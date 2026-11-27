import { cleanup, computed, effect, openUrl, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import { DiffView } from "nsh/base";
import { entryDeviceId, fleetActive, invokeCommand, transportKind } from "../bridge";
import { fleetDeviceById } from "../fleetStore";
import { formatCount, formatTimestamp } from "../format";
import { isCommandUnavailable } from "../hostCommands";
import { localizeHostError, tr, type MessageKey } from "../i18n";
import { pullRequestDraftToken, type PullRequestSection } from "../pullRequestReference";
import {
  usePullRequestReviewHistory, type PullRequestReviewHistoryTarget, type PullRequestReviewRun,
} from "../pullRequestReviewHistory";
import { reviewOutcomeDescription, reviewRunSummary } from "../reviewPresentation";
import { handleReviewLaunch, openReviewChild, type ReviewLaunchAnswer, type ReviewTarget } from "../reviewStore";
import {
  createPullRequestContext, resolvePullRequestInput, reviewAuthProvider, reviewCheckContext, reviewCheckStatus, reviewFileContext, reviewSectionContext,
  reviewThreadLocation, type ReviewPlatformCheck, type ReviewPlatformDetail, type ReviewPlatformDetailSection,
  type ReviewPlatformFile, type ReviewPlatformListState, type ReviewPlatformLog, type ReviewPlatformPullRequest,
  type ReviewPlatformSnapshot,
} from "../reviewPlatform";
import { isRemoteWorkspace } from "../shared/workspaceUtils";
import { secondaryComposerText, selectSecondarySession } from "../splitSessionStore";
import {
  activeSession, activeSessionDevice, activeSessionId, activeWorkspace, composerText, deviceContext, focusedPane,
  navigateScene, secondarySessionDevice, secondarySessionId, secondaryWorkspaceId, splitPaneOpen,
} from "../state";
import { compactLayout, fontMono, palette, radii, space, textStyle } from "../theme";
import { ActionCard } from "../ui/ActionCard";
import { createDiffViewStyles } from "../ui/markdown";
import { MarkdownPreview } from "../ui/markdownEditor";
import { Spinner } from "../ui/motion";
import { pushToast } from "../ui/overlays";
import { Button, EmptyStateCard, IconButton, InlineBanner, InputBox } from "../ui/primitives";
import { TabGroup } from "../ui/TabGroup";
import { Toolbar } from "../ui/Toolbar";
import { ReviewPlatformAuthDialog, type ReviewPlatformAuthTarget } from "./ReviewPlatformAuthDialog";

const SNAPSHOT = "review_platform_get_workspace_snapshot";
const DETAIL = "review_platform_get_pull_request_detail_page";
const CI_LOG = "review_platform_get_pull_request_ci_log";
const LAUNCH_REVIEW = "review_platform_launch_pull_request_review";
const REVIEW_LAUNCH_CAPABILITY = "pull_request_review_launch_v1";
const REVIEW_HISTORY_CAPABILITY = "pull_request_review_history_v1";

const STATES: Record<ReviewPlatformListState, MessageKey> = {
  all: "pullRequests.all", open: "pullRequests.open", draft: "pullRequests.draft",
  merged: "pullRequests.merged", closed: "pullRequests.closed",
};

const SECTIONS: Record<ReviewPlatformDetailSection, MessageKey> = {
  overview: "pullRequests.overview", files: "pullRequests.files", ci: "pullRequests.checks",
  commits: "pullRequests.commits", reviews: "pullRequests.comments",
};

function canReviewAgain(run: PullRequestReviewRun): boolean {
  return run.latestForRecord === true && run.recordHistoryComplete === true && Boolean(run.parentSessionId)
    && ["completed", "failed", "stopped", "interrupted"].includes(run.phase);
}

interface WorkspaceScope {
  request: { workspaceId: string; repositoryPath: string };
  deviceId: string;
  connectionId?: string;
  remoteWorkspace: boolean;
}

interface SelectedPullRequest {
  remoteId: string;
  id: string;
}

function reviewError(error: unknown, command: string): string {
  return isCommandUnavailable(error, command) ? tr("pullRequests.hostUnsupported") : localizeHostError(error);
}

function openReviewUrl(value: string, base?: string): void {
  try {
    const url = new URL(value, base || undefined);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    void openUrl(url.href).catch(error => pushToast(localizeHostError(error), "error"));
  } catch {
    // A relative or malformed provider link has no external destination.
  }
}

function chatTarget() {
  const split = splitPaneOpen() && focusedPane() === 1;
  const session = split ? secondarySessionId() : activeSessionId();
  const workspace = split ? secondaryWorkspaceId() : activeSession()?.workspaceId;
  const device = split ? secondarySessionDevice() : activeSessionDevice();
  return { split, session, workspace, device, key: JSON.stringify([split, session, workspace, device]) };
}

function appendToChat(scope: WorkspaceScope, token: string, label: string): void {
  const { split, session, workspace, device } = chatTarget();
  if (!session || workspace !== scope.request.workspaceId || (fleetActive() && device !== scope.deviceId)) {
    pushToast(tr("pullRequests.sessionRequired"), "warning");
    return;
  }
  (split ? secondaryComposerText : composerText).update(text => text + (text && !/\s$/.test(text) ? " " : "") + token + " ");
  navigateScene("sessions");
  pushToast(tr("files.addedToChat", { name: label }), "success");
}

function PageButtons(props: { page: number; next: boolean; busy: boolean; onPage: (page: number) => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs }}>
      <Button size="sm" variant="ghost" label={tr("pullRequests.previous")} disabled={props.page <= 1 || props.busy}
        onPress={() => props.onPage(props.page - 1)} />
      <Text style={textStyle("caption")}>{tr("pullRequests.page", { page: formatCount(props.page) })}</Text>
      <Button size="sm" variant="ghost" label={tr("pullRequests.next")} disabled={!props.next || props.busy}
        onPress={() => props.onPage(props.page + 1)} />
    </View>
  );
}

