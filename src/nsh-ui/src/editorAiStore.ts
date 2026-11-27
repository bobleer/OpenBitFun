// Inline AI in the Markdown document editor, over the backend's ephemeral
// `editor_ai_stream` / `editor_ai_cancel` commands.
//
// The device that owns the document answers: the command goes through the
// bridge like every file command, so a phone or a browser drives the model of
// the device the workspace lives on. The backend creates no session and keeps
// nothing; it streams `editor-ai://text-chunk`, then `editor-ai://completed` or
// `editor-ai://error`, each carrying the request id this store made. The store
// only holds the answer until the user inserts or discards it.

import { signal } from "nsh";
import { invokeCommand, listenEvent } from "./bridge";

export type InlineAiStatus = "streaming" | "ready" | "failed";
export type InlineAiIntent = "ask" | "continue" | "summary" | "todo";

export interface InlineAiState {
  /** The editor (document) the answer belongs to. */
  documentKey: string;
  target: string | null;
  requestId: string;
  /** What the user asked. */
  intent: InlineAiIntent;
  instruction: string;
  status: InlineAiStatus;
  /** The answer so far (the whole answer once ready). */
  text: string;
  /** The host's own words when it failed. */
  error: string | null;
  /** Whether the answer replaces a selection or goes in at the caret. */
  replacesSelection: boolean;
}

/** The open answer, if any; one document asks at a time. */
export const inlineAi = signal<InlineAiState | null>(null);

/** The editor whose "Ask AI" field is open, with what it was opened over. */
export const inlineAiComposer = signal<{ documentKey: string; selection: string } | null>(null);

interface TextChunkEvent {
  requestId?: string;
  text?: string;
}
interface CompletedEvent {
  requestId?: string;
  fullText?: string;
}
interface ErrorEvent {
  requestId?: string;
  error?: string;
}

let unlisten: Array<() => void> = [];
let requestSeq = 0;

function stopListening(): void {
  for (const off of unlisten) {
    try {
      off();
    } catch {
      // A listener that is already gone has nothing to stop.
    }
  }
  unlisten = [];
}

function updateFor(requestId: string, change: (state: InlineAiState) => InlineAiState): void {
  inlineAi.update(current => (current && current.requestId === requestId ? change(current) : current));
}

/** For long documents the prompt carries the local context around the anchor. */
const PROMPT_DOCUMENT_CHARS = 12000;

const quickInstructions = {
  continue: "Continue writing from the insertion point, keeping the document's language and style.",
  summary: "Insert a short summary of the key points above, keeping the document's language and style.",
  todo: "Insert a concise Markdown todo list with the next action items, keeping the document's language and style.",
};

export interface InlineAiPromptInput {
  intent: InlineAiIntent;
  instruction: string;
  documentName: string;
  document: string;
  selection: string;
  before: string;
  after: string;
}

/**
 * The prompt `editor_ai_stream` takes. The backend adds its own system prompt
 * ("return only the requested document content"); this names the document,
 * the passage and what the user asked.
 */
export function buildInlineAiPrompt(input: InlineAiPromptInput): string {
  const instruction = input.intent === "ask" ? input.instruction.trim() : quickInstructions[input.intent];
  const lines = [
    `You are editing the Markdown document "${input.documentName}".`,
    input.selection.trim()
      ? "Rewrite the selected passage as the request asks. Return only the Markdown that replaces it."
      : "Write what the request asks for, to insert at the cursor. Return only the Markdown to insert.",
    "Keep the document's language and style.",
    "",
    `Request: ${instruction}`,
  ];
  if (input.selection.trim()) {
    lines.push("", "Selected passage:", "<<<", input.selection, ">>>");
  }
  if (input.before) lines.push("", "Immediately before the target:", "<<<", input.before, ">>>");
  if (input.after) lines.push("", "Immediately after the target:", "<<<", input.after, ">>>");
  if (input.document.length <= PROMPT_DOCUMENT_CHARS) {
    lines.push("", "Document:", "<<<", input.document, ">>>");
  }
  return lines.join("\n");
}

/** Models sometimes wrap the proposed document content in a Markdown fence. */
export function inlineAiMarkdown(text: string): string {
  const trimmed = text.trim();
  return /^```(?:markdown|md)[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed)?.[1].trim() ?? trimmed;
}

/** Opens the "Ask AI" field of one editor. */
export function openInlineAiComposer(documentKey: string, selection: string): void {
  inlineAiComposer.set({ documentKey, selection });
}

export function closeInlineAiComposer(): void {
  inlineAiComposer.set(null);
}

/** Asks the document's device for an answer and streams it into `inlineAi`. */
export async function askInlineAi(
  documentKey: string,
  target: string | null,
  prompt: InlineAiPromptInput,
): Promise<void> {
  if (prompt.intent === "ask" && !prompt.instruction.trim()) return;
  // Cancellation is identified by the old request and sent to its own device.
  // An offline device must not delay creating the new stream.
  void cancelInlineAi();
  requestSeq += 1;
  const requestId = `editor-ai-${Date.now().toString(36)}-${requestSeq}`;
  inlineAi.set({
    documentKey,
    target,
    requestId,
    intent: prompt.intent,
    instruction: prompt.instruction.trim(),
    status: "streaming",
    text: "",
    error: null,
    replacesSelection: Boolean(prompt.selection.trim()),
  });
  unlisten = [
    listenEvent<TextChunkEvent>("editor-ai://text-chunk", (payload, meta) => {
      if ((target && meta.origin !== target) || payload?.requestId !== requestId || typeof payload.text !== "string") return;
      const chunk = payload.text;
      updateFor(requestId, state => ({ ...state, text: state.text + chunk }));
    }),
    listenEvent<CompletedEvent>("editor-ai://completed", (payload, meta) => {
      if ((target && meta.origin !== target) || payload?.requestId !== requestId) return;
      updateFor(requestId, state => ({
        ...state,
        status: "ready",
        text: typeof payload.fullText === "string" && payload.fullText ? payload.fullText : state.text.trim(),
      }));
      stopListening();
    }),
    listenEvent<ErrorEvent>("editor-ai://error", (payload, meta) => {
      if ((target && meta.origin !== target) || payload?.requestId !== requestId) return;
      updateFor(requestId, state => ({ ...state, status: "failed", error: String(payload.error ?? "") }));
      stopListening();
    }),
  ];
  try {
    await invokeCommand<unknown>("editor_ai_stream", {
      requestId,
      prompt: buildInlineAiPrompt(prompt),
    }, { target });
  } catch (error) {
    const current = inlineAi();
    if (current?.requestId !== requestId || current.status !== "streaming") return;
    updateFor(requestId, state => ({
      ...state,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    stopListening();
  }
}

/** Stops a running answer on its device and forgets it. */
export async function cancelInlineAi(): Promise<void> {
  const current = inlineAi();
  stopListening();
  inlineAi.set(null);
  if (!current || current.status !== "streaming") return;
  try {
    await invokeCommand<unknown>("editor_ai_cancel", { requestId: current.requestId }, { target: current.target });
  } catch {
    // The answer is dropped here either way; a host that already finished has nothing to cancel.
  }
}

/** The answer was inserted: forget it without cancelling anything. */
export function finishInlineAi(): void {
  stopListening();
  inlineAi.set(null);
  inlineAiComposer.set(null);
}
