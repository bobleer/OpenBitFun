// Review launcher (wave 5): the "Review changes" sheet and `/review` ask the
// host's `launch_review` for everything — the dry-run reading of the changes,
// the refusals, and the child session the read-only reviewer runs in. The
// surface only sends the user's choices and opens the child it is given.

import { expect, open, test } from "nsh/test";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession as openSessionRowOf, withReviewLaunchFixtures } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };

async function openSession(backend: { handlers: Record<string, (data: unknown) => unknown> }) {
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSessionRowOf(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  return app;
}

test("the sheet reads the changes, launches a strict review and opens its child session", async () => {
  const backend = withReviewLaunchFixtures(createBackend());
  const app = await openSession(backend);

  await app.press("thread-actions-trigger");
  await app.press("review-launch-open");
  await app.waitFor("label:review-launcher");
  await app.waitFor("text:src/old_name.rs → src/new_name.rs");
  await app.waitFor("text:3 files · 21 changed lines");
  expect(backend.reviewRequests[0]).toMatchObject({
    parentSessionId: "session-1",
    workspaceId: "workspace-1",
    intent: "review",
    files: [],
    dryRun: true,
  });

  // Strict, one file left out, a focus: the host reads the narrowed scope again.
  await app.press("review-intent-strict");
  await app.waitFor("text:A deeper read-only review with an independent quality check. Takes longer and uses more tokens.");
  await app.press("label:review-file-src/review.rs");
  await app.waitFor("label:review-include-all");
  await app.type("review-focus", "Check the rename for lost history");
  await app.waitUntil(() => backend.reviewRequests.some(request =>
    request.dryRun === true && JSON.stringify(request.files) === JSON.stringify(["src/lib.rs", "src/new_name.rs"]),
  ));

  await app.press("review-start");
  await app.waitUntil(() => backend.reviewRequests.some(request => request.dryRun !== true));
  const launch = backend.reviewRequests.find(request => request.dryRun !== true)!;
  expect(launch).toMatchObject({
    parentSessionId: "session-1",
    intent: "strict",
    files: ["src/lib.rs", "src/new_name.rs"],
    focus: "Check the rename for lost history",
    childSessionName: "Review: Strict",
    displayMessage: "Strict review of the workspace changes",
  });
  expect(String(launch.requestId)).toMatch(/^review_/);
  // The child the host created is the session on screen; the sheet is gone.
  await app.waitUntil(() => !app.shows("label:review-launcher"));
  await app.waitUntil(() =>
    backend.calls.some(call =>
      call.action === "get_session_transcript_view" &&
      String((call.request as Record<string, unknown>)?.sessionId ?? (call.request as Record<string, unknown>)?.session_id ?? "").startsWith("review_child_"),
    ),
  );
  await app.waitFor("Review: Strict");
  // Nothing about the plan was built here: no prompt, no manifest went out.
  expect(JSON.stringify(backend.reviewRequests)).not.toContain("deepReviewRunManifest");
  expect(backend.actions()).not.toContain("create_session");
});

test("/review in the composer is read by the host instead of being sent as a turn", async () => {
  const backend = withReviewLaunchFixtures(createBackend());
  const app = await openSession(backend);

  await app.type("composer", "/review strict watch the locking");
  await app.submit("composer");
  await app.waitUntil(() => backend.reviewRequests.length > 0);
  expect(backend.reviewRequests[0]).toMatchObject({
    parentSessionId: "session-1",
    commandText: "/review strict watch the locking",
    childSessionName: "Review: Strict",
  });
  expect(backend.reviewRequests[0].dryRun).toBeUndefined();
  expect(backend.actions()).not.toContain("submit_user_message");
  expect(app.value("composer")).toBe("");
  await app.waitFor("Review: Strict");
});

test("a strict Git range is prepared and launched on the session owner and keeps its commit pair in the saved card", async () => {
  const sessionId = "s-range-parent";
  const childId = "s-range-review";
  const gitRange = { baseRevision: "1".repeat(40), headRevision: "2".repeat(40) };
  const backend = createBackend();
  const requests: Array<Record<string, unknown>> = [];
  let loseAcknowledgement = true;
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: Record<string, unknown> };
    if (args.action === "launch_review" && args.request) {
      requests.push(args.request);
      const summary = { intent: "strict", mode: "strict", agentType: "DeepReview", fileCount: 2, gitRange };
      if (!args.request.dryRun && loseAcknowledgement) {
        loseAcknowledgement = false;
        return { ok: false, error: "Review acknowledgement lost" };
      }
      return { ok: true, value: args.request.dryRun ? { status: "prepared", ...summary } : {
        status: "started", ...summary, childSessionId: childId, childSessionName: "Review: Strict", parentReviewCard: true,
      } };
    }
    if (args.action === "list_session_review_records") {
      return { ok: true, value: { records: requests.length === 3 && args.request?.sessionId === sessionId ? [{
        sessionId: childId, sessionName: "Review: Strict", agentType: "DeepReview", phase: "completed",
        freshness: "unknown", createdAt: 1763000005000, target: { kind: "git_range", ...gitRange },
        revision: { recordId: childId, number: 1 }, latestForRecord: true,
      }] : [] } };
    }
    return base(data);
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "entry" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("entry", "Controller", [], { isClientDevice: true }),
      fleetDeviceRow("range-owner", "Git owner", [{ workspaceId: "ws-range", name: "Git workspace",
        rootPath: "/owner/repo", kind: "local",
        sessions: [fleetSessionRow("range-owner", "ws-range", sessionId, "Git range parent")],
      }], { hostKind: "desktop", hostCapabilities: ["session_review_records_v1"], state: "online" }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSessionRowOf(app, "Git range parent");
  const commandText = "/review strict main..HEAD focus on locking";
  await app.type("composer", commandText);
  await app.submit("composer");
  await app.waitFor("Review acknowledgement lost");
  expect(app.value("composer")).toBe(commandText);
  await app.submit("composer");
  await app.waitFor("Review 1111111..2222222");
  expect(requests).toHaveLength(3);
  expect(requests[2]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({ parentSessionId: sessionId, workspaceId: "ws-range", commandText, dryRun: true });
  expect(requests[1]).toMatchObject({
    parentSessionId: sessionId, workspaceId: "ws-range", intent: "git_range",
    approvedGitRange: { commandText, ...gitRange }, displayMessage: "Review 1111111..2222222",
  });
  expect(requests[1].commandText).toBeUndefined();
  expect(host.fleetCalls.filter(call => call.command === "launch_review").map(call => call.target)).toEqual(["range-owner", "range-owner", "range-owner"]);
  expect(host.pageHostCalls).toHaveLength(0);
  expect(app.value("composer")).toBe("");
});

test("an older Review owner cannot launch a workspace review from a Git range command", async () => {
  const backend = withReviewLaunchFixtures(createBackend());
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = payload => {
    const reply = base(payload);
    if ((payload as { action?: string }).action !== "launch_review") return reply;
    return { ok: true, value: { status: "refused", code: "review_no_workspace_changes", intent: "review", fileCount: 0 } };
  };
  const app = await openSession(backend);
  const command = "/review commit HEAD";
  await app.type("composer", command);
  await app.submit("composer");
  await app.waitFor("Update the owning device to review a Git commit range.");
  expect(backend.reviewRequests).toHaveLength(1);
  expect(backend.reviewRequests[0]).toMatchObject({ commandText: command, dryRun: true });
  expect(app.shows("label:review-launcher")).toBe(false);
  expect(app.value("composer")).toBe(command);
  expect(backend.actions()).not.toContain("submit_user_message");
});

test("a background Review keeps its parent visible and opens the saved result only on demand", async () => {
  const backend = withReviewLaunchFixtures(createBackend(), { parentReviewCard: true });
  let settled = false;
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: { sessionId?: string; workspaceId?: string } };
    if (args.action !== "list_session_review_records") return base(data);
    backend.calls.push({ action: args.action, request: args.request, raw: false });
    const launched = backend.reviewRequests.find(request => !request.dryRun);
    const sessionId = launched && `review_child_${launched.requestId}`;
    const records = args.request?.sessionId === "session-1" && sessionId ? [{
      sessionId, sessionName: "Saved workspace Review", agentType: "CodeReview", parentSessionId: "session-1",
      createdAt: 1763000005000, phase: settled ? "completed" : "running", freshness: "unknown",
      target: { kind: "workspace" }, revision: { recordId: sessionId, number: 1 }, latestForRecord: true,
      ...(settled ? { outcome: { state: "available", findingCount: 1, riskLevel: "high",
        evidenceCoverage: "limited", assessment: "One result belongs to this workspace review." } } : {}),
    }] : [];
    return { ok: true, transport: "dev", value: { records } };
  };
  const app = await openSession(backend);
  await app.type("composer", "/review");
  await app.submit("composer");
  await app.waitFor("id:session-review-records");
  await app.waitFor("Review workspace changes");
  expect(app.texts()).toContain("Port the session list.");
  expect(backend.calls.find(call => call.action === "list_session_review_records")?.request).toMatchObject({
    sessionId: "session-1", workspaceId: "workspace-1",
  });
  const child = `review_child_${backend.reviewRequests[0].requestId}`;
  const childWasRead = () => backend.calls.some(call => call.action === "get_session_transcript_view" &&
    (call.request as { session_id?: string } | undefined)?.session_id === child);
  expect(childWasRead()).toBe(false);

  settled = true;
  await app.host.send("openbitfun.event", { event: "agentic://session-history-changed", payload: { sessionId: child } });
  await app.waitUntil(() => app.texts().some(text => text.includes("One result belongs to this workspace review.")));
  expect(childWasRead()).toBe(false);
  expect(app.accessibility(`id:session-review-record-${child}`)).toMatchObject({
    role: "button", label: "Review workspace changes",
  });
  await app.press(`id:session-review-record-${child}`);
  await app.waitUntil(childWasRead);
});

