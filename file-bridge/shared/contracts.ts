import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "bridge", scope: "host", version: 1,
  schema: z.object({
    sshHost: z.string().regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/).refine(v => !/[\r\n]/.test(v)).default("node030"),
    remoteScript: z.string().regex(/^(?:\/|\.)[A-Za-z0-9_./-]+$/).refine(v => !/[\r\n]/.test(v) && !v.split("/").includes("..")).default(".paseo/plugin-data/file-bridge/desktop_transfer.py"),
    autoStart: z.boolean().default(false),
    stagingDirectory: z.string().max(4096).refine(v => v === "" || (/^[A-Za-z]:[\\/]/.test(v) &&
      !/[<>:"|?*\x00-\x1f\x7f]/.test(v.slice(2)) &&
      !v.slice(3).split(/[\\/]/).some(part => part === ".." || /[. ]$/.test(part))),
      "暂存目录必须为空或 Windows 盘符绝对路径，不允许父目录跳转。").default(""),
  }),
});
export type Preferences = z.output<typeof preferences.schema>;
export const jobSchema = z.object({
  id: z.string(), action: z.string(), state: z.string(), filename: z.string(),
  device_id: z.string().optional(), session_id: z.string().optional(),
  stage_path: z.string().optional(), path: z.string().optional(),
  size: z.number().optional(), sha256: z.string().optional(),
  error: z.string().optional(), phase: z.string().optional(),
});
export const ownerSchema = z.object({
  worker_connected: z.boolean(), device_id: z.string().optional(),
  device_name: z.string().optional(), session_id: z.string().optional(),
  connected_at: z.number().optional(),
});
export const statusSchema = z.object({
  platform: z.string(), deviceName: z.string(), deviceId: z.string(),
  state: z.enum(["stopped", "connecting", "connected", "error"]),
  ownership: z.enum(["none", "managed", "same-device"]).default("none"),
  notice: z.string().nullable().default(null),
  error: z.string().nullable(), coordinator: ownerSchema.nullable(),
  jobs: z.array(jobSchema),
});
export const bridgeStatus = defineRpc({name: "bridge.status", input: z.object({}), output: statusSchema});
export const transferStatus = defineRpc({name: "bridge.job", input: z.object({id: z.string().regex(/^[a-f0-9]{32}$/)}), output: jobSchema});
export const bridgeControl = defineRpc({name: "bridge.control", input: z.object({action: z.enum(["start", "stop"])}), output: statusSchema});
export const queueTransfer = defineRpc({
  name: "bridge.queue",
  input: z.object({
    action: z.enum(["push", "pull", "upload", "download", "cleanup-upload"]),
    source: z.string().max(4096).optional(), destination: z.string().max(4096).optional(),
    filename: z.string().max(255).optional(), id: z.string().regex(/^[a-f0-9]{32}$/).optional(),
    confirmed: z.boolean().default(false),
  }), output: jobSchema,
});
