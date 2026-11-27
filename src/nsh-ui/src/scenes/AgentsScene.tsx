import { computed, effect, lifecycle, Scroll, signal, Text, untracked, View, type ViewRef } from "nsh";
import {
  agentKindFilter,
  agentInspectorScopeCurrent,
  agentSearchQuery,
  agentSourceFilter,
  agentsCatalogError,
  agentsLoadedKey,
  agentsLoading,
  agentsNotice,
  allCatalogAgents,
  availableModes,
  availableSubagents,
  builderDraft,
  POOL_TOKEN_PREFIX,
  parentSubagents,
  parentSubagentsError,
  parentSubagentsFor,
  parentSubagentsLoading,
  parentSubagentsSaving,
  parentSubagentsScopeCurrent,
  loadParentSubagents,
  saveParentSubagentSelection,
  modeSkills,
  modeSkillsError,
  modeSkillsFor,
  modeSkillsLoading,
  modeSkillsSaving,
  modeSkillsScopeCurrent,
  loadModeSkills,
  resetModeSkills,
  saveModeSkillSelection,
  builderError,
  builderLoading,
  builderOpen,
  builderSaving,
  closeBuilder,
  confirmDeleteAgentUid,
  deleteCatalogAgent,
  effectiveToolCountForAgent,
  filteredAgents,
  agentCanDelete,
  agentCanEdit,
  isCustomSource,
  isRemoteAgentWorkspace,
  loadAgentsCatalog,
  openAgentInspector,
  openCreateBotBuilder,
  pendingDeleteAgent,
  reloadAgentsCatalog,
  resetProfileConfig,
  saveBuilderBot,
  saveProfileToolSelection,
  saveSubagentRuntimeConfig,
  selectableToolNames,
  startThreadWithMode,
  toolCatalogError,
  updateBuilderDraft,
  type AgentCatalogItem,
  type AgentSource,
  type AgentSourceFilter,
} from "../agentsCatalogStore";
import { setToolSelection } from "../agentToolGroups";
import { formatCount, formatPlural } from "../format";
import { localizeHostError, tr } from "../i18n";
import { loadModels, modelOptionText, modelSettingsLoaded, storedModels } from "../modelSettingsStore";
import { ensurePools, pools } from "../poolStore";
import { activeWorkspace, activeWorkspaceId, deviceContext } from "../state";
import {
  compactLayout,
  fontMono,
  layout,
  palette,
  radii,
  space,
  textLineHeight,
  textSize,
  textStyle,
} from "../theme";
import { LibraryToolbar, libraryBodyStyle } from "./LibraryChrome";
import { AgentSkillGroups } from "./AgentSkillGroups";
import { AgentToolGroups } from "./AgentToolGroups";
import { designTokens } from "../generated/designTokens";
import { CatalogCard } from "../ui/CatalogCard";
import { ChoiceCheckbox } from "../ui/ChoiceIndicator";
import { Icon, type IconName } from "../ui/icons";
import type { MessageKey } from "../locales/en-US";
import { MOTION_DURATION, paintTransition, pressTransition, Spinner, tactileActiveStyle } from "../ui/motion";
import {
  GalleryGrid,
  GallerySkeleton,
  InsetGroup,
  MoreMenu,
  StudioBody,
  StudioEmpty,
  StudioHeader,
  StudioSection,
  StudioToolbar,
  studioCompact,
  trackStudioWidth,
} from "../ui/studio";
import {
  DropdownMenu,
  ModalDialog,
  SelectDropdown,
  type DropdownMenuItem,
  type SelectDropdownOption,
} from "../ui/overlays";
import {
  Badge,
  Button,
  ConfigRow,
  ConfigSection,
  IconButton,
  InlineBanner,
  InlineConfirmBar,
  InputBox,
  SearchInput,
  SegmentedTabs,
  ToggleSwitch,
  focusRingStyle,
} from "../ui/primitives";

