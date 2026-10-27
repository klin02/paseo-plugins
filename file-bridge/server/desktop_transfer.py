#!/usr/bin/env python3
"""Bounded file transfers over a Windows worker's SSH JSONL connection."""
import argparse
import base64
import binascii
import fcntl
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import select
import shutil
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager

MAX_BYTES = 32 * 1024 * 1024
MAX_LINE = ((MAX_BYTES + 2) // 3) * 4 + 65536
ID_PATTERN = re.compile(r"[0-9a-f]{32}\Z")


def state_dir():
    root = Path(os.environ.get("PASEO_FILE_BRIDGE_STATE", "~/.local/state/paseo-file-bridge/transfers")).expanduser()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


def job_dir(job_id):
    if not ID_PATTERN.fullmatch(job_id):
        raise ValueError("invalid transfer ID: expected 32 lowercase hexadecimal characters")
    path = state_dir() / job_id
    if path.is_symlink():
        raise ValueError("transfer directory must not be a symbolic link")
    return path


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix=".json-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def filename_only(name):
    if (not name or name.endswith((".", " ")) or
            any(ord(c) < 32 or c in '<>:"/\\|?*' for c in name) or
            re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name)):
        raise ValueError("filename must be a basename without path separators or drive letters")
    return name


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_bytes(path):
    if not path.is_file() or path.is_symlink():
        raise ValueError("upload source must be a regular file, not a symbolic link")
    with path.open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("file exceeds the 32 MiB transfer limit")
    return data


