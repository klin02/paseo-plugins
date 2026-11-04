import type { PluginServerContext } from "@getpaseo/plugin/server";
import { notificationSettings, notifyCompletion, getStatus, heartbeat, testNotification } from "./shared/contracts";
import { Delivery } from "./server/delivery";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(notificationSettings);
  const delivery = new Delivery(async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error("Notification settings unavailable");
    return state.values;
  });
  server.handle(notifyCompletion, event => delivery.notify(event));
  server.handle(getStatus, () => delivery.status());
  server.handle(heartbeat, input => delivery.heartbeat(input));
  server.handle(testNotification, () => delivery.test());
  return () => delivery.stop();
}
