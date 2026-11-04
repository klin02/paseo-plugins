import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { TaskStore } from '../client/tasks.ts';
import { focusBrowser, startBrowserMonitor } from '../client/web.ts';
import type { PageSnapshot } from '../client/tracker.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));
test('monitor covers resident tabs, survives a frozen guest, retries RPC and disposes', async () => {
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const originalNow = Date.now;
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals.document; const originalDesktop = globals.paseoDesktop;
  let tick = () => {}; let now = 0; let cleared = false;
  let removed = 0; let attempts = 0; let sent = 0;
  const snapshot: PageSnapshot = {
    documentId: 'document', url: 'https://chatgpt.com/c/example', title: 'Example',
    promptKey: 'user', answerKey: 'reply', answerHash: 'hash', completionId: 'a'.repeat(64),
    generating: false, cancellations: 0, submissions: 0, error: false,
  };
  const activeView = {
    getAttribute: () => 'active', getURL: () => snapshot.url + '?model=example',
    executeJavaScript: async (script: string) => {
      if (script.includes('removeEventListener')) { removed++; return null; }
      return { ...snapshot };
    },
  };
  const frozenView = {
    getAttribute: () => 'frozen', getURL: () => 'https://chatgpt.com/c/frozen',
    executeJavaScript: () => new Promise(() => {}),
  };
  const otherView = {
    getAttribute: () => 'unrelated', getURL: () => 'https://example.com',
    executeJavaScript: () => { throw new Error('must never read unrelated pages'); },
  };
  const heartbeats: unknown[] = [];
  const client = {
    rpc: async (contract: { name: string }, input: unknown) => {
      if (contract.name === 'monitor.status') return { enabled: true, configured: true };
      if (contract.name === 'monitor.heartbeat') { heartbeats.push(input); return {}; }
      assert.equal(contract.name, 'completion.notify'); attempts++;
      if (attempts === 1) throw new Error('temporary disconnect');
      sent++; return { status: 'sent' };
    },
  } as unknown as PluginClientContext;
  try {
    Date.now = () => now;
    globals.document = { querySelectorAll: () => [activeView, frozenView, otherView] };
    globals.paseoDesktop = { platform: 'win32' };
    globalThis.setInterval = ((callback: () => void) => { tick = callback; return 1; }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => { cleared = true; }) as typeof clearInterval;
    const stop = startBrowserMonitor(client, true);
    await settle();
    snapshot.generating = true; now = 1000; tick(); await settle();
    snapshot.generating = false; now = 2000; tick(); await settle();
    now = 4000; tick(); await settle();
    assert.equal(attempts, 1); assert.equal(sent, 0);
    now = 5000; tick(); await settle();
    assert.equal(attempts, 2); assert.equal(sent, 1);
    now = 16000; tick(); await settle();
    assert.equal(attempts, 2, 'acknowledged completion is not resent');
    assert.ok(heartbeats.length > 0, 'frozen tab must not block heartbeat');
    stop(); await settle();
    assert.ok(cleared); assert.equal(removed, 1);
    now = 18000; tick(); await settle(); assert.equal(attempts, 2);
  } finally {
    globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
    Date.now = originalNow;
    if (originalDocument === undefined) delete globals.document; else globals.document = originalDocument;
    if (originalDesktop === undefined) delete globals.paseoDesktop; else globals.paseoDesktop = originalDesktop;
  }
});