/** Strips simple inline Markdown emphasis (`**bold**`, `__bold__`, `` `code` ``) for plain-text summary lines. */
function plainDescriptionText(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function sourceOptions(): ReadonlyArray<SelectDropdownOption<AgentSourceFilter>> {
  return [
    { value: "all", label: tr("agents.allSources"), accessibilityLabel: "agent-scope-all" },
    { value: "builtin", label: tr("common.builtin"), accessibilityLabel: "agent-scope-builtin" },
    { value: "user", label: tr("common.user"), accessibilityLabel: "agent-scope-user" },
    { value: "project", label: tr("common.project"), accessibilityLabel: "agent-scope-project" },
    { value: "external", label: tr("common.external"), accessibilityLabel: "agent-scope-external" },
  ];
}

function sourceLabel(source: AgentSource): string {
  if (source === "builtin") return tr("common.builtin");
  if (source === "user") return tr("common.user");
  if (source === "project") return tr("common.project");
  return tr("common.external");
}

function cardBadgeLabel(item: AgentCatalogItem): string {
  if (item.kind === "subagent") return tr("agents.subagent");
  if (item.source === "builtin") return tr("common.builtin");
  if (item.source === "external") return tr("common.external");
  return tr("common.custom");
}

function distinctSubtitle(item: AgentCatalogItem): string {
  return item.externalProviderLabel || "";
}

function builderTitle(): string {
  const draft = builderDraft();
  if (draft.mode === "create") return tr("agents.createBot");
  if (draft.mode === "edit-custom") {
    const name = draft.name || draft.id;
    return draft.kind === "mode"
      ? tr("agents.editPrimaryTitle", { name })
      : tr("agents.editSubagentTitle", { name });
  }
  if (draft.mode === "configure-profile") {
    return tr("agents.configureProfileTitle", { name: draft.name });
  }
  if (draft.mode === "configure-subagent") {
    return tr("agents.configureSubagentTitle", { name: draft.name });
  }
  return tr("agents.inspectBotTitle", { name: draft.name });
}

function builderSubtitle(): string | undefined {
  const draft = builderDraft();
  if (draft.path) return draft.path;
  if (draft.mode === "create") return tr("agents.createSubtitle");
  if (draft.mode === "configure-profile") return tr("agents.configureProfileSubtitle");
  if (draft.mode === "configure-subagent") return tr("agents.configureSubagentSubtitle");
  if (draft.mode === "inspect-external") return tr("agents.inspectExternalSubtitle");
  return undefined;
}

function botSummaryLine(item: AgentCatalogItem): string {
  const count = effectiveToolCountForAgent(item);
  const parts: string[] = [];
  parts.push(formatPlural(count, "agents.toolCountOne", "agents.toolCountOther"));
  parts.push(
    item.model
      ? tr("sessions.modelLabel", { name: item.model })
      : tr("agents.inheritModel"),
  );
  if (item.kind === "subagent" && item.source !== "builtin") {
    parts.push(sourceLabel(item.source));
  }
  if (item.isReadonly) parts.push(tr("common.readonly"));
  return parts.join(" · ");
}

const hasActiveFilter = computed(
  () => agentKindFilter() !== "all" || agentSourceFilter() !== "all" || agentSearchQuery().trim().length > 0,
);

function resetCatalogFilters(): void {
  agentKindFilter.set("all");
  agentSourceFilter.set("all");
  agentSearchQuery.set("");
}

/** Kind and identity line under a card's name: "Built-in · Standard". */
function cardMetaLine(item: AgentCatalogItem): string {
  return [cardBadgeLabel(item), distinctSubtitle(item)].filter(Boolean).join(" · ");
}

function botMenuItems(item: AgentCatalogItem): DropdownMenuItem[] {
  const open = () => {
    void openAgentInspector(item);
  };
  const remote = !agentCanEdit(item);
  const items: DropdownMenuItem[] = isCustomSource(item.source)
    ? [
        {
          id: "edit",
          label: remote ? tr("agents.inspectBot") : tr("agents.editBot"),
          hint: remote ? tr("agents.remoteReadonlyHint") : tr("agents.editBotHint"),
          icon: remote ? "eye" : "edit",
          accessibilityLabel: `agent-menu-edit-${item.id}`,
          onSelect: open,
        },
      ]
    : [
        {
          id: "configure",
          label: item.source === "external" ? tr("agents.inspectBot") : tr("agents.configureTools"),
          icon: item.source === "external" ? "eye" : "sliders",
          accessibilityLabel: `agent-menu-configure-${item.id}`,
          onSelect: open,
        },
      ];
  items.push({
    id: "reload",
    label: tr("agents.reloadCatalog"),
    icon: "refresh",
    onSelect: () => void reloadAgentsCatalog(),
  });
  if (isCustomSource(item.source)) {
    items.push({
      id: "delete",
      label: tr("common.delete"),
      icon: "trash",
      danger: true,
      separator: true,
      confirmDelete: true,
      confirmAccessibilityLabel: "agent-delete-confirm",
      cancelAccessibilityLabel: "agent-delete-cancel",
      disabled: !agentCanDelete(item),
      accessibilityLabel: `agent-menu-delete-${item.id}`,
      onSelect: () => void deleteCatalogAgent(item),
    });
  }
  return items;
}

/** The card opens its details and keeps session and menu actions separate. */
function BotCard(props: { item: AgentCatalogItem }) {
  const unavailable = () => props.item.kind === "subagent" && !props.item.effectiveEnabled;
  const metrics = designTokens.metrics.card;
  const description = () => plainDescriptionText(props.item.description) || tr("common.noDescription");
  return (
    <CatalogCard label={props.item.name} description={description()} testID={`agent-configure-${props.item.id}`}
      onOpen={() => void openAgentInspector(props.item)}
      actions={
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: metrics.footerGap, minWidth: 0 }}>
          <If when={props.item.kind === "mode"} else={<View style={{ flex: 1 }} />}>
            <Button label={tr("agents.startThread")} variant="secondary" size="sm" leadingIcon="chat"
              accessibilityLabel={`agent-start-thread-${props.item.id}`}
              style={compactLayout() ? { height: layout.touchTarget, minHeight: layout.touchTarget } : undefined}
              onPress={() => startThreadWithMode(props.item.id)} />
          </If>
          <MoreMenu accessibilityLabel={`agent-actions-${props.item.id}`}
            tooltip={tr("agents.botActions")} items={botMenuItems(props.item)} />
        </View>
      }>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: metrics.headerGap, minWidth: 0 }}>
        <Icon name={props.item.kind === "subagent" ? "sparkles" : "bot"} size={16} color={palette().textSecondary} />
        <View style={{ flex: 1, minWidth: 0, gap: metrics.titleGap }}>
          <Text style={{ ...textStyle("cardTitle"), numberOfLines: 1, textOverflow: "ellipsis" }}>{props.item.name}</Text>
          <Text style={{ ...textStyle("caption"), numberOfLines: 1, textOverflow: "ellipsis" }}>{cardMetaLine(props.item)}</Text>
        </View>
        <If when={unavailable()}>
          <Text style={textStyle("caption")}>{tr("common.disabled")}</Text>
        </If>
      </View>
      <Text style={{ ...textStyle("smallBody", { color: palette().textSecondary }), numberOfLines: 2, textOverflow: "ellipsis" }}>
        {description()}
      </Text>
      <Text style={{ ...textStyle("caption", { tabular: true }), numberOfLines: 1, textOverflow: "ellipsis" }}>
        {botSummaryLine(props.item)}
      </Text>
    </CatalogCard>
  );
}

/** A quiet filter control: an icon that opens a menu of choices and tints while one is applied. */
function FilterMenu<T extends string>(props: {
  value: T;
  defaultValue: T;
  options: ReadonlyArray<SelectDropdownOption<T>>;
  accessibilityLabel: string;
  tooltip: string;
  onChange: (value: T) => void;
}) {
  const open = signal(false);
  const anchor = signal<ViewRef | null>(null);
  return (
    <View ref={el => anchor.set(el)} style={{ flexShrink: 0 }}>
      <IconButton
        icon="filter"
        size="md"
        active={open() || props.value !== props.defaultValue}
        tooltip={props.tooltip}
        accessibilityLabel={props.accessibilityLabel}
        style={compactLayout() ? { width: layout.touchTarget, height: layout.touchTarget } : undefined}
        onPress={() => open.update(value => !value)}
      />
      <If when={open()}>
        <DropdownMenu
          open={true}
          anchor={anchor()}
          align="end"
          minWidth={180}
          items={props.options.map(option => ({
            id: option.value,
            label: option.label,
            active: option.value === props.value,
            accessibilityLabel: option.accessibilityLabel,
            onSelect: () => props.onChange(option.value),
          }))}
          onClose={() => open.set(false)}
        />
      </If>
    </View>
  );
}

