import { expect, open, test } from "nsh/test";
import {
  createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, showDevices,
} from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const PHONE = { width: 375, height: 812, platform: "ios" as const };
type App = Awaited<ReturnType<typeof open>>;

async function workspaceMenu(app: App, id = "workspace-1", touch = false) {
  if (!touch) await app.hover(`id:sidebar-workspace-row-${id}`);
  await app.press(`sidebar-workspace-actions-${id}`);
}

// A mutable, paged owner catalogue. The usual fixture intentionally keeps its
// list fixed; this wrapper applies the real host's archive/delete visibility.
function backendWithCatalogue() {
  const backend = createBackend({
    openedWorkspaces: [
      { id: "workspace-1", name: "Main", rootPath: "/repo", workspaceKind: "local" },
      { id: "workspace-2", name: "Other", rootPath: "/other", workspaceKind: "local" },
      { id: "assistant-1", name: "Muse", rootPath: "/muse", workspaceKind: "assistant" },
    ],
    currentWorkspaceId: "workspace-1",
  });
  let catalogue = [
    { sessionId: "session-1", sessionName: "First", workspaceId: "workspace-1", lastActiveAt: 100 },
    { sessionId: "session-2", sessionName: "Second", workspaceId: "workspace-1", lastActiveAt: 90 },
    { sessionId: "session-older", sessionName: "Older page", workspaceId: "workspace-1", lastActiveAt: 80 },
    { sessionId: "other-session", sessionName: "Other workspace", workspaceId: "workspace-2", lastActiveAt: 70 },
  ];
  const queryReads: Array<Record<string, unknown>> = [];
  const faults = { load: false, mutation: "" };
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action: string; request?: Record<string, unknown> };
    const request = args.request ?? {};
    const reply = base(data);
    if (args.action === "list_persisted_sessions_page") {
      if (request.query) {
        queryReads.push(request);
        if (faults.load) return { ok: false, error: "host offline" };
      }
      const scoped = catalogue.filter(row => row.workspaceId === request.workspace_id);
      const start = request.cursor === "older" ? 2 : 0;
      const page = request.query ? scoped.slice(start, start + 2) : scoped;
      return { ok: true, value: {
        sessions: page, totalTopLevelCount: scoped.length, loadedTopLevelCount: start + page.length,
        hasMore: Boolean(request.query && start + page.length < scoped.length),
        ...(request.query && start + page.length < scoped.length ? { nextCursor: "older" } : {}),
      } };
    }
    if (args.action === "archive_session" || args.action === "delete_persisted_session") {
      if (faults.mutation === request.session_id) return { ok: false, error: "session is busy" };
      catalogue = catalogue.filter(row => row.sessionId !== request.session_id || row.workspaceId !== request.workspace_id);
    }
    return reply;
  };
  return { backend, queryReads, faults };
}

function mutations(backend: ReturnType<typeof createBackend>, action: string) {
  return backend.calls.filter(call => call.action === action).map(call => call.request);
}

test("workspace storage opens the owner-managed root, including an empty workspace; assistant menus keep their scope", async () => {
  const { backend, queryReads } = backendWithCatalogue();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await showDevices(app);
  await workspaceMenu(app, "assistant-1");
  expect(app.shows("workspace-menu-manage-sessions-assistant-1")).toBe(true);
  expect(app.texts().indexOf("Close workspace")).toBe(app.texts().indexOf("Batch manage sessions") + 1);
  expect(app.enabled("workspace-menu-storage-assistant-1")).toBe(true);
  await app.press("workspace-menu-storage-assistant-1");
  await app.waitUntil(() => mutations(backend, "reveal_session_storage_directory").length === 1);
  expect(mutations(backend, "reveal_session_storage_directory")[0]).toEqual({ workspace_id: "assistant-1" });
  await workspaceMenu(app);
  await app.press("workspace-menu-storage-workspace-1");
  await app.waitUntil(() => mutations(backend, "reveal_session_storage_directory").length === 2);
  expect(mutations(backend, "reveal_session_storage_directory")[1]).toEqual({ workspace_id: "workspace-1" });

  await workspaceMenu(app, "assistant-1");
  await app.press("workspace-menu-manage-sessions-assistant-1");
  await app.waitFor("text:No sessions to manage in this workspace.");
  expect(queryReads.at(-1)).toMatchObject({ workspace_id: "assistant-1", query: { workspaceId: "assistant-1" } });
  expect(app.shows("session-batch-row-session-1")).toBe(false);
});

test("batch management reads every page, selects and inverts, and archives only the chosen workspace sessions", async () => {
  const { backend, queryReads } = backendWithCatalogue();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await showDevices(app);
  await workspaceMenu(app);
  expect(app.texts().indexOf("Close workspace")).toBe(app.texts().indexOf("Batch manage sessions") + 1);
  await app.press("workspace-menu-manage-sessions-workspace-1");
  await app.waitFor("session-batch-row-session-older");
  expect(queryReads).toHaveLength(2);
  expect(queryReads[0]).toMatchObject({ workspace_id: "workspace-1", query: { workspaceId: "workspace-1", source: "all" } });
  expect(queryReads[1]).toMatchObject({ cursor: "older" });
  expect(app.shows("session-batch-row-other-session")).toBe(false);
  expect(app.enabled("session-batch-archive")).toBe(false);
  await app.press("session-batch-row-session-1");
  await app.press("session-batch-invert");
  await app.waitFor("text:2 of 3 selected");
  await app.press("session-batch-archive");
  await app.waitFor("text:Processed 2 sessions");
  expect(mutations(backend, "archive_session")).toEqual([
    { workspace_id: "workspace-1", session_id: "session-2" },
    { workspace_id: "workspace-1", session_id: "session-older" },
  ]);
  expect(app.shows("session-batch-row-session-older")).toBe(false);
  expect(app.shows("id:sidebar-session-session-older")).toBe(false);
  await app.press("session-batch-select-all");
  await app.waitFor("text:1 of 1 selected");
  await app.press("session-batch-select-all");
  await app.waitFor("text:0 of 1 selected");
});

