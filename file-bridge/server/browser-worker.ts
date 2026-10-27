import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { Preferences } from "../shared/contracts.ts";

const taskSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  device_id: z.string(), session_id: z.string(),
  command: z.enum(["list_tabs", "snapshot", "upload"]),
  browser_id: z.string().optional(), ref: z.string().optional(),
  upload_id: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  filename: z.string().optional(), stage_path: z.string().optional(),
  size: z.number().int().min(0).max(32 * 1024 * 1024).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
type Task = z.output<typeof taskSchema>;
const toolResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.object({
      ok: z.boolean(),
      result: z.unknown().optional(), error: z.unknown().optional(),
      context: z.object({ agentId: z.string(), cwd: z.string(), workspaceId: z.string() }),
    }).optional(),
  }).optional(),
  error: z.object({ message: z.string() }).optional(),
});
export interface BrowserTransport {
  tool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function localBrowserTransport(config: Preferences): BrowserTransport {
  const endpoint = new URL(config.browserMcpUrl);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/mcp/agents") {
    throw new Error("Browser MCP endpoint must be the explicit local daemon loopback URL");
  }
  endpoint.searchParams.set("callerAgentId", config.browserAgentId);
  return {
    async tool(name, args) {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 45000);
      try {
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2024-11-05" },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call",
          params: { name, arguments: args } }),
      });
      if (!response.ok) throw new Error("Local browser MCP HTTP " + response.status);
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw new Error("Browser response exceeds limit");
      if (text.trimStart().startsWith("{")) return JSON.parse(text);
      const events = text.split(/\r?\n/).filter(line => line.startsWith("data: "));
      const last = events.at(-1);
      if (!last) throw new Error("No browser JSON-RPC response");
      return JSON.parse(last.slice(6));
      } finally { clearTimeout(deadline); }
    },
  };
}

function inside(file: string, root: string) {
  const path = relative(root, file);
  return path === "" || (path !== ".." && !path.startsWith("..\\") && !path.startsWith("../") && !isAbsolute(path));
}

