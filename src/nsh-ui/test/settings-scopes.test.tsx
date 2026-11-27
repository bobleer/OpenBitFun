// Settings scopes (visual spec §4.9): a left list of Preferences, Account and
// Device (with the device scope chip), pages 680 wide with a 22/600 title,
// "Synced with your account" on Preferences pages only, Account › OpenBitFun
// over the cloud agent's commands, the OpenBitFun device switches on
// Permissions, Account › Activity and the phone push layout.

import { expect, open, test } from "nsh/test";
import { designTokens } from "../src/generated/designTokens";
import { createBackend, DEFAULT_USAGE, fixtureUsageActivity, fleetDeviceRow, fleetObpHost, fleetSessionRow } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const PHONE = { width: 375, height: 812, platform: "ios" as const };
const HARNESS = "./fixtures/settingsApp.tsx";
/** The same harness with the Super Agent UI gate on (`src/productGates.ts`). */
const HARNESS_SUPER_AGENT = "./fixtures/settingsAppSuperAgent.tsx";

function fleetNavigator(peerCapabilities: string[] = ["fleet_v1"]) {
  return {
    revision: 2,
    full: true,
    devices: [
      fleetDeviceRow("cloud-1", "OpenBitFun", [], { hostKind: "cloud" }),
      fleetDeviceRow(
        "dev-a",
        "MacBook",
        [
          {
            workspaceId: "workspace-1",
            name: "OpenBitFun",
            rootPath: "/repo",
            isHostCurrent: true,
            sessions: [fleetSessionRow("dev-a", "workspace-1", "session-1", "NSH skeleton")],
          },
        ],
        { isClientDevice: true },
      ),
      fleetDeviceRow(
        "dev-b",
        "linux-box",
        [{ workspaceId: "workspace-2", name: "infra", rootPath: "/srv/infra", isHostCurrent: true, sessions: [] }],
        { hostKind: "cli", hostCapabilities: peerCapabilities },
      ),
      fleetDeviceRow("dev-c", "win-pc", [], { state: "offline" }),
    ],
    removedDeviceIds: [],
    totals: { running: 0, waiting: 0, unread: 0 },
  };
}

interface SettingsOptions {
  /** The cloud agent's `superagent_status`; `null` makes it a node without the commands. */
  superagent?: Record<string, unknown> | null;
  /** Opens the harness with the Super Agent UI gate on. */
  superAgentUi?: boolean;
  /** Optional custom invoke override run before default fixture dispatch. */
  onInvoke?: (action: string, request: Record<string, unknown> | undefined) => unknown | undefined;
  peerCapabilities?: string[];
}

async function openSettings(options: SettingsOptions = {}, size: typeof DESKTOP | typeof PHONE = DESKTOP) {
  const backend = createBackend();
  const baseInvoke = backend.handlers["openbitfun.invoke"];
  let status = options.superagent === undefined ? { enabled: true, deviceId: "cloud-1" } : options.superagent;
  const superagentCalls: Array<{ action: string; request: unknown }> = [];
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const { action, request } = data as { action?: string; request?: Record<string, unknown> };
    if (options.onInvoke && action) {
      const custom = options.onInvoke(action, request);
      if (custom !== undefined) return custom;
    }
    if (status && action?.startsWith("superagent_")) {
      superagentCalls.push({ action, request });
      if (action === "superagent_status") return { ok: true, value: status };
      if (action === "superagent_enable" || action === "superagent_disable") {
        status = { ...status, enabled: action === "superagent_enable" };
        return { ok: true, value: { enabled: status.enabled } };
      }
      if (action === "superagent_delete_data") return { ok: true, value: { deleted: true } };
    }
    return baseInvoke(data);
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: fleetNavigator(options.peerCapabilities),
  });
  const app = await open(options.superAgentUi ? HARNESS_SUPER_AGENT : HARNESS, { ...size, host: { handlers: host.handlers } });
  return { app, host, backend, superagentCalls };
}

test("the left list keeps three scopes, and only Preferences pages say they sync", async () => {
  const { app } = await openSettings();
  await app.waitFor("nav-settings-page-general");
  for (const scope of ["Preferences", "Account", "Device"]) {
    expect([scope, app.shows(`text:${scope}`)]).toEqual([scope, true]);
  }
  for (const page of ["profile", "devices", "activity", "models", "permissions", "archived", "mcp"]) {
    expect([page, app.shows(`nav-settings-page-${page}`)]).toEqual([page, true]);
  }
  // Account › Super Agent is gated off with the Super Agent entry (`src/productGates.ts`).
  expect(app.shows("nav-settings-page-openbitfun")).toBe(false);
  // The pet page is listed everywhere and says "Desktop only" off the desktop
  // app (tauri-gap §1.5, wave22-p3); the old groups are gone.
  expect(app.shows("nav-settings-page-pet")).toBe(true);
  expect(app.shows("nav-settings-page-automation")).toBe(false);
  expect(app.shows("nav-settings-page-external-agents")).toBe(false);

  // A Preferences page shows the synced line.
  await app.waitFor("settings-synced");
  expect(Number(app.spanStyle("Synced with your account").fontSize)).toBe(12);
  await app.waitFor("Interface language");

  // A Device page drops the synced line.
  await app.press("nav-settings-page-models");
  await app.waitFor("Default models");
  expect(app.shows("settings-synced")).toBe(false);
  expect(Number(app.spanStyle("Models >> nth=1").fontSize)).toBe(designTokens.typography.pageTitle.size);
  expect(String(app.spanStyle("Models >> nth=1").fontWeight)).toBe(designTokens.typography.pageTitle.weight);
});

