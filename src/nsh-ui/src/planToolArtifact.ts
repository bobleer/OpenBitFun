import type { ToolCallView } from "./format";
import { isPlanDocument, readPlanDocument, type PlanTodo } from "./planDocument";
import { normalizeToolName, toolInputRecord } from "./toolPresentation";

const MAX_PREVIEW_BYTES = 128 * 1024;
const WRITE_NAMES = new Set(["write", "writefile", "createfile"]);

export function isPlanWritingTool(name: string): boolean {
  const normalized = normalizeToolName(name);
  return WRITE_NAMES.has(normalized) || normalized === "createplan";
}

/** ParamsPartial carries fragments. Keep a bounded prefix, including the plan's metadata. */
export function appendPlanParameters(previous: string, fragment: string): string {
  if (previous && fragment.trimStart().startsWith("{") && fragment.length <= MAX_PREVIEW_BYTES) {
    const value = toolInputRecord(fragment);
    if (["payload", "file_path", "filePath", "plan_file_path", "planFilePath", "overview"].some(key => Object.hasOwn(value, key))) {
      return fragment;
    }
  }
  return previous + fragment.slice(0, Math.max(0, MAX_PREVIEW_BYTES - previous.length));
}

function firstString(object: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** Read only the JSON string prefix we understand, dropping an unfinished escape. */
function pendingString(buffer: string, field: string): string {
  if (!buffer) return "";
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\(?:u[0-9a-fA-F]{4}|["\\\\/bfnrt])|[^"\\\\])*)`).exec(buffer);
  if (!match) return "";
  try { return JSON.parse(`"${match[1]}"`) as string; } catch { return ""; }
}

function writePayload(payload: string): { path: string; text: string } | null {
  const match = /^\+\+\+ ([^\r\n]+)\r?\n/.exec(payload);
  return match ? { path: match[1].trim(), text: payload.slice(match[0].length) } : null;
}

function previewMetadata(text: string, streaming: boolean) {
  const bounded = text.slice(0, MAX_PREVIEW_BYTES);
  const exact = readPlanDocument(bounded);
  if (exact.kind === "plan" || !streaming || !/^\uFEFF?---[ \t]*\r?\n/.test(bounded)) return exact;
  const lastBreak = bounded.lastIndexOf("\n");
  // Keep complete mapping lines while a scalar or the next list item is streaming.
  for (const end of [lastBreak, bounded.lastIndexOf("\n", lastBreak - 1)]) {
    if (end < 0) continue;
    const partial = readPlanDocument(`${bounded.slice(0, end + 1)}---\n`);
    if (partial.kind === "plan") return partial;
  }
  return exact;
}

export interface TranscriptPlanArtifact {
  path: string;
  storage: "project" | "runtime";
  name: string;
  overview: string;
  todos: Array<Pick<PlanTodo, "id" | "content" | "status">>;
  hasMetadata: boolean;
}

function legacyTodos(value: unknown): TranscriptPlanArtifact["todos"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const content = firstString(row, ["content", "text"]);
    return content ? [{ id: firstString(row, ["id"]) || String(index), content,
      status: firstString(row, ["status"]) || "pending" }] : [];
  });
}

export function transcriptPlanArtifact(call: ToolCallView, streaming = false): TranscriptPlanArtifact | null {
  if (!isPlanWritingTool(call.name)) return null;
  const legacy = normalizeToolName(call.name) === "createplan";
  const input = toolInputRecord(call.input);
  const result = toolInputRecord(call.result);
  const resultData = toolInputRecord(result.data);
  const stream = call.planParameters ?? "";
  const partial = streaming ? toolInputRecord(stream) : {};
  const payload = writePayload(firstString(input, ["payload"]) || firstString(partial, ["payload"]) || pendingString(stream, "payload"));
  const keys = legacy ? ["plan_file_path", "planFilePath", "file_path", "filePath", "path"] : ["file_path", "filePath", "path"];
  const path = call.plan?.file_path || call.plan?.filePath || firstString(resultData, keys) || firstString(result, keys) ||
    payload?.path || firstString(input, keys) || firstString(partial, keys);
  if (!legacy && !isPlanDocument(path)) return null;
  if (legacy && !path && !firstString(input, ["name", "overview"]) && !firstString(partial, ["name", "overview"]) && !streaming) return null;
  const text = payload?.text ?? (firstString(input, ["content", "contents", "file_text", "text"]) || pendingString(stream, "content"));
  const parsed = previewMetadata(text, streaming);
  const metadata = parsed.kind === "plan" ? parsed : null;
  const overview = metadata?.overview || call.plan?.overview || (legacy ? firstString(input, ["overview"]) || firstString(partial, ["overview"]) || pendingString(stream, "overview") : "");
  const name = metadata?.name || call.plan?.name || (legacy ? firstString(input, ["name"]) || firstString(partial, ["name"]) || pendingString(stream, "name") : "");
  const todos = metadata?.todos ?? (legacy ? legacyTodos(input.todos ?? partial.todos) : []);
  return { path, storage: legacy || /^openbitfun:\/\/runtime\//i.test(path) ? "runtime" : "project",
    name, overview, todos, hasMetadata: !call.detailOmitted && Boolean(metadata || (legacy && Array.isArray(input.todos))) };
}
