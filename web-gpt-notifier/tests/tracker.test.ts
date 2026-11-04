import assert from 'node:assert/strict';
import test from 'node:test';
import { isChatGptUrl, ReplyTracker, type PageSnapshot } from '../client/tracker.ts';

const page = (update: Partial<PageSnapshot> = {}): PageSnapshot => ({
  documentId: 'doc-1', url: 'https://chatgpt.com/c/conversation-1', title: 'Example',
  promptKey: 'user-1', answerKey: 'answer-1', answerHash: 'hash-1',
  completionId: 'a'.repeat(64), generating: false, cancellations: 0, submissions: 0, error: false, ...update,
});
const trackerWithBaseline = () => {
  const tracker = new ReplyTracker();
  assert.equal(tracker.observe(page(), 0), null);
  return tracker;
};

test('only exact HTTPS ChatGPT origin is accepted', () => {
  assert.ok(isChatGptUrl('https://chatgpt.com/c/abc'));
  for (const value of ['http://chatgpt.com', 'https://chatgpt.com.evil.test', 'https://chatgpt.com@evil.test', 'invalid']) assert.equal(isChatGptUrl(value), false);
});
test('existing completed history never notifies', () => {
  const tracker = trackerWithBaseline();
  assert.equal(tracker.observe(page(), 5000), null);
});
test('waits for generation to stop and answer to remain stable, then acknowledges once', () => {
  const tracker = trackerWithBaseline();
  assert.equal(tracker.observe(page({ generating: true }), 1000), null);
  assert.equal(tracker.observe(page({ generating: true }), 10000), null);
  assert.equal(tracker.observe(page(), 11000), null);
  const event = tracker.observe(page(), 13000);
  assert.equal(event?.id, 'a'.repeat(64));
  assert.equal(tracker.observe(page(), 14000)?.id, event?.id, 'failed delivery stays pending');
  tracker.acknowledge(event!.id);
  assert.equal(tracker.observe(page(), 16000), null);
});
test('new prompt can finish between polls without notifying an old answer', () => {
  const tracker = trackerWithBaseline();
  assert.equal(tracker.observe(page({ promptKey: 'user-2', answerKey: '', answerHash: '', submissions: 1 }), 1000), null);
  const done = page({ promptKey: 'user-2', answerKey: 'answer-2', answerHash: 'hash-2', submissions: 1 });
  assert.equal(tracker.observe(done, 2000), null);
  assert.ok(tracker.observe(done, 4000));
});
test('streaming text changes restart the stability window', () => {
  const tracker = new ReplyTracker();
  tracker.observe(page({ generating: true }), 0);
  tracker.observe(page(), 1000);
  assert.equal(tracker.observe(page({ answerHash: 'hash-2' }), 2500), null);
  assert.equal(tracker.observe(page({ answerHash: 'hash-2' }), 4000), null);
  assert.ok(tracker.observe(page({ answerHash: 'hash-2' }), 4500));
});
test('manual stop suppresses partial replies; later regeneration can notify', () => {
  const tracker = new ReplyTracker();
  tracker.observe(page({ generating: true }), 0);
  tracker.observe(page({ generating: true, cancellations: 1 }), 1000);
  tracker.observe(page({ cancellations: 1 }), 2000);
  assert.equal(tracker.observe(page({ cancellations: 1 }), 10000), null);
  tracker.observe(page({ generating: true, cancellations: 1 }), 11000);
  tracker.observe(page({ cancellations: 1 }), 12000);
  assert.ok(tracker.observe(page({ cancellations: 1 }), 14000));
});
test('error notices suppress successful completion', () => {
  const tracker = new ReplyTracker();
  tracker.observe(page({ generating: true }), 0);
  tracker.observe(page({ error: true }), 1000);
  assert.equal(tracker.observe(page({ error: true }), 5000), null);
});
test('switching conversations and refreshing reset the baseline', () => {
  const tracker = new ReplyTracker();
  tracker.observe(page({ generating: true }), 0);
  const other = page({ url: 'https://chatgpt.com/c/conversation-2' });
  tracker.observe(other, 1000);
  assert.equal(tracker.observe(other, 5000), null);
  tracker.observe(page({ generating: true }), 6000);
  tracker.observe(page({ documentId: 'new-document' }), 7000);
  assert.equal(tracker.observe(page({ documentId: 'new-document' }), 10000), null);
});
test('a new chat acquiring its conversation URL preserves the pending turn', () => {
  const tracker = new ReplyTracker();
  tracker.observe(page({ url: 'https://chatgpt.com/', generating: true }), 0);
  tracker.observe(page(), 1000);
  assert.ok(tracker.observe(page(), 3000));
});
test('independent tabs have independent completion tracking', () => {
  const left = new ReplyTracker(); const right = trackerWithBaseline();
  left.observe(page({ generating: true }), 0); left.observe(page(), 1000);
  assert.ok(left.observe(page(), 3000));
  assert.equal(right.observe(page(), 3000), null);
});

test('hydrated existing history after an empty page never arms completion', () => {
  const tracker = new ReplyTracker();
  tracker.observe(page({ promptKey: '', answerKey: '', answerHash: '' }), 0);
  tracker.observe(page(), 1000);
  assert.equal(tracker.observe(page(), 4000), null);
});
test('history hydration after SPA navigation never sends an old completion', () => {
  const tracker = trackerWithBaseline();
  const url = 'https://chatgpt.com/c/older-conversation';
  tracker.observe(page({ url, promptKey: '', answerKey: '', answerHash: '' }), 1000);
  tracker.observe(page({ url }), 2000);
  assert.equal(tracker.observe(page({ url }), 5000), null);
});
test('submission intent waits for a new message before arming', () => {
  const tracker = trackerWithBaseline();
  tracker.observe(page({ submissions: 1 }), 1000);
  assert.equal(tracker.observe(page({ submissions: 1 }), 4000), null);
  const done = page({ submissions: 1, promptKey: 'new-user', answerHash: 'new-answer' });
  tracker.observe(done, 5000);
  assert.ok(tracker.observe(done, 7000));
});

test('quick first reply preserves captured submission when a new conversation URL appears', () => {
  const tracker = new ReplyTracker();
  tracker.observe(page({ url: 'https://chatgpt.com/', promptKey: '', answerKey: '', answerHash: '' }), 0);
  const done = page({ submissions: 1 });
  tracker.observe(done, 1000);
  assert.ok(tracker.observe(done, 4000));
});
