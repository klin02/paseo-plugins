import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferences, bridgeStatus, bridgeControl, queueTransfer, transferStatus } from "./shared/contracts";
import { Bridge } from "./server/bridge";
import { BrowserWorker } from "./server/browser-worker";
import { bridgeLifecycle } from "./server/lifecycle";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const readSettings = async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(state.error);
    return state.values;
  };
  const bridge = new Bridge(readSettings);
  const browser = new BrowserWorker(readSettings, () => bridge.status());
  browser.start();
  const { start, stop } = bridgeLifecycle(bridge, browser);
  server.handle(bridgeStatus, async () => ({ ...await bridge.status(), browserError: browser.error }));
  server.handle(bridgeControl, async ({ action }) => {
    if (action === "start") await start(); else await stop();
    return bridge.status();
  });
  server.handle(queueTransfer, input => bridge.queue(input));
  server.handle(transferStatus, ({ id }) => bridge.job(id));
  const unsubscribe = settings.subscribe(() => stop());
  void settings.read().then(async state => {
    if (state.status === "ready" && state.values.autoStart && process.platform === "win32") await start();
  }).catch(error => console.error("File Bridge startup:", error.message));
  return async () => { unsubscribe(); await stop(); };
}
