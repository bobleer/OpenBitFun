import { cleanup, computed, effect, signal, Text, untracked, View } from "nsh";
import {
  applyMcpImport, applyMcpUndo, externalMcpNotice, externalSnapshot, mcpImportBusy, mcpImportPlan,
  MAX_MCP_IMPORT_SELECTIONS, mcpItemSelectable, mcpItemStateKey, mcpPlanState, prepareMcpUndo,
  type ExternalCatalogItem, type McpImportedItem, type McpImportItem, type McpImportPlan, type McpUndoReview,
} from "../externalImportStore";
import { formatCount } from "../format";
import { tr } from "../i18n";
import { palette, radii, space, textStyle } from "../theme";
import { ChoiceCheckbox } from "../ui/ChoiceIndicator";
import { ModalDialog } from "../ui/overlays";
import { Badge, Button, ConfigRow, ConfigSection, InlineBanner } from "../ui/primitives";

interface ReviewSelection {
  rows: McpImportItem[];
  selected: ReadonlySet<string>;
  batch: boolean;
}

type Review = ReviewSelection & (
  | { kind: "import"; plan: McpImportPlan; catalog: ReadonlyMap<string, ExternalCatalogItem>; receipts?: McpImportedItem[] }
  | { kind: "undo"; config: McpUndoReview; stale?: boolean }
);

function transportLabel(transport: string): string {
  if (transport === "streamable_http") return tr("settings.externalImports.transportHttp");
  if (transport === "local_stdio") return tr("settings.externalImports.transportStdio");
  return transport || tr("common.unknown");
}

function eligibleIds(rows: readonly McpImportItem[]): Set<string> {
  return new Set(rows.map(item => item.candidateId));
}

export function McpCopyFacts(props: { row: McpImportItem; catalog?: ExternalCatalogItem; nativeId?: string; receipt?: McpImportedItem; completed?: boolean; showDisposition?: boolean }) {
  const sources = () => props.catalog?.sources.map(source => source.location || source.displayName).filter(Boolean) ?? [];
  const details = () => props.catalog?.mcpDetails;
  const fact = (label: string, value: string) => (
    <If when={value}><Text style={textStyle("caption")}>{`${label} · ${value}`}</Text></If>
  );
  return <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
      <Text style={textStyle("label")}>{props.row.displayName}</Text>
      <If when={props.showDisposition !== false}><Badge size="xs" label={tr(props.receipt ? "settings.externalImports.state.imported"
        : props.completed ? "settings.externalImports.importUnconfirmedRow" : mcpItemStateKey(props.row))}
        tone={props.receipt || props.row.disposition === "already_imported" ? "success" : props.completed ? "warning" : "neutral"} /></If>
    </View>
    <Text style={textStyle("caption")}>{transportLabel(props.row.transport)}</Text>
    {fact(tr("settings.externalImports.mcpCopyTarget"), props.receipt?.nativeId ?? props.nativeId ?? props.row.proposedNativeId)}
    {fact(tr("settings.externalImports.mcpCopySource"), sources().join(", "))}
    {fact(tr("settings.externalImports.mcpEndpoint"), details()?.endpoint ?? "")}
    {fact(tr("settings.externalImports.mcpEnvironmentKeys"), details()?.environmentKeys.join(", ") ?? "")}
    {fact(tr("settings.externalImports.mcpHeaderNames"), details()?.headerNames.join(", ") ?? "")}
  </View>;
}

