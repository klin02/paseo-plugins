import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Delivery } from "../server/delivery.ts";
import type { NotificationSettings } from "../shared/contracts.ts";

const event = { id: "a".repeat(64), title: "Example conversation", url: "https://chatgpt.com/c/example-conversation" };

async function fixture(handler: (attempt: number) => number | undefined) {
  const requests: { body: Record<string, unknown>; authorization: string | undefined }[] = [];
  const directory = await mkdtemp(join(tmpdir(), "web-gpt-notifier-test-"));
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ body: JSON.parse(body), authorization: request.headers.authorization });
    const status = handler(requests.length);
    if (status === 0) request.destroy();
    else if (status !== undefined) response.writeHead(status).end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server address unavailable");
  const settings: NotificationSettings = { enabled: true, serverUrl: `http://127.0.0.1:${address.port}`, topic: "test-topic", token: "test-token" };
  const create = () => new Delivery(async () => settings, { directory, retryDelayMs: 1, timeoutMs: 1000 });
  const delivery = create();
  return { directory, settings, requests, create, delivery, async close() {
    await delivery.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

test("publishes only notification metadata and deduplicates concurrent calls and restarts", async () => {
  const f = await fixture(() => 200);
  try {
    assert.deepEqual(await Promise.all([f.delivery.notify(event), f.delivery.notify(event)]), [{ status: "sent" }, { status: "duplicate" }]);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0], { authorization: "Bearer test-token", body: { topic: "test-topic", title: "ChatGPT 回复完成 · Example conversation",
      message: "网页版 GPT 已完成本次回复。", click: event.url, tags: ["speech_balloon"] } });
    const persisted = JSON.parse(await readFile(join(f.directory, "delivered.json"), "utf8"));
    assert.deepEqual(persisted.ids, [event.id]);
    assert.equal(JSON.stringify(persisted).includes("test-topic"), false);
    assert.equal(JSON.stringify(persisted).includes("test-token"), false);
    assert.equal((await stat(join(f.directory, "delivered.json"))).mode & 0o777, 0o600);
    const restarted = f.create();
    assert.deepEqual(await restarted.notify(event), { status: "duplicate" });
    const status = await restarted.status();
    assert.equal(status.delivered, 1);
    assert.equal(status.configured, true);
    assert.equal(status.lastError, null);
    assert.equal(JSON.stringify(status).includes("test-token"), false);
    await restarted.stop();
  } finally { await f.close(); }
});

test("retries transient responses and records success only after delivery", async () => {
  const f = await fixture(attempt => attempt < 3 ? (attempt === 1 ? 429 : 503) : 200);
  try {
    assert.deepEqual(await f.delivery.notify(event), { status: "sent" });
    assert.equal(f.requests.length, 3);
    assert.equal((await f.delivery.status()).delivered, 1);
  } finally { await f.close(); }
});

test("permanent failures are private, not retried or remembered, and can recover", async () => {
  let fail = true;
  const f = await fixture(() => fail ? 403 : 200);
  try {
    await assert.rejects(f.delivery.notify(event), /^Error: Notification delivery failed$/);
    assert.equal(f.requests.length, 1);
    const failed = await f.delivery.status();
    assert.equal(failed.delivered, 0);
    assert.equal(failed.lastError, "Notification delivery failed");
    await assert.rejects(readFile(join(f.directory, "delivered.json")), { code: "ENOENT" });
    fail = false;
    assert.deepEqual(await f.delivery.notify(event), { status: "sent" });
    assert.equal((await f.delivery.status()).lastError, null);
  } finally { await f.close(); }
});

