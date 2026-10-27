import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWorker, executeBrowserTask, localBrowserTransport, validateStagedUpload } from "../server/browser-worker.ts";
import { preferences } from "../shared/contracts.ts";

test("browser endpoint only accepts explicit loopback daemon URLs", () => {
  for (const browserMcpUrl of ["https://127.0.0.1:6767/mcp/agents", "http://node030:6767/mcp/agents",
    "http://127.0.0.1:6767/mcp/agents?callerAgentId=other", "http://user:pass@127.0.0.1:6767/mcp/agents"]) {
    assert.throws(() => preferences.schema.parse({ browserMcpUrl }));
  }
  assert.ok(localBrowserTransport(preferences.schema.parse({})));
});

test("stop cancels a claimed task before browser dispatch and start can resume", async () => {
  const config = { ...preferences.schema.parse({}), browserEnabled: true };
  const owner = { deviceId: "a".repeat(32), ownership: "managed", coordinator: { worker_connected: true, device_id: "a".repeat(32), session_id: "b".repeat(32) } };
  config.browserAgentId = "11111111-1111-4111-8111-111111111111";
  let release!: () => void; let claimed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { claimed = resolve; });
  const calls: string[] = []; const completed: unknown[] = [];
  let first = true;
  const worker = new BrowserWorker(async () => config, async () => owner, {
    async command(_config, args, input) {
      if (args[0] === "browser-complete") { completed.push(JSON.parse(input!)); return {}; }
      if (!first) return { task: null };
      first = false; claimed(); await gate;
      return { task: { id: "c".repeat(32), command: "list_tabs", device_id: owner.deviceId, session_id: owner.coordinator.session_id } };
    },
    transport() { return { async tool(name) { calls.push(name); return { result: { structuredContent: { ok: true, result: { tabs: [] }, context: { agentId: config.browserAgentId, cwd: "/workspace", workspaceId: "workspace" } } } }; } }; },
  });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    worker.start(); await ready; const stopped = worker.stop(); release(); await stopped;
    assert.deepEqual(calls, []);
    assert.equal((completed[0] as { ok: boolean }).ok, false);
    worker.start(); await new Promise(resolve => setTimeout(resolve, 10)); await worker.stop();
    assert.equal(worker.error, null);
  } finally { release(); await worker.stop(); Object.defineProperty(process, "platform", platform); }
});

test("session changes and settings cancellation invalidate a newly claimed task", async () => {
  for (const reason of ["session", "settings"]) {
    const config = { ...preferences.schema.parse({}), browserEnabled: true, browserAgentId: "11111111-1111-4111-8111-111111111111" };
    const owner = { deviceId: "a".repeat(32), ownership: "managed", coordinator: { worker_connected: true, device_id: "a".repeat(32), session_id: "b".repeat(32) } };
    const calls: string[] = []; const completed: { ok: boolean }[] = [];
    let worker!: BrowserWorker;
    worker = new BrowserWorker(async () => config, async () => owner, {
      async command(_config, args, input) {
        if (args[0] === "browser-complete") { completed.push(JSON.parse(input!)); return {}; }
        if (reason === "session") owner.coordinator.session_id = "d".repeat(32);
        else void worker.stop();
        return { task: { id: "c".repeat(32), command: "list_tabs", device_id: owner.deviceId, session_id: "b".repeat(32) } };
      },
      transport() { return { async tool(name) { calls.push(name); throw new Error("Browser must not run"); } }; },
    });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      worker.start(); await new Promise(resolve => setTimeout(resolve, 20)); await worker.stop();
      assert.deepEqual(calls, [], reason);
      assert.equal(completed[0]?.ok, false, reason);
    } finally { await worker.stop(); Object.defineProperty(process, "platform", platform); }
  }
});

