import { expect, open, test } from "nsh/test";
import { formatTimestamp } from "../src/format";
import { messageWithSessionReferences, sessionReferenceDraft } from "../src/sessionReferences";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession, openToolScene } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "windows" as const };
const SNAPSHOT = "review_platform_get_workspace_snapshot";
const DETAIL = "review_platform_get_pull_request_detail_page";
const CI_LOG = "review_platform_get_pull_request_ci_log";
const LAUNCH_REVIEW = "review_platform_launch_pull_request_review";
const HISTORY = "review_platform_list_pull_request_reviews";
const SAVE_TOKEN = "review_platform_update_auth_token";
const CLEAR_TOKEN = "review_platform_clear_auth_token";
const pr = {
  id: "review-17", providerId: "upstream", number: 17, title: "Update release notes",
  state: "open", author: "alex", sourceBranch: "release", targetBranch: "main",
  webUrl: "https://github.com/example/project/pull/17", changedFiles: 1, comments: 1, reviewDecision: "pending",
  baseRevision: "a".repeat(40), headRevision: "b".repeat(40),
  checks: { total: 1, passed: 0, failed: 1, pending: 0 },
};
const diff = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-old\n+new release note";

function reviewBackend({ unsupported = false, launch = (request: Record<string, unknown>) => ({
  ok: true, value: { status: "started", intent: "review", mode: "standard", fileCount: 1, agentType: "CodeReview",
    childSessionId: "pr-review-child", childSessionName: request.childSessionName },
}), history = () => ({ runs: [] }) }: {
  unsupported?: boolean;
  launch?: (request: Record<string, unknown>) => { ok: boolean; value?: unknown; error?: string };
  history?: (request: Record<string, unknown>) => unknown;
} = {}) {
  const backend = createBackend({ hostQueue: true });
  const calls: Array<{ command: string; request: Record<string, unknown> }> = [];
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const { action = "", request = {} } = (data ?? {}) as { action?: string; request?: Record<string, unknown> };
    const reply = (value: unknown) => ({ ok: true, value, transport: "dev" });
    if (action === "git_is_repository") return reply(true);
    if (action === "git_get_repository_trust") return reply({ state: "trusted" });
    if (action === "git_get_status") return reply({ staged: [], unstaged: [], untracked: [], conflicts: [] });
    if (["git_get_branches", "git_get_commits", "git_list_worktrees"].includes(action)) return reply([]);
    if (action === HISTORY) {
      backend.calls.push({ action, request, raw: false });
      return reply(history(request));
    }
    if (![SNAPSHOT, DETAIL, CI_LOG, LAUNCH_REVIEW].includes(action)) return base(data);
    calls.push({ command: action, request });
    if (unsupported) return { ok: false, error: `unknown command: ${action}` };
    if (action === LAUNCH_REVIEW) return launch(request);
    if (action === SNAPSHOT) {
      return reply({
        remotes: [{ id: "upstream", name: "upstream", projectPath: "example/project",
          webUrl: "https://github.com/example/project", platform: "github", host: "github.com", supported: true },
          { id: "origin", name: "origin", projectPath: "example/fork",
            webUrl: "https://github.com/example/fork", platform: "github", host: "github.com", supported: true }],
        selectedRemoteId: request.remoteId ?? "upstream",
        repository: { projectPath: "example/project" },
        pullRequests: request.page === 2 ? [{ ...pr, id: "review-18", number: 1018, title: "Next page request" }] : [pr],
        pagination: { page: request.page, hasNext: request.page === 1 },
        capabilities: { supportedPullRequestStates: ["all", "open", "merged"] },
      });
    }
    if (action === CI_LOG) return reply({ log: "Fixture job failed at the release validation step.", truncated: true });
    return reply({
      ...pr, body: "Document how we ship the next release.",
      files: request.section === "files" ? [{ path: "notes.md", status: "modified", additions: 1, deletions: 1, patch: diff }] : [],
      ci: request.section === "ci" ? [{ id: "job-1", name: "Validate release", status: "completed", conclusion: "failure" }] : [],
      commits: request.section === "commits" ? [{ hash: "abcdef", shortHash: "abc", title: "Write notes", author: "alex", committedAt: "2026-11-24T00:00:00Z" }] : [],
      threads: request.section === "reviews" ? [{ id: "comment-1", kind: "comment", author: "riley", body: "Please check the notes.",
        filePath: "notes.md", line: 1, resolved: false, updatedAt: "2026-11-24T00:00:00Z" }] : [],
      pagination: { page: request.page, hasNext: false },
    });
  };
  return { backend, calls };
}

