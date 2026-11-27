// Review launcher (wave 5): the "Review changes" sheet and the `/review` command.
//
// The host owns everything a Review is made of — which changes form the target,
// the evidence, the run manifest, the prompt and the child session the read-only
// reviewer runs in (`launch_review`). This store only collects the user's choices
// (ordinary or strict, which changed files, an optional focus), asks the host for
// a dry-run reading of that scope, launches, and opens the child session the host
// created. A host without the command gets the "update the host" sentence; a
// remote workspace gets the host's own refusal, never a local fallback.

import { signal } from "nsh";
import { fleetActive, invokeCommand } from "./bridge";
import { localizeHostError, tr, type MessageKey } from "./i18n";
import { isMissingCommand } from "./settingsMutations";
import {
  activeSessionId,
  activeSessionDevice,
  activeWorkspace,
  navigateScene,
  refreshSessionsSilently,
  rememberReviewSession,
  selectSession,
} from "./state";
import { pushToast } from "./ui/overlays";

export type ReviewIntent = "review" | "strict";

export interface ReviewLaunchFile {
  path: string;
  previousPath?: string;
  status: string;
}

export interface ReviewGitRevisions {
  baseRevision: string;
  headRevision: string;
}

export function gitRangeReviewLabel(range: ReviewGitRevisions): string {
  return tr("review.displayGitRange", { base: range.baseRevision.slice(0, 7), head: range.headRevision.slice(0, 7) });
}

/** The host's answer, dry run or launch. */
export interface ReviewLaunchAnswer {
  status: "prepared" | "started" | "uncertain" | "already_running" | "refused";
  code?: string;
  message?: string;
  intent: ReviewIntent;
  mode?: string;
  agentType?: string;
  gitRange?: ReviewGitRevisions;
  scopeFingerprint?: string;
  fileCount: number;
  plannedFileCount?: number;
  deferredFileCount?: number;
  changedLineCount?: number;
  completeness?: string;
  limitations?: string[];
  files?: ReviewLaunchFile[];
  paths?: string[];
  requestId?: string;
  childSessionId?: string;
  childSessionName?: string;
  parentReviewCard?: boolean;
}

export const reviewRecordChanged = signal<ReviewTarget | null>(null);

export const reviewLauncherOpen = signal(false);
export const reviewIntent = signal<ReviewIntent>("review");
export const reviewFocus = signal("");
/** Every change the host listed for the whole workspace, in its order. */
export const reviewAllFiles = signal<ReviewLaunchFile[]>([]);
/** Paths left out of the scope; empty means every change. */
export const reviewExcluded = signal<string[]>([]);
/** The host's reading of the current scope. */
export const reviewPreview = signal<ReviewLaunchAnswer | null>(null);
export const reviewPreviewLoading = signal(false);
export const reviewLaunching = signal(false);
/** Why the sheet cannot launch right now (refusal, host update, failure); empty otherwise. */
export const reviewNotice = signal("");
/** The host has no `launch_review`: the sheet says so and offers no launch. */
export const reviewUnsupported = signal(false);

let previewTicket = 0;
// One id per sheet: a retry after an unacknowledged start finds the child the
// host already created instead of starting a second reviewer.
let launchRequestId = "";

export interface ReviewTarget {
  sessionId: string;
  deviceId: string;
  workspaceId?: string | null;
  workspacePath?: string | null;
  openChild?: (id: string) => void;
}

const sheetTarget = signal<ReviewTarget | null>(null);

function primaryReviewTarget(): ReviewTarget | null {
  const sessionId = activeSessionId();
  if (!sessionId) return null;
  const workspace = activeWorkspace();
  return { sessionId, deviceId: activeSessionDevice(), workspaceId: workspace?.id, workspacePath: workspace?.rootPath };
}

function reviewRoute(target: ReviewTarget) {
  return fleetActive() && target.deviceId ? { target: target.deviceId } : undefined;
}

