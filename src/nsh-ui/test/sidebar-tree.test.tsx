// The session tree (the sidebar on a wide window, the Sessions tab on a phone):
// every runtime device of the account → its workspaces → their sessions, with
// the backend's folding and roll-up, exceptions in words, a "Show more" that
// pages further sessions in from the owning device, and each device's own
// actions on its ⋯ (new workspace, terminal, SSH, settings, jobs sent from this
// computer, rename, copy id, remove). The All sessions and device pages are
// retired: what they offered lives here.

import { expect, open, test } from "nsh/test";
import { layout, space } from "../src/theme";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, showDevices } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const PHONE = { width: 375, height: 812, platform: "ios" as const };
const ENTRY = { protocol: 1, cursorState: {}, deviceId: "dev-a" };

function navigator(extraDevices: Array<Record<string, unknown>> = []) {
  return {
    revision: 2,
    full: true,
    removedDeviceIds: [],
    totals: { running: 1, waiting: 1, unread: 0 },
    devices: [
      fleetDeviceRow("dev-a", "MacBook", [
        {
          workspaceId: "workspace-1",
          name: "openbitfun",
          rootPath: "/repo",
          isHostCurrent: true,
          sessions: [
            { ...fleetSessionRow("dev-a", "workspace-1", "session-1", "Fix flaky test"), status: "running" },
            fleetSessionRow("dev-a", "workspace-1", "session-2", "Docs pass"),
            fleetSessionRow("dev-a", "workspace-1", "session-3", "Port the terminal"),
            fleetSessionRow("dev-a", "workspace-1", "session-4", "Bump deps"),
          ],
        },
      ], { isClientDevice: true }),
      fleetDeviceRow("dev-b", "linux-box", [
        {
          workspaceId: "workspace-2",
          name: "infra",
          rootPath: "/srv/infra",
          sessions: [{ ...fleetSessionRow("dev-b", "workspace-2", "session-5", "Build release"), needsAttention: true, status: "waiting" }],
        },
      ], { hostKind: "cli", ui: { rollup: "needs_you" } }),
      fleetDeviceRow("dev-c", "win-pc", [], { state: "update_required", stateReason: "Needs OpenBitFun 1.3 or later" }),
      ...extraDevices,
      fleetDeviceRow(
        "dev-d",
        "old-laptop",
        [
          {
            workspaceId: "workspace-offline",
            name: "offline-repo",
            rootPath: "/offline/repo",
            sessions: [fleetSessionRow("dev-d", "workspace-offline", "session-offline", "Cached offline thread")],
          },
        ],
        { state: "offline" },
      ),
      fleetDeviceRow("dev-e", "stale-box", [], { state: "stale" }),
      fleetDeviceRow("dev-f", "unreachable-box", [], { state: "unreachable" }),
    ],
  };
}

async function openFleet(nav = navigator(), viewport: Record<string, unknown> = DESKTOP) {
  const backend = createBackend();
  const host = fleetObpHost(backend, { fleet: ENTRY, navigator: nav });
  const app = await open("./fixtures/obpApp.tsx", { ...viewport, host: { handlers: host.handlers } });
  await showDevices(app);
  return { app, host, backend };
}

async function deviceMenu(app: Awaited<ReturnType<typeof open>>, deviceId: string) {
  await app.hover(`id:sidebar-device-row-${deviceId}`);
  await app.press(`sidebar-device-actions-${deviceId}`);
}

test("the sidebar lists reachable devices with their workspaces and sessions, omitting offline ones", async () => {
  const { app, host } = await openFleet();
  // This device is unfolded; another healthy device is too, with its sessions.
  await app.waitFor("id:sidebar-session-session-1");
  expect(app.shows("id:sidebar-session-session-5")).toBe(true);
  expect(app.shows("text:This device")).toBe(true);
  // An outdated device folds and says why in words; offline / stale / unreachable peers stay out of the sidebar.
  expect(app.shows("text:Update needed")).toBe(true);
  expect(app.shows("id:sidebar-device-row-dev-d")).toBe(false);
  expect(app.shows("id:sidebar-workspace-row-workspace-offline")).toBe(false);
  expect(app.shows("id:sidebar-device-row-dev-e")).toBe(false);
  expect(app.shows("id:sidebar-device-row-dev-f")).toBe(false);

  // Pressing a row of another device opens that session there.
  await app.press("id:sidebar-session-session-5");
  await app.waitUntil(() =>
    host.fleetCalls.some(call => call.target === "dev-b" && call.command === "get_session_transcript_view"),
  );
});

