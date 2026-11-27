// Device isolation and retry/replay contracts, without a native or remote host.
import { expect, test } from "nsh/test";
import "../src/sessionStatusStore";
import type { BackendConnection, BackendEvent } from "../src/backendConnection";
import { backendConnection, installBackendConnection } from "../src/bridge";
import {
  askSideQuestion, refreshSideQuestionTranscript, resetSideQuestion,
  sideQuestion, sideQuestionHistory, subscribeSideQuestionEvents,
} from "../src/btwStore";

function connection() {
  const calls: Array<{ target?: string; command: string; args: Record<string, unknown> }> = [];
  const listeners = new Set<(events: readonly BackendEvent[]) => void>();
  const wire: BackendConnection = {
    kind: "websocket", ready: async () => ({ version: "2.0", platform: "linux", dataDir: null }),
    state: () => "connected", error: () => "", lastSeq: () => null,
    fleet: () => ({ protocol: 1, cursorState: {}, deviceId: "controller" }),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async invoke(command, args) {
      const request = (args?.request ?? {}) as { target?: string; command?: string; args?: Record<string, unknown> };
      calls.push({ target: request.target, command: request.command ?? command, args: request.args ?? args ?? {} });
      if (request.command === "get_session_transcript_view") return { sessionId: sideQuestion()?.childSessionId, mode: "full", turns: [], hasEarlier: false };
      return { ok: true };
    },
  };
  return { wire, calls, push: (origin: string, event: string, payload: Record<string, unknown>) => {
    for (const listener of listeners) listener([{ origin, event: `agentic://${event}`, payload }]);
  } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test("BTW events and transcript reads stay on the owner, even when another device uses the same parent id", async () => {
  const previous = backendConnection();
  const host = connection();
  installBackendConnection(host.wire);
  resetSideQuestion();
  subscribeSideQuestionEvents();
  try {
    await askSideQuestion({ sessionId: "same-parent", deviceId: "runtime-b", workspaceId: "remote-workspace" }, "First question");
    const first = sideQuestion()!;
    const payload = { sessionId: first.childSessionId, turnId: first.turnId, roundId: "r1" };
    host.push("runtime-a", "text-chunk", { ...payload, text: "Wrong device" });
    host.push("runtime-b", "text-chunk", { ...payload, contentType: "thinking", text: "Owner reasoning" });
    host.push("runtime-b", "text-chunk", { ...payload, text: "Owner answer" });
    await settle();
    expect(sideQuestion()?.answer).toBe("Owner answer");
    expect(sideQuestion()?.rounds[0]?.thinking).toBe("Owner reasoning");
    await refreshSideQuestionTranscript();
    const read = host.calls.find(call => call.command === "get_session_transcript_view")!;
    expect(read.target).toBe("runtime-b");
    expect(read.args.request).toMatchObject({ session_id: first.childSessionId, workspace_id: "remote-workspace" });
    host.push("runtime-b", "dialog-turn-completed", payload);
    await settle();
    await askSideQuestion({ sessionId: "same-parent", deviceId: "runtime-a", workspaceId: "remote-workspace" }, "Different device");
    expect(sideQuestion()?.childSessionId === first.childSessionId).toBe(false);
    expect(sideQuestionHistory().length).toBe(1);
    expect(host.calls.filter(call => call.command === "btw_ask_stream").map(call => call.target)).toEqual(["runtime-b", "runtime-a"]);
  } finally {
    resetSideQuestion();
    installBackendConnection(previous);
  }
});

test("BTW retries discard superseded thinking and tool work and reject late chunks from the failed attempt", async () => {
  const previous = backendConnection();
  const host = connection();
  installBackendConnection(host.wire);
  resetSideQuestion();
  subscribeSideQuestionEvents();
  try {
    await askSideQuestion({ sessionId: "parent", deviceId: "runtime-b", workspaceId: "workspace" }, "Retry question");
    const current = sideQuestion()!;
    const payload = { sessionId: current.childSessionId, turnId: current.turnId, roundId: "r1", attemptId: "old" };
    host.push("runtime-b", "text-chunk", { ...payload, contentType: "thinking", text: "Failed reasoning" });
    host.push("runtime-b", "tool-event", { ...payload, toolEvent: { event_type: "Started", tool_id: "old-tool", tool_name: "Read" } });
    host.push("runtime-b", "model-round-attempt-superseded", { ...payload, diagnostic: { attemptId: "old" } });
    host.push("runtime-b", "text-chunk", { ...payload, text: "Late discarded text" });
    host.push("runtime-b", "text-chunk", { ...payload, attemptId: "new", contentType: "thinking", text: "New reasoning" });
    host.push("runtime-b", "text-chunk", { ...payload, attemptId: "new", text: "New answer" });
    await settle();
    expect(sideQuestion()?.answer).toBe("New answer");
    expect(sideQuestion()?.rounds[0]?.thinking).toBe("New reasoning");
    expect(sideQuestion()?.rounds[0]?.tools).toEqual([]);
  } finally {
    resetSideQuestion();
    installBackendConnection(previous);
  }
});