export async function validateStagedUpload(task: Task, stagingDirectory: string, cwd: string) {
  if (!task.stage_path || !task.upload_id || !task.filename || task.size === undefined || !task.sha256)
    throw new Error("Incomplete staged transfer metadata");
  if (!stagingDirectory) throw new Error("Configure a staging directory inside the local browser agent workspace");
  if (task.filename !== task.filename.split(/[\\/]/).at(-1)) throw new Error("Invalid staged filename");
  const expected = resolve(stagingDirectory, "file-bridge", task.upload_id, "upload", task.filename);
  if (resolve(task.stage_path) !== expected || !inside(expected, resolve(cwd)))
    throw new Error("Stage path must match this transfer and remain inside the actual local agent workspace");
  let parent = expected;
  while (true) {
    const stat = await lstat(parent);
    if (stat.isSymbolicLink()) throw new Error("Staged upload must not traverse a link/reparse point");
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const file = await lstat(expected);
  if (!file.isFile() || !inside(await realpath(expected), await realpath(cwd)))
    throw new Error("Staged upload is not a regular workspace file");
  if (file.size !== task.size) throw new Error("Staged file size/SHA-256 changed");
  const bytes = await readFile(expected);
  if (bytes.length !== task.size || createHash("sha256").update(bytes).digest("hex") !== task.sha256)
    throw new Error("Staged file size/SHA-256 changed");
  return expected;
}

export async function executeBrowserTask(raw: unknown, config: Preferences, transport: BrowserTransport,
  beforeCall: () => Promise<void> = async () => {}, signal?: AbortSignal) {
  const task = taskSchema.parse(raw);
  async function call(name: string, args: Record<string, unknown>) {
    await beforeCall();
    if (signal?.aborted) throw new Error("Browser task stopped before dispatch");
    const wire = toolResultSchema.parse(await transport.tool(name, args));
    if (wire.error) throw new Error(wire.error.message);
    const content = wire.result?.structuredContent;
    if (!content || !content.ok || wire.result?.isError) throw new Error(JSON.stringify(content?.error ?? "Browser tool failed"));
    if (content.context.agentId !== config.browserAgentId || !isAbsolute(content.context.cwd))
      throw new Error("Browser tool did not use the configured local agent context");
    return content;
  }
  const tabs = await call("browser_list_tabs", {});
  if (task.command === "list_tabs") return { ok: true, result: tabs.result, context: tabs.context };
  const listed = z.object({ tabs: z.array(z.object({ browserId: z.string() })) }).parse(tabs.result);
  if (!listed.tabs.some(tab => tab.browserId === task.browser_id))
    throw new Error("Browser tab does not belong to the configured local agent workspace");
  if (task.command === "snapshot") {
    const snapshot = await call("browser_snapshot", { browserId: task.browser_id });
    return { ok: true, result: snapshot.result, context: snapshot.context };
  }
  if (!task.ref || !/^@e[0-9]+$/.test(task.ref)) throw new Error("Missing file-input ref");
  const path = await validateStagedUpload(task, config.stagingDirectory, tabs.context.cwd);
  const upload = await call("browser_upload", { browserId: task.browser_id, ref: task.ref, filePaths: [path] });
  if (upload.context.cwd !== tabs.context.cwd || upload.context.workspaceId !== tabs.context.workspaceId)
    throw new Error("Local browser context changed during upload; inspect page before retrying");
  return { ok: true, result: upload.result, context: upload.context,
    stage_path: path, size: task.size, sha256: task.sha256, attachment_processed: false,
    note: "File input set. Take another browser snapshot and verify attachment processing before sending." };
}

export async function sshBrowserCommand(config: Preferences, args: string[], input?: string): Promise<unknown> {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const command = ["python3", config.remoteScript, ...args].map(quote).join(" ");
  return new Promise((resolveResult, reject) => {
    const child = execFile("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=5", config.sshHost, command], { windowsHide: true, timeout: 15000, maxBuffer: 512 * 1024 },
      (error, stdout, stderr) => {
        if (error) { reject(new Error(stderr.trim() || error.message)); return; }
        try { resolveResult(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
    child.stdin?.end(input ?? "");
  });
}

export class BrowserWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private stopped = true;
  private inFlight: Promise<void> = Promise.resolve();
  private cancellation: AbortController | undefined;
  public error: string | null = null;
  private readSettings: () => Promise<Preferences>;
  private owner: () => Promise<{ deviceId: string; ownership: string; coordinator: { worker_connected: boolean; device_id?: string; session_id?: string } | null }>;
  private dependencies: { command: typeof sshBrowserCommand; transport: typeof localBrowserTransport };
  constructor(readSettings: BrowserWorker["readSettings"], owner: BrowserWorker["owner"],
    dependencies = { command: sshBrowserCommand, transport: localBrowserTransport }) {
    this.readSettings = readSettings; this.owner = owner;
    this.dependencies = dependencies;
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    const run = () => { if (!this.busy) this.inFlight = this.tick(); };
    this.timer = setInterval(run, 2500);
    run();
  }
  async stop() {
    this.stopped = true; this.cancellation?.abort();
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    // A dispatched tool may already have a side effect; drain it before releasing the SSH lock.
    await this.inFlight;
  }
  async tick() {
    if (this.busy || this.stopped || process.platform !== "win32") return;
    this.busy = true;
    const cancellation = new AbortController();
    this.cancellation = cancellation;
    try {
      const config = await this.readSettings();
      if (!config.browserEnabled) return;
      if (!config.browserAgentId) throw new Error("Configure the Windows-local browser agent ID");
      const owner = await this.owner();
      const active = owner.coordinator;
      if (this.stopped || owner.ownership !== "managed" || !active?.worker_connected || active.device_id !== owner.deviceId || !active.session_id) return;
      const identity = ["--device-id", owner.deviceId, "--session-id", active.session_id];
      const next = z.object({ task: taskSchema.nullable() }).parse(await this.dependencies.command(config, ["browser-next", ...identity]));
      if (!next.task) { this.error = null; return; }
      let response: unknown;
      try {
        const assertActive = async () => {
          if (cancellation.signal.aborted) throw new Error("Browser task stopped before dispatch");
          const current = await this.owner();
          if (cancellation.signal.aborted) throw new Error("Browser task stopped before dispatch");
          if (this.stopped || current.ownership !== "managed" || !current.coordinator?.worker_connected ||
              current.deviceId !== next.task!.device_id || current.coordinator.device_id !== next.task!.device_id ||
              current.coordinator.session_id !== next.task!.session_id) throw new Error("Browser task owner changed or stopped");
        };
        await assertActive();
        response = await executeBrowserTask(next.task, config, this.dependencies.transport(config), assertActive, cancellation.signal);
      } catch (error) { response = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      await this.dependencies.command(config, ["browser-complete", next.task.id, ...identity], JSON.stringify(response));
      this.error = null;
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; if (this.cancellation === cancellation) this.cancellation = undefined; }
  }
}