test("the device scope chip lists runtime devices, disables an offline one and moves the context", async () => {
  const { app, host } = await openSettings();
  await app.waitFor("settings-scope-chip");
  await app.press("settings-scope-chip");
  // Local runtime desktop (isClientDevice: true) and peer runtimes are both selectable.
  await app.waitFor("settings-scope-device-dev-a");
  await app.waitFor("settings-scope-device-dev-b");
  // The cloud agent is not a device scope; an offline device is listed with its word.
  expect(app.shows("settings-scope-device-cloud-1")).toBe(false);
  expect(app.shows("settings-scope-device-dev-c")).toBe(true);
  expect(app.shows("text:Offline")).toBe(true);

  await app.press("settings-scope-device-dev-b");
  await app.press("nav-settings-page-mcp");
  // The device pages now read linux-box.
  await app.waitUntil(() => host.fleetCalls.some(call => call.target === "dev-b" && call.command === "get_mcp_servers"));

  // Switching back to the local desktop reloads device-scoped stores for dev-a.
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-a");
  await app.waitUntil(() => host.fleetCalls.some(call => call.target === "dev-a" && call.command === "get_mcp_servers"));
});

test("MCP ignores delayed catalog and config responses from the previous device", async () => {
  const host = fleetObpHost(createBackend(), {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" }, navigator: fleetNavigator(),
  });
  const send = host.handlers["openbitfun.obpSend"];
  const delayed: string[] = [];
  host.handlers["openbitfun.obpSend"] = data => {
    const frame = JSON.parse((data as { frame: string }).frame);
    const request = frame.params?.args?.request;
    if (frame.params?.command !== "fleet_call" || request?.target !== "dev-a") return send(data);
    const reply = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: frame.id, result });
    if (request.command === "get_mcp_servers") {
      delayed.push(reply([{ id: "old", name: "Previous device server", status: "Stopped", transport: "stdio", enabled: false }]));
      return [];
    }
    if (request.command === "load_mcp_json_config") {
      delayed.push(reply({ jsonConfig: '{"mcpServers":{}}', fingerprint: "old-device" }));
      return [];
    }
    return send(data);
  };
  const app = await open(HARNESS, { ...DESKTOP, host: { handlers: host.handlers } });
  await app.press("nav-settings-page-mcp");
  await app.waitUntil(() => delayed.length === 2);
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.waitFor("mcp-edit-fs-server");
  await app.host.send("openbitfun.obpFrames", delayed);
  expect(app.shows("Previous device server")).toBe(false);
  await app.press("mcp-stop-fs-server");
  await app.waitUntil(() => host.fleetCalls.some(call => call.target === "dev-b" && call.command === "stop_mcp_server"));
  await app.waitFor("mcp-start-fs-server");
  await app.press("mcp-edit-fs-server");
  await app.waitFor("mcp-draft-save");
  await app.clear("mcp-draft-name");
  await app.type("mcp-draft-name", "Device B files");
  await app.press("mcp-draft-save");
  await app.waitFor("mcp-draft-modal", { state: "gone" });
  expect(host.fleetCalls.filter(call => call.command === "save_mcp_json_config")).toMatchObject([
    { target: "dev-b", args: { expectedFingerprint: "fp-1" } },
  ]);
});

test("model pools show the selected device and retry a member on its owning device", async () => {
  const backend = createBackend();
  backend.handlers["openbitfun.invoke"]({ action: "save_model_pool", internal: true,
    request: { pool: { id: "", name: "Device B pool", strategy: "ordered", member_model_ids: ["model-1"] } } });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" }, navigator: fleetNavigator(),
  });
  const send = host.handlers["openbitfun.obpSend"];
  const delayed: string[] = [];
  let delayedPools = false;
  let delayedModels = false;
  host.handlers["openbitfun.obpSend"] = data => {
    const frame = JSON.parse((data as { frame: string }).frame);
    const request = frame.params?.args?.request;
    if (frame.params?.command !== "fleet_call" || request?.target !== "dev-a") return send(data);
    let result: unknown;
    if (request.command === "get_model_pools") {
      delayedPools = true;
      result = { version: 1, pools: [
        { id: "pool-1", name: "Previous device pool", strategy: "balanced", member_model_ids: [] },
      ] };
    } else if (request.command === "get_config" && request.args?.request?.path === "ai.models") {
      delayedModels = true;
      result = [{ id: "old-model", name: "Previous device model", enabled: true, capabilities: ["text_chat"] }];
    } else {
      return send(data);
    }
    delayed.push(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    return [];
  };

  const app = await open(HARNESS, { ...DESKTOP, host: { handlers: host.handlers } });
  await app.press("nav-settings-page-models");
  await app.waitUntil(() => delayedPools && delayedModels);
  await app.press("models-tab-pools");
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.waitFor("Device B pool");
  await app.host.send("openbitfun.obpFrames", delayed);
  expect(app.shows("Previous device pool")).toBe(false);
  await app.press("edit-pool-pool-1");
  await app.press("pool-add-members");
  await app.waitFor("pool-toggle-model-1");
  expect(app.shows("pool-toggle-old-model")).toBe(false);
  await app.press("pool-member-picker-done");
  await app.waitFor("Cooling down");
  await app.press("pool-member-actions-model-1");
  await app.press("pool-member-retry-model-1");
  await app.waitFor("Available");
  expect(host.fleetCalls.filter(call => call.command === "retry_model_pool_member")).toMatchObject([
    { target: "dev-b", args: { request: { modelId: "model-1" } } },
  ]);
  expect(host.fleetCalls.filter(call => call.command === "get_model_pool_status").map(call => call.target)).toEqual(["dev-b", "dev-b"]);
});