test("the chat Review card reads the session owner's saved PR result over fleet", async () => {
  const backend = createBackend();
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: { sessionId?: string } };
    if (args.action !== "list_session_review_records") return base(data);
    return { ok: true, transport: "dev", value: { records: args.request?.sessionId === "s-review-parent" ? [{
      sessionId: "saved-pr-child", sessionName: "Stored PR report", agentType: "CodeReview", phase: "completed",
      freshness: "unknown", createdAt: 1763000005000, target: { kind: "pull_request", number: 17, projectPath: "example/repo" },
      revision: { recordId: "pr-anchor", number: 2, previousSessionId: "pr-anchor" }, latestForRecord: true,
      outcome: { state: "available", findingCount: 0, evidenceCoverage: "complete" },
    }] : [] } };
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "entry" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("entry", "Controller entry", [], { isClientDevice: true }),
      fleetDeviceRow("review-owner", "Review owner", [{ workspaceId: "ws-review", name: "Review workspace",
        rootPath: "/owner/repo", kind: "local",
        sessions: [fleetSessionRow("review-owner", "ws-review", "s-review-parent", "PR parent chat")],
      }], { hostKind: "desktop", hostCapabilities: ["session_review_records_v1"], state: "online" }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSessionRowOf(app, "PR parent chat");
  await app.waitFor("Review PR #17 · example/repo");
  expect(app.texts()).toContain("0 findings · Complete evidence coverage");
  expect(host.fleetCalls.find(call => call.command === "list_session_review_records")).toMatchObject({
    target: "review-owner", args: { request: { workspaceId: "ws-review", sessionId: "s-review-parent" } },
  });
  expect(host.pageHostCalls).toHaveLength(0);
});