test('disconnect and contribution reload recover without duplicate timers or history notices', async () => {
  const originalInterval = globalThis.setInterval; const originalClear = globalThis.clearInterval;
  const originalNow = Date.now;
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals.document; const originalDesktop = globals.paseoDesktop;
  const timers = new Map<number, () => void>(); let timerId = 0;
  let connected = false; let sent = 0; let now = 0; let cleanups = 0; let reads = 0;
  const snapshot: PageSnapshot = {
    documentId: 'document', url: 'https://chatgpt.com/c/example', title: 'Example',
    promptKey: 'user', answerKey: 'reply', answerHash: 'hash', completionId: 'b'.repeat(64),
    generating: false, cancellations: 0, submissions: 0, error: false,
  };
  const view = {
    getAttribute: () => 'resident', getURL: () => snapshot.url,
    executeJavaScript: async (script: string) => {
      if (script.includes('removeEventListener')) { cleanups++; return null; }
      reads++; return { ...snapshot };
    },
  };
  const client = {
    rpc: async (contract: { name: string }) => {
      if (!connected) throw new Error('host disconnected');
      if (contract.name === 'monitor.status') return { enabled: true, configured: true };
      if (contract.name === 'monitor.heartbeat') return {};
      assert.equal(contract.name, 'completion.notify'); sent++; return { status: 'sent' };
    },
  } as unknown as PluginClientContext;
  const tick = async (time: number) => { now = time; for (const callback of timers.values()) callback(); await settle(); };
  let stop = () => {};
  try {
    Date.now = () => now;
    globals.document = { querySelectorAll: () => [view] }; globals.paseoDesktop = { platform: 'win32' };
    globalThis.setInterval = ((callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: number) => { timers.delete(id); }) as unknown as typeof clearInterval;
    stop = startBrowserMonitor(client, true); await settle();
    assert.equal(reads, 0);
    connected = true; await tick(1000); assert.equal(reads, 1);
    snapshot.generating = true; await tick(2000);
    connected = false; await tick(3000); assert.equal(reads, 2);
    connected = true; snapshot.generating = false; await tick(4000); await tick(6000);
    assert.equal(sent, 1);
    stop(); await settle(); assert.equal(timers.size, 0); assert.equal(cleanups, 1);
    stop = startBrowserMonitor(client, true); await settle(); await tick(9000);
    assert.equal(timers.size, 1); assert.equal(sent, 1, 'reload establishes a baseline for the completed page');
    stop(); await settle(); assert.equal(timers.size, 0); assert.equal(cleanups, 2);
  } finally {
    stop(); globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; Date.now = originalNow;
    if (originalDocument === undefined) delete globals.document; else globals.document = originalDocument;
    if (originalDesktop === undefined) delete globals.paseoDesktop; else globals.paseoDesktop = originalDesktop;
  }
});

