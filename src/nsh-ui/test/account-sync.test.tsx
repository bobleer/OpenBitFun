// Account settings sync (wave 21): the Preferences caption shows only while the
// backend reports sync as active, Account › Profile draws the switch and one
// plain line only for a state the user can act on, and an applied account change repaints the theme
// without the page doing anything itself.

import { expect, open, test } from "nsh/test";
import { createBackend, fleetDeviceRow, fleetObpHost } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const HARNESS = "./fixtures/settingsApp.tsx";

async function openSettings(accountSync?: Record<string, unknown> | null) {
  const backend = createBackend({ accountSync });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1,
      full: true,
      devices: [fleetDeviceRow("dev-a", "MacBook", [])],
      removedDeviceIds: [],
      totals: { running: 0, waiting: 0, unread: 0 },
    },
  });
  const app = await open(HARNESS, { ...DESKTOP, host: { handlers: host.handlers } });
  return { app, host, backend };
}

test("the Preferences caption follows the backend's sync state", async () => {
  const { app } = await openSettings();
  await app.waitFor("settings-synced");

  const off = await openSettings({ enabled: false, phase: "off", active: false, pending: 0 });
  await off.app.waitFor("Interface language");
  expect(off.app.shows("settings-synced")).toBe(false);

  // A host without the commands has no account sync: no caption either.
  const old = await openSettings(null);
  await old.app.waitFor("Interface language");
  expect(old.app.shows("settings-synced")).toBe(false);
});

test("Account › Profile switches sync off and on", async () => {
  const { app } = await openSettings();
  await app.press("nav-settings-page-profile");
  await app.waitFor("account-sync-toggle");
  // A healthy sync says nothing beyond the switch.
  expect(app.shows("account-sync-state")).toBe(false);

  await app.press("account-sync-toggle");
  await app.press("nav-settings-page-general");
  await app.waitFor("Interface language");
  expect(app.shows("settings-synced")).toBe(false);

  await app.press("nav-settings-page-profile");
  await app.waitFor("account-sync-toggle");
  expect(app.shows("account-sync-state")).toBe(false);
  await app.press("account-sync-toggle");
  await app.press("nav-settings-page-general");
  await app.waitFor("settings-synced");
});

test("only a state the user can act on gets a line, and an old host asks for an update", async () => {
  // Waiting for another device, pending changes or being the only device are not problems: no line.
  const { app } = await openSettings({ enabled: true, phase: "offline", active: true, pending: 2, peers: 2, peersOnline: 0 });
  await app.press("nav-settings-page-profile");
  await app.waitFor("account-sync-toggle");
  expect(app.shows("account-sync-state")).toBe(false);
  expect(app.texts().some(text => text.includes("Changes waiting"))).toBe(false);

  // Signed out: the one plain line says what to do.
  const signedOut = await openSettings({ enabled: true, phase: "signed_out", active: false, pending: 0 });
  await signedOut.app.press("nav-settings-page-profile");
  await signedOut.app.waitFor("text:Sign in to sync your settings.");

  const old = await openSettings(null);
  await old.app.press("nav-settings-page-profile");
  await old.app.waitFor("text:Update OpenBitFun on this device to sync settings.");
  expect(old.app.shows("account-sync-toggle")).toBe(false);
});

