// The same round/tool facts used by ordinary sessions, held as plain data for
// ephemeral side threads. Presentation stays in the shared transcript components.
import type { LiveModelRound } from "./agentEvents";
import { applyToolEvent } from "./liveToolEvents";

export const SIDE_QUESTION_EVENTS = [
  "agentic://text-chunk",
  "agentic://model-round-started",
  "agentic://model-round-completed",
  "agentic://model-round-attempt-superseded",
  "agentic://tool-event",
  "agentic://dialog-turn-started",
  "agentic://dialog-turn-completed",
  "agentic://dialog-turn-failed",
  "agentic://dialog-turn-cancelled",
  "agentic://dialog-turn-interrupted",
] as const;

export function reduceSideQuestionRounds(
  rounds: LiveModelRound[],
  event: string,
  payload: Record<string, unknown>,
  superseded: ReadonlySet<string>,
): LiveModelRound[] {
  const diagnostic = payload.diagnostic as Record<string, unknown> | undefined;
  const attempt = payload.attemptId ?? payload.attempt_id ?? diagnostic?.attemptId ?? diagnostic?.attempt_id;
  if (event !== "agentic://model-round-attempt-superseded" && typeof attempt === "string" && superseded.has(attempt)) return rounds;
  const roundId = String(payload.roundId ?? payload.round_id ?? "__default__");
  const index = rounds.findIndex(round => round.roundId === roundId);
  const round: LiveModelRound = index >= 0 ? rounds[index]! : {
    roundId, roundIndex: rounds.length, text: "", thinking: "", tools: [], completed: false,
  };
  let next = round;
  switch (event) {
    case "agentic://text-chunk": {
      const chunk = payload.text ?? payload.delta ?? payload.content ?? payload.chunk;
      const text = typeof chunk === "string" ? chunk : "";
      next = payload.contentType === "thinking"
        ? { ...round, thinking: round.thinking + text,
            ...(payload.reasoningKind === "reasoning" || payload.reasoningKind === "summary" ? { reasoningKind: payload.reasoningKind } : {}),
            ...(payload.isThinkingEnd === true ? { thinkingEnded: true } : {}) }
        : { ...round, text: round.text + text };
      break;
    }
    case "agentic://model-round-started":
      next = { ...round, completed: false,
        ...(typeof payload.roundIndex === "number" ? { roundIndex: payload.roundIndex } : {}),
        ...(typeof payload.effectiveModelName === "string" ? { effectiveModelName: payload.effectiveModelName } : {}) };
      break;
    case "agentic://model-round-completed":
      next = { ...round, completed: true,
        ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}) };
      break;
    case "agentic://model-round-attempt-superseded":
      next = { ...round, text: "", thinking: "", tools: [], attemptId: undefined, thinkingEnded: undefined };
      break;
    case "agentic://tool-event": {
      const tool = payload.toolEvent ?? payload.tool_event;
      if (!tool || typeof tool !== "object") return rounds;
      next = applyToolEvent(round, tool as Record<string, unknown>, round.text.length);
      break;
    }
    default:
      return rounds;
  }
  if (typeof attempt === "string" && event !== "agentic://model-round-attempt-superseded") next = { ...next, attemptId: attempt };
  return index >= 0 ? rounds.map((item, i) => i === index ? next : item) : [...rounds, next];
}