function reviewTargetFields(target: ReviewTarget) {
  return {
    parentSessionId: target.sessionId,
    ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
    ...(target.workspacePath ? { workspacePath: target.workspacePath } : {}),
  };
}

function newRequestId(): string {
  const random = Math.random().toString(16).slice(2, 10);
  return `review_${Date.now().toString(36)}_${random}`;
}

const REFUSAL_KEYS: Record<string, MessageKey> = {
  review_no_workspace_changes: "review.refusal.noChanges",
  review_path_outside_workspace: "review.refusal.outsideWorkspace",
  review_scope_missing: "review.refusal.scopeMissing",
  review_scope_unchanged: "review.refusal.scopeUnchanged",
  review_target_too_large: "review.refusal.tooLarge",
  review_remote_workspace_unsupported: "review.refusal.remoteWorkspace",
  review_not_git_repository: "review.refusal.notGitRepository",
  review_post_fix_scope_changed: "review.postFixScopeChanged",
  review_retry_no_scope: "review.retry.noScope",
  review_retry_scope_changed: "review.retry.scopeChanged",
  review_retry_provider_unsupported: "review.retry.providerUnsupported",
  review_no_git_range_changes: "review.refusal.gitRangeEmpty",
  review_git_range_unresolved: "review.refusal.gitRangeUnresolved",
  review_git_range_three_dot: "review.refusal.gitRangeThreeDot",
  review_git_range_ambiguous: "review.refusal.gitRangeAmbiguous",
  review_git_range_with_files: "review.refusal.gitRangeWithFiles",
  review_git_range_changed: "review.refusal.gitRangeChanged",
  review_git_range_session_unavailable: "review.refusal.gitRangeSession",
  review_git_range_files_unavailable: "review.refusal.gitRangeFiles",
  review_git_range_request_conflict: "review.refusal.gitRangeConflict",
};

/** The sentence a refusal shows: this surface's copy for codes it knows, else the host's. */
export function reviewRefusalText(answer: ReviewLaunchAnswer): string {
  const key = answer.code ? REFUSAL_KEYS[answer.code] : undefined;
  if (!key) return answer.message ?? tr("review.refusal.generic");
  return tr(key, {
    count: answer.fileCount,
    paths: (answer.paths ?? []).join(", "),
  });
}

/** Whether a composer line is a Review command (`/review`, `/review strict …`, `/DeepReview …`). */
export function isReviewCommand(text: string): boolean {
  return /^\/(review|deepreview|deep[-_]review)(\s|$)/i.test(text.trim());
}

/** The scope the host is asked for: the included paths, or `[]` for every change. */
export function reviewScopePaths(): string[] {
  const excluded = new Set(reviewExcluded());
  if (excluded.size === 0) return [];
  return reviewAllFiles()
    .map(file => file.path)
    .filter(path => !excluded.has(path));
}

export function reviewSelectedCount(): number {
  const excluded = new Set(reviewExcluded());
  return reviewAllFiles().filter(file => !excluded.has(file.path)).length;
}

function scopeRequest(target: ReviewTarget) {
  return {
    ...reviewTargetFields(target),
    intent: reviewIntent(),
    files: reviewScopePaths(),
    focus: reviewFocus().trim(),
  };
}

function reportFailure(error: unknown): void {
  if (isMissingCommand(error, "launch_review")) {
    reviewUnsupported.set(true);
    reviewNotice.set(tr("review.hostUpdateRequired"));
    return;
  }
  reviewNotice.set(error instanceof Error ? error.message : String(error));
}

