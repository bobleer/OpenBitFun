import { expect, open, test } from "nsh/test";
import { showDevices, createBackend, createDeviceBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, type BackendOptions } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };

const EXTERNAL_COMMANDS = [
  "get_external_source_discovery_snapshot",
  "get_external_source_control_snapshot",
  "get_external_source_snapshot",
  "apply_external_source_control_action_command",
  "reveal_external_source_location",
  "update_external_integration_policy_command",
  "plan_external_mcp_import_command",
  "apply_external_mcp_import_command",
  "list_removed_external_sessions",
  "restore_removed_external_session",
];
const EXTERNAL_ASSET_COMMANDS = [
  "get_instruction_source_catalog",
  "get_skill_configs",
  "get_global_skill_settings",
  "set_global_skill_disabled",
  "get_external_hook_import_snapshot",
  "get_external_hook_catalog",
  "plan_external_hook_import_command",
  "apply_external_hook_import_command",
  "mutate_external_hook_import_command",
];
const RUNTIME_REVIEW_COMMANDS = [
  "set_external_source_conflict_choice_command",
  "set_external_tool_conflict_choice_command",
  "choose_external_subagent_conflict_command",
  "choose_external_mcp_conflict_command",
  "set_external_tool_target_decision_command",
  "set_external_subagent_activation_command",
  "set_external_mcp_server_decision_command",
  "set_external_tool_targets_enabled_command",
  "set_external_subagents_enabled_command",
  "set_external_mcp_servers_enabled_command",
  "set_external_subagent_model_binding_command",
];

type Recorded = { action: string; payload: Record<string, unknown>; raw: boolean };

/** Plays the host's external-source commands on top of the simulated backend. */
function withExternalHost(
  options: BackendOptions & { device?: boolean },
  answer: (action: string, payload: Record<string, unknown>) => unknown,
  assetCommands: string[] = [],
) {
  const base = options.device ? createDeviceBackend(options) : createBackend(options);
  const originalInvoke = base.handlers["openbitfun.invoke"];
  const recorded: Recorded[] = [];
  base.handlers["openbitfun.invoke"] = (data: unknown) => {
    const args = (data ?? {}) as { action?: string; request?: unknown; raw?: unknown };
    const action = args.action ?? "";
    const raw = Object.prototype.hasOwnProperty.call(args, "raw");
    const payload = ((raw ? args.raw : args.request) ?? {}) as Record<string, unknown>;
    recorded.push({ action, payload, raw });
    if (EXTERNAL_COMMANDS.includes(action) || RUNTIME_REVIEW_COMMANDS.includes(action) || assetCommands.includes(action)) {
      try {
        return { ok: true, value: answer(action, payload), transport: "dev" };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), transport: "dev" };
      }
    }
    return originalInvoke(data);
  };
  return { backend: base, recorded };
}

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    hostCapabilities: {
      canRefresh: true,
      canMutatePolicy: true,
      canManageSources: true,
      canApproveRuntime: true,
      canExecuteExternalAssets: true,
      canSetSafeMode: true,
    },
    generation: 3,
    discoveryPending: false,
    sources: [
      {
        stableKey: "claude-code:user",
        record: {
          key: { providerId: "claude-code", sourceId: "user" },
          ecosystemId: "claude-code",
          displayName: "Claude Code",
          sourceKind: "config",
          scope: "user_global",
          location: "~/.claude",
          executionDomainId: "local",
          health: "available",
          contentVersion: "v1",
        },
        lifecycle: "available",
      },
      {
        stableKey: "opencode:project",
        record: {
          key: { providerId: "opencode", sourceId: "project" },
          ecosystemId: "opencode",
          displayName: "OpenCode",
          sourceKind: "config",
          scope: "project",
          location: "/repo/.opencode",
          executionDomainId: "local",
          health: "degraded",
          contentVersion: "v1",
        },
        lifecycle: "degraded",
      },
    ],
    commands: [{ definition: { name: "review" } }, { definition: { name: "ship" } }],
    mcpServers: [{ candidateId: "mcp-1" }, { candidateId: "mcp-2" }, { candidateId: "mcp-3" }],
    integrationPolicy: {
      registeredEcosystems: [
        { ecosystemId: "claude-code", displayName: "Claude Code", adapterRevision: "1", capabilities: [] },
        { ecosystemId: "opencode", displayName: "OpenCode", adapterRevision: "1", capabilities: [] },
      ],
    },
    ...overrides,
  };
}

function discoverySnapshot(enabled: boolean, revision: number) {
  return {
    schemaVersion: 1,
    automaticDiscovery: enabled,
    canChangeAutomaticDiscovery: true,
    hasScanned: true,
    discoverableCapabilities: { "claude-code": ["mcp"] },
    preferenceRevision: revision,
    catalog: catalog(),
  };
}

function catalogWithCodex() {
  const base = catalog();
  return { ...base, integrationPolicy: { registeredEcosystems: [...base.integrationPolicy.registeredEcosystems,
    { ecosystemId: "codex", displayName: "Codex", adapterRevision: "1", capabilities: [] }] } };
}

function controlSnapshot(preferenceRevision: number, safeMode: boolean, enabled: boolean) {
  const current = catalog();
  const runtime = {
    stableKey: "opencode-runtime-workspace", lifecycle: "available",
    record: { ...current.sources[1].record, displayName: "Runtime settings", location: "/repo/.opencode/runtime" },
  };
  return { catalog: { ...current, sources: [...current.sources, runtime] }, control: { schemaVersion: 1, preferenceRevision, safeMode,
    hostCapabilities: { ...current.hostCapabilities, canRevealSourceLocation: true },
    sources: [{ stableKey: "claude-code:user", desired: enabled ? "enabled" : "disabled",
      effectiveStatus: enabled ? "available" : "disabled" },
    { stableKey: runtime.stableKey, desired: "enabled", effectiveStatus: "available" }],
  } };
}

const runtimeRefs = { claude: catalog().sources[0].record.key, opencode: catalog().sources[1].record.key };
const runtimeAgent = {
  candidateId: "review-agent", logicalId: "reviewer", displayName: "External review agent", providerLabel: "Claude Code",
  description: "Fixture review profile", sourceKeys: [runtimeRefs.claude], sourceLocationLabels: ["/repo/.claude/agents/review.md"],
  scope: "project", effectiveModelLabel: "Fixture model", effectiveToolLabels: ["Read"], compatibilityState: "compatible",
  decisionKey: "agent-reviewed-version",
};
const runtimeMcp = {
  candidateId: "review-mcp", decisionKey: "mcp-reviewed-version", definition: {
    id: { source: runtimeRefs.claude, localId: "reporting" }, name: "Review reporting server", transport: "local_stdio",
    commandPreview: "fixture-mcp", argumentCount: 2, environmentKeys: ["TOKEN"], workingDirectory: "/repo",
    timeouts: { executionMs: 2500 },
  },
};
const runtimeTool = {
  approvalKey: "review-tool", decisionKey: "tool-reviewed-version", sourceDisplayName: "Fixture Automation Tools",
  sourceScope: "project", sourceLocation: "/repo/.claude/tools", workingDirectory: "/repo",
  runtimeKind: "javascript", capabilities: ["file_system", "network"], toolNames: ["release_summary"],
  targetId: { source: runtimeRefs.claude, localId: "fixture-tools" },
};

function reviewControl(revision: number, {
  pending = ["tool", "subagent", "mcp"],
  chosen = new Map<string, string>(),
  canApproveRuntime = true,
}: { pending?: string[]; chosen?: Map<string, string>; canApproveRuntime?: boolean } = {}) {
  const response = controlSnapshot(revision, false, true);
  return { control: { ...response.control, hostCapabilities: { ...response.control.hostCapabilities, canApproveRuntime } },
    catalog: {
      ...response.catalog, subagentGeneration: 21, mcpGeneration: 31,
      subagents: [runtimeAgent], pendingSubagentApprovals: pending.includes("subagent") ? [runtimeAgent.candidateId] : [],
      tools: [{ approvalKey: runtimeTool.approvalKey, decisionKey: runtimeTool.decisionKey, definition: { modulePath: "/repo/tools/fixture.js" } }],
      toolApprovalRequests: pending.includes("tool") ? [runtimeTool] : [],
      mcpServers: [runtimeMcp], mcpApprovalRequests: pending.includes("mcp") ? [runtimeMcp] : [],
      commandConflicts: [{ conflictKey: "cmd-conflict", commandName: "Review command conflict", selectedCandidateId: chosen.get("cmd-conflict"),
        candidates: [
          { candidateId: "cmd-claude", source: runtimeRefs.claude, sourceDisplayName: "Claude review command", ecosystemId: "claude-code",
            sourceLocation: "/repo/.claude/commands/review.md", availability: { state: "available" } },
          { candidateId: "cmd-opencode", source: runtimeRefs.opencode, sourceDisplayName: "OpenCode review command", ecosystemId: "opencode",
            sourceLocation: "/repo/.opencode/commands/review.md", availability: { state: "restricted", reason: "Unavailable shell" } },
        ],
      }],
      toolConflicts: [{ conflictKey: "tool-conflict", toolName: "Review tool conflict", selectedCandidateId: chosen.get("tool-conflict"),
        candidates: [{ candidateId: "tool-native", displayName: "Built-in Review tool", kind: "built_in", providerId: "openbitfun" },
          { candidateId: "tool-external", displayName: "External Review tool", kind: "external", source: runtimeRefs.claude, providerId: "claude-code" }],
      }],
      subagentConflicts: [{ conflictKey: "agent-conflict", logicalId: "Review assistant conflict", selectedCandidateId: chosen.get("agent-conflict"),
        candidates: [{ candidateId: "agent-native", displayName: "Built-in Review assistant", sourceLabel: "OpenBitFun", external: false },
          { candidateId: runtimeAgent.candidateId, displayName: runtimeAgent.displayName, sourceLabel: "Claude Code", external: true }],
      }],
      mcpConflicts: [{ conflictKey: "mcp-conflict", serverName: "Review server conflict", selectedCandidateId: chosen.get("mcp-conflict"),
        candidates: [{ candidateId: "mcp-native", displayName: "OpenBitFun Review server", external: false, available: true },
          { candidateId: runtimeMcp.candidateId, displayName: runtimeMcp.definition.name, source: runtimeRefs.claude, external: true, available: true }],
      }],
    },
  };
}