function ReviewSectionCard(props: { title: string; detail?: string; actions?: JSX.Element; children?: JSX.Element }) {
  return (
    <View style={{ padding: space.md, gap: space.sm, borderWidth: 1, borderRadius: radii.md,
      borderColor: palette().borderSubtle, backgroundColor: palette().panelRaised }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
          <Text style={textStyle("label")}>{props.title}</Text>
          <If when={props.detail}>
            {value => <Text style={textStyle("caption", { color: palette().textSecondary })}>{value()}</Text>}
          </If>
        </View>
        {props.actions}
      </View>
      {props.children}
    </View>
  );
}

function AddToChat(props: { testID: string; onPress: () => void; disabled?: boolean }) {
  return <IconButton icon="chat" size="sm" tooltip={tr("pullRequests.addToChat")}
    accessibilityLabel={props.testID} disabled={props.disabled} onPress={props.onPress} />;
}

function ReviewFileCard(props: { file: ReviewPlatformFile; onAdd: () => void }) {
  const expanded = signal(false);
  return (
    <ReviewSectionCard title={props.file.path}
      detail={`${props.file.status} · +${formatCount(props.file.additions)} −${formatCount(props.file.deletions)}`}
      actions={<>
        <If when={Boolean(props.file.patch)}>
          <IconButton icon="file-code" size="sm" active={expanded()} tooltip={tr("pullRequests.diff")}
            accessibilityLabel={`pr-show-diff-${props.file.path}`} onPress={() => expanded.update(value => !value)} />
        </If>
        <AddToChat testID={`pr-add-file-${props.file.path}`} onPress={props.onAdd} />
      </>}>
      <If when={expanded() ? props.file.patch : null}>
        {patch => <DiffView patch={patch()} language="text" layout="unified" lineNumbers={true} indicators="bars"
          fontFamily={fontMono()} styles={createDiffViewStyles()}
          style={{ minWidth: 0, height: Math.min(360, Math.max(90, patch().split("\n").length * 17)) }} />}
      </If>
    </ReviewSectionCard>
  );
}

function ReviewCheckCard(props: {
  check: ReviewPlatformCheck;
  loadLog: (check: ReviewPlatformCheck) => Promise<ReviewPlatformLog>;
  onAdd: (log: ReviewPlatformLog | undefined, chatKey: string) => void;
}) {
  const result = signal<ReviewPlatformLog | undefined>(undefined);
  const error = signal("");
  const busy = signal(false);
  const expanded = signal(false);
  let closed = false;
  cleanup(() => { closed = true; });

  async function log(): Promise<ReviewPlatformLog | undefined> {
    const loaded = result();
    if (loaded) return loaded;
    const item = props.check;
    if (item.log) {
      const inline = { log: item.log, truncated: item.logTruncated ?? false };
      result.set(inline);
      return inline;
    }
    if (busy()) return;
    busy.set(true);
    error.set("");
    try {
      const reply = await props.loadLog(item);
      if (!closed) result.set(reply);
      return reply;
    } catch (reason) {
      if (!closed) error.set(reviewError(reason, CI_LOG));
    } finally {
      if (!closed) busy.set(false);
    }
  }

  return (
    <ReviewSectionCard title={props.check.name}
      detail={[reviewCheckStatus(props.check), props.check.stage, props.check.detail].filter(Boolean).join(" · ")}
      actions={<>
        <IconButton icon="terminal" size="sm" active={expanded()} tooltip={tr("pullRequests.log")}
          accessibilityLabel={`pr-check-log-${props.check.id}`} disabled={busy()}
          onPress={() => { expanded.update(value => !value); if (expanded()) void log(); }} />
        <AddToChat testID={`pr-add-check-${props.check.id}`} disabled={busy()} onPress={() => {
          const { key } = chatTarget();
          void log().then(reply => {
            if (!closed && !error()) props.onAdd(reply, key);
            else if (!closed) expanded.set(true);
          });
        }} />
      </>}>
      <If when={expanded()}>
        <If when={busy()}><Spinner size={16} /></If>
        <If when={error()}>
          <InlineBanner tone="warning" message={error()} actionLabel={tr("common.retry")} onAction={() => void log()} />
        </If>
        <If when={result()}>
          {output => <>
            <If when={output().log} else={<Text style={textStyle("caption")}>{output().message || tr("pullRequests.noLog")}</Text>}>
              {value => <Scroll style={{ maxHeight: 240 }}>
                <Text style={{ ...textStyle("monoBlock"), userSelect: "text" }}>{value()}</Text>
              </Scroll>}
            </If>
            <If when={output().truncated}><Text style={textStyle("caption")}>{tr("pullRequests.logTruncated")}</Text></If>
          </>}
        </If>
      </If>
    </ReviewSectionCard>
  );
}

export function ReviewPlatformView(props: { compact: boolean }) {
  const scope = computed<WorkspaceScope | null>(() => {
    const workspace = activeWorkspace();
    return workspace ? {
      request: { workspaceId: workspace.id, repositoryPath: workspace.rootPath },
      deviceId: deviceContext(), connectionId: workspace.connectionId, remoteWorkspace: isRemoteWorkspace(workspace),
    } : null;
  });
  const scopeKey = () => {
    const value = scope();
    return value ? JSON.stringify([value.deviceId, value.request.workspaceId, value.request.repositoryPath, value.connectionId]) : "";
  };
  const snapshot = signal<ReviewPlatformSnapshot | null>(null);
  const state = signal<ReviewPlatformListState>("all");
  const remote = signal<string | null>(null);
  const listPage = signal(1);
  const listBusy = signal(false);
  const listError = signal("");
  const lookup = signal("");
  const lookupError = signal(false);
  const selected = signal<SelectedPullRequest | null>(null);
  const section = signal<ReviewPlatformDetailSection>("overview");
  const detail = signal<ReviewPlatformDetail | null>(null);
  const detailPage = signal(1);
  const detailBusy = signal(false);
  const detailError = signal("");
  const authentication = signal<{ scopeKey: string; target: ReviewPlatformAuthTarget } | null>(null);
  const reviewPending = signal<{ previousSessionId?: string } | null>(null);
  const reviewFeedback = signal<{ key: string; message: string; refresh?: boolean } | null>(null);
  const selectedRepository = () =>
    snapshot()?.remotes.find(value => value.id === selected()?.remoteId && value.supported);
  const historyTarget = computed<PullRequestReviewHistoryTarget | null>(() => {
    const workspace = scope();
    const pr = detail();
    const repository = selectedRepository();
    const platform = reviewAuthProvider(repository?.platform);
    if (!pr || !workspace || !platform || !repository?.host || !repository.projectPath ||
        !supportsReviewCapability(workspace.deviceId, REVIEW_HISTORY_CAPABILITY)) return null;
    return {
      workspaceId: workspace.request.workspaceId, deviceId: workspace.deviceId,
      selection: { platform, host: repository.host, projectPath: repository.projectPath,
        pullRequestId: pr.id, baseRevision: pr.baseRevision, headRevision: pr.headRevision },
    };
  });
  const history = usePullRequestReviewHistory(historyTarget);
  let listTicket = 0;
  let detailTicket = 0;
  let disposed = false;
  let reviewAttempt: { key: string; id: string } | null = null;
  cleanup(() => { disposed = true; ++listTicket; ++detailTicket; });

  function clearDetail(): void {
    ++detailTicket;
    selected.set(null);
    detail.set(null);
    detailBusy.set(false);
    detailError.set("");
  }

  async function loadList(page = 1): Promise<void> {
    const target = scope();
    if (!target) return;
    const key = scopeKey();
    const ticket = ++listTicket;
    listPage.set(page);
    listBusy.set(true);
    listError.set("");
    clearDetail();
    const current = () => key === scopeKey() && ticket === listTicket;
    try {
      const response = await invokeCommand<ReviewPlatformSnapshot>(SNAPSHOT, {
        ...target.request, remoteId: remote(), state: state(), page, perPage: 20,
      }, { target: target.deviceId });
      if (!current()) return;
      snapshot.set(response);
    } catch (error) {
      if (current()) listError.set(reviewError(error, SNAPSHOT));
    } finally {
      if (current()) listBusy.set(false);
    }
  }

  async function loadDetail(next: ReviewPlatformDetailSection, page = 1): Promise<void> {
    const target = scope();
    const item = selected();
    if (!target || !item) return;
    const key = scopeKey();
    const ticket = ++detailTicket;
    section.set(next);
    detailPage.set(page);
    detailBusy.set(true);
    detailError.set("");
    detail.set(null);
    const current = () => key === scopeKey() && ticket === detailTicket;
    try {
      const response = await invokeCommand<ReviewPlatformDetail>(DETAIL, {
        ...target.request, remoteId: item.remoteId, pullRequestId: item.id, section: next, page, perPage: 20,
      }, { target: target.deviceId });
      if (current()) detail.set(response);
    } catch (error) {
      if (current()) detailError.set(reviewError(error, DETAIL));
    } finally {
      if (current()) detailBusy.set(false);
    }
  }

  effect(() => {
    const key = scopeKey();
    untracked(() => {
      snapshot.set(null);
      remote.set(null);
      state.set("all");
      lookup.set("");
      lookupError.set(false);
      authentication.set(null);
      if (key) void loadList();
    });
  });

  function select(pr: ReviewPlatformPullRequest): void {
    const remoteId = pr.providerId ?? snapshot()?.selectedRemoteId;
    if (!remoteId) return;
    selected.set({ id: pr.id, remoteId });
    void loadDetail("overview");
  }

  function openFromInput(): void {
    if (listBusy() || !lookup().trim()) return;
    const data = snapshot();
    const match = data && resolvePullRequestInput(lookup(), data.remotes, remote() ?? data.selectedRemoteId);
    lookupError.set(!match);
    if (!match) return;
    selected.set(match);
    void loadDetail("overview");
  }

  const authTarget = computed<ReviewPlatformAuthTarget | null>(() => {
    const data = snapshot();
    const workspace = scope();
    const remoteId = selected()?.remoteId ?? remote() ?? data?.selectedRemoteId;
    const selectedRemote = data?.remotes.find(item => item.id === remoteId && item.supported);
    const platform = reviewAuthProvider(selectedRemote?.platform);
    if (!platform || !selectedRemote?.host || !workspace || (fleetActive() && !workspace.deviceId)) return null;
    const challenge = data?.authChallenge?.remoteId === remoteId ? data?.authChallenge : null;
    return {
      platform, host: selectedRemote.host, projectPath: selectedRemote.projectPath,
      authSource: selectedRemote.authSource, authState: challenge?.state ?? selectedRemote.authState,
      requiredScopes: challenge?.requiredScopes,
      workspaceId: workspace.request.workspaceId, rootPath: workspace.request.repositoryPath,
      deviceId: workspace.deviceId, connectionId: workspace.connectionId, remoteWorkspace: workspace.remoteWorkspace,
    };
  });

  function openAuthentication(): void {
    const target = authTarget();
    if (target && !listBusy()) authentication.set({ scopeKey: scopeKey(), target });
  }

  async function refreshReviewPanel(): Promise<void> {
    const previous = selected();
    const tab = section();
    const page = detailPage();
    const pending = loadList(listPage());
    const ticket = listTicket;
    await pending;
    if (previous && ticket === listTicket && !selected() && !listError()) {
      selected.set(previous);
      void loadDetail(tab, page);
    }
  }

  function AuthButton(props: { label: string }) {
    return <If when={authTarget()}>
      <IconButton icon="key" size="sm" tooltip={tr("pullRequests.auth.manage")} accessibilityLabel={props.label}
        disabled={listBusy()} onPress={openAuthentication} />
    </If>;
  }

  async function loadLog(check: ReviewPlatformCheck): Promise<ReviewPlatformLog> {
    const target = scope();
    const item = selected();
    if (!target || !item) throw new Error(tr("pullRequests.noSelection"));
    return invokeCommand<ReviewPlatformLog>(CI_LOG, {
      ...target.request, remoteId: item.remoteId, pullRequestId: item.id,
      ciItemId: check.id, ciItemName: check.name,
    }, { target: target.deviceId });
  }

  function add(pr: ReviewPlatformDetail, kind: PullRequestSection, label: string, content: string,
    metadata?: Record<string, unknown>, expectedChat?: string): void {
    const target = scope();
    const item = selected();
    if (!target || !item || detail() !== pr) return;
    if (expectedChat && expectedChat !== chatTarget().key) {
      pushToast(tr("pullRequests.sessionChanged"), "warning");
      return;
    }
    const repository = snapshot()?.remotes.find(value => value.id === item.remoteId)?.projectPath ?? snapshot()?.repository?.projectPath;
    const context = createPullRequestContext(pr, item.remoteId, repository, kind, label, content, metadata);
    appendToChat(target, pullRequestDraftToken(context), label);
  }

  const reviewKey = () => JSON.stringify([scopeKey(), selected()?.remoteId, selected()?.id, chatTarget().key]);
  const currentReviewFeedback = () => {
    const feedback = reviewFeedback();
    return feedback?.key === reviewKey() ? feedback : null;
  };

  function supportsReviewCapability(deviceId: string, capability: string): boolean {
    if (!fleetActive()) return true;
    if (!deviceId) return false;
    return (transportKind() === "native" && deviceId === entryDeviceId()) ||
      fleetDeviceById(deviceId)?.hostCapabilities?.includes(capability) === true;
  }

  function reviewNavigationTarget(workspace: WorkspaceScope, sessionId: string): ReviewTarget {
    const target: ReviewTarget = {
      sessionId, deviceId: workspace.deviceId, workspaceId: workspace.request.workspaceId,
    };
    if (!compactLayout() && (chatTarget().split || !splitPaneOpen())) {
      target.openChild = id => {
        navigateScene("sessions");
        selectSecondarySession(id, target.deviceId, target.workspaceId);
      };
    }
    return target;
  }

  function openSavedReview(run: PullRequestReviewRun): void {
    const workspace = scope();
    if (!workspace) return;
    openReviewChild({
      childSessionId: run.sessionId, childSessionName: run.sessionName, agentType: run.agentType,
    }, "review", reviewNavigationTarget(workspace, run.parentSessionId ?? run.sessionId));
  }

  function openPreviousReview(run: PullRequestReviewRun): void {
    const workspace = scope();
    const previous = run.revision?.previousSessionId;
    if (!workspace || !previous || run.recordHistoryComplete !== true) return;
    openReviewChild({ childSessionId: previous }, "review", reviewNavigationTarget(workspace, run.parentSessionId ?? previous));
  }

  async function startPullRequestReview(previous?: PullRequestReviewRun): Promise<void> {
    const workspace = scope();
    const item = selected();
    const pr = detail();
    if (!workspace || !item || !pr || reviewPending()) return;
    const key = reviewKey();
    const current = () => !disposed && reviewKey() === key;
    const report = (message: string, refresh = false) => {
      if (current()) reviewFeedback.set({ key, message, refresh });
    };
    const chat = chatTarget();
    const parentSessionId = previous?.parentSessionId ?? chat.session;
    if (previous ? !history.page()?.supportsLinkedReReview || !canReviewAgain(previous)
        : !parentSessionId || chat.workspace !== workspace.request.workspaceId ||
          (fleetActive() && (!workspace.deviceId || chat.device !== workspace.deviceId))) {
      report(tr("pullRequests.reviewChatRequired"));
      return;
    }
    if (!parentSessionId) return;
    if (workspace.remoteWorkspace) {
      report(tr("pullRequests.reviewRemoteWorkspace"));
      return;
    }
    if (!supportsReviewCapability(workspace.deviceId, REVIEW_LAUNCH_CAPABILITY)) {
      report(tr("pullRequests.reviewHostUnsupported"));
      return;
    }
    const repository = selectedRepository();
    const platform = reviewAuthProvider(repository?.platform);
    if (!platform || !repository?.host || !repository.projectPath) {
      report(tr("pullRequests.reviewTargetUnavailable"), true);
      return;
    }
    const revisionKey = JSON.stringify([key, pr.id, platform, repository.host, repository.projectPath,
      pr.baseRevision, pr.headRevision, previous?.sessionId]);
    if (reviewAttempt?.key !== revisionKey) {
      reviewAttempt = { key: revisionKey, id: `pr_review_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}` };
    }
    const sessionTarget = reviewNavigationTarget(workspace, parentSessionId);

    reviewPending.set({ previousSessionId: previous?.sessionId });
    reviewFeedback.set(null);
    try {
      const response = await invokeCommand<ReviewLaunchAnswer>(LAUNCH_REVIEW, {
        ...(previous ? { previousReviewSessionId: previous.sessionId } : { parentSessionId: sessionTarget.sessionId }),
        workspaceId: sessionTarget.workspaceId,
        remoteId: item.remoteId, pullRequestId: pr.id,
        provider: { platform, host: repository.host, projectPath: repository.projectPath },
        expectedBaseRevision: pr.baseRevision, expectedHeadRevision: pr.headRevision,
        requestId: reviewAttempt.id,
        childSessionName: tr("pullRequests.reviewChildName", { number: formatCount(pr.number) }),
        displayMessage: tr(previous ? "pullRequests.reviewAgainDisplayMessage" : "pullRequests.reviewDisplayMessage",
          { number: formatCount(pr.number) }),
      }, { target: workspace.deviceId });
      if (!current()) {
        if (response.childSessionId) pushToast(tr("pullRequests.reviewStartedElsewhere"), "info");
        return;
      }
      if (response.status === "refused") {
        switch (response.code) {
          case "review_pull_request_changed":
            report(tr("pullRequests.reviewTargetChanged"), true);
            break;
          case "review_pull_request_record_changed":
            report(tr("pullRequests.history.recordChanged"), true);
            break;
          case "review_pull_request_record_busy":
            report(tr("pullRequests.history.recordBusy"), true);
            break;
          case "review_pull_request_session_required":
            report(tr("pullRequests.reviewChatRequired"));
            break;
          case "review_remote_workspace_unsupported":
            report(tr("pullRequests.reviewRemoteWorkspace"));
            break;
          case "review_no_pull_request_changes":
            report(tr("pullRequests.reviewNoFiles"));
            break;
          case "review_pull_request_revisions_unresolved":
          case "review_invalid_pull_request_evidence":
            report(tr("pullRequests.reviewTargetUnavailable"), true);
            break;
          default:
            report(tr("pullRequests.reviewLaunchFailed"));
        }
        return;
      }
      if (!response.childSessionId) {
        report(tr("pullRequests.reviewLaunchFailed"));
        return;
      }
      handleReviewLaunch(response, "review", sessionTarget);
      history.latest();
      if (response.status === "uncertain") pushToast(tr("review.uncertain"), "warning", 5200);
      reviewAttempt = null;
    } catch (error) {
      report(isCommandUnavailable(error, LAUNCH_REVIEW) ? tr("pullRequests.reviewHostUnsupported") : localizeHostError(error));
    } finally {
      if (!disposed) reviewPending.set(null);
    }
  }

  const listStates = () => {
    const supported = snapshot()?.capabilities?.supportedPullRequestStates ?? [];
    return [{ value: "all" as const, label: tr(STATES.all) },
      ...supported.filter(item => item !== "all" && Object.hasOwn(STATES, item)).map(value => ({ value, label: tr(STATES[value]) }))];
  };
  const detailSections = (Object.keys(SECTIONS) as ReviewPlatformDetailSection[]);
  const sectionHasData = (pr: ReviewPlatformDetail, tab: ReviewPlatformDetailSection) =>
    tab === "overview" || (tab === "files" ? pr.files : tab === "ci" ? pr.ci : tab === "commits" ? pr.commits : pr.threads).length > 0;
  const title = (pr: ReviewPlatformPullRequest) => `#${pr.number} ${pr.title}`;

  return (
    <View accessibilityLabel="git-pull-requests"
      style={{ flex: 1, minHeight: 0, minWidth: 0, flexDirection: props.compact ? "column" : "row" }}>
      <If when={!props.compact || !selected()}>
        <View style={{ flex: props.compact ? 1 : undefined, width: props.compact ? "100%" : "36%",
          maxWidth: props.compact ? undefined : 360, minWidth: 0, minHeight: 0,
          borderRightWidth: props.compact ? 0 : 1, borderColor: palette().borderSubtle }}>
          <Toolbar size="sm" leading={<Text style={textStyle("sectionTitle")}>{tr("pullRequests.title")}</Text>}
            trailing={<>
              <AuthButton label="pr-auth-open" />
              <IconButton icon="refresh" size="sm" tooltip={tr("common.refresh")} accessibilityLabel="pr-refresh"
                disabled={listBusy()} onPress={() => void loadList(listPage())} />
            </>} />
          <Scroll smoothWheel style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: space.md, gap: space.sm }}>
            <If when={snapshot()?.remotes.some(value => value.supported)}>
              <TabGroup size="sm" wrap accessibilityLabel="pr-remotes" value={remote() ?? ""}
                items={[{ value: "", label: tr("pullRequests.defaultRemote"), testID: "pr-remote-default" },
                  ...(snapshot()?.remotes.map(value => ({ value: value.id, label: value.name, disabled: !value.supported,
                    testID: `pr-remote-${value.id}` })) ?? [])]}
                onChange={value => { remote.set(value || null); state.set("all"); void loadList(); }} />
            </If>
            <If when={listStates().length > 1}>
              <TabGroup size="sm" wrap accessibilityLabel="pr-list-states" value={state()} items={listStates()}
                onChange={value => {
                  if (value !== "all" && !remote()) remote.set(snapshot()?.selectedRemoteId ?? null);
                  state.set(value);
                  void loadList();
                }} />
            </If>
            <If when={snapshot()?.remotes.some(value => value.supported)}>
              <View style={{ flexDirection: "row", gap: space.xs, alignItems: "center" }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <InputBox size="sm" value={lookup()} placeholder={tr("pullRequests.lookup")} clearable
                    clearLabel={tr("common.clear")}
                    accessibilityLabel="pr-lookup" onChange={value => { lookup.set(value); lookupError.set(false); }}
                    onSubmit={openFromInput} />
                </View>
                <IconButton icon="arrow-right" size="sm" tooltip={tr("pullRequests.openRequest")}
                  accessibilityLabel="pr-lookup-open" disabled={!lookup().trim() || listBusy()} onPress={openFromInput} />
              </View>
              <If when={lookupError()}><InlineBanner tone="warning" message={tr("pullRequests.invalidLookup")} /></If>
            </If>
            <If when={listBusy()}><Spinner size={18} /></If>
            <If when={listError()}>
              <InlineBanner tone="warning" message={listError()} actionLabel={tr("common.retry")} onAction={() => void loadList(listPage())} />
            </If>
            <If when={listBusy() || listError() ? null : snapshot()}>
              {data => <>
                <If when={data().authChallenge?.message || data().message}>
                  {message => <InlineBanner tone="info" message={localizeHostError(message())}
                    actionLabel={authTarget() && data().authChallenge ? tr("pullRequests.auth.manage") : undefined}
                    onAction={openAuthentication} />}
                </If>
                <If when={data().pullRequests.length === 0 && !data().authChallenge}>
                  <Text style={textStyle("caption", { color: palette().textSecondary })}>{tr("pullRequests.empty")}</Text>
                </If>
                <Each of={data().pullRequests} key={pr => `${pr.providerId ?? data().selectedRemoteId}:${pr.id}`}>
                  {pr => <ActionCard icon="git-pull-request" compact label={title(pr())}
                    detail={[tr(STATES[pr().state]), pr().author, `${pr().sourceBranch} → ${pr().targetBranch}`].filter(Boolean).join(" · ")}
                    testID={`pr-row-${pr().id}`} selected={selected()?.id === pr().id && selected()?.remoteId === (pr().providerId ?? data().selectedRemoteId)}
                    onPress={() => select(pr())} />}
                </Each>
                <If when={data().pagination.page > 1 || data().pagination.hasNext}>
                  <PageButtons page={data().pagination.page} next={data().pagination.hasNext} busy={listBusy()} onPage={page => void loadList(page)} />
                </If>
              </>}
            </If>
          </Scroll>
        </View>
      </If>
      <If when={selected()} else={!props.compact && <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <EmptyStateCard icon="git-pull-request" title={tr("pullRequests.noSelection")} />
      </View>}>
        <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <Toolbar size="sm" leading={<>
            <If when={props.compact}>
              <IconButton icon="arrow-left" size="sm" tooltip={tr("common.back")} accessibilityLabel="pr-back" onPress={clearDetail} />
            </If>
            <Text style={{ ...textStyle("sectionTitle"), flex: 1, minWidth: 0, numberOfLines: 1, textOverflow: "ellipsis" }}>
              {detail() ? title(detail()!) : tr("pullRequests.title")}
            </Text>
          </>} trailing={<>
            <AuthButton label="pr-detail-auth-open" />
            <If when={/^https?:\/\//i.test(detail()?.webUrl ?? "")}>
              <IconButton icon="external-link" size="sm" tooltip={tr("pullRequests.openProvider")} accessibilityLabel="pr-open-provider"
                onPress={() => { const url = detail()?.webUrl; if (url) openReviewUrl(url); }} />
            </If>
          </>} />
          <View style={{ paddingHorizontal: space.md, paddingVertical: space.sm }}>
            <TabGroup size="sm" wrap accessibilityLabel="pr-detail-sections" value={section()}
              items={detailSections.map(value => ({ value, label: tr(SECTIONS[value]), testID: `pr-section-${value}` }))}
              onChange={next => { if (next !== section()) void loadDetail(next); }} />
          </View>
          <Scroll smoothWheel style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: space.md, gap: space.sm }}>
            <If when={detailBusy()}><Spinner size={18} /></If>
            <If when={detailError()}>
              <InlineBanner tone="warning" message={detailError()} actionLabel={tr("common.retry")}
                onAction={() => void loadDetail(section(), detailPage())} />
            </If>
            <If when={currentReviewFeedback()}>
              {feedback => <InlineBanner tone="warning" message={feedback().message}
                actionLabel={feedback().refresh ? tr("common.refresh") : undefined}
                onAction={() => { reviewFeedback.set(null); void refreshReviewPanel(); }} />}
            </If>
            <If when={detail()}>
              {item => {
                const tab = section;
                return <>
                  <Each of={item().limitations ?? []} key={value => value}>
                    {value => <InlineBanner tone="info" message={localizeHostError(value())} />}
                  </Each>
                  <If when={!sectionHasData(item(), tab())}>
                    <Text style={textStyle("caption")}>{tr("pullRequests.emptySection")}</Text>
                  </If>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                    <If when={history.page()?.currentRunning} else={
                      <Button size="sm" variant="secondary" label={tr("pullRequests.reviewStart")}
                        accessibilityLabel="pr-start-review"
                        loading={reviewPending() !== null && !reviewPending()?.previousSessionId}
                        disabled={Boolean(reviewPending()?.previousSessionId)}
                        onPress={() => void startPullRequestReview()} />
                    }>
                      {running => <Button size="sm" variant="secondary" label={tr("pullRequests.history.openRunning")}
                        accessibilityLabel="pr-open-running-review" onPress={() => openSavedReview(running())} />}
                    </If>
                    <If when={tab() !== "files" && sectionHasData(item(), tab())}>
                      <Button size="sm" variant="secondary" leadingIcon="chat" label={tr("pullRequests.addToChat")}
                        accessibilityLabel="pr-add-section" onPress={() => {
                          const selectedTab = tab();
                          if (selectedTab !== "files") add(item(), selectedTab, `PR #${item().number} ${tr(SECTIONS[selectedTab])}`, reviewSectionContext(item(), selectedTab));
                        }} />
                    </If>
                  </View>
                  <If when={tab() === "overview"}>
                    <If when={history.error()}>
                      <InlineBanner tone="warning" message={history.error()}
                        actionLabel={tr("common.retry")} onAction={history.reload} />
                    </If>
                    <If when={history.page()?.runs.length || history.hasNewer() || history.loading()}>
                      <ReviewSectionCard title={tr("pullRequests.history.title")}>
                        <If when={history.loading()}><Spinner size={16} /></If>
                        <Each of={history.page()?.runs ?? []} key={run => run.sessionId}>
                          {run => <View style={{ gap: space.xs }}>
                            <ActionCard icon="history" compact label={run().sessionName} multilineDetail
                              selected={chatTarget().session === run().sessionId && chatTarget().device === scope()?.deviceId}
                              detail={reviewRunSummary(run())} description={reviewOutcomeDescription(run())}
                              testID={`pr-review-run-${run().sessionId}`}
                              onPress={() => openSavedReview(run())} />
                            <If when={run().recordHistoryComplete === false}>
                              <Text style={textStyle("caption")}>{tr("pullRequests.history.recordIncomplete")}</Text>
                            </If>
                            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                              <If when={history.page()?.supportsLinkedReReview && canReviewAgain(run()) && !scope()?.remoteWorkspace}>
                                <Button size="sm" variant="ghost" leadingIcon="refresh"
                                  label={tr(run().freshness === "stale" ? "pullRequests.history.reviewCurrent" : "pullRequests.history.reviewAgain")}
                                  accessibilityLabel={`pr-rereview-${run().sessionId}`}
                                  disabled={Boolean(history.page()?.currentRunning) ||
                                    (reviewPending() !== null && reviewPending()?.previousSessionId !== run().sessionId)}
                                  loading={reviewPending()?.previousSessionId === run().sessionId}
                                  onPress={() => void startPullRequestReview(run())} />
                              </If>
                              <If when={run().recordHistoryComplete && run().revision?.previousSessionId}>
                                <Button size="sm" variant="ghost" leadingIcon="history" label={tr("pullRequests.history.openPrevious")}
                                  accessibilityLabel={`pr-rereview-previous-${run().sessionId}`} onPress={() => openPreviousReview(run())} />
                              </If>
                            </View>
                          </View>}
                        </Each>
                        <If when={history.hasNewer() || history.hasOlder()}>
                          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                            <If when={history.hasNewer()}>
                              <Button size="sm" variant="ghost" label={tr("pullRequests.history.newer")}
                                accessibilityLabel="pr-review-newer" disabled={history.loading()} onPress={history.newer} />
                            </If>
                            <If when={history.hasOlder()}>
                              <Button size="sm" variant="ghost" label={tr("pullRequests.history.older")}
                                accessibilityLabel="pr-review-older" disabled={history.loading()} onPress={history.older} />
                            </If>
                          </View>
                        </If>
                      </ReviewSectionCard>
                    </If>
                    <ReviewSectionCard title={tr(STATES[item().state])}
                      detail={`${item().author} · ${item().sourceBranch} → ${item().targetBranch}`}>
                      <If when={item().body} else={<Text style={textStyle("caption")}>{tr("pullRequests.noDescription")}</Text>}>
                        {body => <MarkdownPreview markdown={body()} compact onLinkPress={event => openReviewUrl(event.url, item().webUrl)} />}
                      </If>
                      <Text style={textStyle("caption")}>{tr("pullRequests.checkSummary", {
                        passed: formatCount(item().checks.passed), total: formatCount(item().checks.total),
                        failed: formatCount(item().checks.failed), pending: formatCount(item().checks.pending),
                      })}</Text>
                    </ReviewSectionCard>
                  </If>
                  <If when={tab() === "files"}>
                    <Each of={item().files} key={file => file.path}>
                      {file => <ReviewFileCard file={file()} onAdd={() => add(item(), "file-diff",
                        `PR #${item().number} ${file().path}`, reviewFileContext(item(), file()))} />}
                    </Each>
                  </If>
                  <If when={tab() === "ci"}>
                    <Each of={item().ci} key={check => check.id}>
                      {check => <ReviewCheckCard check={check()} loadLog={loadLog} onAdd={(log, chatKey) => add(item(), "ci",
                        `PR #${item().number} CI · ${check().name}`, reviewCheckContext(item(), check(), log), {
                          ciItemId: check().id, ciItemName: check().name, ciItemStatus: check().status,
                          ciItemConclusion: check().conclusion, ciItemStage: check().stage, ciLogTruncated: log?.truncated ?? false,
                        }, chatKey)} />}
                    </Each>
                  </If>
                  <If when={tab() === "commits"}>
                    <Each of={item().commits} key={commit => commit.hash}>
                      {commit => <ReviewSectionCard title={commit().title} detail={`${commit().shortHash} · ${commit().author}`} />}
                    </Each>
                  </If>
                  <If when={tab() === "reviews"}>
                    <Each of={item().threads} key={thread => thread.id}>
                      {thread => <ReviewSectionCard title={thread().author} detail={reviewThreadLocation(thread())}>
                        <MarkdownPreview markdown={thread().body} compact onLinkPress={event => openReviewUrl(event.url, item().webUrl)} />
                      </ReviewSectionCard>}
                    </Each>
                  </If>
                  <If when={item().pagination.page > 1 || item().pagination.hasNext}>
                    <PageButtons page={item().pagination.page} next={item().pagination.hasNext} busy={detailBusy()}
                      onPage={page => void loadDetail(tab(), page)} />
                  </If>
                </>;
              }}
            </If>
          </Scroll>
        </View>
      </If>
      <If when={authentication()}>
        {value => {
          const opened = value();
          return <ReviewPlatformAuthDialog target={opened.target}
            isCurrent={() => authentication() === opened && opened.scopeKey === scopeKey()}
            onClose={() => authentication.set(null)}
            onChanged={() => { authentication.set(null); void refreshReviewPanel(); }} />;
        }}
      </If>
    </View>
  );
}