test("/review in a split composer uses that session and opens its child in the same pane", async () => {
  const backend = withReviewLaunchFixtures(createBackend());
  const app = await openSession(backend);
  await app.type("composer", "Primary draft");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("Port the terminal.");
  await app.type("secondary-composer", "/review strict split changes");
  await app.submit("secondary-composer");
  await app.waitUntil(() => backend.reviewRequests.length > 0);
  expect(backend.reviewRequests[0]).toMatchObject({
    parentSessionId: "session-2", workspaceId: "workspace-1", commandText: "/review strict split changes",
  });
  await app.waitFor("Review: Strict");
  expect(app.texts()).toContain("Port the session list.");
  expect(app.value("composer")).toBe("Primary draft");
});

test("an older host's oversized target can be narrowed in the sheet", async () => {
  const files = Array.from({ length: 82 }, (_, index) => ({ path: `src/f${index}.rs`, status: "modified" }));
  const backend = withReviewLaunchFixtures(createBackend(), { files });
  const app = await openSession(backend);

  await app.press("thread-actions-trigger");
  await app.press("review-launch-open");
  await app.waitFor(
    "text:This change touches 82 files. Review covers up to 80 files in one run; leave some out below, or choose Strict.",
  );
  await app.waitFor("label:review-file-src/f0.rs");
  expect(app.enabled("label:review-start")).toBe(false);

  await app.press("label:review-file-src/f0.rs");
  await app.press("label:review-file-src/f1.rs");
  await app.waitUntil(() => !app.shows("label:review-notice"));
  await app.press("review-start");
  await app.waitUntil(() => backend.reviewRequests.some(request => request.dryRun !== true));
  const launch = backend.reviewRequests.find(request => request.dryRun !== true)!;
  expect((launch.files as string[]).length).toBe(80);
  expect(launch.files).not.toContain("src/f0.rs");
  expect(launch.intent).toBe("review");
});

