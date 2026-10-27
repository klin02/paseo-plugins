import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { pythonSource, powershellSource } from "./assets.ts";
import { jobSchema, ownerSchema, type Preferences, queueTransfer } from "../shared/contracts.ts";
import type { RpcInput } from "@getpaseo/plugin";
import type { z } from "zod";

const runFile = promisify(execFile);
export const quoteUnix = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const sshOptions = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5"];
type QueueInput = RpcInput<typeof queueTransfer>;
type SettingsReader = () => Promise<Preferences>;
type Owner = z.output<typeof ownerSchema>;
type State = "stopped" | "connecting" | "connected" | "error";

export function reconcileOwner(platform: string, deviceId: string, sessionId: string, hasChild: boolean, state: State, owner: Owner | null): { state: State; ownership: "none" | "managed" | "same-device" } {
  if (platform !== "win32" || !owner) return { state, ownership: "none" };
  if (owner.worker_connected && owner.device_id === deviceId) {
    return { state: "connected", ownership: hasChild && owner.session_id === sessionId ? "managed" : "same-device" };
  }
  if (hasChild && !owner.worker_connected) return { state: "connecting", ownership: "managed" };
  return { state, ownership: "none" };
}

export class Bridge {
  private child: ChildProcess | null = null;
  private state: "stopped" | "connecting" | "connected" | "error" = "stopped";
  private error: string | null = null;
  private sessionId = "";
  private deviceId = "";
  private root: string;
  private readSettings: SettingsReader;
  private ready: Promise<void>;
  private changing = false;
  readonly deviceName = hostname().replace(/[^A-Za-z0-9_.-]/g, "_");

