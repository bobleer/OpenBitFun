import { cleanup, computed, effect, signal, Text, untracked, View, type ViewRef } from "nsh";
import { fleetDeviceContext } from "../bridge";
import { formatCount, formatPlural } from "../format";
import { localizeHostError, tr } from "../i18n";
import {
  deleteUserSkillGroup, moveUserSkillGroup, readUserSkillGroups, resolveSkillGroups,
  saveUserSkillGroup, updateUserSkillGroups, type SkillGroup, type UserSkillGroup,
} from "../skillGroups";
import {
  installedSkills, loadSkillsCatalog, skillCatalogHasDiagnostics, skillDiagnostics, skillsCatalogContextKey,
  skillsError, skillsLoadedKey, skillsLoading, type SkillRecord,
} from "../skillsCatalogStore";
import { layout, palette, space, textStyle } from "../theme";
import { Spinner } from "../ui/motion";
import { DropdownMenu, type DropdownMenuItem } from "../ui/overlays";
import { Button, ConfigSectionHeader, focusRingStyle, IconButton, InlineBanner } from "../ui/primitives";
import { InsetGroup, StudioSection } from "../ui/studio";
import { SkillGroupEditor, type SkillGroupDraft } from "./SkillGroupEditor";

function newGroupId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `skill_group_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function SkillGroupsView(props: { search: string }) {
  const personal = signal<UserSkillGroup[]>([]);
  const status = signal<"loading" | "ready" | "error">("loading");
  const loadError = signal("");
  const actionError = signal("");
  const saving = signal(false);
  const editor = signal<SkillGroupDraft | null>(null);
  let epoch = 0;
  let mounted = true;
  cleanup(() => { mounted = false; });

  const currentCatalog = () => skillsLoadedKey() === skillsCatalogContextKey();
  const skills = () => currentCatalog() ? installedSkills() : [];
  const complete = () => currentCatalog() && !skillsLoading() && !skillsError() && skillCatalogHasDiagnostics() && !skillDiagnostics().length;
  const busy = () => saving() || status() !== "ready";
  const search = () => props.search.trim().toLowerCase();
  const rows = computed(() => resolveSkillGroups(skills(), personal()).filter(group => group.kind !== "other" &&
    (!search() || group.label.toLowerCase().includes(search()) ||
      group.skills.some(skill => skill.name.toLowerCase().includes(search())))));
  const selectedEditor = computed(() => {
    const selected = editor();
    return selected ? [selected] : [];
  });

  const load = async () => {
    const request = ++epoch;
    const context = skillsCatalogContextKey();
    const target = fleetDeviceContext();
    const current = () => mounted && request === epoch && skillsCatalogContextKey() === context;
    try {
      const groups = await readUserSkillGroups(target);
      if (!current()) return;
      personal.set(groups);
      status.set("ready");
    } catch (error) {
      if (!current()) return;
      status.set("error");
      loadError.set(localizeHostError(error) || tr("skills.groups.errors.loadFailed"));
    }
  };
  const reload = () => {
    status.set("loading");
    saving.set(false);
    editor.set(null);
    personal.set([]);
    loadError.set("");
    actionError.set("");
    void load();
  };
  effect(() => {
    skillsCatalogContextKey();
    untracked(reload);
  });

  const mutate = async (change: (groups: UserSkillGroup[]) => UserSkillGroup[]): Promise<boolean> => {
    if (busy()) throw new Error(tr("skills.groups.errors.notReady"));
    const context = skillsCatalogContextKey();
    const target = fleetDeviceContext();
    const request = epoch;
    const current = () => mounted && request === epoch && skillsCatalogContextKey() === context;
    saving.set(true);
    actionError.set("");
    try {
      const groups = await updateUserSkillGroups(target, current, change);
      if (!groups || !current()) return false;
      personal.set(groups);
      return true;
    } finally {
      if (current()) saving.set(false);
    }
  };
  const mutateFromRow = (change: (groups: UserSkillGroup[]) => UserSkillGroup[]) => {
    const request = epoch;
    void mutate(change).catch(error => {
      if (mounted && request === epoch) actionError.set(localizeHostError(error) || tr("skills.groups.errors.saveFailed"));
    });
  };
  const originalFor = (row: SkillGroup<SkillRecord>) => personal().find(group => `user:${group.id}` === row.id);
  const showGroup = (row: SkillGroup<SkillRecord>) => {
    actionError.set("");
    const original = originalFor(row);
    editor.set(original ? { group: original, original } : {
      group: { id: row.id, name: row.label, skillKeys: row.skills.map(skill => skill.key) },
      original: null, readOnly: true,
    });
  };
  const copyGroup = (group: UserSkillGroup) => {
    actionError.set("");
    const base = tr("skills.groups.copyName", { name: group.name });
    const names = new Set(personal().map(item => item.name.toLowerCase()));
    let name = base;
    for (let index = 2; names.has(name.toLowerCase()); index += 1) {
      name = tr("skills.groups.copyNameNumbered", { name: base, count: formatCount(index) });
    }
    editor.set({ group: { id: newGroupId(), name, skillKeys: [...group.skillKeys] }, original: null });
  };
  const copyRow = (row: SkillGroup<SkillRecord>) => copyGroup(originalFor(row) ??
    { id: row.id, name: row.label, skillKeys: row.skills.map(skill => skill.key) });
  const rowActions = (row: SkillGroup<SkillRecord>): ReadonlyArray<DropdownMenuItem> => {
    const original = originalFor(row);
    if (!original) return [];
    const index = personal().findIndex(group => group.id === original.id);
    return [
      { id: "edit", label: tr("skills.groups.edit"), icon: "edit", accessibilityLabel: "skill-group-edit", onSelect: () => showGroup(row) },
      { id: "copy", label: tr("skills.groups.copy"), icon: "copy", accessibilityLabel: "skill-group-copy", onSelect: () => copyRow(row) },
      { id: "up", label: tr("skills.groups.moveUp"), icon: "arrow-up", disabled: index === 0,
        accessibilityLabel: "skill-group-move-up", onSelect: () => mutateFromRow(groups => moveUserSkillGroup(groups, original.id, -1)) },
      { id: "down", label: tr("skills.groups.moveDown"), icon: "arrow-down", disabled: index === personal().length - 1,
        accessibilityLabel: "skill-group-move-down", onSelect: () => mutateFromRow(groups => moveUserSkillGroup(groups, original.id, 1)) },
      { id: "delete", label: tr("skills.groups.delete"), icon: "trash", danger: true, confirmDelete: true,
        accessibilityLabel: "skill-group-delete", confirmLabel: tr("common.delete"), confirmAccessibilityLabel: "skill-group-delete-confirm",
        onSelect: () => mutateFromRow(groups => deleteUserSkillGroup(groups, original)) },
    ];
  };
  const section = (title: string, kind: "user" | "builtin") => {
    const items = computed(() => rows().filter(group => group.kind === kind));
    return (
      <If when={kind === "user" || items().length > 0}>
        <StudioSection title={title} trailing={<Text style={textStyle("caption")}>{formatCount(items().length)}</Text>}>
          <InsetGroup>
            <If when={items().length === 0}>
              <Text style={{ ...textStyle("body"), padding: space.md }}>{tr(search() ? "skills.groups.noMatch" : "skills.groups.noGroups")}</Text>
            </If>
            <Each of={items()} key={group => group.id}>
              {(group, index) => <SkillGroupRow group={group()} first={index() === 0} busy={busy()}
                catalogComplete={complete()} actions={rowActions(group())}
                onOpen={() => showGroup(group())} onCopy={() => copyRow(group())} />}
            </Each>
          </InsetGroup>
        </StudioSection>
      </If>
    );
  };

  return (
    <View style={{ gap: space.lg }} accessibilityLabel="skills-groups-view">
      <ConfigSectionHeader title={tr("skills.groups.title")} description={tr("skills.groups.subtitle")} extra={
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <IconButton icon="refresh" size="sm" disabled={saving() || status() === "loading" || skillsLoading()}
            tooltip={tr("skills.groups.refresh")} accessibilityLabel="skills-groups-refresh" onPress={() => {
              reload();
              void loadSkillsCatalog(true);
            }} />
          <Button label={tr("skills.groups.create")} leadingIcon="plus" variant="primary" size="sm" disabled={busy()}
            accessibilityLabel="skill-group-create" onPress={() => {
              actionError.set("");
              editor.set({ group: { id: newGroupId(), name: "", skillKeys: [] }, original: null });
            }} />
        </View>
      } />
      <If when={status() === "loading"}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Spinner size={14} /><Text style={textStyle("body")}>{tr("skills.groups.loading")}</Text>
        </View>
      </If>
      <If when={loadError() || actionError()}>{message => <InlineBanner tone="warning" message={message()} />}</If>
      <If when={!skillsLoading() && !complete()}>
        <InlineBanner tone="neutral" message={tr("skills.groups.catalogUnavailable")} />
      </If>
      <If when={status() === "ready"}>
        {section(tr("skills.groups.myGroups"), "user")}
        {section(tr("skills.groups.builtinGroups"), "builtin")}
      </If>
      <Each of={selectedEditor()} key={draft => draft.group.id}>
        {draft => <SkillGroupEditor draft={draft()} skills={skills()} catalogComplete={complete()}
          saving={saving()} onClose={() => editor.set(null)} onCopy={() => copyGroup(draft().group)}
          onSave={group => {
            const original = draft().original;
            return mutate(groups => saveUserSkillGroup(groups, group, original));
          }} />}
      </Each>
    </View>
  );
}

function SkillGroupRow(props: {
  group: SkillGroup<SkillRecord>;
  first: boolean;
  busy: boolean;
  catalogComplete: boolean;
  actions: ReadonlyArray<DropdownMenuItem>;
  onOpen: () => void;
  onCopy: () => void;
}) {
  const anchor = signal<ViewRef | null>(null);
  const menu = signal(false);
  const total = () => props.group.skills.length + props.group.unavailableKeys.length;
  const preview = () => props.group.skills.length ? props.group.skills.map(skill => skill.name).join(" · ")
    : tr(total() ? "skills.groups.unresolvedMembers" : "skills.groups.emptyGroup");
  return (
    <View style={{
      flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, padding: space.md,
      borderTopWidth: props.first ? 0 : 1, borderColor: palette().borderSubtle,
    }}>
      <View role="button" accessibilityLabel={props.group.label} testID={`skill-group-open-${props.group.id}`}
        disabled={props.busy} onPress={props.onOpen}
        focusVisibleStyle={focusRingStyle()}
        style={{ flex: 1, flexBasis: 160, minWidth: 0, gap: space.xs, minHeight: layout.touchTarget, justifyContent: "center", cursor: "pointer" }}>
        <Text style={textStyle("label")}>{props.group.label}</Text>
        <Text style={{ ...textStyle("caption"), numberOfLines: 2, textOverflow: "ellipsis" }}>{preview()}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 0, gap: space.sm }}>
        <View style={{ gap: space.xs }}>
          <Text style={textStyle("caption")}>
            {formatPlural(total(), "skills.groups.memberCountOne", "skills.groups.memberCount")}
          </Text>
          <If when={props.catalogComplete && props.group.unavailableKeys.length > 0}>
            <Text style={textStyle("caption")}>
              {tr("skills.groups.unavailableCount", { count: formatCount(props.group.unavailableKeys.length) })}
            </Text>
          </If>
        </View>
        <If when={props.group.kind === "user"} else={
          <Button label={tr("skills.groups.copy")} variant="ghost" size="sm" disabled={props.busy}
            accessibilityLabel={`skill-group-copy-${props.group.id}`} onPress={props.onCopy} />
        }>
          <View ref={node => anchor.set(node)}>
            <IconButton icon="more" size="sm" disabled={props.busy}
              tooltip={tr("skills.groups.actions", { name: props.group.label })}
              accessibilityLabel={`skill-group-actions-${props.group.id}`} onPress={() => menu.update(value => !value)} />
          </View>
          <If when={menu() && !props.busy}>
            <DropdownMenu open anchor={anchor()} items={props.actions} align="end" onClose={() => menu.set(false)} />
          </If>
        </If>
      </View>
    </View>
  );
}
