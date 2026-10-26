import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferences, bridgeStatus, bridgeControl, queueTransfer, transferStatus } from "./shared/contracts";
import { Bridge } from "./server/bridge";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const bridge = new Bridge(async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(state.error);
    return state.values;
  });
  server.handle(bridgeStatus, () => bridge.status());
  server.handle(bridgeControl, async ({ action }) => {
    if (action === "start") await bridge.start(); else await bridge.stop();
    return bridge.status();
  });
  server.handle(queueTransfer, input => bridge.queue(input));
  server.handle(transferStatus, ({ id }) => bridge.job(id));
  const unsubscribe = settings.subscribe(() => bridge.stop());
  void settings.read().then(async state => {
    if (state.status === "ready" && state.values.autoStart && process.platform === "win32") await bridge.start();
  }).catch(error => console.error("File Bridge startup:", error.message));
  return async () => { unsubscribe(); await bridge.stop(); };
}
