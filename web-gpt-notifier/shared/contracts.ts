import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const notificationSettings = defineSettings({
  id: "notifications", scope: "host", version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    serverUrl: z.string().url().refine(value => {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }, "Use an HTTP(S) server URL without credentials, query, or fragment").default("https://ntfy.sh"),
    topic: z.string().max(256).regex(/^[A-Za-z0-9_-]*$/, "Use letters, numbers, underscores, and hyphens").default(""),
    token: z.string().max(4096).refine(value => !/[\r\n]/.test(value)).default(""),
  }),
});
export type NotificationSettings = z.output<typeof notificationSettings.schema>;

export const completionEventSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.string().max(2048).refine(value => {
    try {
      const url = new URL(value);
      return url.origin === "https://chatgpt.com" && !url.username && !url.password && !url.search && !url.hash &&
        /^\/(?:g\/[A-Za-z0-9_-]+\/)?c\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
    } catch { return false; }
  }, "Use a ChatGPT conversation URL"),
  title: z.string().max(200),
});
export type CompletionEvent = z.infer<typeof completionEventSchema>;
export const monitorHeartbeatSchema = z.object({
  clientId: z.string().min(1).max(200), browserCount: z.number().int().min(0).max(10000),
  supported: z.boolean(), error: z.string().max(500).nullable(),
});
export type MonitorHeartbeat = z.infer<typeof monitorHeartbeatSchema>;
const monitorStatusSchema = z.object({
  configured: z.boolean(), enabled: z.boolean(), delivered: z.number(),
  lastDeliveryAt: z.number().nullable(), lastError: z.string().nullable(),
  monitors: z.array(monitorHeartbeatSchema.extend({ lastSeenAt: z.number() })),
});
export type MonitorStatus = z.infer<typeof monitorStatusSchema>;
export const notifyCompletion = defineRpc({
  name: "completion.notify", input: completionEventSchema,
  output: z.object({ status: z.enum(["sent", "duplicate", "disabled"]) }),
});
export const getStatus = defineRpc({ name: "monitor.status", input: z.object({}), output: monitorStatusSchema });
export const heartbeat = defineRpc({ name: "monitor.heartbeat", input: monitorHeartbeatSchema, output: z.object({}) });
export const testNotification = defineRpc({
  name: "notification.test", input: z.object({}), output: z.object({ status: z.literal("sent") }),
});