test("Git pull requests page through the workspace and put the selected overview, diff and check log in the draft", async () => {
  const { backend, calls } = reviewBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.press("session-tool-git");
  await app.press("git-tab-pull-requests");
  await app.waitFor("id:pr-row-review-17");
  await app.press("Next");
  await app.waitFor("id:pr-row-review-18");
  await app.waitFor("#1018 Next page request");
  expect(calls.at(-1)).toMatchObject({ command: SNAPSHOT,
    request: { workspaceId: "workspace-1", repositoryPath: "/repo", page: 2, remoteId: null } });
  await app.press("Previous");
  await app.press("id:pr-row-review-17");
  await app.waitFor("Document how we ship the next release.");
  await app.press("pr-add-section");
  await app.waitFor("composer-prompt-reference-pull-request-PR #17 Overview");
  await app.press("id:pr-section-files");
  await app.press("pr-show-diff-notes.md");
  await app.press("pr-add-file-notes.md");
  await app.waitFor("composer-prompt-reference-pull-request-PR #17 notes.md");
  await app.press("id:pr-section-reviews");
  await app.waitFor("Please check the notes.");
  await app.press("id:pr-section-commits");
  await app.waitFor("Write notes");
  await app.press("id:pr-section-ci");
  await app.press("pr-add-check-job-1");
  await app.waitFor("composer-prompt-reference-pull-request-PR #17 CI · Validate release");
  expect(calls.at(-1)).toMatchObject({ command: CI_LOG, request: {
    workspaceId: "workspace-1", repositoryPath: "/repo", pullRequestId: "review-17",
    remoteId: "upstream", ciItemId: "job-1", ciItemName: "Validate release",
  } });
  expect(backend.actions()).not.toContain("submit_user_message");
  await app.press("Send");
  const request = backend.calls.find(call => call.action === "submit_user_message")?.request as {
    text?: string; userMessageMetadata?: { composerPresentation?: unknown };
  };
  expect(request).toMatchObject({ sessionId: "session-1", workspaceId: "workspace-1" });
  expect(request.text).toContain("#pr:PR_#17_Overview");
  expect(request.text).toContain(diff);
  expect(request.text).toContain("Fixture job failed at the release validation step.");
  const presentation = request.userMessageMetadata?.composerPresentation;
  const restored = sessionReferenceDraft(presentation);
  expect(restored?.references).toEqual([]);
  expect(messageWithSessionReferences(restored!.text, []).text).toBe(request.text);
});

test("the review surface routes remote workspace reads and the draft to the owning runtime", async () => {
  const { backend } = reviewBackend();
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 2, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Review runtime", [{ workspaceId: "ws-b", name: "SSH workspace",
          rootPath: "/srv/team/repo", kind: "remote_ssh",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Remote review chat")],
        }], { hostKind: "desktop", state: "online" }),
      ],
    },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSession(app, "Remote review chat");
  await app.press("session-tool-git");
  await app.press("git-tab-pull-requests");
  await app.press("id:pr-row-review-17");
  await app.press("pr-add-section");
  await app.waitFor("composer-prompt-reference-pull-request-PR #17 Overview");
  await app.press("Send");
  for (const command of [SNAPSHOT, DETAIL, "submit_user_message"]) {
    expect(host.fleetCalls.find(call => call.command === command)).toMatchObject({ target: "dev-b",
      args: { request: { workspaceId: "ws-b" } } });
  }
  expect(host.fleetCalls.find(call => call.command === DETAIL)?.args).toMatchObject({ request: {
    repositoryPath: "/srv/team/repo", pullRequestId: "review-17", remoteId: "upstream", section: "overview",
  } });
  expect(host.pageHostCalls).toHaveLength(0);
});

async function openPullRequest(app: Awaited<ReturnType<typeof open>>, title: string) {
  await openSession(app, title);
  await app.press("session-tool-git");
  await app.press("git-tab-pull-requests");
  await app.press("id:pr-row-review-17");
  await app.waitFor("pr-start-review");
}

