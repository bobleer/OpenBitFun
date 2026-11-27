import { expect, open, test } from "nsh/test";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession } from "./support";

const desktop = { width: 1440, height: 900, platform: "macos" as const };
const source = { providerId: "fixture", sourceId: "fixture-commands" };
const workflows = ["get_external_source_control_snapshot", "get_native_prompt_command_conflicts_command",
  "set_native_prompt_command_conflict_choice_command", "expand_external_prompt_command_command"];

function command(name: string, executionTarget?: object) {
  return {
    candidateId: `fixture:${name}`,
    definition: {
      name, id: { source }, description: "Workspace prompt", contentVersion: "v1",
      availability: { state: "available" }, executionTarget,
    },
  };
}

function mockCommands(options: { name: string; workspaceId?: string; review?: boolean; execution?: object; skills?: object[] }) {
  const backend = createBackend();
  const base = backend.handlers["openbitfun.invoke"]!;
  const requests: { action: string; request: Record<string, unknown> }[] = [];
  const id = `fixture:${options.name}`;
  let selectedCandidateId: string | undefined;
  let revision = 7;
  const conflicts = () => ({
    preferenceRevision: revision,
    conflicts: options.name === "compact" ? [{ externalCandidateId: id, conflictKey: "native-guard", selectedCandidateId }] : [],
  });
  backend.handlers["openbitfun.invoke"] = data => {
    const { action, request = {} } = data as { action: string; request?: Record<string, unknown> };
    if (action === "get_mode_skill_configs" && options.skills) {
      return { ok: true, value: options.skills, transport: "dev" };
    }
    if (!workflows.includes(action)) return base(data);
    requests.push({ action, request });
    const ok = (value: unknown) => ({ ok: true, value, transport: "dev" });
    const rejected = (error: string) => ({ ok: false, error });
    if (request.workspaceId !== (options.workspaceId ?? "workspace-1")) return rejected("wrong workspace");
    switch (action) {
      case "get_external_source_control_snapshot":
        return ok({ catalog: {
          preferenceRevision: revision,
          hostCapabilities: { canExecuteExternalAssets: true },
          sources: [{ record: { key: source, displayName: "Fixture Commands" } }],
          commands: [command(options.name, options.execution)],
        } });
      case "get_native_prompt_command_conflicts_command":
        return ok(conflicts());
      case "set_native_prompt_command_conflict_choice_command":
        if (request.expectedPreferenceRevision !== revision) return rejected("stale preferences");
        selectedCandidateId = String(request.selectedCandidateId);
        revision += 1;
        return ok(conflicts());
      case "expand_external_prompt_command_command":
        if (request.candidateId !== id || request.expectedContentVersion !== "v1") return rejected("stale command");
        if (options.name === "compact" && (request.expectedNativeConflictKey !== "native-guard"
          || request.expectedPreferenceRevision !== revision || selectedCandidateId !== id)) return rejected("unresolved command");
        if (options.review) {
          const decision = request.shellReviewDecision as { mode: string; planFingerprint: string; expectedPreferenceRevision: number } | undefined;
          if (!decision || decision.planFingerprint === "plan-v1") {
            return ok({ state: "review_required", review: {
              schemaVersion: 1,
              planFingerprint: decision ? "plan-v2" : "plan-v1", preferenceRevision: revision,
              sourceDisplayName: "Fixture Commands", workingDirectory: "/workspace", shellDisplayName: "Shell",
              shellExecutable: "/bin/sh", commands: [decision ? "fixture preview v2" : "fixture preview v1"],
              canRemember: false,
            } });
          }
          if (decision.mode !== "run_once" || decision.expectedPreferenceRevision !== revision) return rejected("wrong shell decision");
        }
        return ok({ state: "ready", content: `Expanded ${request.arguments}`, executionTarget: options.execution ?? { kind: "inline" } });
    }
  };
  return { backend, requests };
}

test("a typed collision asks for a source and sends the external expansion with the original invocation", async () => {
  const { backend, requests } = mockCommands({ name: "compact" });
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  await app.type("composer", "/compact");
  await app.waitFor("label:slash-external-fixture:compact");
  await app.submit("composer");
  await app.waitFor("external-slash-choice");
  await app.waitFor("Choose a source for /compact");
  expect(backend.actions()).not.toContain("execute_session_command");
  expect(backend.actions()).not.toContain("submit_user_message");
  await app.press("label:external-slash-choose-fixture:compact");
  await app.waitUntil(() => backend.actions().includes("submit_user_message"));
  expect(requests.find(call => call.action === "get_native_prompt_command_conflicts_command")?.request).toMatchObject({
    nativeCommands: [{ commandName: "compact", candidateId: "openbitfun.desktop:action:compact" }],
  });
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-1", workspaceId: "workspace-1", text: "Expanded", displayText: "/compact",
  });
});

