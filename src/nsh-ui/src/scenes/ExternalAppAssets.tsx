import { cleanup, computed, effect, signal, Text, untracked, View } from "nsh";
import { fleetDeviceContext } from "../bridge";
import { applyHookBatch, canApplyHook, hookBatchSelectable, planHookBatch, type HookBatchEntry, type HookBatchStatus } from "../externalHookBatch";
import {
  applyExternalHook, hookSourceId, mutateExternalHook, planExternalHook, readExternalHooks,
  type ExternalHookPlan, type ExternalHookSnapshot, type ExternalHookSource, type HookMutation, type ImportedHook,
} from "../externalHookImport";
import { isCommandMissing, parseOperationError, workspaceFields } from "../externalImportStore";
import { formatCount } from "../format";
import { localizeHostError, tr, type MessageKey } from "../i18n";
import { canToggleInstalledSkill, directSkillManagementVersion, installedSkills, isSkillDisabled,
  loadSkillsCatalog, skillDiagnostics, skillsCatalogContextKey, skillsError, skillsLoadedKey, skillsLoading, skillsNotice,
  toggleSkillGlobalDisabled, togglingSkillKey,
} from "../skillsCatalogStore";
import { activeWorkspace } from "../state";
import { palette, space, textStyle } from "../theme";
import { ChoiceCheckbox } from "../ui/ChoiceIndicator";
import { ModalDialog } from "../ui/overlays";
import { Badge, Button, ConfigRow, ConfigSection, ConfigSectionHeader, InlineBanner, ToggleSwitch } from "../ui/primitives";

interface AssetProps {
  ecosystemId: string;
  refreshVersion: number;
}

const SKILL_PREVIEW_COUNT = 4;

function skillEcosystemId(source: string): string {
  const identity = source.trim().toLowerCase().replace(/^(home|config)\./, "");
  if (identity === "claude") return "claude-code";
  if (identity === "dsh") return "deepseek-harness";
  if (identity === "agents") return "agent-skills";
  if (identity.startsWith("opencode.")) return "opencode";
  return identity;
}

export function ExternalAppSkills(props: AssetProps) {
  const localNoticeScope = signal("");
  const expanded = signal(false);
  const noticeScope = () => JSON.stringify([skillsCatalogContextKey(), props.ecosystemId]);
  effect(() => {
    noticeScope();
    expanded.set(false);
  });
  let loadedScope = "";
  let loadedRefresh = props.refreshVersion;
  effect(() => {
    const scope = skillsCatalogContextKey();
    const refresh = props.refreshVersion;
    untracked(() => {
      const force = loadedRefresh !== refresh;
      if (loadedScope !== scope) localNoticeScope.set("");
      loadedScope = scope;
      loadedRefresh = refresh;
      if (force || skillsLoadedKey() !== scope) void loadSkillsCatalog(force);
    });
  });
  const rows = computed(() => skillsLoadedKey() === skillsCatalogContextKey()
    ? installedSkills().filter(skill => !skill.isBuiltin && skillEcosystemId(skill.sourceId || skill.sourceSlot) === props.ecosystemId)
    : []);
  const visibleRows = () => expanded() ? rows() : rows().slice(0, SKILL_PREVIEW_COUNT);
  const ready = () => skillsLoadedKey() === skillsCatalogContextKey() && !skillsLoading();
  const diagnostics = computed(() => ready()
    ? skillDiagnostics().filter(item => skillEcosystemId(item.sourceId) === props.ecosystemId)
    : []);
  const managed = () => ready() && directSkillManagementVersion() === 1;
  const notice = () => localNoticeScope() === noticeScope() ? skillsNotice() : null;
  const loadError = () => ready() ? skillsError() : null;
  return (
    <ConfigSection title={tr("settings.externalImports.skillsTitle")} subtitle={tr("settings.externalImports.skillsDescription")} flush
      extra={<If when={rows().length > SKILL_PREVIEW_COUNT}>
        <Button label={tr(expanded() ? "common.showLess" : "common.showAll")} size="sm" variant="ghost"
          accessibilityLabel="external-skills-expand" onPress={() => expanded.update(open => !open)} />
      </If>}>
      <If when={loadError()}>{message => <InlineBanner tone="warning"
        message={localizeHostError(message())} actionLabel={tr("common.retry")} onAction={() => void loadSkillsCatalog(true)} />}
      </If>
      <If when={notice()}>{message => <InlineBanner tone="neutral" message={localizeHostError(message())} />}</If>
      <Each of={diagnostics()}>{item => <InlineBanner tone="warning"
        message={[item().path, localizeHostError(item().message)].filter(Boolean).join(" · ")} />}
      </Each>
      <If when={rows().length > 0} else={<If when={!loadError() && diagnostics().length === 0}>
        <ConfigRow label={ready() ? tr("settings.externalImports.skillsEmpty") : tr("common.loading")} divider={false} />
      </If>}>
        <Each of={visibleRows()} key={skill => skill.key}>
          {(skill, index) => (
            <ConfigRow label={skill().name} wrap topDivider={index() > 0} divider={false}
              description={[
                skill().description,
                tr(skill().level === "project" ? "settings.externalImports.scope.project" : "settings.externalImports.scope.user"),
                skill().path,
              ].filter(Boolean).join(" · ")}>
              <If when={directSkillManagementVersion() === 1} else={<Text style={textStyle("caption")}>
                {tr("settings.externalImports.skillsUnsupported")}
              </Text>}>
                <ToggleSwitch value={!isSkillDisabled(skill().key)}
                  accessibilityLabel={`external-skill-enabled-${skill().key}`}
                  disabled={!managed() || !canToggleInstalledSkill(skill()) || Boolean(togglingSkillKey())}
                  onChange={enabled => {
                    if (!managed()) return;
                    localNoticeScope.set(noticeScope());
                    void toggleSkillGlobalDisabled(skill(), enabled);
                  }} />
              </If>
            </ConfigRow>
          )}
        </Each>
      </If>
    </ConfigSection>
  );
}