test("source switches and Safe Mode use the latest host revision, and reveal uses the reported source identity", async () => {
  let revision = 7;
  let enabled = true;
  let safeMode = false;
  let conflict = true;
  let controlReads = 0;
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, revision);
    if (action === "get_external_source_control_snapshot") {
      const snapshot = controlSnapshot(revision, safeMode, enabled);
      if (++controlReads === 1) return { ...snapshot, catalog: { ...snapshot.catalog, sources: [], discoveryPending: true },
        control: { ...snapshot.control, sources: [] } };
      return snapshot;
    }
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "reveal_external_source_location") return null;
    if (action === "apply_external_source_control_action_command") {
      const control = payload.control as { expectedPreferenceRevision: number; action: { type: string; enabled: boolean } };
      if (conflict) {
        conflict = false;
        revision += 1;
        throw new Error(JSON.stringify({ code: "stale_revision", detail: "Host revision advanced" }));
      }
      if (control.expectedPreferenceRevision !== revision) throw new Error("Unexpected source preference revision");
      if (control.action.type === "set_safe_mode") safeMode = control.action.enabled;
      else enabled = control.action.enabled;
      revision += 1;
      return controlSnapshot(revision, safeMode, enabled);
    }
    throw new Error(`unknown command ${action}`);
  });
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("External Safe Mode");
  await app.waitFor("label:external-source-enabled-claude-code:user");
  await app.press("label:external-source-enabled-claude-code:user");
  await app.waitFor("The source settings changed on the host. Check the refreshed settings before trying again.");
  await app.waitUntil(() => app.enabled("label:external-source-enabled-claude-code:user"));
  expect(enabled).toBe(true);
  await app.press("label:external-source-enabled-claude-code:user");
  await app.waitFor("Disabled");
  await app.waitUntil(() => app.enabled("external-source-safe-mode"));
  await app.press("external-source-safe-mode");
  await app.waitFor("New external calls are paused on this host. Calls already in progress may finish.");
  await app.waitUntil(() => app.enabled("label:external-source-reveal-claude-code:user"));
  await app.press("label:external-source-reveal-claude-code:user");
  const writes = recorded.filter(call => call.action === "apply_external_source_control_action_command");
  expect(writes).toHaveLength(3);
  expect(writes.map(call => call.payload)).toMatchObject([7, 8, 9].map((expectedPreferenceRevision, index) => ({
    workspaceId: "workspace-1",
    control: { schemaVersion: 1, expectedPreferenceRevision, action: index === 2 ? { type: "set_safe_mode", enabled: true }
      : { type: "set_source_enabled", sourceKey: "claude-code:user", enabled: false } },
  })));
  expect(recorded.find(call => call.action === "reveal_external_source_location")?.payload).toEqual({
    workspaceId: "workspace-1", sourceKey: "claude-code:user",
  });
  await app.press("id:external-app-opencode");
  await app.waitFor("Runtime settings");
  await app.waitFor("external-source-enabled-opencode-runtime-workspace");
});

test("subscription account status follows the selected provider and sign-in opens model subscriptions", async () => {
  const { backend, recorded } = withExternalHost({}, action => {
    if (action === "get_external_source_discovery_snapshot") return { ...discoverySnapshot(true, 1), catalog: catalogWithCodex() };
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "list_subscription_accounts") return [
      { provider: "codex", display_label: "Codex", connected: true, account: "sample@example.invalid" },
      { provider: "opencode", display_label: "OpenCode Zen", connected: false, reauthentication_required: true },
    ];
    throw new Error(`unknown command ${action}`);
  }, ["list_subscription_accounts"]);
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("id:external-app-codex");
  expect(recorded.some(call => call.action === "list_subscription_accounts")).toBe(false);
  await app.press("id:external-app-codex");
  await app.waitFor("sample@example.invalid");
  await app.waitFor("Manage account and models");
  await app.press("id:external-app-opencode");
  await app.waitFor("Reauth needed");
  expect(app.shows("sample@example.invalid")).toBe(false);
  await app.press("external-account-models");
  await app.waitFor("AI subscriptions");
  expect(recorded.find(call => call.action === "list_subscription_accounts")).toMatchObject({ raw: true, payload: {} });
  expect(recorded.some(call => call.action.startsWith("begin_subscription"))).toBe(false);
});

test("external approvals show reviewed facts and reload changed decisions before a new confirmation", async () => {
  let revision = 10;
  let pending = ["tool", "subagent", "mcp"];
  let conflict = true;
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, revision);
    if (action === "get_external_source_control_snapshot") return reviewControl(revision, { pending });
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (RUNTIME_REVIEW_COMMANDS.includes(action)) {
      if (payload.expectedPreferenceRevision !== revision) throw new Error("Unexpected review revision");
      revision += 1;
      if (conflict) { conflict = false; throw new Error(JSON.stringify({ code: "stale_revision", detail: "Review changed" })); }
      const kind = action.includes("tool") ? "tool" : action.includes("subagent") ? "subagent" : "mcp";
      pending = pending.filter(value => value !== kind);
      return reviewControl(revision, { pending }).catalog;
    }
    throw new Error(`unknown command ${action}`);
  });
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("Pending approvals");
  await app.press("external-approval-review-review-tool");
  await app.waitFor("File system · Network");
  await app.waitFor("/repo/tools/fixture.js");
  expect(recorded.filter(call => RUNTIME_REVIEW_COMMANDS.includes(call.action))).toHaveLength(0);
  await app.press("external-runtime-confirm");
  await app.waitFor("The source settings changed on the host. Check the refreshed settings before trying again.");
  await app.waitUntil(() => app.enabled("external-approval-review-review-tool"));
  expect(pending).toContain("tool");
  await app.press("external-approval-review-review-tool");
  await app.press("external-runtime-confirm");
  await app.waitUntil(() => app.count("external-approval-review-review-tool") === 0 && app.enabled("external-approval-review-review-agent"));
  await app.press("external-approval-review-review-agent");
  await app.waitFor("Fixture model");
  await app.press("external-runtime-decline");
  await app.waitUntil(() => app.count("external-approval-review-review-agent") === 0 && app.enabled("external-approval-review-review-mcp"));
  await app.press("external-approval-review-review-mcp");
  await app.waitFor("fixture-mcp");
  await app.waitFor("TOKEN");
  await app.waitFor("2,500 ms");
  await app.press("external-runtime-confirm");
  await app.waitUntil(() => app.count("external-approval-review-review-mcp") === 0);
  expect(recorded.filter(call => RUNTIME_REVIEW_COMMANDS.includes(call.action)).map(call => [call.action, call.payload])).toEqual([
    ["set_external_tool_target_decision_command", { workspaceId: "workspace-1", expectedPreferenceRevision: 10,
      approvalKey: "review-tool", decisionKey: "tool-reviewed-version", approved: true }],
    ["set_external_tool_target_decision_command", { workspaceId: "workspace-1", expectedPreferenceRevision: 11,
      approvalKey: "review-tool", decisionKey: "tool-reviewed-version", approved: true }],
    ["set_external_subagent_activation_command", { workspaceId: "workspace-1", expectedPreferenceRevision: 12,
      candidateId: "review-agent", decisionKey: "agent-reviewed-version", expectedSubagentGeneration: 21, approved: false }],
    ["set_external_mcp_server_decision_command", { workspaceId: "workspace-1", expectedPreferenceRevision: 13,
      candidateId: "review-mcp", decisionKey: "mcp-reviewed-version", expectedMcpGeneration: 31, approved: true }],
  ]);
});

test("command, tool, agent, and MCP conflicts save only confirmed candidates and respect reported availability", async () => {
  let revision = 8;
  let writable = true;
  const chosen = new Map<string, string>();
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, revision);
    if (action === "get_external_source_control_snapshot") return reviewControl(revision, { pending: [], chosen, canApproveRuntime: writable });
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (RUNTIME_REVIEW_COMMANDS.includes(action)) {
      if (!writable || payload.expectedPreferenceRevision !== revision) throw new Error("Unexpected review revision");
      chosen.set(String(payload.conflictKey), String(payload.candidateId));
      revision += 1;
      return reviewControl(revision, { pending: [], chosen }).catalog;
    }
    throw new Error(`unknown command ${action}`);
  });
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("Conflicts");
  await app.press("external-conflict-review-cmd-conflict");
  await app.waitFor("OpenCode review command");
  expect(app.enabled("external-runtime-candidate-cmd-opencode")).toBe(false);
  await app.press("external-runtime-candidate-cmd-claude");
  await app.waitFor("/repo/.claude/commands/review.md");
  expect(recorded.filter(call => RUNTIME_REVIEW_COMMANDS.includes(call.action))).toHaveLength(0);
  await app.press("external-runtime-confirm");
  await app.waitFor("Command · Selected · Claude review command");

  for (const [conflictKey, candidate] of [["tool-conflict", "tool-native"], ["mcp-conflict", "review-mcp"], ["agent-conflict", "review-agent"]]) {
    await app.waitUntil(() => app.enabled(`external-conflict-review-${conflictKey}`));
    await app.press(`external-conflict-review-${conflictKey}`);
    await app.press(`external-runtime-candidate-${candidate}`);
    if (conflictKey !== "tool-conflict") await app.waitFor("Allow and use");
    await app.press("external-runtime-confirm");
    await app.waitUntil(() => chosen.get(conflictKey) === candidate && app.count("external-runtime-review-dialog") === 0);
  }
  await app.press("external-conflict-review-agent-conflict");
  await app.press("external-runtime-disable-all");
  await app.press("external-runtime-confirm");
  await app.waitFor("Subagent · Disable all candidates");
  expect(recorded.filter(call => RUNTIME_REVIEW_COMMANDS.includes(call.action)).map(call => [call.action, call.payload])).toEqual([
    ["set_external_source_conflict_choice_command", { workspaceId: "workspace-1", conflictKey: "cmd-conflict", candidateId: "cmd-claude", expectedPreferenceRevision: 8 }],
    ["set_external_tool_conflict_choice_command", { workspaceId: "workspace-1", conflictKey: "tool-conflict", candidateId: "tool-native", expectedPreferenceRevision: 9 }],
    ["choose_external_mcp_conflict_command", { workspaceId: "workspace-1", conflictKey: "mcp-conflict", candidateId: "review-mcp",
      expectedPreferenceRevision: 10, expectedMcpGeneration: 31, approveExternal: true }],
    ["choose_external_subagent_conflict_command", { workspaceId: "workspace-1", conflictKey: "agent-conflict", candidateId: "review-agent",
      expectedPreferenceRevision: 11, expectedSubagentGeneration: 21, approveExternal: true }],
    ["choose_external_subagent_conflict_command", { workspaceId: "workspace-1", conflictKey: "agent-conflict", candidateId: "__openbitfun_disabled__",
      expectedPreferenceRevision: 12, expectedSubagentGeneration: 21, approveExternal: false }],
  ]);
  writable = false;
  await app.press("external-import-refresh");
  await app.waitUntil(() => app.enabled("external-conflict-review-tool-conflict"));
  await app.press("external-conflict-review-tool-conflict");
  await app.waitFor("Review details are read-only on this host.");
  await app.press("external-runtime-candidate-tool-external");
  expect(app.enabled("external-runtime-confirm")).toBe(false);
});

const PLAN = {
  schemaVersion: 1,
  planFingerprint: "fp-1",
  items: [
    { candidateId: "mcp-1", displayName: "github", transport: "local_stdio", disposition: "eligible" },
    {
      candidateId: "mcp-2",
      displayName: "linear",
      transport: "streamable_http",
      proposedNativeId: "linear-2",
      disposition: "automatic_rename",
    },
    {
      candidateId: "mcp-3",
      displayName: "secrets",
      transport: "local_stdio",
      disposition: "unavailable",
      reasonCode: "external_mcp.import_setup_required",
    },
  ],
};

async function openExternalImport(handlers: Record<string, (data: unknown) => unknown>) {
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers } });
  await app.waitFor("nav-library");
  await app.press("Settings");
  await app.press("nav-settings-page-external-import");
  return app;
}