test("Review binds the displayed provider and commits and opens a child beside the parent draft", async () => {
  const { backend, calls } = reviewBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openPullRequest(app, "NSH skeleton");
  await app.type("composer", "Keep my draft");
  await app.press("pr-start-review");
  await app.waitFor("Review: PR #17");
  expect(app.value("composer")).toBe("Keep my draft");
  expect(calls.find(call => call.command === LAUNCH_REVIEW)?.request).toMatchObject({
    parentSessionId: "session-1", workspaceId: "workspace-1", remoteId: "upstream", pullRequestId: "review-17",
    provider: { platform: "github", host: "github.com", projectPath: "example/project" },
    expectedBaseRevision: pr.baseRevision, expectedHeadRevision: pr.headRevision,
    childSessionName: "Review: PR #17",
  });
  expect(calls.find(call => call.command === LAUNCH_REVIEW)?.request.repositoryPath).toBe(undefined);
  expect(backend.actions()).not.toContain("launch_review");
  expect(backend.actions()).not.toContain("submit_user_message");
});

test("a stale target refreshes the repository and detail without silently restarting Review", async () => {
  const { backend, calls } = reviewBackend({ launch: () => ({ ok: true,
    value: { status: "refused", intent: "review", code: "review_pull_request_changed", fileCount: 0 } }) });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openPullRequest(app, "NSH skeleton");
  await app.press("pr-start-review");
  await app.waitFor("The pull request or its repository changed. Refresh before starting the review.");
  const snapshotReads = calls.filter(call => call.command === SNAPSHOT).length;
  await app.press("Refresh");
  await app.waitUntil(() => calls.filter(call => call.command === SNAPSHOT).length > snapshotReads);
  await app.waitFor("Document how we ship the next release.");
  expect(calls.filter(call => call.command === LAUNCH_REVIEW)).toHaveLength(1);
  expect(app.shows("Review: PR #17")).toBe(false);
});

const previousReview = {
  sessionId: "previous-review", sessionName: "Previous PR review", agentType: "CodeReview",
  parentSessionId: "parent-from-history", createdAt: 1763000005000,
  phase: "completed", freshness: "stale", preparedEvidenceLimited: true,
};

test("PR history stays visible after reopening and can open an older result in its workspace", async () => {
  const cursor = { createdAt: previousReview.createdAt, sessionId: previousReview.sessionId };
  const { backend, calls } = reviewBackend({ history: request => request.before
    ? { runs: [{ ...previousReview, sessionId: "older-review", sessionName: "Older attempt", phase: "interrupted", freshness: "unknown" }] }
    : { runs: [previousReview], nextCursor: cursor } });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openPullRequest(app, "NSH skeleton");
  await app.waitFor("Review history");
  const date = formatTimestamp(previousReview.createdAt);
  await app.waitFor(`text:Completed · Older commits · Limited prepared evidence · ${date}`);
  expect(backend.calls.find(call => call.action === HISTORY)?.request).toMatchObject({
    workspaceId: "workspace-1",
    selection: { platform: "github", host: "github.com", projectPath: "example/project", pullRequestId: "review-17",
      baseRevision: pr.baseRevision, headRevision: pr.headRevision },
  });
  await app.press("pr-review-older");
  await app.waitFor(`text:Interrupted · Commit match unknown · Limited prepared evidence · ${date}`);
  expect(backend.calls.filter(call => call.action === HISTORY).at(-1)?.request).toMatchObject({ before: cursor });
  await app.press("pr-review-newer");
  await app.waitFor("id:pr-review-run-previous-review");
  await app.press("pr-back");
  await app.press("id:pr-row-review-17");
  await app.press("id:pr-review-run-previous-review");
  await app.waitFor("Previous PR review");
  expect(calls.filter(call => call.command === LAUNCH_REVIEW)).toHaveLength(0);
});