test("MCP reopens authorization for an expired credential on the owning device", async () => {
  const backend = createBackend({ mcpRemoteAuthConfigured: true });
  const invoke = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const action = (data as { action: string }).action;
    if (action === "restart_mcp_server") return { ok: false, error: "Handshake failed: 401 Unauthorized" };
    if (action !== "get_mcp_servers") return invoke(data);
    const reply = invoke(data) as { ok: true; value: Array<Record<string, unknown>> };
    return { ...reply, value: reply.value.map(row => row.id === "remote-docs"
      ? { ...row, enabled: true, status: "Connected" } : row) };
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" }, navigator: fleetNavigator(),
  });
  const send = host.handlers["openbitfun.obpSend"];
  const delayed: string[] = [];
  host.handlers["openbitfun.obpSend"] = data => {
    const frame = JSON.parse((data as { frame: string }).frame);
    const request = frame.params?.args?.request;
    if (frame.params?.command !== "fleet_call" || request?.command !== "restart_mcp_server" || request.target !== "dev-a") {
      return send(data);
    }
    delayed.push(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: "401 Unauthorized" } }));
    return [];
  };

  const app = await open(HARNESS, { ...DESKTOP, host: { handlers: host.handlers } });
  await app.press("nav-settings-page-mcp");
  await app.waitFor("mcp-restart-remote-docs");
  await app.press("mcp-restart-remote-docs");
  await app.waitUntil(() => delayed.length === 1);
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.waitUntil(() => app.enabled("mcp-restart-remote-docs"));
  await app.host.send("openbitfun.obpFrames", delayed);
  expect(app.shows("mcp-auth-modal")).toBe(false);

  await app.press("mcp-restart-remote-docs");
  await app.waitFor("OAuth status: waiting for the browser");
  await app.waitUntil(() => app.enabled("mcp-auth-close"));
  await app.press("mcp-auth-close");
  await app.waitFor("mcp-auth-modal", { state: "gone" });
  expect(host.fleetCalls.filter(call => ["restart_mcp_server", "start_mcp_remote_oauth", "cancel_mcp_remote_oauth"].includes(call.command)))
    .toMatchObject([
      { target: "dev-b", command: "restart_mcp_server", args: { serverId: "remote-docs" } },
      { target: "dev-b", command: "start_mcp_remote_oauth", args: { request: { serverId: "remote-docs" } } },
      { target: "dev-b", command: "cancel_mcp_remote_oauth", args: { request: { serverId: "remote-docs" } } },
    ]);

  backend.setMcpOAuthSession({ serverId: "remote-docs", status: "awaitingCallback" });
  await app.press("mcp-auth-remote-docs");
  await app.waitFor("OAuth status: waiting for the provider to redirect back");
  backend.setMcpOAuthSession({ serverId: "remote-docs", status: "authorized" });
  await app.waitFor("mcp-auth-modal", { state: "gone" });
  await app.waitFor("remote-docs is authorized");
  expect(host.fleetCalls.filter(call => call.command === "start_mcp_remote_oauth")).toHaveLength(1);
});

