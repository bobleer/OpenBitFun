import { expect, open, test } from "nsh/test";
import type { TranscriptItemView, TranscriptTurnView } from "../src/api";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession } from "./support";

const DISPLAY = { width: 1440, height: 900, platform: "windows" as const };
const REVIEW = "strict-review";
const TURN = "strict-turn";
const OWNER = "review-owner";
const WORKSPACE = "review-workspace";

function reviewer(id: string, description: string, result: unknown, detailOmitted = false): TranscriptItemView {
  return { kind: "tool", roundIndex: 0, tool: {
    id, name: "LaunchReviewAgent", input: { subagent_type: "ReviewWorker", description },
    // The tool wrapper succeeded even when the worker returned a partial result.
    status: "completed", success: true, result, detailOmitted,
  } };
}

function stoppedReview(items: TranscriptItemView[]): TranscriptTurnView {
  return {
    turnId: TURN, turnIndex: 3, kind: "user_dialog", status: "cancelled", settled: true,
    user: { id: "request", text: "Strict review the current changes.", timestampMs: 1 },
    items, startTimeMs: 1, assistantTimestampMs: 2,
    recovery: { status: "interrupted", executionGeneration: 7 },
  };
}

function fixture(interrupted = true, failure?: TranscriptTurnView["errorDetail"]) {
  const backend = createBackend();
  const original = backend.handlers["openbitfun.invoke"];
  const completed = reviewer("worker-a", "Review error handling", { status: "completed" });
  if (completed.kind === "tool") {
    completed.tool.resultForAssistant = "Worker completed successfully with result:\n<result>\nThe failure is recoverable.\n</result>";
  }
  const partial = (whole: boolean) => reviewer("worker-b", "Review UI update", {
    status: "partial_timeout", partial_output: whole ? "Saved partial result after checking the update." : "…",
  }, !whole);
  backend.handlers["openbitfun.invoke"] = payload => {
    const { action, request } = payload as { action?: string; request?: Record<string, unknown> };
    if (action === "get_session_transcript_view" && request?.session_id === REVIEW) {
      const whole = request.before_turn_index === 4;
      const turn = stoppedReview([completed, partial(whole)]);
      if (failure) {
        turn.status = "failed";
        turn.error = "Model provider rejected the request.";
        turn.errorDetail = failure;
        turn.recovery = undefined;
      }
      return { ok: true, value: { sessionId: REVIEW, mode: whole ? "before" : "full",
        cursor: null, hasEarlier: false, turns: interrupted ? [turn] : [] } };
    }
    if (action === "recover_interrupted_dialog_turn") return { ok: true, value: null };
    return original(payload);
  };
  return fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "entry" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("entry", "Controller", [{ workspaceId: "workspace-1", name: "Primary workspace", rootPath: "/primary",
        kind: "local", sessions: [fleetSessionRow("entry", "workspace-1", "session-1", "NSH skeleton")] }], { isClientDevice: true }),
      fleetDeviceRow(OWNER, "Review owner", [{ workspaceId: WORKSPACE, name: "Review workspace", rootPath: "/owner/repo",
        kind: "local", sessions: [{ ...fleetSessionRow(OWNER, WORKSPACE, REVIEW, "Strict Review"), agentType: "DeepReview" }],
      }], { hostKind: "desktop", state: "online" }),
    ] },
  });
}

test("interrupted strict review keeps separate reviewer outcomes and reads exact partial output on demand", async () => {
  const host = fixture();
  const app = await open("./fixtures/obpApp.tsx", { ...DISPLAY, host: { handlers: host.handlers } });
  await openSession(app, "Strict Review", { deviceId: OWNER });
  await app.waitFor("Review interrupted");
  await app.waitFor("2 of 2 launched checks handled");
  await app.press("View reviewer progress");
  await app.waitFor("Timed out with partial results");
  const wholeReads = () => host.fleetCalls.filter(call => call.command === "get_session_transcript_view" &&
    (call.args as { request?: { before_turn_index?: number } })?.request?.before_turn_index === 4);
  expect(wholeReads()).toHaveLength(0);
  await app.press("review-check-worker-a");
  await app.waitFor("The failure is recoverable.");
  await app.press("review-check-worker-b");
  await app.waitFor("Saved partial result after checking the update.");
  expect(wholeReads()).toMatchObject([{ target: OWNER, args: { request: {
    session_id: REVIEW, workspace_id: WORKSPACE, limit: 1, before_turn_index: 4,
  } } }]);
  expect(host.pageHostCalls).toHaveLength(0);
});