test("the appearance is kept on the host, and an applied account change repaints it", async () => {
  const backend = createBackend();
  const app = await open("../App.tsx", { ...DESKTOP, colorScheme: "dark", host: { handlers: backend.handlers } });
  await app.press("Settings");
  await app.press("nav-settings-page-appearance");
  await app.waitFor("appearance-follow-system");
  expect(app.shows("appearance-swatch-openbitfun-monochrome")).toBe(false);
  await app.press("appearance-follow-system");
  await app.waitFor("appearance-swatch-openbitfun-monochrome");
  await app.press("appearance-swatch-openbitfun-monochrome");
  await app.waitFor("Showing the light scheme");
  await app.waitUntil(() =>
    backend.settingsWrites.some(write => write.path === "appearance.selection" && write.value === "openbitfun-monochrome"),
  );

  // Another device chose a dark preset; the backend applied it here and says so.
  await backend.handlers["openbitfun.invoke"]({
    action: "set_config",
    request: { path: "appearance.selection", value: "openbitfun-midnight" },
  });
  await app.host.send("openbitfun.event", {
    event: "account://settings-applied",
    payload: { keys: ["appearance.selection"] },
  });
  await app.waitFor("Showing the dark scheme");
  expect(app.shows("appearance-swatch-openbitfun-monochrome")).toBe(true);

  // Another device switched back to Follow System; the swatch gallery hides again.
  await backend.handlers["openbitfun.invoke"]({
    action: "set_config",
    request: { path: "appearance.selection", value: "system" },
  });
  await app.host.send("openbitfun.event", {
    event: "account://settings-applied",
    payload: { keys: ["appearance.selection"] },
  });
  await app.waitUntil(() => !app.shows("appearance-swatch-openbitfun-monochrome"));
});

test("Account › Profile surfaces an inline error when saving the sync switch fails", async () => {
  const { app, backend } = await openSettings();
  const baseInvoke = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const { action } = data as { action?: string };
    if (action === "account_settings_sync_set") {
      return { ok: false, error: "sync store read-only" };
    }
    return baseInvoke(data);
  };
  await app.press("nav-settings-page-profile");
  await app.waitFor("account-sync-toggle");
  await app.press("account-sync-toggle");
  await app.waitFor("account-sync-write-failed");
  expect(app.shows("text:sync store read-only")).toBe(true);
});

test("account://settings-applied reloads keybindings and ignores events from remote peer origins", async () => {
  const backend = createBackend();
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1,
      full: true,
      devices: [fleetDeviceRow("dev-a", "MacBook", [])],
      removedDeviceIds: [],
      totals: { running: 0, waiting: 0, unread: 0 },
    },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await app.press("Settings");
  await app.waitFor("settings-synced");

  // A sync-state event from a remote peer (`dev-b`) must not overwrite this entry (`dev-a`)'s state.
  await app.host.send("openbitfun.obpFrames", [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        seq: 1,
        origin: "dev-b",
        originInstance: "b-1",
        event: "account://settings-sync-state",
        payload: { enabled: false, phase: "off", active: false, pending: 0 },
      },
    }),
  ]);
  await app.wait(60);
  expect(app.shows("settings-synced")).toBe(true);

  // An applied-settings event on the entry triggers a keybindings reload.
  const countKeybindingReads = () =>
    backend.calls.filter(
      c => c.action === "get_config" && (c.request as { path?: string } | undefined)?.path === "app.keybindings",
    ).length;
  const beforeReads = countKeybindingReads();
  await app.host.send("openbitfun.obpFrames", [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        seq: 2,
        origin: "dev-a",
        originInstance: "a-1",
        event: "account://settings-applied",
        payload: { keys: ["app.keybindings"] },
      },
    }),
  ]);
  await app.waitUntil(() => countKeybindingReads() > beforeReads);
  expect(host.calls.length).toBeGreaterThan(0);
});