test("when every other device is offline the sidebar collapses to this device's Workspaces header", async () => {
  const nav = {
    revision: 3,
    full: true,
    removedDeviceIds: [],
    totals: { running: 0, waiting: 0, unread: 0 },
    devices: [
      fleetDeviceRow(
        "dev-a",
        "MacBook",
        [
          {
            workspaceId: "workspace-1",
            name: "openbitfun",
            rootPath: "/repo",
            isHostCurrent: true,
            sessions: [fleetSessionRow("dev-a", "workspace-1", "session-1", "Local thread")],
          },
        ],
        { isClientDevice: true },
      ),
      fleetDeviceRow(
        "dev-d",
        "BOBPC",
        [
          {
            workspaceId: "workspace-offline",
            name: "offline-repo",
            rootPath: "/offline/repo",
            sessions: [fleetSessionRow("dev-d", "workspace-offline", "session-offline", "Old thread")],
          },
        ],
        { state: "offline" },
      ),
    ],
  };
  const { app } = await openFleet(nav);
  await app.waitFor("id:sidebar-session-session-1");
  expect(app.shows("text:Workspaces")).toBe(true);
  expect(app.shows("id:sidebar-device-row-dev-a")).toBe(false);
  expect(app.shows("id:sidebar-device-row-dev-d")).toBe(false);
  expect(app.shows("text:BOBPC")).toBe(false);
});

test("New session on a workspace starts it on the workspace's own device", async () => {
  const { app, host } = await openFleet();
  await app.waitFor("id:sidebar-workspace-row-workspace-2");
  await app.hover("id:sidebar-workspace-row-workspace-2");
  await app.press("sidebar-new-session-workspace-2");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "create_session"));
  const created = host.fleetCalls.find(call => call.command === "create_session");
  expect(created?.target).toBe("dev-b");
  expect((created?.args.request as Record<string, unknown>).workspaceId).toBe("workspace-2");
});

test("Show more reveals the sessions already listed, then pages the rest in from the owning device", async () => {
  const listed = Array.from({ length: 6 }, (_, idx) => fleetSessionRow("dev-a", "ws-many", `s-${idx + 1}`, `Thread ${idx + 1}`));
  const nav = {
    revision: 4,
    full: true,
    removedDeviceIds: [],
    totals: { running: 0, waiting: 0, unread: 0 },
    devices: [
      fleetDeviceRow("dev-a", "mac-work", [
        { workspaceId: "ws-many", name: "OpenBitFun", rootPath: "/Users/me/OpenBitFun", isHostCurrent: true, sessions: listed, sessionTotal: 12 },
      ], { isClientDevice: true }),
    ],
  };
  const { app, host } = await openFleet(nav);
  await app.waitFor("id:sidebar-session-s-3");
  expect(app.shows("id:sidebar-session-s-4")).toBe(false);
  await app.waitFor("label:sidebar-show-more-ws-many >> text:Show more");

  // The first press shows what the navigator already listed, then asks the device for a page.
  await app.press("label:sidebar-show-more-ws-many");
  await app.waitFor("id:sidebar-session-s-6");
  await app.press("label:sidebar-show-more-ws-many");
  await app.waitUntil(() =>
    host.fleetCalls.some(call => call.target === "dev-a" && call.command === "list_persisted_sessions_page"),
  );

  // Folding the workspace resets it to its first three.
  await app.press("label:sidebar-workspace-toggle-ws-many");
  await app.waitUntil(() => !app.shows("id:sidebar-session-s-1"));
  await app.press("label:sidebar-workspace-toggle-ws-many");
  await app.waitFor("id:sidebar-session-s-3");
  expect(app.shows("id:sidebar-session-s-4")).toBe(false);
});