type AgentCapability = "tools" | "skills" | "subagents";

const capabilityCopy = {
  tools: {
    title: "agents.toolsTitle", description: "agents.toolPermissionsSubtitle", edit: "agents.toolsDraftHint",
    discard: "agents.toolsDiscardConfirm", icon: "wrench", id: "profile",
  },
  skills: {
    title: "agents.modeSkillsTitle", description: "agents.modeSkillsHint", edit: "agents.modeSkillsDraftHint",
    discard: "agents.modeSkillsDiscardConfirm", icon: "sparkles", id: "mode-skills",
  },
  subagents: {
    title: "agents.parentSubagentsTitle", description: "agents.parentSubagentsHint", edit: "agents.subagentsDraftHint",
    discard: "agents.subagentsDiscardConfirm", icon: "bot", id: "mode-subagents",
  },
} as const satisfies Record<AgentCapability, {
  title: MessageKey;
  description: MessageKey;
  edit: MessageKey;
  discard: MessageKey;
  icon: IconName;
  id: string;
}>;

function capabilityAvailable(capability: AgentCapability): boolean {
  const draft = builderDraft();
  if (draft.kind !== "mode" || !agentInspectorScopeCurrent()) return false;
  if (capability === "tools") return draft.mode === "configure-profile";
  if (draft.mode !== "configure-profile" && draft.mode !== "edit-custom") return false;
  return capability === "skills"
    ? modeSkillsFor() === draft.id && modeSkillsScopeCurrent()
    : parentSubagentsFor() === draft.id && parentSubagentsScopeCurrent();
}

function savedCapabilitySelection(capability: AgentCapability): readonly string[] {
  if (capability === "tools") return builderDraft().tools;
  if (capability === "skills") return modeSkills().filter(skill => skill.effectiveEnabled).map(skill => skill.key);
  return parentSubagents().filter(agent => agent.effectiveEnabled).map(agent => agent.id);
}

function capabilityAvailableCount(capability: AgentCapability): number {
  if (capability === "tools") return selectableToolNames().length;
  if (capability === "skills") return modeSkills().length;
  return parentSubagents().length;
}

function capabilityLoading(capability: AgentCapability): boolean {
  if (capability === "tools") return agentsLoading();
  return capability === "skills" ? modeSkillsLoading() : parentSubagentsLoading();
}

function capabilityError(capability: AgentCapability): string | null {
  if (capability === "tools") return toolCatalogError();
  return capability === "skills" ? modeSkillsError() : parentSubagentsError();
}

