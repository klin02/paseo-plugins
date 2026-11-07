import type { PluginClientContext } from '@getpaseo/plugin/client';
import { getStatus, heartbeat, notifyCompletion, type MonitorHeartbeat, type CompletionEvent } from '../shared/contracts.ts';
import { isChatGptUrl, ReplyTracker, type PageSnapshot } from './tracker.ts';
import { TaskStore } from './tasks.ts';

// Runs in the guest page; reply text is hashed there and never sent to the daemon.
export const snapshotScript = String.raw`(async () => {
  if (location.origin !== 'https://chatgpt.com') return null;
  const slot = '__paseoWebGptNotifierV1';
  if (!window[slot]) {
    const state = { documentId: crypto.randomUUID(), cancellations: 0, submissions: 0 };
    state.stopHandler = event => {
      if (event.target?.closest?.('[data-testid="stop-button"], [data-testid="fruitjuice-stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]')) state.cancellations++;
      if (event.target?.closest?.('[data-testid="send-button"], button[aria-label="发送"], button[aria-label="发送提示"], [data-testid="regenerate-response-button"], button[aria-label="Send prompt"], button[aria-label="Regenerate"], button[aria-label="重新生成"]')) state.submissions++;
    };
    state.submitHandler = event => {
      if (event.target?.querySelector?.('#prompt-textarea, [contenteditable="true"], textarea')) state.submissions++;
    };
    state.keyHandler = event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && (event.target?.isContentEditable || event.target?.closest?.('#prompt-textarea, textarea, [role="textbox"]'))) state.submissions++;
    };
    document.addEventListener('click', state.stopHandler, true);
    document.addEventListener('submit', state.submitHandler, true);
    document.addEventListener('keydown', state.keyHandler, true);
    window[slot] = state;
  }
  const state = window[slot];
  const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(x => x.toString(16).padStart(2, '0')).join('');
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const turns = Array.from(document.querySelectorAll('[data-turn="user"], [data-turn="assistant"]'));
  const labeled = Array.from(document.querySelectorAll('[data-conversation-role="user"], [data-conversation-role="assistant"]'));
  const messages = labeled.length ? labeled.map(element => element.parentElement) : turns.length ? turns : Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'));
  const role = element => element.getAttribute('data-turn') || element.getAttribute('data-message-author-role')
    || element.querySelector('[data-conversation-role]')?.getAttribute('data-conversation-role');
  let userIndex = -1;
  for (let i = 0; i < messages.length; i++) if (role(messages[i]) === 'user') userIndex = i;
  const user = messages[userIndex];
  const answer = messages.slice(userIndex + 1).filter(element => role(element) === 'assistant').at(-1);
  const messageId = element => element?.getAttribute('data-turn-id') || element?.getAttribute('data-message-id') || element?.closest('[data-message-id]')?.getAttribute('data-message-id')
    || element?.querySelector('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids') || '';
  const promptKey = user ? (messageId(user) || await hash(user.textContent || '')) : '';
  const text = answer?.querySelector('.markdown, .prose')?.textContent || answer?.textContent || '';
  const answerKey = answer && text.trim() ? (messageId(answer) || 'answer-' + messages.indexOf(answer)) : '';
  const answerHash = answerKey ? await hash(text.trim()) : '';
  const generating = Array.from(document.querySelectorAll('[data-testid="stop-button"], [data-testid="fruitjuice-stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]')).some(visible);
  const error = Array.from(document.querySelectorAll('main [role="alert"], [data-testid="conversation-error"]'))
    .some(element => visible(element) && /something went wrong|error (?:generating|in message)|network error|出错|出了点问题|生成.*错误|网络错误/i.test(element.textContent || ''));
  return {
    documentId: state.documentId, url: location.origin + location.pathname,
    title: document.title.replace(/\s*[-–|]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT',
    promptKey, answerKey, answerHash,
    completionId: await hash(location.pathname + ':' + promptKey + ':' + answerKey + ':' + answerHash),
    focused: document.visibilityState === 'visible' && document.hasFocus?.() === true,
    generating, cancellations: state.cancellations, submissions: state.submissions, error,
  };
})()`;

