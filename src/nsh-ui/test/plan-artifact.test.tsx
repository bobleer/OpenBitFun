import { expect, open, test } from "nsh/test";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const PROJECT_FILE = "/repo/.openbitfun/plans/release.plan.md";
const RUNTIME_FILE = "openbitfun://runtime/ws-b/plans/release.plan.md";
const PLAN = "---\nname: Release review\noverview: Verify the rollout notes\ntodos:\n" +
  "  - id: a\n    content: Review change list\n    status: completed\n" +
  "  - id: b\n    content: Confirm test evidence\n    status: pending\n---\n\n# Rollout steps\n";

function planHost(path: string, sessionId: string, legacy = false) {
  const host = createBackend();
  const base = host.handlers["openbitfun.invoke"];
  const files = new Map([[path, PLAN]]);
  const actions: Array<{ action: string; request: Record<string, unknown> }> = [];
  host.handlers["openbitfun.invoke"] = (data: unknown) => {
    const call = data as { action: string; request?: Record<string, unknown> };
    const request = call.request ?? {};
    actions.push({ action: call.action, request });
    const ok = (value: unknown) => ({ ok: true, value, transport: "dev" });
    if (call.action === "read_file_content") {
      const content = files.get(String(request.filePath));
      return content === undefined ? base(data) : ok(content);
    }
    if (call.action === "create_directory") return ok(null);
    if (call.action === "write_file_content") {
      const destination = String(request.filePath);
      if (files.has(destination) && request.expectedHash === "") {
        return { ok: false, error: "FILE_CONFLICT: destination already exists", transport: "dev" };
      }
      files.set(destination, String(request.content));
      return ok(null);
    }
    if (call.action !== "get_session_transcript_view" || request.session_id !== sessionId) return base(data);
    return ok({ sessionId, mode: "full", turns: [{
      turnId: "plan-turn", turnIndex: 0, kind: "user_dialog", status: "done", settled: true,
      user: { id: "plan-user", text: "Plan the release", timestampMs: 1 },
      items: [{ kind: "tool", roundIndex: 0, tool: {
        id: "plan-call", name: legacy ? "CreatePlan" : "Write", status: "completed", success: true, startMs: 2,
        ...(legacy ? { input: { name: "Release draft" }, plan: { file_path: path, name: "Release draft" } }
          : { input: { payload: `+++ ${path}\n---\nname: Release review\n…` },
            plan: { file_path: path, name: "release" }, detailOmitted: true }),
      } }],
      startTimeMs: 1, assistantTimestampMs: 2,
    }], cursor: null, hasEarlier: false });
  };
  return { host, files, actions };
}

test("a saved Write plan reads its full metadata, opens in Files and shares Build state with it", async () => {
  const { host, actions } = planHost(PROJECT_FILE, "session-1");
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSession(app, "NSH skeleton");
  await app.press("label:explore-group-explore:tool:plan-call");
  await app.waitFor("Verify the rollout notes");
  await app.waitFor("1 of 2 remaining");
  expect(app.shows("Confirm test evidence")).toBe(false);
  await app.press("transcript-plan-todos");
  await app.waitFor("Confirm test evidence");
  expect(app.shows("transcript-plan-copy")).toBe(false);
  await app.press("transcript-plan-build");
  await app.waitFor("Building…");
  const submitted = actions.filter(call => call.action === "submit_user_message");
  expect(submitted.length).toBe(1);
  expect(submitted[0].request).toMatchObject({ sessionId: "session-1", workspaceId: "workspace-1", sendDuringTurn: "queue" });
  expect(submitted[0].request.text).toContain(PROJECT_FILE);
  await app.press("transcript-plan-open");
  await app.waitFor("plan-document");
  expect(app.accessibility("plan-build")?.disabled).toBe(true);
  expect(actions.filter(call => call.action === "read_file_content").every(call => call.request.workspaceId === "workspace-1")).toBe(true);
});

