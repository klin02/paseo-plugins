import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BridgeScreen } from "./client/bridge";

function BridgeItem({ openScreen, currentScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Files" active={currentScreen?.screenId === "bridge"} onPress={() => openScreen({screenId:"bridge"})} />;
}
export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({id:"bridge", title:"File Bridge", Component:BridgeScreen}),
    client.addSidebarHeaderItem({id:"bridge", title:"File Bridge", Component:BridgeItem}),
    client.addCommandCenterItem({id:"open-bridge", title:"File Bridge 文件桥接", icon:"Files", context:"global", onSelect:({openScreen}) => openScreen({screenId:"bridge"})}),
  ];
  return () => { for (const remove of removers.reverse()) remove(); };
}