function managedRuntime(revision: number, options: {
  mcpState?: string; toolState?: string; agentState?: string;
  target?: { kind: string; modelId?: string } | null; canApprove?: boolean;
} = {}) {
  const agentState = options.agentState ?? "approval_required";
  const pending = [agentState === "approval_required" ? "subagent" : "", options.mcpState === "approval_required" ? "mcp" : ""];
  const base = reviewControl(revision, { pending, canApproveRuntime: options.canApprove !== false });
  const tool = (name: string, localId = "fixture-tools", source = runtimeRefs.claude) => ({
    approvalKey: localId + "-key", decisionKey: localId + "-version", activation: { state: options.toolState ?? "active" },
    definition: { id: { target: { source, localId }, exportId: name }, name,
      descriptionPreview: "Fixture host tool", modulePath: "/repo/fixtures/runtime.js",
      workingDirectory: "/repo", runtimeKind: "javascript", capabilities: ["file_system"] },
  });
  const target = "target" in options ? options.target : { kind: "model", modelId: "retired" };
  return { ...base, catalog: { ...base.catalog,
    tools: [tool("Runtime summary tool"), tool("Runtime render tool"), tool("Other app tool", "other-tools", runtimeRefs.opencode)],
    subagents: [{ ...runtimeAgent, activationState: { state: agentState }, mode: "subagent" }],
    mcpServers: [{
      ...runtimeMcp, activationState: { state: options.mcpState ?? "active" },
    }],
    subagentModelBindingOptions: [{ target: { kind: "model", modelId: "model-1" }, effectiveModelLabel: "Available fixture model",
      configuredReasoningEffort: "high" }],
    subagentModelBindingGroups: [{ bindingKey: "review-model-group", request: { kind: "reference", modelName: "Requested fixture model" },
      profileRequest: { kind: "named_variant", name: "long-context" }, scope: "project",
      method: target ? target.modelId === "retired" ? "binding_unavailable" : "explicit" : "binding_required",
      selectedTarget: target, affectedCandidateIds: [runtimeAgent.candidateId] }],
  } };
}

test("managed external MCP can be disabled and re-enabled against the current snapshot", async () => {
  let revision = 60;
  let mcpState = "active";
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, revision);
    if (action === "get_external_source_control_snapshot") return managedRuntime(revision, { mcpState });
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "set_external_mcp_server_decision_command") {
      if (payload.expectedPreferenceRevision !== revision) throw new Error("Unexpected revision");
      mcpState = payload.approved ? "active" : "declined";
      revision += 1;
      return catalog();
    }
    throw new Error(`unknown command ${action}`);
  });
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("External MCP servers");
  await app.press("external-runtime-details-mcp-review-mcp");
  await app.waitFor("fixture-mcp");
  expect(recorded.some(call => call.action === "set_external_mcp_server_decision_command")).toBe(false);
  await app.press("external-runtime-item-disable");
  await app.waitFor("Declined");
  await app.waitUntil(() => app.enabled("external-runtime-details-mcp-review-mcp"));
  await app.press("external-runtime-details-mcp-review-mcp");
  await app.press("external-runtime-inventory-confirm");
  await app.waitUntil(() => mcpState === "active" && !app.shows("external-runtime-inventory-dialog"));
  expect(recorded.filter(call => call.action === "set_external_mcp_server_decision_command").map(call => call.payload)).toEqual([
    { workspaceId: "workspace-1", candidateId: "review-mcp", decisionKey: "mcp-reviewed-version",
      expectedMcpGeneration: 31, expectedPreferenceRevision: 60, approved: false },
    { workspaceId: "workspace-1", candidateId: "review-mcp", decisionKey: "mcp-reviewed-version",
      expectedMcpGeneration: 31, expectedPreferenceRevision: 61, approved: true },
  ]);
});

test("runtime batch reviews stay in the selected app, deduplicate tool targets and reject stale approval", async () => {
  let revision = 70;
  let toolState = "active";
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, revision);
    if (action === "get_external_source_control_snapshot") {
      const snapshot = managedRuntime(revision, { toolState });
      return { ...snapshot, catalog: { ...snapshot.catalog, generation: revision - 60 } };
    }
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "set_external_tool_targets_enabled_command") {
      if (payload.expectedCatalogGeneration !== revision - 60 || payload.expectedPreferenceRevision !== revision) {
        throw new Error("Unexpected catalog generation or revision");
      }
      revision += 1;
      if (revision === 71) throw new Error(JSON.stringify({ code: "stale_revision", detail: "Generation advanced" }));
      toolState = "disabled";
      return catalog();
    }
    throw new Error(`unknown command ${action}`);
  });
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("Runtime summary tool");
  await app.waitFor("Runtime render tool");
  expect(app.shows("Other app tool")).toBe(false);
  await app.press("external-runtime-bulk-disable-tool");
  await app.waitFor("Review external capabilities to disable");
  expect(recorded.filter(call => call.action === "set_external_tool_targets_enabled_command")).toHaveLength(0);
  await app.press("external-runtime-inventory-confirm");
  await app.waitFor("The host updated this review. Close it and open the latest version.");
  expect(app.enabled("external-runtime-inventory-confirm")).toBe(false);
  await app.waitUntil(() => app.enabled("Cancel"));
  await app.press("Cancel");
  await app.press("external-runtime-bulk-disable-tool");
  await app.press("external-runtime-inventory-confirm");
  await app.waitUntil(() => toolState === "disabled" && !app.shows("external-runtime-inventory-dialog"));
  expect(recorded.filter(call => call.action === "set_external_tool_targets_enabled_command").map(call => call.payload))
    .toEqual([70, 71].map(expectedPreferenceRevision => ({
      workspaceId: "workspace-1", decisions: [{ approvalKey: "fixture-tools-key", decisionKey: "fixture-tools-version" }],
      enabled: false, expectedPreferenceRevision, expectedCatalogGeneration: expectedPreferenceRevision - 60,
    })));
});

test("batch approval uses the subagent and MCP versions reviewed for the selected application", async () => {
  let revision = 90;
  let agentState = "approval_required";
  let mcpState = "approval_required";
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, revision);
    if (action === "get_external_source_control_snapshot") return managedRuntime(revision, { agentState, mcpState });
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "set_external_subagents_enabled_command") {
      if (payload.expectedPreferenceRevision !== revision || payload.expectedSubagentGeneration !== 21) throw new Error("Unexpected subagent version");
      agentState = "active";
      revision += 1;
      return catalog();
    }
    if (action === "set_external_mcp_servers_enabled_command") {
      if (payload.expectedPreferenceRevision !== revision || payload.expectedMcpGeneration !== 31) throw new Error("Unexpected MCP version");
      mcpState = "active";
      revision += 1;
      return catalog();
    }
    throw new Error(`unknown command ${action}`);
  });
  const app = await openExternalImport(backend.handlers);
  const batchCalls = () => recorded.filter(call => ["set_external_subagents_enabled_command", "set_external_mcp_servers_enabled_command"].includes(call.action));
  for (const [index, kind] of ["subagent", "mcp"].entries()) {
    await app.waitUntil(() => app.enabled(`external-runtime-bulk-enable-${kind}`));
    await app.press(`external-runtime-bulk-enable-${kind}`);
    expect(batchCalls()).toHaveLength(index);
    await app.press("external-runtime-inventory-confirm");
    await app.waitUntil(() => batchCalls().length === index + 1 && !app.shows("external-runtime-inventory-dialog"));
  }
  expect(batchCalls().map(call => [call.action, call.payload])).toEqual([
    ["set_external_subagents_enabled_command", { workspaceId: "workspace-1", expectedPreferenceRevision: 90,
      expectedSubagentGeneration: 21, enabled: true, decisions: [{ candidateId: runtimeAgent.candidateId, decisionKey: runtimeAgent.decisionKey }] }],
    ["set_external_mcp_servers_enabled_command", { workspaceId: "workspace-1", expectedPreferenceRevision: 91,
      expectedMcpGeneration: 31, enabled: true, decisions: [{ candidateId: runtimeMcp.candidateId, decisionKey: runtimeMcp.decisionKey }] }],
  ]);
});

test("subagent model bindings edit only host-listed targets on the owner device", async () => {
  let revision = 80;
  let target: { kind: string; modelId?: string } | null = { kind: "model", modelId: "retired" };
  const { backend } = withExternalHost({ device: true }, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, revision);
    if (action === "get_external_source_control_snapshot") return managedRuntime(revision, { target, canApprove: revision < 82 });
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "set_external_subagent_model_binding_command") {
      if (payload.expectedPreferenceRevision !== revision || payload.expectedSubagentGeneration !== 21) throw new Error("Unexpected revision");
      target = payload.target as typeof target;
      revision += 1;
      return catalog();
    }
    throw new Error(`unknown command ${action}`);
  });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 }, devices: [
      fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
      fleetDeviceRow("dev-b", "Runtime owner", [{ workspaceId: "ws-b", name: "Release workspace", rootPath: "/repo",
        sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Release session")] }]),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-b1");
  await app.press("Settings");
  await app.press("nav-settings-page-external-import");
  await app.waitFor("Unavailable · retired");
  await app.press("external-runtime-model-binding-review-model-group");
  await app.press("Available fixture model");
  await app.waitUntil(() => revision === 81 && app.enabled("external-runtime-model-binding-review-model-group"));
  await app.press("external-runtime-model-binding-review-model-group");
  await app.press("Clear binding");
  await app.waitUntil(() => revision === 82 && !app.enabled("external-runtime-model-binding-review-model-group"));
  expect(host.fleetCalls.filter(call => call.command === "set_external_subagent_model_binding_command")).toMatchObject([
    { target: "dev-b", args: { request: { workspaceId: "ws-b", bindingKey: "review-model-group",
      target: { kind: "model", modelId: "model-1" }, expectedPreferenceRevision: 80, expectedSubagentGeneration: 21 } } },
    { target: "dev-b", args: { request: { workspaceId: "ws-b", bindingKey: "review-model-group",
      target: null, expectedPreferenceRevision: 81, expectedSubagentGeneration: 21 } } },
  ]);
});

function policyControlSnapshot(revision: number, options: {
  status?: string; userEnabled?: boolean; workspaceEnabled?: boolean; mode?: string; canMutate?: boolean;
} = {}) {
  const base = controlSnapshot(revision, false, true);
  const tool = { capabilityId: "tool", recommendedAccess: "discover_only", safetyCeiling: "discover_only" };
  const app = { ecosystemId: "claude-code", mode: options.mode ?? "recommended",
    capabilities: { tool: "discover_only" }, policyLimitedCapabilities: options.mode === "custom" ? ["tool"] : [] };
  return {
    control: { ...base.control, hostCapabilities: { ...base.control.hostCapabilities, canMutatePolicy: options.canMutate !== false } },
    catalog: { ...base.catalog, integrationPolicy: {
      schemaMajor: options.status === "incompatible_schema" ? 99 : 1,
      status: options.status ?? "compatible", userDefaults: { enabled: options.userEnabled ?? false },
      ...(options.workspaceEnabled === undefined ? {} : { workspaceOverride: { enabled: options.workspaceEnabled,
        ecosystems: { "claude-code": { mode: options.mode ?? "recommended" } } } }),
      globalEffective: { enabled: options.userEnabled ?? false, ecosystems: { "claude-code": app } },
      effective: { enabled: options.workspaceEnabled ?? options.userEnabled ?? false, ecosystems: { "claude-code": app } },
      registeredEcosystems: [{ ...base.catalog.integrationPolicy.registeredEcosystems[0], capabilities: [tool] }],
    } },
  };
}

test("runtime policy edits device defaults and workspace overrides independently", async () => {
  let revision = 30;
  let userEnabled = false;
  let workspaceEnabled: boolean | undefined;
  let mode = "recommended";
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, revision);
    if (action === "get_external_source_control_snapshot") return policyControlSnapshot(revision, { userEnabled, workspaceEnabled, mode });
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "update_external_integration_policy_command") {
      const mutation = payload.mutation as { expectedPreferenceRevision: number; scope: string;
        change: { operation: string; enabled?: boolean; mode?: string } };
      if (mutation.expectedPreferenceRevision !== revision) throw new Error("Unexpected revision");
      if (mutation.change.operation === "set_enabled") {
        if (mutation.scope === "workspace") workspaceEnabled = mutation.change.enabled;
        else userEnabled = mutation.change.enabled === true;
      } else if (mutation.change.operation === "set_ecosystem_mode") mode = mutation.change.mode ?? "";
      else if (mutation.change.operation === "set_capability_access") mode = "custom";
      else if (mutation.change.operation === "reset_workspace") { workspaceEnabled = undefined; mode = "recommended"; }
      revision += 1;
      return catalog();
    }
    throw new Error(`unknown command ${action}`);
  });
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("This workspace inherits the device defaults");
  expect(app.enabled("external-policy-app-mode")).toBe(false);
  await app.press("external-policy-enabled");
  await app.waitFor("This workspace has overrides");
  await app.waitUntil(() => app.enabled("external-policy-app-mode"));
  await app.press("external-policy-app-mode");
  await app.press("Discover only");
  await app.waitUntil(() => revision === 32 && app.enabled("external-policy-app-mode"));
  await app.press("external-policy-capabilities");
  await app.press("external-policy-capability-tool");
  expect(app.shows("Automatic")).toBe(false);
  await app.press("Ask before use");
  await app.waitFor("Limited by host policy");
  await app.press("id:external-policy-scope-user");
  await app.waitUntil(() => app.enabled("external-policy-enabled"));
  expect(app.enabled("external-policy-app-mode")).toBe(false);
  await app.press("external-policy-enabled");
  await app.waitUntil(() => revision === 34 && app.enabled("external-policy-enabled"));
  await app.press("id:external-policy-scope-workspace");
  await app.press("external-policy-reset-workspace");
  await app.waitFor("This workspace inherits the device defaults");
  expect(app.enabled("external-policy-app-mode")).toBe(true);
  expect(recorded.filter(call => call.action === "update_external_integration_policy_command").map(call => call.payload)).toEqual([
    { workspaceId: "workspace-1", mutation: { expectedPreferenceRevision: 30, scope: "workspace",
      change: { operation: "set_enabled", enabled: true } } },
    { workspaceId: "workspace-1", mutation: { expectedPreferenceRevision: 31, scope: "workspace",
      change: { operation: "set_ecosystem_mode", ecosystemId: "claude-code", mode: "discover_only" } } },
    { workspaceId: "workspace-1", mutation: { expectedPreferenceRevision: 32, scope: "workspace",
      change: { operation: "set_capability_access", ecosystemId: "claude-code", capabilityId: "tool", access: "ask_before_use" } } },
    { workspaceId: "workspace-1", mutation: { expectedPreferenceRevision: 33, scope: "user",
      change: { operation: "set_enabled", enabled: true } } },
    { workspaceId: "workspace-1", mutation: { expectedPreferenceRevision: 34, scope: "workspace",
      change: { operation: "reset_workspace" } } },
  ]);
});

