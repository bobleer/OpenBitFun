import { cleanup, computed, effect, signal, Text, untracked, View } from "nsh";
import { fleetDeviceContext } from "../bridge";
import { applyHookBatch, hookBatchSelectable, planHookBatch, type ExternalBatchMode, type HookBatchEntry, type HookBatchStatus } from "../externalHookBatch";
import { hookSourceId } from "../externalHookImport";
import {
  applyMcpImport, applyMcpUndo, externalLoadState, externalMcpNotice, externalSnapshot, loadMcpImportPlan,
  MAX_MCP_IMPORT_SELECTIONS, mcpImportBusy, mcpImportPlan, mcpItemSelectable, mcpPlanState, prepareMcpUndo, workspaceFields,
  type ExternalCatalogItem, type McpImportedItem, type McpImportItem, type McpImportPlan, type McpUndoReview,
} from "../externalImportStore";
import { formatCount } from "../format";
import { tr, type MessageKey } from "../i18n";
import { skillsCatalogContextKey } from "../skillsCatalogStore";
import { activeWorkspace } from "../state";
import { compactLayout, palette, radii, space, textStyle } from "../theme";
import { ChoiceCheckbox } from "../ui/ChoiceIndicator";
import { ModalDialog } from "../ui/overlays";
import { Badge, Button, ConfigSection, ConfigSectionHeader, InlineBanner } from "../ui/primitives";
import { ProductBrandIcon } from "../ui/ProductBrandIcon";
import { Toolbar } from "../ui/Toolbar";
import { HookPlanDetails, type ExternalAppHookBatchState } from "./ExternalAppAssets";
import { McpCopyFacts } from "./ExternalMcpImports";

interface McpBatchEntry {
  item: McpImportItem;
  checked: boolean;
  status: HookBatchStatus;
  receipt?: McpImportedItem;
}

interface AppBatch {
  mode: ExternalBatchMode;
  mcp: McpBatchEntry[];
  hooks: HookBatchEntry[];
  catalog: ReadonlyMap<string, ExternalCatalogItem>;
  plan: McpImportPlan | null;
  undo: McpUndoReview | null;
  hookRevision: string | null;
}

const statusKeys: Record<HookBatchStatus, MessageKey> = {
  ready: "settings.externalImports.state.ready", skipped: "settings.externalImports.appBatchSkipped",
  stale: "settings.externalImports.hooks.batchStale", saved: "settings.externalImports.state.imported",
  removed: "settings.externalImports.hooks.batchRemoved", failed: "settings.externalImports.hooks.batchFailed",
};

function mcpSelectable(batch: AppBatch, entry: McpBatchEntry): boolean {
  if (batch.mode === "remove") return entry.status === "ready" && Boolean(batch.undo);
  return Boolean(batch.plan?.planFingerprint) && mcpItemSelectable(entry.item)
    && (entry.status === "ready" || entry.status === "stale");
}

function BatchStatus(props: { status: HookBatchStatus }) {
  return <Badge label={tr(statusKeys[props.status])} size="xs" tone={props.status === "saved" || props.status === "removed"
    ? "success" : props.status === "failed" ? "danger" : props.status === "stale" ? "warning" : "neutral"} />;
}

