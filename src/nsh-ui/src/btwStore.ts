// Side questions ("by the way", wave 22 P5). `btw_ask_stream` runs a question
// as an ephemeral child of the open session on the device that runs it: the
// child reuses the parent's context, streams through the normal agentic events
// under the child session id this client names, and never enters the parent's
// transcript or sidebar. After confirmation and any required `btw_cancel`
// acknowledgement, closing the pane releases its ephemeral state.

import { batch, signal, Storage } from "nsh";
import {
  buildAttachmentContexts,
  composeMessageWithFileAttachments,
  type FileAttachment,
  type ImageAttachment,
} from "./attachmentStore";
import { fleetActive, invokeCommand, listenEvent } from "./bridge";
import { isMissingCommand } from "./settingsMutations";

export type SideQuestionState = "idle" | "running" | "done" | "failed" | "cancelled";

export interface SideQuestion {
  requestId: string;
  childSessionId: string;
  parentSessionId: string;
  deviceId: string;
  question: string;
  images?: ImageAttachment[];
  answer: string;
  state: SideQuestionState;
  error?: string;
}

export const sideQuestionOpen = signal(false);
export const sideQuestionDraft = signal("");
export const sideQuestionImageAttachments = signal<ImageAttachment[]>([]);
export const sideQuestionFileAttachments = signal<FileAttachment[]>([]);
export const sideQuestionModelOverride = signal<string | null>(null);
export const sideQuestion = signal<SideQuestion | null>(null);
/** Multi-turn ephemeral messages inside the active BTW side-question pane. */
export const sideQuestionHistory = signal<SideQuestion[]>([]);
/** Active ephemeral child session ID reused for follow-up turns in this side pane. */
export const sideQuestionChildId = signal<string | null>(null);
/** Parent session that spawned the current ephemeral side thread. */
export const sideQuestionParentId = signal<string | null>(null);
export interface SideQuestionTarget {
  sessionId: string;
  deviceId: string;
  workspaceId?: string | null;
  workspacePath?: string | null;
  modelId?: string | null;
}
export const sideQuestionTarget = signal<SideQuestionTarget | null>(null);
/** Set when the session's host predates `btw_ask_stream`. */
export const sideQuestionUnsupported = signal(false);

const SKIP_CLOSE_CONFIRMATION_KEY = "openbitfun:preferences:skip-btw-close-confirmation:v1";
export const confirmBtwClose = signal(true);
let preferenceEdited = false;
let preferenceWrite = Promise.resolve();

export async function loadBtwClosePreference(): Promise<void> {
  try {
    const saved = await Storage.getItem(SKIP_CLOSE_CONFIRMATION_KEY);
    if (!preferenceEdited) confirmBtwClose.set(saved !== "true");
  } catch {
    // Keep confirmation enabled if storage is unavailable.
  }
}

export function setConfirmBtwClose(enabled: boolean): void {
  preferenceEdited = true;
  confirmBtwClose.set(enabled);
  preferenceWrite = preferenceWrite.then(async () => {
    if (enabled) await Storage.removeItem(SKIP_CLOSE_CONFIRMATION_KEY);
    else await Storage.setItem(SKIP_CLOSE_CONFIRMATION_KEY, "true");
  }).catch(() => {
    // The preference still applies in this window.
  });
}

interface SideQuestionCloseRequest {
  action: "close" | "replace" | "reset";
  afterClose?: () => void;
}
export const sideQuestionCloseRequest = signal<SideQuestionCloseRequest | null>(null);
export const sideQuestionClosing = signal(false);
export const sideQuestionStopError = signal("");
export const sideQuestionStopping = signal(false);
let admission: Promise<unknown> | undefined;
let cancellation: Promise<boolean> | undefined;

export function requestSideQuestionClose(
  afterClose?: () => void,
  action: SideQuestionCloseRequest["action"] = "close",
): void {
  if (!sideQuestionOpen() || sideQuestionClosing() || sideQuestionCloseRequest()) return;
  const request = { action, afterClose };
  if (confirmBtwClose()) sideQuestionCloseRequest.set(request);
  else void finishSideQuestionClose(request, false);
}

export function dismissSideQuestionClose(): void {
  if (!sideQuestionClosing()) sideQuestionCloseRequest.set(null);
}

export async function acceptSideQuestionClose(skipNextTime: boolean): Promise<void> {
  const request = sideQuestionCloseRequest();
  if (!request || sideQuestionClosing()) return;
  await finishSideQuestionClose(request, skipNextTime);
}

