import { useEffect, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type {
  PluginButtonIconProps, PluginButtonRegistration, PluginClientContext, PluginHostProps, PluginIconProps,
  PluginPopoverProps, PluginScreenProps, PluginSidebarItemProps,
} from '@getpaseo/plugin/client';
import { Icon, SidebarRow } from '@getpaseo/plugin/client/ui';
import type { BrowserTask, TaskState, TaskStore } from './tasks.ts';

const labels: Record<TaskState, string> = {
  idle: '暂无新问答', running: '进行中', completed: '已读', stopped: '已停止',
  error: '网页出错', unavailable: '暂时无法读取',
};
const taskLabel = (task: BrowserTask) => task.state === 'completed' && task.unread ? '已完成未读' : labels[task.state];
const icons: Record<TaskState, string> = {
  idle: 'MessageCircle', running: 'LoaderCircle', completed: 'CircleCheck', stopped: 'Square',
  error: 'CircleAlert', unavailable: 'CircleAlert',
};

function RunningIcon({ color }: PluginIconProps) {
  return <ActivityIndicator size="small" color={color} />;
}

function CompletedIcon({ size, theme }: PluginButtonIconProps) {
  return <Icon icon={icons.completed} size={size} color={theme.colors.statusSuccess} />;
}

export function registerActivityUi(
  client: PluginClientContext,
  store: TaskStore,
  focusBrowser: (id: string) => Promise<void>,
): () => void {
  const useTasks = () => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  function TaskList({ theme, layout, workspaceId, beforeOpen }: PluginHostProps & {
    workspaceId?: string; beforeOpen?: () => void;
  }) {
    const snapshot = useTasks();
    const tasks = snapshot.tasks.filter(task => !workspaceId || task.workspaceId === workspaceId)
      .toSorted((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || Number(b.unread) - Number(a.unread) || b.updatedAt - a.updatedAt);
    const running = tasks.filter(task => task.state === 'running').length;
    const openTask = (task: BrowserTask) => {
      beforeOpen?.();
      client.openScreen({ screenId: 'activity', params: { focus: task.browserId } });
    };
    return (
      <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
        contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 12 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 18 }}>Web GPT{running ? ` · ${running} 个进行中` : ''}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          {!snapshot.supported ? '请在 Paseo 桌面端打开 ChatGPT。' : !snapshot.enabled ? '监控已暂停，可在插件设置中启用。' : '当前电脑的 ChatGPT 标签页。点击会话可返回原网页。'}
        </Text>
        {!tasks.length ? <Text style={{ color: theme.colors.foregroundMuted }}>暂无 ChatGPT 标签页。</Text> : null}
        {tasks.map(task => (
          <Pressable key={task.browserId} accessibilityRole="button"
            accessibilityLabel={`${task.title || 'ChatGPT'}，${taskLabel(task)}`}
            onPress={() => openTask(task)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 }}>
            {task.state === 'running' ? <RunningIcon color={theme.colors.accent} size={18} />
              : <Icon icon={icons[task.state]} color={task.state === 'completed' && task.unread ? theme.colors.statusSuccess : theme.colors.foregroundMuted} size={18} />}
            <View style={{ flex: 1, gap: 4 }}>
              <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 14 }}>{task.title || 'ChatGPT'}</Text>
              <Text style={{ color: task.state === 'completed' && task.unread ? theme.colors.statusSuccess : theme.colors.foregroundMuted, fontSize: 12 }}>{taskLabel(task)}</Text>
            </View>
          </Pressable>
        ))}
        {snapshot.error ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{snapshot.error}</Text> : null}
      </ScrollView>
    );
  }

  function TasksScreen(props: PluginScreenProps) {
    useEffect(() => {
      const browserId = props.params.focus;
      if (!browserId) return;
      const task = store.getSnapshot().tasks.find(value => value.browserId === browserId);
      if (!task?.workspaceId || !props.navigation?.openWorkspace) {
        store.setMonitor({ error: '无法定位原工作区，请确认网页仍在当前桌面窗口中。' });
        return;
      }
      store.setMonitor({ error: null });
      try {
        props.navigation.openWorkspace({ workspaceId: task.workspaceId });
        // Navigation unmounts this screen; focus must finish selecting the resident tab.
        void focusBrowser(browserId).then(() => store.markRead(browserId, task.completionId)).catch(() => {
          store.setMonitor({ error: '无法打开原标签页，请确认该网页仍在当前窗口中。' });
        });
      } catch {
        store.setMonitor({ error: '无法打开原工作区，请确认该工作区仍然存在。' });
      }
    }, [props.params.focus]);
    return <TaskList {...props} workspaceId={props.params.workspaceId} />;
  }

  function TasksPopover(props: PluginPopoverProps) {
    return (
      <View style={{ width: props.layout.compact ? '100%' : 360, height: 400, maxHeight: 440 }}>
        <TaskList {...props} beforeOpen={props.close} />
        <Pressable accessibilityRole="button" onPress={() => { props.close(); props.openScreen({ screenId: 'activity' }); }}
          style={{ padding: 16 }}>
          <Text style={{ color: props.theme.colors.accent }}>查看全部会话</Text>
        </Pressable>
      </View>
    );
  }

  function SidebarItem(props: PluginSidebarItemProps) {
    const snapshot = useTasks();
    const running = snapshot.tasks.filter(task => task.state === 'running').length;
    const unread = snapshot.tasks.filter(task => task.state === 'completed' && task.unread).length;
    return <SidebarRow icon={running ? RunningIcon : 'Globe'} label="Web GPT"
      active={props.currentScreen?.screenId === 'activity'}
      onPress={() => props.openPopover(TasksPopover)}
      trailing={!running && unread ? <View accessibilityLabel={`${unread} 个已完成未读`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon icon={icons.completed} size={14} color={props.theme.colors.statusSuccess} />
        <Text style={{ color: props.theme.colors.statusSuccess, fontSize: 12 }}>{unread}</Text>
      </View> : <Text accessibilityLabel={`${running} 个进行中`} style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>{running || snapshot.tasks.length || ''}</Text>} />;
  }

  const removeScreen = client.addScreen({ id: 'activity', title: 'Web GPT', Component: TasksScreen });
  const removeSidebar = client.addSidebarHeaderItem({ id: 'activity', title: 'Web GPT', Component: SidebarItem });
  const headers = new Map<string, { registration: PluginButtonRegistration; signature: string }>();
  const syncHeaders = () => {
    const snapshot = store.getSnapshot();
    const workspaceIds = new Set(snapshot.tasks.flatMap(task => task.workspaceId ? [task.workspaceId] : []));
    for (const [workspaceId, value] of headers) {
      if (!workspaceIds.has(workspaceId)) { value.registration.remove(); headers.delete(workspaceId); }
    }
    for (const workspaceId of workspaceIds) {
      const tasks = snapshot.tasks.filter(task => task.workspaceId === workspaceId);
      const running = tasks.filter(task => task.state === 'running').length;
      const unread = tasks.filter(task => task.state === 'completed' && task.unread).length;
      const signature = `${running}:${unread}:${tasks.length}:${snapshot.enabled}`;
      const old = headers.get(workspaceId);
      if (old?.signature === signature) continue;
      const button = {
        title: snapshot.enabled ? `Web GPT · ${running} 个进行中，${unread} 个已完成未读，${tasks.length} 个标签页` : 'Web GPT · 监控已暂停',
        label: running ? `GPT ${running}` : 'GPT',
        icon: running ? RunningIcon : unread ? CompletedIcon : 'Globe',
        behavior: { kind: 'action' as const, onPress: () => client.openScreen({ screenId: 'activity', params: { workspaceId } }) },
      };
      if (old) { old.registration.update(button); old.signature = signature; }
      else headers.set(workspaceId, { registration: client.addHeaderButton({ id: 'activity', workspaceId, button }), signature });
    }
  };
  const unsubscribe = store.subscribe(syncHeaders);
  syncHeaders();
  return () => {
    unsubscribe();
    for (const value of headers.values()) value.registration.remove();
    headers.clear();
    removeSidebar();
    removeScreen();
  };
}