test("runtime policy recovery requires a confirmed backup and reset", async () => {
  let revision = 40;
  let status = "incompatible_schema";
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(false, revision);
    if (action === "get_external_source_control_snapshot") return policyControlSnapshot(revision, { status });
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "update_external_integration_policy_command") {
      const mutation = payload.mutation as { expectedPreferenceRevision: number; change: { operation: string } };
      if (mutation.expectedPreferenceRevision !== revision || mutation.change.operation !== "reset_incompatible_policy") {
        throw new Error("Unexpected recovery request");
      }
      revision += 1;
      status = "compatible";
      return catalog();
    }
    throw new Error(`unknown command ${action}`);
  });
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("The device reports an incompatible policy. Back it up and reset it to make changes.");
  expect(app.shows("external-policy-enabled")).toBe(false);
  await app.press("Back up and reset");
  await app.waitFor("external-policy-recovery");
  expect(recorded.some(call => call.action === "update_external_integration_policy_command")).toBe(false);
  await app.press("Cancel");
  await app.waitFor("external-policy-recovery", { state: "gone" });
  expect(recorded.some(call => call.action === "update_external_integration_policy_command")).toBe(false);
  await app.press("Back up and reset");
  await app.press("external-policy-confirm-recovery");
  await app.waitFor("external-policy-enabled");
  expect(recorded.find(call => call.action === "update_external_integration_policy_command")?.payload).toEqual({
    workspaceId: "workspace-1", mutation: { expectedPreferenceRevision: 40, scope: "user",
      change: { operation: "reset_incompatible_policy" } },
  });
});

test("runtime policy sends device defaults to the workspace owner and respects a read-only result", async () => {
  let revision = 50;
  const { backend } = withExternalHost({ device: true }, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(false, revision);
    if (action === "get_external_source_control_snapshot") return policyControlSnapshot(revision, {
      userEnabled: revision > 50, canMutate: revision === 50,
    });
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "update_external_integration_policy_command") {
      if (payload.workspaceId !== "ws-b") throw new Error("Wrong policy owner");
      revision += 1;
      return catalog();
    }
    throw new Error(`unknown command ${action}`);
  });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 }, devices: [
      fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
      fleetDeviceRow("dev-b", "Policy owner", [{ workspaceId: "ws-b", name: "Release workspace", rootPath: "/repo",
        sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Release session")] }]),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-b1");
  await app.press("Settings");
  await app.press("nav-settings-page-external-import");
  await app.waitFor("id:external-policy-scope-user");
  await app.press("id:external-policy-scope-user");
  await app.press("external-policy-enabled");
  await app.waitUntil(() => revision === 51 && !app.enabled("external-policy-enabled"));
  await app.waitUntil(() => host.fleetCalls.filter(call => call.command === "get_external_source_control_snapshot").length >= 2);
  expect(app.enabled("external-policy-app-mode")).toBe(false);
  const writes = host.fleetCalls.filter(call => call.command === "update_external_integration_policy_command");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    target: "dev-b", args: { request: { workspaceId: "ws-b", mutation: { scope: "user",
      expectedPreferenceRevision: 50, change: { operation: "set_enabled", enabled: true } } } },
  });
  expect(host.pageHostCalls).toHaveLength(0);
});

test("external import reads the discovery snapshot for the workspace and writes the discovery switch", async () => {
  let enabled = true;
  let revision = 7;
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(enabled, revision);
    if (action === "update_external_integration_policy_command") {
      const mutation = payload.mutation as { change: { enabled: boolean } };
      enabled = mutation.change.enabled;
      revision += 1;
      return catalog();
    }
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    throw new Error(`unexpected ${action}`);
  });
  const app = await openExternalImport(backend.handlers);

  await app.waitFor("Claude Code");
  expect(app.texts()).toContain("OpenCode");
  expect(app.texts()).toContain("User · ~/.claude");
  await app.press("id:external-app-opencode");
  await app.waitFor("Degraded");
  expect(app.shows("User · ~/.claude")).toBe(false);
  await app.press("id:external-app-claude-code");
  await app.waitFor("User · ~/.claude");
  expect(app.texts()).toContain("2 commands · 0 tools · 0 subagents · 3 MCP servers");

  // One request struct, the workspace by id, no rescan on open.
  const read = recorded.find(item => item.action === "get_external_source_discovery_snapshot");
  expect(read?.raw).toBe(false);
  expect(read?.payload).toEqual({ workspaceId: "workspace-1", forceRefresh: false });

  // The switch writes the one mutation against the revision it read, then re-reads.
  await app.press("external-discovery-toggle");
  await app.waitUntil(() => recorded.some(item => item.action === "update_external_integration_policy_command"));
  const write = recorded.find(item => item.action === "update_external_integration_policy_command");
  expect(write?.payload).toEqual({
    workspaceId: "workspace-1",
    mutation: {
      expectedPreferenceRevision: 7,
      scope: "workspace",
      change: { operation: "set_automatic_discovery", enabled: false },
    },
  });
  await app.waitFor("Turn on automatic discovery to preview the MCP servers other apps declare.");
  expect(recorded.filter(item => item.action === "get_external_source_discovery_snapshot").length).toBe(2);

  // Refresh asks the host to rescan.
  await app.press("external-import-refresh");
  await app.waitUntil(() =>
    recorded.some(
      item => item.action === "get_external_source_discovery_snapshot" && item.payload.forceRefresh === true,
    ),
  );
});

test("external MCP import reviews single and legacy batch copies and requires consent again after a stale plan", async () => {
  let applies = 0;
  let plan = PLAN;
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, 1);
    if (action === "plan_external_mcp_import_command") return plan;
    if (action === "apply_external_mcp_import_command") {
      applies += 1;
      const request = payload.importRequest as { selections: Array<{ candidateId: string }> };
      if (applies === 2) {
        plan = { ...plan, planFingerprint: "fp-renamed", items: plan.items.map(item => item.candidateId === "mcp-2" && item.proposedNativeId
          ? { ...item, proposedNativeId: "linear-3" } : item) };
        return { schemaVersion: 1, outcome: { status: "stale", refreshedPlan: plan } };
      }
      const selected = request.selections[0]!.candidateId;
      plan = { ...plan, planFingerprint: `fp-written-${applies}`, items: plan.items.map(item => item.candidateId === selected
        ? { ...item, disposition: "already_imported" } : item) };
      return {
        schemaVersion: 1,
        outcome: { status: "applied", imported: [{ candidateId: selected, nativeId: selected === "mcp-1" ? "github" : "linear-3" }] },
      };
    }
    if (action === "list_removed_external_sessions") return [];
    throw new Error(`unexpected ${action}`);
  });
  const app = await openExternalImport(backend.handlers);

  await app.waitFor("github");
  expect(app.texts()).toContain("Ready to import");
  expect(app.texts()).toContain("Ready · auto-rename");
  expect(app.texts()).toContain("Setup required");
  expect(app.texts()).toContain("Streamable HTTP · Imported as linear-2");
  // An item the host will not copy offers no button.
  expect(app.count("external-mcp-import-mcp-3")).toBe(0);
  expect(app.shows("Import all (2)")).toBe(true);

  await app.press("external-mcp-import-mcp-1");
  await app.waitFor("external-mcp-batch-review");
  expect(applies).toBe(0);
  await app.press("external-mcp-review-close");
  await app.waitFor("external-mcp-batch-review", { state: "gone" });
  await app.press("external-mcp-import-mcp-1");
  await app.press("external-mcp-review-confirm");
  await app.waitFor("Imported github. Its copy is now available on the MCP page.");
  const single = recorded.find(item => item.action === "apply_external_mcp_import_command");
  expect(single?.raw).toBe(false);
  expect(single?.payload).toEqual({
    workspaceId: "workspace-1",
    importRequest: { schemaVersion: 1, planFingerprint: "fp-1", selections: [{ candidateId: "mcp-1" }] },
  });

  await app.waitUntil(() => app.enabled("external-mcp-import-all") && !app.shows("external-mcp-batch-review"));
  await app.press("external-mcp-import-all");
  expect(applies).toBe(1);
  await app.press("external-mcp-review-confirm");
  await app.waitFor("The source or destination changed. Review the updated preview and confirm again.");
  const batch = recorded.filter(item => item.action === "apply_external_mcp_import_command")[1];
  expect(batch?.payload.importRequest).toMatchObject({ planFingerprint: "fp-written-1", selections: [{ candidateId: "mcp-2" }] });
  await app.waitFor("OpenBitFun copy · linear-3");
  expect(applies).toBe(2);
  await app.press("external-mcp-review-confirm");
  await app.waitFor("MCP import results");
  expect(recorded.filter(item => item.action === "apply_external_mcp_import_command")[2]?.payload.importRequest)
    .toMatchObject({ planFingerprint: "fp-renamed", selections: [{ candidateId: "mcp-2" }] });
  await app.waitFor("Confirmed copies · 1");
  await app.press("external-mcp-review-close");
  await app.waitFor("Imported");
  expect(app.count("external-mcp-import-all")).toBe(0);
});