async function finishSideQuestionClose(request: SideQuestionCloseRequest, skipNextTime: boolean): Promise<void> {
  sideQuestionClosing.set(true);
  try {
    if (sideQuestion()?.state === "running" && !await cancelSideQuestion()) return;
    batch(() => {
      resetSideQuestionThread();
      if (request.action !== "reset") {
        sideQuestionOpen.set(false);
        sideQuestionTarget.set(null);
      }
      sideQuestionCloseRequest.set(null);
      if (skipNextTime) setConfirmBtwClose(false);
    });
  } finally {
    sideQuestionClosing.set(false);
  }
  request.afterClose?.();
}

export function addSideQuestionImageAttachment(item: ImageAttachment): void {
  sideQuestionImageAttachments.update(list => (list.some(x => x.id === item.id) ? list : [...list, item]));
}

export function removeSideQuestionImageAttachment(id: string): void {
  sideQuestionImageAttachments.update(list => list.filter(item => item.id !== id));
}

export function addSideQuestionFileAttachment(item: FileAttachment): void {
  sideQuestionFileAttachments.update(list => (list.some(x => x.path === item.path) ? list : [...list, item]));
}

export function removeSideQuestionFileAttachment(id: string): void {
  sideQuestionFileAttachments.update(list => list.filter(item => item.id !== id));
}

function clearSideQuestionAttachments(): void {
  sideQuestionImageAttachments.set([]);
  sideQuestionFileAttachments.set([]);
}