test("PR history shows saved findings and keeps old or missing reports distinct from zero findings", async () => {
  const { backend } = reviewBackend({ history: () => ({ runs: [
    { ...previousReview, outcome: { state: "available", findingCount: 2, riskLevel: "high",
      recommendedAction: "request_changes", evidenceCoverage: "limited", targetChangedDuringReview: true,
      assessment: "The report found two risks in the shipped change." } },
    { ...previousReview, sessionId: "without-report", sessionName: "No report run", outcome: { state: "missing" } },
    { ...previousReview, sessionId: "legacy-run", sessionName: "Legacy result" },
    { ...previousReview, sessionId: "deferred-run", sessionName: "Limited scope",
      outcome: { state: "available", findingCount: 4, evidenceCoverage: "complete" } },
  ] }) });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openPullRequest(app, "NSH skeleton");
  await app.waitFor("id:pr-review-run-previous-review");
  expect(app.texts()).toContain("2 findings · Risk level High · Limited evidence coverage · Target changed during the review\nAI recommendation · Request changes\nThe report found two risks in the shipped change.");
  expect(app.texts()).toContain("This run did not submit a structured report.");
  expect(app.texts()).toContain("Open the review to see the report.");
  expect(app.texts()).toContain("4 findings");
  expect(app.texts()).not.toContain("4 findings · Complete evidence coverage");
  expect(app.texts().some(text => text.includes("0 findings"))).toBe(false);
  expect(backend.calls.some(call => call.action === "get_session_transcript_view" &&
    (call.request as { session_id?: string } | undefined)?.session_id === previousReview.sessionId)).toBe(false);
});

test("a stale PR review starts a linked revision from the original owning chat", async () => {
  const root = { ...previousReview, revision: { recordId: previousReview.sessionId, number: 1 },
    latestForRecord: true, recordHistoryComplete: true };
  const { backend, calls } = reviewBackend({ history: () => ({ supportsLinkedReReview: true, runs: [root,
    { ...root, sessionId: "not-latest", latestForRecord: false },
    { ...root, sessionId: "broken-record", recordHistoryComplete: false },
  ] }) });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openPullRequest(app, "NSH skeleton");
  await app.waitFor("Review current version");
  expect(app.shows("pr-rereview-not-latest")).toBe(false);
  expect(app.shows("pr-rereview-broken-record")).toBe(false);
  expect(app.texts()).toContain("Review history is incomplete.");
  await app.press("pr-rereview-previous-review");
  await app.waitFor("Review: PR #17");
  const request = calls.find(call => call.command === LAUNCH_REVIEW)?.request;
  expect(request).toMatchObject({
    previousReviewSessionId: root.sessionId,
    workspaceId: "workspace-1", expectedBaseRevision: pr.baseRevision, expectedHeadRevision: pr.headRevision,
  });
  expect(request?.parentSessionId).toBeUndefined();
});

test("older runtimes without a linked re-review contract still expose ordinary Review", async () => {
  const { backend } = reviewBackend({ history: () => ({ runs: [{ ...previousReview,
    revision: { recordId: previousReview.sessionId, number: 1 }, latestForRecord: true, recordHistoryComplete: true }] }) });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openPullRequest(app, "NSH skeleton");
  await app.waitFor("id:pr-review-run-previous-review");
  expect(app.shows("pr-rereview-previous-review")).toBe(false);
  expect(app.shows("pr-start-review")).toBe(true);
});

test("PR history can reopen a preceding revision outside the current page", async () => {
  const { backend, calls } = reviewBackend({ history: () => ({ supportsLinkedReReview: true, runs: [{
    ...previousReview, sessionId: "current-revision", freshness: "current",
    revision: { recordId: "first-revision", previousSessionId: "first-revision", number: 2 },
    latestForRecord: true, recordHistoryComplete: true,
  }] }) });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openPullRequest(app, "NSH skeleton");
  await app.waitFor("Review again");
  await app.press("pr-rereview-previous-current-revision");
  await app.waitUntil(() => backend.calls.some(call => call.action === "get_session_transcript_view" &&
    (call.request as { session_id?: string } | undefined)?.session_id === "first-revision"));
  expect(calls.some(call => call.command === LAUNCH_REVIEW)).toBe(false);
});