test("usage ignores delayed period and activity results from the previous device", async () => {
  const host = fleetObpHost(createBackend(), {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" }, navigator: fleetNavigator(),
  });
  const send = host.handlers["openbitfun.obpSend"];
  const delayed: string[] = [];
  host.handlers["openbitfun.obpSend"] = data => {
    const frame = JSON.parse((data as { frame: string }).frame);
    const request = frame.params?.args?.request;
    if (frame.params?.command !== "fleet_call" || request?.target !== "dev-a") return send(data);
    const result = request.command === "get_token_usage_statistics"
      ? { ...DEFAULT_USAGE, totalTokens: 999_000 }
      : request.command === "get_token_usage_activity"
        ? { ...fixtureUsageActivity(), totalTokens: 888_000 }
        : undefined;
    if (!result) return send(data);
    delayed.push(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    return [];
  };

  const app = await open(HARNESS, { ...DESKTOP, host: { handlers: host.handlers } });
  await app.press("nav-settings-page-usage");
  await app.waitUntil(() => delayed.length === 2);
  expect(app.enabled("id:usage-range-select")).toBe(false);
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.waitFor("id:usage-total-tokens >> text:120K");
  await app.waitFor("Each cell is one day; the busiest day is darkest. 4.0K tokens over the window.");
  await app.host.send("openbitfun.obpFrames", delayed);

  expect(app.shows("id:usage-total-tokens >> text:120K")).toBe(true);
  expect(app.shows("text:999K")).toBe(false);
  expect(app.texts().join("\n")).not.toContain("888K tokens over the window");
  expect(host.fleetCalls.filter(call => call.target === "dev-b" && call.command.startsWith("get_token_usage_"))
    .map(call => call.command).sort()).toEqual(["get_token_usage_activity", "get_token_usage_statistics"]);
});

test("usage reopens after offscreen results from a previous device are discarded", async () => {
  const host = fleetObpHost(createBackend(), {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" }, navigator: fleetNavigator(),
  });
  const send = host.handlers["openbitfun.obpSend"];
  const delayed: string[] = [];
  let delayRequests = true;
  host.handlers["openbitfun.obpSend"] = data => {
    const frame = JSON.parse((data as { frame: string }).frame);
    const request = frame.params?.args?.request;
    if (!delayRequests || frame.params?.command !== "fleet_call" || request?.target !== "dev-a") return send(data);
    const result = request.command === "get_token_usage_statistics"
      ? DEFAULT_USAGE
      : request.command === "get_token_usage_activity" ? fixtureUsageActivity() : undefined;
    if (!result) return send(data);
    delayed.push(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    return [];
  };
  const app = await open(HARNESS, { ...DESKTOP, host: { handlers: host.handlers } });

  await app.press("nav-settings-page-usage");
  await app.waitUntil(() => delayed.length === 2);
  await app.press("nav-settings-page-general");
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.host.send("openbitfun.obpFrames", delayed);
  delayRequests = false;
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-a");
  await app.press("nav-settings-page-usage");
  await app.waitFor("id:usage-total-tokens >> text:120K");
  expect(app.enabled("id:usage-range-select")).toBe(true);
  await app.waitFor("Each cell is one day; the busiest day is darkest. 4.0K tokens over the window.");
});

test("a device switch holds an MCP JSON draft and saves it on the device where it was edited", async () => {
  const { app, host } = await openSettings();
  await app.press("nav-settings-page-mcp");
  await app.press("mcp-json-toggle");
  await app.waitUntil(() => (app.value("mcp-json") ?? "").includes("fs-server"));
  const draft = JSON.stringify({ ...JSON.parse(app.value("mcp-json")!), deviceDraft: "saved on dev-a" });
  await app.clear("mcp-json");
  await app.type("mcp-json", draft);

  const switchDevice = async () => {
    await app.press("settings-scope-chip");
    await app.press("settings-scope-device-dev-b");
    await app.waitFor("settings-unsaved-dialog");
  };
  await switchDevice();
  expect(host.fleetCalls.some(call => call.target === "dev-b" && call.command === "get_mcp_servers")).toBe(false);
  await app.press("settings-unsaved-keep");
  expect(app.value("mcp-json")).toBe(draft);
  await switchDevice();
  await app.press("settings-unsaved-save");
  await app.waitUntil(() => host.fleetCalls.some(call => call.target === "dev-b" && call.command === "get_mcp_servers"));
  expect(host.fleetCalls.filter(call => call.command === "save_mcp_json_config")).toMatchObject([
    { target: "dev-a", args: { jsonConfig: draft, expectedFingerprint: "fp-1" } },
  ]);
  expect(app.shows("mcp-json-editor")).toBe(false);
});

test("a picked MCP file is read on the controller and imported only on the selected fleet device", async () => {
  const { app, host } = await openSettings();
  await app.press("nav-settings-page-mcp");
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.waitUntil(() => host.fleetCalls.some(call => call.target === "dev-b" && call.command === "load_mcp_json_config"));
  await app.waitFor("mcp-import");
  await app.press("mcp-import");
  app.onPick(() => [{ name: "controller-only.json", data: new TextEncoder().encode(JSON.stringify({
    mcpServers: { "fleet-fixture": { command: "fixture-only-command" } },
  })) }]);
  await app.press("mcp-import-pick");
  await app.waitFor("controller-only.json");
  await app.press("mcp-import-preview");
  expect(host.fleetCalls.some(call => call.command === "read_file_content" || call.command === "save_mcp_json_config")).toBe(false);
  await app.press("mcp-import-save");
  await app.waitFor("mcp-import-modal", { state: "gone" });
  const writes = host.fleetCalls.filter(call => call.command === "save_mcp_json_config");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ target: "dev-b", args: { expectedFingerprint: "fp-1" } });
  expect(String(writes[0].args.jsonConfig)).not.toContain("controller-only.json");
  expect(JSON.parse(String(writes[0].args.jsonConfig))).toMatchObject({ mcpServers: { "fleet-fixture": {
    command: "fixture-only-command", enabled: false,
  } } });
});