function newId(prefix: string): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `${prefix}_${cryptoObj.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

export function openSideQuestion(target: SideQuestionTarget, question: string): void {
  if (sideQuestionClosing() || sideQuestionCloseRequest()) return;
  const previous = sideQuestionTarget();
  if (previous && (previous.sessionId !== target.sessionId || previous.deviceId !== target.deviceId)) {
    requestSideQuestionClose(() => openSideQuestion(target, question), "replace");
    return;
  }
  sideQuestionTarget.set(target);
  sideQuestionUnsupported.set(false);
  sideQuestionOpen.set(true);
  if (question) void askSideQuestion(target, question);
}

/** Starts a fresh ephemeral side-question thread while keeping the split pane open. */
function resetSideQuestionThread(): void {
  batch(() => {
    sideQuestion.set(null);
    sideQuestionHistory.set([]);
    sideQuestionChildId.set(null);
    sideQuestionParentId.set(null);
    sideQuestionDraft.set("");
    clearSideQuestionAttachments();
    sideQuestionModelOverride.set(null);
    sideQuestionUnsupported.set(false);
    sideQuestionStopError.set("");
  });
}

function updateTurnEntry(requestId: string, updater: (entry: SideQuestion) => SideQuestion): void {
  batch(() => {
    const current = sideQuestion();
    if (current && current.requestId === requestId) {
      sideQuestion.set(updater(current));
    }
    sideQuestionHistory.update(list =>
      list.map(item => (item.requestId === requestId ? updater(item) : item)),
    );
  });
}

/** Asks `question` beside `sessionId`; follow-ups reuse the ephemeral child session. */
export async function askSideQuestion(
  target: SideQuestionTarget,
  question: string,
): Promise<void> {
  if (sideQuestionClosing() || sideQuestionCloseRequest()) return;
  const outgoingImages = [...sideQuestionImageAttachments()];
  const outgoingFiles = [...sideQuestionFileAttachments()];
  const text = composeMessageWithFileAttachments(question, outgoingFiles);
  if ((!text && outgoingImages.length === 0) || !target.sessionId) return;
  const previous = sideQuestion();
  if (previous?.state === "running") {
    if (!await cancelSideQuestion() || sideQuestion()?.requestId !== previous.requestId
      || sideQuestionClosing() || sideQuestionCloseRequest()) return;
  }

  // Reuse the ephemeral child session when continuing under the same parent session;
  // start a clean thread if the user switched parent sessions.
  const sameParent = sideQuestionParentId() === target.sessionId && sideQuestionTarget()?.deviceId === target.deviceId
    && Boolean(sideQuestionChildId());
  const childSessionId = sameParent ? sideQuestionChildId()! : newId("btw_session");
  const imageContexts = buildAttachmentContexts(outgoingImages);
  const modelId = target.modelId ?? sideQuestionModelOverride();

  const entry: SideQuestion = {
    requestId: newId("btw"),
    childSessionId,
    parentSessionId: target.sessionId,
    deviceId: target.deviceId,
    question: text,
    ...(outgoingImages.length > 0 ? { images: outgoingImages } : {}),
    answer: "",
    state: "running",
  };

  batch(() => {
    sideQuestionOpen.set(true);
    sideQuestionTarget.set(target);
    sideQuestionParentId.set(target.sessionId);
    sideQuestionChildId.set(childSessionId);
    sideQuestion.set(entry);
    sideQuestionHistory.set(sameParent ? [...sideQuestionHistory(), entry] : [entry]);
    sideQuestionDraft.set("");
    clearSideQuestionAttachments();
    sideQuestionUnsupported.set(false);
    sideQuestionStopError.set("");
  });

  const pending = invokeCommand<{ ok?: boolean }>(
    "btw_ask_stream",
    {
      requestId: entry.requestId,
      sessionId: entry.parentSessionId,
      ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
      ...(target.workspacePath ? { workspacePath: target.workspacePath } : {}),
      question: text,
      childSessionId: entry.childSessionId,
      childSessionName: oneLine(text || "image"),
      ...(modelId ? { modelId } : {}),
      ...(imageContexts.length > 0 ? { imageContexts } : {}),
    },
    fleetActive() && target.deviceId ? { target: target.deviceId } : undefined,
  ).catch(error => {
    if (sideQuestion()?.requestId !== entry.requestId) return;
    if (isMissingCommand(error, "btw_ask_stream")) sideQuestionUnsupported.set(true);
    const message = error instanceof Error ? error.message : String(error ?? "");
    updateTurnEntry(entry.requestId, item => ({
      ...item,
      state: "failed",
      error: message,
    }));
  }).finally(() => {
    if (admission === pending) admission = undefined;
  });
  admission = pending;
  await pending;
}

export function cancelSideQuestion(): Promise<boolean> {
  if (cancellation) return cancellation;
  const current = sideQuestion();
  if (!current || current.state !== "running") return Promise.resolve(true);
  sideQuestionStopping.set(true);
  sideQuestionStopError.set("");
  const stillRunning = () => sideQuestion()?.requestId === current.requestId && sideQuestion()?.state === "running";
  // The host registers the request id before acknowledging admission. A stop
  // sent sooner can succeed without ever reaching the corresponding turn.
  const stop = async () => {
    await admission;
    if (!stillRunning()) return;
    await invokeCommand<unknown>(
      "btw_cancel",
      { requestId: current.requestId },
      fleetActive() && current.deviceId ? { target: current.deviceId } : undefined,
    );
  };
  cancellation = stop().then(() => {
    if (stillRunning()) updateTurnEntry(current.requestId, item => ({ ...item, state: "cancelled" }));
    return true;
  }, error => {
    if (!stillRunning()) return true;
    sideQuestionStopError.set(error instanceof Error ? error.message : String(error));
    return false;
  }).finally(() => {
    cancellation = undefined;
    sideQuestionStopping.set(false);
  });
  return cancellation;
}

function matches(payload: unknown, origin: string): SideQuestion | null {
  const current = sideQuestion();
  if (!current || !payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const sessionId = record.sessionId ?? record.session_id;
  if (sessionId !== current.childSessionId) return null;
  if (fleetActive() && current.deviceId && origin && origin !== current.deviceId) return null;
  return current;
}

let subscribed = false;

/** Follows the child session's stream; other sessions' events are not this store's. */
export function subscribeSideQuestionEvents(): void {
  if (subscribed) return;
  subscribed = true;
  listenEvent<Record<string, unknown>>("agentic://text-chunk", (payload, meta) => {
    const current = matches(payload, meta.origin);
    if (!current || current.state !== "running") return;
    if (payload.contentType === "thinking") return;
    const chunk = payload.text ?? payload.delta ?? payload.content ?? payload.chunk;
    if (typeof chunk !== "string" || !chunk) return;
    updateTurnEntry(current.requestId, item => ({ ...item, answer: item.answer + chunk }));
  });
  listenEvent<Record<string, unknown>>("agentic://dialog-turn-completed", (payload, meta) => {
    const current = matches(payload, meta.origin);
    if (current && current.state === "running") {
      updateTurnEntry(current.requestId, item => ({ ...item, state: "done" }));
    }
  });
  listenEvent<Record<string, unknown>>("agentic://dialog-turn-failed", (payload, meta) => {
    const current = matches(payload, meta.origin);
    if (!current || current.state !== "running") return;
    const error = typeof payload.error === "string" ? payload.error : "";
    updateTurnEntry(current.requestId, item => ({
      ...item,
      state: "failed",
      ...(error ? { error } : {}),
    }));
  });
  listenEvent<Record<string, unknown>>("agentic://dialog-turn-cancelled", (payload, meta) => {
    const current = matches(payload, meta.origin);
    if (current && current.state === "running") {
      updateTurnEntry(current.requestId, item => ({ ...item, state: "cancelled" }));
    }
  });
}

/** Test seam. */
export function resetSideQuestion(): void {
  batch(() => {
    resetSideQuestionThread();
    sideQuestionTarget.set(null);
    sideQuestionOpen.set(false);
    sideQuestionCloseRequest.set(null);
  });
}