test("a running current review can be opened and settles from a refreshed owner response", async () => {
  let reads = 0;
  const active = { ...previousReview, sessionId: "active-review", sessionName: "Current review",
    phase: "running", freshness: "current", preparedEvidenceLimited: false };
  const { backend, calls } = reviewBackend({ history: () => ++reads === 1
    ? { runs: [active], currentRunning: active }
    : { runs: [{ ...active, phase: "completed" }] } });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.press("session-tool-git");
  await app.press("git-tab-pull-requests");
  await app.press("id:pr-row-review-17");
  await app.waitFor("pr-open-running-review");
  expect(app.shows("pr-start-review")).toBe(false);
  await app.waitFor(`text:Completed · Matches shown commits · ${formatTimestamp(previousReview.createdAt)}`);
  await app.waitFor("pr-start-review");
  expect(calls.filter(call => call.command === LAUNCH_REVIEW)).toHaveLength(0);
  expect(reads).toBeGreaterThan(1);
});

function launchFleetFixture(capable: boolean, ssh: boolean, history?: () => unknown) {
  const { backend } = reviewBackend({ history });
  return fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 2, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Review runtime", [{ workspaceId: "ws-b", name: "Review workspace",
          rootPath: "/owner/repo", kind: ssh ? "remote_ssh" : "local",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Owner chat")],
        }], { hostKind: "desktop", state: "online",
          hostCapabilities: capable ? ["pull_request_review_launch_v1", "pull_request_review_history_v1"] : ["review_platform_v1"] }),
      ],
    },
  });
}

test("a browser controller starts PR Review on the parent owner with the advertised capability", async () => {
  const host = launchFleetFixture(true, false, () => ({ runs: [{ ...previousReview,
    preparedEvidenceLimited: false,
    outcome: { state: "available", findingCount: 0, riskLevel: "low", evidenceCoverage: "complete" } }] }));
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openPullRequest(app, "Owner chat");
  await app.waitFor("text:0 findings · Risk level Low · Complete evidence coverage");
  await app.press("pr-start-review");
  await app.waitFor("Review: PR #17");
  expect(host.fleetCalls.find(call => call.command === LAUNCH_REVIEW)).toMatchObject({
    target: "dev-b", args: { request: { workspaceId: "ws-b", parentSessionId: "s-b1", remoteId: "upstream", pullRequestId: "review-17" } },
  });
  expect(host.fleetCalls.find(call => call.command === HISTORY)).toMatchObject({
    target: "dev-b", args: { request: { workspaceId: "ws-b", selection: { pullRequestId: "review-17" } } },
  });
  expect(host.pageHostCalls).toHaveLength(0);
});

test("a browser controller sends a linked review revision to the owning runtime", async () => {
  const host = launchFleetFixture(true, false, () => ({ supportsLinkedReReview: true, runs: [{ ...previousReview,
    parentSessionId: "s-b1", revision: { recordId: "previous-review", number: 1 },
    latestForRecord: true, recordHistoryComplete: true,
  }] }));
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openPullRequest(app, "Owner chat");
  await app.press("pr-rereview-previous-review");
  await app.waitFor("Review: PR #17");
  expect(host.fleetCalls.find(call => call.command === LAUNCH_REVIEW)).toMatchObject({
    target: "dev-b", args: { request: { previousReviewSessionId: "previous-review", workspaceId: "ws-b" } },
  });
  expect(host.pageHostCalls).toHaveLength(0);
});

test("PR Review gives explicit feedback for older owners and SSH workspaces", async () => {
  for (const ssh of [false, true]) {
    const host = launchFleetFixture(ssh, ssh);
    const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
    await openPullRequest(app, "Owner chat");
    await app.press("pr-start-review");
    await app.waitFor(ssh ? "Pull request review is currently unavailable for SSH workspaces."
      : "Update OpenBitFun on this workspace’s runtime to start pull request reviews.");
    expect(host.fleetCalls.some(call => call.command === LAUNCH_REVIEW || call.command === "launch_review")).toBe(false);
  }
});

test("a runtime without review platform commands gets an explicit state", async () => {
  const { backend } = reviewBackend({ unsupported: true });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await openToolScene(app, "git");
  await app.press("git-tab-pull-requests");
  await app.waitFor("This workspace's runtime does not support pull request browsing.");
  expect(app.shows("No pull requests match this view.")).toBe(false);
});