test("live reviewer progress counts launches separately and yields to a submitted report", async () => {
  const host = fixture(false);
  const app = await open("./fixtures/obpApp.tsx", { ...DISPLAY, host: { handlers: host.handlers } });
  await openSession(app, "Strict Review", { deviceId: OWNER });
  let seq = 0;
  const publish = (event: string, payload: Record<string, unknown>) =>
    app.host.send("openbitfun.obpFrames", [JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
      seq: ++seq, origin: OWNER, originInstance: OWNER + "-1", event,
      payload: { sessionId: REVIEW, turnId: TURN, roundId: "strict-round", ...payload },
    } })]);
  const toolEvent = (toolEvent: Record<string, unknown>) => publish("agentic://tool-event", { toolEvent });
  await publish("agentic://dialog-turn-started", { userInput: "Review concurrent changes.", turnIndex: 0 });
  for (const id of ["first-check", "second-check"]) {
    await toolEvent({ event_type: "Started", tool_id: id, tool_name: "LaunchReviewAgent",
      params: { subagent_type: "ReviewWorker", description: id } });
  }
  await app.waitFor("0 of 2 launched checks handled");
  await toolEvent({ event_type: "Completed", tool_id: "first-check", tool_name: "LaunchReviewAgent",
    result: { status: "completed" } });
  await app.waitFor("1 of 2 launched checks handled");
  await toolEvent({ event_type: "Started", tool_id: "report", tool_name: "submit_code_review" });
  await toolEvent({ event_type: "Completed", tool_id: "report", tool_name: "submit_code_review",
    result: { summary: { overall_assessment: "Authoritative assessment" }, issues: [] } });
  await app.waitFor("text:View reviewer progress", { state: "gone" });
});

test("a split review resumes its original checkpoint on the owning device", async () => {
  const host = fixture();
  const app = await open("./fixtures/obpApp.tsx", { ...DISPLAY, host: { handlers: host.handlers } });
  await openSession(app, "NSH skeleton", { deviceId: "entry" });
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await openSession(app, "Strict Review", { deviceId: OWNER });
  const pane = "id:secondary-session-pane";
  await app.waitFor(pane + " >> text:Review interrupted");
  expect(app.shows("id:primary-session-pane >> text:Review interrupted")).toBe(false);
  await app.press(pane + " >> label:secondary-resume-turn-" + TURN);
  const resumes = () => host.fleetCalls.filter(call => call.command === "recover_interrupted_dialog_turn");
  await app.waitUntil(() => resumes().length === 1);
  expect(resumes()).toMatchObject([{ target: OWNER, args: { request: {
    sessionId: REVIEW, workspaceId: WORKSPACE, dialogTurnId: TURN, executionGeneration: 7,
  } } }]);
  expect(host.fleetCalls.some(call => call.command === "submit_user_message")).toBe(false);
  expect(host.pageHostCalls).toHaveLength(0);
});

test("a split review's provider guidance copies diagnostics and opens the owner's Models settings", async () => {
  const host = fixture(true, {
    category: "provider_quota", provider: "Example AI", providerCode: "quota_exceeded",
    requestId: "review-provider-request", httpStatus: 429, retryable: false,
    actionHints: ["open_model_settings", "switch_model", "copy_diagnostics"],
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DISPLAY, host: { handlers: host.handlers } });
  await openSession(app, "NSH skeleton", { deviceId: "entry" });
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await openSession(app, "Strict Review", { deviceId: OWNER });
  const pane = "id:secondary-session-pane";
  await app.waitFor(pane + " >> label:review-recovery-model-settings");
  expect(app.texts()).toContain("The turn stopped: The model provider's quota or balance is exhausted.");
  expect(app.shows("id:primary-session-pane >> label:review-recovery-model-settings")).toBe(false);
  await app.press(pane + " >> label:review-recovery-copy-diagnostics");
  await app.waitUntil(() => app.clipboard()?.includes("requestId: review-provider-request") === true);
  expect(app.clipboard()).toContain("providerCode: quota_exceeded");
  expect(app.clipboard()).toContain("httpStatus: 429");

  const beforeSettings = host.fleetCalls.length;
  await app.press(pane + " >> label:review-recovery-model-settings");
  await app.waitFor("settings-scope-chip");
  const modelReads = () => host.fleetCalls.slice(beforeSettings).filter(call => call.command === "get_config"
    && (call.args as { request?: { path?: string } }).request?.path === "ai.models");
  await app.waitUntil(() => modelReads().length > 0);
  expect(modelReads().every(call => call.target === OWNER)).toBe(true);
  await app.waitFor("AI models");
  expect(host.fleetCalls.some(call => call.command === "submit_user_message" || call.command === "update_session_model")).toBe(false);
  await app.press("label:nav-back");
  await app.waitFor(pane + " >> label:review-recovery-model-settings");
});

test("provider replay constraints keep the binding visible and honor the remaining settings hint", async () => {
  const host = fixture(true, {
    category: "auth", provider: "Example AI", provider_code: "invalid_key",
    recovery_constraint: "account_bound_replay",
    action_hints: ["open_model_settings", "switch_model", "copy_diagnostics", "start_new_chat"],
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DISPLAY, host: { handlers: host.handlers } });
  await openSession(app, "Strict Review", { deviceId: OWNER });
  await app.waitFor("This turn's saved context is tied to the original provider account.");
  await app.waitFor("Open model settings");
  expect(app.shows("Switch model")).toBe(false);
  await app.press("label:review-recovery-copy-diagnostics");
  await app.waitUntil(() => app.clipboard()?.includes("recoveryConstraint: account_bound_replay") === true);
  expect(app.clipboard()).toContain("providerCode: invalid_key");
});