type HookReview =
  | { kind: "import"; plan: ExternalHookPlan }
  | { kind: "remove"; entry: ImportedHook; revision: string }
  | HookBatch;

interface HookBatch {
  kind: "batch";
  mode: "import" | "remove";
  revision: string;
  entries: HookBatchEntry[];
}

const batchStatusLabels: Partial<Record<HookBatchStatus, MessageKey>> = {
  stale: "settings.externalImports.hooks.batchStale",
  saved: "settings.externalImports.state.imported",
  removed: "settings.externalImports.hooks.batchRemoved",
  failed: "settings.externalImports.hooks.batchFailed",
};

const hookStates: Readonly<Record<string, MessageKey>> = {
  update_available: "settings.externalImports.hooks.updateAvailable",
  source_missing: "settings.externalImports.hooks.sourceMissing",
  update_check_failed: "settings.externalImports.hooks.updateCheckFailed",
  bundle_missing: "settings.externalImports.hooks.bundleMissing",
};

function hookScope(source: ExternalHookSource): string {
  if (source.scope === "project") return tr("settings.externalImports.scope.project");
  if (source.scope === "user_global") return tr("settings.externalImports.scope.user");
  return tr("settings.externalImports.scope.workspace");
}

function canPlanHook(source: ExternalHookSource): boolean {
  return (source.ecosystemId === "codex" || source.ecosystemId === "claude-code")
    && (source.scope === "user_global" || source.scope === "project" || source.scope === "workspace_local");
}