function AgentBuilderModal() {
  const capability = signal<AgentCapability | null>(null);
  const selectionDraft = signal<ReadonlyMap<string, boolean> | null>(null);
  const confirmDiscard = signal(false);
  const inCapability = () => capability() !== null;
  const copy = () => capabilityCopy[capability() ?? "skills"];
  const editing = () => selectionDraft() !== null;
  const saving = () => builderSaving() || modeSkillsSaving() || parentSubagentsSaving();
  const busy = () => saving() || capabilityLoading(capability() ?? "skills");
  const canManage = () => {
    const active = capability();
    if (!active || busy() || isRemoteAgentWorkspace()) return false;
    if (active === "tools") return !toolCatalogError() && selectableToolNames().length > 0;
    if (active === "skills") return modeSkills().some(skill => skill.globallyEnabled);
    return parentSubagents().some(agent => agent.source !== "external");
  };
  const leaveCapability = () => {
    selectionDraft.set(null);
    confirmDiscard.set(false);
    capability.set(null);
  };
  const openCapability = (next: AgentCapability) => capability.set(next);
  const cancelEdit = () => {
    if (saving()) return;
    if (selectionDraft()?.size) confirmDiscard.set(true);
    else selectionDraft.set(null);
  };
  const stage = (keys: readonly string[], enabled: boolean) => {
    const active = capability();
    const draft = selectionDraft();
    if (!active || !draft || !canManage() || !capabilityAvailable(active)) return;
    const changes = new Map(draft);
    const selected = new Set(savedCapabilitySelection(active));
    for (const key of keys) {
      if (selected.has(key) === enabled) changes.delete(key);
      else changes.set(key, enabled);
    }
    selectionDraft.set(changes);
  };
  const save = async () => {
    const active = capability();
    const draft = selectionDraft();
    if (!active || !draft?.size || busy() || !capabilityAvailable(active)) return;
    if (active === "subagents") {
      const remaining = await saveParentSubagentSelection(builderDraft().id, draft);
      if (remaining && selectionDraft() === draft) selectionDraft.set(remaining.size ? remaining : null);
      return;
    }
    const saved = active === "skills"
      ? await saveModeSkillSelection(builderDraft().id, draft)
      : await saveProfileToolSelection(draft);
    if (saved && selectionDraft() === draft) selectionDraft.set(null);
  };
  const subagentDefaults = () => parentSubagents()
    .filter(agent => agent.source !== "external" && agent.defaultEnabled !== undefined && agent.defaultEnabled !== agent.effectiveEnabled);
  const reset = async () => {
    const active = capability();
    if (!active || busy() || !capabilityAvailable(active) || isRemoteAgentWorkspace()) return;
    if (active === "tools") await resetProfileConfig();
    else if (active === "skills") await resetModeSkills(builderDraft().id);
    else {
      const changes = new Map(subagentDefaults().map(agent => [agent.id, agent.defaultEnabled === true]));
      const remaining = await saveParentSubagentSelection(builderDraft().id, changes);
      if (remaining?.size && capability() === active) selectionDraft.set(remaining);
    }
  };
  effect(() => {
    const active = capability();
    if (!builderOpen()) untracked(leaveCapability);
    else if (!agentInspectorScopeCurrent()) untracked(() => { leaveCapability(); closeBuilder(); });
    else if (active && !capabilityAvailable(active)) untracked(leaveCapability);
  });
  const handleClose = () => {
    if (saving()) return;
    if (inCapability()) {
      if (editing()) cancelEdit();
      else leaveCapability();
      return;
    }
    closeBuilder();
  };

  return (
    <ModalDialog
      open={builderOpen()}
      title={inCapability() ? tr(copy().title) : builderTitle()}
      subtitle={inCapability() ? tr(editing() ? copy().edit : copy().description) : builderSubtitle()}
      size="lg"
      keepOpenOnBackdrop={inCapability()}
      accessibilityLabel="agent-builder-dialog"
      onClose={handleClose}
      footer={<If when={inCapability()} else={
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <View style={{ flex: 1, minWidth: 8 }} />

          <If when={builderDraft().mode === "create" || builderDraft().mode === "edit-custom"}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <Button
                label={tr("common.cancel")}
                variant="secondary"
                size="md"
                accessibilityLabel="agent-builder-close"
                onPress={handleClose}
              />
              <Button
                label={
                  builderSaving()
                    ? tr("common.saving")
                    : builderDraft().mode === "create"
                      ? tr("agents.createBot")
                      : tr("common.saveChanges")
                }
                variant="primary"
                size="md"
                loading={builderSaving()}
                disabled={builderSaving() || builderLoading()}
                accessibilityLabel="builder-save"
                onPress={() => void saveBuilderBot()}
              />
            </View>
          </If>

          <If when={builderDraft().mode === "configure-profile"}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <Button
                label={tr("common.close")}
                variant="secondary"
                size="md"
                accessibilityLabel="agent-builder-close"
                onPress={handleClose}
              />
            </View>
          </If>

          <If when={builderDraft().mode === "configure-subagent"}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <Button
                label={tr("common.close")}
                variant="secondary"
                size="md"
                accessibilityLabel="agent-builder-close"
                onPress={handleClose}
              />
              <Button
                label={builderSaving() ? tr("common.saving") : tr("agents.saveSubagentConfig")}
                variant="primary"
                size="md"
                loading={builderSaving()}
                disabled={builderSaving()}
                accessibilityLabel="subagent-config-save"
                onPress={() => void saveSubagentRuntimeConfig()}
              />
            </View>
          </If>

          <If when={builderDraft().mode === "inspect-external"}>
            <Button
              label={tr("common.close")}
              variant="secondary"
              size="md"
              accessibilityLabel="agent-builder-close"
              onPress={handleClose}
            />
          </If>
        </View>
      }>
        <If when={confirmDiscard()} else={
          <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
            <If when={editing()} else={
              <>
                <Button label={tr("common.resetDefaults")} variant="secondary" size="md" accessibilityLabel={`${copy().id}-reset`}
                  disabled={busy() || isRemoteAgentWorkspace() ||
                    (capability() === "tools" && Boolean(toolCatalogError())) ||
                    (capability() === "subagents" && subagentDefaults().length === 0)}
                  onPress={() => void reset()} />
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                  <Button label={tr("common.back")} variant="secondary" size="md" accessibilityLabel={`${copy().id}-back`}
                    disabled={saving()} onPress={handleClose} />
                  <Button label={tr("common.manage")} variant="primary" size="md" accessibilityLabel={`${copy().id}-manage`}
                    disabled={!canManage()} onPress={() => selectionDraft.set(new Map())} />
                </View>
              </>
            }>
              <View style={{ flex: 1 }} />
              <Button label={tr("common.cancel")} variant="secondary" size="md" accessibilityLabel={`${copy().id}-cancel`}
                disabled={saving()} onPress={cancelEdit} />
              <Button label={tr("common.saveChanges")} variant="primary" size="md" accessibilityLabel={`${copy().id}-save`}
                loading={saving()} disabled={busy() || !selectionDraft()?.size} onPress={() => void save()} />
            </If>
          </View>
        }>
          <InlineConfirmBar message={tr(copy().discard)} danger
            confirmLabel={tr("common.discardChanges")} cancelLabel={tr("common.cancel")}
            onConfirm={() => { selectionDraft.set(null); confirmDiscard.set(false); }}
            onCancel={() => confirmDiscard.set(false)} />
        </If>
      </If>}
    >
      <If when={inCapability()} else={<View style={{ gap: space.lg }}>
        <If when={builderLoading()}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Spinner size={14} />
            <Text
              style={{
                color: palette().textMuted,
                fontSize: textSize(12),
                lineHeight: textLineHeight(12, 1.4),
              }}
            >
              {tr("agents.loadingDefinition")}
            </Text>
          </View>
        </If>

        <If when={builderError() ?? ""}>
          {err => <InlineBanner tone="danger" message={localizeHostError(err())} />}
        </If>

        <If when={builderDraft().mode === "create" || builderDraft().mode === "edit-custom"}>
          <View style={{ gap: space.lg }}>
            <If when={builderDraft().mode === "create"}>
              <ConfigSection title={tr("agents.identityScope")} flush controlWidth={240}>
                <ConfigRow
                  label={tr("agents.botKind")}
                  description={tr("agents.botKindHint")}
                >
                  <SegmentedTabs
                    size="sm"
                    options={[
                      { value: "mode", label: tr("agents.primaryAgent"), accessibilityLabel: "builder-kind-mode" },
                      { value: "subagent", label: tr("agents.subagent"), accessibilityLabel: "builder-kind-subagent" },
                    ]}
                    value={builderDraft().kind}
                    onChange={next => {
                      updateBuilderDraft({
                        kind: next,
                        readonly: next === "subagent",
                        level: next === "mode" ? "user" : builderDraft().level,
                      });
                    }}
                  />
                </ConfigRow>

                <ConfigRow
                  label={tr("agents.scope")}
                  description={
                    builderDraft().kind === "mode"
                      ? tr("agents.scopePrimaryHint")
                      : tr("agents.scopeSubagentHint")
                  }
                >
                  <SegmentedTabs
                    size="sm"
                    options={
                      builderDraft().kind === "subagent" && Boolean(activeWorkspaceId())
                        ? [
                            { value: "user", label: tr("common.user"), accessibilityLabel: "builder-level-user" },
                            { value: "project", label: tr("common.project"), accessibilityLabel: "builder-level-project" },
                          ]
                        : [
                            { value: "user", label: tr("common.user"), accessibilityLabel: "builder-level-user" },
                          ]
                    }
                    value={builderDraft().level}
                    onChange={next => updateBuilderDraft({ level: next })}
                  />
                </ConfigRow>

                <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
                  <InputBox
                    label={tr("agents.botId")}
                    hint={tr("agents.botIdHint")}
                    size="md"
                    monospace
                    value={builderDraft().id}
                    placeholder={tr("agents.botIdPlaceholder")}
                    accessibilityLabel="builder-id-input"
                    onChange={id => updateBuilderDraft({ id })}
                  />
                </View>
              </ConfigSection>
            </If>

            <ConfigSection title={tr("agents.profilePrompt")}>
              <View style={{ gap: 12 }}>
                <InputBox
                  label={tr("common.name")}
                  size="md"
                  value={builderDraft().name}
                  placeholder={tr("agents.displayNamePlaceholder")}
                  accessibilityLabel="builder-name-input"
                  onChange={name => updateBuilderDraft({ name })}
                />
                <InputBox
                  label={tr("common.description")}
                  size="md"
                  value={builderDraft().description}
                  placeholder={tr("agents.descriptionPlaceholder")}
                  accessibilityLabel="builder-description-input"
                  onChange={description => updateBuilderDraft({ description })}
                />
                <InputBox
                  label={tr("agents.model")}
                  hint={tr("agents.modelHint")}
                  size="md"
                  monospace
                  value={builderDraft().model}
                  placeholder={tr("agents.modelPlaceholder")}
                  accessibilityLabel="builder-model-input"
                  onChange={model => updateBuilderDraft({ model })}
                />
                <InputBox
                  label={tr("agents.systemPrompt")}
                  multiline
                  minHeight={96}
                  monospace
                  value={builderDraft().prompt}
                  placeholder={tr("agents.systemPromptPlaceholder")}
                  accessibilityLabel="builder-prompt-input"
                  onChange={prompt => updateBuilderDraft({ prompt })}
                />
              </View>
            </ConfigSection>

            <ConfigSection title={tr("agents.safetyToolAccess")} flush controlWidth={240}>
              <ConfigRow
                label={tr("agents.readonlyTools")}
                description={tr("agents.readonlyToolsHint")}
                divider={false}
              >
                <ToggleSwitch
                  value={builderDraft().readonly}
                  accessibilityLabel="builder-readonly-toggle"
                  onChange={next => updateBuilderDraft({ readonly: next })}
                />
              </ConfigRow>
            </ConfigSection>

            <AgentCapabilityCards onOpen={openCapability} />
            <AgentToolGroups tools={builderDraft().tools} editing
              disabled={builderSaving() || builderLoading() || agentsLoading() || Boolean(toolCatalogError())}
              onChange={(names, enabled) => updateBuilderDraft({ tools: setToolSelection(builderDraft().tools, names, enabled) })} />

            <If when={builderDraft().mode === "edit-custom" && builderDraft().kind === "subagent"}>
              <ConfigSection
                title={tr("agents.runtimeOverride")}
                subtitle={tr("agents.runtimeOverrideHint")}
                flush
                controlWidth={220}
                extra={
                  <Button
                    label={builderSaving() ? tr("common.updating") : tr("agents.saveSubagentConfig")}
                    variant="secondary"
                    size="sm"
                    disabled={builderSaving()}
                    accessibilityLabel="subagent-config-save"
                    onPress={() => void saveSubagentRuntimeConfig()}
                  />
                }
              >
                <ConfigRow
                  label={tr("agents.enabledForParent")}
                  description={tr("agents.enabledForParentHint")}
                >
                  <ToggleSwitch
                    value={builderDraft().enabled}
                    accessibilityLabel="subagent-enabled-toggle"
                    onChange={next => updateBuilderDraft({ enabled: next })}
                  />
                </ConfigRow>
                <ConfigRow
                  label={tr("agents.parentAgentMode")}
                  description={tr("agents.parentAgentModeHint")}
                  controlAlign="stretch"
                  divider={false}
                >
                  <SelectDropdown
                    size="md"
                    fullWidth
                    options={availableModes().map(mode => ({
                      value: mode.id,
                      label: mode.name,
                      accessibilityLabel: `subagent-parent-${mode.id}`,
                    }))}
                    value={builderDraft().parentChosen ? builderDraft().parentAgentType : null}
                    placeholder={tr("agents.chooseParent")}
                    accessibilityLabel="subagent-parent-select"
                    onChange={next => updateBuilderDraft({ parentAgentType: next, parentChosen: true })}
                  />
                </ConfigRow>
              </ConfigSection>
            </If>
          </View>
        </If>

        <If when={builderDraft().mode === "configure-profile"}>
          <View style={{ gap: 18 }}>
            <ConfigSection title={tr("agents.builtinProfile")} flush controlWidth={220}>
              <ConfigRow
                label={builderDraft().name}
                description={builderDraft().description || tr("agents.builtinProfileDesc")}
              >
                <Badge label={tr("common.builtin")} tone="neutral" />
              </ConfigRow>
              <ConfigRow
                label={tr("agents.accessMode")}
                description={tr("agents.profileIdLabel", { id: builderDraft().id })}
                divider={false}
              >
                <Text
                  style={{
                    color: palette().textSecondary,
                    fontSize: textSize(12),
                    fontWeight: "500",
                    lineHeight: textLineHeight(12, 1.38),
                  }}
                >
                  {builderDraft().readonly ? tr("common.readonly") : tr("common.readWrite")}
                </Text>
              </ConfigRow>
            </ConfigSection>

            <AgentCapabilityCards onOpen={openCapability} />
          </View>
        </If>

        <If when={builderDraft().mode === "configure-subagent"}>
          <View style={{ gap: 18 }}>
            <ConfigSection title={tr("agents.runtimeConfig")} flush controlWidth={220}>
              <ConfigRow
                label={tr("agents.enabledForParent")}
                description={builderDraft().description || tr("agents.builtinSubagentDesc")}
              >
                <ToggleSwitch
                  value={builderDraft().enabled}
                  accessibilityLabel="subagent-enabled-toggle"
                  onChange={next => updateBuilderDraft({ enabled: next })}
                />
              </ConfigRow>

              <ConfigRow
                label={tr("agents.parentAgentMode")}
                description={tr("agents.targetPrimaryProfile")}
                controlAlign="stretch"
              >
                <SelectDropdown
                  size="md"
                  fullWidth
                  options={availableModes().map(mode => ({
                    value: mode.id,
                    label: mode.name,
                    accessibilityLabel: `subagent-parent-${mode.id}`,
                  }))}
                  value={builderDraft().parentChosen ? builderDraft().parentAgentType : null}
                  placeholder={tr("agents.chooseParent")}
                  accessibilityLabel="subagent-parent-select"
                  onChange={next => updateBuilderDraft({ parentAgentType: next, parentChosen: true })}
                />
              </ConfigRow>

              <ConfigRow
                label={tr("agents.modelOverride")}
                description={tr("agents.modelSelectorHint")}
                controlAlign="stretch"
                divider={false}
              >
                <SelectDropdown
                  size="md"
                  fullWidth
                  searchable
                  options={subagentModelOptions(true)}
                  value={builderDraft().model}
                  accessibilityLabel="subagent-model-select"
                  onChange={model => updateBuilderDraft({ model })}
                />
              </ConfigRow>
            </ConfigSection>

            <ConfigSection
              title={tr("agents.defaultToolsTitle", { count: formatCount(builderDraft().tools.length) })}
            >
              <ToolListText empty={tr("agents.noDefaultTools")} />
            </ConfigSection>
          </View>
        </If>

        <If when={builderDraft().mode === "inspect-external"}>
          <ConfigSection title={tr("agents.readonlyDetails")} flush controlWidth={220}>
            <ConfigRow
              label={builderDraft().name}
              description={builderDraft().description || tr("agents.externalAgentDesc")}
            >
              <Badge label={sourceLabel(builderDraft().source)} tone="neutral" />
            </ConfigRow>
            <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 10 }}>
              <Text
                style={{
                  color: palette().textMuted,
                  fontSize: textSize(12),
                  lineHeight: textLineHeight(12, 1.45),
                }}
              >
                {tr("agents.readonlyNotice")}
              </Text>
              <ToolListText empty={tr("agents.noToolBindings")} />
            </View>
          </ConfigSection>
        </If>
      </View>}>
        <If when={capability() === "tools"}>
          <View style={{ gap: space.md }}>
            <If when={builderError()}>{error => <InlineBanner tone="danger" message={localizeHostError(error())} />}</If>
            <AgentToolGroups tools={builderDraft().tools} changes={selectionDraft() ?? undefined}
              editing={editing()} disabled={busy()} onChange={stage} />
          </View>
        </If>
        <If when={capability() === "skills"}>
          <ModeSkillsPanel changes={selectionDraft() ?? undefined} onChange={stage} />
        </If>
        <If when={capability() === "subagents"}>
          <ParentSubagentsPanel changes={selectionDraft() ?? undefined} disabled={busy()} onChange={stage} />
        </If>
      </If>
    </ModalDialog>
  );
}

