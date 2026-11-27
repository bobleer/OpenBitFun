import { computed, effect, signal, untracked, View } from "nsh";
import {
  canChangeExternalRuntime, externalDiscoverySaving, externalLoadState, externalSnapshot,
  externalSourceControl, externalSourceControlBusy, submitExternalRuntimeManagement, type ExternalSourceControlState,
} from "../externalImportStore";
import {
  canDisableRuntimeItem, canEditRuntimeModelBinding, canEnableRuntimeItem,
  runtimeBatchItems, runtimeManagementCommand, runtimeModelTargetKey,
  type ManagedRuntimeKind, type RuntimeApproval, type RuntimeDetail, type RuntimeItem, type RuntimeManagementDecision,
  type RuntimeModelBinding, type RuntimeModelTarget,
} from "../externalRuntimeReview";
import { formatCount } from "../format";
import { tr, type MessageKey } from "../i18n";
import { skillsCatalogContextKey } from "../skillsCatalogStore";
import { space } from "../theme";
import { ModalDialog, SelectDropdown } from "../ui/overlays";
import { Badge, Button, ConfigRow, ConfigSection, InlineBanner } from "../ui/primitives";
import { ReviewDetails } from "./ExternalRuntimeReview";

const kinds = ["tool", "subagent", "mcp"] as const;
const sectionLabels: Record<ManagedRuntimeKind, MessageKey> = {
  tool: "settings.externalImports.runtimeInventory.tools",
  subagent: "settings.externalImports.runtimeInventory.subagents",
  mcp: "settings.externalImports.runtimeInventory.mcp",
};
const states: Readonly<Record<string, MessageKey>> = {
  active: "common.active",
  disabled: "common.disabled",
  unavailable: "common.unavailable",
  unsupported: "common.unavailable",
  removed: "settings.externalImports.runtimeInventory.removed",
  approval_required: "settings.externalImports.runtimeInventory.pending",
  declined: "settings.externalImports.runtimeInventory.declined",
  starting: "settings.externalImports.runtimeInventory.starting",
  conflict: "settings.externalImports.runtimeReview.unresolved",
  covered: "settings.externalImports.runtimeInventory.covered",
  source_disabled: "settings.externalImports.runtimeInventory.sourceDisabled",
  configuration_changed: "settings.externalImports.runtimeInventory.changed",
  runtime_unavailable: "settings.externalImports.runtimeInventory.runtimeUnavailable",
  blocked: "settings.externalImports.runtimeInventory.blocked",
  load_failed: "settings.externalImports.runtimeInventory.loadFailed",
  discovered: "settings.externalImports.runtimeInventory.discovered",
};
const modelMethods: Readonly<Record<string, MessageKey>> = {
  default: "settings.externalImports.runtimeInventory.automatic",
  inherit: "settings.externalImports.runtimeInventory.inherited",
  exact: "settings.externalImports.runtimeInventory.exact",
  explicit: "settings.externalImports.runtimeInventory.explicit",
  binding_required: "settings.externalImports.runtimeInventory.bindingRequired",
  binding_unavailable: "settings.externalImports.runtimeInventory.bindingUnavailable",
};

type RuntimeInspection =
  | { type: "item"; snapshot: ExternalSourceControlState; item: RuntimeItem }
  | { type: "batch"; snapshot: ExternalSourceControlState; decision: Extract<RuntimeManagementDecision, { kind: "batch" }>; items: RuntimeApproval[] };

function mappedLabel(labels: Readonly<Record<string, MessageKey>>, value: string): string {
  return tr(Object.hasOwn(labels, value) ? labels[value]! : "common.unknown");
}

function runtimeItemDescription(item: RuntimeItem): string {
  return item.details.filter(row => row.kind === "source" || row.kind === "model" || row.kind === "description"
    || (item.state === "discovered" && row.kind === "location"))
    .map(row => row.values.join(" · ")).join(" · ");
}

function targetDescription(target: RuntimeModelTarget): string {
  if (target.kind === "primary") return tr("settings.externalImports.runtimeInventory.primaryModel");
  if (target.kind === "fast") return tr("settings.externalImports.runtimeInventory.fastModel");
  return tr("settings.externalImports.runtimeInventory.configuredModel");
}

function bindingLabel(binding: RuntimeModelBinding): string {
  return binding.requestedModel || tr(binding.requestKind === "inherit"
    ? "settings.externalImports.runtimeInventory.inherited" : "settings.externalImports.runtimeInventory.sourceModel");
}

