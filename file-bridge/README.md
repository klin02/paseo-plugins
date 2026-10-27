# File Bridge

A general file-transfer plugin for Paseo. It has no GPT or OpenAI dependency. An opt-in Windows browser worker lets the SSH coordinator list tabs, take snapshots and upload staged files without a native file picker. Ordinary bidirectional copies work without a browser. Legacy Open/Save dialog helpers remain separate.

## Install from Git

Add this source in **Settings → Plugins** on both the Windows local daemon and the Linux coordinator:

```text
github:klin02/paseo-plugins:file-bridge
```

CLI equivalent, run against each intended daemon:

```sh
paseo plugin install github:klin02/paseo-plugins:file-bridge
```

Updates use `paseo plugin update file-bridge`. A manually cloned checkout also works: install its `file-bridge` directory. Never point Windows installation at a Linux filesystem path; plugin server code runs on the daemon where it is installed.

Requires Paseo 0.13.x on daemon and app. Windows needs PowerShell 5.1+ and OpenSSH. Linux coordinator needs Python 3.9+. Existing SSH keys/agent and a verified host fingerprint must allow noninteractive login. The plugin stores no passwords and does not change SSH configuration or the global plugin switch.

## Setup

1. Install on Linux first. Loading the plugin writes its embedded helper to `~/.paseo/plugin-data/file-bridge/desktop_transfer.py` (or `$PASEO_HOME/plugin-data/file-bridge` if configured).
2. On Windows, open **File Bridge** and select the local host in the header. Set SSH host to your existing alias or `user@hostname`. The default alias is `node030`; change it if your SSH configuration differs.
3. The default remote script is `.paseo/plugin-data/file-bridge/desktop_transfer.py`, relative to the SSH login directory. Use the full Linux helper path if its daemon has a custom PASEO_HOME.
4. Save, then acquire local control. The coordinator shows the Windows computer name, device ID and connection session. Automatic startup is off unless enabled in the panel.
5. Set **Windows 暂存父目录** to a local Windows directory, for example `D:\PaseoFiles` if that drive is available, or leave it empty for system Temp. This path is independent of the Linux source directory. Files stay isolated under `file-bridge/<job-id>/upload/<filename>`. Stop and start the worker after changing this setting; reusing an already running worker keeps its existing directory.

There is no extra npm build or Python installation on Windows. Client screens are React Native and use Paseo's theme; helpers are embedded in the server bundle and materialized on the daemon.

## Transfer files

- **Linux → Windows staging directory:** enter a Linux source path and send. Open the completed task to see the exact Windows path, byte count and SHA-256.
- **Windows → Linux:** enter a drive-absolute Windows source such as `C:\Users\me\Desktop\input.txt`, a new Linux destination and a filename. The Windows original stays in place.
- **Browser upload without a picker:** use the browser queue described below. The Windows plugin executes through the configured Windows-local agent. Verify page processing separately before sending or cleaning up.
- **Legacy browser upload dialog:** the original panel upload action still waits for an Open dialog. Use `queue-browser-upload` for the picker-free workflow.
- **Browser download:** enqueue first, then trigger the corresponding Save dialog. Windows Temp is removed only after the Linux destination is verified and acknowledged.

Per-file limit: 32 MiB. Targets never overwrite existing files. UNC/device paths and reparse points are not supported for Windows source files. Linux destination parent directories must exist. A staged upload/push stays until explicit confirmed cleanup; cleanup across a changed device or session is refused.

Direct native `browser_upload` calls from a Linux agent still carry the Linux cwd. The plugin queue uses one explicitly configured Windows-local agent whose actual workspace contains the staging parent, preserving the browser tool's workspace checks. Hidden inputs additionally require the local Desktop snapshot patch: stock Paseo 0.13.0 omits them. This plugin does not patch Desktop itself.

## Browser tasks from the SSH coordinator

In the Windows plugin settings, enable browser tasks, set the local agent ID and the exact local daemon MCP URL (for example `http://127.0.0.1:6767/mcp/agents`). Only a loopback IPv4 endpoint is accepted. Use a Windows-local agent whose real workspace contains the staging parent and whose tabs you intend to control. The plugin verifies returned agent, cwd and workspace context. Settings changes stop the transfer worker; start it once after saving.

Run on the coordinator, replacing placeholders with returned IDs. Set `TRANSFER` to the plugin-data `file-bridge/desktop_transfer.py` under your actual Paseo home.

```sh
python3 "$TRANSFER" queue-browser-tabs
python3 "$TRANSFER" browser-status TASK_ID
python3 "$TRANSFER" queue-browser-snapshot --browser-id BROWSER_ID
python3 "$TRANSFER" browser-status SNAPSHOT_TASK_ID
python3 "$TRANSFER" queue-browser-upload /absolute/source.txt --browser-id BROWSER_ID --ref @e78
python3 "$TRANSFER" browser-status UPLOAD_TASK_ID
```

Use the file-input ref from a fresh snapshot. Upload tasks create a normal `push` transfer and wait for verified completion. Windows checks the exact per-transfer stage path, regular file, workspace containment, size and SHA-256. Results include `upload_id`, `stage_path`, size and hash. `attachment_processed: false` means only that the input was set. Take another snapshot and verify page processing before sending a message.

