import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { URL } from 'node:url';
import ts from 'typescript';
import { TaskStore, type BrowserTask } from '../client/tasks.ts';

// Compile JSX without loading React Native's device runtime in Node.
const compiled = ts.transpileModule(readFileSync(new URL('../client/activity.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
type Element = { type: string | ((props: any) => Element); props: any };
const jsx = (type: Element['type'], props: any): Element => ({ type, props });
function harness() {
  const effects: (() => void)[] = [];
  const runtime: Record<string, unknown> = {
    react: { useEffect: (effect: () => void) => effects.push(effect), useSyncExternalStore: (_: unknown, read: () => unknown) => read() },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': Object.fromEntries(['ActivityIndicator', 'Pressable', 'ScrollView', 'Text', 'View'].map(name => [name, name])),
    '@getpaseo/plugin/client/ui': { Icon: 'Icon', SidebarRow: 'SidebarRow' },
  };
  const exports: any = {};
  vm.runInNewContext(compiled, { exports, require: (name: string) => { assert.ok(name in runtime); return runtime[name]; } });
  const screens: any[] = [], sidebars: any[] = [], headers: any[] = [], routes: any[] = [], focused: string[] = [];
  let removed = 0;
  const client = {
    addScreen: (value: any) => { screens.push(value); return () => { removed++; }; },
    addSidebarHeaderItem: (value: any) => { sidebars.push(value); return () => { removed++; }; },
    addHeaderButton: (value: any) => {
      const record = { ...value, updates: 0, removed: 0 };
      headers.push(record);
      return { update: (patch: any) => { Object.assign(record.button, patch); record.updates++; }, remove: () => { record.removed++; } };
    },
    openScreen: (route: any) => routes.push(route),
  };
  const store = new TaskStore();
  const cleanup = exports.registerActivityUi(client, store, async (id: string) => { focused.push(id); });
  return { store, screens, sidebars, headers, routes, focused, cleanup, effects, removed: () => removed };
}
const task = (id: string, workspaceId: string | null, state: BrowserTask['state']): BrowserTask => ({
  browserId: id, workspaceId, state, title: `Conversation ${id}`, url: `https://chatgpt.com/c/${id}`, updatedAt: 10,
});
const props = (compact = false, dark = false) => ({
  theme: { colors: { foreground: dark ? '#fff' : '#111', foregroundMuted: dark ? '#aaa' : '#555', accent: '#08f', surface0: dark ? '#111' : '#fff' } },
  layout: { compact, platform: 'web' }, host: { id: 'test', label: 'Test' }, params: {},
});
function elements(value: any): Element[] {
  if (value === null || value === undefined || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== 'object' || !value.type) return [];
  if (typeof value.type === 'function') return elements(value.type(value.props));
  return [value, ...elements(value.props.children)];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (typeof value === 'object') return typeof value.type === 'function' ? text(value.type(value.props)) : text(value.props?.children);
  return String(value);
}

test('workspace indicators follow local task lifecycle and release registrations', () => {
  const h = harness();
  assert.equal(h.screens[0].id, 'activity');
  assert.equal(h.sidebars[0].id, 'activity');
  assert.equal(h.headers.length, 0);
  h.store.upsert(task('one', 'workspace-a', 'running'));
  h.store.upsert(task('two', 'workspace-b', 'idle'));
  h.store.upsert(task('unknown-workspace', null, 'running'));
  assert.equal(h.headers.length, 2);
  assert.equal(h.headers[0].button.label, 'GPT 1');
  assert.equal(typeof h.headers[0].button.icon, 'function');
  h.headers[0].button.behavior.onPress();
  assert.equal(h.routes[0].params.workspaceId, 'workspace-a');
  h.store.upsert(task('one', 'workspace-a', 'completed'));
  assert.equal(h.headers[0].button.label, 'GPT');
  assert.equal(h.headers[0].button.icon, 'Globe');
  h.store.retain(new Set(['two']));
  assert.equal(h.headers[0].removed, 1);
  h.cleanup();
  assert.equal(h.headers[1].removed, 1);
  assert.equal(h.removed(), 2);
  h.store.upsert(task('later', 'workspace-c', 'running'));
  assert.equal(h.headers.length, 2, 'cleanup unsubscribes the store');
});

test('task screen renders titles, statuses, workspace filtering and focus action across layouts/themes', async () => {
  const h = harness();
  h.store.setMonitor({ supported: true });
  h.store.upsert(task('one', 'workspace-a', 'running'));
  h.store.upsert(task('two', 'workspace-b', 'completed'));
  for (const compact of [false, true]) for (const dark of [false, true]) {
    const surface = props(compact, dark);
    const tree = h.screens[0].Component({ ...surface, params: { workspaceId: 'workspace-a' } });
    assert.match(text(tree), /Conversation one/);
    assert.match(text(tree), /进行中/);
    assert.doesNotMatch(text(tree), /Conversation two/);
    const nodes = elements(tree);
    assert.equal(nodes.find(node => node.type === 'ScrollView')?.props.contentContainerStyle.padding, compact ? 16 : 24);
    assert.equal(nodes.filter(node => node.type === 'ActivityIndicator').length, 1);
    assert.ok(nodes.filter(node => node.type === 'Text').every(node => node.props.style.color));
    const open = nodes.find(node => node.type === 'Pressable');
    open?.props.onPress();
    await Promise.resolve();
  }
  assert.equal(h.focused.length, 0, 'rows navigate through the screen before focusing');
  assert.equal(h.routes.length, 4);
  assert.ok(h.routes.every(route => route.params.focus === 'one'));
  let popover: any;
  const row = h.sidebars[0].Component({ ...props(), currentScreen: null, openPopover: (value: any) => { popover = value; } });
  assert.equal(row.props.label, 'Web GPT');
  row.props.onPress();
  let closed = false;
  const tree = popover({ ...props(true, true), close: () => { closed = true; }, openScreen: () => {} });
  assert.match(text(tree), /Conversation one/);
  assert.match(text(tree), /Conversation two/);
  assert.match(text(tree), /已完成/);
  elements(tree).find(node => node.type === 'Pressable')?.props.onPress();
  assert.equal(closed, true);
  assert.equal(h.routes.at(-1).params.focus, 'one');
  h.cleanup();
});


test('focus route opens original workspace before selecting its resident browser', async () => {
  const h = harness();
  h.store.upsert(task('one', 'workspace-a', 'running'));
  const workspaces: string[] = [];
  h.screens[0].Component({ ...props(), params: { focus: 'one' }, navigation: {
    openWorkspace: ({ workspaceId }: { workspaceId: string }) => {
      assert.equal(h.focused.length, 0);
      workspaces.push(workspaceId);
    },
  } });
  h.effects.pop()?.();
  await Promise.resolve();
  assert.deepEqual(workspaces, ['workspace-a']);
  assert.deepEqual(h.focused, ['one']);
  assert.equal(h.store.getSnapshot().error, null);
  h.cleanup();
});

test('missing original workspace or navigation reports failure without creating or focusing a tab', () => {
  for (const missing of ['workspace', 'navigation', 'task']) {
    const h = harness();
    if (missing !== 'task') h.store.upsert(task('one', missing === 'workspace' ? null : 'workspace-a', 'completed'));
    h.screens[0].Component({ ...props(), params: { focus: 'one' },
      navigation: missing === 'navigation' ? undefined : { openWorkspace: () => assert.fail('must not navigate') },
    });
    h.effects.pop()?.();
    assert.match(h.store.getSnapshot().error ?? '', /无法定位原工作区/);
    assert.equal(h.focused.length, 0);
    h.cleanup();
  }
});