/** The draft's tools as one quiet, selectable line instead of a wall of badges. */
function ToolListText(props: { empty: string }) {
  return (
    <Text
      style={{
        minWidth: 0,
        color: builderDraft().tools.length > 0 ? palette().textSecondary : palette().textMuted,
        fontSize: textSize(13),
        lineHeight: textLineHeight(13, 1.55),
        userSelect: "text",
      }}
    >
      {builderDraft().tools.length > 0 ? builderDraft().tools.join(" · ") : props.empty}
    </Text>
  );
}

function AgentCapabilityCards(props: { onOpen: (capability: AgentCapability) => void }) {
  const cards = computed(() => (["tools", "skills", "subagents"] as const).filter(capabilityAvailable));
  // AgentDetailDialog switches to one column at a 460 px content width.
  const narrow = signal(compactLayout());
  return (
    <If when={cards().length > 0}>
      <View role="group" style={{ display: "grid", minWidth: 0, gap: space.md,
        gridTemplateColumns: narrow() ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))" }}
        onLayout={event => narrow.set(event.bounds.size.width <= 460)}>
        <Each of={cards()} key={card => card}>
          {(card, index) => {
            const copy = () => capabilityCopy[card()];
            const lastOddCard = () => !narrow() && cards().length % 2 === 1 && index() === cards().length - 1;
            return (
                <CatalogCard label={tr(copy().title)} description={tr(copy().description)}
                  style={{ minHeight: 112, gridColumn: lastOddCard() ? "1 / 3" : undefined }}
                  testID={`agent-capability-${card()}`} onOpen={() => props.onOpen(card())}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: designTokens.metrics.card.headerGap }}>
                    <Icon name={copy().icon} size={16} color={palette().textSecondary} />
                    <Text style={{ ...textStyle("cardTitle"), flex: 1, numberOfLines: 1, textOverflow: "ellipsis" }}>{tr(copy().title)}</Text>
                    <If when={!capabilityLoading(card()) && !capabilityError(card())}>
                      <Text style={textStyle("caption", { tabular: true })}>
                        {formatCount(savedCapabilitySelection(card()).length)}/{formatCount(capabilityAvailableCount(card()))}
                      </Text>
                    </If>
                    <Icon name="chevron-right" size={14} color={palette().textMuted} />
                  </View>
                  <Text style={{ ...textStyle("smallBody", { color: palette().textSecondary }), flexGrow: 1 }}>
                    {tr(copy().description)}
                  </Text>
                </CatalogCard>
            );
          }}
        </Each>
      </View>
    </If>
  );
}