test("each application shows its own assets and confirms only the checked MCP import entries", async () => {
  const claude = { providerId: "claude-code", sourceId: "user" };
  const opencode = { providerId: "opencode", sourceId: "project" };
  const save = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return {
      ...discoverySnapshot(true, 1),
      catalog: catalog({
        commands: [{ candidateId: "cmd-review", definition: { id: { source: claude, localId: "review" }, name: "Review change list" } }],
        tools: [{ definition: { id: { target: { source: opencode, localId: "audit" }, exportId: "summary" }, name: "Repository summary" } }],
        subagents: [{ candidateId: "agent-lint", displayName: "Lint reviewer", sourceKeys: [claude] }],
        mcpServers: PLAN.items.map((item, index) => ({ candidateId: item.candidateId,
          definition: { id: { source: index === 2 ? opencode : claude }, name: item.displayName } })),
      }),
    };
    if (action === "list_removed_external_sessions") return [];
    if (action === "plan_external_mcp_import_command") return {
      ...PLAN, items: PLAN.items.map(item => item.candidateId === "mcp-3" ? { ...item, displayName: "project-docs", disposition: "eligible" } : item),
    };
    if (action === "apply_external_mcp_import_command") {
      const request = payload.importRequest as { selections: Array<{ candidateId: string }> };
      return { schemaVersion: 1, outcome: { status: "applied", imported: request.selections.map(item => ({ ...item, nativeId: "linear-2" })) } };
    }
    throw new Error(`unexpected ${action}`);
  });
  const app = await openExternalImport(save.backend.handlers);
  await app.waitFor("Review change list");
  await app.waitFor("Lint reviewer");
  await app.waitFor("github");
  expect(app.shows("Repository summary")).toBe(false);
  expect(app.shows("project-docs")).toBe(false);
  await app.press("external-mcp-import-all");
  await app.waitFor("external-mcp-batch-review");
  expect(save.recorded.some(call => call.action === "apply_external_mcp_import_command")).toBe(false);
  await app.press("id:external-mcp-review-mcp-1");
  await app.waitFor("Import selected (1)");
  await app.press("external-mcp-review-confirm");
  await app.waitFor("Imported linear. Its copy is now available on the MCP page.");
  expect(save.recorded.find(call => call.action === "apply_external_mcp_import_command")?.payload).toEqual({
    workspaceId: "workspace-1",
    importRequest: { schemaVersion: 1, planFingerprint: "fp-1", selections: [{ candidateId: "mcp-2" }] },
  });
  await app.waitFor("MCP import results");
  await app.press("external-mcp-review-close");
  await app.press("id:external-app-opencode");
  await app.waitFor("Repository summary");
  await app.waitFor("project-docs");
  expect(app.shows("Review change list")).toBe(false);
  expect(app.shows("github")).toBe(false);
});

test("external MCP undo compares the reviewed config fingerprint and removes only selected native copies", async () => {
  const provenance = (sourceCandidateId: string) => ({ schemaVersion: 1, sourceCandidateId });
  const document = { layout: "fixture", mcpServers: {
    github: { command: "original-fixture" },
    "github-copy": { command: "edited-copy-fixture", _openbitfunImport: provenance("mcp-1") },
    "linear-copy": { url: "https://fixture.example.invalid/mcp", _openbitfunImport: provenance("mcp-2") },
  } };
  const fixture = withExternalHost({}, (action) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, 1);
    if (action === "list_removed_external_sessions") return [];
    if (action === "plan_external_mcp_import_command") return { ...PLAN, items: PLAN.items.map(item => {
      const { mcpServers: entries } = fixture.backend.mcpDocument() as {
        mcpServers: Record<string, { _openbitfunImport?: { sourceCandidateId?: string } }>;
      };
      const isImported = Object.values(entries).some(entry => entry._openbitfunImport?.sourceCandidateId === item.candidateId);
      return isImported ? { ...item, disposition: "already_imported" } : item;
    }) };
    throw new Error(`unexpected ${action}`);
  });
  fixture.backend.changeMcpDocumentElsewhere(JSON.stringify(document));
  const app = await openExternalImport(fixture.backend.handlers);
  await app.waitFor("external-mcp-undo-all");
  await app.press("external-mcp-undo-all");
  await app.waitFor("external-mcp-undo-review");
  await app.waitFor("OpenBitFun copy · github-copy");
  await app.waitFor("OpenBitFun copy · linear-copy");
  expect(fixture.backend.mcpSaves).toHaveLength(0);

  const newer = { ...document, mcpServers: { ...document.mcpServers, another: { command: "new-fixture" } } };
  fixture.backend.changeMcpDocumentElsewhere(JSON.stringify(newer));
  await app.press("external-mcp-undo-confirm");
  await app.waitFor("The MCP configuration changed. Close this review and reopen it before removing any copies.");
  expect(app.enabled("external-mcp-undo-confirm")).toBe(false);
  expect(fixture.backend.mcpDocument()).toEqual(newer);
  await app.press("external-mcp-review-close");

  await app.press("external-mcp-undo-all");
  await app.waitFor("external-mcp-undo-review");
  await app.press("id:external-mcp-review-mcp-2");
  await app.press("external-mcp-undo-confirm");
  await app.waitFor("The imported copies were removed.");
  const { "github-copy": removed, ...retained } = newer.mcpServers;
  expect(removed._openbitfunImport.sourceCandidateId).toBe("mcp-1");
  expect(fixture.backend.mcpDocument()).toEqual({ ...newer, mcpServers: retained });
  expect(fixture.backend.mcpSaves).toHaveLength(1);
  expect(fixture.backend.mcpSaves[0]?.expectedFingerprint).toBe("fp-3");

  const ambiguous = { ...newer, mcpServers: { ...retained, "linear-shadow": newer.mcpServers["linear-copy"] } };
  fixture.backend.changeMcpDocumentElsewhere(JSON.stringify(ambiguous));
  await app.press("external-mcp-undo-mcp-2");
  await app.waitFor("A unique imported copy could not be found for every selected server.");
  expect(app.shows("external-mcp-undo-review")).toBe(false);
  expect(fixture.backend.mcpSaves).toHaveLength(1);

  await app.waitFor("external-mcp-manage-mcp-2");
  await app.press("external-mcp-manage-mcp-2");
  await app.waitFor("mcp-import");
});

test("application session discovery writes only its preference and requires a supported importer", async () => {
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, 1);
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") {
      if (payload.ecosystemId === "opencode") throw new Error('{"code":"unsupported","detail":"No OpenCode importer"}');
      return [];
    }
    throw new Error(`unexpected ${action}`);
  });
  const invoke = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const call = data as { action: string; request?: Record<string, unknown> };
    if (call.action === "get_config" && call.request?.path === "app.external_session_discovery") {
      return { ok: true, value: { "claude-code": false, opencode: true }, transport: "dev" };
    }
    return invoke(data);
  };
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("Find Claude Code sessions automatically");
  await app.waitUntil(() => app.accessibility("external-session-discovery-claude-code")?.disabled === false);
  await app.press("external-session-discovery-claude-code");
  const leaf = "app.external_session_discovery.claude-code";
  await app.waitUntil(() => recorded.some(call => call.action === "set_config" && call.payload.path === leaf));
  expect(recorded.find(call => call.action === "set_config" && call.payload.path === leaf)?.payload).toEqual({ path: leaf, value: true });
  await app.press("id:external-app-opencode");
  await app.waitFor("This device does not report support for finding sessions from this app.");
  expect(app.accessibility("external-session-discovery-opencode")?.disabled).toBe(true);
  expect(recorded.some(call => call.action === "set_config" && call.payload.path === "app.external_session_discovery")).toBe(false);
});

const CLAUDE_HOOK = {
  key: { providerId: "claude-hooks", sourceId: "claude-local" },
  ecosystemId: "claude-code",
  displayName: "Claude workspace hooks",
  locationHint: "D:/repo/.claude/settings.json",
  scope: "project",
};
const OPENCODE_HOOK = {
  ...CLAUDE_HOOK,
  key: { providerId: "opencode-hooks", sourceId: "opencode-local" },
  ecosystemId: "opencode",
  displayName: "OpenCode plugin hooks",
  locationHint: "D:/repo/.opencode/plugins",
};
const CLAUDE_SKILL = { key: "project::review", name: "Review code changes", level: "project",
  sourceSlot: "claude", sourceId: "claude", path: "D:/repo/.claude/skills/review", canToggle: true };
const OPENCODE_SKILL = { ...CLAUDE_SKILL, key: "user::audit", name: "Audit dependencies", level: "user", sourceId: "opencode.plugin" };
const HOOK_CATALOG = {
  schemaVersion: 1,
  discoveryPending: false,
  providers: [CLAUDE_HOOK, OPENCODE_HOOK].map(source => ({ providerId: source.key.providerId, ecosystemId: source.ecosystemId })),
  sources: [CLAUDE_HOOK, OPENCODE_HOOK],
  staleProviderIds: [],
  failedProviderIds: [],
  diagnostics: [
    { message: "Provider-wide discovery note" },
    { source: OPENCODE_HOOK.key, message: "OpenCode plugin source note" },
  ],
};
const HOOK_PLAN = {
  schemaVersion: 1,
  source: CLAUDE_HOOK,
  disposition: "import",
  planFingerprint: "plan-old",
  handlers: [{
    stableKey: "pre-tools",
    event: "PreToolUse",
    matcher: "Read",
    command: "./hooks/demo.sh",
    commandWindows: "pwsh -File ./hooks/demo.ps1",
    timeoutSeconds: 5,
    statusMessage: "Checking local fixture",
    dependencies: [{ kind: "managed", relativePath: "hooks/demo.ps1" }, { kind: "external", location: "D:/tools/helper.ps1" }],
  }, {
    stableKey: "session-start",
    event: "SessionStart",
    command: "echo fixture-only",
  }],
  skipped: [{ reasonCode: "unsupported_handler", count: 1 }],
};

const INSTRUCTION_CATALOG = {
  schemaVersion: 1,
  entries: [
    { ecosystemId: "claude-code", name: "Project rules", path: "/repo/.claude/rules/release.md", scope: "project", pathPatterns: ["release/**"] },
    { ecosystemId: "shared", name: "Shared guidance", path: "/repo/AGENTS.md", scope: "project", pathPatterns: [] },
    { ecosystemId: "opencode", name: "OpenCode guidance", path: "/repo/.opencode/AGENTS.md", scope: "project", pathPatterns: [] },
  ],
  failedEcosystems: ["opencode"],
};

test("instruction source details and partial failures are scoped to the selected application", async () => {
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, 1);
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "get_instruction_source_catalog") return {
      ...INSTRUCTION_CATALOG, failedEcosystems: payload.forceRefresh ? [] : INSTRUCTION_CATALOG.failedEcosystems,
    };
    throw new Error(`unknown command ${action}`);
  }, EXTERNAL_ASSET_COMMANDS);
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("Project rules");
  await app.waitFor("Shared guidance");
  expect(app.shows("OpenCode guidance")).toBe(false);
  expect(app.shows("external-instructions-retry")).toBe(false);
  await app.press("external-instruction-details-0");
  await app.waitFor("Project · Applies to matching paths");
  await app.waitFor("release/**");
  await app.press("Close");
  await app.press("external-instruction-details-1");
  await app.waitFor("Project · Applies at startup");
  await app.press("Close");
  await app.press("id:external-app-opencode");
  await app.waitFor("OpenCode guidance");
  await app.waitFor("Shared guidance");
  expect(app.shows("Project rules")).toBe(false);
  await app.waitFor("Could not read all instruction sources. Retry to refresh the list.");
  await app.press("external-instructions-retry");
  await app.waitFor("OpenCode guidance");
  expect(app.shows("external-instructions-retry")).toBe(false);
  expect(recorded.filter(call => call.action === "get_instruction_source_catalog").map(call => call.payload)).toEqual([
    { workspaceId: "workspace-1", forceRefresh: false }, { workspaceId: "workspace-1", forceRefresh: true },
  ]);
});