test("ordinary Review shows the host's batch coverage and launches the full selected scope", async () => {
  const files = Array.from({ length: 82 }, (_, index) => ({ path: `src/f${index}.rs`, status: "modified" }));
  const backend = withReviewLaunchFixtures(createBackend(), { files, managedFileBudget: 80 });
  const app = await openSession(backend);

  await app.press("thread-actions-trigger");
  await app.press("review-launch-open");
  await app.waitFor("text:Read-only batches cover 80 files. 2 files are outside this run’s coverage.");
  expect(app.enabled("label:review-start")).toBe(true);

  await app.press("review-start");
  await app.waitUntil(() => backend.reviewRequests.some(request => !request.dryRun));
  expect(backend.reviewRequests.find(request => !request.dryRun)).toMatchObject({
    parentSessionId: "session-1",
    intent: "review",
    files: [],
    childSessionName: "Review",
  });
  await app.waitFor("Review");
  await app.waitUntil(() => !app.shows("label:review-launcher"));
});

test("a remote workspace and an older host each say why there is no review", async () => {
  const remote = withReviewLaunchFixtures(
    createBackend({ currentWorkspaceId: "workspace-2" }),
  );
  const first = await open("../App.tsx", { ...DESKTOP, host: { handlers: remote.handlers } });
  // The session of the remote workspace (each workspace of the fixture lists the same titles).
  await openSessionRowOf(first, "NSH skeleton");
  await first.press("label:sidebar-workspace-workspace-2 >> NSH skeleton");
  await first.press("thread-actions-trigger");
  await first.press("review-launch-open");
  await first.waitFor(
    "text:Review is not available for remote workspaces yet: exact diff evidence is only prepared for a local checkout.",
  );
  expect(first.enabled("label:review-start")).toBe(false);
  expect(remote.reviewRequests.every(request => request.dryRun === true)).toBe(true);

  const older = withReviewLaunchFixtures(createBackend(), { missing: true });
  const second = await openSession(older);
  await second.press("thread-actions-trigger");
  await second.press("review-launch-open");
  await second.waitFor("text:This device cannot start a Review. Update OpenBitFun on it to use it.");
  expect(second.enabled("label:review-start")).toBe(false);
});
