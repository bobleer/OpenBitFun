// Shared live tool projection for foreground, background and ephemeral sessions.

import type { ToolCallView } from "./format";
import { appendPlanParameters, isPlanWritingTool } from "./planToolArtifact";
import { effectiveToolInvocation, reviewProgressTool } from "./toolPresentation";

export interface LiveToolItem {
  toolId: string;
  toolName: string;
  effectiveToolName?: string;
  status: "queued" | "waiting" | "running" | "confirmation" | "completed" | "failed" | "cancelled" | "rejected";
  input?: unknown;
  planParameters?: string;
  detail: string;
  progressMessage?: string;
  error?: string;
  durationMs?: number;
  /** The tool's `Completed` result payload, drawn in the expanded card. */
  result?: unknown;
  /** The text the model was given back, when the host reports it apart from `result`. */
  resultForAssistant?: string;
  /** A GenerativeUI call's OpenUI source so far, from `GenUIStream` deltas. */
  genuiStream?: { source: string; title?: string; format: string; seq: number };
  /**
   * How much of the round's answer text had arrived when the tool first appeared.
   * The transcript cuts the round's text at this offset, so text written before a
   * tool call stays above its card and text written after it stays below.
   */
  textOffset?: number;
}

export function liveToolToCallView(tool: LiveToolItem): ToolCallView {
  return {
    id: tool.toolId,
    name: tool.effectiveToolName || tool.toolName,
    detail: tool.progressMessage || tool.detail,
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    ...(tool.planParameters ? { planParameters: tool.planParameters } : {}),
    status: tool.status,
    ...(tool.error ? { error: tool.error } : {}),
    ...(tool.result !== undefined ? { result: tool.result } : {}),
    ...(tool.resultForAssistant ? { resultForAssistant: tool.resultForAssistant } : {}),
    ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
    ...(tool.genuiStream
      ? {
          genuiStream: {
            source: tool.genuiStream.source,
            format: tool.genuiStream.format,
            ...(tool.genuiStream.title ? { title: tool.genuiStream.title } : {}),
          },
        }
      : {}),
  };
}

export interface LiveRoundMeta {
  roundId: string;
  roundIndex: number;
  attemptId?: string;
  effectiveModelName?: string;
  reasoningKind?: "reasoning" | "summary";
  thinkingEnded?: boolean;
  tools: LiveToolItem[];
  reviewTools?: ReadonlyMap<string, ToolCallView>;
  completed: boolean;
  durationMs?: number;
}