test("live Write reveals the plan metadata across partial JSON and only offers actions after completion", async () => {
  const host = createBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  const send = (event: string, payload: Record<string, unknown>) => app.host.send("openbitfun.event", {
    event, payload: { sessionId: "session-1", turnId: "live-plan", ...payload },
  });
  const event = (eventType: string, params: unknown, result?: unknown) => send("agentic://tool-event", {
    roundId: "plan-round", toolEvent: { event_type: eventType, tool_id: "live-plan-call", tool_name: "Write", params, result },
  });
  await send("agentic://dialog-turn-started", {});
  await event("EarlyDetected", null);
  await app.press("label:explore-group-explore:tool:live-plan-call");
  const payload = `+++ ${PROJECT_FILE}\n${PLAN}`;
  const partial = JSON.stringify({ payload });
  const breakAt = partial.indexOf("Release review");
  await event("ParamsPartial", partial.slice(0, breakAt));
  await event("ParamsPartial", partial.slice(breakAt, partial.indexOf("  - id: b")));
  await app.waitFor("Release review");
  await app.waitFor("Writing plan…");
  expect(app.shows("transcript-plan-build")).toBe(false);
  await event("Started", { payload });
  await app.waitFor("1 of 2 remaining");
  await event("Completed", null, { file_path: PROJECT_FILE, success: true });
  await app.waitFor("transcript-plan-open");
  expect(app.accessibility("transcript-plan-build")?.disabled).toBe(true);
});

test("a split pane builds its own plan without moving the primary session or sending its draft", async () => {
  const { host, actions } = planHost(PROJECT_FILE, "session-2");
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  await app.type("composer", "Keep this primary draft");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("id:secondary-session-pane");
  await app.press("id:secondary-session-pane >> label:explore-group-explore:tool:plan-call");
  await app.waitFor("Verify the rollout notes");
  await app.type("secondary-composer", "Keep this secondary draft");
  await app.press("transcript-plan-build");
  await app.waitFor("Building…");
  const submitted = actions.filter(call => call.action === "submit_user_message");
  expect(submitted.length).toBe(1);
  expect(submitted[0].request).toMatchObject({ sessionId: "session-2", workspaceId: "workspace-1", sendDuringTurn: "queue" });
  expect(submitted[0].request.text).toContain(PROJECT_FILE);
  expect(app.value("composer")).toBe("Keep this primary draft");
  expect(app.value("secondary-composer")).toBe("Keep this secondary draft");
});

test("a legacy runtime plan uses its fleet owner and copies to the project without replacing another file", async () => {
  const { host: backend, files } = planHost(RUNTIME_FILE, "s-b1", true);
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 }, devices: [
      fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
      fleetDeviceRow("dev-b", "Owner", [{ workspaceId: "ws-b", name: "Project", rootPath: "/repo", kind: "remote_ssh",
        sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Fleet plan")] }], { hostKind: "desktop", state: "online" }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-b1");
  await app.press("label:explore-group-explore:tool:plan-call");
  await app.waitFor("Release review");
  files.set(PROJECT_FILE, "Existing project file");
  await app.press("transcript-plan-copy");
  await app.waitFor("A different plan with this name already exists in the project.");
  expect(files.get(PROJECT_FILE)).toBe("Existing project file");
  files.delete(PROJECT_FILE);
  await app.press("transcript-plan-copy");
  await app.waitFor("Saved to project");
  expect(files.get(PROJECT_FILE)).toBe(PLAN);
  const artifactCalls = host.fleetCalls.filter(call => ["read_file_content", "create_directory", "write_file_content"].includes(call.command));
  expect(artifactCalls.length).toBeGreaterThan(4);
  expect(artifactCalls.every(call => call.target === "dev-b")).toBe(true);
  expect(artifactCalls.find(call => call.command === "write_file_content")?.args.request).toMatchObject({
    workspaceId: "ws-b", filePath: PROJECT_FILE, expectedHash: "",
  });
  expect(host.pageHostCalls).toHaveLength(0);
});
