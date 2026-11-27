// AskUserQuestion prompts.
//
// A question is a blocking interaction like a permission prompt: the agent's tool
// call waits for an answer, and until one arrives the turn cannot finish. The host
// keeps that wait in a mailbox per session, so this store reads the mailbox when a
// session opens (recovering questions whose event was missed) and answers through
// the same positional command the desktop surface uses.
//
// The payload shape comes from the Runtime's own DTOs: `questions` is
// `{ questions: [{question, header, options: [{label, description}], multiSelect}],
// responseHostNowMs, responseDeadlineMs }`, and the answer map is keyed by the
// question's index as a string, holding a label or a list of labels.

import { signal } from "nsh";
import { fleetActive, invokeCommand, invokeRawCommand, listenEvent } from "./bridge";
import { buildQuestionAnswers, readQuestions, type QuestionDraft, type QuestionView } from "./questionDraft";
import { activeSessionDevice, activeSessionId, deviceOfSession, reportError } from "./state";

export interface QuestionPrompt {
  toolId: string;
  sessionId: string;
  /** The device whose runtime asked (`EventMeta.origin`; `""` without the fleet layer). */
  deviceId: string;
  questions: QuestionView[];
  /** The host's own deadline, when it set one; 0 means it waits for an answer. */
  deadlineMs: number;
  /**
   * Local wall-clock timestamp (ms) calibrated once from `(responseDeadlineMs - responseHostNowMs)`
   * so client/host clock skew never distorts the countdown; 0 when no countdown runs.
   */
  localDeadlineMs: number;
  /** Explicitly disabled by the host. An older payload can omit timing entirely. */
  unboundedWait: boolean;
  /** True once the user begins interacting with this prompt (pausing the host timeout). */
  interactionStarted: boolean;
  draft: QuestionDraft;
  error: string;
  submitting: boolean;
  /** When this prompt entered the store, so a slow mailbox read cannot drop it. */
  seenAt: number;
}

export const questionPrompts = signal<QuestionPrompt[]>([]);

let listening = false;
/** Arrival order of prompts, so a mailbox read can tell "already known" from "new". */
let arrivals = 0;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readDeadlineTiming(
  payload: unknown,
  started: boolean,
): { deadlineMs: number; localDeadlineMs: number; unboundedWait: boolean } {
  if (started) return { deadlineMs: 0, localDeadlineMs: 0, unboundedWait: false };
  const record = asRecord(payload);
  const deadline = record.responseDeadlineMs !== undefined ? record.responseDeadlineMs : record.response_deadline_ms;
  if (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0) {
    return { deadlineMs: 0, localDeadlineMs: 0, unboundedWait: deadline === null };
  }
  const hostNow = record.responseHostNowMs ?? record.response_host_now_ms;
  const remainingMs =
    typeof hostNow === "number" && Number.isFinite(hostNow) && hostNow > 0
      ? Math.max(0, deadline - hostNow)
      : Math.max(0, deadline - Date.now());
  return {
    deadlineMs: deadline,
    localDeadlineMs: Date.now() + remainingMs,
    unboundedWait: false,
  };
}

function toPrompt(
  toolId: string,
  sessionId: string,
  questions: unknown,
  deviceId: string,
  started = false,
): QuestionPrompt | null {
  const views = readQuestions(questions);
  if (views.length === 0) return null;
  const timing = readDeadlineTiming(questions, started);
  return {
    toolId,
    sessionId,
    deviceId,
    questions: views,
    ...timing,
    interactionStarted: started,
    draft: {},
    error: "",
    submitting: false,
    seenAt: ++arrivals,
  };
}

export function questionPromptKey(prompt: Pick<QuestionPrompt, "deviceId" | "sessionId" | "toolId">): string {
  return JSON.stringify([prompt.deviceId, prompt.sessionId, prompt.toolId]);
}

function isSamePrompt(left: QuestionPrompt, right: QuestionPrompt): boolean {
  return left.seenAt === right.seenAt && questionPromptKey(left) === questionPromptKey(right);
}

