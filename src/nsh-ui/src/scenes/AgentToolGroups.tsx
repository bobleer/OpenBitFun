import { cleanup, computed, effect, signal, Text, untracked, View } from "nsh";
import { agentToolMetadata, agentToolNames, selectableToolNames, toolCatalogError } from "../agentsCatalogStore";
import { readUserToolGroups, resolveAgentToolGroups, type AgentToolGroup, type UserToolGroup } from "../agentToolGroups";
import { fleetDeviceContext } from "../bridge";
import { formatCount } from "../format";
import { localizeHostError, tr } from "../i18n";
import { skillsCatalogContextKey } from "../skillsCatalogStore";
import { compactLayout, layout, palette, space, textStyle } from "../theme";
import { ChoiceCheckbox } from "../ui/ChoiceIndicator";
import { Badge, Button, ConfigSection, InlineBanner, SearchInput } from "../ui/primitives";
import { InsetGroup } from "../ui/studio";
import { ToolGroupManager } from "./ToolGroupManager";

export function AgentToolGroups(props: {
  tools: readonly string[];
  changes?: ReadonlyMap<string, boolean>;
  editing: boolean;
  disabled?: boolean;
  onChange: (names: readonly string[], enabled: boolean) => void;
}) {
  const personal = signal<UserToolGroup[]>([]);
  const groupError = signal("");
  const groupsLoading = signal(true);
  const managerOpen = signal(false);
  const query = signal("");
  const selectedOnly = signal(false);
  const scope = untracked(skillsCatalogContextKey);
  const target = untracked(fleetDeviceContext);
  let mounted = true;
  cleanup(() => { mounted = false; });
  const current = () => mounted && scope === skillsCatalogContextKey();
  const resetFilter = () => {
    query.set("");
    selectedOnly.set(false);
  };
  effect(() => {
    if (!props.editing) resetFilter();
  });
  void readUserToolGroups(target).then(config => {
    if (current()) personal.set(config.groups);
  }).catch(error => {
    if (current()) groupError.set(localizeHostError(error));
  }).finally(() => {
    if (current()) groupsLoading.set(false);
  });

  const selected = computed(() => {
    const saved = new Set(props.tools);
    return new Set(selectableToolNames().filter(name => props.changes?.get(name) ?? saved.has(name)));
  });
  const groups = computed(() => resolveAgentToolGroups(selectableToolNames(), personal(), agentToolMetadata()));
  const primaryGroupByTool = computed(() => {
    const primary = new Map<string, string>();
    for (const group of groups()) {
      if (group.kind === "user") continue;
      for (const name of group.toolNames) if (!primary.has(name)) primary.set(name, group.id);
    }
    return primary;
  });
  const visible = computed(() => {
    const search = query().trim().toLowerCase();
    const seen = new Set<string>();
    return groups().flatMap(group => {
      const groupMatch = group.label.toLowerCase().includes(search);
      const names = group.toolNames.filter(name => {
        if (props.editing) {
          return (!selectedOnly() || selected().has(name)) &&
            (groupMatch || name.toLowerCase().includes(search) ||
              Boolean(agentToolMetadata().get(name)?.description?.toLowerCase().includes(search)));
        }
        if (!selected().has(name) || seen.has(name)) return false;
        seen.add(name);
        return true;
      });
      return names.length ? [{ group, names }] : [];
    });
  });
  return (
    <ConfigSection
      title={tr("agents.toolPermissionsTitle", {
        selected: formatCount(selected().size), total: formatCount(selectableToolNames().length),
      })}>
      <View style={{ gap: space.md }}>
        <If when={props.editing}>
          <View style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xs }}>
              <Button label={tr("agents.toolGroups.manageGroups")} leadingIcon="settings" variant="secondary" size="xs"
                disabled={props.disabled || groupsLoading() || Boolean(groupError())}
                accessibilityLabel="agent-tool-groups-manage" onPress={() => managerOpen.set(true)} />
              <Button label={tr("common.selected")} variant={selectedOnly() ? "secondary" : "ghost"} size="xs"
                accessibilityLabel="builder-tools-selected-only" onPress={() => selectedOnly.update(value => !value)} />
              <Button label={tr("common.all")} variant="ghost" size="xs"
                disabled={props.disabled || !selectableToolNames().length} accessibilityLabel="builder-tools-select-all"
                onPress={() => props.onChange(selectableToolNames(), true)} />
              <Button label={tr("common.clear")} variant="ghost" size="xs"
                disabled={props.disabled || !selected().size} accessibilityLabel="builder-tools-clear" onPress={() => {
                  selectedOnly.set(false);
                  props.onChange([...selected()], false);
                }} />
            </View>
            <SearchInput value={query()} size={compactLayout() ? "lg" : "md"} placeholder={tr("agents.filterTools")}
              accessibilityLabel="builder-tools-search" onChange={value => query.set(value)} />
          </View>
        </If>
        <If when={toolCatalogError() ?? ""}>
          {message => <InlineBanner tone="warning" message={localizeHostError(message())} />}
        </If>
        <If when={groupError()}>{message => <InlineBanner tone="warning" message={message()} />}</If>
        <Each of={visible()} key={row => row.group.id}>
          {row => (
            <ToolGroupCard group={row().group} visibleNames={row().names} selected={selected()}
              editing={props.editing} disabled={props.disabled}
              primaryGroupByTool={primaryGroupByTool()} onChange={props.onChange} />
          )}
        </Each>
        <If when={!visible().length}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
            <Text style={{ ...textStyle("caption", { color: palette().textSecondary }), flex: 1 }}>
              {tr(!props.editing ? "agents.noToolBindings" : !selectableToolNames().length ? "agents.noTools"
                : selectedOnly() && !query().trim() ? "agents.noToolsSelected" : "agents.noToolsMatch")}
            </Text>
            <If when={props.editing && Boolean(query() || selectedOnly())}>
              <Button label={tr("common.resetFilter")} variant="ghost" size="xs" onPress={resetFilter} />
            </If>
          </View>
        </If>
      </View>
      <If when={props.editing && managerOpen()}>
        <ToolGroupManager target={target} current={current} groups={personal()} toolNames={agentToolNames()}
          onChange={groups => personal.set(groups)} onClose={() => managerOpen.set(false)} />
      </If>
    </ConfigSection>
  );
}