/** Asks the host to read the current scope without creating anything. */
export async function previewReview(): Promise<void> {
  const target = sheetTarget();
  if (!target) return;
  const request = scopeRequest(target);
  const ticket = ++previewTicket;
  reviewPreviewLoading.set(true);
  try {
    const answer = await invokeCommand<ReviewLaunchAnswer>("launch_review", { ...request, dryRun: true }, reviewRoute(target));
    if (ticket !== previewTicket) return;
    reviewUnsupported.set(false);
    reviewPreview.set(answer);
    // The unscoped reading is the list the user narrows from.
    if ((request.files as string[]).length === 0) reviewAllFiles.set(answer.files ?? []);
    reviewNotice.set(answer.status === "refused" ? reviewRefusalText(answer) : "");
  } catch (error) {
    if (ticket !== previewTicket) return;
    reviewPreview.set(null);
    reportFailure(error);
  } finally {
    if (ticket === previewTicket) reviewPreviewLoading.set(false);
  }
}

/** Opens the sheet for the session on screen and reads its workspace changes. */
export function openReviewLauncher(options: { intent?: ReviewIntent; focus?: string; target?: ReviewTarget } = {}): void {
  const target = options.target ?? primaryReviewTarget();
  if (!target) return;
  sheetTarget.set(target);
  reviewIntent.set(options.intent ?? "review");
  reviewFocus.set(options.focus ?? "");
  reviewExcluded.set([]);
  reviewAllFiles.set([]);
  reviewPreview.set(null);
  reviewNotice.set("");
  reviewLaunching.set(false);
  launchRequestId = newRequestId();
  reviewLauncherOpen.set(true);
  void previewReview();
}

export function closeReviewLauncher(): void {
  previewTicket += 1;
  reviewLauncherOpen.set(false);
  sheetTarget.set(null);
  reviewPreviewLoading.set(false);
}

export function chooseReviewIntent(intent: ReviewIntent): void {
  if (reviewIntent() === intent) return;
  reviewIntent.set(intent);
  void previewReview();
}

export function toggleReviewFile(path: string): void {
  const excluded = reviewExcluded();
  reviewExcluded.set(excluded.includes(path) ? excluded.filter(item => item !== path) : [...excluded, path]);
  void previewReview();
}

export function includeAllReviewFiles(): void {
  if (reviewExcluded().length === 0) return;
  reviewExcluded.set([]);
  void previewReview();
}

/** Shows the child session the host created and started. */
export function openReviewChild(
  answer: Pick<ReviewLaunchAnswer, "childSessionId" | "childSessionName" | "agentType">,
  intent: ReviewIntent,
  target: ReviewTarget,
): void {
  const childId = answer.childSessionId;
  if (!childId) return;
  rememberReviewSession({
    sessionId: childId,
    sessionName: answer.childSessionName ?? childName(intent),
    agentType: answer.agentType,
    workspaceId: target.workspaceId ?? undefined,
    ...(target.deviceId ? { deviceId: target.deviceId } : {}),
  });
  if (target.openChild) target.openChild(childId);
  else {
    navigateScene("sessions");
    selectSession(childId, target.deviceId || undefined, target.workspaceId || undefined);
  }
  void refreshSessionsSilently();
}

export function handleReviewLaunch(answer: ReviewLaunchAnswer, intent: ReviewIntent, target: ReviewTarget): void {
  if (!answer.childSessionId) return;
  if (!answer.parentReviewCard || !target.workspaceId) {
    openReviewChild(answer, intent, target);
    return;
  }
  reviewRecordChanged.set({ ...target });
  if (answer.status === "started") pushToast(tr("review.recordStarted"), "info");
}

function childName(intent: ReviewIntent): string {
  return intent === "strict" ? tr("review.childNameStrict") : tr("review.childName");
}

async function runLaunch(
  request: Record<string, unknown>, intent: ReviewIntent, target: ReviewTarget, requestId: string,
  displayMessage = intent === "strict" ? tr("review.displayStrict") : tr("review.displayStandard"),
): Promise<ReviewLaunchAnswer> {
  const answer = await invokeCommand<ReviewLaunchAnswer>("launch_review", {
    ...request,
    requestId,
    childSessionName: childName(intent),
    displayMessage,
  }, reviewRoute(target));
  if (answer.status === "refused") {
    reviewNotice.set(reviewRefusalText(answer));
    return answer;
  }
  handleReviewLaunch(answer, intent, target);
  if (answer.status === "uncertain") pushToast(tr("review.uncertain"), "warning");
  return answer;
}

