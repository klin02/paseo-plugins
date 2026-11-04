import type { PluginClientContext } from '@getpaseo/plugin/client';
import { Platform } from 'react-native';
import { SettingsScreen } from './client/settings.tsx';
import { startBrowserMonitor } from './client/web.ts';

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: 'notifications', title: 'Web GPT Notifier', icon: 'BellRing', Component: SettingsScreen,
  });
  const removeCommand = client.addCommandCenterItem({
    id: 'settings', title: 'Web GPT Notifier 设置', icon: 'BellRing', context: 'global',
    onSelect: () => client.openSettings('notifications'),
  });
  const stop = startBrowserMonitor(client, Platform.OS === 'web');
  return () => { stop(); removeCommand(); removeSettings(); };
}