function upsert(prompt: QuestionPrompt): void {
  const key = questionPromptKey(prompt);
  questionPrompts.update(current => {
    const existing = current.find(item => questionPromptKey(item) === key);
    if (!existing) return [...current, prompt];
    // A republished question keeps its draft. A mailbox can acknowledge that a
    // different controller has already paused this same host deadline.
    if (existing.questions.length !== prompt.questions.length) {
      return current.map(item => item === existing ? prompt : item);
    }
    if (prompt.interactionStarted && !existing.interactionStarted) {
      return current.map(item => item === existing ? { ...item, interactionStarted: true, localDeadlineMs: 0 } : item);
    }
    return current;
  });
}

function patch(prompt: QuestionPrompt, change: (item: QuestionPrompt) => QuestionPrompt): void {
  questionPrompts.update(current => current.map(item => isSamePrompt(item, prompt) ? change(item) : item));
}

/**
 * Tells the host that the user began interacting with this question, which
 * pauses/cancels the host's unattended auto-timeout deadline (`user_questions.rs::start_interaction`).
 * Only user interaction calls this, including an explicit request to pause.
 */
const interactionInFlight = new Set<number>();

async function startInteraction(prompt: QuestionPrompt, reportFailure = false): Promise<void> {
  if (prompt.interactionStarted || interactionInFlight.has(prompt.seenAt)) return;
  interactionInFlight.add(prompt.seenAt);
  try {
    await invokeCommand<unknown>(
      "start_user_question_interaction",
      { sessionId: prompt.sessionId, toolId: prompt.toolId },
      prompt.deviceId ? { target: prompt.deviceId } : undefined,
    );
    patch(prompt, item => ({ ...item, interactionStarted: true, localDeadlineMs: 0 }));
  } catch (error) {
    // An older host has no such command; the question is still answerable.
    if (reportFailure) {
      const message = error instanceof Error ? error.message : String(error);
      patch(prompt, item => ({ ...item, error: message }));
    }
  } finally {
    interactionInFlight.delete(prompt.seenAt);
  }
}

export function pauseQuestionCountdown(source: QuestionPrompt): void {
  const prompt = questionPrompts().find(item => isSamePrompt(item, source));
  if (prompt && !prompt.submitting) void startInteraction(prompt, true);
}

/** Drops a single pending question prompt when its tool finishes, times out, or is cancelled. */
export function dropQuestionByToolId(toolId: string, deviceId?: string): void {
  if (!toolId) return;
  questionPrompts.update(current =>
    current.filter(item => {
      if (item.toolId !== toolId) return true;
      if (deviceId !== undefined && item.deviceId !== deviceId) return true;
      return false;
    }),
  );
}

/** Drops every pending question prompt belonging to a session (e.g. when the turn stops or ends). */
export function clearQuestionsForSession(sessionId: string | null | undefined, deviceId?: string): void {
  if (!sessionId) return;
  questionPrompts.update(current =>
    current.filter(item => {
      if (item.sessionId !== sessionId) return true;
      if (deviceId !== undefined && item.deviceId !== deviceId) return true;
      return false;
    }),
  );
}

/** Subscribes once, and seeds from the mailbox of whichever session is opened. */
export async function startQuestionPrompts(): Promise<void> {
  if (listening) return;
  listening = true;
  listenEvent<Record<string, unknown>>("backend-event-toolawaitinguserinput", (payload, meta) => {
    const value = asRecord(asRecord(payload).value ?? payload);
    // Real Rust `BackendEvent::ToolAwaitingUserInput` serializes snake_case
    // (`tool_id`, `session_id`); also accept camelCase from fixtures/newer bridges.
    const toolId =
      typeof value.tool_id === "string"
        ? value.tool_id
        : typeof value.toolId === "string"
          ? value.toolId
          : "";
    const sessionId =
      typeof value.session_id === "string"
        ? value.session_id
        : typeof value.sessionId === "string"
          ? value.sessionId
          : "";
    if (!toolId) return;
    const prompt = toPrompt(toolId, sessionId, value.questions, meta.origin, false);
    if (!prompt) return;
    upsert(prompt);
  });
}