test("Account › OpenBitFun turns the agent off and deletes its data through the cloud node", async () => {
  const { app, host, superagentCalls } = await openSettings({ superAgentUi: true });
  await app.press("nav-settings-page-openbitfun");
  await app.waitFor("Talk to one agent that starts work on all your devices.");
  await app.waitFor("obf-toggle");
  // Every superagent command is addressed to the cloud device.
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "superagent_status"));
  expect(
    host.fleetCalls.filter(call => call.command.startsWith("superagent_")).every(call => call.target === "cloud-1"),
  ).toBe(true);

  await app.press("obf-toggle");
  // The switch was on (the node answered enabled), so a press turns it off.
  await app.waitUntil(() => superagentCalls.some(call => call.action === "superagent_disable"));
  expect(superagentCalls.some(call => call.action === "superagent_enable")).toBe(false);

  await app.press("obf-delete-data");
  await app.waitFor("obf-delete-confirm");
  expect(app.shows("obf-delete-dialog")).toBe(false);
  await app.press("obf-delete-confirm");
  await app.waitUntil(() => superagentCalls.some(call => call.action === "superagent_delete_data"));
  expect(superagentCalls.find(call => call.action === "superagent_delete_data")?.request).toEqual({ cancelJobs: true });
});

test("a node without the OpenBitFun commands answers with an explicit unsupported row", async () => {
  const { app } = await openSettings({ superagent: null, superAgentUi: true });
  await app.press("nav-settings-page-openbitfun");
  await app.waitFor("Super Agent can't be reached from here yet.");
  expect(app.shows("obf-toggle")).toBe(false);
});

test("with Super Agent gated off, Permissions shows the modes without the Super Agent switches", async () => {
  const { app, superagentCalls } = await openSettings();
  await app.press("nav-settings-page-permissions");
  await app.waitFor("Full access");
  expect(app.shows("superagent-accept-dispatch")).toBe(false);
  expect(app.texts().some(text => text.includes("Super Agent"))).toBe(false);
  // No superagent command leaves the UI while the gate is off.
  expect(superagentCalls).toEqual([]);
});

test("Permissions names the modes in plain words and writes the OpenBitFun device switches through set_superagent_settings", async () => {
  const { app, backend } = await openSettings({ superAgentUi: true });
  await app.press("nav-settings-page-permissions");
  await app.waitFor("Let Super Agent answer for me");
  await app.waitFor("Accept jobs from Super Agent");
  await app.waitFor("Full access");
  await app.waitFor("Ask first");
  // Both switches are on unless the device stored exactly false, so a press writes false,
  // as the device's own typed command (it applies the rule), never a leaf config write.
  await app.press("superagent-accept-dispatch");
  await app.waitUntil(() =>
    backend.calls.some(
      call =>
        call.action === "set_superagent_settings" &&
        (call.request as Record<string, unknown> | null)?.acceptDispatch === false,
    ),
  );
  expect(backend.settingsWrites.some(write => write.path === "superagent.acceptDispatch")).toBe(false);
});

test("Account › Activity states the host's six months in one sentence above the heatmap", async () => {
  const { app } = await openSettings();
  await app.press("nav-settings-page-activity");
  await app.waitFor("settings-activity-heatmap");
  const summary = app.texts().find(text => text.includes("active days in the last 6 months")) ?? "";
  expect(summary).toMatch(/tokens across \d+ active days in the last 6 months/);
});

test("Account › Devices and chat apps lists the account's devices, this device's switch and one phone row", async () => {
  const { app } = await openSettings();
  await app.press("nav-settings-page-devices");
  await app.waitFor("account-device-dev-b");
  expect(app.shows("text:linux-box")).toBe(true);
  expect(app.shows("text:Offline")).toBe(true);
  // Device rows are informative: what the device is, and no page to open.
  expect(app.shows("text:This device")).toBe(true);
  expect(app.shows("text:Server · OpenBitFun 9.9.9")).toBe(true);
  let opensPage = true;
  try {
    await app.press("account-device-dev-b");
  } catch {
    opensPage = false;
  }
  expect(opensPage).toBe(false);
  // The switch that hides this device from the others is a device setting, not a chat-app one.
  expect(app.shows("text:Allow other devices to control this device")).toBe(true);
  await app.press("account-open-on-phone");
  await app.waitFor("account-phone-sheet");
});

test("the phone lists the scopes first, hides desktop-only Pet, and pushes one page with a pages switcher", async () => {
  const { app } = await openSettings({}, PHONE);
  await app.waitFor("settings-compact-page-general");
  expect(app.shows("settings-scope-list")).toBe(false);
  expect(app.shows("settings-compact-page-openbitfun")).toBe(false);
  expect(app.shows("settings-compact-page-pet")).toBe(false);
  await app.press("settings-compact-page-permissions");
  await app.waitFor("settings-compact-pages");
  expect(app.shows("settings-compact-back")).toBe(false);
  await app.waitFor("Full access");
  await app.press("settings-compact-pages");
  await app.waitFor("settings-compact-page-general");
});

