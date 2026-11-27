import { cleanup, computed, effect, signal, Text, View } from "nsh";
import { backendConnection, fleetActive, invokeCommand } from "../bridge";
import { localizeHostError, tr, type MessageKey } from "../i18n";
import { formatCount } from "../format";
import type { PullRequestReviewPhase } from "../pullRequestReviewHistory";
import { reviewPhaseLabel } from "../reviewPresentation";
import { openReviewChild, reviewRefusalText, type ReviewLaunchAnswer, type ReviewTarget } from "../reviewStore";
import { fontMono, palette, space, textStyle } from "../theme";
import { ChoiceCheckbox } from "./ChoiceIndicator";
import { ModalDialog, pushToast, SelectDropdown } from "./overlays";
import { Badge, Button, InlineBanner, InputBox } from "./primitives";

const GROUP_LABELS = {
  must_fix: "chat.review.mustFix",
  should_improve: "chat.review.shouldImprove",
  needs_decision: "chat.review.needsDecision",
  verification: "chat.review.verification",
  findings: "chat.review.findings",
} as const satisfies Record<string, MessageKey>;

interface RemediationItem {
  id: string;
  group: keyof typeof GROUP_LABELS;
  title: string;
  detail?: string;
  path?: string;
  choices?: string[];
  selectedByDefault: boolean;
}

interface RemediationPlan {
  reportRevision: string;
  items: RemediationItem[];
}

interface ApprovedFix {
  requestId: string;
  reportRevision: string;
  selection: Array<{ id: string; choice?: number }>;
  instructions: string;
  childSessionName: string;
  displayMessage: string;
}

const ITEM_STATE = {
  pending: { label: "review.fixPending", tone: "neutral" },
  in_progress: { label: "review.fixDoing", tone: "accent" },
  completed: { label: "review.fixReported", tone: "success" },
} as const;
const RUN_STATE = {
  running: "review.fixRunRunning",
  completed: "review.fixRunFinished",
  failed: "review.fixRunFailed",
  cancelled: "review.fixRunCancelled",
  interrupted: "review.fixRunInterrupted",
  start_unconfirmed: "review.fixRunUnconfirmed",
} as const;

interface FixProgress {
  items: Record<string, keyof typeof ITEM_STATE>;
  latestRun?: { sessionId: string; sessionName: string; state: keyof typeof RUN_STATE };
  running: boolean;
}

interface PostFixSelection {
  fixSessionId: string;
  previousReviewSessionId: string;
}

interface PostFixState {
  selection?: PostFixSelection;
  existing?: { sessionId: string; sessionName: string; agentType: string; phase: PullRequestReviewPhase };
}

interface PostFixPreview {
  selection: PostFixSelection;
  review: ReviewLaunchAnswer;
  workspaceFallback: boolean;
  scopeFingerprint: string;
}

type FixResponse = { status: "prepared"; plan: RemediationPlan; progress?: FixProgress; postFixReview?: PostFixState }
  | { status: "started" | "uncertain"; childSessionId: string; childSessionName: string }
  | { status: "review"; review: ReviewLaunchAnswer; workspaceFallback: boolean; scopeFingerprint?: string };