  constructor(readSettings: SettingsReader) {
    this.readSettings = readSettings;
    this.root = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "file-bridge");
    this.ready = this.initialize();
  }

  private async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const identity = join(this.root, "device-id");
    try { await writeFile(identity, randomUUID().replaceAll("-", ""), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.deviceId = (await readFile(identity, "utf8")).trim();
    if (!/^[a-f0-9]{32}$/.test(this.deviceId)) throw new Error("Invalid stored File Bridge device identity.");
    await writeFile(join(this.root, "desktop_transfer.py"), pythonSource, { mode: 0o600 });
    await writeFile(join(this.root, "start-desktop-transfer.ps1"), powershellSource, { mode: 0o600 });
  }

  private async command(args: string[]) {
    await this.ready;
    const config = await this.readSettings();
    const local = process.platform !== "win32";
    const result = local
      ? await runFile("python3", [join(this.root, "desktop_transfer.py"), ...args], { timeout: 10000, maxBuffer: 256 * 1024 })
      : await runFile("ssh.exe", [...sshOptions, config.sshHost, ["python3", config.remoteScript, ...args].map(quoteUnix).join(" ")], { timeout: 10000, maxBuffer: 256 * 1024, windowsHide: true });
    return JSON.parse(result.stdout);
  }

  async status() {
    await this.ready;
    let coordinator = null;
    let jobs = [] as ReturnType<typeof jobSchema.parse>[];
    let queryError = null;
    try {
      const values = await Promise.all([this.command(["worker-status"]), this.command(["list"])]);
      coordinator = ownerSchema.parse(values[0]);
      jobs = jobSchema.array().parse(values[1].jobs);
    } catch (error) { queryError = this.message(error); }
    const current = reconcileOwner(process.platform, this.deviceId, this.sessionId, !!this.child, this.state, coordinator);
    const notice = current.ownership === "same-device"
      ? "本机已有另一插件实例的助手在线，已复用其连接。停止/释放须在启动它的本地 daemon 中操作；请勿重复启动。" : null;
    return { platform: process.platform, deviceName: this.deviceName, deviceId: this.deviceId,
      ...current, notice, error: queryError || (current.state === "connected" ? null : this.error), coordinator, jobs };
  }

  async start() {
    await this.ready;
    if (process.platform !== "win32") throw new Error("启动本机助手需要选择 Windows daemon；node030 页面用于查看和提交任务。");
    if (this.changing) throw new Error("控制权正在切换，请等待。");
    if (this.child) return;
    this.changing = true;
    try {
      const owner = ownerSchema.parse(await this.command(["worker-status"]));
      if (owner.worker_connected) {
        if (owner.device_id !== this.deviceId) throw new Error(`控制权由 ${owner.device_name || "另一台电脑"} 持有，请先在该电脑释放。`);
        this.error = null;
        return;
      }
      const config = await this.readSettings();
      const stagingArgs = config.stagingDirectory ? ["-StagingDirectory", config.stagingDirectory] : [];
      this.sessionId = randomUUID().replaceAll("-", "");
      this.state = "connecting"; this.error = null;
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(this.root, "start-desktop-transfer.ps1"),
        "-SshHost", config.sshHost, "-RemoteScript", config.remoteScript,
        "-DeviceId", this.deviceId, "-SessionId", this.sessionId, "-DeviceName", this.deviceName, "-WatchParent", ...stagingArgs],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      let stderr = "";
      child.stderr?.on("data", data => { stderr = (stderr + String(data)).slice(-3000); });
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", line => {
        if (!line.startsWith("{")) return;
        try {
          const event = JSON.parse(line);
          if (event.event === "connected" && event.deviceId === this.deviceId && event.sessionId === this.sessionId && this.child === child) this.state = "connected";
        } catch { /* PowerShell diagnostics are not protocol messages. */ }
      });
      child.on("error", error => { if (this.child === child) { this.error = error.message; this.state = "error"; } });
      child.on("close", code => {
        lines.close();
        if (this.child !== child) return;
        this.child = null;
        if (this.state !== "stopped") { this.state = "error"; this.error = stderr.trim() || `文件助手已退出 (${code})。`; }
      });
    } finally { this.changing = false; }
  }

  async stop() {
    if (this.changing) throw new Error("控制权正在切换，请等待。");
    const child = this.child;
    if (!child) { this.state = "stopped"; this.error = null; return; }
    this.changing = true;
    try {
      // Kill the PowerShell/SSH tree together so the remote flock cannot outlive Stop.
      if (process.platform === "win32" && child.pid && child.exitCode === null) await runFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
      else child.kill();
      this.child = null; this.state = "stopped"; this.error = null;
    } finally { this.changing = false; }
  }

  async queue(input: QueueInput) {
    const needed = (key: "source" | "destination" | "filename" | "id") => {
      const value = input[key];
      if (!value || /[\x00-\x1f]/.test(value)) throw new Error(`缺少有效 ${key}。`);
      return value;
    };
    let args: string[];
    if (input.action === "push" || input.action === "upload") args = [`queue-${input.action}`, needed("source")];
    else if (input.action === "pull") args = ["queue-pull", needed("filename"), needed("destination"), needed("source")];
    else if (input.action === "download") args = ["queue-download", needed("filename"), needed("destination")];
    else {
      if (!input.confirmed) throw new Error("请先确认文件已用完；网页上传须确认处理完成。");
      args = ["queue-cleanup-upload", needed("id"), "--confirm"];
    }
    if (process.platform === "win32") {
      const owner = ownerSchema.parse(await this.command(["worker-status"]));
      if (!owner.worker_connected || owner.device_id !== this.deviceId || !owner.session_id) throw new Error("本机未取得控制权。");
      args.push("--expected-device", this.deviceId, "--expected-session", owner.session_id);
    }
    try { return jobSchema.parse(await this.command(args)); }
    catch (error) { throw new Error(this.message(error)); }
  }

  async job(id: string) {
    return jobSchema.parse(await this.command(["status", id]));
  }

  private message(error: unknown) {
    const detail = error as Error & { stderr?: string };
    return (detail.stderr?.trim() || detail.message || String(error)).slice(-3000);
  }
}