test("switching device scope guards unsaved drafts, masks secrets, and Default models omits Not set", async () => {
  const { app, host } = await openSettings();
  await app.press("nav-settings-page-models");
  await app.waitFor("Default models");
  // Unset default model slots show the Choose a model placeholder, never raw "Not set".
  expect(app.texts()).not.toContain("Not set");

  // The proxy fields live on the Models page's Network tab.
  await app.press("models-tab-network");
  await app.waitFor("proxy-password");
  await app.type("proxy-password", "super-secret-value");
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.waitFor("settings-unsaved-dialog");
  expect(app.texts()).toContain("Proxy password: Hidden");
  expect(app.texts().join("\n")).not.toContain("super-secret-value");

  await app.press("settings-unsaved-discard");
  await app.waitUntil(() => !app.shows("settings-unsaved-dialog"));
  await app.waitUntil(() => host.fleetCalls.some(call => call.target === "dev-b" && call.command === "get_config"));
});

test("Device › Archived sessions queries list_archived_sessions on the selected fleet device and restores there", async () => {
  const archivedByWorkspace: Record<string, Array<Record<string, unknown>>> = {
    "workspace-1": [{ session_id: "arch-a1", session_name: "Archived on MacBook", workspace_id: "workspace-1" }],
    "workspace-2": [{ session_id: "arch-b1", session_name: "Archived on Linux", workspace_id: "workspace-2" }],
  };
  const { app, host } = await openSettings({
    onInvoke: (action, request) => {
      if (action === "list_archived_sessions") {
        const wsId = String(request?.workspace_id ?? "");
        return { ok: true, value: archivedByWorkspace[wsId] ?? [] };
      }
      if (action === "unarchive_session") {
        const wsId = String(request?.workspaceId ?? "");
        const sessionId = String(request?.sessionId ?? "");
        if (archivedByWorkspace[wsId]) {
          archivedByWorkspace[wsId] = archivedByWorkspace[wsId].filter(row => row.session_id !== sessionId);
        }
        return { ok: true, value: null };
      }
      return undefined;
    },
  });
  await app.press("nav-settings-page-archived");
  await app.waitFor("settings-archived-restore-arch-a1");
  expect(host.fleetCalls.some(call => call.target === "dev-a" && call.command === "list_archived_sessions")).toBe(true);
  await app.press("settings-archived-restore-arch-a1");
  await app.waitUntil(() =>
    host.fleetCalls.some(call => call.target === "dev-a" && call.command === "unarchive_session"),
  );
  await app.waitFor("settings-archived-restore-arch-a1", { state: "gone" });
});

test("Settings coalesces parent config reads when the host returns full section documents", async () => {
  const fullDocs: Record<string, Record<string, unknown>> = {
    app: {
      language: "en-US",
      auto_update: true,
      prevent_sleep: false,
      close_button_behavior: "minimize_to_tray",
      notifications: { dialog_completion_notify: true, permission_request_notify: false },
      flow_chat: { auto_show_selection_toolbar: true },
      ai_experience: {
        enable_session_title_generation: true,
        enable_prompt_suggestion: true,
        enable_workspace_search: false,
        enable_git_commit_coauthor: true,
        voice_input: { enabled: true, default_language: "auto", max_recording_seconds: 60, microphone_device_id: "" },
      },
      worktrees: { rootPath: "~/.openbitfun/worktrees", branchPrefix: "openbitfun/", copyLocalChanges: false, autoDeleteEnabled: true, autoDeleteLimit: 15 },
      logging: { level: "info", include_sensitive_diagnostics: false },
      hooks: { enabled: true, project_hooks_enabled: false },
      keybindings: {},
    },
    ai: {
      enable_deferred_tool_loading: true,
      subagent_max_concurrency: 4,
      swarm_max_concurrency: 4,
      subagent_batch_execution_policy: "force_parallel",
      tool_execution_timeout_secs: 120,
      user_question_timeout_secs: 180,
      tool_presentation_mode: "native",
      proxy: { enabled: false, url: "", username: "", password: "" },
      stream_idle_timeout_secs: 60,
      stream_ttft_timeout_secs: 30,
      computer_use_enabled: true,
      browser_control_auto_connect_on_startup: false,
      browser_control_preferred_browser: "default",
    },
    memories: {
      generate_memories: true,
      use_memories: true,
      generate_for_btw_sessions: false,
      external_context_policy: "clear_tool_results",
      max_unused_days: 30,
      max_raw_memories_for_consolidation: 64,
      extract_model: "",
      consolidation_model: "",
      min_rollout_idle_hours: 6,
      max_rollout_age_days: 10,
      max_rollouts_per_startup: 5,
      max_rollouts_scan_limit: 2000,
      phase1_max_concurrency: 1,
    },
    editor: {
      font_size: 14, tab_size: 4, insert_spaces: true, detect_indentation: true,
      line_height: 1.5, word_wrap: "off", line_numbers: "on", minimap: { enabled: true },
      scroll_beyond_last_line: false, render_line_highlight: "line", render_whitespace: "selection",
    },
    terminal: { font_size: 14, scrollback: 1000, cursor_style: "block" },
    superagent: { allowAutoApproval: true, acceptDispatch: true },
  };
  const readPaths: string[] = [];
  const { app } = await openSettings({
    onInvoke: (action, request) => {
      if (action === "get_config") {
        const path = String(request?.path ?? "");
        readPaths.push(path);
        if (path in fullDocs) return { ok: true, value: fullDocs[path] };
      }
      return undefined;
    },
  });
  await app.waitFor("nav-settings-page-general");
  // Wait for the initial settings load to settle.
  await app.waitUntil(() => readPaths.includes("terminal") && readPaths.includes("memories"));
  // Coalesced parent reads: only the section roots are read for SETTINGS_SECTIONS (never 63 leaf RPCs);
  // `superagent` is not among them while the Super Agent UI is gated off (`src/productGates.ts`).
  const settingsRootReads = readPaths.filter(p => p in fullDocs);
  expect(new Set(settingsRootReads).size).toBe(5);
  expect(settingsRootReads.includes("superagent")).toBe(false);
  expect(readPaths.filter(p => p.startsWith("editor.") || p.startsWith("terminal.") || p.startsWith("memories.")).length).toBe(0);
});