Only tab listing, snapshots and upload are supported. The queue does not send messages, evaluate arbitrary scripts or open a native picker. Jobs are claimed once and bound to the current device/session; uncertain execution is never replayed. Browser work runs only in the plugin instance owning the transfer worker. Install this version on both hosts so a Linux plugin reload cannot restore an older helper.

## Exclusive control

One coordinator accepts exactly one worker SSH session using an OS file lock. Jobs bind to device and connection identity; an optional expected-owner fence is validated atomically with queue publication. A second Windows worker is rejected. Stop the old worker before the next machine acquires control. A disconnect fails uncertain jobs; they never replay on another machine or connection. There is no automatic reconnect or force takeover.

Stop, settings changes and plugin cleanup first prevent new browser dispatch, cancel claimed tasks that have not dispatched, and wait for an already dispatched tool to return before releasing the SSH worker. Each tool call rechecks current device/session ownership. Concurrent start/stop requests are serialized. An upload already sent to Desktop may finish while Stop waits; Stop is not an undo operation. A timeout or lost tool response leaves the page outcome uncertain: inspect the same tab before retrying.

The plugin watches its parent process pipe so an unexpected backend exit also terminates its worker and SSH child. After draining, normal Stop kills the process tree. A broken network may delay server-side disconnect detection; the second worker remains blocked during that period. Unexpected process/network failure and a timed-out remote tool are not an atomic cancellation of Desktop side effects. Never delete the live lock file.

Repeated acquisition first checks the coordinator. If this device already has an active session, the panel reuses that session and fences new jobs to its current identity. It distinguishes a worker managed by this plugin process from a same-device worker started by another instance; the latter remains usable, but must be stopped through the daemon that started it. The panel disables duplicate acquisition while connected and does not pretend to own another process's Stop action.

This controls **File Bridge workers**. It does not disconnect other Paseo Desktop sessions or intercept native `browser_*` tools. Connected hosts can manage Windows workspaces, agents and terminals, but the public plugin API does not expose cross-host filesystem transfer or plugin RPC. File bytes use the separate SSH channel.

State: `~/.local/state/paseo-file-bridge/transfers`; `PASEO_FILE_BRIDGE_STATE` may override it only if all coordinator commands and workers use the same value. Default staging: system Temp `/file-bridge/<job-id>/...`; an explicit Windows staging parent replaces Temp without granting per-task arbitrary destination writes. Stop old experimental AskGPT workers before migrating; their queue format and state are separate. The installed ask-gpt skill's legacy file helper does not target this queue; use this panel or the following CLI.

## Coordinator CLI

```sh
TRANSFER="$HOME/.paseo/plugin-data/file-bridge/desktop_transfer.py"
python3 "$TRANSFER" worker-status
python3 "$TRANSFER" queue-push /absolute/input.txt
python3 "$TRANSFER" queue-pull received.txt /absolute/new-result.txt 'C:\Users\me\Desktop\input.txt'
python3 "$TRANSFER" status JOB_ID
python3 "$TRANSFER" queue-cleanup-upload JOB_ID --confirm
```

Each queue command also accepts paired `--expected-device HEX32 --expected-session HEX32`. Device identity is local plugin state, not an authentication token; authentication is the existing SSH session.

## Development and verification

On Linux (Python coordinator tests import Unix `fcntl`):

```sh
npm run typecheck
npm test
pwsh -NoProfile -File tests/test_worker.ps1
node scripts/verify-live.mjs
```

On Windows, run the portable browser/lifecycle suite and PowerShell helper tests. The full `npm test` also includes Linux coordinator integration and does not run natively on Windows:

```powershell
npm.cmd run typecheck
npm.cmd run test:portable
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/test_worker.ps1
```

`npm run assets` regenerates `server/assets.ts` from the reviewed Python and PowerShell sources. Commit it when helpers change. No server credentials, device IDs or transfer payloads belong in the repository.

Verified: TypeScript compilation; actual Python subprocess tests for exclusivity, owner fencing, disconnect, hashes, no overwrite and cleanup; Node service ↔ Python push/pull integration; PowerShell parse/helper/parent-EOF tests; live node030 plugin load, client registrations and RPC error states. Linux tests also run on the shared workspace filesystem.

Native Windows evidence: one real Windows desktop completed UTF-8 filename/content and empty-file round trips through SSH, matching SHA-256, rejection of existing destinations, acknowledged Temp cleanup, rejection of a second controller and rejection of a wrong-owner request. The same active session passed a second round-trip while diagnosing duplicate acquisition.

Picker-free Windows acceptance passed: node030 queued an upload, Windows staged and verified 184 bytes, an HTTP page independently received the same size/SHA-256, and ChatGPT read the random marker, integer count and sum from one prompt containing none of those answers. The Desktop hidden-input patch remained installed and the existing local browser login was used. Two physical Windows machines taking turns and legacy Open/Save dialogs remain unverified.

References: https://paseo.sh/docs/plugins/reference.md, https://paseo.sh/docs/sdk/reference.md#clienthosts, https://paseo.sh/docs/browser.md.
