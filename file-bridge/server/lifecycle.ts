// Serialize control changes while Stop immediately prevents new browser dispatch.
export function bridgeLifecycle(bridge: { start(): Promise<void>; stop(): Promise<void> },
  browser: { start(): void; stop(): Promise<void> }) {
  let pending = Promise.resolve();
  let request = 0;
  const enqueue = (operation: () => Promise<void>) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  return {
    start() {
      const version = ++request;
      return enqueue(async () => {
        if (version !== request) return;
        await bridge.start();
        if (version === request) browser.start();
      });
    },
    stop() {
      ++request;
      const draining = browser.stop();
      void draining.catch(() => {});
      return enqueue(async () => { await draining; await bridge.stop(); });
    },
  };
}