function CapabilitySelection(props: { entries: ReadonlyArray<{ id: string; label: string }> }) {
  return (
    <If when={props.entries.length > 0} else={<Text style={textStyle("caption")}>{tr("common.none")}</Text>}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
        <Each of={props.entries} key={entry => entry.id}>{entry => <Badge label={entry().label} tone="neutral" />}</Each>
      </View>
    </If>
  );
}

function ModeSkillsPanel(props: {
  changes?: ReadonlyMap<string, boolean>;
  onChange: (keys: readonly string[], enabled: boolean) => void;
}) {
  return (
    <View style={{ gap: space.md }}>
      <If when={modeSkillsError()}>
        {err => (
          <View style={{ gap: space.sm, alignItems: "flex-start" }}>
            <InlineBanner tone="danger" message={localizeHostError(err())} />
            <If when={!modeSkills().length}>
              <Button label={tr("common.retry")} variant="secondary" size="sm" onPress={() => void loadModeSkills(builderDraft().id)} />
            </If>
          </View>
        )}
      </If>
      <If when={modeSkillsLoading() && !modeSkills().length}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Spinner size={14} />
          <Text style={textStyle("caption")}>{tr("common.loading")}</Text>
        </View>
      </If>
      <If when={!modeSkillsLoading() && !modeSkills().length && !modeSkillsError()}>
        <Text style={textStyle("caption")}>{tr("agents.modeSkillsEmpty")}</Text>
      </If>
      <If when={modeSkills().length > 0}>
        <AgentSkillGroups skills={modeSkills()} changes={props.changes}
          disabled={modeSkillsSaving() || modeSkillsLoading() || isRemoteAgentWorkspace()} onChange={props.onChange} />
      </If>
    </View>
  );
}