function ToolGroupCard(props: {
  group: AgentToolGroup;
  visibleNames: readonly string[];
  selected: ReadonlySet<string>;
  editing: boolean;
  disabled?: boolean;
  primaryGroupByTool: ReadonlyMap<string, string>;
  onChange: (names: readonly string[], enabled: boolean) => void;
}) {
  const total = () => props.group.toolNames.length;
  const count = () => props.group.toolNames.filter(name => props.selected.has(name)).length;
  const checked = () => count() === total();
  const rowStyle = () => ({
    minHeight: compactLayout() ? layout.touchTarget : 36,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  });
  return (
    <If when={props.editing} else={
      <InsetGroup style={{ padding: space.md }}>
        <View style={{ gap: space.sm }}>
          <Text role="header" style={textStyle("label")}>{props.group.label}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            <Each of={props.visibleNames} key={name => name}>{name => <Badge tone="neutral" label={name()} />}</Each>
          </View>
        </View>
      </InsetGroup>
    }>
      <InsetGroup>
        <ChoiceCheckbox checked={checked()} indeterminate={count() > 0 && !checked()} disabled={props.disabled}
          accessibilityLabel={tr(checked() ? "agents.toolGroups.clearGroupTools" : "agents.toolGroups.enableGroupTools", {
            name: props.group.label,
          })}
          testID={`agent-tool-group-${props.group.id}`} onChange={enabled => props.onChange(props.group.toolNames, enabled)}
          style={rowStyle()}>
          <Text role="header" style={{ ...textStyle("label"), flex: 1, minWidth: 0 }}>{props.group.label}</Text>
          <Text style={textStyle("caption", { color: palette().textSecondary })}>
            {formatCount(count())}/{formatCount(total())}
          </Text>
        </ChoiceCheckbox>
        <Each of={props.visibleNames} key={name => name}>
          {name => (
            <ChoiceCheckbox checked={props.selected.has(name())} disabled={props.disabled} accessibilityLabel={name()}
              testID={props.primaryGroupByTool.get(name()) === props.group.id
                ? `builder-tool-${name()}` : `agent-tool-${props.group.id}-${name()}`}
              onChange={enabled => props.onChange([name()], enabled)}
              style={{ ...rowStyle(), paddingLeft: space.lg, borderTopWidth: 1, borderColor: palette().borderSubtle }}>
              <View style={{ flex: 1, minWidth: 0, gap: space.hair }}>
                <Text style={{ ...textStyle("mono"), numberOfLines: 1, textOverflow: "ellipsis" }}>{name()}</Text>
                <If when={agentToolMetadata().get(name())?.description?.trim()}>
                  {description => <Text style={{ ...textStyle("caption", { color: palette().textSecondary }),
                    numberOfLines: 1, textOverflow: "ellipsis" }}>{description()}</Text>}
                </If>
              </View>
            </ChoiceCheckbox>
          )}
        </Each>
      </InsetGroup>
    </If>
  );
}
