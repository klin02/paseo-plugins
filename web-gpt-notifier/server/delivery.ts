import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CompletionEvent, MonitorHeartbeat, MonitorStatus, NotificationSettings } from "../shared/contracts.ts";

interface DeliveryState { ids: string[]; delivered: number; lastDeliveryAt: number | null }
interface Options { directory?: string; retryDelayMs?: number; timeoutMs?: number }

export class Delivery {
  private state: DeliveryState = { ids: [], delivered: 0, lastDeliveryAt: null };
  private stateLoading: Promise<void> | undefined;
  private dirty = false;
  private queue: Promise<unknown> = Promise.resolve();
  private controller = new AbortController();
  private lastError: string | null = null;
  private monitors = new Map<string, MonitorHeartbeat & { lastSeenAt: number }>();
  private readonly directory: string;

  private readonly readSettings: () => Promise<NotificationSettings>;
  private readonly options: Options;

  constructor(readSettings: () => Promise<NotificationSettings>, options: Options = {}) {
    this.readSettings = readSettings;
    this.options = options;
    this.directory = options.directory ?? join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "web-gpt-notifier");
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.controller.signal.aborted) throw new Error("Notification service stopped");
      try { return await action(); } catch (error) { throw this.recordError(error); }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private recordError(error: unknown) {
    this.lastError = error instanceof Error && ["Notification service stopped", "Notification delivery failed", "Notification storage unavailable", "Notifications are disabled or not configured"].includes(error.message)
      ? error.message : "Notification service unavailable";
    return new Error(this.lastError);
  }

  private load(): Promise<void> {
    this.stateLoading ??= this.readState().catch(error => {
      this.stateLoading = undefined;
      throw error;
    });
    return this.stateLoading;
  }

  private async readState() {
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, "delivered.json"), "utf8")) as DeliveryState;
      if (!Array.isArray(parsed.ids) || !parsed.ids.every(id => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) ||
        !Number.isSafeInteger(parsed.delivered) || parsed.delivered < 0 ||
        !(parsed.lastDeliveryAt === null || (typeof parsed.lastDeliveryAt === "number" && Number.isFinite(parsed.lastDeliveryAt)))) throw new Error("Invalid state");
      this.state = { ids: parsed.ids.slice(-1000), delivered: parsed.delivered, lastDeliveryAt: parsed.lastDeliveryAt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Notification storage unavailable");
    }
  }

  private async save() {
    const temporary = join(this.directory, `.delivered-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600, flag: "wx" });
      await rename(temporary, join(this.directory, "delivered.json"));
      this.dirty = false;
      this.lastError = null;
    } catch {
      throw new Error("Notification storage unavailable");
    } finally { await unlink(temporary).catch(() => {}); }
  }

  private async publish(settings: NotificationSettings, event?: CompletionEvent) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.controller.signal.aborted) throw new Error("Notification service stopped");
      let retry = false;
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      this.controller.signal.addEventListener("abort", abortRequest, { once: true });
      const timeout = setTimeout(abortRequest, this.options.timeoutMs ?? 10000);
      try {
        const response = await fetch(settings.serverUrl.replace(/\/+$/, "") + "/", {
          method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}) },
          body: JSON.stringify({ topic: settings.topic, title: event ? `ChatGPT 回复完成 · ${event.title}` : "Web GPT Notifier 测试",
            message: event ? "网页版 GPT 已完成本次回复。" : "通知通道已连接。", ...(event ? { click: event.url } : {}), tags: ["speech_balloon"] }),
          signal: requestController.signal,
        });
        await response.body?.cancel();
        if (response.ok) { this.lastError = null; return; }
        retry = response.status === 429 || response.status >= 500;
      } catch { retry = true; }
      finally {
        clearTimeout(timeout);
        this.controller.signal.removeEventListener("abort", abortRequest);
      }
      if (this.controller.signal.aborted) throw new Error("Notification service stopped");
      if (!retry || attempt === 2) throw new Error("Notification delivery failed");
      try { await delay((this.options.retryDelayMs ?? 500) * 2 ** attempt, undefined, { signal: this.controller.signal }); }
      catch { throw new Error("Notification service stopped"); }
    }
  }

  notify(event: CompletionEvent) {
    return this.serialize(async () => {
      const settings = await this.readSettings();
      if (!settings.enabled || !settings.topic) return { status: "disabled" as const };
      await this.load();
      if (this.dirty) await this.save();
      if (this.state.ids.includes(event.id)) return { status: "duplicate" as const };
      await this.publish(settings, event);
      this.state = { ids: [...this.state.ids, event.id].slice(-1000), delivered: this.state.delivered + 1, lastDeliveryAt: Date.now() };
      this.dirty = true;
      await this.save();
      return { status: "sent" as const };
    });
  }

  test() {
    return this.serialize(async () => {
      const settings = await this.readSettings();
      if (!settings.enabled || !settings.topic) throw new Error("Notifications are disabled or not configured");
      await this.publish(settings);
      return { status: "sent" as const };
    });
  }

  heartbeat(input: MonitorHeartbeat) {
    this.monitors.delete(input.clientId);
    this.monitors.set(input.clientId, { ...input, lastSeenAt: Date.now() });
    if (this.monitors.size > 100) this.monitors.delete(this.monitors.keys().next().value!);
    return {};
  }

  async status(): Promise<MonitorStatus> {
    try {
      if (this.controller.signal.aborted) throw new Error("Notification service stopped");
      await this.load();
      const settings = await this.readSettings();
      return { configured: Boolean(settings.topic), enabled: settings.enabled, delivered: this.state.delivered,
        lastDeliveryAt: this.state.lastDeliveryAt, lastError: this.lastError,
        monitors: [...this.monitors.values()].filter(monitor => Date.now() - monitor.lastSeenAt < 90000) };
    } catch (error) { throw this.recordError(error); }
  }

  async stop() { this.controller.abort(); await this.queue; }
}
