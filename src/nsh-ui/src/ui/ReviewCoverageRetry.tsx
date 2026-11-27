import { cleanup, effect, signal, Text, View } from "nsh";
import { backendConnection, fleetActive, invokeCommand } from "../bridge";
import { formatCount, formatPlural } from "../format";
import { localizeHostError, tr } from "../i18n";
import {
  gitRangeReviewLabel, openReviewChild, reviewRefusalText,
  type ReviewLaunchAnswer, type ReviewLaunchFile, type ReviewTarget,
} from "../reviewStore";
import { fontMono, space, textStyle } from "../theme";
import { ModalDialog, pushToast } from "./overlays";
import { Button, InlineBanner } from "./primitives";

interface ScopePreview {
  fingerprint: string;
  files: ReviewLaunchFile[];
  range?: ReviewLaunchAnswer["gitRange"];
  limited: boolean;
  planLimit?: { planned: number; deferred: number };
}

export function ReviewCoverageRetry(props: { target: ReviewTarget; reportId: string }) {
  const open = signal(false);
  const preview = signal<ScopePreview | null>(null);
  const issue = signal("");
  const busy = signal(false);
  let generation = 0;
  cleanup(() => { generation += 1; });
  const source = () => JSON.stringify([
    props.target.deviceId, props.target.workspaceId, props.target.sessionId, props.reportId,
  ]);
  effect(() => {
    source();
    backendConnection();
    generation += 1;
    open.set(false);
    preview.set(null);
    busy.set(false);
  });

  async function request(approved?: ScopePreview): Promise<void> {
    const target = props.target;
    if (busy() || !target.workspaceId || (fleetActive() && !target.deviceId)) return;
    const ticket = ++generation;
    const sourceKey = source();
    const connection = backendConnection();
    const isCurrent = () => generation === ticket && sourceKey === source() && connection === backendConnection();
    const title = tr("review.retry.title");
    issue.set("");
    busy.set(true);
    try {
      const answer = await invokeCommand<ReviewLaunchAnswer>("launch_review", {
        parentSessionId: target.sessionId,
        workspaceId: target.workspaceId,
        intent: "retry_incomplete",
        dryRun: !approved,
        retryCoverage: { reportToolId: props.reportId, ...(approved ? { scopeFingerprint: approved.fingerprint } : {}) },
        childSessionName: title,
        displayMessage: title,
      }, target.deviceId ? { target: target.deviceId } : undefined);
      if (!isCurrent()) return;
      if (answer.status === "refused") {
        preview.set(null);
        issue.set(reviewRefusalText(answer));
        return;
      }
      if (!approved && answer.status === "prepared" && answer.scopeFingerprint && answer.files?.length &&
          answer.fileCount === answer.files.length && answer.files.every(file => typeof file.path === "string" && file.path)) {
        const planLimit = answer.deferredFileCount && typeof answer.plannedFileCount === "number"
          ? { planned: answer.plannedFileCount, deferred: answer.deferredFileCount } : undefined;
        preview.set({ fingerprint: answer.scopeFingerprint, files: answer.files, range: answer.gitRange,
          limited: answer.completeness !== "complete", planLimit });
        return;
      }
      if (approved && (answer.status === "started" || answer.status === "uncertain") && answer.childSessionId) {
        open.set(false);
        if (answer.status === "uncertain") pushToast(tr("review.uncertain"), "warning");
        openReviewChild(answer, answer.intent, target);
        return;
      }
      preview.set(null);
      issue.set(tr("review.retry.unavailable"));
    } catch (error) {
      if (isCurrent()) {
        const reason = localizeHostError(error);
        issue.set(reason.includes("Unknown Review intent: retry_incomplete") ? tr("review.retry.unavailable") : reason);
      }
    } finally {
      if (generation === ticket) busy.set(false);
    }
  }

  function close(): void {
    if (!busy()) open.set(false);
  }

  return <>
    <Button label={tr("review.retry.title")} leadingIcon="history" variant="secondary" size="sm"
      accessibilityLabel="review-open-coverage-retry" onPress={() => {
        preview.set(null);
        open.set(true);
        void request();
      }} />
    <ModalDialog open={open()} title={tr("review.retry.title")} accessibilityLabel="review-coverage-retry"
      keepOpenOnBackdrop onClose={close} footer={
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm }}>
          <Button label={tr("common.cancel")} variant="secondary" disabled={busy()} onPress={close} />
          <If when={preview()} else={
            <Button label={tr("common.retry")} variant="secondary" loading={busy()}
              accessibilityLabel="review-reload-retry-scope" onPress={() => void request()} />
          }>
            {approved => <Button label={tr("review.start")} variant="primary" loading={busy()}
              accessibilityLabel="review-confirm-coverage-retry" onPress={() => void request(approved())} />}
          </If>
        </View>
      }>
      <View style={{ gap: space.sm }}>
        <If when={issue()}>{message => <InlineBanner tone="warning" message={message()} />}</If>
        <If when={preview()}>{scope => <>
          <If when={scope().range} else={<Text style={textStyle("body")}>{tr("review.retry.currentWorkspace")}</Text>}>
            {range => <Text style={textStyle("body")}>{gitRangeReviewLabel(range())}</Text>}
          </If>
          <Text style={textStyle("label")}>{formatPlural(scope().files.length, "review.fileOne", "review.fileOther")}</Text>
          <If when={scope().limited}><InlineBanner tone="info" message={tr("review.partialEvidence")} /></If>
          <If when={scope().planLimit}>{limit => <Text style={textStyle("caption")}>
            {tr("review.intentManagedLimitedHint", { planned: formatCount(limit().planned), deferred: formatCount(limit().deferred) })}
          </Text>}</If>
          <Each of={scope().files} key={file => file.path}>
            {file => <Text style={{ ...textStyle("caption"), fontFamily: fontMono(), userSelect: "text" }}>{file().path}</Text>}
          </Each>
        </>}</If>
      </View>
    </ModalDialog>
  </>;
}
