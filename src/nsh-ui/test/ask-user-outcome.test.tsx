import { expect, open, test } from "nsh/test";
import type { TranscriptToolView, TranscriptTurnView } from "../src/api";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };

function inputFor(subject: string) {
  return { questions: [
    { question: `Which channel for ${subject}?`, header: "Channel", multiSelect: false,
      options: [{ label: `${subject} stable`, description: "Use the default release channel." }] },
    { question: `Which checks for ${subject}?`, header: "Checks", multiSelect: true,
      options: [{ label: "Types" }, { label: "Smoke" }] },
  ] };
}

function tool(id: string, options: Partial<TranscriptToolView>): TranscriptToolView {
  return { id, name: "AskUserQuestion", status: "completed", success: true, startMs: 1, ...options };
}

function turn(tools: TranscriptToolView[]): TranscriptTurnView {
  return {
    turnId: "question-turn",
    turnIndex: 0,
    kind: "user_dialog",
    status: "done",
    settled: true,
    user: { id: "q-prompt", text: "Set up a release", timestampMs: 1, images: [] },
    startTimeMs: 1,
    assistantTimestampMs: 2,
    items: tools.map(entry => ({ kind: "tool", roundIndex: 0, tool: entry })),
  };
}

test("an answered live question replaces the pending editor with the host's reply", async () => {
  const backend = createBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  const input = inputFor("live");
  const send = (event: string, payload: Record<string, unknown>) => app.host.send("openbitfun.event", {
    event, payload: { sessionId: "session-1", turnId: "live-question-turn", ...payload },
  });
  await send("agentic://dialog-turn-started", { userInput: "Start the release" });
  await send("backend-event-toolawaitinguserinput", { toolId: "live-question", questions: { ...input, responseDeadlineMs: null } });
  await app.waitFor("id:question-card-live-question");
  expect(app.shows("No time limit")).toBe(true);
  await send("agentic://tool-event", {
    roundId: "r1",
    toolEvent: { event_type: "Completed", tool_id: "live-question", tool_name: "AskUserQuestion",
      result: { status: "answered", questions: input.questions, answers: { "0": "live stable", "1": ["Types"] } } },
  });
  await app.press("label:explore-group-explore:tool:live-question");
  await app.waitFor("id:question-reply-live-question >> text:live stable");
  expect(app.shows("id:question-card-live-question")).toBe(false);
});

test("settled questions show host answers and only fetch omitted detail when opened", async () => {
  const backend = createBackend();
  const base = backend.handlers["openbitfun.invoke"];
  const input = inputFor("nightly");
  let wholeReads = 0;
  backend.handlers["openbitfun.invoke"] = (payload: unknown) => {
    const { action, request } = payload as { action: string; request?: Record<string, unknown> };
    if (action !== "get_session_transcript_view" || request?.session_id !== "session-1") return base(payload);
    const summary = request.tool_detail === "summary";
    if (!summary) {
      wholeReads += 1;
      if (wholeReads === 1) return { ok: false, error: "offline" };
    }
    const answered = JSON.stringify({ status: "answered", questions: input.questions,
      answers: { "0": "nightly stable", "1": ["Types", "Check signed artifacts"] } });
    return { ok: true, value: { sessionId: "session-1", mode: "full", cursor: null, hasEarlier: false, turns: [turn([
      tool("full-answer", { result: { status: "answered", questions: inputFor("preview").questions,
        answers: { "0": "preview stable", "1": ["Smoke"] } } }),
      tool("omitted-answer", { input, result: summary ? '{"status":"answered", …' : answered, detailOmitted: summary }),
      tool("cancelled-question", { input: inputFor("cancelled"), result: { status: "cancelled" } }),
      tool("superseded-question", { status: "retry_superseded", input: inputFor("expired attempt"), result: { status: "timeout" } }),
    ])] } };
  };
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.press("label:explore-group-explore:tool:full-answer");
  await app.waitFor("id:question-reply-full-answer >> text:preview stable");
  expect(app.shows("id:question-reply-full-answer >> text:Which checks for preview?")).toBe(true);
  expect(wholeReads).toBe(0);

  await app.press("id:question-result-omitted-answer");
  await app.waitFor("Only a preview is available; the full result could not be read.");
  expect(wholeReads).toBe(1);
  await app.press("Retry");
  await app.waitFor("id:question-reply-omitted-answer >> text:Check signed artifacts");
  expect(wholeReads).toBe(2);
  expect(app.shows("id:question-reply-omitted-answer >> text:nightly stable")).toBe(true);

  await app.press("id:question-result-cancelled-question");
  await app.waitFor("Which channel for cancelled?");
  expect(app.enabled("label:cancelled stable")).toBe(false);
  await app.press("id:question-result-cancelled-question");
  await app.press("id:question-result-superseded-question");
  await app.waitFor("Which channel for expired attempt?");
  expect(app.shows("Send a follow-up")).toBe(false);
});