export function ReviewRemediation(props: { target: ReviewTarget; reportId: string }) {
  const open = signal(false);
  const busy = signal(false);
  const issue = signal("");
  const progress = signal<FixProgress | undefined>(undefined);
  const postFix = signal<PostFixState | undefined>(undefined);
  const reviewPreview = signal<PostFixPreview | null>(null);
  const reviewing = signal(false);
  const refreshing = signal(false);
  const refreshIssue = signal("");
  const prepared = signal<{
    plan: RemediationPlan; target: ReviewTarget; reportId: string; connection: ReturnType<typeof backendConnection>;
  } | null>(null);
  const plan = () => prepared()?.plan ?? null;
  const selected = signal<ReadonlySet<string>>(new Set());
  const decisions = signal<ReadonlyMap<string, number>>(new Map());
  const instructions = signal("");
  const approved = signal<ApprovedFix | null>(null);
  let ticket = 0;
  cleanup(() => { ticket += 1; });

  const sourceKey = () => JSON.stringify([props.target.deviceId, props.target.workspaceId, props.target.sessionId, props.reportId]);
  let source = sourceKey();
  let connection = backendConnection();
  effect(() => {
    const nextSource = sourceKey();
    const nextConnection = backendConnection();
    if (source === nextSource && connection === nextConnection) return;
    source = nextSource;
    connection = nextConnection;
    ticket += 1;
    open.set(false);
    busy.set(false);
    refreshing.set(false);
    reviewing.set(false);
    reviewPreview.set(null);
    prepared.set(null);
  });

  const itemState = (id: string) => progress()?.items[id];
  const completed = (id: string) => itemState(id) === "completed";
  const itemStatus = (id: string) => {
    const state = itemState(id);
    return state ? ITEM_STATE[state] : undefined;
  };
  const changes = computed(() => (plan()?.items ?? []).filter(item => selected().has(item.id) && !completed(item.id)));
  const needsChoice = () => changes().some(item => item.choices?.length && !decisions().has(item.id));
  const running = () => progress()?.running === true;
  const locked = () => busy() || reviewing() || !!reviewPreview() || running() || approved() !== null;
  const savedReview = () => postFix()?.existing;
  const liveProgress = computed(() => open() && (running() || savedReview()?.phase === "running" || savedReview()?.phase === "pending"));
  const activeRun = () => progress()?.latestRun;
  effect(() => {
    if (!liveProgress()) return;
    const timer = setInterval(() => void refreshProgress(), 3000);
    return () => clearInterval(timer);
  });
  function route(target: ReviewTarget) {
    return fleetActive() && target.deviceId ? { target: target.deviceId } : undefined;
  }
  function requestOf(target: ReviewTarget, reportId: string) {
    return { workspaceId: target.workspaceId, sessionId: target.sessionId, reportToolId: reportId };
  }
  function close(): void {
    if (busy() || reviewing()) return;
    open.set(false);
    refreshing.set(false);
    ticket += 1;
  }
  async function prepare(): Promise<void> {
    const target = props.target;
    const reportId = props.reportId;
    const version = ++ticket;
    const initiatingConnection = backendConnection();
    open.set(true);
    issue.set("");
    busy.set(true);
    prepared.set(null);
    progress.set(undefined);
    postFix.set(undefined);
    reviewPreview.set(null);
    refreshing.set(false);
    refreshIssue.set("");
    approved.set(null);
    decisions.set(new Map());
    instructions.set("");
    try {
      const response = await invokeCommand<FixResponse>("launch_review_remediation", requestOf(target, reportId), route(target));
      if (ticket !== version || backendConnection() !== initiatingConnection) return;
      if (response.status !== "prepared" || !response.plan?.items.length) throw new Error(tr("review.fixUnavailable"));
      const ready = response.plan;
      progress.set(response.progress);
      postFix.set(response.postFixReview);
      selected.set(new Set(ready.items.filter(item => !completed(item.id)
        && (item.selectedByDefault || response.progress?.items[item.id] === "pending")).map(item => item.id)));
      prepared.set({ plan: ready, target, reportId, connection: initiatingConnection });
    } catch (error) {
      if (ticket === version) issue.set(localizeHostError(error));
    } finally {
      if (ticket === version) busy.set(false);
    }
  }
  async function refreshProgress(): Promise<void> {
    const ready = prepared();
    if (!open() || !ready || refreshing() || busy() || reviewing() || ready.connection !== backendConnection()) return;
    const version = ticket;
    refreshing.set(true);
    refreshIssue.set("");
    const isCurrent = () => ticket === version && backendConnection() === ready.connection;
    try {
      const response = await invokeCommand<FixResponse>("launch_review_remediation",
        requestOf(ready.target, ready.reportId), route(ready.target));
      if (!isCurrent()) return;
      if (response.status !== "prepared" || response.plan.reportRevision !== ready.plan.reportRevision) {
        throw new Error(tr("review.fixUnavailable"));
      }
      progress.set(response.progress);
      postFix.set(response.postFixReview);
      if (!approved()) selected.set(new Set([...selected()].filter(id => !completed(id))));
    } catch (error) {
      if (isCurrent()) refreshIssue.set(localizeHostError(error));
    } finally {
      if (isCurrent()) refreshing.set(false);
    }
  }

  function openFixSession(run: NonNullable<FixProgress["latestRun"]>) {
    const ready = prepared();
    if (!ready || ready.connection !== backendConnection()) return;
    close();
    openReviewChild({ childSessionId: run.sessionId, childSessionName: run.sessionName,
      agentType: "ReviewFixer" }, "review", ready.target);
  }

  async function start(): Promise<void> {
    const ready = prepared();
    if (!ready || busy() || reviewing() || reviewPreview() || refreshing() || ready.connection !== backendConnection()) return;
    if (!approved() && (running() || !changes().length || needsChoice())) return;
    const { target, reportId } = ready;
    const version = ++ticket;
    issue.set("");
    busy.set(true);
    try {
      const confirmation = approved() ?? {
        requestId: crypto.randomUUID(),
        reportRevision: ready.plan.reportRevision,
        selection: changes().map(item => ({ id: item.id, choice: decisions().get(item.id) })),
        instructions: instructions(),
        childSessionName: tr("review.fixSession"),
        displayMessage: tr("review.fixDisplay"),
      };
      approved.set(confirmation);
      const response = await invokeCommand<FixResponse>("launch_review_remediation",
        { ...requestOf(target, reportId), approved: confirmation }, route(target));
      if (ticket !== version || backendConnection() !== ready.connection) return;
      if (response.status !== "started" && response.status !== "uncertain") throw new Error(tr("review.fixUnavailable"));
      open.set(false);
      if (response.status === "uncertain") pushToast(tr("review.fixUncertain"), "warning");
      openReviewChild({ childSessionId: response.childSessionId, childSessionName: response.childSessionName,
        agentType: "ReviewFixer" }, "review", target);
    } catch (error) {
      if (ticket === version) issue.set(localizeHostError(error));
    } finally {
      if (ticket === version) busy.set(false);
    }
  }
  function openSavedReview(run: NonNullable<PostFixState["existing"]>) {
    const ready = prepared();
    if (!ready || ready.connection !== backendConnection()) return;
    close();
    openReviewChild({ childSessionId: run.sessionId, childSessionName: run.sessionName,
      agentType: run.agentType }, "review", ready.target);
  }

  async function reviewFixes(): Promise<void> {
    const ready = prepared();
    const preview = reviewPreview();
    const selection = preview?.selection ?? postFix()?.selection;
    if (!ready || !selection || busy() || reviewing() || refreshing() || approved() || ready.connection !== backendConnection()) return;
    const version = ++ticket;
    const isCurrent = () => ticket === version && backendConnection() === ready.connection;
    const request = (scopeFingerprint?: string) => invokeCommand<FixResponse>("launch_review_remediation", {
      ...requestOf(ready.target, ready.reportId), reviewFixes: {
        ...selection, reportRevision: ready.plan.reportRevision, scopeFingerprint,
        childSessionName: tr("review.postFixTitle"), displayMessage: tr("review.postFixAction"),
      },
    }, route(ready.target));
    issue.set("");
    reviewing.set(true);
    try {
      let response = await request(preview?.scopeFingerprint);
      if (!isCurrent()) return;
      if (response.status === "review" && response.review.status === "prepared" && response.scopeFingerprint) {
        if (response.workspaceFallback) {
          reviewPreview.set({ selection, review: response.review, workspaceFallback: response.workspaceFallback,
            scopeFingerprint: response.scopeFingerprint });
          return;
        }
        response = await request(response.scopeFingerprint);
        if (!isCurrent()) return;
      }
      if (response.status !== "review") throw new Error(tr("review.fixUnavailable"));
      const { review } = response;
      if (review.status === "refused") {
        reviewPreview.set(null);
        issue.set(reviewRefusalText(review));
        return;
      }
      if (!review.childSessionId) throw new Error(tr("review.fixUnavailable"));
      open.set(false);
      if (review.status === "uncertain") pushToast(tr("review.uncertain"), "warning");
      openReviewChild(review, review.intent, ready.target);
    } catch (error) {
      if (isCurrent()) issue.set(localizeHostError(error));
    } finally {
      if (isCurrent()) reviewing.set(false);
    }
  }

  return <>
    <Button label={tr("review.fixFindings")} leadingIcon="edit" size="sm" variant="secondary"
      accessibilityLabel="review-select-fixes" onPress={() => void prepare()} />
    <ModalDialog open={open()} title={tr("review.fixFindings")} subtitle={tr("review.fixScope")}
      size="lg" accessibilityLabel="review-remediation" keepOpenOnBackdrop onClose={close}
      footer={<View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
        <Button label={tr("common.cancel")} variant="secondary" disabled={busy() || reviewing()} onPress={close} />
        <If when={!reviewPreview() && plan()}>
          <Button label={tr(approved() ? "common.retry" : "review.fixStart")} variant="primary"
            accessibilityLabel="review-start-fixes" disabled={refreshing() || reviewing() || (!approved() && (running() || !changes().length || needsChoice()))}
            loading={busy()} onPress={() => void start()} />
        </If>
        <If when={reviewPreview()}>{preview =>
          <Button label={tr(preview().workspaceFallback ? "review.recordWorkspace" : "review.postFixAction")}
            variant="primary" accessibilityLabel="review-confirm-follow-up" disabled={refreshing()}
            loading={reviewing()} onPress={() => void reviewFixes()} />
        }</If>
      </View>}>
      <View style={{ gap: space.md }}>
        <If when={busy() && !plan()}><Text style={textStyle("caption")}>{tr("common.loading")}</Text></If>

        <If when={issue()}>{message => <InlineBanner tone="warning" message={message()} />}</If>
        <If when={refreshIssue()}>{message => <InlineBanner tone="warning" message={message()} />}</If>
        <If when={activeRun()}>
          {run => <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
            <Badge label={tr(RUN_STATE[run().state] ?? "review.fixRunUnconfirmed")}
              tone={run().state === "running" ? "accent" : "neutral"} accessibilityLabel="review-fix-run-state" />
            <Button label={tr("review.fixOpenSession")} leadingIcon="external-link" size="sm" variant="secondary"
              accessibilityLabel="review-fix-open-session" disabled={busy() || reviewing()} onPress={() => openFixSession(run())} />
            <Button label={tr("review.fixRefresh")} leadingIcon="refresh" size="sm" variant="ghost"
              accessibilityLabel="review-fix-refresh" loading={refreshing()} disabled={busy() || reviewing()}
              onPress={() => void refreshProgress()} />
          </View>}
        </If>
        <If when={savedReview()}>{run =>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
            <Button label={tr("review.postFixOpen")} leadingIcon="external-link" size="sm" variant="secondary"
              accessibilityLabel="review-open-follow-up" disabled={busy() || reviewing()} onPress={() => openSavedReview(run())} />
            <Badge label={reviewPhaseLabel(run().phase)} tone={run().phase === "running" ? "accent" : "neutral"} />
          </View>
        }</If>
        <If when={reviewPreview()}>{preview =>
          <View style={{ gap: space.sm }}>
            <If when={preview().workspaceFallback}>
              <InlineBanner tone="warning" message={tr("review.postFixFallback")} />
            </If>
            <If when={preview().review.intent === "strict"}>
              <Text style={textStyle("caption")}>{tr("review.intentStrictHint")}</Text>
            </If>
            <Text style={textStyle("caption")}>{tr(preview().review.fileCount === 1 ? "review.fileOne" : "review.fileOther",
              { count: formatCount(preview().review.fileCount) })}</Text>
          </View>
        }</If>
        <If when={postFix()?.selection && !reviewPreview()}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Button label={tr(savedReview() ? "review.postFixRetry" : "review.postFixAction")}
              leadingIcon="search" size="sm" variant="secondary" accessibilityLabel="review-start-follow-up"
              disabled={busy() || refreshing() || !!approved()} loading={reviewing()} onPress={() => void reviewFixes()} />
          </View>
        </If>
        <If when={plan()}>{ready => <>
          <Each of={Object.entries(GROUP_LABELS)} key={entry => entry[0]}>
            {entry => {
              const items = () => ready().items.filter(item => item.group === entry()[0]);
              return <If when={items().length}>
                <View style={{ gap: space.sm }}>
                  <Text style={textStyle("label")}>{tr(entry()[1])}</Text>
                  <Each of={items()} key={item => item.id}>
                    {item => <View style={{ gap: space.xs }}>
                      <ChoiceCheckbox checked={selected().has(item().id)} disabled={locked() || completed(item().id)}
                        accessibilityLabel={item().title} testID={`review-fix-item-${item().id}`}
                        onChange={checked => {
                          const next = new Set(selected());
                          if (checked) next.add(item().id);
                          else next.delete(item().id);
                          selected.set(next);
                        }}>
                        <View style={{ flex: 1, minWidth: 0, gap: space.xs, paddingVertical: space.xs }}>
                          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
                            <Text style={textStyle("body")}>{item().title}</Text>
                            <If when={itemStatus(item().id)}>
                              {state => <Badge label={tr(state().label)} tone={state().tone}
                                accessibilityLabel={`review-fix-progress-${item().id}`} />}
                            </If>
                          </View>
                          <If when={item().path}>
                            {path => <Text style={{ ...textStyle("caption"), fontFamily: fontMono() }}>{path()}</Text>}
                          </If>
                        </View>
                      </ChoiceCheckbox>
                      <If when={item().detail}>{detail => <Text style={textStyle("caption")}>{detail()}</Text>}</If>
                      <If when={selected().has(item().id) && item().choices?.length}>
                        <SelectDropdown value={decisions().get(item().id)?.toString() ?? ""}
                          placeholder={tr("review.fixChooseDecision")} disabled={locked()}
                          accessibilityLabel={`review-fix-decision-${item().id}`}
                          options={(item().choices ?? []).map((label, index) => ({
                            value: String(index), label, accessibilityLabel: label,
                          }))}
                          onChange={value => decisions.set(new Map(decisions()).set(item().id, Number(value)))} />
                      </If>
                    </View>}
                  </Each>
                </View>
              </If>;
            }}
          </Each>
          <InputBox multiline label={tr("review.fixInstructions")} accessibilityLabel="review-fix-instructions"
            value={instructions()} readonly={locked()} onChange={instructions.set} />
        </>}</If>
        <If when={needsChoice()}>
          <Text style={{ ...textStyle("caption"), color: palette().textSecondary }}>{tr("review.fixChooseDecision")}</Text>
        </If>
      </View>
    </ModalDialog>
  </>;
}