function summarizeLiveInput(value: unknown, limit = 160): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…` : value;
  try {
    const text = JSON.stringify(value);
    if (!text) return "";
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return "";
  }
}

export function applyToolEvent<T extends LiveRoundMeta>(
  round: T,
  rawToolEvent: Record<string, unknown>,
  textOffset = 0,
): T {
  const eventType = String(rawToolEvent.event_type ?? rawToolEvent.eventType ?? "");
  const toolId = String(rawToolEvent.tool_id ?? rawToolEvent.toolId ?? "");
  const toolName = String(rawToolEvent.tool_name ?? rawToolEvent.toolName ?? "");
  const effectiveToolName =
    typeof rawToolEvent.effective_tool_name === "string"
      ? rawToolEvent.effective_tool_name
      : typeof rawToolEvent.effectiveToolName === "string"
        ? rawToolEvent.effectiveToolName
        : undefined;
  if (!toolId && !toolName) return round;

  const key = toolId || toolName;
  const existingIdx = round.tools.findIndex(item => item.toolId === key);
  const existing: LiveToolItem =
    existingIdx >= 0
      ? round.tools[existingIdx]
      : {
          toolId: key,
          toolName: effectiveToolName || toolName || "tool",
          ...(effectiveToolName ? { effectiveToolName } : {}),
          status: "running",
          detail: "",
          textOffset,
        };

  const identity = effectiveToolInvocation(toolName, rawToolEvent.params);
  const target = effectiveToolName ?? (identity.name !== toolName ? identity.name : existing.effectiveToolName);
  let next: LiveToolItem = {
    ...existing,
    ...(target || toolName ? { toolName: target || toolName } : {}),
    ...(target ? { effectiveToolName: target } : {}),
  };

  switch (eventType) {
    case "EarlyDetected":
    case "ParamsPartial": {
      const nextStatus = existing.status === "completed" ? "completed" : "running";
      const nextDetail =
        typeof rawToolEvent.params === "string" && rawToolEvent.params
          ? summarizeLiveInput(rawToolEvent.params)
          : next.detail;
      const planParameters = eventType === "ParamsPartial" && typeof rawToolEvent.params === "string"
        && isPlanWritingTool(next.toolName) && existing.status === "running" && existing.input === undefined
        ? appendPlanParameters(existing.planParameters ?? "", rawToolEvent.params)
        : existing.planParameters;
      if (
        existingIdx >= 0 &&
        nextStatus === existing.status &&
        nextDetail === existing.detail &&
        planParameters === existing.planParameters &&
        next.toolName === existing.toolName &&
        next.effectiveToolName === existing.effectiveToolName
      ) {
        return round;
      }
      next = {
        ...next,
        status: nextStatus,
        detail: nextDetail,
        planParameters,
      };
      break;
    }
    case "GenUIStream": {
      // The decoded OpenUI source of a GenerativeUI call, delta by delta; `reset`
      // starts the source over (a new message), `seq` drops a repeated delta.
      const seq = typeof rawToolEvent.seq === "number" ? rawToolEvent.seq : -1;
      const previous = existing.genuiStream;
      if (previous && !rawToolEvent.reset && seq >= 0 && seq <= previous.seq) return round;
      const text = typeof rawToolEvent.text === "string" ? rawToolEvent.text : "";
      const title = typeof rawToolEvent.title === "string" && rawToolEvent.title ? rawToolEvent.title : previous?.title;
      next = {
        ...next,
        status: existing.status === "completed" ? "completed" : "running",
        genuiStream: {
          source: rawToolEvent.reset || !previous ? text : previous.source + text,
          format: typeof rawToolEvent.format === "string" ? rawToolEvent.format : "openui-lang",
          seq,
          ...(title ? { title } : {}),
        },
      };
      break;
    }
    case "Queued":
      next = { ...next, status: "queued" };
      break;
    case "Waiting":
      next = { ...next, status: "waiting" };
      break;
    case "Started":
      next = {
        ...next,
        status: "running",
        planParameters: undefined,
        ...(identity.input !== undefined
          ? { input: identity.input, detail: summarizeLiveInput(identity.input) }
          : {}),
      };
      break;
    case "Progress":
      next = {
        ...next,
        status: "running",
        ...(typeof rawToolEvent.message === "string"
          ? { progressMessage: rawToolEvent.message }
          : {}),
      };
      break;
    case "ConfirmationNeeded":
      next = {
        ...next,
        status: "confirmation",
        planParameters: undefined,
        ...(identity.input !== undefined
          ? { input: identity.input, detail: summarizeLiveInput(identity.input) }
          : {}),
      };
      break;
    case "Confirmed":
      next = { ...next, status: "running" };
      break;
    case "Rejected":
    case "Cancelled":
      next = {
        ...next,
        status: eventType === "Rejected" ? "rejected" : "cancelled",
        ...(typeof rawToolEvent.reason === "string" ? { error: rawToolEvent.reason } : {}),
      };
      break;
    case "Completed": {
      const resultForAssistant =
        rawToolEvent.result_for_assistant ?? rawToolEvent.resultForAssistant;
      next = {
        ...next,
        status: "completed",
        ...(rawToolEvent.result !== undefined ? { result: rawToolEvent.result } : {}),
        ...(typeof resultForAssistant === "string" && resultForAssistant
          ? { resultForAssistant }
          : {}),
        ...(typeof rawToolEvent.duration_ms === "number"
          ? { durationMs: rawToolEvent.duration_ms }
          : {}),
      };
      break;
    }
    case "Failed":
      next = {
        ...next,
        status: "failed",
        ...(typeof rawToolEvent.error === "string" ? { error: rawToolEvent.error } : {}),
        ...(typeof rawToolEvent.duration_ms === "number"
          ? { durationMs: rawToolEvent.duration_ms }
          : {}),
      };
      break;
    default:
      return round;
  }

  const tools =
    existingIdx >= 0
      ? round.tools.map((item, idx) => (idx === existingIdx ? next : item))
      : [...round.tools, next];
  const wasReviewTool = round.reviewTools?.has(key) ?? false;
  const name = next.effectiveToolName || next.toolName;
  const sameInvocation = existingIdx >= 0 && next.input === existing.input &&
    name === (existing.effectiveToolName || existing.toolName);
  const isReviewTool = sameInvocation ? wasReviewTool : reviewProgressTool(name, next.input) !== null;
  if (!isReviewTool && !wasReviewTool) return { ...round, tools };
  const reviewTools = new Map(round.reviewTools);
  if (isReviewTool) reviewTools.set(key, liveToolToCallView(next));
  else reviewTools.delete(key);
  return { ...round, tools, reviewTools: reviewTools.size ? reviewTools : undefined };
}
