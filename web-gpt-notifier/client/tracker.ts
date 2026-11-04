import type { CompletionEvent } from '../shared/contracts.ts';

export interface PageSnapshot {
  documentId: string;
  url: string;
  title: string;
  promptKey: string;
  answerKey: string;
  answerHash: string;
  completionId: string;
  generating: boolean;
  cancellations: number;
  submissions: number;
  error: boolean;
}

export function isChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com';
  } catch {
    return false;
  }
}

export class ReplyTracker {
  private previous: PageSnapshot | null = null;
  private armed = false;
  private stableHash = '';
  private stableSince = 0;
  private delivered = '';
  private cancelledPrompt = '';
  private submissionPending = false;

  observe(page: PageSnapshot, now: number): CompletionEvent | null {
    if (!isChatGptUrl(page.url)) return null;
    const old = this.previous;
    const navigation = old && new URL(old.url).pathname !== new URL(page.url).pathname;
    const continuedNewChat = old && old.documentId === page.documentId
      && new URL(old.url).pathname === '/' && new URL(page.url).pathname.startsWith('/c/')
      && ((this.armed && old.promptKey === page.promptKey)
        || this.submissionPending || page.submissions > old.submissions);
    if (old && page.submissions > old.submissions) this.submissionPending = true;
    if (!old || old.documentId !== page.documentId || (navigation && !continuedNewChat)) {
      this.armed = page.generating;
      this.stableHash = '';
      this.cancelledPrompt = '';
      this.submissionPending = false;
    } else if (page.cancellations > old.cancellations || page.error) {
      this.armed = false;
      this.submissionPending = false;
      this.cancelledPrompt = page.promptKey;
      this.stableHash = '';
    } else if (this.submissionPending && (page.promptKey !== old.promptKey
      || page.answerHash !== old.answerHash)) {
      this.armed = Boolean(page.promptKey);
      this.submissionPending = false;
      this.cancelledPrompt = '';
      this.stableHash = '';
    } else if (page.generating && !old.generating) {
      this.armed = true;
      this.submissionPending = false;
      this.cancelledPrompt = '';
      this.stableHash = '';
    }
    this.previous = page;
    if (!this.armed || page.error || page.generating || !page.promptKey
      || this.cancelledPrompt === page.promptKey || !page.answerKey || !page.answerHash) {
      this.stableHash = '';
      return null;
    }
    const fingerprint = `${page.promptKey}:${page.answerKey}:${page.answerHash}`;
    if (this.stableHash !== fingerprint) {
      this.stableHash = fingerprint;
      this.stableSince = now;
      return null;
    }
    if (now - this.stableSince < 1800 || this.delivered === page.completionId) return null;
    return { id: page.completionId, url: page.url, title: page.title.slice(0, 200) };
  }

  acknowledge(id: string): void {
    this.delivered = id;
    this.armed = false;
  }
}