test("a timed-out split question retains its draft on failure and sends from the source after swap", async () => {
  const backend = createBackend();
  const base = backend.handlers["openbitfun.invoke"];
  let failNext = true;
  backend.handlers["openbitfun.invoke"] = (payload: unknown) => {
    const { action, request } = payload as { action: string; request?: Record<string, unknown> };
    if (action === "submit_user_message" && failNext) {
      failNext = false;
      return { ok: false, error: "The connection closed before sending." };
    }
    if (action !== "get_session_transcript_view") return base(payload);
    const id = request?.session_id;
    const subject = id === "s-b1" ? "owner" : "entry";
    return { ok: true, value: { sessionId: id, mode: "full", cursor: null, hasEarlier: false, turns: [turn([
      tool("shared-question", { input: inputFor(subject), result: { status: "timeout" } }),
    ])] } };
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], devices: [
      fleetDeviceRow("dev-a", "Entry", [{ workspaceId: "ws-a", name: "Entry project", rootPath: "/entry",
        sessions: [fleetSessionRow("dev-a", "ws-a", "s-a1", "Entry session")] }], { isClientDevice: true }),
      fleetDeviceRow("dev-b", "Owner", [{ workspaceId: "ws-b", name: "Owner project", rootPath: "/owner",
        sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Owner session")] }]),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  const primary = "id:primary-session-pane";
  const secondary = "id:secondary-session-pane";
  await app.press("id:sidebar-session-s-a1");
  await app.press(`${primary} >> label:explore-group-explore:tool:shared-question`);
  await app.waitFor(`${primary} >> id:question-result-shared-question`);
  await app.type("composer", "Entry composer draft");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor(secondary);
  await app.press("id:sidebar-session-s-b1");
  await app.waitFor(`${secondary} >> id:question-result-shared-question`);
  await app.type("secondary-composer", "Owner composer draft");
  await app.press(`${secondary} >> id:question-result-shared-question`);
  expect(app.shows(`${primary} >> id:question-card-followup-shared-question`)).toBe(false);
  await app.press(`${secondary} >> label:owner stable`);
  await app.press(`${secondary} >> id:question-next-followup-shared-question`);
  await app.press(`${secondary} >> label:Smoke`);
  await app.press(`${secondary} >> label:Other`);
  await app.type(`${secondary} >> id:question-followup-shared-question-1-text`, "Verify signatures");
  await app.press(`${secondary} >> id:question-send-followup-shared-question`);
  await app.waitFor("Could not send the follow-up. Your answers are still here.");
  expect(app.value(`${secondary} >> id:question-followup-shared-question-1-text`)).toBe("Verify signatures");
  expect(app.value("composer")).toBe("Entry composer draft");
  expect(app.value("secondary-composer")).toBe("Owner composer draft");

  await app.hover("id:split-divider-proximity-left");
  await app.press("split-divider-swap");
  expect(app.value("composer")).toBe("Owner composer draft");
  expect(app.value("secondary-composer")).toBe("Entry composer draft");
  await app.press(`${primary} >> label:explore-group-explore:tool:shared-question`);
  await app.press(`${primary} >> id:question-result-shared-question`);
  await app.press(`${primary} >> id:question-next-followup-shared-question`);
  expect(app.value(`${primary} >> id:question-followup-shared-question-1-text`)).toBe("Verify signatures");
  await app.press(`${primary} >> id:question-send-followup-shared-question`);
  await app.waitFor(`${primary} >> id:question-reply-shared-question >> text:Verify signatures`);
  expect(app.shows(`${secondary} >> id:question-result-shared-question`)).toBe(true);
  expect(app.value("composer")).toBe("Owner composer draft");
  expect(app.value("secondary-composer")).toBe("Entry composer draft");
  const sends = host.fleetCalls.filter(call => call.command === "submit_user_message");
  expect(sends.map(call => call.target)).toEqual(["dev-b", "dev-b"]);
  expect(sends[1]?.args).toEqual({ request: {
    sessionId: "s-b1", workspaceId: "ws-b", agentType: "Standard", sendDuringTurn: "immediate",
    text: "Which channel for owner?\nowner stable\n\nWhich checks for owner?\nSmoke\nVerify signatures",
  } });
  expect(host.fleetCalls.some(call => call.command === "submit_user_answers")).toBe(false);
});
