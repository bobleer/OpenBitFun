import { expect, open, test } from "nsh/test";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession } from "./support";

const OWNER = "review-device";
const WORKSPACE = "review-workspace";
const REVIEW = "source-review";
const REPORT = "source-report";
const CHILD = "coverage-review";

function fixture(supported: boolean) {
  const backend = createBackend();
  const base = backend.handlers["openbitfun.invoke"];
  const requests: Record<string, unknown>[] = [];
  let previewCount = 0;
  backend.handlers["openbitfun.invoke"] = payload => {
    const { action, request } = payload as { action?: string; request?: Record<string, unknown> };
    if (action === "get_session_transcript_view" && request?.session_id === REVIEW) {
      return { ok: true, value: { sessionId: REVIEW, mode: "full", cursor: null, hasEarlier: false, turns: [{
        turnId: "original-turn", turnIndex: 0, kind: "user_dialog", status: "done", settled: true,
        startTimeMs: 1, assistantTimestampMs: 2, user: { id: "request", text: "Review before shipping.", timestampMs: 1 },
        items: [{ kind: "tool", roundIndex: 0, tool: {
          id: REPORT, name: "submit_code_review", status: "completed", success: true, result: {
            summary: { overall_assessment: "One check timed out." }, issues: [], review_mode: "deep",
            reviewers: [{ packet_id: "legacy-check", status: "partial_timeout", retry_scope_files: ["stale.ts"] }],
          },
        } }],
      }] } };
    }
    if (action === "launch_review" && request) {
      requests.push(request);
      if (request.dryRun) {
        const refreshed = ++previewCount > 1;
        return { ok: true, value: { status: "prepared", intent: "strict", fileCount: 1, completeness: "complete",
          scopeFingerprint: refreshed ? "fresh-fingerprint" : "original-fingerprint",
          files: [{ path: refreshed ? "remaining.ts" : "stale.ts", status: "modified" }],
        } };
      }
      return previewCount === 1
        ? { ok: true, value: { status: "refused", intent: "strict", code: "review_retry_scope_changed" } }
        : { ok: true, value: { status: "started", intent: "strict", agentType: "DeepReview",
          childSessionId: CHILD, childSessionName: "Coverage follow-up",
        } };
    }
    return base(payload);
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "entry" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 }, devices: [
      fleetDeviceRow("entry", "Controller", [], { isClientDevice: true }),
      fleetDeviceRow(OWNER, "Review computer", [{
        workspaceId: WORKSPACE, name: "Review workspace", rootPath: "/owner/repo", kind: "local",
        sessions: [{ ...fleetSessionRow(OWNER, WORKSPACE, REVIEW, "Original review"), agentType: "DeepReview" }],
      }], { hostKind: "desktop", hostCapabilities: supported ? ["review_coverage_retry_v1"] : [], state: "online" }),
    ] },
  });
  return { host, requests };
}

test("incomplete coverage requires confirmation of the latest exact scope on the review owner", async () => {
  const { host, requests } = fixture(true);
  const app = await open("./fixtures/obpApp.tsx", { width: 1440, height: 900, host: { handlers: host.handlers } });
  await openSession(app, "Original review", { deviceId: OWNER });
  await app.press(`label:explore-group-explore:tool:${REPORT}`);
  await app.press("label:tool-card-submit_code_review");
  await app.press("label:review-open-coverage-retry");
  await app.waitFor("stale.ts");
  expect(requests).toMatchObject([{
    parentSessionId: REVIEW, workspaceId: WORKSPACE, intent: "retry_incomplete", dryRun: true,
    retryCoverage: { reportToolId: REPORT },
  }]);
  await app.press("label:review-confirm-coverage-retry");
  await app.waitFor("The file scope changed. Refresh it before starting another review.");
  expect(app.shows("label:review-confirm-coverage-retry")).toBe(false);
  expect(app.shows("text:stale.ts")).toBe(false);
  await app.press("label:review-reload-retry-scope");
  await app.waitFor("remaining.ts");
  expect(requests).toHaveLength(3);
  await app.press("label:review-confirm-coverage-retry");
  await app.waitFor("Coverage follow-up");
  expect(requests.filter(request => !request.dryRun).map(request => request.retryCoverage)).toEqual([
    { reportToolId: REPORT, scopeFingerprint: "original-fingerprint" },
    { reportToolId: REPORT, scopeFingerprint: "fresh-fingerprint" },
  ]);
  expect(host.fleetCalls.filter(call => call.command === "launch_review").map(call => call.target))
    .toEqual([OWNER, OWNER, OWNER, OWNER]);
  expect(app.shows("Review before shipping.")).toBe(true);
  expect(host.pageHostCalls).toHaveLength(0);
});

test("an older review owner leaves its saved report readable without offering incomplete coverage retry", async () => {
  const { host, requests } = fixture(false);
  const app = await open("./fixtures/obpApp.tsx", { width: 1440, height: 900, host: { handlers: host.handlers } });
  await openSession(app, "Original review", { deviceId: OWNER });
  await app.press(`label:explore-group-explore:tool:${REPORT}`);
  await app.press("label:tool-card-submit_code_review");
  await app.waitFor("One check timed out.");
  expect(app.shows("label:review-open-coverage-retry")).toBe(false);
  expect(requests).toHaveLength(0);
});