test("a PR outside the list opens by link or number on the matching workspace remote", async () => {
  const { backend, calls } = reviewBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await openToolScene(app, "git");
  await app.press("git-tab-pull-requests");
  await app.type("pr-lookup", "https://github.com/another/project/pull/28");
  await app.press("pr-lookup-open");
  await app.waitFor("Enter a number or a pull request link from this workspace’s remotes.");
  expect(calls.some(call => call.command === DETAIL)).toBe(false);
  await app.press("Clear");
  await app.type("pr-lookup", "https://github.com/Example/Fork/pull/28");
  expect(app.value("pr-lookup")).toBe("https://github.com/Example/Fork/pull/28");
  await app.press("pr-lookup-open");
  await app.waitFor("Document how we ship the next release.");
  expect(calls.at(-1)).toMatchObject({ command: DETAIL, request: { remoteId: "origin", pullRequestId: "28" } });
  await app.press("Clear");
  await app.type("pr-lookup", "#29");
  await app.press("pr-lookup-open");
  await app.waitFor("Document how we ship the next release.");
  expect(calls.at(-1)).toMatchObject({ command: DETAIL, request: { remoteId: "upstream", pullRequestId: "29" } });
});

test("a saved main-format PR capsule survives transcript edit and rerun", async () => {
  const { backend } = reviewBackend();
  const base = backend.handlers["openbitfun.invoke"];
  const context = {
    id: "previous-pr", timestamp: 1763150000000, type: "pull-request", label: "PR #17 CI · Validate release",
    section: "ci", content: "Release validation failed.", remoteId: "upstream", repository: "example/project",
    pullRequestNumber: 17, pullRequestTitle: pr.title, sourceUrl: pr.webUrl,
    metadata: { ciItemId: "job-1", ciLogTruncated: true },
  };
  const tag = "#pr:PR_#17_CI_·_Validate_release";
  const presentation = { version: 1, segments: [
    { kind: "text", text: "Explain " },
    { kind: "context", context, tag, label: context.label, title: context.label },
  ] };
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: Record<string, unknown> };
    if (args.action !== "get_session_transcript_view" || args.request?.session_id !== "session-1") return base(data);
    return { ok: true, value: { sessionId: "session-1", mode: "full", hasEarlier: false,
      turns: [{ turnId: "review-history", turnIndex: 0, kind: "user_dialog", status: "done", settled: true,
        user: { id: "pr-user", text: `Explain ${tag}`, composerPresentation: presentation, timestampMs: 1763150000000 },
        items: [], startTimeMs: 1763150000000, assistantTimestampMs: 1763150001000 }] } };
  };
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor(`user-prompt-reference-pull-request-${context.label}`);
  await app.press("edit-rerun-review-history");
  await app.waitFor(`rerun-prompt-reference-pull-request-${context.label}`);
  await app.press("Roll back and rerun");
  await app.waitUntil(() => backend.actions().includes("submit_user_message"));
  const request = backend.calls.find(call => call.action === "submit_user_message")?.request as { text?: string };
  expect(request.text).toContain(`Section: ci\nRelease validation failed.\n\nExplain ${tag}`);
  expect(request).toMatchObject({ userMessageMetadata: { composerPresentation: presentation } });
});

function reviewAuthHost(platform: "github" | "gitlab", canOpenHostTerminal = true) {
  const { backend } = reviewBackend();
  const base = backend.handlers["openbitfun.invoke"];
  const providerHost = platform === "github" ? "github.com" : "gitlab.example";
  let saved = false;
  let failNextSave = true;
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: Record<string, unknown> };
    if (args.action === SAVE_TOKEN) {
      if (failNextSave) {
        failNextSave = false;
        return { ok: false, error: `Untrusted provider echoed ${args.request?.token}` };
      }
      saved = true;
      return { ok: true };
    }
    if (args.action === CLEAR_TOKEN) {
      saved = false;
      return { ok: true };
    }
    if (args.action === SNAPSHOT) {
      return { ok: true, value: {
        remotes: [{ id: "upstream", name: "upstream", projectPath: "example/project",
          platform, host: providerHost, webUrl: `https://${providerHost}/example/project`, supported: true,
          authState: saved ? "connected" : "not_connected", authSource: saved ? "stored" : "none" }],
        selectedRemoteId: "upstream", pagination: { page: 1, hasNext: false },
        pullRequests: saved ? [pr] : [],
        authChallenge: saved ? null : { remoteId: "upstream", state: "missing",
          requiredScopes: ["read_api"], message: "Provider authentication is required." },
      } };
    }
    return base(data);
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: { revision: 2, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Controller entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Review runtime", [{ workspaceId: "ws-b", name: "SSH workspace",
          kind: "remote_ssh", rootPath: "/srv/team/repo", connectionId: "ssh-team",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Remote review chat")],
        }], { hostCapabilities: canOpenHostTerminal ? ["fleet_v1", "host_terminal_workspace_v1"] : ["fleet_v1"] }),
      ],
    },
  });
  return host;
}