test("a session's device badge unfolds that device in the sidebar", async () => {
  const { app } = await openFleet();
  await app.press("id:sidebar-session-session-5");
  await app.waitFor("id:session-breadcrumb-device");
  // Fold linux-box, then ask for it from the session's header.
  await app.press("label:sidebar-device-toggle-dev-b");
  await app.waitUntil(() => app.accessibility("label:sidebar-device-toggle-dev-b")?.expanded === false);
  await app.press("id:session-breadcrumb-device");
  await app.waitUntil(() => app.accessibility("label:sidebar-device-toggle-dev-b")?.expanded === true);
});

test("a device's ⋯ opens Settings on that device", async () => {
  const { app, host } = await openFleet();
  await deviceMenu(app, "dev-b");
  await app.press("device-settings-dev-b");
  await app.waitUntil(() => host.fleetCalls.some(call => call.target === "dev-b"));
  await app.waitFor("text:Preferences");
});

test("a device's ⋯ removes it only after a confirmation", async () => {
  const { app, backend } = await openFleet();
  await deviceMenu(app, "dev-b");
  await app.press("device-menu-remove-dev-b");
  await app.waitFor("device-remove-confirm-dev-b");
  expect(backend.actions()).not.toContain("account_delete_device");
  await app.press("device-remove-confirm-dev-b");
  await app.waitUntil(() => backend.actions().includes("account_delete_device"));
});

test("Rename sets the account alias of the device and refreshes the sidebar name", async () => {
  const nav = navigator();
  const backend = createBackend();
  const baseInvoke = backend.handlers["openbitfun.invoke"]!;
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const req = (data ?? {}) as { action?: string; request?: { device_id?: string; device_alias?: string | null } };
    if (req.action === "account_update_device_alias" && req.request?.device_id) {
      nav.revision += 1;
      for (const device of nav.devices) {
        if ((device as { deviceId?: string }).deviceId === req.request.device_id) {
          (device as { name: string }).name = req.request.device_alias || "linux-box";
        }
      }
    }
    return baseInvoke(data);
  };
  const host = fleetObpHost(backend, { fleet: ENTRY, navigator: nav });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await showDevices(app);

  await deviceMenu(app, "dev-b");
  await app.press("device-menu-rename-dev-b");
  await app.waitFor("device-rename-field");
  await app.clear("device-rename-field");
  await app.type("device-rename-field", "gpu-box");
  await app.press("device-rename-save");
  await app.waitUntil(() => backend.calls.some(call => call.action === "account_update_device_alias"));
  expect(backend.calls.find(call => call.action === "account_update_device_alias")?.request).toMatchObject({
    device_id: "dev-b",
    device_alias: "gpu-box",
  });
  await app.waitFor("text:GPU-BOX");
});

test("Rename surfaces backend failures as a toast instead of failing silently", async () => {
  const nav = navigator();
  const backend = createBackend();
  const baseInvoke = backend.handlers["openbitfun.invoke"]!;
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const req = (data ?? {}) as { action?: string };
    if (req.action === "account_update_device_alias") {
      return { ok: false, error: "directory unavailable" };
    }
    return baseInvoke(data);
  };
  const host = fleetObpHost(backend, { fleet: ENTRY, navigator: nav });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await showDevices(app);

  await deviceMenu(app, "dev-b");
  await app.press("device-menu-rename-dev-b");
  await app.waitFor("device-rename-field");
  await app.clear("device-rename-field");
  await app.type("device-rename-field", "gpu-box");
  await app.press("device-rename-save");
  await app.waitFor("text:directory unavailable");
});

test("an outdated device's ⋯ says what it needs", async () => {
  const { app } = await openFleet();
  await deviceMenu(app, "dev-c");
  await app.press("device-update-dev-c");
  await app.waitFor("device-update-dialog");
  await app.waitFor("text:Needs OpenBitFun 1.3 or later");
});