test("language sync uses the fleet entry while Settings displays another device", async () => {
  const backend = createBackend();
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1, full: true, removedDeviceIds: [], devices: [
        fleetDeviceRow("dev-a", "Entry", [{ workspaceId: "ws-a", name: "Entry project", rootPath: "/entry", sessions: [] }], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Peer", [{ workspaceId: "ws-b", name: "Peer project", rootPath: "/peer", sessions: [] }]),
      ],
    },
  });
  let entryLanguage = "en-US";
  const send = host.handlers["openbitfun.obpSend"];
  host.handlers["openbitfun.obpSend"] = data => {
    const reply = send!(data);
    const frame = JSON.parse((data as { frame: string }).frame);
    const command = frame.params?.command;
    const request = frame.params?.args?.request;
    const respond = (answer: Record<string, unknown>) => [JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...answer })];
    if (command === "i18n_get_current_language") {
      return respond({ error: { code: -32601, message: "Older host without an i18n getter" } });
    }
    if (command === "fleet_call" && request?.command === "get_config" && request.args?.request?.path === "app.language") {
      const language = request.target === "dev-a" ? entryLanguage : "zh-CN";
      return respond({ result: language });
    }
    return reply;
  };
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await app.press("Settings");
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.press("nav-settings-page-general");
  await app.waitFor("Interface language");

  const publish = (origin: string, seq: number, key: string) => app.host.send("openbitfun.obpFrames", [
    JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
      seq, origin, originInstance: `${origin}-1`, event: "account://settings-applied", payload: { keys: [key] },
    } }),
  ]);
  const reads = () => host.calls.filter(call => call.command === "i18n_get_current_language");
  const getConfigCalls = host.fleetCalls.filter(call => call.command === "get_config");
  expect(getConfigCalls.some(call => call.target === "dev-b")).toBe(true);
  const before = reads().length;
  expect(before).toBeGreaterThan(0);
  entryLanguage = "zh-TW";
  await publish("dev-b", 1, "app.language");
  await publish("dev-a", 1, "app.keybindings");
  expect(reads()).toHaveLength(before);
  expect(app.shows("Interface language")).toBe(true);

  await publish("dev-a", 2, "app.language");
  await app.waitFor("介面語言");
  expect(reads()).toHaveLength(before + 1);
  expect(host.fleetCalls.filter(call => call.command === "get_config"
    && (call.args.request as { path?: string })?.path === "app.language").at(-1)).toMatchObject({ target: "dev-a" });

  await app.press("id:app-language-select");
  await app.press("label:app-language-zh-CN");
  await app.waitFor("界面语言");
  await app.waitUntil(() => host.calls.some(call => call.command === "i18n_set_language"));
  expect(host.calls.filter(call => call.command === "i18n_set_language")).toEqual([
    { command: "i18n_set_language", args: { request: { language: "zh-CN" } } },
  ]);
  expect(host.fleetCalls.some(call => call.command === "i18n_set_language")).toBe(false);
});

test("appearance preferences follow the fleet entry while editing another device", async () => {
  const backend = createBackend();
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1, full: true, removedDeviceIds: [], devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Peer", []),
      ],
    },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await app.press("Settings");
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.press("nav-settings-page-appearance");
  await app.waitFor("id:font-level-select");

  await app.press("id:font-level-select");
  await app.press("label:font-level-large");
  await app.press("label:content-width-increase");
  await app.press("appearance-follow-system");

  const preferencePaths = ["font", "appearance.content_width", "appearance.selection"];
  const saved = () => host.fleetCalls.filter(call => call.command === "set_config"
    && preferencePaths.includes(String((call.args.request as { path?: string })?.path)));
  await app.waitUntil(() => saved().length >= 3);
  expect(saved().map(call => [call.target, (call.args.request as { path?: string }).path]).sort()).toEqual(
    preferencePaths.map(path => ["dev-a", path]).sort(),
  );

  await backend.handlers["openbitfun.invoke"]({
    action: "set_config", request: { path: "font", value: { uiSize: { level: "custom", customPx: 19 } } },
  });
  await backend.handlers["openbitfun.invoke"]({
    action: "set_config", request: { path: "appearance.content_width", value: 880 },
  });
  const count = host.fleetCalls.length;
  await app.host.send("openbitfun.obpFrames", [
    JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
      seq: 1, origin: "dev-a", originInstance: "dev-a-1",
      event: "account://settings-applied", payload: { keys: ["font", "appearance.content_width"] },
    } }),
  ]);
  await app.waitUntil(() => app.value("id:font-size") === "19" && app.value("id:content-width") === "880");
  const refreshed = host.fleetCalls.slice(count).filter(call => call.command === "get_config"
    && preferencePaths.includes(String((call.args.request as { path?: string })?.path)));
  expect(refreshed.some(call => (call.args.request as { path?: string }).path === "font")).toBe(true);
  expect(refreshed.some(call => (call.args.request as { path?: string }).path === "appearance.content_width")).toBe(true);
  expect(refreshed.every(call => call.target === "dev-a")).toBe(true);
});