interface BrowserView {
  getAttribute(name: string): string | null;
  getURL(): string;
  executeJavaScript(script: string): Promise<PageSnapshot | null>;
}
interface DesktopGlobals {
  document?: {
    visibilityState?: string;
    hasFocus?(): boolean;
    querySelectorAll(selector: string): Iterable<BrowserView>;
    querySelector?(selector: string): {
      click(): void;
      getBoundingClientRect?(): { x: number; y: number; width: number; height: number };
    } | null;
  };
  paseoDesktop?: {
    platform?: string;
    notification?: { sendNotification(input: { title: string; body: string; data: Record<string, unknown> }): Promise<boolean> };
    events?: { on(event: string, handler: (payload: unknown) => void): Promise<() => void> };
    browser?: {
      focus(browserId: string): Promise<boolean>;
      executeAutomationCommand(request: Record<string, unknown>): Promise<{
        ok: boolean; result?: { tabs?: { browserId: string; workspaceId: string | null }[] };
      }>;
    };
  };
}
const desktopGlobals = () => globalThis as unknown as DesktopGlobals;
function isBrowserBeingViewed(browserId: string, guestFocused = false): boolean {
  const doc = desktopGlobals().document;
  if (doc?.visibilityState !== 'visible' || !(doc.hasFocus?.() || guestFocused)) return false;
  const rect = doc.querySelector?.(`[data-paseo-browser-surface="${browserId}"][aria-hidden="false"]`)?.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 1 && rect.height > 1 && rect.x >= 0 && rect.y >= 0);
}
export async function focusBrowser(browserId: string, signal?: AbortSignal): Promise<void> {
  const browser = desktopGlobals().paseoDesktop?.browser;
  if (!browser) throw new Error('请在 Paseo 桌面端打开此标签页。');
  if (!/^[A-Za-z0-9_-]+$/.test(browserId)) throw new Error('无效标签页。');
  // shortcut: the Desktop tab selector is internal to Paseo 0.14/0.15.
  for (let attempt = 0; attempt < 40; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error('Plugin stopped'), { name: 'AbortError' });
    const tab = desktopGlobals().document?.querySelector?.(`[data-testid="workspace-tab-browser_${browserId}"]`);
    const viewRect = desktopGlobals().document?.querySelector?.(`[data-paseo-browser-surface="${browserId}"][aria-hidden="false"]`)?.getBoundingClientRect?.();
    const alreadyVisible = viewRect && viewRect.width > 1 && viewRect.height > 1 && viewRect.x >= 0 && viewRect.y >= 0;
    if (tab || alreadyVisible) {
      tab?.click();
      if (!await browser.focus(browserId)) throw new Error('标签页已关闭。');
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 50);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(Object.assign(new Error('Plugin stopped'), { name: 'AbortError' }));
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  throw new Error('无法选择原标签页，请在工作区中打开。');
}
interface TrackedTab {
  view: BrowserView;
  tracker: ReplyTracker;
  reading: boolean;
  completedTurn: number;
  completionId: string | null;
}
export function startBrowserMonitor(client: PluginClientContext, isWeb: boolean, store = new TaskStore()): () => void {
  const host = desktopGlobals();
  const supported = isWeb && Boolean(host.paseoDesktop && host.document);
  const tabs = new Map<string, TrackedTab>();
  const observedViews = new Set<BrowserView>();
  const completions = new Map<string, CompletionEvent>();
  const delivering = new Set<string>();
  const workspaces = new Map<string, string | null>();
  let stopped = false;
  let busy = false;
  let mapping = false;
  let lastMapping = -Infinity;
  let lastHeartbeat = 0;
  let browserError: string | null = null;
  let sample: MonitorHeartbeat['sample'] = null;
  let removeClick = () => {};
  store.setMonitor({ supported });
  const clientId = `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  // shortcut: these native Desktop bridges are internal to Paseo 0.14/0.15.
  if (supported && host.paseoDesktop?.events) {
    void host.paseoDesktop.events.on('notification-click', payload => {
      const data = (payload as { data?: Record<string, unknown> } | null)?.data;
      if (data?.webGptClient !== clientId || typeof data.browserId !== 'string' || !tabs.has(data.browserId)) return;
      client.openScreen({ screenId: 'activity', params: { focus: data.browserId } });
    }).then(remove => { if (stopped) remove(); else removeClick = remove; })
      .catch(() => store.setMonitor({ error: '无法注册通知点击处理，请从 Web GPT 侧栏返回会话。' }));
  }
  const notifyLocal = (id: string, title: string) => {
    const notification = host.paseoDesktop?.notification;
    if (!notification) { store.setMonitor({ error: '当前桌面端未提供系统通知接口。' }); return; }
    void notification.sendNotification({
      title: `ChatGPT 回复完成 · ${title.slice(0, 200)}`,
      body: '回复已完成，点击返回会话。',
      data: { webGptClient: clientId, browserId: id },
    }).then(sent => {
      if (!stopped && !sent) store.setMonitor({ error: '系统通知未发送，请检查操作系统的 Paseo 通知设置。' });
    }).catch(() => { if (!stopped) store.setMonitor({ error: '系统通知发送失败，请检查桌面端通知设置。' }); });
  };
  const refreshWorkspaces = () => {
    const browser = host.paseoDesktop?.browser;
    if (!browser || mapping || Date.now() - lastMapping < 5000) return;
    mapping = true;
    void browser.executeAutomationCommand({ type: 'browser.automation.execute.request',
      requestId: `web-gpt-${clientId}-${Date.now()}`, command: { command: 'list_tabs', args: {} },
    }).then(result => {
      if (stopped) return;
      if (!result.ok || !Array.isArray(result.result?.tabs)) throw new Error('browser mapping unavailable');
      workspaces.clear();
      for (const tab of result.result.tabs) workspaces.set(tab.browserId, tab.workspaceId);
      for (const task of store.getSnapshot().tasks) store.upsert({ ...task, workspaceId: workspaces.get(task.browserId) ?? null });
      lastMapping = Date.now();
      if (store.getSnapshot().error === '无法读取标签页所属工作区，页眉指示正在重试。') store.setMonitor({ error: null });
    }).catch(() => {
      if (!stopped) store.setMonitor({ error: '无法读取标签页所属工作区，页眉指示正在重试。' });
    }).finally(() => { mapping = false; });
  };
  const sendQueued = () => {
    for (const event of completions.values()) {
      if (delivering.has(event.id)) continue;
      delivering.add(event.id);
      void client.rpc(notifyCompletion, event).then(result => {
        if (!stopped && result.status !== 'disabled') completions.delete(event.id);
      }).catch(() => { browserError = 'ntfy 投递失败，插件会自动重试。'; })
        .finally(() => { delivering.delete(event.id); });
    }
  };
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    let browserCount = 0;
    try {
      const status = await client.rpc(getStatus, {});
      if (stopped) return;
      store.setMonitor({ enabled: status.enabled });
      if (status.enabled && status.configured) sendQueued();
      if (supported && status.enabled) {
        refreshWorkspaces();
        const seen = new Set<string>();
        const views = host.document!.querySelectorAll('webview[data-paseo-browser-id]');
        for (const view of views) {
          const id = view.getAttribute('data-paseo-browser-id');
          if (!id) continue;
          try {
            if (!isChatGptUrl(view.getURL())) continue;
            seen.add(id); browserCount++; observedViews.add(view);
            let tab = tabs.get(id);
            if (!tab || tab.view !== view) {
              tab = { view, tracker: new ReplyTracker(), reading: false, completedTurn: 0, completionId: null };
              tabs.set(id, tab);
            }
            if (tab.reading) continue;
            const tracked = tab;
            tracked.reading = true;
            // A frozen guest only stalls its own read, never other tabs or ntfy retries.
            void view.executeJavaScript(snapshotScript).then(page => {
              if (stopped || tabs.get(id) !== tracked) return;
              if (!page || !isChatGptUrl(page.url)) throw new Error('invalid snapshot');
              sample = { at: Date.now(), hasPrompt: Boolean(page.promptKey), hasAnswer: Boolean(page.answerKey),
                generating: page.generating, submissions: page.submissions, cancellations: page.cancellations };
              const current = new URL(view.getURL());
              if (current.origin + current.pathname !== page.url) return;
              browserError = null;
              const tracker = tracked.tracker;
              const completion = tracker.observe(page, Date.now());
              const justCompleted = tracker.state === 'completed' && tracker.turn > tracked.completedTurn;
              // Keep read acknowledgements tied to a turn, not later DOM/hash changes.
              if (justCompleted) tracked.completionId = `${page.documentId}:${tracker.turn}:${page.completionId}`;
              store.upsert({ browserId: id, workspaceId: workspaces.get(id) ?? null,
                url: page.url, title: page.title, state: tracker.state,
                completionId: tracker.state === 'completed' ? tracked.completionId : null, updatedAt: Date.now() });
              if (tracker.state === 'completed' && isBrowserBeingViewed(id, page.focused)) store.markRead(id, tracked.completionId);
              if (justCompleted) {
                tracked.completedTurn = tracker.turn; notifyLocal(id, page.title);
              }
              if (completion && status.configured) {
                // Keep immutable pending events when another turn starts or a tab closes.
                completions.set(completion.id, completion);
                tracker.acknowledge(completion.id);
                sendQueued();
              }
            }).catch(() => {
              if (stopped || tabs.get(id) !== tracked) return;
              browserError = '网页读取失败，插件会自动重试。';
              const old = store.getSnapshot().tasks.find(task => task.browserId === id);
              store.upsert({ browserId: id, workspaceId: workspaces.get(id) ?? null,
                url: old?.url ?? 'https://chatgpt.com/', title: old?.title ?? 'ChatGPT', state: 'unavailable', completionId: old?.completionId ?? null, updatedAt: Date.now() });
            }).finally(() => { tracked.reading = false; });
          } catch { browserError = '网页正在导航，插件会自动重试。'; }
        }
        for (const id of tabs.keys()) if (!seen.has(id)) tabs.delete(id);
        store.retain(seen);
      } else { tabs.clear(); store.clear(); }
      if (!stopped && Date.now() - lastHeartbeat >= 15000) {
        await client.rpc(heartbeat, { clientId, browserCount, supported, error: browserError, sample });
        lastHeartbeat = Date.now();
      }
    } catch {
      // A disconnected host is retried without creating another Paseo connection.
    } finally { busy = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 1000);
  return () => {
    if (stopped) return;
    stopped = true; clearInterval(timer); removeClick(); tabs.clear(); completions.clear(); store.clear();
    for (const view of observedViews) {
      try {
        if (isChatGptUrl(view.getURL())) void view.executeJavaScript(`(() => {
          if (location.origin !== 'https://chatgpt.com') return;
          const state = window.__paseoWebGptNotifierV1;
          if (state) {
            document.removeEventListener('click', state.stopHandler, true);
            document.removeEventListener('submit', state.submitHandler, true);
            document.removeEventListener('keydown', state.keyHandler, true);
          }
          delete window.__paseoWebGptNotifierV1;
        })()`).catch(() => {});
      } catch { /* The guest may already have been closed. */ }
    }
    observedViews.clear();
  };
}