test('local activity and native notifications continue through ntfy stalls and clean up closed tabs', async () => {
  const originalInterval = globalThis.setInterval; const originalClear = globalThis.clearInterval;
  const originalNow = Date.now;
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals.document; const originalDesktop = globals.paseoDesktop;
  let tick = () => {}; let now = 0; let configured = false; let enabled = true;
  let listener: (payload: unknown) => void = () => {}; let clickRemoved = 0;
  let deliver: (value: unknown) => void = () => {};
  let rejectDelivery: (error: Error) => void = () => {}; let requests = 0;
  const notices: { title: string; data: unknown }[] = []; const focused: string[] = [];
  const snapshot: PageSnapshot = {
    documentId: 'doc', url: 'https://chatgpt.com/c/local', title: 'Local conversation',
    promptKey: 'user', answerKey: 'reply', answerHash: 'hash', completionId: 'c'.repeat(64),
    generating: false, cancellations: 0, submissions: 0, error: false,
  };
  let failRead = false;
  const view = { getAttribute: () => 'local', getURL: () => snapshot.url,
    executeJavaScript: async (script: string) => {
      if (script.includes('removeEventListener')) return null;
      if (failRead) throw new Error('navigating');
      return { ...snapshot };
    } };
  let views = [view];
  const client = { openScreen: (input: { params: { focus: string } }) => { focused.push(input.params.focus); }, rpc: async (contract: { name: string }) => {
    if (contract.name === 'monitor.status') return { configured, enabled };
    if (contract.name === 'monitor.heartbeat') return {};
    requests++; return await new Promise((resolve, reject) => { deliver = resolve; rejectDelivery = reject; });
  } } as unknown as PluginClientContext;
  const store = new TaskStore(); let stop = () => {};
  const step = async (time: number) => { now = time; tick(); await settle(); };
  try {
    Date.now = () => now;
    globals.document = { querySelectorAll: () => views };
    globals.paseoDesktop = {
      notification: { sendNotification: async (input: { title: string; data: unknown }) => { notices.push(input); return true; } },
      events: { on: async (_: string, handler: (payload: unknown) => void) => { listener = handler; return () => { clickRemoved++; }; } },
      browser: { focus: async (id: string) => { focused.push(id); }, executeAutomationCommand: async () => ({ ok: true,
        result: { tabs: [{ browserId: 'local', workspaceId: 'workspace' }] } }) },
    };
    globalThis.setInterval = ((callback: () => void) => { tick = callback; return 1; }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;
    stop = startBrowserMonitor(client, true, store); await settle();
    assert.equal(store.getSnapshot().tasks[0].state, 'idle');
    assert.equal(store.getSnapshot().tasks[0].workspaceId, 'workspace');
    assert.equal(notices.length, 0, 'history is only a baseline even without ntfy');
    snapshot.generating = true; await step(1000);
    assert.equal(store.getSnapshot().tasks[0].state, 'running');
    assert.equal(notices.length, 1); assert.match(notices[0].title, /任务开始.*Local conversation/);
    snapshot.generating = false; await step(2000); await step(4000);
    assert.equal(store.getSnapshot().tasks[0].state, 'completed');
    assert.equal(notices.length, 2); assert.match(notices[1].title, /回复完成/);
    assert.equal(requests, 0, 'no ntfy topic is needed for local notifications');
    configured = true; await step(5000); assert.equal(requests, 1);
    await step(6000); assert.equal(requests, 1); assert.equal(notices.length, 2);
    listener({ data: notices[1].data }); await settle(); assert.deepEqual(focused, ['local']);
    listener({ data: { browserId: 'local', webGptClient: 'another-computer' } }); await settle();
    assert.equal(focused.length, 1, 'ignore another contribution notification');
    snapshot.generating = true; snapshot.promptKey = 'user-2'; snapshot.completionId = 'd'.repeat(64);
    await step(7000); assert.equal(store.getSnapshot().tasks[0].state, 'running');
    assert.equal(notices.length, 3, 'a stalled ntfy call does not stall a later turn');
    rejectDelivery(new Error('temporary failure after next turn started')); await settle();
    snapshot.generating = false; await step(8000);
    assert.equal(requests, 2, 'earlier completion is retried independently of the current turn');
    deliver({ status: 'sent' }); await settle();
    await step(10000);
    assert.equal(requests, 3, 'the later completion is delivered as well');
    assert.equal(store.getSnapshot().tasks[0].state, 'completed', 'old delivery acknowledgment cannot disarm a new turn');
    assert.equal(notices.length, 4);
    failRead = true; await step(11000); assert.equal(store.getSnapshot().tasks[0].state, 'unavailable');
    failRead = false; await step(12000); assert.equal(store.getSnapshot().tasks[0].state, 'completed');
    assert.equal(notices.length, 4, 'temporary read errors do not duplicate completion');
    views = []; await step(13000); assert.equal(store.getSnapshot().tasks.length, 0);
    listener({ data: notices[1].data }); await settle(); assert.equal(focused.length, 1, 'closed tab is ignored');
    views = [view]; await step(14000); assert.equal(notices.length, 4, 'reopened completed page establishes a baseline');
    enabled = false; await step(15000); assert.equal(store.getSnapshot().tasks.length, 0);
    stop(); await settle(); assert.equal(clickRemoved, 1);
  } finally {
    stop(); globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; Date.now = originalNow;
    if (originalDocument === undefined) delete globals.document; else globals.document = originalDocument;
    if (originalDesktop === undefined) delete globals.paseoDesktop; else globals.paseoDesktop = originalDesktop;
  }
});

test('browser focus selects the existing tab and rejects a closed native guest', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals.document; const originalDesktop = globals.paseoDesktop;
  let selected = false; let live = true;
  try {
    globals.document = { querySelector: (selector: string) => {
      assert.equal(selector, '[data-testid="workspace-tab-browser_original"]');
      return { click: () => { selected = true; } };
    } };
    globals.paseoDesktop = { browser: { focus: async (id: string) => { assert.equal(id, 'original'); assert.ok(selected); return live; } } };
    await focusBrowser('original');
    live = false;
    await assert.rejects(focusBrowser('original'), /标签页已关闭/);
    await assert.rejects(focusBrowser('invalid"selector'), /无效标签页/);
  } finally {
    if (originalDocument === undefined) delete globals.document; else globals.document = originalDocument;
    if (originalDesktop === undefined) delete globals.paseoDesktop; else globals.paseoDesktop = originalDesktop;
  }
});
