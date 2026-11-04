import type { PluginClientContext } from '@getpaseo/plugin/client';
import { getStatus, heartbeat, notifyCompletion } from '../shared/contracts.ts';
import { isChatGptUrl, ReplyTracker, type PageSnapshot } from './tracker.ts';

// Runs in the guest page; reply text is hashed there and never sent to the daemon.
export const snapshotScript = String.raw`(async () => {
  if (location.origin !== 'https://chatgpt.com') return null;
  const slot = '__paseoWebGptNotifierV1';
  if (!window[slot]) {
    const state = { documentId: crypto.randomUUID(), cancellations: 0, submissions: 0 };
    state.stopHandler = event => {
      if (event.target?.closest?.('[data-testid="stop-button"], [data-testid="fruitjuice-stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]')) state.cancellations++;
      if (event.target?.closest?.('[data-testid="send-button"], [data-testid="regenerate-response-button"], button[aria-label="Send prompt"], button[aria-label="Regenerate"], button[aria-label="重新生成"]')) state.submissions++;
    };
    state.submitHandler = event => {
      if (event.target?.querySelector?.('#prompt-textarea')) state.submissions++;
    };
    state.keyHandler = event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target?.closest?.('#prompt-textarea')) state.submissions++;
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
  const messages = Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'));
  let userIndex = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i].getAttribute('data-message-author-role') === 'user') userIndex = i;
  const user = messages[userIndex];
  const answer = messages.slice(userIndex + 1).filter(element => element.getAttribute('data-message-author-role') === 'assistant').at(-1);
  const messageId = element => element?.getAttribute('data-message-id') || element?.closest('[data-message-id]')?.getAttribute('data-message-id') || '';
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
    generating, cancellations: state.cancellations, submissions: state.submissions, error,
  };
})()`;

interface BrowserView {
  getAttribute(name: string): string | null;
  getURL(): string;
  executeJavaScript(script: string): Promise<PageSnapshot | null>;
}
interface DesktopGlobals {
  document?: { querySelectorAll(selector: string): Iterable<BrowserView> };
  paseoDesktop?: { platform?: string };
}

export function startBrowserMonitor(client: PluginClientContext, isWeb: boolean): () => void {
  const host = globalThis as unknown as DesktopGlobals;
  const supported = isWeb && Boolean(host.paseoDesktop && host.document);
  const trackers = new Map<string, ReplyTracker>();
  const pending = new Set<string>();
  const observedViews = new Set<BrowserView>();
  let stopped = false;
  let busy = false;
  let lastHeartbeat = 0;
  let browserError: string | null = null;
  const clientId = `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    let browserCount = 0;
    try {
      const status = await client.rpc(getStatus, {});
      if (stopped) return;
      if (supported && status.configured && status.enabled) {
        const seen = new Set<string>();
        // shortcut: Paseo 0.14 resident webviews are internal; recheck on an SDK upgrade.
        const views = host.document!.querySelectorAll('webview[data-paseo-browser-id]');
        for (const view of views) {
          const id = view.getAttribute('data-paseo-browser-id');
          if (!id) continue;
          try {
            if (!isChatGptUrl(view.getURL())) continue;
            seen.add(id);
            browserCount++;
            observedViews.add(view);
            if (pending.has(id)) continue;
            pending.add(id);
            // A frozen guest only stalls its own read, never the other tabs.
            void view.executeJavaScript(snapshotScript).then(async page => {
              if (stopped || !page || !isChatGptUrl(page.url)) return;
              const current = new URL(view.getURL());
              if (current.origin + current.pathname !== page.url) return;
              browserError = null;
              let tracker = trackers.get(id);
              if (!tracker) { tracker = new ReplyTracker(); trackers.set(id, tracker); }
              const completion = tracker.observe(page, Date.now());
              if (!completion) return;
              const result = await client.rpc(notifyCompletion, completion);
              if (result.status !== 'disabled') tracker.acknowledge(completion.id);
            }).catch(() => {
              browserError = '读取或发送失败；保持桌面端运行，插件会自动重试。';
            }).finally(() => { pending.delete(id); });
          } catch {
            browserError = '网页正在导航，插件会自动重试。';
          }
        }
        for (const id of trackers.keys()) if (!seen.has(id)) trackers.delete(id);
      } else {
        trackers.clear();
      }
      if (!stopped && Date.now() - lastHeartbeat >= 15000) {
        await client.rpc(heartbeat, { clientId, browserCount, supported, error: browserError });
        lastHeartbeat = Date.now();
      }
    } catch {
      // A disconnected host is retried without creating another Paseo connection.
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
    trackers.clear();
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