test("Codex pet import reviews the fingerprint before copying and activates an existing copy explicitly", async () => {
  const configPath = "app.ai_experience.agent_companion_pet";
  const enabledPath = "app.ai_experience.enable_agent_companion";
  const pet = (id: string, displayName: string, packagePath: string, source = "codex") => ({
    id, displayName, packagePath, spritesheetPath: `${packagePath}/spritesheet.webp`, spritesheetMimeType: "image/webp", source,
  });
  const sources = [
    { sourceKey: "bundled", builtinId: "review-sprite", pet: pet("built", "Review sprite", "D:/Codex/assets.asar") },
    { sourceKey: "custom", pet: pet("custom", "Custom sprite", "D:/home/.codex/pets/custom") },
  ];
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/T9sAAAAASUVORK5CYII=";
  const copies = new Map<string, ReturnType<typeof pet>>();
  let refreshAfterChange = false;
  let selected: unknown = null;
  let enabled = false;
  const assetCommands = [...EXTERNAL_ASSET_COMMANDS, "list_agent_companion_pets", "import_agent_companion_pet_package", "get_config", "set_config"];
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return { ...discoverySnapshot(true, 1), catalog: catalogWithCodex() };
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "get_skill_configs") return [];
    if (action === "get_config") {
      if (payload.path === configPath) return selected;
      if (payload.path === enabledPath) return enabled;
      return null;
    }
    if (action === "set_config") {
      if (payload.path === configPath) selected = payload.value;
      if (payload.path === enabledPath) enabled = payload.value === true;
      return null;
    }
    if (action === "list_agent_companion_pets") return { pets: [...copies.values()], importOperationsVersion: 1, builtinImportVersion: 1,
      ...(payload.includeExternal ? { external: { diagnostics: [], candidates: sources.map(source => ({
        ...source, fingerprint: source.sourceKey === "bundled" ? refreshAfterChange ? "bundled-v2" : "bundled-v1" : "custom-v1",
        previewDataUrl: png, imported: copies.get(source.sourceKey) ?? null, copyModified: false, sourceChanged: false,
      })) } } : {}),
    };
    if (action === "import_agent_companion_pet_package") {
      if (payload.expectedFingerprint === "bundled-v1") {
        refreshAfterChange = true;
        throw new Error("Pet source changed; refresh and review again");
      }
      const source = sources.find(item => item.pet.packagePath === payload.path)!;
      const copy = pet(source.sourceKey, source.pet.displayName, `D:/openbitfun/pets/${source.sourceKey}`, "user");
      copies.set(source.sourceKey, copy);
      return copy;
    }
    throw new Error(`unknown command ${action}`);
  }, assetCommands);

  const app = await open("./fixtures/externalPetsApp.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await app.waitFor("id:external-app-codex");
  await app.press("id:external-app-codex");
  await app.waitFor("Review sprite");
  await app.press("external-pet-review-bundled");
  await app.waitFor("Review pet import");
  expect(recorded.filter(call => call.action === "import_agent_companion_pet_package")).toHaveLength(0);
  await app.press("external-pet-confirm");
  await app.waitFor("Could not apply the pet change. Check the refreshed entry before trying again.");
  await app.waitUntil(() => app.enabled("external-pet-review-bundled"));
  expect(copies.has("bundled")).toBe(false);
  await app.press("external-pet-review-bundled");
  await app.press("external-pet-confirm");
  await app.waitFor("external-pet-use-bundled");
  expect(selected).toBe(null);
  await app.press("external-pet-use-bundled");
  await app.waitFor("In use");
  expect(enabled).toBe(true);
  expect(selected).toMatchObject({ packagePath: "D:/openbitfun/pets/bundled", id: "bundled" });
  await app.press("external-pet-review-custom");
  await app.press("external-pet-confirm");
  await app.waitFor("external-pet-use-custom");
  expect(recorded.filter(call => call.action === "import_agent_companion_pet_package").map(call => call.payload)).toEqual([
    { path: "D:/Codex/assets.asar", builtinId: "review-sprite", expectedFingerprint: "bundled-v1" },
    { path: "D:/Codex/assets.asar", builtinId: "review-sprite", expectedFingerprint: "bundled-v2" },
    { path: "D:/home/.codex/pets/custom", expectedFingerprint: "custom-v1" },
  ]);
  expect(recorded.find(call => call.action === "list_agent_companion_pets" && call.payload.includeExternal)?.payload)
    .toEqual({ includeExternal: true, builtinImportVersion: 1 });
});

test("external skills are scoped to the selected app and use the host's direct management contract", async () => {
  const extraSkills = [1, 2, 3, 4].map(index => ({ ...CLAUDE_SKILL, key: `project::extra-${index}`, name: `Extra skill ${index}` }));
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, 1);
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "get_skill_configs") return { skills: [CLAUDE_SKILL, ...extraSkills, OPENCODE_SKILL], diagnostics: [] };
    if (action === "get_global_skill_settings") return { directSkillManagementVersion: 1, globallyDisabledProjectSkillKeys: [] };
    if (action === "set_global_skill_disabled") return {
      directSkillManagementVersion: 1,
      globallyDisabledProjectSkillKeys: payload.disabled ? [payload.skillKey] : [],
    };
    throw new Error(`unknown command ${action}`);
  }, EXTERNAL_ASSET_COMMANDS);
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("Review code changes");
  expect(app.shows("Audit dependencies")).toBe(false);
  expect(app.shows("Extra skill 4")).toBe(false);
  await app.press("external-skills-expand");
  await app.waitFor("Extra skill 4");
  await app.press("label:external-skill-enabled-project::review");
  await app.waitFor("Disabled 'Review code changes'.");
  expect(recorded.find(call => call.action === "set_global_skill_disabled")).toMatchObject({
    raw: false, payload: { workspaceId: "workspace-1", skillKey: "project::review", disabled: true },
  });
  expect(recorded.some(call => call.action === "add_skill")).toBe(false);
  await app.press("id:external-app-opencode");
  await app.waitFor("Audit dependencies");
  expect(app.shows("Review code changes")).toBe(false);
  expect(app.shows("Disabled 'Review code changes'.")).toBe(false);
  await app.press("id:external-app-claude-code");
  await app.waitFor("Review code changes");
  expect(app.shows("Extra skill 4")).toBe(false);
});

test("external hook imports require review of the current plan and manage only the imported copy", async () => {
  let imports: Array<{ importId: string; source: typeof CLAUDE_HOOK; enabled: boolean; state: string }> = [];
  let revision = "rev-a";
  const snapshot = () => ({ schemaVersion: 1, catalog: HOOK_CATALOG, revision, imports });
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, 1);
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "get_skill_configs") return [];
    if (action === "get_global_skill_settings") return { directSkillManagementVersion: 1 };
    if (action === "get_external_hook_import_snapshot") return snapshot();
    if (action === "plan_external_hook_import_command") return HOOK_PLAN;
    if (action === "apply_external_hook_import_command") {
      const request = payload.importRequest as { planFingerprint: string };
      if (request.planFingerprint === "plan-old") return { schemaVersion: 1, outcome: {
        kind: "stale", refreshedPlan: { ...HOOK_PLAN, planFingerprint: "plan-new",
          handlers: [{ ...HOOK_PLAN.handlers[0], commandWindows: "pwsh -File ./hooks/demo-updated.ps1" }] },
      } };
      if (request.planFingerprint !== "plan-new") throw new Error("Unrecognized fingerprint");
      imports = [{ importId: "hook-copy", source: CLAUDE_HOOK, enabled: true, state: "current" }];
      revision = "rev-b";
      return { schemaVersion: 1, outcome: { kind: "applied", snapshot: snapshot() } };
    }
    if (action === "mutate_external_hook_import_command") {
      const mutation = payload.mutation as { expectedRevision: string; action: { kind: string; importId: string; enabled: boolean } };
      if (mutation.expectedRevision !== revision || mutation.action.importId !== "hook-copy") throw new Error("Unexpected import mutation");
      imports = mutation.action.kind === "remove" ? [] : imports.map(item => ({ ...item, enabled: mutation.action.enabled }));
      revision += "-next";
      return snapshot();
    }
    throw new Error(`unknown command ${action}`);
  }, EXTERNAL_ASSET_COMMANDS);
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("Claude workspace hooks");
  expect(app.shows("OpenCode plugin hooks")).toBe(false);
  expect(app.shows("OpenCode plugin source note")).toBe(false);
  expect(app.shows("Provider-wide discovery note")).toBe(false);
  await app.press("external-hook-review-claude-local");
  await app.waitFor("Review hook commands");
  await app.waitFor("pwsh -File ./hooks/demo.ps1");
  expect(app.shows("echo fixture-only")).toBe(true);
  expect(app.shows("Plan fingerprint · plan-old")).toBe(true);
  expect(app.shows("External dependency · D:/tools/helper.ps1")).toBe(true);
  expect(recorded.filter(call => call.action === "apply_external_hook_import_command")).toHaveLength(0);
  await app.press("external-hook-apply");
  await app.waitFor("pwsh -File ./hooks/demo-updated.ps1");
  await app.waitFor("The source or destination changed. Review the updated preview and confirm again.");
  expect(recorded.filter(call => call.action === "apply_external_hook_import_command")).toHaveLength(1);
  await app.press("external-hook-apply");
  await app.waitFor("external-hook-enabled-hook-copy");
  expect(recorded.filter(call => call.action === "apply_external_hook_import_command").map(call => call.payload)).toEqual(
    ["plan-old", "plan-new"].map(planFingerprint => ({ workspaceId: "workspace-1",
      importRequest: { schemaVersion: 1, source: CLAUDE_HOOK.key, planFingerprint } })),
  );
  await app.press("external-hook-enabled-hook-copy");
  await app.waitFor("Project · D:/repo/.claude/settings.json · Disabled");
  await app.press("external-hook-remove-hook-copy");
  await app.waitFor("Remove imported hooks?");
  expect(recorded.filter(call => call.action === "mutate_external_hook_import_command")).toHaveLength(1);
  await app.press("external-hook-confirm-remove");
  await app.waitFor("external-hook-review-claude-local");
  expect(recorded.filter(call => call.action === "mutate_external_hook_import_command").map(call => call.payload)).toEqual([
    { workspaceId: "workspace-1", mutation: { schemaVersion: 1, expectedRevision: "rev-b",
      action: { kind: "set_enabled", importId: "hook-copy", enabled: false } } },
    { workspaceId: "workspace-1", mutation: { schemaVersion: 1, expectedRevision: "rev-b-next",
      action: { kind: "remove", importId: "hook-copy" } } },
  ]);
  await app.press("id:external-app-opencode");
  await app.waitFor("OpenCode plugin hooks");
  await app.waitFor("OpenCode plugin source note");
  expect(app.shows("external-hook-review-opencode-local")).toBe(false);
});

test("a catalog-only hook host and a skill host without direct management show discovery without write actions", async () => {
  const { backend, recorded } = withExternalHost({}, action => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, 1);
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "get_skill_configs") return [CLAUDE_SKILL];
    if (action === "get_global_skill_settings") return {};
    if (action === "get_external_hook_catalog") return HOOK_CATALOG;
    throw new Error(`unknown command ${action}`);
  }, EXTERNAL_ASSET_COMMANDS);
  const app = await openExternalImport(backend.handlers);
  await app.waitFor("Review code changes");
  await app.waitFor("Skill management is unavailable on this device.");
  await app.waitFor("Claude workspace hooks");
  await app.waitFor("This device does not support managing external hooks.");
  await app.waitFor("This device does not report instruction sources.");
  expect(app.shows("label:external-skill-enabled-project::review")).toBe(false);
  expect(app.shows("external-hook-review-claude-local")).toBe(false);
  expect(recorded.find(call => call.action === "get_external_hook_catalog")?.payload).toEqual({
    workspaceId: "workspace-1", forceRefresh: false,
  });
});