test("execution settings use the selected runtime's model targets and write only the requested leaves", async () => {
  const { app, host } = await openSettings({
    peerCapabilities: ["fleet_v1", "model_routing_v1", "model_pool_selection_v1", "subagent_model_override_policy_v1"],
    onInvoke: (action, request) => {
      if (action === "get_config" && request?.path === "ai") return { ok: true, value: {
        allow_subagent_model_override: true, allow_tool_json_repair: true,
        agent_model_selections: { subagents: { default: { kind: "model", model_ref: "fast" }, fork: { kind: "inherit" } } },
      } };
      if (action === "get_model_pools") return { ok: true, value: { version: 1, pools: [
        { id: "review-pool", name: "Review pool", strategy: "ordered", member_model_ids: ["model-1"] },
      ] } };
      if (action === "set_config" && request?.path === "ai.allow_tool_json_repair" && request.value === true) {
        return { ok: false, error: "This fixture refused the tool argument setting" };
      }
      return undefined;
    },
  });
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.press("nav-settings-page-execution");
  await app.waitFor("Tool schema loading");
  await app.waitFor("Subagents");
  await app.waitUntil(() => app.enabled("id:subagent-default-model") &&
    host.fleetCalls.some(call => call.command === "get_model_pools" && call.target === "dev-b"));
  await app.press("id:subagent-default-model");
  await app.press("subagent-default-model-pool-review-pool");
  await app.waitFor("Review pool");
  await app.press("id:subagent-fork-model");
  await app.press("subagent-fork-model-primary");
  await app.press("id:subagent-model-override");
  await app.press("id:tool-json-repair");
  await app.waitUntil(() => app.enabled("id:tool-json-repair"));
  await app.press("id:tool-json-repair");
  await app.waitFor("This fixture refused the tool argument setting");

  expect(host.fleetCalls.filter(call => call.command === "set_config")).toMatchObject([
    { target: "dev-b", args: { request: { path: "ai.agent_model_selections.subagents.default", value: { kind: "pool", pool_id: "review-pool" } } } },
    { target: "dev-b", args: { request: { path: "ai.agent_model_selections.subagents.fork", value: { kind: "model", model_ref: "primary" } } } },
    { target: "dev-b", args: { request: { path: "ai.allow_subagent_model_override", value: false } } },
    { target: "dev-b", args: { request: { path: "ai.allow_tool_json_repair", value: false } } },
    { target: "dev-b", args: { request: { path: "ai.allow_tool_json_repair", value: true } } },
  ]);
  expect(app.accessibility("id:tool-json-repair")?.checked).toBe("false");
});

test("execution settings retain legacy subagent selections and hide pool choices on an older host", async () => {
  const { app, host } = await openSettings({
    onInvoke: (action, request) => {
      if (action === "get_config" && request?.path === "ai") return { ok: true, value: {
        allow_subagent_model_override: true,
        agent_model_defaults: { subagents: { default: { kind: "fixed", model_id: "removed-model" }, fork: { kind: "inherit" } } },
      } };
      return undefined;
    },
  });
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.press("nav-settings-page-execution");
  await app.waitFor("removed-model (not configured)");
  expect(app.enabled("id:subagent-model-override")).toBe(false);
  await app.press("id:subagent-default-model");
  expect(app.enabled("subagent-default-model-unavailable")).toBe(false);
  expect(host.fleetCalls.some(call => call.command === "get_model_pools" && call.target === "dev-b")).toBe(false);
  await app.press("subagent-default-model-primary");
  expect(host.fleetCalls.filter(call => call.command === "set_config")).toMatchObject([
    { target: "dev-b", args: { request: { path: "ai.agent_model_defaults.subagents.default", value: { kind: "fixed", model_id: "primary" } } } },
  ]);
});

