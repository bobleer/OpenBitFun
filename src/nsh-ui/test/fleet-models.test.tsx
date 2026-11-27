// Models of every device (wave 21): on a fleet entry the session model picker
// draws `fleet_models` as the entry projects it (the device that runs the
// session first, one header per device with its state, rows that cannot be
// picked disabled), picking another device's model stores its qualified
// reference, the chip names the model and its device, a session on another
// device asks for the catalog relative to that device, and an entry without
// the command keeps the local list exactly as before.

import { expect, open, test } from "nsh/test";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession, type BackendOptions } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const ENTRY = { protocol: 1, cursorState: {}, deviceId: "dev-a" };

function navigator() {
  return {
    revision: 2,
    full: true,
    removedDeviceIds: [],
    totals: { running: 0, waiting: 0, unread: 0 },
    devices: [
      fleetDeviceRow(
        "dev-a",
        "MacBook",
        [{ workspaceId: "workspace-1", name: "openbitfun", rootPath: "/repo", isHostCurrent: true, sessions: [fleetSessionRow("dev-a", "workspace-1", "session-1", "Fix flaky test")] }],
        { isClientDevice: true },
      ),
      fleetDeviceRow(
        "dev-b",
        "linux-box",
        [{ workspaceId: "workspace-2", name: "infra", rootPath: "/srv/infra", sessions: [fleetSessionRow("dev-b", "workspace-2", "session-5", "Build release")] }],
        { hostKind: "cli" },
      ),
    ],
  };
}

function model(id: string, name: string, ref: string, selectable = true, primary = false) {
  return { modelId: id, displayName: name, provider: "openai", capabilities: ["text_chat"], primary, modelRef: ref, selectable };
}

/** The catalog relative to the entry (dev-a) and to dev-b. */
const CATALOG: Record<string, Record<string, unknown>> = {
  "": {
    revision: 3,
    devices: [
      { deviceId: "dev-a", name: "MacBook", hostKind: "desktop", state: "online", online: true, isThisDevice: true,
        models: [model("cfg-primary", "Primary model", "cfg-primary", true, true), model("cfg-fast", "Fast model", "cfg-fast")] },
      { deviceId: "dev-b", name: "linux-box", hostKind: "cli", state: "online", online: true, isThisDevice: false,
        models: [model("big", "Big model", "fleet:dev-b/big", true, true)] },
      { deviceId: "dev-c", name: "old-laptop", hostKind: "desktop", state: "offline", online: false, isThisDevice: false,
        unavailableReason: "device_offline", models: [model("gone", "Gone model", "fleet:dev-c/gone", false)] },
    ],
  },
  "dev-b": {
    revision: 3,
    devices: [
      { deviceId: "dev-b", name: "linux-box", hostKind: "cli", state: "online", online: true, isThisDevice: true,
        models: [model("big", "Big model", "big", true, true)] },
      { deviceId: "dev-a", name: "MacBook", hostKind: "desktop", state: "online", online: true, isThisDevice: false,
        models: [model("cfg-primary", "Primary model", "fleet:dev-a/cfg-primary", true, true)] },
    ],
  },
};

async function openFleet(fleetModels?: Record<string, Record<string, unknown>>, options?: BackendOptions) {
  const backend = createBackend(options);
  const host = fleetObpHost(backend, { fleet: ENTRY, navigator: navigator(), ...(fleetModels ? { fleetModels } : {}) });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await app.waitFor("nav-library");
  return { app, host, backend };
}

function fleetModelsRequests(host: ReturnType<typeof fleetObpHost>) {
  return host.calls
    .filter(call => call.command === "fleet_models")
    .map(call => (call.args.request ?? {}) as { deviceId?: string });
}

