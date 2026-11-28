import { expect, open, test } from "nsh/test";
import type { SessionTranscriptView, TranscriptTurnView } from "../src/api";
import { createBackend, openSession } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };

function btwBackend() {
  const backend = createBackend();
  const requests: Record<string, unknown>[] = [];
  const reads: Record<string, unknown>[] = [];
  let view: Partial<SessionTranscriptView> = {};
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const args = data as { action?: string; request?: Record<string, unknown> };
    if (args.action === "btw_ask_stream") {
      requests.push(args.request!);
      return { ok: true, value: { ok: true }, transport: "dev" };
    }
    if (args.action === "btw_cancel") return { ok: true, value: null, transport: "dev" };
    if (args.action === "get_session_transcript_view" && String(args.request?.session_id).startsWith("btw_session_")) {
      reads.push(args.request!);
      return { ok: true, value: { sessionId: args.request?.session_id, mode: "full", turns: [], hasEarlier: false, ...view }, transport: "dev" };
    }
    return base(data);
  };
  return { backend, requests, reads, setView: (value: Partial<SessionTranscriptView>) => { view = value; } };
}

function settledTurn(request: Record<string, unknown>): TranscriptTurnView {
  return {
    turnId: `btw-turn-${request.requestId}`, turnIndex: 0, kind: "user_dialog", status: "done", settled: true,
    user: { id: "btw-user", text: String(request.question), timestampMs: 1000 },
    items: [
      { kind: "thinking", id: "thought", roundIndex: 0, text: "I should inspect the router." },
      { kind: "text", id: "intro", roundIndex: 0, text: "Before tool." },
      { kind: "tool", roundIndex: 0, tool: { id: "command", name: "Bash", status: "completed", input: { command: "pwd" }, result: "/repo", success: true } },
      { kind: "text", id: "answer", roundIndex: 0, text: "Final answer." },
    ],
    effectiveModel: "Side model", durationMs: 2500, startTimeMs: 1000, assistantTimestampMs: 3500,
    tokenUsage: { inputTokens: 120, outputTokens: 24, totalTokens: 144 },
  };
}

test("BTW shares thinking, tools, streamed answers and hover footer without persistent message actions", async () => {
  const fixture = btwBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: fixture.backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.type("composer", "/btw Inspect the router");
  await app.press("Send");
  await app.waitUntil(() => fixture.requests.length === 1);
  const request = fixture.requests[0]!;
  const turnId = `btw-turn-${request.requestId}`;
  const send = (event: string, body: Record<string, unknown>) => app.host.send("openbitfun.event", {
    event: `agentic://${event}`, payload: { sessionId: request.childSessionId, turnId, roundId: "r1", ...body },
  });
  await send("text-chunk", { contentType: "thinking", text: "I should inspect the router." });
  const thinking = `thinking-btw-${request.requestId}-live-thinking`;
  await app.waitFor(thinking);
  await app.press(thinking);
  await app.waitFor("I should inspect the router.");
  await send("text-chunk", { text: "Before tool." });
  await app.waitFor("Before tool.");
  await send("tool-event", { toolEvent: { event_type: "Started", tool_id: "command", tool_name: "Bash", params: { command: "pwd" } } });
  const liveGroup = `label:explore-group-btw-${request.requestId}-explore:tool:command`;
  await app.waitFor(liveGroup);
  await app.press(liveGroup);
  await app.waitFor("tool-card-Bash");
  await app.press("tool-card-Bash");
  await send("tool-event", { toolEvent: { event_type: "Completed", tool_id: "command", tool_name: "Bash", result: "/repo", duration_ms: 10 } });
  await send("text-chunk", { text: "Final answer." });
  await app.waitFor("Final answer.");
  expect(app.shows(`copy-answer-${turnId}`)).toBe(false);
  await send("dialog-turn-completed", {});
  await app.waitFor(`copy-answer-${turnId}`);
  await app.waitUntil(() => fixture.reads.length > 0);
  // Low-latency completion can arrive before the canonical memory record.
  fixture.setView({ turns: [settledTurn(request)] });
  await send("session-history-changed", { settledTurnId: turnId });
  await app.waitUntil(() => app.texts().join("\n").includes("Side model"));
  const meta = app.texts().join("\n");
  expect(meta).toContain("2.5s");
  expect(meta).toContain("120");
  expect(meta).toContain("24");
  expect(app.viewStyle(`turn-footer-${turnId}`)?.opacity).toBe(0);
  await app.hover(`btw-turn-${request.requestId}`);
  await app.waitUntil(() => app.viewStyle(`turn-footer-${turnId}`)?.opacity === 1);
  expect(app.shows(`fork-turn-${turnId}`)).toBe(false);
  expect(app.shows(`rollback-${turnId}`)).toBe(false);
  expect(app.shows(`edit-rerun-${turnId}`)).toBe(false);
  await app.press(`copy-answer-${turnId}`);
  expect(app.clipboard()).toBe("Before tool.\n\nFinal answer.");
  expect(fixture.reads[0]).toMatchObject({ session_id: request.childSessionId, workspace_id: "workspace-1" });
  await app.type("side-question-input", "And the tests?");
  await app.press("side-question-ask");
  await app.waitUntil(() => fixture.requests.length === 2);
  expect(fixture.requests[1]?.childSessionId).toBe(request.childSessionId);
  await send("text-chunk", { text: "Late old answer" });
  expect(app.texts().join("\n")).not.toContain("Late old answer");
  await app.press("side-question-close");
  await app.press("side-question-close-confirm");
  await app.waitFor("id:side-question-pane", { state: "gone" });
});

