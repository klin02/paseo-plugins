import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { bridgeStatus, bridgeControl, queueTransfer, transferStatus, preferences } from "../shared/contracts";

export function BridgeScreen({ theme, layout }: PluginScreenProps) {
  const read = useRpc(bridgeStatus);
  const control = useRpc(bridgeControl);
  const queue = useRpc(queueTransfer);
  const inspect = useRpc(transferStatus);
  const settings = useSettings(preferences);
  const [status, setStatus] = useState<RpcOutput<typeof bridgeStatus> | null>(null);
  const [selected, setSelected] = useState<RpcOutput<typeof transferStatus> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [remoteScript, setRemoteScript] = useState("");
  const [autoStart, setAutoStart] = useState(false);
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [filename, setFilename] = useState("");
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const selectedId = useRef<string | null>(null);
  const foreground = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  const border = theme.colors.foregroundMuted;
  const box = { borderWidth: 1, borderColor: border, borderRadius: 8, padding: 12, gap: 10 };

  useEffect(() => {
    if (settings.status === "ready") {
      setSshHost(settings.values.sshHost); setRemoteScript(settings.values.remoteScript); setAutoStart(settings.values.autoStart);
    }
  }, [settings.status, settings.status === "ready" ? settings.revision : null]);

  useEffect(() => {
    let live = true; let running = false;
    const refresh = async () => {
      if (running) return; running = true;
      try {
        const next = await read({});
        if (live) setStatus(next);
        if (selectedId.current) { const job = await inspect({ id: selectedId.current }); if (live) setSelected(job); }
      } catch (value) { if (live) setError(String(value)); }
      finally { running = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    return () => { live = false; clearInterval(timer); };
  }, [read, inspect]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); setStatus(await read({})); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  }
  async function submit(action: "push" | "pull" | "upload" | "download" | "cleanup-upload") {
    await act(async () => {
      const job = await queue({ action, source, destination, filename, id: selected?.id, confirmed: cleanupConfirmed });
      selectedId.current = job.id; setSelected(job); setCleanupConfirmed(false);
    });
  }
  const button = (label: string, onPress: () => void, disabled = busy) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
      style={{ borderWidth: 1, borderColor: border, padding: 10, borderRadius: 6, opacity: disabled ? 0.45 : 1 }}>
      <Text style={foreground}>{label}</Text>
    </Pressable>
  );
  const field = (label: string, value: string, set: (text: string) => void) => (
    <View style={{ gap: 5 }}><Text style={muted}>{label}</Text><TextInput accessibilityLabel={label} value={value}
      onChangeText={set} autoCapitalize="none" autoCorrect={false} editable={!busy} placeholderTextColor={border}
      style={{ ...foreground, borderWidth: 1, borderColor: border, borderRadius: 5, padding: 9 }} /></View>
  );
  const owner = status?.coordinator;
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 24, gap: 16, maxWidth: 960 }}>
    <Text style={{ ...foreground, fontSize: 22, fontWeight: "bold" }}>File Bridge 文件桥接</Text>
    <Text style={muted}>顶部主机选择器决定后台运行位置。选择 Windows 启动助手；选择 node030 可查看控制权、提交文件任务。</Text>
    <View style={box}>
      <Text style={foreground}>本机：{status ? `${status.deviceName} (${status.platform})` : "读取中…"}</Text>
      <Text style={muted} selectable>设备 ID：{status?.deviceId || "…"}</Text>
      <Text style={foreground}>助手：{status?.state || "读取中"}</Text>
      <Text style={foreground}>当前独占电脑：{owner?.worker_connected ? owner.device_name : "无在线控制者"}</Text>
      {owner?.worker_connected && <Text style={muted} selectable>会话：{owner.session_id}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button("取得本机控制权", () => void act(() => control({ action: "start" })), busy || status?.platform !== "win32")}
        {button("停止本机并释放", () => void act(() => control({ action: "stop" })), busy || status?.platform !== "win32")}
        {button("刷新", () => void act(async () => { if (selectedId.current) setSelected(await inspect({id:selectedId.current})); }))}
      </View>
      <Text style={muted}>另一台必须等待当前助手停止或 SSH 断开。此锁只约束 File Bridge 文件助手；Paseo 原生浏览器工具和其他 Desktop 连接有自己的路由。</Text>
    </View>
    {(error || status?.error) && <Text accessibilityRole="alert" style={foreground} selectable>{error || status?.error}</Text>}
    <View style={box}>
      <Text style={{ ...foreground, fontWeight: "bold" }}>Windows 连接设置</Text>
      {settings.status === "ready" ? <>
        {field("SSH 主机（使用已有 SSH 配置/密钥）", sshHost, setSshHost)}
        {field("远程 Python 脚本路径（绝对路径或 .paseo/…）", remoteScript, setRemoteScript)}
        {button(`插件启动时自动取得控制权：${autoStart ? "开" : "关"}`, () => setAutoStart(!autoStart))}
        {button("保存设置（先停止当前助手）", () => void act(async () => {
          const values = preferences.schema.parse({ sshHost, remoteScript, autoStart });
          if (!await settings.save(values, settings.revision)) throw new Error("设置保存失败或版本冲突，请刷新。");
        }))}
      </> : <Text style={muted}>{settings.status === "loading" ? "读取设置…" : settings.error}</Text>}
      <Text style={muted}>默认关闭自动启动。每台 Windows 只需安装一次；需要该电脑接管时点击取得控制权。</Text>
    </View>
    <View style={box}>
      <Text style={{ ...foreground, fontWeight: "bold" }}>互传文件（每文件 ≤32 MiB）</Text>
      {field("源路径：发送时填 node030 路径；取回时填 Windows 绝对路径", source, setSource)}
      {field("接收目标：node030 全新文件绝对路径（不覆盖）", destination, setDestination)}
      {field("接收文件名（取回或网页下载时填写）", filename, setFilename)}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button("node030 → Windows Temp", () => void submit("push"))}
        {button("Windows → node030", () => void submit("pull"))}
        {button("为网页选择上传附件", () => void submit("upload"))}
        {button("接收网页下载", () => void submit("download"))}
      </View>
      <Text style={muted}>网页动作提交后，在持有控制权的 Windows Paseo 打开对应的文件选择/保存窗口。选择完成仍须检查网页附件处理完成；通用互传无需浏览器。</Text>
    </View>
    {selected && <View style={box}>
      <Text style={{ ...foreground, fontWeight: "bold" }}>当前任务：{selected.action} · {selected.state}</Text>
      <Text style={muted} selectable>{selected.id}</Text>
      <Text style={foreground} selectable>{selected.stage_path || selected.path || selected.filename}</Text>
      {selected.sha256 && <Text style={muted} selectable>SHA-256：{selected.sha256} · {selected.size} bytes</Text>}
      {selected.error && <Text style={foreground} selectable>{selected.error}</Text>}
      {selected.state === "completed" && ["push", "upload"].includes(selected.action) && <>
        {button(`确认文件已用完／网页已处理完成：${cleanupConfirmed ? "是" : "否"}`, () => setCleanupConfirmed(!cleanupConfirmed))}
        {button("清理这个 Windows Temp 文件", () => void submit("cleanup-upload"), busy || !cleanupConfirmed)}
      </>}
    </View>}
    <View style={box}>
      <Text style={{ ...foreground, fontWeight: "bold" }}>最近 20 个任务</Text>
      {status?.jobs.length ? status.jobs.map(job => <Pressable key={job.id} accessibilityRole="button" onPress={() => void act(async () => {selectedId.current=job.id; setSelected(await inspect({id:job.id})); setCleanupConfirmed(false);})}>
        <Text style={foreground}>{job.action} · {job.state} · {job.filename}</Text><Text style={muted} selectable>{job.id}</Text>
      </Pressable>) : <Text style={muted}>暂无任务</Text>}
    </View>
  </ScrollView>;
}
