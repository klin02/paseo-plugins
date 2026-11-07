import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore, type BrowserTask } from '../client/tasks.ts';

const completed = (completionId = 'reply-one'): Omit<BrowserTask, 'unread'> => ({
  browserId: 'tab', workspaceId: 'workspace', url: 'https://chatgpt.com/c/one',
  title: 'Conversation', state: 'completed', completionId, updatedAt: 10,
});

test('read acknowledgements survive polling and metadata updates for the same reply', () => {
  const store = new TaskStore();
  store.upsert(completed());
  assert.equal(store.getSnapshot().tasks[0].unread, true);
  store.markRead('tab', 'reply-one');
  store.upsert({ ...completed(), title: 'Renamed', workspaceId: 'other', updatedAt: 20 });
  assert.equal(store.getSnapshot().tasks[0].unread, false);
  const before = store.getSnapshot();
  store.markRead('tab', 'reply-one');
  assert.equal(store.getSnapshot(), before, 'repeated acknowledgement does not publish');
});

test('an earlier focus request cannot mark a later reply read', () => {
  const store = new TaskStore();
  store.upsert(completed());
  store.upsert({ ...completed(), state: 'running', completionId: null });
  assert.equal(store.getSnapshot().tasks[0].unread, false);
  store.upsert(completed('reply-two'));
  store.markRead('tab', 'reply-one');
  assert.equal(store.getSnapshot().tasks[0].unread, true);
  store.markRead('tab', 'reply-two');
  assert.equal(store.getSnapshot().tasks[0].unread, false);
});

test('temporary read errors preserve acknowledgement and navigation resets it', () => {
  const store = new TaskStore();
  store.upsert(completed());
  store.markRead('tab', 'reply-one');
  store.upsert({ ...completed(), state: 'unavailable' });
  store.upsert(completed());
  assert.equal(store.getSnapshot().tasks[0].unread, false);
  store.upsert({ ...completed(), state: 'idle', completionId: null, url: 'https://chatgpt.com/c/other' });
  store.markRead('tab', 'reply-one');
  assert.equal(store.getSnapshot().tasks[0].state, 'idle');
  assert.equal(store.getSnapshot().tasks[0].unread, false);
  store.clear();
  store.markRead('tab', 'reply-one');
  assert.equal(store.getSnapshot().tasks.length, 0);
});