test("BTW recovers missing reasoning, tool work and text from a journal after dropped events without repeating replayed chunks", async () => {
  const fixture = btwBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: fixture.backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.type("composer", "/btw Recover this stream");
  await app.press("Send");
  await app.waitUntil(() => fixture.requests.length === 1);
  const request = fixture.requests[0]!;
  const turnId = `btw-turn-${request.requestId}`;
  const payload = { sessionId: request.childSessionId, turnId, roundId: "r1" };
  fixture.setView({ runningTurn: { sessionId: String(request.childSessionId), streamId: "btw-stream", cursor: 4, activeTurnId: turnId, events: [
    { eventName: "agentic://text-chunk", payload: { ...payload, contentType: "thinking", text: "Recovered reasoning" } },
    { eventName: "agentic://text-chunk", payload: { ...payload, text: "Recovered answer" } },
    { eventName: "agentic://tool-event", payload: { ...payload, toolEvent: { event_type: "Started", tool_id: "recovered", tool_name: "Bash", params: { command: "pwd" } } } },
  ] } });
  await app.host.send("openbitfun.event", { event: "backend://events-dropped", payload: {} });
  await app.waitFor("Recovered answer");
  const recoveredGroup = `label:explore-group-btw-${request.requestId}-explore:tool:recovered`;
  await app.waitFor(recoveredGroup);
  await app.press(recoveredGroup);
  await app.waitFor("tool-card-Bash");
  await app.press(`thinking-btw-${request.requestId}-live-thinking`);
  await app.waitFor("Recovered reasoning");
  await app.host.send("openbitfun.event", { event: "agentic://text-chunk", payload: {
    ...payload, text: "Recovered answer", __openbitfunRuntimeStreamId: "btw-stream", __openbitfunRuntimeEventCursor: 4,
  } });
  await app.host.send("openbitfun.event", { event: "agentic://text-chunk", payload: {
    ...payload, text: " continues", __openbitfunRuntimeStreamId: "btw-stream", __openbitfunRuntimeEventCursor: 5,
  } });
  await app.waitFor(" continues");
  expect(app.texts().join("\n")).not.toContain("Recovered answerRecovered answer");
  await app.press("side-question-stop");
  await app.waitFor("Stopped.");
});
