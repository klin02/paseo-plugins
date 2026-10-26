"""Real subprocess tests for the Windows SSH JSONL transfer boundary."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

SCRIPT = Path(__file__).resolve().parents[1] / "server" / "desktop_transfer.py"


class Transfers(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, PASEO_FILE_BRIDGE_STATE=str(self.root / "state"))
        self.workers = []
        self.source = self.root / "sample.txt"
        self.source.write_bytes(b"bounded transfer\n")
        self.device = uuid.uuid4().hex
        self.session = uuid.uuid4().hex

    def tearDown(self):
        for worker in self.workers:
            if worker.poll() is None:
                worker.kill()
            if worker.stdin and worker.stdin.closed:
                worker.stdin = None
            worker.communicate(timeout=3)
        self.temp.cleanup()

    def cli(self, *args, error=False):
        result = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1 if error else 0, result.stderr)
        return json.loads(result.stderr if error else result.stdout)

    def connect(self, device=None, session=None):
        worker = subprocess.Popen([sys.executable, "-u", str(SCRIPT), "worker",
                                   "--device-id", device or self.device, "--device-name", "WINDOWS-PC",
                                   "--session-id", session or self.session], env=self.env,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, bufsize=1)
        self.workers.append(worker)
        until = time.monotonic() + 3
        while time.monotonic() < until:
            active = self.cli("worker-status")
            if active.get("session_id") == (session or self.session):
                ready = self.receive(worker)
                self.assertEqual(ready, dict(type="ready", device_id=device or self.device,
                                            device_name="WINDOWS-PC", session_id=session or self.session))
                return worker
            time.sleep(.02)
        self.fail("worker did not become connected")

    def receive(self, worker):
        self.assertTrue(select.select([worker.stdout], [], [], 3)[0], "worker did not emit message")
        return json.loads(worker.stdout.readline())

    def respond(self, worker, job, **fields):
        worker.stdin.write(json.dumps(dict(id=job["id"], ok=True, **fields)) + "\n")
        worker.stdin.flush()
        return self.receive(worker)

    def stop(self, worker, abrupt=False):
        if abrupt:
            worker.kill()
        else:
            worker.stdin.close()
        worker.wait(timeout=3)

    def push(self, worker, command="queue-push"):
        job = self.cli(command, self.source)
        message = self.receive(worker)
        self.assertEqual(message["id"], job["id"])
        self.assertEqual(base64.b64decode(message["data_base64"]), self.source.read_bytes())
        ack = self.respond(worker, job, staged=True, stage_path=r"C:\Temp\file-bridge\sample.txt",
                           size=message["size"], sha256=message["sha256"])
        self.assertTrue(ack["ok"])
        return job

    def test_offline_enqueue_refused(self):
        self.assertIn("offline", self.cli("queue-push", self.source, error=True)["error"])
        self.assertEqual(self.cli("worker-status"), {"worker_connected": False})
        self.assertEqual(self.cli("list"), {"jobs": []})

    def test_legacy_worker_lock_cannot_be_bypassed(self):
        state = self.root / "state"
        state.mkdir()
        with (state / ".worker.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            (state / "worker.json").write_text(json.dumps(dict(pid=1, connected_at=time.time())))
            self.assertIn("legacy protocol", self.cli("queue-push", self.source, error=True)["error"])
            self.assertIn("legacy protocol", self.cli("worker-status", error=True)["error"])
            self.assertIn("already connected", self.cli("worker", "--device-id", self.device,
                "--device-name", "WINDOWS-PC", "--session-id", self.session, error=True)["error"])
        self.assertEqual(self.cli("worker-status"), {"worker_connected": False})

    def test_exclusive_worker_and_truthful_status(self):
        worker = self.connect()
        active = self.cli("worker-status")
        self.assertEqual(active["device_id"], self.device)
        self.assertEqual(active["session_id"], self.session)
        self.assertEqual(active["device_name"], "WINDOWS-PC")
        self.assertIsInstance(active["connected_at"], float)
        failed = self.cli("worker", "--device-id", uuid.uuid4().hex, "--device-name", "OTHER",
                          "--session-id", uuid.uuid4().hex, error=True)
        self.assertIn("already connected", failed["error"])
        self.assertEqual(self.cli("worker-status"), active)
        self.stop(worker)
        self.assertEqual(self.cli("worker-status"), {"worker_connected": False})

    def test_push_and_explicit_cleanup(self):
        worker = self.connect()
        job = self.push(worker)
        result = self.cli("status", job["id"])
        self.assertTrue(result["staged"])
        self.assertNotIn("file_selected", result)
        self.assertEqual(result["device_id"], self.device)
        self.assertIn("--confirm", self.cli("queue-cleanup-upload", job["id"], error=True)["error"])
        cleanup = self.cli("queue-cleanup-upload", job["id"], "--confirm")
        message = self.receive(worker)
        self.assertEqual(message["upload_id"], job["id"])
        self.respond(worker, cleanup, windows_temp_removed=True)
        self.assertTrue(self.cli("status", cleanup["id"])["windows_temp_removed"])
        self.cli("cleanup", cleanup["id"])

    def test_upload_preserves_file_selected_contract(self):
        worker = self.connect()
        job = self.push(worker, "queue-upload")
        self.assertTrue(self.cli("status", job["id"])["file_selected"])

    def test_pull_and_download_integrity(self):
        worker = self.connect()
        for action in ("queue-pull", "queue-download"):
            destination = self.root / action
            args = [action, "sample.txt", destination]
            if action == "queue-pull":
                args.append(r"\\desktop\share\sample.txt")
            job = self.cli(*args)
            message = self.receive(worker)
            if action == "queue-pull":
                self.assertEqual(message["windows_source"], args[-1])
            payload = b"a small downloaded file\x00"
            self.assertTrue(self.respond(worker, job, size=len(payload),
                sha256=hashlib.sha256(payload).hexdigest(), data_base64=base64.b64encode(payload).decode())["ok"])
            self.assertEqual(destination.read_bytes(), payload)
            self.assertTrue(self.cli("status", job["id"])["downloaded"])

    def test_corrupt_payload_and_destination_race_never_overwrite(self):
        worker = self.connect()
        for corruption in ("hash", "base64", "race"):
            destination = self.root / corruption
            job = self.cli("queue-download", "sample.txt", destination)
            self.receive(worker)
            payload = b"new data"
            encoded = base64.b64encode(payload).decode()
            sha = hashlib.sha256(payload).hexdigest()
            if corruption == "hash":
                sha = "0" * 64
            elif corruption == "base64":
                encoded = "!invalid!"
            else:
                destination.write_bytes(b"existing data")
            ack = self.respond(worker, job, size=len(payload), sha256=sha, data_base64=encoded)
            self.assertFalse(ack["ok"])
            self.assertEqual(self.cli("status", job["id"])["state"], "failed")
            if corruption == "race":
                self.assertEqual(destination.read_bytes(), b"existing data")
            else:
                self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob(".file-bridge-*")), [])

    def test_disconnect_fences_jobs_across_hosts_and_sessions(self):
        worker = self.connect()
        job = self.cli("queue-push", self.source)
        self.receive(worker)
        self.stop(worker, abrupt=True)
        new = self.connect(device=uuid.uuid4().hex, session=uuid.uuid4().hex)
        self.assertEqual(self.cli("status", job["id"])["state"], "failed")
        self.assertFalse(select.select([new.stdout], [], [], .15)[0])
        self.stop(new)
        same_device = self.connect(session=uuid.uuid4().hex)
        self.assertFalse(select.select([same_device.stdout], [], [], .15)[0])
        self.assertIn("will not replay", self.cli("status", job["id"])["error"])

    def test_graceful_disconnect_fails_running_and_pending(self):
        worker = self.connect()
        first = self.cli("queue-push", self.source)
        self.receive(worker)
        pending = self.cli("queue-push", self.source)
        self.stop(worker)
        for job in (first, pending):
            self.assertEqual(self.cli("status", job["id"])["state"], "failed")

    def test_cleanup_cannot_cross_host_or_reconnected_session(self):
        worker = self.connect()
        job = self.push(worker)
        self.stop(worker)
        new = self.connect(session=uuid.uuid4().hex)
        self.assertIn("original Windows device and session",
                      self.cli("queue-cleanup-upload", job["id"], "--confirm", error=True)["error"])
        self.stop(new)
        self.connect(device=uuid.uuid4().hex, session=uuid.uuid4().hex)
        self.assertIn("original Windows device and session",
                      self.cli("queue-cleanup-upload", job["id"], "--confirm", error=True)["error"])

    def test_size_limit_symlink_and_existing_destination(self):
        oversized = self.root / "oversized.bin"
        with oversized.open("wb") as stream:
            stream.truncate(32 * 1024 * 1024 + 1)
        self.assertIn("32 MiB", self.cli("queue-push", oversized, error=True)["error"])
        link = self.root / "link.txt"
        link.symlink_to(self.source)
        self.assertIn("symbolic link", self.cli("queue-push", link, error=True)["error"])
        self.assertIn("already exists", self.cli("queue-download", "sample.txt", self.source, error=True)["error"])
        self.assertEqual(self.source.read_bytes(), b"bounded transfer\n")

    def test_failed_job_never_replays(self):
        worker = self.connect()
        job = self.cli("queue-push", self.source)
        self.receive(worker)
        self.assertFalse(self.respond(worker, job, staged=True, stage_path="relative.txt", size=0, sha256="bad")["ok"])
        self.stop(worker)
        new = self.connect(session=uuid.uuid4().hex)
        self.assertFalse(select.select([new.stdout], [], [], .15)[0])
        self.assertEqual(self.cli("status", job["id"])["state"], "failed")

    def test_queued_foreign_session_is_fenced_while_connected(self):
        worker = self.connect()
        job_id = uuid.uuid4().hex
        directory = self.root / "state" / job_id
        directory.mkdir()
        request = dict(id=job_id, action="download", filename="foreign.txt", state="pending",
                       device_id=self.device, session_id=uuid.uuid4().hex,
                       destination=str(self.root / "foreign"))
        (directory / "request.json").write_text(json.dumps(request))
        until = time.monotonic() + 2
        while time.monotonic() < until:
            result = self.cli("status", job_id)
            if result["state"] == "failed":
                break
            time.sleep(.02)
        self.assertEqual(result["state"], "failed")
        self.assertIn("another Windows device/session", result["error"])
        self.assertFalse(select.select([worker.stdout], [], [], .1)[0])

    def test_expected_owner_atomic_enqueue_fence(self):
        worker = self.connect()
        expected = ["--expected-device", self.device, "--expected-session", self.session]
        job = self.cli("queue-push", self.source, *expected)
        self.receive(worker)
        self.stop(worker)
        self.connect(device=uuid.uuid4().hex, session=uuid.uuid4().hex)
        self.assertIn("changed", self.cli("queue-push", self.source, *expected, error=True)["error"])
        self.assertIn("changed", self.cli("queue-download", "file.txt", self.root / "download",
                                         *expected, error=True)["error"])
        self.assertIn("changed", self.cli("queue-pull", "file.txt", self.root / "pull", r"C:\Temp\file.txt",
                                         *expected, error=True)["error"])
        self.assertEqual(len(self.cli("list")["jobs"]), 1)
        self.assertEqual(self.cli("status", job["id"])["state"], "failed")
        self.assertIn("supplied together", self.cli("queue-push", self.source,
                      "--expected-device", self.device, error=True)["error"])

    def test_windows_source_validation(self):
        self.connect()
        for source in ("relative.txt", "C:relative.txt", "/root/file", "C:\\temp\\bad\nfile"):
            self.assertIn("absolute", self.cli("queue-pull", "file.txt", self.root / "dest", source, error=True)["error"])

    def test_push_ack_requires_absolute_path_integrity_and_staged(self):
        worker = self.connect()
        for invalid in ("path", "sha", "staged"):
            job = self.cli("queue-push", self.source)
            message = self.receive(worker)
            response = dict(staged=True, stage_path=r"C:\Temp\sample.txt", size=message["size"], sha256=message["sha256"])
            response[{"path": "stage_path", "sha": "sha256", "staged": "staged"}[invalid]] = {
                "path": "relative.txt", "sha": "0" * 64, "staged": False}[invalid]
            self.assertFalse(self.respond(worker, job, **response)["ok"])

    def test_list_is_bounded_and_sanitized(self):
        worker = self.connect()
        first = self.cli("queue-download", "first.txt", self.root / "first")
        self.receive(worker)
        for i in range(22):
            self.cli("queue-download", f"file-{i}.txt", self.root / f"destination-{i}")
        jobs = self.cli("list")["jobs"]
        self.assertEqual(len(jobs), 20)
        self.assertNotIn(first["id"], [job["id"] for job in jobs])
        for job in jobs:
            self.assertNotIn("destination", job)
            self.assertNotIn("stage_path", job)
            self.assertNotIn("error", job)
            self.assertEqual(job["device_id"], self.device)


if __name__ == "__main__":
    unittest.main()