export function ExternalMcpImportGroup(props: {
  candidateIds?: readonly string[];
  ownerId: string;
  unassigned?: boolean;
  externalBatchBusy?: boolean;
  onManage: () => void;
}) {
  const review = signal<Review | null>(null);
  let generation = 0;
  effect(() => {
    void props.ownerId;
    untracked(() => { generation += 1; review.set(null); });
  });
  cleanup(() => { generation += 1; });
  const scopeAllows = (id: string) => !props.candidateIds || props.candidateIds.includes(id);
  const entries = computed(() => (mcpImportPlan()?.items ?? []).filter(item => scopeAllows(item.candidateId)));
  const ready = computed(() => entries().filter(mcpItemSelectable).slice(0, MAX_MCP_IMPORT_SELECTIONS));
  const imported = computed(() => entries().filter(item => item.disposition === "already_imported"));
  const busy = () => mcpImportBusy() !== null || Boolean(props.externalBatchBusy);
  const groupTitle = () => tr(props.unassigned ? "settings.externalImports.unassignedMcp" : "settings.externalImports.mcpTitle");
  const stateText = () => {
    switch (mcpPlanState()) {
      case "loading": return tr("common.loading");
      case "unsupported": return tr("settings.externalImports.unsupportedContext");
      case "error": return tr("settings.externalImports.previewFailed");
      default: return tr(externalSnapshot()?.discovery?.enabled === false
        ? "settings.externalImports.mcpDiscoveryOff" : "settings.externalImports.mcpEmpty");
    }
  };

  function openImport(rows: McpImportItem[], batch: boolean): void {
    const plan = mcpImportPlan();
    if (busy() || mcpPlanState() !== "ready" || !plan?.planFingerprint || !rows.length) return;
    const catalog = new Map((externalSnapshot()?.items ?? []).filter(item => item.kind === "mcp").map(item => [item.id, item]));
    externalMcpNotice.set(null);
    review.set({ kind: "import", plan, rows, batch, selected: eligibleIds(rows), catalog });
  }

  async function openUndo(rows: McpImportItem[], batch: boolean): Promise<void> {
    const version = generation;
    const config = await prepareMcpUndo(rows);
    if (!config || generation !== version) return;
    review.set({ kind: "undo", config, rows, batch, selected: eligibleIds(rows) });
  }

  function checkedChange(id: string, checked: boolean): void {
    review.update(current => {
      if (!current || busy()) return current;
      const selected = new Set(current.selected);
      if (checked) selected.add(id); else selected.delete(id);
      return { ...current, selected };
    });
  }

  async function commit(): Promise<void> {
    const draft = review();
    if (!draft?.selected.size || busy() || [...draft.selected].some(id => !scopeAllows(id))) return;
    if (draft.kind === "undo") {
      if (draft.stale) return;
      const result = await applyMcpUndo(draft.config, [...draft.selected]);
      if (review() !== draft) return;
      if (result === "removed") review.set(null);
      if (result === "stale") review.set({ ...draft, stale: true });
      return;
    }
    const result = await applyMcpImport(draft.plan, [...draft.selected]);
    if (!result || review() !== draft) return;
    if (result.status === "stale") {
      const reviewed = eligibleIds(draft.rows);
      const rows = result.plan.items.filter(item => reviewed.has(item.candidateId) && scopeAllows(item.candidateId));
      const selected = new Set(rows.filter(item => mcpItemSelectable(item) && draft.selected.has(item.candidateId))
        .map(item => item.candidateId));
      review.set({ ...draft, plan: result.plan, rows, selected, catalog: new Map() });
    } else if (draft.batch || result.imported.length !== draft.selected.size) {
      review.set({ ...draft, rows: draft.rows.filter(row => draft.selected.has(row.candidateId)), receipts: result.imported });
    } else {
      review.set(null);
    }
  }

  const undo = () => { const draft = review(); return draft?.kind === "undo" ? draft : null; };
  const completed = () => { const draft = review(); return draft?.kind === "import" ? draft.receipts : undefined; };
  const close = () => { if (!busy()) review.set(null); };
  const open = () => review() !== null;
  const title = () => tr(completed() ? "settings.externalImports.importResults"
    : undo() ? "settings.externalImports.undoTitle" : "settings.externalImports.reviewTitle");
  const selectedCount = () => formatCount(review()?.selected.size ?? 0);
  return <ConfigSection title={groupTitle()} subtitle={tr("settings.externalImports.mcpDescription")} flush
    extra={<View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm }}>
      <If when={imported().length > 1 && mcpPlanState() === "ready"}>
        <Button label={tr("settings.externalImports.undoAll")} size="sm" variant="outline" disabled={busy()}
          accessibilityLabel="external-mcp-undo-all" onPress={() => void openUndo(imported(), true)} />
      </If>
      <If when={ready().length > 0 && mcpPlanState() === "ready"}>
        <Button label={tr("settings.externalImports.importAll", { count: formatCount(ready().length) })}
          variant="primary" size="sm" disabled={busy()} accessibilityLabel={props.unassigned ? "external-mcp-import-all-unassigned" : "external-mcp-import-all"}
          onPress={() => openImport(ready(), true)} />
      </If>
    </View>}>
    <If when={entries().length > 0 && mcpPlanState() === "ready"} else={<ConfigRow label={stateText()} divider={false} />}>
      <Each of={entries()} key={row => row.candidateId}>{(row, index) => (
        <ConfigRow testID={`external-mcp-${row().candidateId}`} label={row().displayName} divider={false} wrap topDivider={index() > 0}
          description={[transportLabel(row().transport), row().disposition === "automatic_rename" && row().proposedNativeId
            ? tr("settings.externalImports.renameTo", { name: row().proposedNativeId }) : ""].filter(Boolean).join(" · ")}>
          <Badge size="xs" pill label={tr(mcpItemStateKey(row()))} tone={row().disposition === "already_imported" ? "success" : "neutral"} />
          <If when={mcpItemSelectable(row())}>
            <Button label={tr("settings.externalImports.import")} variant="secondary" size="sm" disabled={busy()}
              accessibilityLabel={`external-mcp-import-${row().candidateId}`} onPress={() => openImport([row()], false)} />
          </If>
          <If when={row().disposition === "already_imported"}>
            <Button label={tr("settings.externalImports.manageCopy")} variant="ghost" size="sm" disabled={busy()}
              accessibilityLabel={`external-mcp-manage-${row().candidateId}`} onPress={props.onManage} />
            <Button label={tr("settings.externalImports.undoCopy")} variant="secondary" size="sm" disabled={busy()}
              accessibilityLabel={`external-mcp-undo-${row().candidateId}`} onPress={() => void openUndo([row()], false)} />
          </If>
        </ConfigRow>
      )}</Each>
    </If>
    <ModalDialog open={open()} title={title()} size="md" closeOnBackdropPress={!busy()} onClose={close}
      subtitle={undo() ? tr("settings.externalImports.undoWarning") : completed()
        ? tr("settings.externalImports.importResultCount", { count: formatCount(completed()!.length) })
        : tr("settings.externalImports.reviewDescription")}
      accessibilityLabel={undo() ? "external-mcp-undo-review" : "external-mcp-batch-review"}
      footer={<View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm }}>
        <Button label={tr(completed() ? "common.close" : "common.cancel")} size="md" disabled={busy()}
          accessibilityLabel="external-mcp-review-close" onPress={close} />
        <If when={completed() === undefined}>
          <Button label={undo() ? tr("settings.externalImports.undoSelected", { count: selectedCount() })
            : review()?.batch ? tr("settings.externalImports.importSelected", { count: selectedCount() }) : tr("settings.externalImports.import")}
            size="md" variant={undo() ? "danger" : "primary"} loading={busy()}
            disabled={busy() || !review()?.selected.size || Boolean(undo()?.stale)}
            accessibilityLabel={undo() ? "external-mcp-undo-confirm" : "external-mcp-review-confirm"} onPress={() => void commit()} />
        </If>
      </View>}>
      <View style={{ gap: space.md }}>
        <If when={externalMcpNotice()}>{notice => <InlineBanner tone={notice().tone}
          message={tr(notice().key, notice().name ? { name: notice().name! } : undefined)} />}</If>
        <If when={review()?.rows.length === 0}>
          <Text style={textStyle("caption")}>{tr("settings.externalImports.batchEmpty")}</Text>
        </If>
        <Each of={review()?.rows ?? []} key={row => row.candidateId}>{row => {
          const displayFacts = () => {
            const draft = review();
            return <McpCopyFacts row={row()} catalog={draft?.kind === "import" ? draft.catalog.get(row().candidateId) : undefined}
              nativeId={undo()?.config.copies.find(copy => copy.candidateId === row().candidateId)?.nativeId}
              receipt={completed()?.find(item => item.candidateId === row().candidateId)} completed={completed() !== undefined} />;
          };
          return <View style={{ borderRadius: radii.md, borderWidth: 1, borderColor: palette().borderSubtle, padding: space.md }}>
            <If when={review()?.batch && completed() === undefined} else={displayFacts()}>
              <ChoiceCheckbox checked={review()?.selected.has(row().candidateId) ?? false}
                disabled={busy() || Boolean(undo()?.stale) || (!undo() && !mcpItemSelectable(row()))}
                accessibilityLabel={row().displayName} testID={`external-mcp-review-${row().candidateId}`}
                onChange={checked => checkedChange(row().candidateId, checked)}>{displayFacts()}</ChoiceCheckbox>
            </If>
          </View>;
        }}</Each>
      </View>
    </ModalDialog>
  </ConfigSection>;
}