export function HookPlanDetails(props: { plan: ExternalHookPlan }) {
  return (
    <View style={{ gap: space.md }}>
      <If when={!canApplyHook(props.plan)}>
        <InlineBanner tone="neutral" message={tr(props.plan.disposition === "unchanged"
          ? "settings.externalImports.hooks.unchanged" : "settings.externalImports.hooks.noCompatibleCommands")} />
      </If>
      <Each of={props.plan.handlers} key={handler => handler.stableKey}>
        {handler => (
          <ConfigSection title={[handler().event, handler().matcher].filter(Boolean).join(" · ")}>
            <View style={{ gap: space.sm }}>
              <Text style={{ ...textStyle("mono"), userSelect: "text" }}>{handler().command}</Text>
              <If when={handler().commandWindows}>
                {command => <View style={{ gap: space.xs }}>
                  <Text style={textStyle("caption")}>{tr("settings.externalImports.hooks.windowsCommand")}</Text>
                  <Text style={{ ...textStyle("mono"), userSelect: "text" }}>{command()}</Text>
                </View>}
              </If>
              <If when={handler().timeoutSeconds !== undefined}>
                <Text style={textStyle("caption")}>{tr("settings.externalImports.hooks.timeout", { count: formatCount(handler().timeoutSeconds ?? 0) })}</Text>
              </If>
              <If when={handler().statusMessage}>
                {message => <Text style={textStyle("caption")}>{message()}</Text>}
              </If>
              <Each of={handler().dependencies ?? []}>
                {dependency => <Text style={{ ...textStyle("caption"), userSelect: "text" }}>{(() => {
                  const value = dependency();
                  return value.kind === "managed"
                    ? tr("settings.externalImports.hooks.copiedDependency", { path: value.relativePath })
                    : tr("settings.externalImports.hooks.externalDependency", { path: value.location });
                })()}</Text>}
              </Each>
            </View>
          </ConfigSection>
        )}
      </Each>
      <Each of={props.plan.skipped} key={item => item.reasonCode}>
        {item => <Text style={textStyle("caption")}>
          {tr("settings.externalImports.hooks.skipped", { count: formatCount(item().count), reason: item().reasonCode })}
        </Text>}
      </Each>
      <Text style={{ ...textStyle("caption"), userSelect: "text" }}>
        {tr("settings.externalImports.hooks.fingerprint", { fingerprint: props.plan.planFingerprint })}
      </Text>
    </View>
  );
}

export interface ExternalAppHookBatchState {
  scope: string;
  ecosystemId: string;
  revision: string | null;
  sources: readonly ExternalHookSource[];
  imports: readonly ImportedHook[];
  busy: boolean;
  publish: (next: ExternalHookSnapshot) => void;
  reload: () => Promise<void>;
}