test("batch hook review preserves selection, re-reviews changed commands, and removes only selected copies", async () => {
  const ids = ["first", "second", "third", "fourth"];
  const sources = ids.map(id => ({ ...CLAUDE_HOOK, key: { ...CLAUDE_HOOK.key, sourceId: id },
    scope: id === "second" ? "workspace_local" : "project",
    displayName: `Hook source ${id}`, locationHint: `/repo/${id}/settings.json`, contentVersion: "source-v1" }));
  const byId = new Map(sources.map(source => [source.key.sourceId, source]));
  const imported = new Set<string>();
  let version = 0;
  const snapshot = () => ({ schemaVersion: 1, revision: `rev-${version}`,
    catalog: { ...HOOK_CATALOG, sources: [...sources, OPENCODE_HOOK] },
    imports: [...imported].map(id => ({ importId: `copy-${id}`, source: byId.get(id), enabled: true, state: "current" })),
  });
  const planFor = (id: string) => {
    const changed = id === "third" && version > 0;
    const base = byId.get(id)!;
    return { ...HOOK_PLAN, source: { ...base, contentVersion: changed ? "source-v2" : "source-v1" },
      behaviorVersion: changed ? "changed-behavior" : "reviewed-behavior",
      planFingerprint: `${id}-fp-${version}`,
      handlers: [{ stableKey: id, event: "PreToolUse", command: `echo ${changed ? "updated" : "reviewed"}-${id}` }], skipped: [],
    };
  };
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, 1);
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "get_external_hook_import_snapshot") return snapshot();
    if (action === "plan_external_hook_import_command") return planFor((payload.source as { sourceId: string }).sourceId);
    if (action === "apply_external_hook_import_command") {
      const req = payload.importRequest as { source: { sourceId: string }; planFingerprint: string };
      const id = req.source.sourceId;
      if (req.planFingerprint !== planFor(id).planFingerprint) throw new Error("Unexpected batch fingerprint");
      imported.add(id);
      version += 1;
      return { schemaVersion: 1, outcome: { kind: "applied", snapshot: snapshot() } };
    }
    if (action === "mutate_external_hook_import_command") {
      const req = payload.mutation as { expectedRevision: string; action: { kind: string; importId: string } };
      if (req.expectedRevision !== `rev-${version}` || req.action.kind !== "remove") throw new Error("Unexpected batch revision");
      imported.delete(req.action.importId.replace(/^copy-/, ""));
      version += 1;
      return snapshot();
    }
    throw new Error(`unknown command ${action}`);
  }, EXTERNAL_ASSET_COMMANDS);

  const app = await openExternalImport(backend.handlers);
  await app.waitFor("Hook source first");
  await app.press("external-hooks-review-batch");
  await app.waitFor("external-hook-batch-dialog");
  await app.waitFor("echo reviewed-third");
  expect(recorded.filter(call => call.action === "apply_external_hook_import_command")).toHaveLength(0);
  expect(recorded.filter(call => call.action === "plan_external_hook_import_command").map(call => call.payload.source))
    .toEqual(sources.map(source => source.key));
  await app.press("external-hook-batch-select-fourth");
  await app.waitFor("Apply selected (3)");
  await app.press("external-hook-batch-confirm");
  await app.waitFor("echo updated-third");
  await app.waitFor("Changed since review. Review again.");
  expect([...imported]).toEqual(["first", "second"]);
  expect(recorded.filter(call => call.action === "apply_external_hook_import_command").map(call => call.payload)).toEqual(
    ["first-fp-0", "second-fp-1"].map((planFingerprint, index) => ({ workspaceId: "workspace-1",
      importRequest: { schemaVersion: 1, source: sources[index].key, planFingerprint } })),
  );
  await app.waitFor("Apply selected (0)");
  await app.press("external-hook-batch-select-third");
  await app.waitFor("Apply selected (1)");
  await app.press("external-hook-batch-confirm");
  await app.waitUntil(() => imported.has("third"));
  await app.waitUntil(() => app.accessibility("external-hook-batch-confirm")?.disabled === true);
  await app.press("Close");
  await app.press("external-hooks-remove-batch");
  await app.waitFor("Remove selected (3)");
  await app.press("external-hook-batch-select-third");
  await app.press("external-hook-batch-confirm");
  await app.waitFor("Removed");
  await app.waitUntil(() => imported.size === 1);
  expect([...imported]).toEqual(["third"]);
  await app.press("external-hook-batch-select-third");
  await app.press("external-hook-batch-confirm");
  await app.waitUntil(() => imported.size === 0);
  expect(recorded.filter(call => call.action === "mutate_external_hook_import_command").map(call => call.payload)).toEqual(
    ["first", "second", "third"].map((id, index) => ({ workspaceId: "workspace-1", mutation: {
      schemaVersion: 1, expectedRevision: `rev-${3 + index}`, action: { kind: "remove", importId: `copy-${id}` },
    } })),
  );
});

test("batch hook removal stops at an unrelated revision and retains the completed result", async () => {
  const ids = ["a", "b", "c"];
  const rows = ids.map(id => ({ importId: `hook-${id}`, enabled: true, state: "current", source: {
    ...CLAUDE_HOOK, key: { ...CLAUDE_HOOK.key, sourceId: id }, displayName: `Imported batch hook ${id}`,
  } }));
  let imports = rows;
  let revision = "opened";
  const snapshot = () => ({ schemaVersion: 1, revision, imports,
    catalog: { ...HOOK_CATALOG, sources: rows.map(row => row.source) },
  });
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, 1);
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    if (action === "get_external_hook_import_snapshot") return snapshot();
    if (action === "mutate_external_hook_import_command") {
      const mutation = payload.mutation as { expectedRevision: string; action: { importId: string } };
      if (revision !== mutation.expectedRevision) throw new Error(JSON.stringify({ code: "stale_revision" }));
      imports = imports.filter(row => row.importId !== mutation.action.importId);
      const response = { ...snapshot(), revision: "own-write" };
      revision = "another-device-write";
      return response;
    }
    throw new Error(`unknown command ${action}`);
  }, EXTERNAL_ASSET_COMMANDS);

  const app = await openExternalImport(backend.handlers);
  await app.waitFor("Imported batch hook a");
  await app.press("external-hooks-remove-batch");
  await app.waitFor("Remove selected (3)");
  await app.press("external-hook-batch-confirm");
  await app.waitFor("Removed");
  await app.waitFor("Changed since review. Review again.");
  await app.waitUntil(() => app.count("external-hook-batch-confirm") === 0);
  expect(recorded.filter(call => call.action === "mutate_external_hook_import_command").map(call => call.payload)).toEqual([
    { workspaceId: "workspace-1", mutation: { schemaVersion: 1, expectedRevision: "opened",
      action: { kind: "remove", importId: "hook-a" } } },
    { workspaceId: "workspace-1", mutation: { schemaVersion: 1, expectedRevision: "own-write",
      action: { kind: "remove", importId: "hook-b" } } },
  ]);
  expect(imports.map(row => row.importId)).toEqual(["hook-b", "hook-c"]);
  await app.press("Close");
  await app.press("external-hooks-remove-batch");
  await app.waitFor("Remove selected (2)");
});

