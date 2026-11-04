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