@contextmanager
def state_lock():
    with (state_dir() / ".state.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def windows_path(path):
    if (not isinstance(path, str) or not path or
            any(ord(c) < 32 or ord(c) == 127 for c in path) or
            not PureWindowsPath(path).is_absolute()):
        raise ValueError("Windows path must be absolute and contain no control characters")
    return path


def new_job(request, data=None, owner=None, expected=None):
    with state_lock():
        active = worker_status()
        if not active["worker_connected"]:
            raise ValueError("Windows transfer worker is offline; connect a worker before enqueueing")
        if expected and any(active.get(k) != expected.get(k) for k in ("device_id", "session_id")):
            raise ValueError("active Windows device/session changed; refusing transfer for a different owner")
        if owner and any(active.get(k) != owner.get(k) for k in ("device_id", "session_id")):
            raise ValueError("cleanup requires the original Windows device and session; reconnect cleanup requires manual review")
        request.update({k: active[k] for k in ("device_id", "device_name", "session_id")})
        job_id = uuid.uuid4().hex
        directory = job_dir(job_id)
        directory.mkdir(mode=0o700)
        request.update(id=job_id, state="pending", created_at=time.time())
        try:
            if data is not None:
                fd = os.open(directory / "input", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
            atomic_json(directory / "request.json", request)
        except BaseException:
            shutil.rmtree(directory)
            raise
        return {k: v for k, v in request.items() if k not in ("destination", "source_path")}


def queue_upload(source, action="upload", expected=None):
    path = Path(source).expanduser()
    data = checked_bytes(path)
    return new_job(dict(action=action, filename=filename_only(path.name), size=len(data), sha256=digest(data)), data, expected=expected)


def queue_download(filename, destination, source_path=None, expected=None):
    filename_only(filename)
    path = Path(destination).expanduser().absolute()
    if not path.parent.is_dir():
        raise ValueError("download destination parent directory must already exist")
    if os.path.lexists(path):
        raise ValueError("download destination already exists; refusing to overwrite")
    path = path.parent.resolve() / path.name
    request = dict(action="download", filename=filename, destination=str(path))
    if source_path is not None:
        request.update(action="pull", source_path=windows_path(source_path))
    return new_job(request, expected=expected)


def queue_cleanup_upload(job_id, confirmed=False, expected=None):
    if not confirmed:
        raise ValueError("Windows cleanup requires explicit operator confirmation (--confirm)")
    original = status(job_id)
    if original["action"] not in ("upload", "push") or original["state"] != "completed":
        raise ValueError("Windows cleanup requires a completed upload or push; confirm web upload first when applicable")
    return new_job(dict(action="cleanup-upload", upload_id=job_id, filename=original["filename"],
                        size=original["size"], sha256=original["sha256"]), owner=original, expected=expected)


def status(job_id):
    directory = job_dir(job_id)
    request = read_json(directory / "request.json")
    result = directory / "result.json"
    if result.exists():
        request.update(read_json(result))
    request["worker_connected"] = worker_connected()
    return request


def worker_connected():
    with (state_dir() / ".worker.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return False
        except BlockingIOError:
            return True


def worker_status():
    if not worker_connected():
        return dict(worker_connected=False)
    try:
        metadata = read_json(state_dir() / "worker.json")
    except FileNotFoundError:
        return dict(worker_connected=False)
    required = ("device_id", "device_name", "session_id", "connected_at")
    if any(k not in metadata for k in required):
        raise ValueError("connected worker uses an incompatible legacy protocol; disconnect it before connecting this plugin")
    return dict(worker_connected=True, **{k: metadata[k] for k in required})


def list_jobs():
    paths = sorted(state_dir().glob("*/request.json"), key=lambda p: p.stat().st_mtime_ns, reverse=True)[:20]
    fields = ("id", "action", "filename", "state", "device_id", "device_name", "session_id",
              "created_at", "size", "sha256", "upload_id", "staged", "downloaded", "windows_temp_removed")
    jobs = []
    for path in paths:
        job = status(path.parent.name)
        jobs.append({k: job[k] for k in fields if k in job})
    return dict(jobs=jobs)


def save_result(directory, **result):
    atomic_json(directory / "result.json", result)


def complete(directory, request, response):
    if response.get("id") != request["id"]:
        raise ValueError("worker response ID does not match the active transfer")
    if response.get("ok") is not True:
        raise ValueError("Windows worker failed: " + str(response.get("error", "no error detail supplied")))
    if request["action"] in ("upload", "push"):
        if type(response.get("size")) is not int or response["size"] != request["size"] or response.get("sha256") != request["sha256"]:
            raise ValueError("upload acknowledgement size/SHA-256 mismatch")
        stage_path = windows_path(response.get("stage_path"))
        result = dict(state="completed", stage_path=stage_path, size=request["size"], sha256=request["sha256"])
        if request["action"] == "push":
            if response.get("staged") is not True:
                raise ValueError("push acknowledgement requires staged:true")
            result["staged"] = True
        else:
            result["file_selected"] = True
        return result
    if request["action"] == "cleanup-upload":
        if response.get("windows_temp_removed") is not True:
            raise ValueError("Windows cleanup was not confirmed")
        return dict(state="completed", windows_temp_removed=True, upload_id=request["upload_id"])
    encoded = response.get("data_base64")
    if not isinstance(encoded, str) or len(encoded) > ((MAX_BYTES + 2) // 3) * 4:
        raise ValueError("download payload missing or exceeds the 32 MiB transfer limit")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("download payload is not valid base64") from error
    sha = digest(data)
    if len(data) > MAX_BYTES:
        raise ValueError("download exceeds the 32 MiB transfer limit")
    if type(response.get("size")) is not int or response["size"] != len(data) or response.get("sha256") != sha:
        raise ValueError("download size/SHA-256 mismatch")
    destination = Path(request["destination"])
    fd, temporary = tempfile.mkstemp(prefix=".file-bridge-", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # Linking creates the final name atomically and never overwrites it.
        os.link(temporary, destination)
    finally:
        os.unlink(temporary)
    return dict(state="completed", downloaded=True, path=str(destination), server_sha=sha, sha256=sha, size=len(data))


def fail_unfinished(root, reason, owner=None):
    for path in root.glob("*/request.json"):
        request = read_json(path)
        result_path = path.parent / "result.json"
        result = read_json(result_path) if result_path.exists() else request
        if result.get("state") not in ("pending", "running"):
            continue
        if owner and any(request.get(k) != owner.get(k) for k in ("device_id", "session_id")):
            continue
        save_result(path.parent, state="failed", error=reason)


def worker(device_id, device_name, session_id):
    for value, label in ((device_id, "device ID"), (session_id, "session ID")):
        if not ID_PATTERN.fullmatch(value):
            raise ValueError(label + " must be 32 lowercase hexadecimal characters")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,255}", device_name):
        raise ValueError("device name must contain only letters, digits, underscore, dot or hyphen")
    root = state_dir()
    owner = dict(device_id=device_id, device_name=device_name, session_id=session_id, connected_at=time.time())
    with (root / ".worker.lock").open("a") as lock:
        with state_lock():
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ValueError("another Windows transfer worker is already connected") from error
            fail_unfinished(root, "previous Windows device/session disconnected; transfer will not replay")
            atomic_json(root / "worker.json", owner)
        try:
            print(json.dumps(dict(type="ready", **{k: owner[k] for k in
                                 ("device_id", "device_name", "session_id")})), flush=True)
            worker_loop(root, owner)
        finally:
            with state_lock():
                fail_unfinished(root, "Windows worker disconnected before completing this transfer", owner)
                (root / "worker.json").unlink(missing_ok=True)


def worker_loop(root, owner):
    while True:
        pending = sorted(root.glob("*/request.json"), key=lambda p: p.stat().st_mtime_ns)
        for path in pending:
            directory = job_dir(path.parent.name)
            if (directory / "result.json").exists():
                continue
            request = read_json(path)
            if any(request.get(k) != owner[k] for k in ("device_id", "session_id")):
                save_result(directory, state="failed", error="transfer belongs to another Windows device/session; refusing replay")
                continue
            try:
                save_result(directory, state="running")
                message = {k: request[k] for k in ("id", "action", "filename")}
                if request["action"] == "pull":
                    message["windows_source"] = windows_path(request["source_path"])
                if request["action"] == "cleanup-upload":
                    message.update(upload_id=request["upload_id"], size=request["size"], sha256=request["sha256"])
                if request["action"] in ("upload", "push"):
                    data = checked_bytes(directory / "input")
                    if len(data) != request["size"] or digest(data) != request["sha256"]:
                        raise ValueError("queued upload contents changed; size/SHA-256 mismatch")
                    message.update(size=len(data), sha256=request["sha256"], data_base64=base64.b64encode(data).decode("ascii"))
                print(json.dumps(message, ensure_ascii=False), flush=True)
                while True:
                    line = sys.stdin.buffer.readline(MAX_LINE + 1)
                    if not line:
                        raise EOFError("Windows worker disconnected before acknowledging the transfer")
                    if len(line) > MAX_LINE or not line.endswith(b"\n"):
                        raise ValueError("worker response exceeds the JSONL line limit or is incomplete")
                    response = json.loads(line)
                    if not isinstance(response, dict) or response.get("id") != request["id"]:
                        raise ValueError("worker response must be a JSON object with the active transfer ID")
                    if "phase" not in response:
                        break
                    if response["phase"] != "staged" or not isinstance(response.get("stage_path"), str) or not response["stage_path"]:
                        raise ValueError("worker progress requires phase staged and a nonempty stage_path")
                    save_result(directory, state="running", phase="staged", stage_path=windows_path(response["stage_path"]))
                save_result(directory, **complete(directory, request, response))
                print(json.dumps(dict(id=request["id"], ack=True, ok=True)), flush=True)
            except BaseException as error:
                save_result(directory, state="failed", error=str(error) or type(error).__name__)
                if isinstance(error, (EOFError, KeyboardInterrupt, SystemExit, BrokenPipeError)):
                    return
                print(json.dumps(dict(id=request["id"], ack=True, ok=False, error=str(error))), flush=True)
        # Detect a closed SSH input while idle without protocol noise.
        readable, _, _ = select.select([sys.stdin], [], [], 0.5)
        if readable:
            line = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not line:
                return
            raise ValueError("unexpected worker input while no transfer is active")


def cleanup(job_id):
    directory = job_dir(job_id)
    if status(job_id)["state"] != "completed":
        raise ValueError("cleanup is allowed only for completed transfers")
    shutil.rmtree(directory)
    return dict(id=job_id, state="cleaned")


def browser_directory(job_id=None):
    root = state_dir() / ".browser"
    root.mkdir(exist_ok=True, mode=0o700)
    if job_id is None:
        return root
    if not ID_PATTERN.fullmatch(job_id):
        raise ValueError("invalid browser task ID")
    directory = root / job_id
    if directory.is_symlink():
        raise ValueError("browser task directory must not be a symbolic link")
    return directory


def browser_queue(command, browser_id=None, ref=None, source=None, expected=None):
    if command not in ("list_tabs", "snapshot", "upload"):
        raise ValueError("unsupported File Bridge browser command")
    if command != "list_tabs" and not re.fullmatch(r"[A-Za-z0-9-]{1,128}", browser_id or ""):
        raise ValueError("browser ID is required")
    if command == "upload" and not re.fullmatch(r"@e[0-9]+", ref or ""):
        raise ValueError("upload requires a file-input ref from a fresh browser snapshot")
    transfer = queue_upload(source, "push", expected=expected) if command == "upload" else None
    with state_lock():
        active = worker_status()
        if not active["worker_connected"]:
            raise ValueError("Windows transfer worker is offline")
        fence = transfer or expected
        if fence and any(active.get(k) != fence.get(k) for k in ("device_id", "session_id")):
            raise ValueError("Windows device/session changed before browser task publication")
        task = dict(id=uuid.uuid4().hex, command=command, state="pending", created_at=time.time(),
                    device_id=active["device_id"], session_id=active["session_id"])
        if browser_id:
            task["browser_id"] = browser_id
        if ref:
            task["ref"] = ref
        if transfer:
            task["upload_id"] = transfer["id"]
        directory = browser_directory(task["id"])
        directory.mkdir(mode=0o700)
        atomic_json(directory / "request.json", task)
        return task


def browser_status(job_id):
    return read_json(browser_directory(job_id) / "request.json")


def browser_next(device_id, session_id):
    if not all(ID_PATTERN.fullmatch(value) for value in (device_id, session_id)):
        raise ValueError("invalid browser worker identity")
    with state_lock():
        active = worker_status()
        if not active["worker_connected"] or active.get("device_id") != device_id or active.get("session_id") != session_id:
            raise ValueError("browser worker must match the active transfer device/session")
        for path in sorted(browser_directory().glob("*/request.json"), key=lambda p: p.stat().st_mtime_ns):
            task = read_json(path)
            if task["state"] not in ("pending", "running"):
                continue
            if task["device_id"] != device_id or task["session_id"] != session_id:
                task.update(state="failed", error="browser task belongs to another device/session; refusing replay")
                atomic_json(path, task)
                continue
            if task["state"] == "running":
                if time.time() - task["started_at"] > 120:
                    task.update(state="failed", error="browser execution acknowledgement lost; not replayed")
                    atomic_json(path, task)
                continue
            if task["command"] == "upload":
                transfer = status(task["upload_id"])
                if transfer["state"] == "failed":
                    task.update(state="failed", error="staging transfer failed: " + transfer.get("error", "unknown"))
                    atomic_json(path, task)
                    continue
                if transfer["state"] != "completed":
                    continue
                if any(transfer.get(k) != task[k] for k in ("device_id", "session_id")):
                    raise ValueError("upload transfer owner does not match browser task")
                task.update(stage_path=transfer["stage_path"], size=transfer["size"], sha256=transfer["sha256"],
                            filename=transfer["filename"])
            task.update(state="running", started_at=time.time())
            atomic_json(path, task)
            return dict(task=task)
        return dict(task=None)


def browser_complete(job_id, device_id, session_id, response):
    if len(response.encode("utf-8")) > 160000:
        raise ValueError("browser result exceeds limit")
    result = json.loads(response)
    if not isinstance(result, dict) or type(result.get("ok")) is not bool:
        raise ValueError("browser result requires a boolean ok")
    with state_lock():
        task = browser_status(job_id)
        active = worker_status()
        if (not active["worker_connected"] or task["state"] != "running" or
                any(task.get(k) != v or active.get(k) != v for k, v in
                    (("device_id", device_id), ("session_id", session_id)))):
            raise ValueError("browser result does not belong to the active claimed task/session")
        task.update(state="completed" if result["ok"] else "failed", response=result, completed_at=time.time())
        atomic_json(browser_directory(job_id) / "request.json", task)
        return dict(id=job_id, state=task["state"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    worker_parser = sub.add_parser("worker")
    worker_parser.add_argument("--device-id", required=True)
    worker_parser.add_argument("--device-name", required=True)
    worker_parser.add_argument("--session-id", required=True)
    sub.add_parser("worker-status")
    sub.add_parser("list")
    for name in ("queue-browser-tabs", "queue-browser-snapshot", "queue-browser-upload"):
        browser = sub.add_parser(name)
        if name != "queue-browser-tabs":
            browser.add_argument("--browser-id", required=True)
        if name == "queue-browser-upload":
            browser.add_argument("source")
            browser.add_argument("--ref", required=True)
    browser = sub.add_parser("browser-status")
    browser.add_argument("id")
    for name in ("browser-next", "browser-complete"):
        browser = sub.add_parser(name)
        browser.add_argument("--device-id", required=True)
        browser.add_argument("--session-id", required=True)
        if name == "browser-complete":
            browser.add_argument("id")
    for name in ("queue-upload", "queue-push"):
        upload = sub.add_parser(name)
        upload.add_argument("source")
    download = sub.add_parser("queue-download")
    download.add_argument("filename")
    download.add_argument("destination")
    pull = sub.add_parser("queue-pull")
    pull.add_argument("filename")
    pull.add_argument("destination")
    pull.add_argument("source_path")
    for name in ("status", "cleanup", "queue-cleanup-upload"):
        command = sub.add_parser(name)
        command.add_argument("id")
        if name == "queue-cleanup-upload":
            command.add_argument("--confirm", action="store_true")
    for name, command in sub.choices.items():
        if name.startswith("queue-"):
            command.add_argument("--expected-device")
            command.add_argument("--expected-session")
    args = parser.parse_args()
    try:
        expected = None
        if args.command.startswith("queue-"):
            if bool(args.expected_device) != bool(args.expected_session):
                raise ValueError("--expected-device and --expected-session must be supplied together")
            if args.expected_device:
                if not all(ID_PATTERN.fullmatch(value) for value in (args.expected_device, args.expected_session)):
                    raise ValueError("expected device and session must be 32 lowercase hexadecimal characters")
                expected = dict(device_id=args.expected_device, session_id=args.expected_session)
        if args.command == "worker":
            worker(args.device_id, args.device_name, args.session_id)
            return
        if args.command == "worker-status":
            with state_lock():
                result = worker_status()
        elif args.command == "list":
            result = list_jobs()
        elif args.command == "queue-browser-tabs":
            result = browser_queue("list_tabs", expected=expected)
        elif args.command == "queue-browser-snapshot":
            result = browser_queue("snapshot", browser_id=args.browser_id, expected=expected)
        elif args.command == "queue-browser-upload":
            result = browser_queue("upload", browser_id=args.browser_id, ref=args.ref, source=args.source, expected=expected)
        elif args.command == "browser-status":
            result = browser_status(args.id)
        elif args.command == "browser-next":
            result = browser_next(args.device_id, args.session_id)
        elif args.command == "browser-complete":
            result = browser_complete(args.id, args.device_id, args.session_id, sys.stdin.read(160001))
        elif args.command == "queue-upload":
            result = queue_upload(args.source, expected=expected)
        elif args.command == "queue-push":
            result = queue_upload(args.source, "push", expected=expected)
        elif args.command == "queue-pull":
            result = queue_download(args.filename, args.destination, args.source_path, expected=expected)
        elif args.command == "queue-download":
            result = queue_download(args.filename, args.destination, expected=expected)
        elif args.command == "status":
            result = status(args.id)
        elif args.command == "queue-cleanup-upload":
            result = queue_cleanup_upload(args.id, args.confirm, expected=expected)
        else:
            result = cleanup(args.id)
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError) as error:
        print(json.dumps(dict(error=str(error)), ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