function ParentSubagentsPanel(props: {
  changes?: ReadonlyMap<string, boolean>;
  disabled: boolean;
  onChange: (keys: readonly string[], enabled: boolean) => void;
}) {
  const rowLabel = (agent: AgentCatalogItem) => agent.source === "external"
    ? `${agent.name} · ${tr("common.external")}`
    : agent.name;
  const selected = () => parentSubagents().filter(agent => agent.effectiveEnabled)
    .map(agent => ({ id: agent.uid, label: rowLabel(agent) }));
  return (
    <View style={{ gap: space.md }}>
      <If when={parentSubagentsError()}>
        {error => (
          <View style={{ gap: space.sm, alignItems: "flex-start" }}>
            <InlineBanner tone="danger" message={localizeHostError(error())} />
            <If when={!parentSubagents().length && !props.changes}>
              <Button label={tr("common.retry")} variant="secondary" size="sm" onPress={() => void loadParentSubagents(builderDraft().id)} />
            </If>
          </View>
        )}
      </If>
      <If when={parentSubagentsLoading() && !parentSubagents().length}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Spinner size={14} />
          <Text style={textStyle("caption")}>{tr("common.loading")}</Text>
        </View>
      </If>
      <If when={!parentSubagentsLoading() && !parentSubagents().length && !parentSubagentsError()}>
        <Text style={textStyle("caption")}>{tr("agents.parentSubagentsEmpty")}</Text>
      </If>
      <If when={parentSubagents().length > 0}>
        <If when={props.changes} else={<CapabilitySelection entries={selected()} />}>
          <InsetGroup>
            <Each of={parentSubagents()} key={item => item.uid}>
              {(item, index) => (
                <ChoiceCheckbox checked={props.changes?.get(item().id) ?? item().effectiveEnabled}
                  disabled={props.disabled || item().source === "external"}
                  accessibilityLabel={rowLabel(item())} testID={`parent-subagent-${item().id}`}
                  style={{ paddingVertical: space.sm, paddingHorizontal: space.md,
                    borderTopWidth: index() > 0 ? 1 : 0, borderColor: palette().borderSubtle }}
                  onChange={enabled => props.onChange([item().id], enabled)}>
                  <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
                    <Text style={textStyle("label")}>{rowLabel(item())}</Text>
                    <Text style={textStyle("caption")}>{plainDescriptionText(item().description) || item().id}</Text>
                  </View>
                </ChoiceCheckbox>
              )}
            </Each>
          </InsetGroup>
        </If>
      </If>
    </View>
  );
}

/** The model choices a subagent can take, as the desktop's agent model selector lists them. */
function subagentModelOptions(includePools: boolean): SelectDropdownOption<string>[] {
  const options: SelectDropdownOption<string>[] = [
    { value: "", label: tr("agents.modelDefault"), accessibilityLabel: "subagent-model-default" },
    { value: "inherit", label: tr("agents.modelInherit"), accessibilityLabel: "subagent-model-inherit" },
    { value: "primary", label: tr("agents.modelPrimary"), accessibilityLabel: "subagent-model-primary" },
    { value: "fast", label: tr("agents.modelFast"), accessibilityLabel: "subagent-model-fast" },
  ];
  for (const model of storedModels()) {
    if (!model.id || model.enabled === false) continue;
    options.push({
      value: model.id,
      label: modelOptionText(model),
      accessibilityLabel: `subagent-model-${model.id}`,
    });
  }
  if (includePools) {
    for (const pool of pools()) {
      options.push({
        value: `${POOL_TOKEN_PREFIX}${pool.id}`,
        label: tr("agents.modelPool", { name: pool.name }),
        icon: "layers",
        accessibilityLabel: `subagent-model-pool-${pool.id}`,
      });
    }
  }
  // A stored choice this list no longer offers stays visible instead of reading as unset.
  const current = builderDraft().model.trim();
  if (current && !options.some(option => option.value === current)) {
    options.push({ value: current, label: current });
  }
  return options;
}

// The gallery is drawn in two sections; each reads its own slice so a filter
// change recomputes once instead of per card.
const filteredModeAgents = computed(() => filteredAgents().filter(item => item.kind === "mode"));
const filteredSubagentAgents = computed(() => filteredAgents().filter(item => item.kind === "subagent"));

/** The quiet count beside a section header. */
function SectionCount(props: { count: number }) {
  return (
    <Text
      style={{
        color: palette().textMuted,
        fontSize: textSize(12),
        fontVariant: ["tabular-nums"],
        lineHeight: textLineHeight(12, 1.35),
      }}
    >
      {formatCount(props.count)}
    </Text>
  );
}

