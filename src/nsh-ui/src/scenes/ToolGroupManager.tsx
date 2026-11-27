import { cleanup, computed, signal, Text, View } from "nsh";
import { setToolSelection, updateUserToolGroups, type UserToolGroup } from "../agentToolGroups";
import { formatCount, formatPlural } from "../format";
import { localizeHostError, tr } from "../i18n";
import { compactLayout, layout, palette, space, textStyle } from "../theme";
import { ChoiceCheckbox } from "../ui/ChoiceIndicator";
import { ModalDialog } from "../ui/overlays";
import { Badge, Button, ConfigSection, IconButton, InlineBanner, InlineConfirmBar, InlineDeleteConfirm, SearchInput, TextField } from "../ui/primitives";
import { InsetGroup } from "../ui/studio";

interface ToolGroupManagerProps {
  target: string | null;
  current: () => boolean;
  groups: readonly UserToolGroup[];
  toolNames: readonly string[];
  onChange: (groups: UserToolGroup[]) => void;
  onClose: () => void;
}

interface GroupDraft {
  original: UserToolGroup | null;
  name: string;
  toolNames: string[];
}

function requireUnchanged(groups: UserToolGroup[], original: UserToolGroup): UserToolGroup {
  const current = groups.find(group => group.id === original.id);
  if (!current || current.name !== original.name || current.toolNames.length !== original.toolNames.length ||
    current.toolNames.some((name, index) => name !== original.toolNames[index])) {
    throw new Error(tr("agents.toolGroups.conflict"));
  }
  return current;
}