test("upload uses the actual bound local context and verifies transfer path and hash", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bridge-browser-"));
  const stagingDirectory = join(cwd, "staging");
  const upload_id = "a".repeat(32);
  const folder = join(stagingDirectory, "file-bridge", upload_id, "upload");
  const file = join(folder, "proof.txt");
  const bytes = Buffer.from("actual upload bytes");
  await mkdir(folder, { recursive: true });
  await writeFile(file, bytes, { flag: "wx" });
  const config = { ...preferences.schema.parse({}), stagingDirectory, browserAgentId: "11111111-1111-4111-8111-111111111111" };
  const context = { agentId: config.browserAgentId, cwd, workspaceId: "local-workspace" };
  const task = { id: "b".repeat(32), device_id: "device", session_id: "session", command: "upload" as const,
    browser_id: "tab", ref: "@e1", upload_id, filename: "proof.txt", stage_path: file, size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const transport = { async tool(name: string, args: Record<string, unknown>) {
    calls.push({ name, args });
    return { result: { structuredContent: { ok: true, context,
      result: name === "browser_list_tabs" ? { tabs: [{ browserId: "tab" }] } : { command: "upload" } } } };
  } };
  try {
    const result = await executeBrowserTask(task, config, transport);
    assert.equal(result.ok, true);
    assert.equal("attachment_processed" in result && result.attachment_processed, false);
    assert.deepEqual(calls.at(-1), { name: "browser_upload", args: { browserId: "tab", ref: "@e1", filePaths: [file] } });
    await assert.rejects(() => validateStagedUpload({ ...task, upload_id: "c".repeat(32) }, stagingDirectory, cwd), /Stage path/);
    await assert.rejects(() => validateStagedUpload(task, stagingDirectory, join(cwd, "other")), /workspace/);
    await writeFile(file, "changed");
    await assert.rejects(() => validateStagedUpload(task, stagingDirectory, cwd), /SHA-256/);
    await assert.rejects(() => executeBrowserTask({ ...task, browser_id: "other" }, config, transport), /does not belong/);
    await assert.rejects(() => executeBrowserTask(task, config, { async tool() {
      return { result: { structuredContent: { ok: true, context: { ...context, agentId: "other" }, result: {} } } };
    } }), /configured local agent/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("owner changes or Stop after listing prevent upload, and dispatched upload drains", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bridge-browser-stop-"));
  const stagingDirectory = join(cwd, "staging");
  const upload_id = "a".repeat(32);
  const folder = join(stagingDirectory, "file-bridge", upload_id, "upload");
  const file = join(folder, "proof.txt");
  const bytes = Buffer.from("drain proof");
  await mkdir(folder, { recursive: true });
  await writeFile(file, bytes);
  const config = { ...preferences.schema.parse({}), stagingDirectory, browserEnabled: true,
    browserAgentId: "11111111-1111-4111-8111-111111111111" };
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    for (const reason of ["session", "stop", "dispatched"]) {
      const owner = { deviceId: "a".repeat(32), ownership: "managed", coordinator: {
        worker_connected: true, device_id: "a".repeat(32), session_id: "b".repeat(32) } };
      const task = { id: "c".repeat(32), command: "upload", device_id: owner.deviceId,
        session_id: owner.coordinator.session_id, browser_id: "tab", ref: "@e1", upload_id,
        filename: "proof.txt", stage_path: file, size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") };
      const calls: string[] = []; const completed: { ok: boolean }[] = [];
      let release!: () => void; let reached!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { reached = resolve; });
      const worker = new BrowserWorker(async () => config, async () => owner, {
        async command(_config, args, input) {
          if (args[0] === "browser-complete") { completed.push(JSON.parse(input!)); return {}; }
          return { task };
        },
        transport() { return { async tool(name) {
          calls.push(name);
          if ((reason === "dispatched") === (name === "browser_upload")) { reached(); await gate; }
          return { result: { structuredContent: { ok: true, context: {
            agentId: config.browserAgentId, cwd, workspaceId: "workspace" },
            result: name === "browser_list_tabs" ? { tabs: [{ browserId: "tab" }] } : {} } } };
        } }; },
      });
      try {
        worker.start(); await ready;
        if (reason === "session") owner.coordinator.session_id = "d".repeat(32);
        let stopped = false;
        const stopping = reason === "session" ? undefined : worker.stop().then(() => { stopped = true; });
        await Promise.resolve();
        assert.equal(stopped, false, "Stop must await the active tool");
        release();
        if (stopping) await stopping;
        else {
          while (!completed.length) await new Promise(resolve => setTimeout(resolve, 1));
          await worker.stop();
        }
        assert.deepEqual(calls, reason === "dispatched" ? ["browser_list_tabs", "browser_upload"] : ["browser_list_tabs"], reason);
        assert.equal(completed[0]?.ok, reason === "dispatched", reason);
        assert.equal(completed.length, 1);
      } finally { release(); await worker.stop(); }
    }
  } finally { Object.defineProperty(process, "platform", platform); await rm(cwd, { recursive: true, force: true }); }
});
