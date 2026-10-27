import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeLifecycle } from "../server/lifecycle.ts";

test("Stop drains the browser before release, then a requested restart can acquire", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const draining = new Promise<void>(resolve => { release = resolve; });
  const lifecycle = bridgeLifecycle({
    async start() { calls.push("bridge.start"); }, async stop() { calls.push("bridge.stop"); },
  }, { start() { calls.push("browser.start"); }, stop() { calls.push("browser.stop"); return draining; } });
  const stopped = lifecycle.stop();
  const restarted = lifecycle.start();
  await Promise.resolve();
  assert.deepEqual(calls, ["browser.stop"]);
  release(); await stopped; await restarted;
  assert.deepEqual(calls, ["browser.stop", "bridge.stop", "bridge.start", "browser.start"]);
});

test("Stop racing an active start waits for acquisition and never starts browser polling", async () => {
  const calls: string[] = [];
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const lifecycle = bridgeLifecycle({
    async start() { calls.push("bridge.start"); entered(); await gate; },
    async stop() { calls.push("bridge.stop"); },
  }, { start() { calls.push("browser.start"); }, async stop() { calls.push("browser.stop"); } });
  const started = lifecycle.start(); await ready;
  const stopped = lifecycle.stop(); await Promise.resolve();
  assert.deepEqual(calls, ["bridge.start", "browser.stop"]);
  release(); await started; await stopped;
  assert.deepEqual(calls, ["bridge.start", "browser.stop", "bridge.stop"]);
});

test("a superseded start is skipped and errors do not block later controls", async () => {
  const calls: string[] = []; let fail = true;
  const lifecycle = bridgeLifecycle({
    async start() { calls.push("bridge.start"); if (fail) throw new Error("acquire failed"); },
    async stop() { calls.push("bridge.stop"); },
  }, { start() { calls.push("browser.start"); }, async stop() { calls.push("browser.stop"); } });
  const skipped = lifecycle.start(); const stopped = lifecycle.stop();
  await skipped; await stopped;
  assert.deepEqual(calls, ["browser.stop", "bridge.stop"]);
  await assert.rejects(lifecycle.start(), /acquire failed/);
  fail = false; await lifecycle.start(); await lifecycle.stop();
  assert.deepEqual(calls.slice(-4), ["bridge.start", "browser.start", "browser.stop", "bridge.stop"]);
});
