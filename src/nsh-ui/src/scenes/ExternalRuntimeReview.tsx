import { computed, effect, signal, untracked, View } from "nsh";
import {
  canChangeExternalRuntime, externalDiscoverySaving, externalLoadState, externalSourceControl, externalSourceControlBusy,
  submitExternalRuntimeReview, type ExternalSourceControlState,
} from "../externalImportStore";
import {
  DISABLED_SUBAGENT_CHOICE, runtimeReviewCommand, type RuntimeApproval, type RuntimeConflict,
  type RuntimeDetail, type RuntimeDetailKind, type RuntimeKind, type RuntimeReviewDecision,
} from "../externalRuntimeReview";
import { formatCount } from "../format";
import { tr, type MessageKey } from "../i18n";
import { skillsCatalogContextKey } from "../skillsCatalogStore";
import { space } from "../theme";
import { ModalDialog } from "../ui/overlays";
import { Badge, Button, ConfigRow, ConfigSection, InlineBanner } from "../ui/primitives";

const kindLabels: Record<RuntimeKind, MessageKey> = {
  command: "settings.externalImports.runtimeReview.command",
  tool: "settings.externalImports.runtimeReview.tool",
  subagent: "settings.externalImports.runtimeReview.subagent",
  mcp: "settings.externalImports.mcpTitle",
};

const detailLabels: Record<RuntimeDetailKind, MessageKey> = {
  source: "settings.externalImports.runtimeReview.source",
  location: "settings.externalImports.sourceLocations",
  scope: "settings.externalImports.runtimeReview.scope",
  domain: "settings.externalImports.runtimeReview.domain",
  runtime: "settings.externalImports.runtimeReview.runtime",
  modules: "settings.externalImports.runtimeReview.modules",
  directory: "settings.externalImports.runtimeReview.directory",
  capabilities: "settings.externalImports.runtimeReview.access",
  tools: "settings.externalImports.catalog.tools",
  model: "settings.externalImports.runtimeReview.model",
  compatibility: "settings.externalImports.runtimeReview.compatibility",
  description: "settings.externalImports.runtimeReview.description",
  transport: "settings.externalImports.runtimeReview.transport",
  command: "settings.externalImports.runtimeReview.command",
  url: "settings.externalImports.runtimeReview.url",
  argumentCount: "settings.externalImports.runtimeReview.argumentCount",
  startupTimeout: "settings.externalImports.runtimeReview.startupTimeout",
  catalogTimeout: "settings.externalImports.runtimeReview.catalogTimeout",
  executionTimeout: "settings.externalImports.runtimeReview.executionTimeout",
  environment: "settings.externalImports.runtimeReview.environment",
  environmentReads: "settings.externalImports.runtimeReview.environmentReads",
  headers: "settings.externalImports.runtimeReview.headers",
  reason: "settings.externalImports.runtimeReview.reason",
  role: "settings.externalImports.runtimeInventory.role",
  requestedModel: "settings.externalImports.runtimeInventory.requestedModel",
  unavailableTools: "settings.externalImports.runtimeInventory.unavailableTools",
};

const scopeLabels: Readonly<Record<string, MessageKey>> = {
  user_global: "settings.externalImports.scope.user",
  project: "settings.externalImports.scope.project",
  workspace_local: "settings.externalImports.scope.workspace",
  remote_project: "settings.externalImports.scope.remote",
  remote_user: "settings.externalImports.scope.remote",
};

const capabilityLabels: Readonly<Record<string, MessageKey>> = {
  file_system: "settings.externalImports.runtimeReview.fileSystem",
  network: "settings.externalImports.runtimeReview.network",
  process: "settings.externalImports.runtimeReview.process",
  environment: "settings.externalImports.runtimeReview.environment",
};

function detailText(detail: RuntimeDetail): string {
  return detail.values.map(value => {
    if (detail.kind === "argumentCount") return formatCount(Number(value));
    if (detail.kind === "startupTimeout" || detail.kind === "catalogTimeout" || detail.kind === "executionTimeout") {
      return tr("settings.externalImports.runtimeReview.milliseconds", { count: formatCount(Number(value)) });
    }
    const key = detail.kind === "scope" ? scopeLabels[value] : detail.kind === "capabilities" ? capabilityLabels[value] : undefined;
    return key ? tr(key) : value;
  }).join(" · ");
}

export function ReviewDetails(props: { rows: RuntimeDetail[] }) {
  return <Each of={props.rows} key={row => row.kind}>
    {(row, index) => <ConfigRow label={tr(detailLabels[row().kind])} description={detailText(row())}
      wrap divider={false} topDivider={index() > 0} />}
  </Each>;
}