test("browser controllers inspect and update the external apps of the workspace's fleet device", async () => {
  let importedMcp = false;
  let hookRevision = "rev-a";
  let importedHook = false;
  const hookSnapshot = () => ({ schemaVersion: 1, revision: hookRevision, catalog: HOOK_CATALOG, imports: importedHook
    ? [{ importId: "hook-copy", source: CLAUDE_HOOK, enabled: true, state: "current" }] : [] });
  const { backend } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return { ...discoverySnapshot(true, 1),
      catalog: { ...catalogWithCodex(), mcpServers: PLAN.items.map((item, index) => ({
        candidateId: item.candidateId,
        definition: { id: { source: index === 0 ? runtimeRefs.claude : runtimeRefs.opencode }, name: item.displayName },
      })) } };
    if (action === "get_external_source_control_snapshot") return reviewControl(4);
    if (action === "apply_external_source_control_action_command") return controlSnapshot(5, true, true);
    if (action === "set_external_tool_target_decision_command") return reviewControl(5).catalog;
    if (action === "list_subscription_accounts") return [
      { provider: "codex", display_label: "Codex account", connected: true, account: "fleet@example.invalid" },
    ];
    if (action === "plan_external_mcp_import_command") return importedMcp && Object.hasOwn(
      (backend.mcpDocument() as { mcpServers: object }).mcpServers, "fixture-github-copy")
      ? { ...PLAN, planFingerprint: "fp-imported", items: PLAN.items.map(item => item.candidateId === "mcp-1"
        ? { ...item, disposition: "already_imported" } : item) } : PLAN;
    if (action === "apply_external_mcp_import_command") {
      importedMcp = true;
      backend.changeMcpDocumentElsewhere(JSON.stringify({ mcpServers: {
        unrelated: { command: "fixture-other" },
        "fixture-github-copy": { command: "fixture", _openbitfunImport: { schemaVersion: 1, sourceCandidateId: "mcp-1" } },
      } }));
      return { schemaVersion: 1, outcome: { status: "applied", imported: [{ candidateId: "mcp-1", nativeId: "fixture-github-copy" }] } };
    }
    if (action === "list_removed_external_sessions") return [];
    if (action === "get_skill_configs") return { skills: [CLAUDE_SKILL], diagnostics: [] };
    if (action === "get_global_skill_settings") return { directSkillManagementVersion: 1, globallyDisabledProjectSkillKeys: [] };
    if (action === "set_global_skill_disabled") return { globallyDisabledProjectSkillKeys: [CLAUDE_SKILL.key] };
    if (action === "get_external_hook_import_snapshot") return hookSnapshot();
    if (action === "plan_external_hook_import_command") {
      expect(payload.source).toEqual(CLAUDE_HOOK.key);
      return HOOK_PLAN;
    }
    if (action === "apply_external_hook_import_command") {
      const request = payload.importRequest as { source: unknown; planFingerprint: string };
      expect(request.source).toEqual(CLAUDE_HOOK.key);
      if (request.planFingerprint === "plan-old") return { schemaVersion: 1, outcome: {
        kind: "stale", refreshedPlan: { ...HOOK_PLAN, planFingerprint: "plan-reviewed",
          handlers: [{ ...HOOK_PLAN.handlers[0], commandWindows: "pwsh -File ./hooks/changed-fixture.ps1" }] },
      } };
      expect(request.planFingerprint).toBe("plan-reviewed");
      importedHook = true;
      hookRevision = "rev-b";
      return { schemaVersion: 1, outcome: { kind: "applied", snapshot: hookSnapshot() } };
    }
    if (action === "mutate_external_hook_import_command") {
      expect(payload.mutation).toEqual({ schemaVersion: 1, expectedRevision: "rev-b", action: { kind: "remove", importId: "hook-copy" } });
      importedHook = false;
      hookRevision = "rev-c";
      return hookSnapshot();
    }
    if (action === "get_instruction_source_catalog") return INSTRUCTION_CATALOG;
    throw new Error(`unexpected ${action}`);
  }, [...EXTERNAL_ASSET_COMMANDS, "list_subscription_accounts"]);
  const invoke = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const call = data as { action: string; request?: Record<string, unknown> };
    if (call.action === "get_config" && call.request?.path === "app.external_session_discovery") {
      return { ok: true, value: { "claude-code": false }, transport: "dev" };
    }
    return invoke(data);
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 }, devices: [
      fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
      fleetDeviceRow("dev-b", "Workspace device", [{ workspaceId: "ws-b", name: "Release workspace", rootPath: "/repo",
        sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Release session")] }], { hostKind: "desktop", state: "online" }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-b1");
  await app.press("Settings");
  await app.press("nav-settings-page-external-import");
  await app.waitFor("User · ~/.claude");
  await app.waitUntil(() => app.accessibility("external-session-discovery-claude-code")?.disabled === false);
  await app.press("external-session-discovery-claude-code");

  const snapshot = host.fleetCalls.find(call => call.command === "get_external_source_discovery_snapshot");
  expect(snapshot?.target).toBe("dev-b");
  expect(snapshot?.args.request).toEqual({ workspaceId: "ws-b", forceRefresh: false });
  const update = host.fleetCalls.find(call => call.command === "set_config" &&
    (call.args.request as { path?: string })?.path === "app.external_session_discovery.claude-code");
  expect(update?.target).toBe("dev-b");
  expect(update?.args.request).toMatchObject({ value: true });
  await app.waitFor("Review code changes");
  await app.press("label:external-skill-enabled-project::review");
  const skill = host.fleetCalls.find(call => call.command === "set_global_skill_disabled");
  expect(skill?.target).toBe("dev-b");
  expect(skill?.args.request).toMatchObject({ workspaceId: "ws-b", skillKey: CLAUDE_SKILL.key, disabled: true });
  await app.press("external-hook-review-claude-local");
  await app.waitFor("Review hook commands");
  const hook = host.fleetCalls.find(call => call.command === "plan_external_hook_import_command");
  expect(hook?.target).toBe("dev-b");
  expect(hook?.args.request).toEqual({ workspaceId: "ws-b", source: CLAUDE_HOOK.key });
  const instructions = host.fleetCalls.find(call => call.command === "get_instruction_source_catalog");
  expect(instructions?.target).toBe("dev-b");
  expect(instructions?.args.request).toEqual({ workspaceId: "ws-b", forceRefresh: false });
  await app.press("Cancel");
  expect(app.shows("label:external-source-reveal-claude-code:user")).toBe(false);
  await app.press("external-source-safe-mode");
  expect(host.fleetCalls.find(call => call.command === "apply_external_source_control_action_command")).toMatchObject({
    target: "dev-b", args: { request: { workspaceId: "ws-b", control: { expectedPreferenceRevision: 4,
      action: { type: "set_safe_mode", enabled: true } } } },
  });
  await app.waitUntil(() => app.enabled("external-approval-review-review-tool"));
  await app.press("external-approval-review-review-tool");
  await app.press("external-runtime-confirm");
  await app.waitUntil(() => app.count("external-runtime-review-dialog") === 0);
  expect(host.fleetCalls.find(call => call.command === "set_external_tool_target_decision_command")).toMatchObject({
    target: "dev-b", args: { request: { workspaceId: "ws-b", expectedPreferenceRevision: 4,
      approvalKey: "review-tool", decisionKey: "tool-reviewed-version", approved: true } },
  });
  await app.press("id:external-app-codex");
  await app.waitFor("Codex pet import is available on the desktop app on that device.");
  await app.waitFor("fleet@example.invalid");
  expect(host.fleetCalls.find(call => call.command === "list_subscription_accounts")?.target).toBe("dev-b");
  expect(host.fleetCalls.some(call => call.command === "list_agent_companion_pets")).toBe(false);

  await app.press("id:external-app-claude-code");
  await app.waitUntil(() => app.enabled("external-app-import-all"));
  await app.press("external-app-import-all");
  await app.waitFor("Review application imports");
  await app.waitFor("Import selected (2)");
  expect(app.shows("id:external-app-batch-mcp-mcp-1")).toBe(true);
  expect(app.shows("id:external-app-batch-mcp-mcp-2")).toBe(false);
  expect(app.shows("OpenCode plugin hooks")).toBe(false);
  expect(importedMcp).toBe(false);
  expect(importedHook).toBe(false);
  await app.press("external-app-batch-confirm");
  await app.waitFor("pwsh -File ./hooks/changed-fixture.ps1");
  await app.waitUntil(() => !app.enabled("external-app-batch-confirm"));
  expect(importedMcp).toBe(true);
  expect(importedHook).toBe(false);
  await app.press("id:external-app-batch-hook-claude-local");
  await app.press("external-app-batch-confirm");
  await app.waitFor("Items processed · 2 / 2");
  await app.waitUntil(() => importedHook && app.enabled("external-app-batch-close"));
  await app.press("external-app-batch-close");

  await app.press("external-app-undo-all");
  await app.waitFor("Review application removals");
  await app.waitFor("OpenBitFun copy · fixture-github-copy");
  expect(importedHook).toBe(true);
  expect(host.fleetCalls.some(call => call.command === "save_mcp_json_config")).toBe(false);
  await app.press("external-app-batch-confirm");
  await app.waitUntil(() => !importedHook && app.enabled("external-app-batch-close"));
  expect(backend.mcpDocument()).toEqual({ mcpServers: { unrelated: { command: "fixture-other" } } });
  expect(host.fleetCalls.find(call => call.command === "apply_external_mcp_import_command")).toMatchObject({
    target: "dev-b", args: { request: { workspaceId: "ws-b", importRequest: { planFingerprint: "fp-1", selections: [{ candidateId: "mcp-1" }] } } },
  });
  expect(host.fleetCalls.filter(call => call.command === "apply_external_mcp_import_command")).toHaveLength(1);
  expect(host.fleetCalls.filter(call => call.command === "apply_external_hook_import_command").map(call => ({ target: call.target, request: call.args.request })))
    .toEqual(["plan-old", "plan-reviewed"].map(planFingerprint => ({ target: "dev-b",
      request: { workspaceId: "ws-b", importRequest: { schemaVersion: 1, planFingerprint, source: CLAUDE_HOOK.key } } })));
  expect(host.fleetCalls.find(call => call.command === "mutate_external_hook_import_command")).toMatchObject({
    target: "dev-b", args: { request: { workspaceId: "ws-b", mutation: { expectedRevision: "rev-b" } } },
  });
  expect(host.fleetCalls.find(call => call.command === "load_mcp_json_config")?.target).toBe("dev-b");
  expect(host.fleetCalls.find(call => call.command === "save_mcp_json_config")).toMatchObject({
    target: "dev-b", args: { expectedFingerprint: "fp-2" },
  });
  expect(host.pageHostCalls).toHaveLength(0);
});

test("removed source sessions list per ecosystem and come back one at a time", async () => {
  let restoreCalls = 0;
  const { backend, recorded } = withExternalHost({}, (action, payload) => {
    if (action === "get_external_source_discovery_snapshot") return discoverySnapshot(true, 1);
    if (action === "plan_external_mcp_import_command") return { schemaVersion: 1, planFingerprint: "fp", items: [] };
    if (action === "list_removed_external_sessions") {
      if (payload.ecosystemId === "claude-code") {
        return [
          { ecosystemId: "claude-code", sessionId: "s-1", sessionName: "Fix login", workspaceId: "workspace-1", workspaceName: "OpenBitFun" },
          { ecosystemId: "claude-code", sessionId: "s-2", sessionName: "Refactor", workspaceId: "workspace-1", workspaceName: "OpenBitFun" },
        ];
      }
      return [];
    }
    if (action === "restore_removed_external_session") {
      restoreCalls += 1;
      if (payload.sessionId === "s-2") throw new Error('{"code":"internal","detail":"store locked","retryable":true}');
      return null;
    }
    throw new Error(`unexpected ${action}`);
  });
  const app = await openExternalImport(backend.handlers);

  await app.waitFor("Fix login");
  // One list per ecosystem the host registered, never a workspace field.
  const lists = recorded.filter(item => item.action === "list_removed_external_sessions");
  expect(lists.map(item => item.payload)).toEqual([{ ecosystemId: "claude-code" }, { ecosystemId: "opencode" }]);
  expect(app.texts()).toContain("Claude Code · OpenBitFun");

  await app.press("external-removed-restore-s-1");
  await app.waitFor("Fix login", { state: "gone" });
  const restore = recorded.find(item => item.action === "restore_removed_external_session");
  expect(restore?.payload).toEqual({ ecosystemId: "claude-code", targetWorkspaceId: "workspace-1", sessionId: "s-1" });

  // A refused restore keeps the row and says the record is kept.
  await app.press("external-removed-restore-s-2");
  await app.waitFor("Could not add this source session again. The removal record is kept; retry later.");
  expect(app.shows("Refactor")).toBe(true);
  expect(restoreCalls).toBe(2);
});

test("an older host falls back to the legacy catalog with a read-only switch, and a host without any says so", async () => {
  const { backend, recorded } = withExternalHost({}, action => {
    if (action === "get_external_source_discovery_snapshot" || action === "get_external_source_control_snapshot") {
      throw new Error(`Command not found: ${action}`);
    }
    if (action === "get_external_source_snapshot") return catalog({ mcpServers: undefined });
    if (action === "list_removed_external_sessions") throw new Error(`unknown command ${action}`);
    throw new Error(`unexpected ${action}`);
  });
  const app = await openExternalImport(backend.handlers);

  await app.waitFor("Claude Code");
  expect(app.texts()).toContain("This device or settings version does not support changing automatic discovery.");
  expect(app.enabled("external-discovery-toggle")).toBe(false);
  expect(app.texts()).toContain("No MCP servers were found in other apps.");
  // A host without the removed-sessions command is told apart from an empty list.
  await app.waitFor("This device does not support restoring removed source sessions. Update OpenBitFun on it and retry.");
  expect(recorded.some(item => item.action === "plan_external_mcp_import_command")).toBe(false);
});

test("a failed read shows the host's own detail and retries", async () => {
  let reads = 0;
  const { backend } = withExternalHost({}, action => {
    if (action === "get_external_source_discovery_snapshot") {
      reads += 1;
      if (reads === 1) throw new Error('{"code":"unavailable","detail":"Discovery service is starting","retryable":true}');
      return discoverySnapshot(true, 1);
    }
    if (action === "plan_external_mcp_import_command") return PLAN;
    if (action === "list_removed_external_sessions") return [];
    throw new Error(`unexpected ${action}`);
  });
  const app = await openExternalImport(backend.handlers);

  await app.waitFor("Could not read external apps. Discovery service is starting");
  await app.press("Retry");
  await app.waitFor("Claude Code");
});

test("a remote workspace never reaches the external-source commands and says why", async () => {
  const { backend, recorded } = withExternalHost({ currentWorkspaceId: "workspace-2" }, action => {
    if (action === "list_removed_external_sessions") return [];
    throw new Error(`unexpected ${action}`);
  });
  const app = await openExternalImport(backend.handlers);

  await app.waitFor(
    "External import reads other apps' folders on the machine running the desktop app. The active workspace is remote, so it is unavailable here; switch to a local workspace to use it.",
  );
  const workspaceScoped = recorded.filter(
    item => [...EXTERNAL_COMMANDS, ...EXTERNAL_ASSET_COMMANDS, ...RUNTIME_REVIEW_COMMANDS, "list_subscription_accounts"].includes(item.action)
      && item.action !== "list_removed_external_sessions",
  );
  expect(workspaceScoped).toEqual([]);
  expect(app.shows("external-import-open-agents")).toBe(true);
});