test("batch deletion needs confirmation and leaves failed sessions selected for retry", async () => {
  const { backend, faults } = backendWithCatalogue();
  faults.mutation = "session-2";
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await showDevices(app);
  await workspaceMenu(app);
  await app.press("workspace-menu-manage-sessions-workspace-1");
  await app.waitFor("session-batch-row-session-older");
  const footerButtonHeight = app.layout("session-batch-archive")?.height;
  expect(footerButtonHeight).toBeGreaterThan(0);
  expect(app.layout("session-batch-delete")?.height).toBe(footerButtonHeight);
  await app.press("session-batch-select-all");
  await app.press("session-batch-delete");
  await app.waitFor("session-batch-delete-confirm");
  expect(app.layout("session-batch-delete-inline-confirm")?.height).toBe(footerButtonHeight);
  expect(app.shows("text:Permanently delete 3 selected sessions? This cannot be undone.")).toBe(false);
  expect(mutations(backend, "delete_persisted_session")).toHaveLength(0);
  await app.press("session-batch-delete-cancel");
  expect(mutations(backend, "delete_persisted_session")).toHaveLength(0);
  await app.press("session-batch-delete");
  await app.press("session-batch-delete-confirm");
  await app.waitFor("text:1 of 1 selected");
  await app.waitFor("text:1 sessions could not be processed. They remain selected. session is busy");
  expect(app.shows("session-batch-row-session-1")).toBe(false);
  expect(app.shows("session-batch-row-session-2")).toBe(true);
  faults.mutation = "";
  await app.press("session-batch-delete");
  await app.press("session-batch-delete-confirm");
  await app.waitFor("text:No sessions to manage in this workspace.");
  expect(mutations(backend, "delete_persisted_session")).toHaveLength(4);
  expect(mutations(backend, "delete_persisted_session").at(-1)).toEqual({ workspace_id: "workspace-1", session_id: "session-2" });
});

test("a failed catalogue read cannot select or mutate a partial page and can be retried", async () => {
  const { backend, faults } = backendWithCatalogue();
  faults.load = true;
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await showDevices(app);
  await workspaceMenu(app, "workspace-2");
  await app.press("workspace-menu-manage-sessions-workspace-2");
  await app.waitFor("text:Failed to load sessions: host offline");
  expect(app.enabled("session-batch-select-all")).toBe(false);
  expect(app.enabled("session-batch-delete")).toBe(false);
  faults.load = false;
  await app.press("session-batch-retry");
  await app.waitFor("session-batch-row-other-session");
  expect(app.shows("session-batch-row-session-1")).toBe(false);
  await app.press("session-batch-select-all");
  await app.press("session-batch-archive");
  await app.waitFor("text:Processed 1 sessions");
  expect(mutations(backend, "archive_session")).toEqual([{ workspace_id: "workspace-2", session_id: "other-session" }]);
  expect(app.shows("id:sidebar-session-session-1")).toBe(true);
});

test("browser fleet management routes reads and writes to the owner and disables file-manager access", async () => {
  const { backend } = backendWithCatalogue();
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 }, devices: [
      fleetDeviceRow("dev-a", "MacBook", [
        { workspaceId: "workspace-1", name: "Main", rootPath: "/repo", sessions: [] },
      ], { isClientDevice: true }),
      fleetDeviceRow("dev-b", "Linux", [
        { workspaceId: "workspace-2", name: "Other", rootPath: "/srv/other", sessions: [fleetSessionRow("dev-b", "workspace-2", "other-session", "Other workspace")] },
      ], { hostKind: "cli" }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await showDevices(app);
  await workspaceMenu(app);
  expect(app.enabled("workspace-menu-storage-workspace-1")).toBe(false);
  await app.keyboard.press("Escape");
  await workspaceMenu(app, "workspace-2");
  expect(app.enabled("workspace-menu-storage-workspace-2")).toBe(false);
  await app.press("workspace-menu-manage-sessions-workspace-2");
  await app.waitFor("session-batch-row-other-session");
  await app.press("session-batch-select-all");
  await app.press("session-batch-archive");
  await app.waitFor("text:Processed 1 sessions");
  const commands = host.fleetCalls.filter(call => call.command === "archive_session" ||
    (call.command === "list_persisted_sessions_page" && (call.args.request as Record<string, unknown>)?.workspace_id === "workspace-2"));
  expect(commands.length >= 3).toBe(true);
  expect(commands.every(call => call.target === "dev-b")).toBe(true);
  expect(commands.find(call => call.command === "archive_session")).toMatchObject({ args: { request: { workspace_id: "workspace-2", session_id: "other-session" } } });
});

test("the phone can select and confirm cleanup in the shared workspace panel", async () => {
  const { backend } = backendWithCatalogue();
  const app = await open("../App.tsx", { ...PHONE, host: { handlers: backend.handlers } });
  await showDevices(app);
  await workspaceMenu(app, "workspace-1", true);
  await app.press("workspace-menu-manage-sessions-workspace-1");
  await app.waitFor("session-batch-row-session-older");
  await app.press("session-batch-select-all");
  await app.press("session-batch-delete");
  await app.waitFor("session-batch-delete-confirm");
  await app.press("session-batch-delete-confirm");
  await app.waitFor("text:No sessions to manage in this workspace.");
  expect(mutations(backend, "delete_persisted_session")).toHaveLength(3);
});