export function ToolGroupManager(props: ToolGroupManagerProps) {
  const draft = signal<GroupDraft | null>(null);
  const query = signal("");
  const saving = signal(false);
  const error = signal("");
  const confirmDiscard = signal(false);
  let mounted = true;
  cleanup(() => { mounted = false; });

  const catalog = computed(() => new Set(props.toolNames));
  const choices = computed(() => {
    const search = query().trim().toLowerCase();
    return [...catalog()].filter(name => name.toLowerCase().includes(search)).sort((a, b) => a.localeCompare(b));
  });
  const unavailable = computed(() => (draft()?.toolNames ?? []).filter(name => !catalog().has(name)));
  const edit = (group: GroupDraft | null) => {
    draft.set(group);
    query.set("");
    error.set("");
    confirmDiscard.set(false);
  };
  const mutate = async (update: (groups: UserToolGroup[]) => UserToolGroup[]) => {
    if (saving()) return false;
    saving.set(true);
    error.set("");
    try {
      const result = await updateUserToolGroups(props.target, () => mounted && props.current(), update);
      if (!mounted || !result) return false;
      props.onChange(result.groups);
      return true;
    } catch (err) {
      if (mounted) error.set(localizeHostError(err));
      return false;
    } finally {
      if (mounted) saving.set(false);
    }
  };
  const save = async () => {
    const item = draft();
    if (!item || confirmDiscard()) return;
    const name = item.name.trim();
    if (!name) {
      error.set(tr("agents.toolGroups.validation.nameRequired"));
      return;
    }
    if (!item.toolNames.length) {
      error.set(tr("agents.toolGroups.validation.toolsRequired"));
      return;
    }
    if (await mutate(groups => {
      const original = item.original;
      if (groups.some(group => group.id !== original?.id && group.name.trim().toLowerCase() === name.toLowerCase())) {
        throw new Error(tr("agents.toolGroups.validation.nameDuplicate"));
      }
      if (!original) {
        const id = globalThis.crypto?.randomUUID?.() ?? `tool_group_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        return [...groups, { id, name, toolNames: item.toolNames }];
      }
      const current = requireUnchanged(groups, original);
      return groups.map(group => group === current ? { ...group, name, toolNames: item.toolNames } : group);
    })) edit(null);
  };
  const move = (id: string, delta: -1 | 1) => {
    void mutate(groups => {
      const index = groups.findIndex(group => group.id === id);
      const nextIndex = index + delta;
      if (index < 0) throw new Error(tr("agents.toolGroups.conflict"));
      if (nextIndex < 0 || nextIndex >= groups.length) return groups;
      const next = [...groups];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };
  const close = () => {
    if (saving()) return;
    const item = draft();
    if (!item) {
      props.onClose();
      return;
    }
    const originalNames = item.original?.toolNames ?? [];
    if (item.name !== (item.original?.name ?? "") || item.toolNames.length !== originalNames.length ||
      item.toolNames.some((name, index) => name !== originalNames[index])) {
      confirmDiscard.set(true);
    } else edit(null);
  };

  return (
    <ModalDialog open title={tr("agents.toolGroups.manageTitle")} size="lg"
      keepOpenOnBackdrop={Boolean(draft())} accessibilityLabel="agent-tool-group-manager" onClose={close}
      footer={
        <If when={confirmDiscard()} else={
          <If when={draft() !== null} else={
            <Button label={tr("common.done")} disabled={saving()} onPress={close} accessibilityLabel="agent-tool-group-done" />
          }>
            <Button label={tr("common.cancel")} variant="secondary" disabled={saving()}
              accessibilityLabel="agent-tool-group-cancel" onPress={close} />
            <Button label={tr("agents.toolGroups.saveGroup")} variant="primary" loading={saving()} disabled={saving()}
              accessibilityLabel="agent-tool-group-save" onPress={() => void save()} />
          </If>
        }>
          <InlineConfirmBar message={tr("agents.toolGroups.discardMessage")} danger
            confirmLabel={tr("common.discardChanges")} cancelLabel={tr("common.cancel")}
            onConfirm={() => edit(null)} onCancel={() => confirmDiscard.set(false)} />
        </If>
      }>
      <View style={{ gap: space.md }}>
        <If when={error()}>
          {message => <InlineBanner tone="warning" message={message()} />}
        </If>
        <If when={draft()} else={
          <View style={{ gap: space.sm, alignItems: "stretch" }}>
            <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
              <Button label={tr("agents.toolGroups.createGroup")} leadingIcon="plus" variant="secondary" disabled={saving()}
                accessibilityLabel="agent-tool-group-add" onPress={() => edit({ original: null, name: "", toolNames: [] })} />
            </View>
            <If when={props.groups.length > 0} else={
              <Text style={textStyle("body", { color: palette().textSecondary })}>{tr("agents.toolGroups.noUserGroups")}</Text>
            }>
              <InsetGroup>
                <Each of={props.groups} key={group => group.id}>
                  {(group, index) => {
                    const missing = () => group().toolNames.filter(name => !catalog().has(name)).length;
                    const countLabel = () => formatPlural(group().toolNames.length,
                      "agents.toolGroups.groupCountOne", "agents.toolGroups.groupCount");
                    return (
                      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm,
                        paddingVertical: space.sm, paddingHorizontal: space.md, borderTopWidth: index() > 0 ? 1 : 0,
                        borderColor: palette().borderSubtle }}>
                        <View style={{ flexGrow: 1, minWidth: 0, gap: space.xs }}>
                          <Text style={textStyle("label")}>{group().name}</Text>
                          <Text style={textStyle("caption", { color: palette().textSecondary })}>
                            {missing() ? `${countLabel()} · ${tr("agents.toolGroups.unavailableCount", { count: formatCount(missing()) })}`
                              : countLabel()}
                          </Text>
                        </View>
                        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xs }}>
                          <IconButton icon="arrow-up" size="sm" disabled={saving() || index() === 0}
                            tooltip={tr("agents.toolGroups.moveUp")} accessibilityLabel={`agent-tool-group-up-${group().id}`}
                            onPress={() => move(group().id, -1)} />
                          <IconButton icon="arrow-down" size="sm" disabled={saving() || index() === props.groups.length - 1}
                            tooltip={tr("agents.toolGroups.moveDown")} accessibilityLabel={`agent-tool-group-down-${group().id}`}
                            onPress={() => move(group().id, 1)} />
                          <IconButton icon="edit" size="sm" disabled={saving()} tooltip={tr("agents.toolGroups.editGroup")}
                            accessibilityLabel={`agent-tool-group-edit-${group().id}`} onPress={() => {
                              const original = group();
                              edit({ original, name: original.name, toolNames: original.toolNames });
                            }} />
                          <InlineDeleteConfirm size="sm" disabled={saving()} tooltip={tr("agents.toolGroups.deleteGroup")}
                            accessibilityLabel={`agent-tool-group-delete-${group().id}`}
                            onConfirm={() => {
                              const original = group();
                              void mutate(groups => {
                                const current = requireUnchanged(groups, original);
                                return groups.filter(item => item !== current);
                              });
                            }} />
                        </View>
                      </View>
                    );
                  }}
                </Each>
              </InsetGroup>
            </If>
          </View>
        }>
          {item => (
            <View style={{ gap: space.md }}>
              <TextField label={tr("agents.toolGroups.groupName")} placeholder={tr("agents.toolGroups.groupNamePlaceholder")}
                accessibilityLabel="agent-tool-group-name" value={item().name} disabled={saving()}
                onChange={name => draft.set({ ...item(), name })} />
              <ConfigSection title={tr("settings.section.tools")}>
                <View style={{ gap: space.sm }}>
                  <If when={props.toolNames.length > 0}>
                    <SearchInput value={query()} placeholder={tr("agents.filterTools")}
                      accessibilityLabel="agent-tool-group-search" onChange={value => query.set(value)} />
                  </If>
                  <InsetGroup>
                    <Each of={choices()} key={name => name}>
                      {(name, index) => (
                        <ChoiceCheckbox checked={item().toolNames.includes(name())} disabled={saving()}
                          accessibilityLabel={name()} testID={`agent-tool-group-tool-${name()}`}
                          style={{ minHeight: compactLayout() ? layout.touchTarget : 36, paddingHorizontal: space.md,
                            paddingVertical: space.xs, borderTopWidth: index() > 0 ? 1 : 0, borderColor: palette().borderSubtle }}
                          onChange={checked => draft.set({ ...item(), toolNames: setToolSelection(item().toolNames, [name()], checked) })}>
                          <Text style={{ ...textStyle("mono"), flex: 1, minWidth: 0 }}>{name()}</Text>
                        </ChoiceCheckbox>
                      )}
                    </Each>
                  </InsetGroup>
                  <If when={!choices().length}>
                    <Text style={textStyle("caption", { color: palette().textSecondary })}>
                      {tr(query().trim() ? "agents.noToolsMatch" : "agents.noTools")}
                    </Text>
                  </If>
                  <If when={unavailable().length > 0}>
                    <Text style={textStyle("caption", { color: palette().textSecondary })}>
                      {tr("agents.toolGroups.unavailableCount", { count: formatCount(unavailable().length) })}
                    </Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                      <Each of={unavailable()} key={name => name}>{name => <Badge tone="neutral" label={name()} />}</Each>
                    </View>
                  </If>
                </View>
              </ConfigSection>
            </View>
          )}
        </If>
      </View>
    </ModalDialog>
  );
}