test("the picker groups every device's models in the entry's order and stores another device's reference", async () => {
  const { app, host, backend } = await openFleet(CATALOG);
  await openSession(app, "Fix flaky test");
  await app.waitFor("Message");
  await app.press("bot-capsule-trigger");
  await app.waitFor("id:model-device-dev-b");
  // One header per device: this device first, then the others, with their state.
  expect(app.shows("text:MacBook · This device")).toBe(true);
  expect(app.shows("id:model-device-dev-b >> text:linux-box")).toBe(true);
  expect(app.shows("id:model-device-dev-c >> text:Offline")).toBe(true);
  // A host from before the label rule: its name, then its provider, in the secondary style.
  expect(app.shows("id:model-device-dev-c >> text:Gone model")).toBe(true);
  expect(app.shows("id:model-device-dev-c >> text:openai")).toBe(true);
  const texts = app.texts();
  // The picker draws after the sidebar, which may list the same device names.
  expect(texts.indexOf("MacBook · This device")).toBeLessThan(texts.lastIndexOf("linux-box"));
  // The session runs on the entry: the catalog is the entry's own view.
  expect(fleetModelsRequests(host).pop()?.deviceId).toBeUndefined();

  // A model of an offline device cannot be picked.
  const refused = await app.press("label:model-option-fleet:dev-c/gone").then(
    () => "",
    (error: unknown) => String(error),
  );
  expect(refused).toContain("is disabled");
  expect(host.fleetCalls.some(call => call.command === "update_session_model")).toBe(false);

  await app.press("label:model-option-fleet:dev-b/big");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "update_session_model"));
  const update = host.fleetCalls.filter(call => call.command === "update_session_model").pop()!;
  expect(update.target).toBe("dev-a");
  expect((update.args.request as { modelName?: string }).modelName).toBe("fleet:dev-b/big");
  // The chip names the model and the device it lives on.
  await app.waitFor("label:bot-capsule-trigger >> text:Big model · linux-box");
});

test("a session on another device reads the catalog relative to that device", async () => {
  const { app, host } = await openFleet(CATALOG);
  await openSession(app, "Build release");
  await app.waitFor("Message");
  await app.press("bot-capsule-trigger");
  await app.waitFor("text:linux-box · This device");
  expect(fleetModelsRequests(host).some(request => request.deviceId === "dev-b")).toBe(true);
  expect(app.shows("id:model-device-dev-a >> text:MacBook")).toBe(true);
});

test("the reasoning settings in a remote session model menu update the session's owner", async () => {
  const { app, host } = await openFleet(CATALOG);
  await openSession(app, "Build release");
  await app.waitFor("reasoning-picker");
  await app.press("bot-capsule-trigger");
  await app.press("model-picker-reasoning");
  await app.press("reasoning-option-high");
  await app.waitFor("label:model-picker-reasoning >> text:High");
  const reads = host.fleetCalls.filter(call => call.command === "get_session_model_target"
    && (call.args.request as { sessionId?: string })?.sessionId === "session-5");
  expect(reads).toHaveLength(1);
  expect(reads[0].target).toBe("dev-b");
  expect(host.fleetCalls.filter(call => call.command === "update_session_model")).toMatchObject([{
    target: "dev-b", args: { request: { sessionId: "session-5", workspaceId: "workspace-2", reasoningPreset: "high" } },
  }]);
});

test("editing the context window of a fleet model writes to the model owner instead of the session owner", async () => {
  const { app, host } = await openFleet(CATALOG, { configs: { "ai.models": [{
    id: "big", name: "Big model", provider: "openai", model_name: "big",
    base_url: "https://fixture.invalid/v1", enabled: true, capabilities: ["text_chat"],
  }] } });
  await openSession(app, "Fix flaky test");
  await app.press("bot-capsule-trigger");
  await app.press("label:model-option-fleet:dev-b/big");
  await app.waitFor("label:bot-capsule-trigger >> text:Big model · linux-box");
  await app.press("bot-capsule-trigger");
  await app.press("model-picker-context");
  await app.clear("model-picker-context-input");
  await app.type("model-picker-context-input", "96000");
  await app.press("model-picker-context-save");
  await app.waitFor("label:model-picker-context >> text:96.0K");

  expect(host.fleetCalls.filter(call => call.command === "update_session_model")).toMatchObject([{ target: "dev-a" }]);
  expect(host.fleetCalls.filter(call => call.command === "ai_model_upsert")).toEqual([{
    target: "dev-b", command: "ai_model_upsert", args: { request: { models: [{ id: "big", contextWindow: 96_000 }] } },
  }]);
});