test("choosing the native side of a collision saves its identity and runs the session action", async () => {
  const { backend, requests } = mockCommands({ name: "compact" });
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  await app.type("composer", "/compact");
  await app.waitFor("label:slash-external-fixture:compact");
  await app.submit("composer");
  await app.waitFor("external-slash-choice");
  await app.press("label:external-slash-choose-openbitfun.desktop:action:compact");
  await app.waitUntil(() => backend.actions().includes("execute_session_command"));
  expect(requests.find(call => call.action === "set_native_prompt_command_conflict_choice_command")?.request).toMatchObject({
    selectedCandidateId: "openbitfun.desktop:action:compact", expectedPreferenceRevision: 7,
  });
  expect(requests.some(call => call.action === "expand_external_prompt_command_command")).toBe(false);
  expect(backend.actions()).not.toContain("submit_user_message");
});

test("a shell review is explicit and a changed plan requires another confirmation", async () => {
  const { backend, requests } = mockCommands({ name: "inspect", review: true });
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  await app.type("composer", "/ins");
  await app.waitFor("label:slash-external-fixture:inspect");
  await app.press("label:slash-external-fixture:inspect");
  expect(app.value("composer")).toBe("/inspect ");
  expect(requests.some(call => call.action === "expand_external_prompt_command_command")).toBe(false);
  await app.type("composer", "report");
  await app.submit("composer");
  await app.waitFor("fixture preview v1");
  expect(app.shows("external-slash-remember")).toBe(false);
  await app.press("external-slash-run-once");
  await app.waitFor("fixture preview v2");
  expect(backend.actions()).not.toContain("submit_user_message");
  await app.press("external-slash-run-once");
  await app.waitUntil(() => backend.actions().includes("submit_user_message"));
  const expansions = requests.filter(call => call.action === "expand_external_prompt_command_command");
  expect(expansions).toHaveLength(3);
  expect(expansions[2]?.request).toMatchObject({
    arguments: "report", shellReviewDecision: { planFingerprint: "plan-v2", expectedPreferenceRevision: 7, mode: "run_once" },
  });
});

test("a fresh external Agent uses the typed turn execution request", async () => {
  const execution = { kind: "fresh_external_subagent", ecosystemId: "fixture", logicalId: "specialist" };
  const { backend } = mockCommands({ name: "specialist", execution });
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  await app.type("composer", "/specialist report");
  await app.submit("composer");
  await app.waitUntil(() => backend.actions().includes("start_dialog_turn"));
  expect(backend.calls.find(call => call.action === "start_dialog_turn")?.request).toMatchObject({
    sessionId: "session-1", workspaceId: "workspace-1", userInput: "Expanded report", originalUserInput: "/specialist report",
    execution,
  });
  expect(backend.actions()).not.toContain("submit_user_message");
});

function remoteComposer(backend: ReturnType<typeof createBackend>, kind: "local" | "remote_ssh") {
  return fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 }, devices: [
      fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
      fleetDeviceRow("dev-b", "Session owner", [{
        workspaceId: "ws-b", name: "Release workspace", rootPath: "/repo", kind,
        sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Release session")],
      }]),
    ] },
  });
}

test("a browser controller sends catalog, expansion and turn requests to the session owner", async () => {
  const { backend } = mockCommands({ name: "inspect", workspaceId: "ws-b" });
  const host = remoteComposer(backend, "local");
  const app = await open("./fixtures/obpApp.tsx", { ...desktop, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-b1");
  await app.type("composer", "/inspect release");
  await app.submit("composer");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "submit_user_message"));
  for (const command of ["get_external_source_control_snapshot", "expand_external_prompt_command_command", "submit_user_message"]) {
    expect(host.fleetCalls.find(call => call.command === command)).toMatchObject({ target: "dev-b", args: { request: { workspaceId: "ws-b" } } });
  }
  expect(host.fleetCalls.find(call => call.command === "submit_user_message")?.args.request).toMatchObject({
    sessionId: "s-b1", text: "Expanded release", displayText: "/inspect release",
  });
  expect(host.pageHostCalls).toHaveLength(0);
});

test("an SSH workspace never reads local external commands from the controller or session owner", async () => {
  const { backend } = mockCommands({ name: "inspect", workspaceId: "ws-b" });
  const host = remoteComposer(backend, "remote_ssh");
  const app = await open("./fixtures/obpApp.tsx", { ...desktop, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-b1");
  await app.type("composer", "/inspect release");
  await app.submit("composer");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "submit_user_message"));
  expect(host.calls.some(call => workflows.includes(call.command))).toBe(false);
  expect(host.fleetCalls.some(call => workflows.includes(call.command))).toBe(false);
  expect(host.fleetCalls.find(call => call.command === "submit_user_message")).toMatchObject({
    target: "dev-b", args: { request: { sessionId: "s-b1", text: "/inspect release" } },
  });
});

