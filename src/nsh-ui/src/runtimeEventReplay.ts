// Shared cursor fence for live events delivered after a runtime journal replay.

const RUNTIME_CURSOR_KEY = "__openbitfunRuntimeEventCursor";
const RUNTIME_STREAM_KEY = "__openbitfunRuntimeStreamId";
/** Set by the text-chunk merge: `[cursor, end offset]` of each merged chunk. */
const CHUNK_SPANS_KEY = "__openbitfunChunkSpans";

export interface RuntimeReplayFloor { streamId: string; cursor: number }

export function admitRuntimeEvent(event: string, payload: unknown, floor?: RuntimeReplayFloor): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  if (!floor) return payload;
  const cursor = record[RUNTIME_CURSOR_KEY];
  if (typeof cursor !== "number" || record[RUNTIME_STREAM_KEY] !== floor.streamId) return payload;
  if (cursor <= floor.cursor) return null;
  const spans = record[CHUNK_SPANS_KEY];
  if (event !== "agentic://text-chunk" || !Array.isArray(spans)) return payload;
  let cut = 0;
  for (const span of spans) {
    if (Array.isArray(span) && typeof span[0] === "number" && typeof span[1] === "number" && span[0] <= floor.cursor) {
      cut = Math.max(cut, span[1]);
    }
  }
  if (cut === 0) return payload;
  const field = (["text", "delta", "content", "chunk"] as const).find(key => typeof record[key] === "string");
  if (!field) return payload;
  return { ...record, [field]: String(record[field]).slice(cut) };
}
