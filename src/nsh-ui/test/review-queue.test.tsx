import { expect, open, test } from "nsh/test";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const SESSION = "review-session";
const TURN = "review-turn";
const QUEUE_EVENT = "agentic://deep-review-queue-state-changed";

function sample(toolId: string, status: string, optional: boolean, controlsAvailable?: boolean) {
  return { sessionId: SESSION, turnId: TURN, queueState: {
    toolId, status, reason: "provider_rate_limit", queueElapsedMs: 3000, activeReviewerCount: 1,
    optionalReviewerCount: optional ? 1 : 0, controlsAvailable,
  } };
}

function fixture(queueSamples: ReturnType<typeof sample>[]) {
  const backend = createBackend();
  const previous = backend.handlers["openbitfun.invoke"];
  const changes: Array<Record<string, unknown>> = [];
  let samples: ReturnType<typeof sample>[] | null = queueSamples;
  backend.handlers["openbitfun.invoke"] = payload => {
    const { action, request } = payload as { action?: string; request?: Record<string, unknown> };
    if (action === "get_session_transcript_view" && request?.session_id === SESSION) {
      return { ok: true, value: {
        sessionId: SESSION, mode: "full", cursor: null, hasEarlier: false, turns: [],
        ...(samples ? { runningTurn: {
          sessionId: SESSION, streamId: "review-stream", cursor: 12, activeTurnId: TURN,
          events: [
            { eventName: "agentic://dialog-turn-started", payload: {
              sessionId: SESSION, turnId: TURN, turnIndex: 0, userInput: "Strict review",
            } },
            ...samples.map(payload => ({ eventName: QUEUE_EVENT, payload })),
          ],
        } } : {}),
      } };
    }
    if (action === "control_deep_review_queue" && request) {
      changes.push(request);
      return { ok: true, value: null };
    }
    return previous(payload);
  };
  return { backend, changes, endSnapshot: () => { samples = null; } };
}

function reviewOwnerHost(backend: ReturnType<typeof createBackend>, hostKind: "desktop" | "cli" = "desktop") {
  return fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "entry" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 1, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("entry", "Controller", [], { isClientDevice: true }),
      fleetDeviceRow("review-owner", "Review owner", [{
        workspaceId: "review-workspace", name: "Review workspace", rootPath: "/owner/repo", kind: "local",
        sessions: [{ ...fleetSessionRow("review-owner", "review-workspace", SESSION, "Queue review"), agentType: "DeepReview" }],
      }], { hostKind, state: "online" }),
    ] },
  });
}

test("review queue restores mixed waits and applies controls only to the affected tools on their owner", async () => {
  const { backend, changes, endSnapshot } = fixture([
    sample("optional", "queued_for_capacity", true, true),
    sample("required", "paused_by_user", false, true),
  ]);
  const host = reviewOwnerHost(backend);
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSession(app, "Queue review", { deviceId: "review-owner" });
  await app.waitFor("Reviewers waiting");
  const publish = (event: string, payload: unknown, seq: number, origin = "review-owner") =>
    app.host.send("openbitfun.obpFrames", [JSON.stringify({ jsonrpc: "2.0", method: "event",
      params: { seq, origin, originInstance: origin + "-1", event, payload },
    })]);

  await publish(QUEUE_EVENT, sample("optional", "capacity_skipped", true, true), 1, "entry");
  await app.press("label:review-queue-pause");
  await app.waitUntil(() => changes.length === 1);
  expect(changes[0]).toMatchObject({ sessionId: SESSION, dialogTurnId: TURN, toolId: "optional", action: "pause" });
  expect(app.shows("Reviewers waiting")).toBe(true);
  await publish(QUEUE_EVENT, sample("optional", "paused_by_user", true, true), 1);
  await app.waitFor("Reviewer queue paused");

  await app.press("label:review-queue-continue");
  await app.waitUntil(() => changes.length === 3);
  expect(changes.slice(1, 3).map(request => request.toolId).sort()).toEqual(["optional", "required"]);
  expect(changes.slice(1, 3).every(request => request.action === "continue")).toBe(true);
  await app.press("label:review-queue-skip");
  await app.waitUntil(() => changes.length === 4);
  expect(changes[3]).toMatchObject({ toolId: "optional", action: "skip_optional" });
  await publish(QUEUE_EVENT, sample("optional", "capacity_skipped", true, true), 2);
  await app.waitUntil(() => !app.shows("label:review-queue-skip"));

  await app.press("label:review-queue-cancel");
  await app.waitUntil(() => changes.length === 5);
  expect(changes[4]).toMatchObject({ toolId: "required", action: "cancel" });
  endSnapshot();
  await publish("backend://events-dropped", { origin: "review-owner" }, 3);
  await app.waitUntil(() => !app.shows("label:review-queue-notice"));
  expect(host.fleetCalls.filter(call => call.command === "control_deep_review_queue").map(call => call.target))
    .toEqual(Array(5).fill("review-owner"));
  expect(host.pageHostCalls).toHaveLength(0);
});

