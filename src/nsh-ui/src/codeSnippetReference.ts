import type { EditorPosition, EditorSelection } from "nsh/base";

export interface CodeSnippetContext {
  type: "code-snippet";
  id: string;
  timestamp: number;
  filePath: string;
  fileName: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  language?: string;
}

function comparePosition(a: EditorPosition, b: EditorPosition): number {
  return a.line - b.line || a.column - b.column;
}

/** Freeze the visible selection, including unsaved text and original line endings. */
export function createCodeSnippetContext(
  filePath: string, fileName: string, language: string, text: string, selection: EditorSelection,
): CodeSnippetContext | undefined {
  const { anchor, head } = selection;
  if (comparePosition(anchor, head) === 0) return;
  const [start, end] = comparePosition(anchor, head) < 0 ? [anchor, head] : [head, anchor];
  // Even indices are the line text, odd indices are the original separators.
  const lines = text.split(/(\r\n|\r|\n)/);
  const first = start.line * 2;
  const last = end.line * 2;
  if (lines[first] === undefined || lines[last] === undefined) return;
  const selectedText = first === last
    ? lines[first].slice(start.column, end.column)
    : lines[first].slice(start.column) + lines.slice(first + 1, last).join("") + lines[last].slice(0, end.column);
  if (!selectedText.trim()) return;
  const timestamp = Date.now();
  return {
    type: "code-snippet",
    id: globalThis.crypto?.randomUUID?.() ?? `snippet-${timestamp}-${Math.random().toString(36).slice(2)}`,
    timestamp, filePath, fileName, language, selectedText,
    startLine: start.line + 1,
    endLine: end.line + (end.column === 0 && first !== last ? 0 : 1),
  };
}

export function readCodeSnippetContext(value: unknown): CodeSnippetContext | undefined {
  const context = value as Partial<CodeSnippetContext> | null;
  if (context?.type !== "code-snippet" || typeof context.id !== "string" || !context.id
    || typeof context.filePath !== "string" || !context.filePath || typeof context.fileName !== "string" || !context.fileName
    || typeof context.selectedText !== "string" || !context.selectedText
    || typeof context.startLine !== "number" || !Number.isSafeInteger(context.startLine) || context.startLine < 1
    || typeof context.endLine !== "number" || !Number.isSafeInteger(context.endLine) || context.endLine < context.startLine) return;
  const { id, filePath, fileName, startLine, endLine, selectedText, language, timestamp } = context;
  return {
    type: "code-snippet", id, filePath, fileName, startLine, endLine, selectedText,
    timestamp: typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : 0,
    ...(typeof language === "string" ? { language } : {}),
  };
}

export function codeSnippetLabel(context: CodeSnippetContext): string {
  return `${context.fileName}:${context.startLine}-${context.endLine}`;
}

export function codeSnippetLocation(context: CodeSnippetContext): string {
  return `${context.filePath}:${context.startLine}-${context.endLine}`;
}

/** A single-line draft token keeps the snapshot in its position through editing and clipboard round trips. */
export function codeSnippetPromptToken(context: CodeSnippetContext): string {
  return `Code snippet ${JSON.stringify(JSON.stringify(context))}`;
}