test("memory settings group advanced fields and send paired changes and settings reset to the selected device", async () => {
  let document = {
    generate_memories: true, use_memories: false, generate_for_btw_sessions: true,
    external_context_policy: "clear_tool_results", extract_model: "fast", consolidation_model: null,
    min_rollout_idle_hours: 12,
  };
  const { app, host } = await openSettings({
    onInvoke: (action, request) => {
      if (action === "get_config" && request?.path === "memories") return { ok: true, value: document };
      if (action === "product_control_invoke" && request?.capabilityId === "setting.ai.memory") {
        if (request.value === false) return { ok: false, error: "Memory settings fixture refused the write" };
        document = { ...document, generate_memories: true, use_memories: true };
        return { ok: true, value: { configured: true, effectiveValue: true } };
      }
      if (action === "reset_config" && request?.path === "memories") {
        document = { ...document, generate_memories: false, use_memories: false, extract_model: "", min_rollout_idle_hours: 6 };
        return { ok: true, value: "Configuration reset" };
      }
      return undefined;
    },
  });
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.press("nav-settings-page-session-memory");
  await app.waitUntil(() => app.enabled("id:memory-enabled"));
  expect(document).toMatchObject({ generate_memories: true, use_memories: false });
  expect(app.enabled("id:memory-extract-model")).toBe(false);
  expect(app.shows("id:memory-idle-hours")).toBe(false);
  await app.type("settings-search", "A session must be idle");
  await app.press("settings-search-hit-field-memory-idle-hours");
  await app.waitFor("id:memory-idle-hours");
  expect(app.enabled("memory-idle-hours-increase")).toBe(false);
  await app.press("id:memory-advanced-toggle");
  await app.waitFor("id:memory-idle-hours", { state: "gone" });
  await app.type("settings-search", "A session must be idle");
  await app.press("settings-search-hit-field-memory-idle-hours");
  await app.waitFor("id:memory-idle-hours");

  await app.press("id:memory-enabled");
  await app.waitUntil(() => app.enabled("id:memory-extract-model"));
  expect(app.enabled("memory-idle-hours-increase")).toBe(true);
  expect(app.value("id:memory-idle-hours")).toBe("12");
  await app.press("id:memory-enabled");
  await app.waitFor("Memory settings fixture refused the write");
  expect(app.enabled("id:memory-extract-model")).toBe(true);
  expect(host.fleetCalls.filter(call => call.command === "product_control_invoke" &&
    (call.args.request as { capabilityId?: string }).capabilityId === "setting.ai.memory")).toMatchObject([true, false].map(value => ({
      target: "dev-b", args: { request: { action: "configure", capabilityId: "setting.ai.memory", optionId: "enabled", value } },
    })));
  expect(host.fleetCalls.some(call => call.command === "set_config" &&
    String((call.args.request as { path?: string }).path).startsWith("memories"))).toBe(false);

  await app.press("memory-manage");
  expect(app.enabled("memory-open-folder")).toBe(false);
  await app.press("memory-reset-settings");
  await app.waitFor("memory-reset-settings-confirm");
  expect(host.fleetCalls.some(call => call.command === "reset_config")).toBe(false);
  await app.press("memory-reset-settings-confirm");
  await app.waitFor("Follow the primary model");
  expect(app.enabled("id:memory-extract-model")).toBe(false);
  expect(host.fleetCalls.filter(call => call.command === "reset_config")).toMatchObject([
    { target: "dev-b", args: { request: { path: "memories" } } },
  ]);
  expect(host.fleetCalls.some(call => call.command === "reset_memory" || call.command === "get_memory_paths")).toBe(false);
});

test("a peer device's storage page never scans or cleans the controller's snapshot store", async () => {
  const { app, host, backend } = await openSettings();
  await app.press("settings-scope-chip");
  await app.press("settings-scope-device-dev-b");
  await app.press("nav-settings-page-storage");
  await app.waitFor("Open Storage in the desktop app to manage snapshots on this device.");
  expect(app.shows("snapshot-storage-clean")).toBe(false);
  for (const command of ["inspect_snapshot_storage", "clean_snapshot_storage"]) {
    expect(backend.actions()).not.toContain(command);
    expect(host.fleetCalls.some(call => call.command === command)).toBe(false);
  }
});

test("a long device name in the Device scope chip truncates inside its column without overlapping the Device label", async () => {
  const nav = fleetNavigator();
  nav.devices = nav.devices.map(device =>
    (device as { deviceId?: string }).deviceId === "dev-b"
      ? { ...device, name: "ecs-openbitfun-personal-lwb" }
      : device,
  );
  const backend = createBackend();
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: nav,
  });
  for (const viewport of [DESKTOP, { width: 760, height: 800, platform: "macos" as const }]) {
    const app = await open(HARNESS, { ...viewport, host: { handlers: host.handlers } });
    await app.waitFor("settings-scope-chip");
    await app.press("settings-scope-chip");
    await app.press("settings-scope-device-dev-b");
    await app.waitUntil(() => app.texts().includes("ecs-openbitfun-personal-lwb"));

    const listBox = app.layout("settings-scope-list");
    const labelBox = app.layout("text:Device");
    const chipBox = app.layout("settings-scope-chip");
    expect(listBox).toBeTruthy();
    expect(labelBox).toBeTruthy();
    expect(chipBox).toBeTruthy();
    expect(chipBox!.width).toBeGreaterThan(0);
    expect(chipBox!.x).toBeGreaterThanOrEqual(labelBox!.x + labelBox!.width);
    expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(listBox!.x + listBox!.width);
  }
});