test("a queue in the split pane controls only the split session", async () => {
  const { backend, changes } = fixture([]);
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("Port the terminal.");
  const sessionId = "session-2";
  const turnId = "split-review-turn";
  await app.host.send("openbitfun.event", { event: "agentic://dialog-turn-started", payload: {
    sessionId, turnId, userInput: "Review in the other pane",
  } });
  await app.host.send("openbitfun.event", { event: QUEUE_EVENT, payload: {
    sessionId, turnId, queueState: sample("split-reviewer", "queued_for_capacity", false, true).queueState,
  } });
  const split = "id:secondary-session-pane";
  await app.waitFor(split + " >> label:review-queue-notice");
  expect(app.shows("id:primary-session-pane >> label:review-queue-notice")).toBe(false);
  await app.press(split + " >> label:review-queue-cancel");
  await app.waitUntil(() => changes.length === 1);
  expect(changes[0]).toEqual({ sessionId, dialogTurnId: turnId, toolId: "split-reviewer", action: "cancel" });
});

test("a CLI owner reports the wait without exposing desktop queue controls", async () => {
  const { backend, changes } = fixture([sample("cli-wait", "queued_for_capacity", true, true)]);
  const host = reviewOwnerHost(backend, "cli");
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSession(app, "Queue review", { deviceId: "review-owner" });
  await app.waitFor("Use Stop in the composer to stop this review.");
  expect(app.shows("label:review-queue-pause")).toBe(false);
  expect(app.shows("label:review-queue-cancel")).toBe(false);
  expect(changes).toHaveLength(0);
});

test("a host without live queue controls still shows the wait and clears it when the tool settles", async () => {
  const { backend, changes } = fixture([sample("legacy", "queued_for_capacity", true)]);
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.host.send("openbitfun.event", { event: "agentic://dialog-turn-started", payload: {
    sessionId: "session-1", turnId: "turn-older", userInput: "Review now",
  } });
  const event = {
    sessionId: "session-1", turnId: "turn-older", queueState: sample("legacy", "queued_for_capacity", true).queueState,
  };
  await app.host.send("openbitfun.event", { event: QUEUE_EVENT, payload: event });
  await app.waitFor("Use Stop in the composer to stop this review.");
  expect(app.shows("label:review-queue-pause")).toBe(false);
  expect(app.shows("label:review-queue-skip")).toBe(false);

  await app.host.send("openbitfun.event", { event: "agentic://tool-event", payload: {
    sessionId: "session-1", turnId: "turn-older", roundId: "round",
    toolEvent: { event_type: "Cancelled", tool_id: "legacy", tool_name: "LaunchReviewAgent" },
  } });
  await app.waitUntil(() => !app.shows("label:review-queue-notice"));
  expect(changes).toHaveLength(0);
});