export function ExternalAppHooks(props: AssetProps & {
  automaticDiscovery: boolean;
  externalBatchBusy?: boolean;
  onBatchStateChange?: (state: ExternalAppHookBatchState) => void;
}) {
  const scopedSnapshot = signal<{ scope: string; value: ExternalHookSnapshot } | null>(null);
  const loading = signal(false);
  const unavailable = signal(false);
  const loadFailure = signal(false);
  const notice = signal<{ tone: "success" | "warning" | "danger"; message: string } | null>(null);
  const busy = signal(false);
  const review = signal<HookReview | null>(null);
  let loadTicket = 0;
  let operationTicket = 0;
  const scope = skillsCatalogContextKey;
  const snapshot = () => {
    const current = scopedSnapshot();
    return current?.scope === scope() ? current.value : null;
  };
  const writeSnapshot = (value: ExternalHookSnapshot) => scopedSnapshot.set({ scope: scope(), value });
  const publishMutation = (value: ExternalHookSnapshot) => {
    loadTicket += 1;
    loading.set(false);
    loadFailure.set(false);
    unavailable.set(false);
    writeSnapshot(value);
  };

  async function load(force: boolean, poll = false) {
    const key = scope();
    const ticket = ++loadTicket;
    const stillCurrent = () => key === scope() && ticket === loadTicket;
    if (!poll) loading.set(true);
    unavailable.set(false);
    loadFailure.set(false);
    try {
      const next = await readExternalHooks(workspaceFields(activeWorkspace()), force);
      if (stillCurrent()) writeSnapshot(next);
    } catch (error) {
      if (!stillCurrent()) return;
      if (isCommandMissing("get_external_hook_catalog", error)) unavailable.set(true);
      else loadFailure.set(true);
    } finally {
      if (stillCurrent()) loading.set(false);
    }
  }

  let lastScope = "";
  let lastRefresh = props.refreshVersion;
  effect(() => {
    const key = scope();
    const refresh = props.refreshVersion;
    const automatic = props.automaticDiscovery;
    untracked(() => {
      if (lastScope !== key) {
        scopedSnapshot.set(null);
        loading.set(false);
        unavailable.set(false);
        loadFailure.set(false);
        lastScope = key;
      }
      const force = refresh !== lastRefresh;
      lastRefresh = refresh;
      if (force || (automatic && !snapshot() && !loading())) void load(force);
    });
  });
  effect(() => {
    const value = snapshot();
    if (!value?.catalog.discoveryPending || busy() || props.externalBatchBusy || loading() || loadFailure() || !props.automaticDiscovery) return;
    const timer = setTimeout(() => void load(false, true), 1000);
    cleanup(() => clearTimeout(timer));
  });
  effect(() => {
    scope();
    void props.ecosystemId;
    untracked(() => {
      operationTicket += 1;
      review.set(null);
      notice.set(null);
      busy.set(false);
    });
  });
  cleanup(() => { loadTicket += 1; operationTicket += 1; });

  const rows = computed(() => {
    const current = snapshot();
    if (!current) return [];
    const imports = new Map(current.imports.filter(entry => entry.source.ecosystemId === props.ecosystemId)
      .map(entry => [hookSourceId(entry.source.key), entry]));
    const sources = new Map(current.catalog.sources.filter(source => source.ecosystemId === props.ecosystemId)
      .map(source => [hookSourceId(source.key), source]));
    return [...new Set([...sources.keys(), ...imports.keys()])].map(id => ({
      id,
      source: sources.get(id) ?? imports.get(id)!.source,
      imported: imports.get(id),
      discovered: sources.has(id),
    }));
  });
  const providerFailed = () => snapshot()?.catalog.providers.some(provider => provider.ecosystemId === props.ecosystemId
    && snapshot()?.catalog.failedProviderIds?.includes(provider.providerId)) ?? false;
  const diagnosticRows = computed(() => {
    const current = snapshot();
    const providerIds = new Set(current?.catalog.providers.filter(provider => provider.ecosystemId === props.ecosystemId)
      .map(provider => provider.providerId));
    const store = (current?.diagnostics ?? []).filter(item => !item.source || providerIds.has(item.source.providerId));
    const catalog = (current?.catalog.diagnostics ?? []).filter(item => item.source && providerIds.has(item.source.providerId));
    const sources = rows().flatMap(row => row.source.diagnostics ?? []);
    return [...new Set([...store, ...catalog, ...sources].map(item => item.message))];
  });
  const ready = () => Boolean(snapshot()?.revision) && !loading() && !unavailable() && !loadFailure();
  const canStart = () => ready() && !busy() && !props.externalBatchBusy;
  const sourceCurrent = (source: ExternalHookSource) =>
    !snapshot()?.catalog.staleProviderIds?.includes(source.key.providerId)
    && !snapshot()?.catalog.failedProviderIds?.includes(source.key.providerId);
  const batchSources = computed(() => rows()
    .filter(row => row.discovered && canPlanHook(row.source) && sourceCurrent(row.source)
      && (!row.imported || row.imported.state !== "current"))
    .map(row => row.source));
  const batchImports = computed(() => rows().flatMap(row => row.imported ? [row.imported] : []));
  effect(() => {
    const key = scope();
    const ecosystemId = props.ecosystemId;
    const sameScope = () => key === scope() && ecosystemId === props.ecosystemId;
    const state: ExternalAppHookBatchState = {
      scope: key, ecosystemId, revision: ready() ? snapshot()?.revision ?? null : null,
      sources: batchSources(), imports: batchImports(), busy: busy() || loading() || review() !== null,
      publish: next => { if (sameScope()) publishMutation(next); },
      reload: async () => { if (sameScope()) await load(false); },
    };
    untracked(() => props.onBatchStateChange?.(state));
  });
  const emptyText = () => {
    if (loading() || snapshot()?.catalog.discoveryPending) return tr("settings.externalImports.scanning");
    if (unavailable()) return tr("settings.externalImports.hooks.unsupported");
    if (loadFailure() || providerFailed()) return tr("settings.externalImports.hooks.loadFailed");
    if (!snapshot() && !props.automaticDiscovery) return tr("settings.externalImports.notScanned");
    return tr("settings.externalImports.hooks.empty");
  };
  const statusText = (entry: ImportedHook | undefined, source: ExternalHookSource) => {
    if (!entry) return sourceCurrent(source) ? "" : tr("settings.externalImports.hooks.updateCheckFailed");
    const state = hookStates[entry.state];
    return [tr(entry.enabled ? "common.enabled" : "common.disabled"), state ? tr(state) : ""].filter(Boolean).join(" · ");
  };
  const close = () => { if (!busy()) { review.set(null); notice.set(null); } };

  async function run(action: (current: () => boolean) => Promise<void>, fallback: MessageKey) {
    if (!canStart()) return;
    const ticket = ++operationTicket;
    const key = scope();
    const ecosystem = props.ecosystemId;
    const current = () => ticket === operationTicket && key === scope() && ecosystem === props.ecosystemId;
    loadTicket += 1;
    busy.set(true);
    notice.set(null);
    try {
      await action(current);
    } catch (error) {
      if (!current()) return;
      const parsed = parseOperationError(error);
      if (parsed?.code === "stale_revision") {
        review.set(null);
        notice.set({ tone: "warning", message: tr("settings.externalImports.hooks.revisionChanged") });
        await load(false);
      } else {
        const detail = parsed?.detail ? localizeHostError(parsed.detail) : "";
        notice.set({ tone: "danger", message: [tr(fallback), detail].filter(Boolean).join(" ") });
      }
    } finally {
      if (current()) busy.set(false);
    }
  }

  async function prepare(source: ExternalHookSource) {
    if (!canPlanHook(source) || !sourceCurrent(source) || source.ecosystemId !== props.ecosystemId) return;
    await run(async current => {
      const plan = await planExternalHook(workspaceFields(activeWorkspace()), source);
      if (current()) review.set({ kind: "import", plan });
    }, "settings.externalImports.previewFailed");
  }

  async function apply(plan: ExternalHookPlan) {
    if (!canApplyHook(plan)) return;
    await run(async current => {
      const result = await applyExternalHook(workspaceFields(activeWorkspace()), plan);
      if (!current()) return;
      if (result.kind === "stale") {
        review.set({ kind: "import", plan: result.refreshedPlan });
        notice.set({ tone: "warning", message: tr("settings.externalImports.stale") });
        return;
      }
      publishMutation(result.snapshot);
      review.set(null);
      notice.set({ tone: "success", message: tr("settings.externalImports.hooks.saved", { name: plan.source.displayName }) });
    }, "settings.externalImports.hooks.applyFailed");
  }

  async function mutate(revision: string, mutation: HookMutation) {
    await run(async current => {
      const next = await mutateExternalHook(workspaceFields(activeWorkspace()), revision, mutation);
      if (!current()) return;
      publishMutation(next);
      review.set(null);
    }, "settings.externalImports.hooks.changeFailed");
  }

  async function prepareBatch(mode: HookBatch["mode"]) {
    const revision = snapshot()?.revision;
    if (!revision || !canStart()) return;
    if (mode === "remove") {
      review.set({ kind: "batch", mode, revision, entries: batchImports().map(imported => ({
        source: imported.source, imported, checked: true, status: "ready",
      })) });
      return;
    }
    const sources = batchSources();
    const workspace = workspaceFields(activeWorkspace());
    const route = { target: fleetDeviceContext() };
    await run(async current => {
      const entries = await planHookBatch(sources, { workspace, route, current });
      if (current()) review.set({ kind: "batch", mode, revision, entries });
    }, "settings.externalImports.previewFailed");
  }

  function updateBatchEntry(source: ExternalHookSource, patch: Partial<HookBatchEntry>) {
    const key = hookSourceId(source.key);
    review.update(value => value?.kind === "batch" ? {
      ...value,
      entries: value.entries.map(entry => hookSourceId(entry.source.key) === key ? { ...entry, ...patch } : entry),
    } : value);
  }

  async function applyBatch(batch: HookBatch) {
    const workspace = workspaceFields(activeWorkspace());
    const route = { target: fleetDeviceContext() };
    await run(async current => {
      const stale = await applyHookBatch({
        mode: batch.mode, revision: batch.revision, entries: batch.entries,
        workspace, route, current,
        publish: next => {
          publishMutation(next);
          review.update(value => value?.kind === "batch" ? { ...value, revision: next.revision! } : value);
        },
        update: (entry, patch) => updateBatchEntry(entry.source, patch),
      });
      if (stale && current()) {
        review.update(value => value?.kind === "batch" ? {
          ...value,
          entries: value.entries.map(entry => entry.status === "ready" ? { ...entry, checked: false, status: "stale" } : entry),
        } : value);
        await load(false);
      }
    }, batch.mode === "remove" ? "settings.externalImports.hooks.changeFailed" : "settings.externalImports.hooks.applyFailed");
  }

  const noticeBanner = () => <If when={notice()}>{value =>
    <InlineBanner tone={value().tone} message={value().message} onDismiss={() => notice.set(null)} />}
  </If>;
  return (
    <ConfigSection title={tr("settings.externalImports.hooks.title")} subtitle={tr("settings.externalImports.hooks.description")} flush
      extra={<View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm }}>
        <If when={Boolean(snapshot()?.revision) && batchSources().length > 1}>
          <Button label={tr("settings.externalImports.hooks.batchReview")} variant="secondary" size="sm"
            accessibilityLabel="external-hooks-review-batch" disabled={!canStart()} onPress={() => void prepareBatch("import")} />
        </If>
        <If when={Boolean(snapshot()?.revision) && batchImports().length > 1}>
          <Button label={tr("settings.externalImports.hooks.batchReviewRemoval")} variant="ghost" size="sm"
            accessibilityLabel="external-hooks-remove-batch" disabled={!canStart()} onPress={() => void prepareBatch("remove")} />
        </If>
        <Button label={tr("common.refresh")} variant="ghost" size="sm" leadingIcon="refresh"
          accessibilityLabel="external-hooks-refresh" disabled={busy() || props.externalBatchBusy || loading() || Boolean(review())}
          onPress={() => { notice.set(null); void load(true); }} />
      </View>}>
      <If when={!review()}>{noticeBanner()}</If>
      <If when={snapshot() && !snapshot()?.revision}>
        <InlineBanner tone="neutral" message={tr("settings.externalImports.hooks.unsupported")} />
      </If>
      <Each of={diagnosticRows()}>{message => <InlineBanner tone="warning" message={message()} />}</Each>
      <If when={rows().length > 0} else={<ConfigRow label={emptyText()} divider={false} />}>
        <If when={loadFailure() || providerFailed()}><InlineBanner tone="warning" message={tr("settings.externalImports.hooks.loadFailed")} /></If>
        <Each of={rows()} key={row => row.id}>
          {(row, index) => (
            <ConfigRow label={row().source.displayName} wrap topDivider={index() > 0} divider={false}
              description={[
                hookScope(row().source), row().source.locationHint, statusText(row().imported, row().source),
                canPlanHook(row().source) ? "" : tr("settings.externalImports.hooks.sourceOnly"),
              ].filter(Boolean).join(" · ")}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: space.sm }}>
                <If when={row().imported}>
                  {entry => <>
                    <ToggleSwitch value={entry().enabled} disabled={!canStart()}
                      accessibilityLabel={`external-hook-enabled-${entry().importId}`}
                      onChange={enabled => {
                        const revision = snapshot()?.revision;
                        if (revision) void mutate(revision, { kind: "set_enabled", importId: entry().importId, enabled });
                      }} />
                    <Button label={tr("common.remove")} variant="ghost" size="sm" disabled={!canStart()}
                      accessibilityLabel={`external-hook-remove-${entry().importId}`}
                      onPress={() => {
                        const revision = snapshot()?.revision;
                        if (revision) { notice.set(null); review.set({ kind: "remove", entry: entry(), revision }); }
                      }} />
                  </>}
                </If>
                <If when={row().discovered && canPlanHook(row().source) && Boolean(snapshot()?.revision)
                  && (!row().imported || row().imported?.state !== "current")}>
                  <Button label={tr(row().imported ? "settings.externalImports.hooks.reviewUpdate" : "settings.externalImports.hooks.reviewImport")}
                    variant="secondary" size="sm" disabled={!canStart() || !sourceCurrent(row().source)}
                    accessibilityLabel={`external-hook-review-${row().source.key.sourceId}`}
                    onPress={() => void prepare(row().source)} />
                </If>
              </View>
            </ConfigRow>
          )}
        </Each>
      </If>
      <If when={(() => { const value = review(); return value?.kind === "batch" ? value : null; })()}>
        {batch => {
          const count = () => batch().entries.filter(entry => entry.checked && hookBatchSelectable(entry)).length;
          const removing = () => batch().mode === "remove";
          return <ModalDialog open size="lg" accessibilityLabel="external-hook-batch-dialog"
            title={tr(removing() ? "settings.externalImports.hooks.batchReviewRemoval" : "settings.externalImports.hooks.batchReview")}
            subtitle={tr(removing() ? "settings.externalImports.hooks.batchRemoveDescription" : "settings.externalImports.hooks.reviewDescription")}
            onClose={close} closeOnBackdropPress={!busy()} closeOnEscape={!busy()}
            footer={<>
              <Button label={tr("common.close")} variant="secondary" disabled={busy()} onPress={close} />
              <If when={batch().entries.some(hookBatchSelectable)}>
                <Button label={tr(removing() ? "settings.externalImports.hooks.batchRemoveSelected" : "settings.externalImports.hooks.batchApplySelected",
                  { count: formatCount(count()) })}
                  variant={removing() ? "danger" : "primary"} loading={busy()}
                  accessibilityLabel="external-hook-batch-confirm" disabled={!canStart() || count() === 0}
                  onPress={() => void applyBatch(batch())} />
              </If>
            </>}>
            <View style={{ gap: space.md }}>
              {noticeBanner()}
              <Each of={batch().entries} key={entry => hookSourceId(entry.source.key)}>
                {entry => <View style={{ gap: space.md }}>
                  <ConfigSectionHeader title={entry().source.displayName}
                    description={`${hookScope(entry().source)} · ${entry().source.locationHint}`}
                    extra={<View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                      <If when={batchStatusLabels[entry().status]}>
                        {label => <Badge label={tr(label())}
                          tone={entry().status === "saved" || entry().status === "removed" ? "success"
                            : entry().status === "failed" ? "danger" : "warning"} />}
                      </If>
                      <If when={hookBatchSelectable(entry())}>
                        <ChoiceCheckbox checked={entry().checked} disabled={busy()}
                          accessibilityLabel={`external-hook-batch-select-${entry().source.key.sourceId}`}
                          onChange={checked => updateBatchEntry(entry().source, { checked })} />
                      </If>
                    </View>} />
                  <If when={entry().detail}>{text => <Text style={textStyle("caption")}>{text()}</Text>}</If>
                  <If when={entry().status === "saved" ? undefined : entry().plan}>
                    {plan => <HookPlanDetails plan={plan()} />}
                  </If>
                </View>}
              </Each>
            </View>
          </ModalDialog>;
        }}
      </If>
      <If when={(() => { const value = review(); return value?.kind === "batch" ? null : value; })()}>
        {item => {
          const plan = () => { const value = item(); return value.kind === "import" ? value.plan : null; };
          const removal = () => { const value = item(); return value.kind === "remove" ? value : null; };
          const source = () => plan()?.source ?? removal()!.entry.source;
          return <ModalDialog open size="lg" accessibilityLabel="external-hook-review-dialog"
            title={tr(removal() ? "settings.externalImports.hooks.removeTitle" : "settings.externalImports.hooks.reviewTitle")}
            subtitle={`${source().displayName} · ${hookScope(source())} · ${source().locationHint}`}
            onClose={close} closeOnBackdropPress={!busy()} closeOnEscape={!busy()}
            footer={<>
              <Button label={tr("common.cancel")} variant="secondary" disabled={busy()} onPress={close} />
              <If when={plan()}>
                {preview => <Button label={tr(preview().disposition === "update" ? "settings.externalImports.hooks.update" : "settings.externalImports.import")}
                  variant="primary" accessibilityLabel="external-hook-apply"
                  disabled={!canStart() || !canApplyHook(preview())} onPress={() => void apply(preview())} />}
              </If>
              <If when={removal()}>
                {entry => <Button label={tr("common.remove")} variant="danger" accessibilityLabel="external-hook-confirm-remove"
                  disabled={!canStart()} onPress={() => void mutate(entry().revision, { kind: "remove", importId: entry().entry.importId })} />}
              </If>
            </>}>
            <View style={{ gap: space.md }}>
              {noticeBanner()}
              <If when={plan()}>
                {preview => <>
                  <Text style={textStyle("body", { color: palette().textSecondary })}>{tr("settings.externalImports.hooks.reviewDescription")}</Text>
                  <HookPlanDetails plan={preview()} />
                </>}
              </If>
              <If when={removal()}><Text style={textStyle("body")}>{tr("settings.externalImports.hooks.removeDescription")}</Text></If>
            </View>
          </ModalDialog>;
        }}
      </If>
    </ConfigSection>
  );
}