test("an entry without fleet_models keeps the local model list", async () => {
  const { app } = await openFleet();
  await openSession(app, "Fix flaky test");
  await app.waitFor("Message");
  await app.press("bot-capsule-trigger");
  await app.waitFor("Fast model");
  expect(app.shows("text:Primary model")).toBe(true);
  expect(app.shows("text:openai")).toBe(true);
  expect(app.shows("text:MacBook · This device")).toBe(false);
});

test("model search combines device and model terms, filters providers and selects a qualified result with the keyboard", async () => {
  const catalog = { "": { revision: 4, devices: [
    { deviceId: "dev-a", name: "MacBook", state: "online", online: true, isThisDevice: true,
      models: [{ ...model("cfg-primary", "OpenAI", "cfg-primary", true, true), label: "gpt-5", detail: "OpenAI" }] },
    { deviceId: "dev-b", name: "linux-box", state: "online", online: true, isThisDevice: false,
      models: [
        { ...model("sonnet", "Remote Anthropic", "fleet:dev-b/sonnet"), label: "claude-sonnet", detail: "Anthropic", provider: "anthropic" },
        { ...model("haiku", "Lightweight coding", "fleet:dev-b/haiku"), label: "claude-haiku", detail: "Anthropic", provider: "anthropic" },
      ] },
    { deviceId: "dev-c", name: "old-laptop", state: "offline", online: false, isThisDevice: false, unavailableReason: "device_offline",
      models: [{ ...model("opus", "Archived model", "fleet:dev-c/opus", false), label: "claude-opus", detail: "Anthropic", provider: "anthropic" }] },
  ] } };
  const { app, host } = await openFleet(catalog);
  await openSession(app, "Fix flaky test");
  await app.press("bot-capsule-trigger");
  await app.press("model-picker-search-open");
  await app.type("model-picker-search-input", "old-laptop opus");
  await app.waitFor("label:model-option-fleet:dev-c/opus");
  expect(app.enabled("label:model-option-fleet:dev-c/opus")).toBe(false);
  await app.keyboard.press("enter");
  expect(host.fleetCalls.some(call => call.command === "update_session_model")).toBe(false);

  await app.clear("model-picker-search-input");
  await app.press("model-picker-provider-filter");
  await app.press("model-provider-openai");
  await app.waitFor("id:model-device-dev-b", { state: "gone" });
  await app.type("model-picker-search-input", "LINUX-BOX claude");
  await app.waitFor("No models match your search.");
  await app.press("model-picker-provider-filter");
  await app.press("model-provider-anthropic");
  await app.waitFor("label:model-option-fleet:dev-b/sonnet");
  expect(app.shows("label:model-option-fleet:dev-b/haiku")).toBe(true);
  expect(app.shows("id:model-device-dev-c")).toBe(false);
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "update_session_model"));
  const write = host.fleetCalls.filter(call => call.command === "update_session_model");
  expect(write).toMatchObject([{ target: "dev-a", args: { request: { modelName: "fleet:dev-b/haiku" } } }]);
});