/**
 * Drops cached prompts: every one (a host this surface just left, the legacy
 * Peer Device switch), or only one device's (`origin`, a gap in its events;
 * its mailbox is read again when its session opens or re-hydrates).
 */
export function resetQuestionPrompts(origin?: string): void {
  if (origin !== undefined && fleetActive()) {
    questionPrompts.update(current => current.filter(item => item.deviceId !== origin));
    return;
  }
  questionPrompts.set([]);
}

/**
 * Reads the host's mailbox for one session. This is the recovery path: a question
 * asked while this surface was on another session, or before it loaded, is
 * otherwise invisible and the turn stays stuck.
 */
export async function loadQuestionMailbox(sessionId: string, deviceId?: string): Promise<void> {
  if (!sessionId) return;
  const device = deviceId ?? (sessionId === activeSessionId() ? activeSessionDevice() : deviceOfSession(sessionId));
  // Prompts that arrive while this read is in flight are newer than the snapshot.
  const startedAt = arrivals;
  try {
    const snapshot = asRecord(
      await invokeCommand<unknown>(
        "get_session_interaction_mailbox",
        { sessionId },
        device ? { target: device } : undefined,
      ),
    );
    const mailbox = asRecord(snapshot.userQuestions ?? snapshot.user_questions);
    const pending = Array.isArray(mailbox.questions) ? mailbox.questions : [];
    const readToolId = (entry: unknown): string => {
      const rec = asRecord(entry);
      if (typeof rec.toolId === "string") return rec.toolId;
      if (typeof rec.tool_id === "string") return rec.tool_id;
      return "";
    };
    const known = new Set(pending.map(readToolId));
    // Questions of other sessions are not this surface's to show, and one asked
    // while this read was in flight is kept: the snapshot simply cannot know it.
    questionPrompts.update(current =>
      current.filter(
        item =>
          item.sessionId !== sessionId ||
          item.deviceId !== device ||
          item.seenAt > startedAt ||
          known.has(item.toolId),
      ),
    );
    for (const entry of pending) {
      const record = asRecord(entry);
      const toolId = readToolId(entry);
      if (!toolId) continue;
      const alreadyStarted = record.interactionStarted === true || record.interaction_started === true;
      const prompt = toPrompt(toolId, sessionId, record.questions, device, alreadyStarted);
      if (!prompt) continue;
      upsert(prompt);
    }
  } catch {
    // A host without the mailbox keeps the event path only.
  }
}

export function updateQuestionDraft(source: QuestionPrompt, update: (draft: QuestionDraft) => QuestionDraft): void {
  const prompt = questionPrompts().find(item => isSamePrompt(item, source));
  if (!prompt || prompt.submitting) return;
  patch(prompt, item => ({ ...item, draft: update(item.draft), error: "" }));
  void startInteraction(prompt);
}

export async function submitQuestion(source: QuestionPrompt): Promise<void> {
  const prompt = questionPrompts().find(item => isSamePrompt(item, source));
  if (!prompt || prompt.submitting) return;
  const answers = buildQuestionAnswers(prompt.questions, prompt.draft);
  if (!answers) return;
  patch(prompt, item => ({ ...item, submitting: true, error: "" }));
  try {
    // Positional: `tool_id` and `answers` are separate arguments on the host, not
    // one request struct.
    // The answer goes to the device whose tool future is waiting.
    await invokeRawCommand(
      "submit_user_answers",
      { toolId: prompt.toolId, answers, sessionId: prompt.sessionId },
      prompt.deviceId ? { target: prompt.deviceId } : undefined,
    );
    questionPrompts.update(current => current.filter(item => !isSamePrompt(item, prompt)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    patch(prompt, item => ({ ...item, submitting: false, error: message }));
    reportError(message);
  }
}

/** The prompts this surface should show for one session. */
export function questionsForSession(sessionId: string | null, deviceId: string): QuestionPrompt[] {
  if (!sessionId) return [];
  return questionPrompts().filter(
    prompt => prompt.sessionId === sessionId && prompt.deviceId === deviceId,
  );
}