test("exhausted transient failures leave no delivered marker", async () => {
  const f = await fixture(() => 503);
  try {
    await assert.rejects(f.delivery.notify(event), /Notification delivery failed/);
    assert.equal(f.requests.length, 3);
    assert.equal((await f.delivery.status()).delivered, 0);
    await assert.rejects(readFile(join(f.directory, "delivered.json")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("reads current settings and reports disabled without sending or storing events", async () => {
  const f = await fixture(() => 200);
  try {
    f.settings.topic = "";
    assert.deepEqual(await f.delivery.notify(event), { status: "disabled" });
    assert.equal((await f.delivery.status()).configured, false);
    f.settings.topic = "test-topic"; f.settings.enabled = false;
    assert.deepEqual(await f.delivery.notify(event), { status: "disabled" });
    assert.equal(f.requests.length, 0);
    await assert.rejects(f.delivery.test(), /disabled or not configured/);
    f.settings.enabled = true;
    assert.deepEqual(await f.delivery.notify(event), { status: "sent" });
  } finally { await f.close(); }
});

test("test notifications and heartbeat status do not create completion markers", async () => {
  const f = await fixture(() => 200);
  try {
    assert.deepEqual(await f.delivery.test(), { status: "sent" });
    assert.deepEqual(f.delivery.heartbeat({ clientId: "desktop-test", browserCount: 2, supported: true, error: null }), {});
    const status = await f.delivery.status();
    assert.equal(status.delivered, 0);
    assert.equal(status.monitors.length, 1);
    assert.equal(status.monitors[0].browserCount, 2);
    assert.equal(status.monitors[0].lastSeenAt > 0, true);
    await assert.rejects(readFile(join(f.directory, "delivered.json")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("stop aborts pending retry delays and prevents future work", async () => {
  const f = await fixture(() => 503);
  const delivery = new Delivery(async () => f.settings, { directory: f.directory, retryDelayMs: 10000 });
  try {
    const pending = delivery.notify(event);
    const rejection = assert.rejects(pending, /Notification service stopped/);
    while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 1));
    await delivery.stop();
    await rejection;
    await assert.rejects(delivery.notify(event), /Notification service stopped/);
    assert.equal(f.requests.length, 1);
  } finally { await delivery.stop(); await f.close(); }
});


test("network errors are bounded and never recorded as delivered", async () => {
  const f = await fixture(() => 0);
  try {
    await assert.rejects(f.delivery.notify(event), /Notification delivery failed/);
    assert.equal(f.requests.length, 3);
    assert.equal((await f.delivery.status()).delivered, 0);
  } finally { await f.close(); }
});

test("stalled requests time out and failed events remain eligible for retry", async () => {
  const f = await fixture(() => undefined);
  const delivery = new Delivery(async () => f.settings, { directory: f.directory, retryDelayMs: 1, timeoutMs: 20 });
  try {
    await assert.rejects(delivery.notify(event), /Notification delivery failed/);
    assert.equal(f.requests.length, 3);
    assert.equal((await delivery.status()).delivered, 0);
  } finally { await delivery.stop(); await f.close(); }
});


test("failed persistence is retried before deduplication without publishing twice", async () => {
  const f = await fixture(() => 200);
  try {
    await f.delivery.status();
    const destination = join(f.directory, "delivered.json");
    await mkdir(destination);
    await assert.rejects(f.delivery.notify(event), /Notification storage unavailable/);
    await assert.rejects(f.delivery.notify(event), /Notification storage unavailable/);
    assert.equal(f.requests.length, 1);
    await rm(destination, { recursive: true });
    assert.deepEqual(await f.delivery.notify(event), { status: "duplicate" });
    assert.equal((await f.delivery.status()).lastError, null);
    assert.equal(f.requests.length, 1);
    const restarted = f.create();
    assert.deepEqual(await restarted.notify(event), { status: "duplicate" });
    assert.equal((await restarted.status()).delivered, 1);
    await restarted.stop();
  } finally { await f.close(); }
});

test("stop aborts an in-flight request before its timeout", async () => {
  const f = await fixture(() => undefined);
  const delivery = new Delivery(async () => f.settings, { directory: f.directory, timeoutMs: 10000 });
  try {
    const pending = delivery.notify(event);
    const rejection = assert.rejects(pending, /Notification service stopped/);
    while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 1));
    const before = Date.now();
    await delivery.stop();
    await rejection;
    assert.equal(Date.now() - before < 1000, true);
    assert.equal(f.requests.length, 1);
  } finally { await delivery.stop(); await f.close(); }
});


test("status remains responsive while a notification request is stalled", async () => {
  const f = await fixture(() => undefined);
  const delivery = new Delivery(async () => f.settings, { directory: f.directory, timeoutMs: 10000 });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = delivery.notify(event);
    const rejection = assert.rejects(pending, /Notification service stopped/);
    while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 1));
    const status = await Promise.race([
      delivery.status(),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Status blocked on delivery")), 500); }),
    ]);
    assert.equal(status.enabled, true);
    assert.equal(status.configured, true);
    assert.equal(status.delivered, 0);
    await delivery.stop();
    await rejection;
  } finally { clearTimeout(deadline); await delivery.stop(); await f.close(); }
});

test("concurrent initial status and delivery share state loading and preserve persisted dedup", async () => {
  const f = await fixture(() => 200);
  try {
    await writeFile(join(f.directory, "delivered.json"), JSON.stringify({ ids: [event.id], delivered: 7, lastDeliveryAt: 123 }));
    const [status, result] = await Promise.all([f.delivery.status(), f.delivery.notify(event)]);
    assert.equal(status.delivered, 7);
    assert.deepEqual(result, { status: "duplicate" });
    assert.equal(f.requests.length, 0);
    assert.equal((await f.delivery.status()).lastDeliveryAt, 123);
  } finally { await f.close(); }
});

test("nonblocking status sanitizes settings failures", async () => {
  const f = await fixture(() => 200);
  const delivery = new Delivery(async () => { throw new Error("private destination and token"); }, { directory: f.directory });
  try {
    await assert.rejects(delivery.status(), /^Error: Notification service unavailable$/);
  } finally { await delivery.stop(); await f.close(); }
});