test("the split composer searches the catalog relative to its own device", async () => {
  const { app, host } = await openFleet(CATALOG);
  await openSession(app, "Fix flaky test");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await openSession(app, "Build release");
  if (!app.shows("secondary-bot-capsule-trigger")) await app.press("secondary-composer-plus");
  await app.press("secondary-bot-capsule-trigger");
  await app.waitFor("model-option-big");
  expect(app.shows("label:model-option-fleet:dev-a/cfg-primary")).toBe(true);
  expect(app.shows("label:model-option-fleet:dev-b/big")).toBe(false);
  expect(fleetModelsRequests(host)).toContainEqual({ deviceId: "dev-b" });
  await app.press("model-picker-search-open");
  await app.type("model-picker-search-input", "big linux-box");
  await app.keyboard.press("enter");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "update_session_model"));
  expect(host.fleetCalls.filter(call => call.command === "update_session_model")).toMatchObject([{
    target: "dev-b", args: { request: { sessionId: "session-5", modelName: "big" } },
  }]);
});

test("escaping model search clears the query and the provider filter on an older host", async () => {
  const { app } = await openFleet();
  await openSession(app, "Fix flaky test");
  await app.press("bot-capsule-trigger");
  await app.press("model-picker-search-open");
  await app.type("model-picker-search-input", "cfg-fast small");
  await app.waitFor("model-option-fast-small");
  expect(app.shows("model-option-gpt-4.1-mini")).toBe(false);
  await app.press("model-picker-provider-filter");
  await app.waitFor("model-provider-openai");
  await app.keyboard.press("escape");
  await app.waitFor("model-provider-openai", { state: "gone" });
  expect(app.value("model-picker-search-input")).toBe("cfg-fast small");
  await app.press("model-picker-provider-filter");
  await app.press("model-provider-openai");
  await app.wait(200);
  await app.keyboard.press("escape");
  await app.waitFor("model-picker-search-open");
  await app.waitFor("model-option-gpt-4.1-mini");
  await app.press("model-picker-search-open");
  expect(app.value("model-picker-search-input")).toBe("");
  expect(app.shows("model-option-fast-small")).toBe(true);
});

test("rows show the host's label and provider, and two models that read the same stay distinguishable", async () => {
  // Two models of one provider share a name (the 2.0 report: "OpenAI, OpenAI, ...");
  // the host labels them by model and numbers the twins.
  const labelled = (id: string, label: string, detail: string, ref: string, primary = false) => ({
    ...model(id, "OpenAI", ref, true, primary),
    modelName: label,
    label,
    detail,
  });
  const catalog = {
    "": {
      revision: 4,
      devices: [
        { deviceId: "dev-a", name: "MacBook", hostKind: "desktop", state: "online", online: true, isThisDevice: true,
          models: [
            labelled("m1", "gpt-5", "OpenAI #1", "m1", true),
            labelled("m2", "gpt-5", "OpenAI #2", "m2"),
            labelled("m3", "gemini-2.5-pro", "Google Gemini", "m3"),
          ] },
        { deviceId: "dev-b", name: "linux-box", hostKind: "cli", state: "online", online: true, isThisDevice: false,
          models: [labelled("big", "glm-4.6", "OpenBitFun", "fleet:dev-b/big", true)] },
      ],
    },
  };
  const { app, host } = await openFleet(catalog);
  await openSession(app, "Fix flaky test");
  await app.waitFor("Message");
  await app.press("bot-capsule-trigger");
  await app.waitFor("id:model-device-dev-b");
  expect(app.shows("label:model-option-m1 >> text:gpt-5")).toBe(true);
  expect(app.shows("label:model-option-m1 >> text:OpenAI #1")).toBe(true);
  expect(app.shows("label:model-option-m2 >> text:OpenAI #2")).toBe(true);
  expect(app.shows("label:model-option-m3 >> text:gemini-2.5-pro")).toBe(true);
  expect(app.shows("label:model-option-m3 >> text:Google Gemini")).toBe(true);
  // The config name the host replaced is not what the row leads with.
  expect(app.shows("label:model-option-m1 >> text:OpenAI")).toBe(false);
  await app.press("label:model-option-fleet:dev-b/big");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "update_session_model"));
  // The chip names the model and its device.
  await app.waitFor("label:bot-capsule-trigger >> text:glm-4.6 · linux-box");
});