test("the split composer offers the same sources and sends only to its own session", async () => {
  const { backend, requests } = mockCommands({
    name: "compact", skills: [{ name: "compact-guide", description: "Fixture skill for compact" }],
  });
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  await app.type("composer", "Keep this draft");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("Port the terminal.");
  await app.type("secondary-composer", "/compact");
  await app.waitFor("secondary-slash-command-compact");
  await app.waitFor("label:secondary-slash-external-fixture:compact");
  await app.waitFor("Fixture skill for compact");
  const labels = app.texts();
  expect(labels.indexOf("Fixture Commands · Workspace prompt")).toBeLessThan(labels.indexOf("Fixture skill for compact"));
  expect(app.shows("slash-command-compact")).toBe(false);
  await app.submit("secondary-composer");
  await app.waitFor("Choose a source for /compact");
  await app.press("label:external-slash-choose-fixture:compact");
  await app.waitUntil(() => backend.actions().includes("submit_user_message"));
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-2", workspaceId: "workspace-1", text: "Expanded", displayText: "/compact",
  });
  expect(requests.some(call => call.action === "expand_external_prompt_command_command")).toBe(true);
  expect(backend.actions()).not.toContain("execute_session_command");
  expect(app.value("composer")).toBe("Keep this draft");
});

test("both slash menus follow keyboard focus and keep their drafts independent", async () => {
  const { backend } = mockCommands({ name: "inspect" });
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("Port the terminal.");
  await app.type("composer", "/rel");
  await app.waitFor("slash-command-reload");
  await app.type("secondary-composer", "/ins");
  await app.waitFor("label:secondary-slash-external-fixture:inspect");
  expect(app.shows("slash-command-reload")).toBe(false);
  await app.press("label:secondary-slash-external-fixture:inspect");
  expect(app.value("secondary-composer")).toBe("/inspect ");
  expect(app.value("composer")).toBe("/rel");
  await app.type("secondary-composer", "split");
  await app.submit("secondary-composer");
  await app.waitUntil(() => backend.actions().includes("submit_user_message"));
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-2", text: "Expanded split", displayText: "/inspect split",
  });
  expect(app.value("composer")).toBe("/rel");
});

test("a split browser controller expands and sends on the right pane's device", async () => {
  const { backend } = mockCommands({ name: "inspect", workspaceId: "ws-b" });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 }, devices: [
      fleetDeviceRow("dev-a", "Entry", [{ workspaceId: "ws-a", name: "Entry project", rootPath: "/entry",
        sessions: [fleetSessionRow("dev-a", "ws-a", "s-a1", "Entry session")] }], { isClientDevice: true }),
      fleetDeviceRow("dev-b", "Session owner", [{ workspaceId: "ws-b", name: "Owner project", rootPath: "/owner",
        sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Owner session")] }]),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...desktop, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-a1");
  await app.type("composer", "Entry draft");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("id:secondary-session-pane");
  await app.press("id:sidebar-session-s-b1");
  await app.type("secondary-composer", "/inspect fleet");
  await app.submit("secondary-composer");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "submit_user_message"));
  for (const command of ["get_external_source_control_snapshot", "expand_external_prompt_command_command", "submit_user_message"]) {
    expect(host.fleetCalls.filter(call => call.command === command).every(call => call.target === "dev-b")).toBe(true);
    expect(host.fleetCalls.find(call => call.command === command)?.args.request).toMatchObject({ workspaceId: "ws-b" });
  }
  expect(host.fleetCalls.find(call => call.command === "submit_user_message")?.args.request).toMatchObject({
    sessionId: "s-b1", text: "Expanded fleet", displayText: "/inspect fleet",
  });
  expect(app.value("composer")).toBe("Entry draft");
  expect(host.pageHostCalls).toHaveLength(0);
});

test("a fresh external Agent starts a right-pane turn without clearing the other draft", async () => {
  const execution = { kind: "fresh_external_subagent", ecosystemId: "fixture", logicalId: "specialist" };
  const { backend } = mockCommands({ name: "specialist", execution });
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  await app.type("composer", "Other draft");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("Port the terminal.");
  await app.type("secondary-composer", "/specialist split");
  await app.submit("secondary-composer");
  await app.waitUntil(() => backend.actions().includes("start_dialog_turn"));
  expect(backend.calls.find(call => call.action === "start_dialog_turn")?.request).toMatchObject({
    sessionId: "session-2", workspaceId: "workspace-1", userInput: "Expanded split",
    originalUserInput: "/specialist split", execution,
  });
  expect(backend.actions()).not.toContain("submit_user_message");
  expect(app.value("composer")).toBe("Other draft");
});
