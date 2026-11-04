import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { startBrowserMonitor } from '../client/web.ts';
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
