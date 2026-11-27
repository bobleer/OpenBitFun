import "../../src/agentEvents";
import { effect, mount, signal, Text, View } from "nsh";
import { installBackendConnection } from "../../src/bridge";
import { closeGlobalSearch, openGlobalSearch, searchItems, searchOpen, searchQuery, type SearchItem } from "../../src/globalSearchStore";
import { workspaces } from "../../src/state";
import { palette, space } from "../../src/theme";
import { GlobalSearchPanel } from "../../src/ui/GlobalSearchPanel";
import { Button } from "../../src/ui/primitives";

const actions: SearchItem[] = [
  { id: "command:new-session", label: "Create a session", kind: "command", target: "session", detail: "" },
  { id: "command:browser", label: "Open the Browser", kind: "command", target: "browser", detail: "" },
  { id: "command:files", label: "Open the Files", kind: "command", target: "files", detail: "" },
];
const chosen = signal("");
const requestStatus = signal("");
let reply: ((value: unknown) => void) | undefined;

workspaces.set([{ id: "workspace-search", rootPath: "/repo" }]);
installBackendConnection({
  kind: "dev",
  ready: async () => ({ version: null, platform: null, dataDir: null }),
  state: () => "connected",
  error: () => "",
  lastSeq: () => null,
  subscribe: () => () => {},
  invoke: async (command, args) => {
    const request = args?.request as { query?: string } | undefined;
    if (command !== "search_session_content" || request?.query !== "old query") return [];
    return new Promise(resolve => {
      reply = resolve;
      requestStatus.set("Search request pending");
    });
  },
});

function Fixture() {
  effect(() => {
    if (!searchQuery() && reply) {
      reply({ hits: [{ sessionId: "session-late", sessionTitle: "Late result", snippet: "This reply is stale" }] });
      reply = undefined;
      setTimeout(() => requestStatus.set("Search request settled"), 0);
    }
  });
  return <View style={{ flex: 1, padding: space.xl, backgroundColor: palette().canvas }}>
    <Button label="Open search palette" onPress={() => openGlobalSearch(">")} />
    <Button label="Open content search" onPress={() => openGlobalSearch()} />
    <Text>{chosen()}</Text>
    <Text>{requestStatus()}</Text>
    <Text>{searchItems().map(item => item.label).join(", ")}</Text>
    <If when={searchOpen()}>
      <GlobalSearchPanel commands={() => actions} settings={() => []} capabilities={() => []} icon={(_, fallback) => fallback}
        shortcut="Ctrl+K" activate={item => { chosen.set("Selected " + item.target); closeGlobalSearch(); }} />
    </If>
  </View>;
}

mount(Fixture);
