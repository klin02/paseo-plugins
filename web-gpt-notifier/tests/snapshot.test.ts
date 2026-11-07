import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { snapshotScript } from '../client/web.ts';
import type { PageSnapshot } from '../client/tracker.ts';

class Element {
  role: string; textContent: string; id: string; visible: boolean; turnRole = false; parentElement: Element | null = null;
  constructor(role: string, textContent: string, id: string, visible = true) {
    this.role = role; this.textContent = textContent; this.id = id; this.visible = visible;
  }
  getAttribute(name: string) {
    if (name === (this.turnRole ? 'data-turn' : 'data-message-author-role')) return this.role;
    if (name === (this.turnRole ? 'data-turn-id' : 'data-message-id')) return this.id;
    return null;
  }
  closest() { return null; }
  querySelector(_selector?: string): Element | null { return null; }
  getClientRects() { return this.visible ? [{}] : []; }
}
function fixture() {
  const messages = [new Element('user', 'old question', 'u1'), new Element('assistant', 'old answer', 'a1'), new Element('user', 'new question', 'u2'), new Element('assistant', 'private latest reply', 'a2')];
  const state = { messages, turns: [] as Element[], labeled: [] as Element[], handlers: {} as Record<string, (event: unknown) => void>, stops: [] as Element[], alerts: [] as Element[], click: null as null | ((event: unknown) => void) };
  const context = vm.createContext({
    location: { origin: 'https://chatgpt.com', pathname: '/c/example' },
    document: {
      title: 'A conversation - ChatGPT',
      addEventListener: (name: string, handler: (event: unknown) => void) => { state.handlers[name] = handler; if (name === 'click') state.click = handler; },
      querySelectorAll: (selector: string) => selector.includes('data-conversation-role=') ? state.labeled : selector.includes('data-turn=') ? state.turns : selector.includes('data-message-author-role') ? state.messages : selector.includes('stop-button') ? state.stops : state.alerts,
    },
    window: {}, crypto: webcrypto, TextEncoder, URL, getComputedStyle: () => ({ visibility: 'visible' }),
  });
  return { state, context, read: () => vm.runInContext(snapshotScript, context) as Promise<PageSnapshot> };
}
test('guest snapshot scopes the latest answer and exports hashes without reply text', async () => {
  const f = fixture();
  const result = await f.read();
  assert.equal(result.promptKey, 'u2'); assert.equal(result.answerKey, 'a2');
  assert.equal(result.title, 'A conversation'); assert.match(result.answerHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('private latest reply'), false);
  assert.equal(result.generating, false);
  f.state.messages.pop();
  const waiting = await f.read();
  assert.equal(waiting.answerKey, '', 'never falls back to the prior question answer');
});
test('visible stop controls, errors and cancellation clicks are reported', async () => {
  const f = fixture();
  f.state.stops = [new Element('', '', '', false)];
  assert.equal((await f.read()).generating, false);
  f.state.stops.push(new Element('', '', ''));
  assert.equal((await f.read()).generating, true);
  f.state.click!({ target: { closest: () => ({}) } });
  assert.equal((await f.read()).cancellations, 1);
  f.state.alerts.push(new Element('', 'Something went wrong', ''));
  assert.equal((await f.read()).error, true);
});
test('stable identity persists for a document and changes for a regenerated answer', async () => {
  const f = fixture();
  const first = await f.read(); const second = await f.read();
  assert.equal(first.documentId, second.documentId); assert.equal(first.completionId, second.completionId);
  f.state.messages[f.state.messages.length - 1] = new Element('assistant', 'regenerated answer', 'a2');
  assert.notEqual((await f.read()).completionId, first.completionId);
});
test('guest script does nothing outside exact ChatGPT origin', async () => {
  const f = fixture();
  vm.runInContext("location.origin='https://other.example'", f.context);
  assert.equal(await f.read(), null);
});

test('current ChatGPT data-turn articles use stable turn IDs while preserving old markup support', async () => {
  const f = fixture();
  f.state.turns = [new Element('user', 'current prompt', 'turn-u'), new Element('assistant', 'current reply', 'turn-a')];
  for (const element of f.state.turns) element.turnRole = true;
  const snapshot = await f.read();
  assert.equal(snapshot.promptKey, 'turn-u');
  assert.equal(snapshot.answerKey, 'turn-a');
  assert.match(snapshot.answerHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(snapshot).includes('current reply'), false);
});

test('current conversation-role headings identify their message containers', async () => {
  const f = fixture();
  const user = new Element('', 'new question', 'current-user');
  const assistant = new Element('', 'new answer', 'current-assistant');
  const labels = ['user', 'assistant'].map(role => {
    const label = new Element('', '', '');
    label.getAttribute = name => name === 'data-conversation-role' ? role : null;
    return label;
  });
  [user, assistant].forEach((container, index) => {
    labels[index].parentElement = container;
    container.querySelector = selector => selector === '[data-conversation-role]' ? labels[index] : null;
  });
  f.state.labeled = labels;
  const result = await f.read();
  assert.equal(result.promptKey, 'current-user');
  assert.equal(result.answerKey, 'current-assistant');
  assert.match(result.answerHash, /^[a-f0-9]{64}$/);
});
test('submission on a contenteditable composer does not require a legacy editor ID', async () => {
  const f = fixture(); await f.read();
  f.state.handlers.keydown({ key: 'Enter', shiftKey: false, isComposing: false, target: { isContentEditable: true } });
  assert.equal((await f.read()).submissions, 1);
  f.state.handlers.keydown({ key: 'Enter', shiftKey: true, isComposing: false, target: { isContentEditable: true } });
  assert.equal((await f.read()).submissions, 1);
});

test('guest focus is reported only while the page is visible and focused', async () => {
  const f = fixture();
  assert.equal((await f.read()).focused, false);
  vm.runInContext("document.visibilityState = 'visible'; document.hasFocus = () => true", f.context);
  assert.equal((await f.read()).focused, true);
  vm.runInContext("document.visibilityState = 'hidden'", f.context);
  assert.equal((await f.read()).focused, false);
  vm.runInContext("document.visibilityState = 'visible'; document.hasFocus = () => false", f.context);
  assert.equal((await f.read()).focused, false);
});