test("only this computer's ⋯ lists the jobs it sent; another device's does not", async () => {
  const backend = createBackend({
    dispatchJob: {
      jobId: "job-7",
      sessionId: "session-7",
      promptPreview: "Run the nightly suite",
      title: "Nightly suite",
      state: "running",
      workspacePath: "/srv/api",
      target: { kind: "ssh", connectionId: "conn-1", displayName: "build-box" },
    },
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await showDevices(app);
  await app.press("sidebar-device-actions-local");
  await app.press("device-jobs-local");
  await app.waitFor("device-jobs-sheet");
  await app.waitFor("text:Nightly suite");
  expect(app.shows("text:build-box · Working")).toBe(true);
  await app.press("dispatch-cancel-job-7");
  await app.waitUntil(() => backend.cancelledJobs.includes("job-7"));
  // The copy never names the mechanism.
  expect(app.texts().some(text => /dispatch|detached/i.test(text))).toBe(false);

  const { app: fleet } = await openFleet();
  await deviceMenu(fleet, "dev-b");
  expect(fleet.shows("device-jobs-dev-b")).toBe(false);
});

test("without the fleet layer the tree lists this machine's workspaces under one header", async () => {
  const backend = createBackend();
  const host = fleetObpHost(backend, { fleet: null });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await showDevices(app);
  await app.waitFor("label:sidebar-device-tree >> NSH skeleton");
  expect(host.fleetCalls.length).toBe(0);
  expect(app.shows("text:Workspaces")).toBe(true);
  expect(app.shows("sidebar-new-workspace")).toBe(true);
});

test("a phone's Sessions tab is the same tree with touch-sized rows and its actions shown", async () => {
  const { app } = await openFleet(navigator(), PHONE);
  await app.waitFor("label:session-list-scene");
  await app.waitFor("id:sidebar-session-session-1");
  // No hover on a phone: the row actions are drawn already.
  expect(app.shows("sidebar-device-actions-dev-b")).toBe(true);
  expect(app.shows("sidebar-new-session-workspace-1")).toBe(true);
  const row = app.layout("id:sidebar-device-row-dev-b");
  expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("opening an unread CLI session clears the sidebar checkmark immediately and sends mark_session_seen with workspaceId", async () => {
  const futureActivityMs = Date.now() + 60_000; // simulate remote CLI host clock ahead of local clock
  const nav = {
    revision: 5,
    full: true,
    removedDeviceIds: [],
    totals: { running: 0, waiting: 0, unread: 1 },
    devices: [
      fleetDeviceRow(
        "dev-a",
        "MacBook",
        [
          {
            workspaceId: "workspace-1",
            name: "openbitfun",
            rootPath: "/repo",
            isHostCurrent: true,
            sessions: [fleetSessionRow("dev-a", "workspace-1", "session-1", "Local thread")],
          },
        ],
        { isClientDevice: true },
      ),
      fleetDeviceRow(
        "dev-ubuntu",
        "ubuntu",
        [
          {
            workspaceId: "ws-ubuntu-assistant",
            name: "小福",
            rootPath: "/home/u/.openbitfun/assistant",
            kind: "assistant",
            sessions: [
              {
                ...fleetSessionRow("dev-ubuntu", "ws-ubuntu-assistant", "session-greet", "问候", futureActivityMs),
                unread: true,
              },
            ],
          },
        ],
        { hostKind: "cli" },
      ),
    ],
  };
  const { app, host } = await openFleet(nav);
  await app.waitFor("id:sidebar-session-session-greet");
  // Unread completed session starts with the green "Done" checkmark.
  expect(app.shows("id:sidebar-session-session-greet >> label:Done")).toBe(true);

  await app.press("id:sidebar-session-session-greet");
  // Even before the peer's updated digest returns (and even with clock skew), the checkmark clears right away.
  await app.waitUntil(() => !app.shows("id:sidebar-session-session-greet >> label:Done"));
  await app.waitUntil(() =>
    host.fleetCalls.some(call => call.target === "dev-ubuntu" && call.command === "mark_session_seen"),
  );
  const seenCall = host.fleetCalls.find(call => call.target === "dev-ubuntu" && call.command === "mark_session_seen");
  expect((seenCall?.args.request as Record<string, unknown>)?.sessionId).toBe("session-greet");
  expect((seenCall?.args.request as Record<string, unknown>)?.workspaceId).toBe("ws-ubuntu-assistant");
});

test("a persisted failed fleet session renders as Failed rather than Needs you and clears once opened", async () => {
  const nav = {
    revision: 7,
    full: true,
    removedDeviceIds: [],
    totals: { running: 0, waiting: 0, unread: 1 },
    devices: [
      fleetDeviceRow(
        "dev-a",
        "MacBook",
        [
          {
            workspaceId: "workspace-1",
            name: "openbitfun",
            rootPath: "/repo",
            isHostCurrent: true,
            sessions: [fleetSessionRow("dev-a", "workspace-1", "session-1", "Local thread")],
          },
        ],
        { isClientDevice: true },
      ),
      fleetDeviceRow(
        "dev-ubuntu",
        "ubuntu",
        [
          {
            workspaceId: "ws-ubuntu",
            name: "api",
            rootPath: "/srv/api",
            sessions: [
              {
                ...fleetSessionRow("dev-ubuntu", "ws-ubuntu", "session-failed", "Broken deploy"),
                status: "idle",
                unread: true,
                failed: true,
                needsAttention: false,
              },
            ],
          },
        ],
        { hostKind: "cli" },
      ),
    ],
  };
  const { app } = await openFleet(nav);
  await app.waitFor("id:sidebar-session-session-failed >> label:Failed");
  expect(app.shows("id:sidebar-session-session-failed >> label:Needs you")).toBe(false);

  await app.press("id:sidebar-session-session-failed");
  await app.waitUntil(() => !app.shows("id:sidebar-session-session-failed >> label:Failed"));
});

test("sidebar account avatar centers on the workspace icon slot and username left-aligns with tree text", async () => {
  const { app } = await openFleet();
  await app.waitFor("id:sidebar-workspace-row-workspace-1");
  await app.waitFor("id:sidebar-session-session-1");
  await app.waitFor("id:sidebar-account-avatar");
  await app.waitFor("id:sidebar-account-label");

  const workspaceRow = app.layout("id:sidebar-workspace-row-workspace-1");
  const workspaceLabel = app.layout("id:sidebar-workspace-row-workspace-1 >> text:openbitfun");
  const sessionLabel = app.layout("id:sidebar-session-session-1 >> text:Fix flaky test");
  const avatar = app.layout("id:sidebar-account-avatar");
  const accountLabel = app.layout("id:sidebar-account-label");

  expect(workspaceRow).not.toBeNull();
  expect(workspaceLabel).not.toBeNull();
  expect(sessionLabel).not.toBeNull();
  expect(avatar).not.toBeNull();
  expect(accountLabel).not.toBeNull();

  // Workspace row starts with its 16 px leading icon slot (`space.lg`).
  const workspaceIconCenterX = workspaceRow!.x + space.lg / 2;
  const avatarCenterX = avatar!.x + avatar!.width / 2;
  expect(avatarCenterX).toBe(workspaceIconCenterX);
  expect(accountLabel!.x).toBe(workspaceLabel!.x);
  expect(accountLabel!.x).toBe(sessionLabel!.x);
});

test("this-device marker renders as an inverted pill capsule on the chrome surface", async () => {
  const { app } = await openFleet();
  await app.waitFor("id:sidebar-device-this-device-dev-a");

  const pillStyle = app.viewStyle("id:sidebar-device-this-device-dev-a");
  const textStyleVal = app.spanStyle("id:sidebar-device-this-device-dev-a >> text:This device");
  expect(pillStyle?.backgroundColor).toBeDefined();
  expect(textStyleVal.color).toBeDefined();
  expect(pillStyle?.backgroundColor).not.toBe(textStyleVal.color);
});

test("temporary dev route tag shows P2P/Relay and latency on the right side of peer device headers", async () => {
  const nav = navigator();
  nav.devices = nav.devices.map(device => {
    const id = (device as { deviceId?: string }).deviceId;
    if (id === "dev-a") return { ...device, route: { kind: "local" } };
    if (id === "dev-b") return { ...device, route: { kind: "direct_lan", latencyMs: 12 } };
    return device;
  });
  nav.devices.push({
    ...fleetDeviceRow(
      "dev-relay",
      "ubuntu",
      [{ workspaceId: "ws-r", name: "srv", rootPath: "/srv", isHostCurrent: true, sessions: [] }],
      { hostKind: "cli" },
    ),
    route: { kind: "relayed_server", latencyMs: 48 },
  });
  const { app } = await openFleet(nav);
  await app.waitFor("id:sidebar-device-dev-route-dev-b");
  await app.waitFor("id:sidebar-device-dev-route-dev-relay");

  expect(app.shows("id:sidebar-device-dev-route-dev-a")).toBe(false);
  expect(app.shows("text:P2P · 12ms")).toBe(true);
  expect(app.shows("text:Relay · 48ms")).toBe(true);

  const sectionBox = app.layout("label:sidebar-device-dev-relay");
  const nameBox = app.layout("id:sidebar-device-row-dev-relay >> text:UBUNTU");
  const routeBox = app.layout("id:sidebar-device-dev-route-dev-relay");
  expect(sectionBox).not.toBeNull();
  expect(nameBox).not.toBeNull();
  expect(routeBox).not.toBeNull();
  expect(routeBox!.x).toBeGreaterThan(nameBox!.x + nameBox!.width);
  expect(routeBox!.x + routeBox!.width).toBeLessThanOrEqual(sectionBox!.x + sectionBox!.width + 2);
  expect(Math.abs((routeBox!.y + routeBox!.height / 2) - (nameBox!.y + nameBox!.height / 2))).toBeLessThanOrEqual(4);
});

test("desktop sidebar buttons use compact nav item height with a 1px gap between adjacent buttons", async () => {
  const nav = {
    revision: 8,
    full: true,
    removedDeviceIds: [],
    totals: { running: 0, waiting: 0, unread: 0 },
    devices: [
      fleetDeviceRow(
        "dev-a",
        "MacBook",
        [
          {
            workspaceId: "ws-1",
            name: "Assistant",
            rootPath: "/assistant",
            kind: "assistant",
            isHostCurrent: true,
            sessions: [
              fleetSessionRow("dev-a", "ws-1", "s-1", "New session"),
              fleetSessionRow("dev-a", "ws-1", "s-2", "Second session"),
              fleetSessionRow("dev-a", "ws-1", "s-3", "Third session"),
              fleetSessionRow("dev-a", "ws-1", "s-4", "Fourth session"),
            ],
          },
          {
            workspaceId: "ws-empty",
            name: "Empty project",
            rootPath: "/empty",
            sessions: [],
          },
          {
            workspaceId: "ws-2",
            name: "OpenBitFun",
            rootPath: "/repo",
            sessions: [fleetSessionRow("dev-a", "ws-2", "s-5", "Repo thread")],
          },
        ],
        { isClientDevice: true },
      ),
      fleetDeviceRow("dev-b", "linux-box", [], { hostKind: "cli" }),
    ],
  };
  const { app } = await openFleet(nav);
  await app.waitFor("id:sidebar-session-s-5");
  await app.waitFor("label:sidebar-show-more-ws-1");

  const search = app.layout("label:global-search-trigger");
  const library = app.layout("label:nav-library");
  const deviceRow = app.layout("id:sidebar-device-row-dev-a");
  const ws1 = app.layout("id:sidebar-workspace-row-ws-1");
  const s1 = app.layout("id:sidebar-session-s-1");
  const s2 = app.layout("id:sidebar-session-s-2");
  const s3 = app.layout("id:sidebar-session-s-3");
  const showMore = app.layout("label:sidebar-show-more-ws-1");
  const wsEmpty = app.layout("id:sidebar-workspace-row-ws-empty");
  const ws2 = app.layout("id:sidebar-workspace-row-ws-2");
  const s5 = app.layout("id:sidebar-session-s-5");
  const account = app.layout("label:account-row");

  const all = [search, library, deviceRow, ws1, s1, s2, s3, showMore, wsEmpty, ws2, s5, account];
  for (const box of all) {
    expect(box).not.toBeNull();
    expect(box!.height).toBe(layout.navItemHeight);
  }

  const gapBetween = (upper: NonNullable<typeof search>, lower: NonNullable<typeof search>) =>
    lower.y - (upper.y + upper.height);

  expect(gapBetween(search!, library!)).toBe(layout.navItemGap);
  expect(gapBetween(deviceRow!, ws1!)).toBe(layout.navItemGap);
  expect(gapBetween(ws1!, s1!)).toBe(layout.navItemGap);
  expect(gapBetween(s1!, s2!)).toBe(layout.navItemGap);
  expect(gapBetween(s2!, s3!)).toBe(layout.navItemGap);
  expect(gapBetween(s3!, showMore!)).toBe(layout.navItemGap);
  expect(gapBetween(showMore!, wsEmpty!)).toBe(layout.navItemGap);
  expect(gapBetween(wsEmpty!, ws2!)).toBe(layout.navItemGap);
  expect(gapBetween(ws2!, s5!)).toBe(layout.navItemGap);
});

test("assistant workspaces support changing icons and render the chosen glyph in the sidebar", async () => {
  let glyph: string | undefined;
  let revision = 0;
  const nav = {
    revision: 10,
    full: true,
    removedDeviceIds: [],
    totals: { running: 0, waiting: 0, unread: 0 },
    devices: [
      fleetDeviceRow(
        "dev-a",
        "MacBook",
        [
          {
            workspaceId: "ws-asst",
            name: "哥伦比亚",
            rootPath: "/Users/me/.openbitfun/assistants/columbia",
            kind: "assistant",
            isHostCurrent: true,
            sessions: [fleetSessionRow("dev-a", "ws-asst", "s-asst-1", "Hello")],
          },
        ],
        { isClientDevice: true },
      ),
    ],
  };
  const backend = createBackend();
  const baseInvoke = backend.handlers["openbitfun.invoke"]!;
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const req = (data ?? {}) as { action?: string; request?: Record<string, unknown> };
    if (req.action === "get_workspace_icon") {
      return {
        ok: true,
        value: {
          workspaceId: req.request?.workspaceId,
          icon: {
            version: 1,
            revision,
            mode: "default",
            color: "default",
            ...(glyph ? { glyph } : {}),
          },
          imageUnavailable: false,
          supportedGlyphs: ["default", "pets", "code"],
        },
        transport: "dev",
      };
    }
    if (req.action === "set_workspace_icon") {
      const input = (req.request?.icon ?? {}) as { glyph?: string };
      glyph = input.glyph && input.glyph !== "default" ? input.glyph : undefined;
      revision += 1;
      nav.revision += 1;
      const ws = (nav.devices[0] as { workspaces: Array<Record<string, unknown>> }).workspaces[0]!;
      if (glyph) ws.iconGlyph = glyph;
      else delete ws.iconGlyph;
      return {
        ok: true,
        value: {
          workspaceId: req.request?.workspaceId,
          icon: {
            version: 1,
            revision,
            mode: "default",
            color: "default",
            ...(glyph ? { glyph } : {}),
          },
          imageUnavailable: false,
          supportedGlyphs: ["default", "pets", "code"],
        },
        transport: "dev",
      };
    }
    return baseInvoke(data);
  };
  const host = fleetObpHost(backend, { fleet: ENTRY, navigator: nav });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await showDevices(app);
  await app.waitFor("id:sidebar-workspace-icon-ws-asst-bot");

  await app.hover("id:sidebar-workspace-row-ws-asst");
  await app.press("sidebar-workspace-actions-ws-asst");
  await app.press("text:Change icon…");
  await app.waitFor("id:workspace-icon-glyph-icon-default-bot");
  await app.press("workspace-icon-glyph-pets");
  await app.press("workspace-icon-save");

  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "set_workspace_icon"));
  const setCall = host.fleetCalls.find(call => call.command === "set_workspace_icon");
  expect(setCall?.target).toBe("dev-a");
  expect(setCall?.args.request).toMatchObject({
    workspaceId: "ws-asst",
    expectedRevision: 0,
    icon: { kind: "default", color: "default", glyph: "pets" },
  });

  await app.hover("label:nav-library");
  await app.waitFor("id:sidebar-workspace-icon-ws-asst-sparkles");

  // Switching back to the default tile restores the assistant's default bot icon.
  await app.hover("id:sidebar-workspace-row-ws-asst");
  await app.press("sidebar-workspace-actions-ws-asst");
  await app.press("text:Change icon…");
  await app.waitFor("id:workspace-icon-glyph-icon-default-bot");
  await app.press("workspace-icon-glyph-default");
  await app.press("workspace-icon-save");
  await app.hover("label:nav-library");
  await app.waitFor("id:sidebar-workspace-icon-ws-asst-bot");
});