/** The selected app's identity and its shared import and removal review. */
export function ExternalAppBatchHeader(props: {
  appId: string;
  name: string;
  mcpIds: readonly string[];
  hooks: ExternalAppHookBatchState | null;
  onBusyChange: (busy: boolean) => void;
  onRefresh: () => void;
}) {
  const busy = signal(false);
  const batch = signal<AppBatch | null>(null);
  let generation = 0;
  const changeBusy = (value: boolean) => { busy.set(value); props.onBusyChange(value); };
  effect(() => {
    void props.appId;
    skillsCatalogContextKey();
    untracked(() => { generation += 1; batch.set(null); changeBusy(false); });
  });
  cleanup(() => { generation += 1; props.onBusyChange(false); });
  const hookState = () => {
    const hooks = props.hooks;
    return hooks?.ecosystemId === props.appId && hooks.scope === skillsCatalogContextKey() ? hooks : null;
  };
  const locations = computed(() => [...new Set(externalSnapshot()?.sources.filter(source => source.ecosystemId === props.appId)
    .map(source => source.location).filter(Boolean))]);
  const matchesApp = (item: McpImportItem) => props.mcpIds.includes(item.candidateId);
  const mcpRows = (mode: ExternalBatchMode) => mcpPlanState() === "ready"
    ? (mcpImportPlan()?.items.filter(item => matchesApp(item) && (mode === "remove"
      ? item.disposition === "already_imported" : mcpItemSelectable(item))) ?? []) : [];
  const canStart = () => externalLoadState() === "ready" && !busy() && !mcpImportBusy() && !hookState()?.busy;
  const showActions = () => (props.mcpIds.length > 0 && mcpPlanState() !== "unsupported")
    || Boolean(hookState()?.revision && (hookState()?.sources.length || hookState()?.imports.length));
  const canReview = (mode: ExternalBatchMode) => mcpRows(mode).length > 0 || Boolean(hookState()?.revision
    && (mode === "remove" ? hookState()?.imports.length : hookState()?.sources.length));
  const currentOperation = () => {
    const epoch = generation;
    const scope = skillsCatalogContextKey();
    const appId = props.appId;
    return { workspace: workspaceFields(activeWorkspace()), route: { target: fleetDeviceContext() },
      current: () => epoch === generation && appId === props.appId && scope === skillsCatalogContextKey() };
  };

  async function prepare(mode: ExternalBatchMode): Promise<void> {
    if (!canStart() || !canReview(mode)) return;
    const op = currentOperation();
    const hooks = hookState();
    let rows = mcpRows(mode);
    let plan: McpImportPlan | null = null;
    changeBusy(true);
    externalMcpNotice.set(null);
    try {
      const hookEntries = hooks?.revision ? mode === "remove"
        ? Promise.resolve(hooks.imports.map(imported => ({ source: imported.source, imported, checked: true, status: "ready" as const })))
        : planHookBatch(hooks.sources, op) : Promise.resolve([]);
      if (mode === "import" && rows.length) {
        await loadMcpImportPlan();
        if (!op.current()) return;
        if (mcpPlanState() === "ready") {
          plan = mcpImportPlan();
          rows = mcpRows(mode).slice(0, MAX_MCP_IMPORT_SELECTIONS);
        }
      }
      const undo = mode === "remove" && rows.length ? await prepareMcpUndo(rows) : null;
      const entries = await hookEntries;
      if (!op.current()) return;
      const catalog = new Map((externalSnapshot()?.items ?? []).filter(item => item.kind === "mcp").map(item => [item.id, item]));
      const mcpReady = mode === "remove" ? undo !== null : Boolean(plan?.planFingerprint);
      batch.set({ mode, catalog, plan, undo,
        mcp: rows.map(item => ({ item, status: mcpReady ? "ready" : "failed", checked: mcpReady })),
        hooks: entries, hookRevision: hooks?.revision ?? null,
      });
    } finally { if (op.current()) changeBusy(false); }
  }

  const selectedCount = () => {
    const draft = batch();
    return draft ? draft.mcp.filter(entry => entry.checked && matchesApp(entry.item) && mcpSelectable(draft, entry)).length
      + draft.hooks.filter(entry => entry.checked && hookBatchSelectable(entry)).length : 0;
  };
  const hasChoices = (draft: AppBatch) => draft.mcp.some(entry => matchesApp(entry.item) && mcpSelectable(draft, entry))
    || draft.hooks.some(hookBatchSelectable);
  const processed = () => {
    const draft = batch();
    return [...(draft?.mcp ?? []), ...(draft?.hooks ?? [])].filter(entry => entry.status !== "ready").length;
  };
  const updateHook = (entry: HookBatchEntry, patch: Partial<HookBatchEntry>) => batch.update(value => value && ({ ...value,
    hooks: value.hooks.map(row => hookSourceId(row.source.key) === hookSourceId(entry.source.key) ? { ...row, ...patch } : row),
  }));
  const updateMcp = (id: string, patch: Partial<McpBatchEntry>) => batch.update(value => value && ({ ...value,
    mcp: value.mcp.map(row => row.item.candidateId === id ? { ...row, ...patch } : row),
  }));

  async function commit(): Promise<void> {
    const draft = batch();
    if (!draft || !selectedCount() || busy()) return;
    const op = currentOperation();
    const hooks = hookState();
    const chosenMcp = draft.mcp.filter(entry => entry.checked && matchesApp(entry.item) && mcpSelectable(draft, entry));
    const selected = new Set(chosenMcp.map(entry => entry.item.candidateId));
    changeBusy(true);
    externalMcpNotice.set(null);
    const skipUnchecked = <T extends { status: HookBatchStatus; checked: boolean }>(entry: T): T =>
      !entry.checked && entry.status === "ready" ? { ...entry, status: "skipped" } : entry;
    batch.set({ ...draft, mcp: draft.mcp.map(entry => matchesApp(entry.item)
      ? skipUnchecked(entry) : { ...entry, status: "stale", checked: false }), hooks: draft.hooks.map(skipUnchecked) });
    try {
      if (selected.size && draft.mode === "import" && draft.plan) {
        const result = await applyMcpImport(draft.plan, [...selected]);
        if (!op.current()) return;
        if (result?.status === "stale") {
          const plan = result.plan;
          batch.update(value => value && ({ ...value, plan, catalog: new Map(), mcp: value.mcp.map(row => {
            if (!selected.has(row.item.candidateId)) return row;
            const item = plan.items.find(next => next.candidateId === row.item.candidateId);
            return { ...row, item: item ?? row.item, status: item ? "stale" : "skipped", checked: false };
          }) }));
        } else {
          const imported = result?.imported ?? [];
          for (const id of selected) {
            const receipt = imported.find(item => item.candidateId === id);
            updateMcp(id, { status: receipt ? "saved" : "failed", checked: false, receipt });
          }
        }
      }
      if (selected.size && draft.mode === "remove" && draft.undo) {
        const result = await applyMcpUndo(draft.undo, [...selected]);
        if (!op.current()) return;
        const status = result === "removed" ? "removed" : result === "stale" ? "stale" : "failed";
        for (const id of selected) updateMcp(id, { status, checked: false });
      }
      if (draft.hookRevision && hooks) {
        const stale = await applyHookBatch({ ...op, mode: draft.mode, revision: draft.hookRevision, entries: draft.hooks,
          publish: next => {
            hooks.publish(next);
            batch.update(value => value && ({ ...value, hookRevision: next.revision }));
          }, update: updateHook,
        });
        if (stale && op.current()) await hooks.reload();
      }
    } finally { if (op.current()) changeBusy(false); }
  }

  const close = () => { if (!busy()) { batch.set(null); externalMcpNotice.set(null); } };
  const reviewItemStyle = () => ({ gap: space.md, padding: space.md, borderWidth: 1,
    borderColor: palette().borderSubtle, borderRadius: radii.md });
  return <>
    <ConfigSection title="" flush bodyStyle={{ backgroundColor: palette().panelRaised }}>
      <Toolbar size="md" style={{ borderBottomWidth: 0 }} leading={<View style={{ flex: 1, minWidth: 0,
        flexDirection: compactLayout() ? "column" : "row", flexWrap: "wrap", alignItems: compactLayout() ? "stretch" : "center",
        justifyContent: "space-between", gap: space.md }}>
        <View style={{ flexGrow: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.md }}>
          <ProductBrandIcon productId={props.appId} size={space.xxl} />
          <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
            <Text role="header" accessibilityLabel="external-app-heading" style={textStyle("sectionTitle")}>{props.name}</Text>
            <Text style={textStyle("caption")} accessibilityLabel="external-app-location">
              {locations().length ? locations().join(" · ") : tr("settings.externalImports.notDetected")}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          <If when={showActions()}>
            <Button size="sm" label={tr("settings.externalImports.appImportAll")} variant="outline" leadingIcon="download"
              accessibilityLabel="external-app-import-all" disabled={!canStart() || !canReview("import")}
              onPress={() => void prepare("import")} />
            <Button size="sm" label={tr("settings.externalImports.undoAll")} variant="outline"
              accessibilityLabel="external-app-undo-all" disabled={!canStart() || !canReview("remove")}
              onPress={() => void prepare("remove")} />
          </If>
          <Button size="sm" label={tr("settings.externalImports.refresh")} variant="outline" leadingIcon="refresh"
            accessibilityLabel="external-import-refresh" disabled={!canStart() || externalSnapshot()?.canRefresh === false}
            onPress={props.onRefresh} />
        </View>
      </View>} />
    </ConfigSection>
    <If when={batch()}>{draft => <ModalDialog open size="lg" accessibilityLabel="external-app-batch-review"
      title={tr(draft().mode === "import" ? "settings.externalImports.appImportReview" : "settings.externalImports.appUndoReview")}
      subtitle={tr(draft().mode === "import" ? "settings.externalImports.appReviewDescription" : "settings.externalImports.appUndoWarning")}
      onClose={close} closeOnBackdropPress={!busy()} closeOnEscape={!busy()}
      footer={<>
        <Button size="md" label={tr("common.close")} onPress={close} disabled={busy()} accessibilityLabel="external-app-batch-close" />
        <If when={busy() || hasChoices(draft())}><Button size="md" variant={draft().mode === "remove" ? "danger" : "primary"}
          label={tr(draft().mode === "remove" ? "settings.externalImports.undoSelected" : "settings.externalImports.importSelected",
            { count: formatCount(selectedCount()) })} loading={busy()} disabled={busy() || selectedCount() === 0}
          accessibilityLabel="external-app-batch-confirm" onPress={() => void commit()} /></If>
      </>}>
      <View style={{ gap: space.lg }}>
        <If when={processed() > 0 || busy()}><Text style={textStyle("caption")}>
          {tr("settings.externalImports.appBatchProgress", { processed: formatCount(processed()), total: formatCount(draft().mcp.length + draft().hooks.length) })}
        </Text></If>
        <If when={externalMcpNotice()}>{notice => <InlineBanner tone={notice().tone}
          message={tr(notice().key, notice().name ? { name: notice().name! } : undefined)} />}</If>
        <If when={draft().mcp.length + draft().hooks.length === 0}>
          <Text style={textStyle("caption")}>{tr("settings.externalImports.batchEmpty")}</Text>
        </If>
        <If when={draft().mcp.length > 0}><View style={{ gap: space.sm }}>
          <ConfigSectionHeader title={tr("settings.externalImports.mcpTitle")} />
          <Each of={draft().mcp} key={entry => entry.item.candidateId}>{entry => {
            const inApp = () => matchesApp(entry().item);
            const facts = () => <McpCopyFacts row={entry().item}
                catalog={draft().mode === "import" ? draft().catalog.get(entry().item.candidateId) : undefined}
                nativeId={draft().undo?.copies.find(copy => copy.candidateId === entry().item.candidateId)?.nativeId}
                receipt={entry().receipt} showDisposition={inApp() && (entry().status === "ready" || entry().status === "saved")} />;
            return <View style={reviewItemStyle()}>
              <If when={!inApp() || (entry().status !== "ready" && entry().status !== "saved")}>
                <BatchStatus status={inApp() ? entry().status : "stale"} />
              </If>
              <If when={inApp() && mcpSelectable(draft(), entry())} else={facts()}>
                <ChoiceCheckbox checked={entry().checked} disabled={busy()} accessibilityLabel={entry().item.displayName}
                  testID={`external-app-batch-mcp-${entry().item.candidateId}`}
                  onChange={checked => updateMcp(entry().item.candidateId, { checked })}>{facts()}</ChoiceCheckbox>
              </If>
            </View>;
          }}</Each>
        </View></If>
        <If when={draft().hooks.length > 0}><View style={{ gap: space.sm }}>
          <ConfigSectionHeader title={tr("settings.externalImports.hooks.title")} />
          <Each of={draft().hooks} key={entry => hookSourceId(entry.source.key)}>{entry => {
            const facts = () => <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
              <Text style={textStyle("label")}>{entry().source.displayName}</Text>
              <Text style={textStyle("caption")}>{entry().source.locationHint}</Text>
            </View>;
            return <View style={reviewItemStyle()}>
              <If when={entry().status !== "ready"}><BatchStatus status={entry().status} /></If>
              <If when={hookBatchSelectable(entry())} else={facts()}>
                <ChoiceCheckbox checked={entry().checked} disabled={busy()}
                  accessibilityLabel={entry().source.displayName} testID={`external-app-batch-hook-${entry().source.key.sourceId}`}
                  onChange={checked => updateHook(entry(), { checked })}>{facts()}</ChoiceCheckbox>
              </If>
              <If when={entry().detail}>{detail => <Text style={textStyle("caption")}>{detail()}</Text>}</If>
              <If when={entry().status === "saved" ? undefined : entry().plan}>{plan => <HookPlanDetails plan={plan()} />}</If>
            </View>;
          }}</Each>
        </View></If>
      </View>
    </ModalDialog>}</If>
  </>;
}