async function openAuth(app: Awaited<ReturnType<typeof open>>) {
  await openSession(app, "Remote review chat");
  await app.press("session-tool-git");
  await app.press("git-tab-pull-requests");
  await app.press("pr-auth-open");
  await app.waitFor("pr-auth-dialog");
}

test("provider credentials are saved and cleared on the selected runtime after confirmation", async () => {
  const host = reviewAuthHost("gitlab");
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openAuth(app);
  await app.waitFor("Required permissions · read_api");
  expect(app.enabled("pr-auth-save")).toBe(false);
  await app.type("pr-auth-token", "  fixture-token-do-not-display  ");
  await app.press("pr-auth-save");
  await app.waitFor("The workspace runtime could not save the token. Try again.");
  expect(app.texts().join("\n")).not.toContain("Untrusted provider echoed");
  await app.press("pr-auth-save");
  await app.waitFor("id:pr-row-review-17");
  expect(host.fleetCalls.filter(call => call.command === SAVE_TOKEN)).toHaveLength(2);
  expect(host.fleetCalls.find(call => call.command === SAVE_TOKEN)).toMatchObject({
    target: "dev-b", args: { request: { platform: "gitlab", host: "gitlab.example", token: "fixture-token-do-not-display" } },
  });
  await app.press("id:pr-row-review-17");
  await app.waitFor("Document how we ship the next release.");
  await app.press("pr-detail-auth-open");
  await app.waitFor("gitlab.example · Review runtime · Connected");
  expect(app.enabled("pr-auth-save")).toBe(false);
  await app.press("pr-auth-clear");
  expect(host.fleetCalls.some(call => call.command === CLEAR_TOKEN)).toBe(false);
  await app.press("pr-auth-confirm-clear");
  await app.waitFor("Saved token cleared.");
  expect(host.fleetCalls.find(call => call.command === CLEAR_TOKEN)).toMatchObject({
    target: "dev-b", args: { request: { platform: "gitlab", host: "gitlab.example" } },
  });
  expect(host.pageHostCalls).toHaveLength(0);
});

test("GitHub sign-in opens the owner terminal for an SSH workspace and leaves the command on the clipboard", async () => {
  const host = reviewAuthHost("github");
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openAuth(app);
  await app.waitFor("gh auth login --hostname github.com");
  expect(app.shows("pr-auth-token")).toBe(false);
  await app.press("pr-auth-terminal");
  await app.waitFor("terminal-viewport");
  expect(app.clipboard()).toBe("gh auth login --hostname github.com");
  expect(host.fleetCalls.filter(call => call.command === "terminal_create")).toHaveLength(1);
  expect(host.fleetCalls.find(call => call.command === "terminal_create")).toMatchObject({
    target: "dev-b", args: { request: { workspaceId: "ws-b",
      hostWorkspaceTarget: { rootPath: "/srv/team/repo", connectionId: "ssh-team" } } },
  });
  const create = host.fleetCalls.find(call => call.command === "terminal_create")?.args.request as { workingDirectory?: string };
  expect(create.workingDirectory).toBe(undefined);
  expect(host.fleetCalls.some(call => ["terminal_send_command", "terminal_write", SAVE_TOKEN].includes(call.command))).toBe(false);
  expect(host.pageHostCalls).toHaveLength(0);
});

test("GitHub sign-in on an older runtime keeps the copy path without launching a workspace shell", async () => {
  const host = reviewAuthHost("github", false);
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openAuth(app);
  await app.waitFor("Open a terminal on Review runtime to sign in.");
  expect(app.enabled("pr-auth-terminal")).toBe(false);
  await app.press("pr-auth-copy-command");
  expect(app.clipboard()).toBe("gh auth login --hostname github.com");
  expect(host.fleetCalls.some(call => call.command === "terminal_create")).toBe(false);
});
