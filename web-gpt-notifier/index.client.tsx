import type { PluginClientContext } from '@getpaseo/plugin/client';
import { Platform } from 'react-native';
import { SettingsScreen } from './client/settings.tsx';
import { focusBrowser, startBrowserMonitor } from './client/web.ts';
import { TaskStore } from './client/tasks.ts';
import { registerActivityUi } from './client/activity.tsx';

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: 'notifications', title: 'Web GPT Notifier', icon: 'BellRing', Component: SettingsScreen,
  });
  const removeCommand = client.addCommandCenterItem({
    id: 'settings', title: 'Web GPT Notifier 设置', icon: 'BellRing', context: 'global',
    onSelect: () => client.openSettings('notifications'),
  });
  const store = new TaskStore();
  const removeActivity = registerActivityUi(client, store, focusBrowser);
  const stop = startBrowserMonitor(client, Platform.OS === 'web', store);
  return () => { stop(); removeActivity(); removeCommand(); removeSettings(); };
}
