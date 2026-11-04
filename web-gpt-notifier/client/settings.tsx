import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRpc, useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsInput, SettingsSection, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import { getStatus, notificationSettings, testNotification, type MonitorStatus } from '../shared/contracts.ts';

export function SettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(notificationSettings);
  const readStatus = useRpc(getStatus);
  const test = useRpc(testNotification);
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [draft, setDraft] = useState({ enabled: true, serverUrl: 'https://ntfy.sh', topic: '', token: '' });
  const [loadedRevision, setLoadedRevision] = useState('');
  const [message, setMessage] = useState('');
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (settings.status === 'ready') { setDraft(settings.values); setLoadedRevision(settings.revision); }
  }, [settings.status === 'ready' ? settings.revision : null]);
  useEffect(() => {
    let disposed = false;
    const update = () => { void readStatus({}).then(value => { if (!disposed) setStatus(value); }).catch(() => {}); };
    update();
    const timer = setInterval(update, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [readStatus]);
  if (settings.status !== 'ready' || loadedRevision !== settings.revision) {
    return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>{settings.status === 'invalid' || settings.status === 'error' ? '读取设置失败，请重新打开插件设置。' : '正在加载本机设置…'}</Text>;
  }
  const save = async () => {
    if (settings.status !== 'ready') return;
    setMessage(await settings.save(draft, settings.revision) ? '设置已保存到当前主机。' : '保存失败，请检查设置。');
  };
  const sendTest = async () => {
    setTesting(true);
    try { await test({}); setMessage('测试通知已发送。'); }
    catch { setMessage('发送失败，请检查已保存的 ntfy 设置。'); }
    finally { setTesting(false); }
  };
  const monitors = status?.monitors.filter(value => Date.now() - value.lastSeenAt < 45000) ?? [];
  const active = monitors.filter(value => value.supported);
  const browserCount = active.reduce((sum, value) => sum + value.browserCount, 0);
  const textStyle = { color: theme.colors.foregroundMuted, fontSize: 13 };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 16 }}>在 Paseo 桌面端打开 ChatGPT，插件会自动监控当前窗口中已打开的网页。仅发送完成提醒、会话标题和链接，不发送回答正文。</Text>
      <SettingsSection title="ntfy 通知">
        <SettingsSwitch label="启用监控" value={draft.enabled} onValueChange={enabled => setDraft(value => ({ ...value, enabled }))} />
        <SettingsInput key={'server-' + (settings.status === 'ready' ? settings.revision : '')} label="服务器" initialValue={draft.serverUrl} onChangeText={serverUrl => setDraft(value => ({ ...value, serverUrl }))} />
        <SettingsInput key={'topic-' + (settings.status === 'ready' ? settings.revision : '')} label="Topic" hint="仅保存在当前主机设置中。" initialValue={draft.topic} secureTextEntry onChangeText={topic => setDraft(value => ({ ...value, topic }))} />
        <SettingsInput key={'token-' + (settings.status === 'ready' ? settings.revision : '')} label="访问令牌（可选）" initialValue={draft.token} secureTextEntry onChangeText={token => setDraft(value => ({ ...value, token }))} />
        <SettingsAction label="保存设置" actionLabel={settings.saving ? '保存中…' : '保存'} disabled={settings.status !== 'ready' || settings.saving} onPress={() => { void save(); }} />
        <SettingsAction label="测试已保存的配置" actionLabel={testing ? '发送中…' : '发送测试'} disabled={!status?.configured || testing} onPress={() => { void sendTest(); }} />
      </SettingsSection>
      <SettingsSection title="监控状态">
        <View style={{ gap: 8, padding: 12 }}>
          <Text style={textStyle}>{status?.configured ? '通知目标已配置' : '请先保存通知目标'}</Text>
          <Text style={textStyle}>{active.length ? `桌面监控在线，检测到 ${browserCount} 个 ChatGPT 标签页` : '等待 Paseo 桌面端连接'}</Text>
          <Text style={textStyle}>已投递：{status?.delivered ?? 0}</Text>
          {status?.lastError ? <Text style={textStyle}>{status.lastError}</Text> : null}
          {active.some(value => value.error) ? <Text style={textStyle}>网页读取或投递正在重试。</Text> : null}
          <Text style={textStyle}>保持 Paseo 桌面端运行。外部 Chrome／Edge 标签页不在监控范围内。</Text>
          {message ? <Text style={textStyle}>{message}</Text> : null}
          {settings.saveError ? <Text style={textStyle}>设置无效或版本已改变，请重新加载。</Text> : null}
        </View>
      </SettingsSection>
    </ScrollView>
  );
}