type Review =
  | { kind: "approval"; snapshot: ExternalSourceControlState; item: RuntimeApproval }
  | { kind: "conflict"; snapshot: ExternalSourceControlState; item: RuntimeConflict };

export function ExternalRuntimeReviewSections(props: { ecosystemId: string }) {
  const selectedReview = signal<Review | null>(null);
  const selectedCandidate = signal("");
  effect(() => {
    skillsCatalogContextKey();
    void props.ecosystemId;
    untracked(() => { selectedReview.set(null); selectedCandidate.set(""); });
  });
  const catalog = () => externalSourceControl()?.runtimeReviews;
  const belongs = (ids: string[]) => ids.length === 0 || ids.includes(props.ecosystemId);
  const approvals = computed(() => (catalog()?.approvals ?? []).filter(item => belongs(item.ecosystemIds)));
  const conflicts = computed(() => (catalog()?.conflicts ?? []).filter(item => belongs(item.ecosystemIds)));
  const locked = () => externalLoadState() !== "ready" || externalDiscoverySaving() || Boolean(externalSourceControlBusy());
  const busy = () => Boolean(externalSourceControlBusy());
  const stale = () => Boolean(selectedReview() && selectedReview()?.snapshot !== externalSourceControl());
  const close = () => { if (!busy()) selectedReview.set(null); };
  const openApproval = (item: RuntimeApproval) => {
    const snapshot = externalSourceControl();
    if (snapshot && !locked()) selectedReview.set({ kind: "approval", snapshot, item });
  };
  const openConflict = (item: RuntimeConflict) => {
    const snapshot = externalSourceControl();
    if (snapshot && !locked()) {
      selectedCandidate.set(item.selectedId);
      selectedReview.set({ kind: "conflict", snapshot, item });
    }
  };
  const candidate = () => {
    const current = selectedReview();
    return current?.kind === "conflict" ? current.item.candidates.find(item => item.id === selectedCandidate()) : undefined;
  };
  const choiceApproves = () => {
    const review = selectedReview();
    return review?.kind === "conflict" && (review.item.kind === "subagent" || review.item.kind === "mcp")
      && candidate()?.external === true;
  };
  function decision(approved = true): RuntimeReviewDecision | null {
    const current = selectedReview();
    if (!current) return null;
    if (current.kind === "approval") return { kind: "approval", item: current.item, approved };
    if (!selectedCandidate() || selectedCandidate() === current.item.selectedId) return null;
    return { kind: "conflict", item: current.item, candidateId: selectedCandidate() };
  }
  const canSubmit = () => {
    const choice = decision();
    return Boolean(choice && runtimeReviewCommand(choice) && canChangeExternalRuntime(selectedReview()?.snapshot ?? null)
      && !stale() && !locked());
  };
  async function submit(approved = true) {
    if (!canSubmit()) return;
    const review = selectedReview();
    const choice = decision(approved);
    if (!review || !choice) return;
    await submitExternalRuntimeReview(review.snapshot, choice);
    if (selectedReview() === review) selectedReview.set(null);
  }
  const conflictText = (item: RuntimeConflict) => {
    if (!item.selectedId) return tr("settings.externalImports.runtimeReview.unresolved");
    if (item.selectedId === DISABLED_SUBAGENT_CHOICE) return tr("settings.externalImports.runtimeReview.disableAll");
    const selected = item.candidates.find(candidate => candidate.id === item.selectedId);
    return selected?.available ? tr("settings.externalImports.runtimeReview.winner", { name: selected.name })
      : tr("settings.externalImports.runtimeReview.selectedUnavailable");
  };

  return <>
    <If when={approvals().length > 0}>
      <ConfigSection title={tr("settings.externalImports.runtimeReview.approvals")} flush>
        <Each of={approvals()} key={item => `${item.kind}:${item.id}`}>
          {(item, index) => <ConfigRow label={item().name} description={tr(kindLabels[item().kind])} wrap topDivider={index() > 0} divider={false}>
            <Button label={tr("settings.externalImports.runtimeReview.review")} size="sm" variant="secondary"
              accessibilityLabel={`external-approval-review-${item().id}`} disabled={locked()}
              onPress={() => openApproval(item())} />
          </ConfigRow>}
        </Each>
      </ConfigSection>
    </If>
    <If when={conflicts().length > 0}>
      <ConfigSection title={tr("settings.externalImports.runtimeReview.conflicts")} flush>
        <Each of={conflicts()} key={item => `${item.kind}:${item.key}`}>
          {(item, index) => <ConfigRow label={item().name}
            description={`${tr(kindLabels[item().kind])} · ${conflictText(item())}`} wrap topDivider={index() > 0} divider={false}>
            <Button label={tr("settings.externalImports.runtimeReview.review")} size="sm" variant="secondary"
              accessibilityLabel={`external-conflict-review-${item().key}`} disabled={locked()}
              onPress={() => openConflict(item())} />
          </ConfigRow>}
        </Each>
      </ConfigSection>
    </If>
    <If when={selectedReview()}>{review => <ModalDialog open size="lg" title={review().item.name}
      subtitle={tr(kindLabels[review().item.kind])} accessibilityLabel="external-runtime-review-dialog"
      onClose={close} closeOnEscape={!busy()} closeOnBackdropPress={!busy()}
      footer={<>
        <Button label={tr("common.cancel")} variant="secondary" disabled={busy()} onPress={close} />
        <If when={review().kind === "approval"}>
          <Button label={tr("settings.externalImports.runtimeReview.decline")} variant="secondary"
            accessibilityLabel="external-runtime-decline" disabled={!canSubmit()} onPress={() => void submit(false)} />
        </If>
        <Button label={tr(review().kind === "approval" ? "common.allow" : choiceApproves()
          ? "settings.externalImports.runtimeReview.allowAndUse" : "common.confirm")}
          variant="primary" accessibilityLabel="external-runtime-confirm" disabled={!canSubmit()} loading={busy()}
          onPress={() => void submit()} />
      </>}>
      <View style={{ gap: space.md }}>
        <If when={stale() || !canChangeExternalRuntime(review().snapshot)}>
          <InlineBanner tone="warning" message={tr(stale() ? "settings.externalImports.runtimeReview.changed"
            : "settings.externalImports.runtimeReview.readOnly")} />
        </If>
        <If when={(() => { const row = review(); return row.kind === "approval" ? row.item : undefined; })()}>{item => <>
          <InlineBanner tone="warning" message={tr("settings.externalImports.runtimeReview.warning")} />
          <ConfigSection title={tr("common.details")} flush><ReviewDetails rows={item().details} /></ConfigSection>
        </>}</If>
        <If when={(() => { const row = review(); return row.kind === "conflict" ? row.item : undefined; })()}>{conflict => <>
          <ConfigSection title={tr("settings.externalImports.runtimeReview.candidates")} flush>
            <Each of={conflict().candidates} key={option => option.id}>
              {(option, index) => <ConfigRow label={option().name}
                description={option().details.filter(detail => detail.kind === "source" || (!option().available && detail.kind === "reason"))
                  .map(detailText).join(" · ")}
                wrap topDivider={index() > 0} divider={false}>
                <If when={option().id === conflict().selectedId && selectedCandidate() !== option().id}>
                  <Badge label={tr("common.selected")} />
                </If>
                <Button label={tr(!option().available ? "common.unavailable" : selectedCandidate() === option().id
                  ? "settings.externalImports.runtimeReview.chosen" : "settings.externalImports.runtimeReview.choose")}
                  variant={selectedCandidate() === option().id ? "primary" : "secondary"} size="sm"
                  accessibilityLabel={`external-runtime-candidate-${option().id}`}
                  disabled={busy() || !option().available} onPress={() => selectedCandidate.set(option().id)} />
              </ConfigRow>}
            </Each>
            <If when={conflict().kind === "subagent"}>
              <ConfigRow label={tr("settings.externalImports.runtimeReview.disableAll")} topDivider divider={false}>
                <Button label={tr(selectedCandidate() === DISABLED_SUBAGENT_CHOICE
                  ? "settings.externalImports.runtimeReview.chosen" : "settings.externalImports.runtimeReview.choose")}
                  variant={selectedCandidate() === DISABLED_SUBAGENT_CHOICE ? "primary" : "secondary"} size="sm"
                  accessibilityLabel="external-runtime-disable-all" disabled={busy()}
                  onPress={() => selectedCandidate.set(DISABLED_SUBAGENT_CHOICE)} />
              </ConfigRow>
            </If>
          </ConfigSection>
          <If when={candidate()}>{choice => <>
            <If when={choiceApproves()}>
              <InlineBanner tone="warning" message={tr("settings.externalImports.runtimeReview.warning")} />
            </If>
            <If when={choice().details.length > 0}>
              <ConfigSection title={choice().name} flush><ReviewDetails rows={choice().details} /></ConfigSection>
            </If>
          </>}</If>
        </>}</If>
      </View>
    </ModalDialog>}</If>
  </>;
}