/** Launches the Review the sheet describes. */
export async function launchReviewFromSheet(): Promise<void> {
  const target = sheetTarget();
  if (!target || reviewLaunching() || reviewUnsupported()) return;
  reviewLaunching.set(true);
  reviewNotice.set("");
  try {
    const answer = await runLaunch(scopeRequest(target), reviewIntent(), target, launchRequestId);
    if (sheetTarget() === target && answer.status !== "refused") {
      launchRequestId = "";
      closeReviewLauncher();
    }
  } catch (error) {
    reportFailure(error);
  } finally {
    reviewLaunching.set(false);
  }
}

// Treat any range-shaped selection as a preflight candidate so a previous
// owner cannot interpret it as workspace focus. The host parses and resolves it.
function maySelectGitRange(text: string): boolean {
  const focus = text.trim().replace(/^\/\S+\s*/, "").replace(/^strict(?:\s+|$)/i, "");
  return /^(?:review\s+)?(?:commit|ref)(?:\s|$)/i.test(focus)
    || focus.split(/\s+/).some(raw => {
      const token = raw.replace(/^[`"']+/, "");
      return token.includes("..") && !token.startsWith("../") && !token.includes("://");
    });
}

interface PendingGitRangeLaunch {
  commandText: string;
  revisions: ReviewGitRevisions;
  intent: ReviewIntent;
  requestId: string;
  launching: boolean;
}

const pendingGitRangeLaunches = new Map<string, PendingGitRangeLaunch>();

async function launchReviewGitRange(text: string, target: ReviewTarget): Promise<boolean> {
  const key = JSON.stringify([target.deviceId, target.workspaceId, target.sessionId]);
  const matchingLaunch = () => {
    const saved = pendingGitRangeLaunches.get(key);
    return saved?.commandText === text ? saved : undefined;
  };
  let launch = matchingLaunch();
  try {
    if (!launch) {
      const prepared = await invokeCommand<ReviewLaunchAnswer>("launch_review", {
        ...reviewTargetFields(target), commandText: text, dryRun: true,
      }, reviewRoute(target));
      if (prepared.status === "refused") {
        // Older owners can refuse a clean or oversized working tree before
        // telling us anything about the explicitly requested commits.
        const workspaceOnly = prepared.code === "review_no_workspace_changes" || prepared.code === "review_target_too_large";
        pushToast(workspaceOnly ? tr("review.gitRangeHostUpdate") : reviewRefusalText(prepared), "warning");
        return false;
      }
      if (prepared.status !== "prepared" || !prepared.gitRange) {
        pushToast(tr("review.gitRangeHostUpdate"), "warning");
        return false;
      }
      launch = matchingLaunch() ?? {
        commandText: text, revisions: prepared.gitRange, intent: prepared.intent, requestId: newRequestId(), launching: false,
      };
      pendingGitRangeLaunches.set(key, launch);
    }
    if (launch.launching) return true;
    launch.launching = true;
    try {
      const answer = await runLaunch({
        ...reviewTargetFields(target),
        // Older owners reject this intent even if the runtime changed
        // between preparation and launch.
        intent: "git_range",
        approvedGitRange: { ...launch.revisions, commandText: text },
      }, launch.intent, target, launch.requestId, gitRangeReviewLabel(launch.revisions));
      if (pendingGitRangeLaunches.get(key) === launch) pendingGitRangeLaunches.delete(key);
      if (answer.status === "refused") {
        pushToast(reviewRefusalText(answer), "warning");
        return false;
      }
      return true;
    } finally {
      launch.launching = false;
    }
  } catch (error) {
    pushToast(isMissingCommand(error, "launch_review")
      ? tr("review.gitRangeHostUpdate") : localizeHostError(error), "warning");
    return false;
  }
}

/**
 * Runs a typed `/review …` line for the session on screen. The host reads the
 * line (intent and focus); a refusal or an older host opens the sheet, where the
 * reason is shown and the scope can be changed. A refused Git range keeps its
 * composer draft so it can be corrected and resubmitted.
 */
export async function launchReviewFromCommand(text: string, target = primaryReviewTarget()): Promise<boolean> {
  if (!target || !isReviewCommand(text)) return false;
  if (maySelectGitRange(text)) return launchReviewGitRange(text.trim(), target);
  const intent: ReviewIntent = /^\/(deepreview|deep[-_]review)\b|^\/review\s+strict\b/i.test(text.trim())
    ? "strict"
    : "review";
  try {
    const answer = await runLaunch(
      {
        ...reviewTargetFields(target),
        commandText: text.trim(),
      },
      intent, target, newRequestId(),
    );
    if (answer?.status === "refused") {
      const notice = reviewNotice();
      openReviewLauncher({ intent, target });
      reviewNotice.set(notice);
    }
  } catch (error) {
    openReviewLauncher({ intent, target });
    reportFailure(error);
  }
  return true;
}

// ── Review notes (wave 15 UI-C, visual spec §4.5) ────────────────────────────
//
// Line notes the user leaves on a diff, batched back to the session's agent with
// "Send to agent" as one message (the Orca pattern). Notes belong to one session
// on one device (`sessionKey`); they live only on this client until sent.

export interface ReviewNote {
  id: string;
  /** `"<deviceId>/<sessionId>"` (`state.sessionKey`). */
  sessionKey: string;
  path: string;
  side: "old" | "new";
  /** First and last line, from 0 (as `DiffView` numbers them). */
  start: number;
  end: number;
  text: string;
}

export const reviewNotes = signal<ReviewNote[]>([]);
/** The note being written (its field has focus). */
export const editingReviewNote = signal<string | null>(null);
export const sendingReviewNotes = signal(false);
let noteSeq = 0;

export function reviewNotesFor(sessionKey: string | null): ReviewNote[] {
  if (!sessionKey) return [];
  return reviewNotes().filter(note => note.sessionKey === sessionKey);
}

/** Adds an empty note on lines `start`–`end` of `path` and opens it for writing. */
export function addReviewNote(note: Omit<ReviewNote, "id" | "text">): string {
  const id = `note-${++noteSeq}`;
  reviewNotes.update(current => [...current, { ...note, id, text: "" }]);
  editingReviewNote.set(id);
  return id;
}

export function updateReviewNote(id: string, text: string): void {
  reviewNotes.update(current => current.map(note => (note.id === id ? { ...note, text } : note)));
}

export function removeReviewNote(id: string): void {
  reviewNotes.update(current => current.filter(note => note.id !== id));
  if (editingReviewNote() === id) editingReviewNote.set(null);
}

/** The message the notes become: one line per note, `path:line` then the note. */
export function reviewNotesMessage(notes: ReviewNote[]): string {
  return notes
    .filter(note => note.text.trim())
    .map(note => {
      const lines = note.start === note.end ? `${note.start + 1}` : `${note.start + 1}-${note.end + 1}`;
      return `${note.path}:${lines} ${note.text.trim()}`;
    })
    .join("\n");
}

/**
 * Sends a session's notes to its agent as one message (`send` is the session's
 * own `sendTurn`, so the host decides whether it steers or queues), then clears
 * them. Notes without text stay.
 */
export async function sendReviewNotes(sessionKey: string, send: (text: string) => Promise<unknown>): Promise<void> {
  const notes = reviewNotesFor(sessionKey).filter(note => note.text.trim());
  if (notes.length === 0 || sendingReviewNotes()) return;
  sendingReviewNotes.set(true);
  try {
    await send(reviewNotesMessage(notes));
    const sent = new Set(notes.map(note => note.id));
    reviewNotes.update(current => current.filter(note => !sent.has(note.id)));
  } finally {
    sendingReviewNotes.set(false);
  }
}
