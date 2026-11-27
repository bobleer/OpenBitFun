import { Text, View } from "nsh";
import type { RefreshableBinding } from "../figureBindingDeclarations";
import { formatCount } from "../format";
import { tr } from "../i18n";
import { palette, space, textStyle } from "../theme";
import { SelectDropdown } from "./overlays";
import { Button } from "./primitives";
import type { createFigureResourceBinding } from "./figureResourceBinding";

export function FigureResourceControls(props: {
  name: string;
  binding: RefreshableBinding;
  reader: ReturnType<typeof createFigureResourceBinding>;
  supported: boolean;
}) {
  const state = () => props.reader.state(props.name);
  const feedback = () => {
    if (!props.supported) return tr("chat.figures.sources.liveUnsupported");
    if (state().phase === "failed") return tr("chat.figures.sources.resourceUnavailable");
    if (state().phase === "empty") return tr("chat.figures.sources.noResources");
    if (state().phase === "connected") return tr("chat.figures.sources.refreshInterval", {
      seconds: formatCount(props.binding.refreshIntervalSeconds),
    });
    return "";
  };
  return (
    <View style={{ gap: space.xs }}>
      <If when={props.supported}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xs }}>
          <If when={!state().servers.length || (state().phase === "failed" && !state().resource)}>
            <Button size="xs" variant="secondary" label={tr("chat.figures.sources.connectResource")}
              accessibilityLabel={`figure-resource-connect-${props.name}`}
              loading={state().phase === "loading"}
              onPress={() => void props.reader.discover(props.name)} />
          </If>
          <If when={state().servers.length > 0}>
            <SelectDropdown size="sm" options={state().servers} value={state().server}
              placeholder={tr("chat.figures.sources.selectServer")}
              accessibilityLabel={`figure-resource-server-${props.name}`}
              onChange={server => void props.reader.selectServer(props.name, server)} />
          </If>
          <If when={state().rows.length > 0}>
            <SelectDropdown size="sm" options={state().rows.map(row => ({ value: row.uri, label: row.title || row.name }))}
              value={state().resource} placeholder={tr("chat.figures.sources.selectResource")}
              accessibilityLabel={`figure-resource-select-${props.name}`}
              onChange={uri => props.reader.selectResource(props.name, props.binding, uri)} />
          </If>
          <If when={state().resource}>
            <Button size="xs" variant="ghost" label={tr("common.disconnect")}
              accessibilityLabel={`figure-resource-disconnect-${props.name}`}
              onPress={() => props.reader.disconnect(props.name)} />
          </If>
        </View>
      </If>
      <If when={feedback()}>
        {message => <Text style={textStyle("smallBody", { color: palette().textMuted })}>{message()}</Text>}
      </If>
    </View>
  );
}