export function ExternalRuntimeInventory(props: { ecosystemId: string }) {
  const control = () => externalSourceControl();
  const catalog = () => control()?.runtimeReviews;
  const busy = () => Boolean(externalSourceControlBusy());
  const locked = () => externalLoadState() !== "ready" || externalDiscoverySaving() || busy();
  const editable = () => !locked() && canChangeExternalRuntime(control());
  const inspection = signal<RuntimeInspection | null>(null);
  const inspectedItem = computed(() => {
    const value = inspection();
    return value?.type === "item" ? value.item : null;
  });
  const inspectedBatch = computed(() => {
    const value = inspection();
    return value?.type === "batch" ? value : null;
  });
  const canEnableInspected = () => {
    const item = inspectedItem();
    return item ? canEnableRuntimeItem(item) : false;
  };
  const canDisableInspected = () => {
    const item = inspectedItem();
    return item ? canDisableRuntimeItem(item) : false;
  };
  let lastScope = "";
  effect(() => {
    const scope = JSON.stringify([skillsCatalogContextKey(), props.ecosystemId]);
    if (scope === lastScope) return;
    lastScope = scope;
    untracked(() => inspection.set(null));
  });

  const sections = computed(() => {
    const snapshot = catalog();
    return kinds.flatMap(kind => {
      const rows = (snapshot?.items ?? []).filter(item => item.kind === kind && item.ecosystemIds.includes(props.ecosystemId));
      const seen = new Set(rows.map(item => item.key));
      if (kind !== "mcp") {
        for (const discovered of externalSnapshot()?.items ?? []) {
          if (discovered.kind !== kind || seen.has(discovered.id) || !discovered.ecosystemIds.includes(props.ecosystemId)) continue;
          const details: RuntimeDetail[] = [
            { kind: "description", values: discovered.description ? [discovered.description] : [] },
            { kind: "location", values: discovered.sources.map(source => source.location).filter(Boolean) },
          ];
          rows.push({
            kind, key: discovered.id, name: discovered.name, ecosystemIds: discovered.ecosystemIds,
            state: "discovered", approval: null,
            details: details.filter(row => row.values.length > 0),
          });
        }
      }
      if (!rows.length) return [];
      return [{ kind, rows,
        pending: snapshot ? runtimeBatchItems(snapshot, kind, props.ecosystemId, true).length : 0,
        disable: snapshot ? runtimeBatchItems(snapshot, kind, props.ecosystemId, false).length : 0 }];
    });
  });
  const modelBindings = computed(() => (catalog()?.modelBindings ?? []).filter(binding =>
    binding.ecosystemIds.includes(props.ecosystemId)));

  const stale = () => Boolean(inspection() && inspection()?.snapshot !== control());
  const close = () => { if (!busy()) inspection.set(null); };
  function openItem(item: RuntimeItem) {
    const snapshot = control();
    if (snapshot && !locked()) inspection.set({ type: "item", snapshot, item });
  }
  function openBatch(assetKind: ManagedRuntimeKind, enabled: boolean) {
    const snapshot = control();
    if (!snapshot || !editable()) return;
    const decision = { kind: "batch", ecosystemId: props.ecosystemId, assetKind, enabled } as const;
    if (!runtimeManagementCommand(snapshot.runtimeReviews, decision)) return;
    inspection.set({ type: "batch", snapshot, decision,
      items: runtimeBatchItems(snapshot.runtimeReviews, assetKind, props.ecosystemId, enabled) });
  }
  function itemDecision(item: RuntimeItem, approved: boolean) {
    return { kind: "item", assetKind: item.kind, itemKey: item.key, approved } as const;
  }
  const inspectDecision = (review: RuntimeInspection, approved: boolean) =>
    review.type === "batch" ? review.decision : itemDecision(review.item, approved);
  function canSubmit(approved: boolean): boolean {
    const review = inspection();
    return Boolean(review && editable() && !stale()
      && runtimeManagementCommand(review.snapshot.runtimeReviews, inspectDecision(review, approved)));
  }
  async function submit(approved: boolean) {
    const review = inspection();
    if (!review || !canSubmit(approved)) return;
    if (await submitExternalRuntimeManagement(review.snapshot, inspectDecision(review, approved)) && inspection() === review) {
      inspection.set(null);
    }
  }

  const unknownTarget = "unavailable";
  function selection(binding: RuntimeModelBinding): string {
    return binding.unknownSelection ? unknownTarget : runtimeModelTargetKey(binding.selected);
  }
  function modelChoices(binding: RuntimeModelBinding) {
    const current = selection(binding);
    const values: { value: string; label: string; description?: string; disabled?: boolean }[] = [
      { value: "source", label: tr(binding.profile ? "settings.externalImports.runtimeInventory.unbound"
        : "settings.externalImports.runtimeInventory.sourceModel") },
      ...(catalog()?.modelOptions ?? []).map(option => ({
        value: runtimeModelTargetKey(option.target), label: option.label,
        description: [targetDescription(option.target), option.effort].filter(Boolean).join(" · "),
      })),
    ];
    if (!values.some(option => option.value === current)) {
      const selected = binding.selected;
      const target = selected?.kind === "model" ? selected.modelId : selected ? targetDescription(selected) : "";
      values.push({ value: current, label: [tr("common.unavailable"), target].filter(Boolean).join(" · "), disabled: true });
    }
    return values;
  }
  function changeBinding(binding: RuntimeModelBinding, targetKey: string) {
    const snapshot = control();
    if (!snapshot || !editable() || targetKey === selection(binding)) return;
    void submitExternalRuntimeManagement(snapshot, { kind: "model", bindingKey: binding.key, targetKey });
  }

  return <>
    <Each of={sections()} key={section => section.kind}>
      {section => <ConfigSection title={tr(sectionLabels[section().kind])} flush>
        <If when={section().pending > 0 || section().disable > 0}>
          <ConfigRow label={tr("settings.externalImports.runtimeInventory.batch")} divider={false} wrap>
            <If when={section().pending > 0}>
              <Button label={tr("settings.externalImports.runtimeInventory.enablePending", { count: formatCount(section().pending) })}
                size="sm" variant="secondary" accessibilityLabel={`external-runtime-bulk-enable-${section().kind}`}
                disabled={!editable() || catalog()?.generation[section().kind] == null}
                onPress={() => openBatch(section().kind, true)} />
            </If>
            <If when={section().disable > 0}>
              <Button label={tr("settings.externalImports.runtimeInventory.disableAll")} size="sm" variant="secondary"
                accessibilityLabel={`external-runtime-bulk-disable-${section().kind}`}
                disabled={!editable() || catalog()?.generation[section().kind] == null}
                onPress={() => openBatch(section().kind, false)} />
            </If>
          </ConfigRow>
        </If>
        <Each of={section().rows} key={item => item.key}>
          {(item, index) => <ConfigRow label={item().name} description={runtimeItemDescription(item())}
            divider={false} topDivider={index() > 0 || section().pending > 0 || section().disable > 0} wrap>
            <Badge label={mappedLabel(states, item().state)} />
            <If when={item().details.length > 0 && control()}>
              <Button label={tr("common.details")} variant="secondary" size="sm"
                accessibilityLabel={`external-runtime-details-${item().kind}-${item().key}`}
                disabled={locked()} onPress={() => openItem(item())} />
            </If>
          </ConfigRow>}
        </Each>
      </ConfigSection>}
    </Each>
    <If when={modelBindings().length > 0}>
      <ConfigSection title={tr("settings.externalImports.runtimeInventory.modelBindings")} flush>
        <Each of={modelBindings()} key={group => group.key}>
          {(group, index) => <ConfigRow label={bindingLabel(group())}
            description={[group().profile, mappedLabel(modelMethods, group().method),
              tr("settings.externalImports.runtimeInventory.affected", { count: formatCount(group().affectedCount) }),
              group().effective].filter(Boolean).join(" · ")} divider={false} topDivider={index() > 0} wrap>
            <If when={canEditRuntimeModelBinding(group())}>
              <SelectDropdown size="sm" align="end" minWidth={160} value={selection(group())} options={modelChoices(group())}
                accessibilityLabel={`external-runtime-model-binding-${group().key}`}
                disabled={!editable() || catalog()?.generation.subagent == null} onChange={key => changeBinding(group(), key)} />
            </If>
          </ConfigRow>}
        </Each>
      </ConfigSection>
    </If>
    <If when={inspection()}>{current => <ModalDialog open size="lg"
      title={inspectedItem()?.name ?? tr(inspectedBatch()?.decision.enabled
        ? "settings.externalImports.runtimeInventory.reviewEnable" : "settings.externalImports.runtimeInventory.reviewDisable")}
      accessibilityLabel="external-runtime-inventory-dialog" onClose={close}
      closeOnEscape={!busy()} closeOnBackdropPress={!busy()}
      footer={<>
        <Button label={tr("common.cancel")} variant="secondary" disabled={busy()} onPress={close} />
        <If when={canDisableInspected()}>
          <Button label={tr("common.disable")} variant="secondary" disabled={!canSubmit(false)}
            accessibilityLabel="external-runtime-item-disable" onPress={() => void submit(false)} />
        </If>
        <If when={inspectedBatch() || canEnableInspected()}>
          <Button label={tr(inspectedBatch()?.decision.enabled === false
            ? "common.disable" : "common.allow")} variant="primary" disabled={!canSubmit(true)} loading={busy()}
            accessibilityLabel="external-runtime-inventory-confirm" onPress={() => void submit(true)} />
        </If>
      </>}>
      <View style={{ gap: space.md }}>
        <If when={stale() || !canChangeExternalRuntime(current().snapshot)}>
          <InlineBanner tone="warning" message={tr(stale() ? "settings.externalImports.runtimeReview.changed"
            : "settings.externalImports.runtimeReview.readOnly")} />
        </If>
        <If when={inspectedItem()}>{item => <>
          <If when={canEnableRuntimeItem(item())}><InlineBanner tone="warning" message={tr("settings.externalImports.runtimeReview.warning")} /></If>
          <ConfigSection title={tr("common.details")} flush><ReviewDetails rows={item().details} /></ConfigSection>
        </>}</If>
        <If when={inspectedBatch()}>{batch => <>
          <If when={batch().decision.enabled}>
            <InlineBanner tone="warning" message={tr("settings.externalImports.runtimeReview.warning")} />
          </If>
          <Each of={batch().items} key={item => item.id}>
            {item => <ConfigSection title={item().name} flush><ReviewDetails rows={item().details} /></ConfigSection>}
          </Each>
        </>}</If>
      </View>
    </ModalDialog>}</If>
  </>;
}