export function AgentsScene(props: { embedded?: boolean }) {
  if (!modelSettingsLoaded()) void loadModels();
  ensurePools();
  // The catalogue does not need a workspace (the host answers user-level
  // entries without one, as the desktop asks). It reloads on every scene entry,
  // when the selected device or workspace changes, and when the window regains focus.
  let enteredScene = false;
  effect(() => {
    const device = deviceContext();
    const workspace = activeWorkspace();
    const key = `${device || "local"}:${workspace?.id ?? "none"}:${workspace?.rootPath ?? ""}`;
    if (!enteredScene || untracked(() => agentsLoadedKey()) !== key) {
      enteredScene = true;
      void loadAgentsCatalog(key);
    }
  });
  let lastLifecycle = untracked(() => lifecycle());
  effect(() => {
    const state = lifecycle();
    const regained = state === "active" && lastLifecycle !== "active";
    lastLifecycle = state;
    if (!regained) return;
    const device = untracked(() => deviceContext());
    const workspace = untracked(() => activeWorkspace());
    const key = `${device || "local"}:${workspace?.id ?? "none"}:${workspace?.rootPath ?? ""}`;
    void loadAgentsCatalog(key);
  });

  const openCreate = () => {
    openCreateBotBuilder("mode");
  };

  const kindTabs = () => (
    <SegmentedTabs
      size="sm"
      options={[
        { value: "all", label: tr("common.all"), accessibilityLabel: "agents-tab-all" },
        { value: "mode", label: tr("agents.tabPrimary"), accessibilityLabel: "agents-tab-mode" },
        { value: "subagent", label: tr("agents.subagents"), accessibilityLabel: "agents-tab-subagent" },
      ]}
      value={agentKindFilter()}
      onChange={next => agentKindFilter.set(next)}
    />
  );
  const filterControls = () => (
    <>
      <SearchInput
        size={compactLayout() ? "lg" : "md"}
        value={agentSearchQuery()}
        placeholder={tr("agents.searchPlaceholder")}
        countLabel={
          hasActiveFilter()
            ? `${formatCount(filteredAgents().length)}/${formatCount(allCatalogAgents().length)}`
            : undefined
        }
        accessibilityLabel="agents-search-input"
        style={{
          flex: 1,
          minWidth: 160,
          maxWidth: studioCompact() ? undefined : 260,
          ...(compactLayout() ? { height: layout.touchTarget, minHeight: layout.touchTarget } : {}),
        }}
        onChange={val => agentSearchQuery.set(val)}
      />
      <FilterMenu
        value={agentSourceFilter()}
        defaultValue="all"
        options={sourceOptions()}
        accessibilityLabel="agents-source-select"
        tooltip={tr("agents.sourceFilter")}
        onChange={next => agentSourceFilter.set(next)}
      />
      <If when={hasActiveFilter()}>
        <Button
          label={tr("common.clear")}
          variant="ghost"
          size="sm"
          accessibilityLabel="agents-filters-clear"
          style={compactLayout() ? { height: layout.touchTarget, minHeight: layout.touchTarget } : undefined}
          onPress={resetCatalogFilters}
        />
      </If>
    </>
  );
  const reloadButton = () => (
    <IconButton
      icon="refresh"
      size="md"
      accessibilityLabel="agents-reload"
      tooltip={tr("agents.reload")}
      disabled={agentsLoading()}
      style={compactLayout() ? { width: layout.touchTarget, height: layout.touchTarget } : undefined}
      onPress={() => void reloadAgentsCatalog()}
    />
  );
  const createButton = () => (
    <Button
      label={tr("agents.newAgent")}
      leadingIcon="plus"
      variant="primary"
      size="md"
      accessibilityLabel="agents-create-bot"
      disabled={isRemoteAgentWorkspace()}
      tooltip={isRemoteAgentWorkspace() ? tr("agents.unavailableRemote") : undefined}
      style={compactLayout() ? { height: layout.touchTarget, minHeight: layout.touchTarget } : undefined}
      onPress={openCreate}
    />
  );

  return (
    <View
      onLayout={trackStudioWidth}
      style={{ flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column", backgroundColor: palette().canvas }}
    >
      <Scroll smoothWheel style={{ flex: 1, minHeight: 0 }}>
        <If
          when={props.embedded}
          else={
            <StudioHeader
              title={tr("agents.title")}
              subtitle={tr("agents.subtitle")}
              actions={
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  {reloadButton()}
                  {createButton()}
                </View>
              }
              extra={<StudioToolbar leading={kindTabs()} trailing={filterControls()} />}
            />
          }
        >
          <LibraryToolbar
            accessibilityLabel="agents-toolbar"
            leading={
              <>
                {kindTabs()}
                {filterControls()}
              </>
            }
            primary={
              <>
                {reloadButton()}
                {createButton()}
              </>
            }
          />
        </If>

        <StudioBody style={props.embedded ? libraryBodyStyle() : undefined}>
          <If when={isRemoteAgentWorkspace() || Boolean(agentsCatalogError()) || Boolean(agentsNotice())}>
            <View style={{ gap: 8 }}>
              <If when={isRemoteAgentWorkspace()}>
                <InlineBanner tone="warning" message={tr("agents.remoteUnsupportedBanner")} />
              </If>

              <If when={agentsCatalogError() ?? ""}>
                {err => <InlineBanner tone="danger" message={localizeHostError(err())} />}
              </If>

              <If when={agentsNotice() ?? ""}>
                {notice => (
                  <InlineBanner
                    tone="neutral"
                    icon="check-circle"
                    message={localizeHostError(notice())}
                    onDismiss={() => agentsNotice.set(null)}
                  />
                )}
              </If>
            </View>
          </If>

          <If when={agentsLoading() && allCatalogAgents().length === 0}>
            <GallerySkeleton count={4} height={156} />
          </If>

          <If when={!agentsLoading() && filteredAgents().length === 0}>
            <StudioEmpty
              icon="bot"
              message={hasActiveFilter() ? tr("agents.emptyFilteredTitle") : tr("agents.emptyTitle")}
              detail={hasActiveFilter() ? tr("agents.emptyFilteredSubtitle") : tr("agents.emptySubtitle")}
              action={
                hasActiveFilter() ? (
                  <Button
                    label={tr("common.resetFilter")}
                    variant="secondary"
                    size="sm"
                    onPress={resetCatalogFilters}
                  />
                ) : isRemoteAgentWorkspace() ? undefined : (
                  <Button
                    label={tr("agents.newAgent")}
                    variant="secondary"
                    size="md"
                    leadingIcon="plus"
                    onPress={openCreate}
                  />
                )
              }
            />
          </If>

          <If when={filteredModeAgents().length > 0}>
            <StudioSection
              title={tr("agents.sectionPrimary")}
              trailing={<SectionCount count={filteredModeAgents().length} />}
            >
              <GalleryGrid>
                <Each of={filteredModeAgents()} key={item => item.uid}>
                  {item => <BotCard item={item()} />}
                </Each>
              </GalleryGrid>
            </StudioSection>
          </If>

          <If when={filteredSubagentAgents().length > 0}>
            <StudioSection
              title={tr("agents.subagents")}
              trailing={<SectionCount count={filteredSubagentAgents().length} />}
            >
              <GalleryGrid>
                <Each of={filteredSubagentAgents()} key={item => item.uid}>
                  {item => <BotCard item={item()} />}
                </Each>
              </GalleryGrid>
            </StudioSection>
          </If>
        </StudioBody>
      </Scroll>

      <AgentBuilderModal />
    </View>
  );
}
