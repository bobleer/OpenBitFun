import { expect, open, test } from "nsh/test";
import { showAllSessions, showDevices, createBackend, createDeviceBackend, type Backend, type BackendCall, type BackendOptions } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };

type OpenApp = Awaited<ReturnType<typeof open>>;

/** Agents and Skills are Library tabs (visual spec §4.8): open the Library, then the tab. */
async function openLibraryTab(app: OpenApp, tab: "agents" | "skills"): Promise<void> {
  await app.waitFor("Library");
  if (!app.shows(`library-tab-${tab}`)) await app.press("Library");
  await app.press(`library-tab-${tab}`);
}

interface StudioMockOptions extends BackendOptions {
  skillConfigsShape?: "report" | "array";
  marketShape?: "diagnostics" | "array";
  initialDisabledSkills?: string[];
  includeShadowedSkill?: boolean;
}

function createAgentsSkillsBackend(options: StudioMockOptions = {}) {
  const base: Backend = options.devices
    ? createDeviceBackend(options)
    : createBackend(options);
  const baseInvoke = base.handlers["openbitfun.invoke"];

  const recorded: BackendCall[] = [];
  const modes: Array<Record<string, unknown>> = [
    {
      id: "Standard",
      name: "Standard",
      description: "Balanced default profile.",
      source: "builtin",
      isReadonly: false,
      toolCount: 3,
      defaultTools: ["Read", "Write", "Grep"],
      configProfileId: "Standard",
      model: null,
    },
    {
      id: "Reviewer",
      name: "Reviewer",
      description: "Custom user code review primary mode.",
      source: "user",
      isReadonly: true,
      toolCount: 2,
      defaultTools: ["Read", "Grep"],
      configProfileId: "Reviewer",
      model: "gpt-4.1",
    },
    {
      id: "OpenCodeMode",
      name: "OpenCode ACP",
      description: "External ACP primary runtime.",
      source: "external",
      isReadonly: false,
      toolCount: 1,
      defaultTools: ["Bash"],
      configProfileId: "OpenCodeMode",
      model: "opencode-acp",
    },
  ];

  const subagents: Array<Record<string, unknown>> = [
    {
      id: "Explorer",
      name: "Explorer",
      description: "Fast built-in codebase explorer.",
      source: "builtin",
      subagentSource: "builtin",
      isReadonly: true,
      isReview: false,
      toolCount: 2,
      defaultTools: ["Read", "Grep"],
      effectiveEnabled: true,
      model: null,
    },
    {
      id: "HelperSub",
      name: "HelperSub",
      description: "User-created helper subagent.",
      source: "user",
      subagentSource: "user",
      isReadonly: true,
      isReview: false,
      toolCount: 2,
      defaultTools: ["Read", "Glob"],
      effectiveEnabled: true,
      model: "gpt-4.1-mini",
    },
  ];

  const customAgentDetails: Record<string, Record<string, unknown>> = {
    Reviewer: {
      agentId: "Reviewer",
      kind: "mode",
      level: "user",
      name: "Reviewer",
      description: "Custom user code review primary mode.",
      prompt: "Review diffs carefully.",
      tools: ["Read", "Grep"],
      readonly: true,
      review: false,
      model: "gpt-4.1",
      path: "/tmp/agents/reviewer.md",
    },
  };

  const customSubagentDetails: Record<string, Record<string, unknown>> = {
    HelperSub: {
      subagentId: "HelperSub",
      name: "HelperSub",
      description: "User-created helper subagent.",
      prompt: "Assist with focused tasks.",
      tools: ["Read", "Glob"],
      readonly: true,
      review: false,
      enabled: true,
      model: "gpt-4.1-mini",
      level: "user",
      path: "/tmp/agents/helpersub.md",
    },
  };

  const toolNames = ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "LS"];
  let profileConfigs: Record<string, Record<string, unknown>> = {
    Standard: {
      profile_id: "Standard",
      default_tools: ["Read", "Write", "Grep"],
      enabled_tools: ["Read", "Write", "Grep"],
    },
  };

  const skills: Array<Record<string, unknown>> = [
    {
      key: "user::openbitfun-system::core-guide",
      name: "Core Guide",
      description: "Built-in baseline conventions.",
      path: "/skills/builtin/core-guide",
      level: "user",
      sourceSlot: "openbitfun-system",
      sourceId: "openbitfun-system",
      sourceLabel: "OpenBitFun",
      dirName: "core-guide",
      isBuiltin: true,
      isShadowed: false,
    },
    {
      key: "user::openbitfun::reviewer",
      name: "Code Reviewer",
      description: "Structured code review checklist.",
      path: "/skills/reviewer",
      level: "user",
      sourceSlot: "openbitfun",
      sourceId: "openbitfun",
      sourceLabel: "OpenBitFun",
      installationSource: "team/skills",
      dirName: "reviewer",
      isBuiltin: false,
      isShadowed: false,
    },
    ...(options.includeShadowedSkill
      ? [
          {
            key: "project::openbitfun::shadowed-skill",
            name: "Shadowed Skill",
            description: "Overridden project skill.",
            path: "/repo/.openbitfun/skills/shadowed-skill",
            level: "project",
            sourceSlot: "openbitfun",
            sourceId: "openbitfun",
            sourceLabel: "OpenBitFun",
            dirName: "shadowed-skill",
            isBuiltin: false,
            isShadowed: true,
            shadowedByKey: "user::openbitfun::reviewer",
          },
        ]
      : []),
  ];

  const fileContents: Record<string, string> = {
    "/skills/reviewer/SKILL.md": "# Code Reviewer\n\nInspect diffs for **correctness** and missing tests.",
    "/skills/builtin/core-guide/SKILL.md": "# Core Guide\n\nBaseline workspace instructions.",
    ...(options.fileContent ?? {}),
  };

  let disabledSkills = [...(options.initialDisabledSkills ?? [])];

  const marketItems: Array<Record<string, unknown>> = [
    {
      id: "skills-sh:https://skills.sh#team/skills/reviewer",
      name: "reviewer",
      description: "Code review automation skill.",
      source: "team/skills",
      installs: 1200,
      url: "https://skills.sh/team/skills/reviewer",
      installId: "skills-sh:https://skills.sh#team/skills@reviewer",
      marketName: "skills.sh",
    },
    {
      id: "skills-sh:https://skills.sh#team/skills/testing",
      name: "testing",
      description: "Automated test generation and coverage.",
      source: "team/skills",
      installs: 420,
      url: "https://skills.sh/team/skills/testing",
      installId: "skills-sh:https://skills.sh#team/skills@testing",
      marketName: "skills.sh",
    },
  ];

  const RAW_ONLY = new Set([
    "list_agent_tool_names",
    "get_agent_profile_configs",
    "set_agent_profile_config",
    "reset_agent_profile_config",
    "get_skill_configs",
    "validate_skill_path",
    "add_skill",
    "delete_skill",
  ]);

  const REQUEST_ONLY = new Set([
    "get_available_modes",
    "list_subagents",
    "get_custom_agent_detail",
    "create_custom_agent",
    "update_custom_agent",
    "delete_custom_agent",
    "reload_custom_agents",
    "get_subagent_detail",
    "create_subagent",
    "update_subagent",
    "delete_subagent",
    "reload_subagents",
    "update_subagent_config",
    "get_global_skill_settings",
    "set_global_skill_disabled",
    "list_skill_market",
    "search_skill_market",
    "download_skill_market",
  ]);

  function handleCustomAction(action: string, payload: Record<string, unknown>): { handled: boolean; value?: unknown } {
    switch (action) {
      case "get_available_modes":
        return { handled: true, value: [...modes] };
      case "list_subagents":
        return { handled: true, value: [...subagents] };
      case "list_agent_tool_names":
        return { handled: true, value: [...toolNames] };
      case "get_agent_profile_configs":
        return { handled: true, value: { ...profileConfigs } };
      case "set_agent_profile_config": {
        const agentId = String(payload.agentId ?? "");
        const config = (payload.config ?? {}) as Record<string, unknown>;
        profileConfigs = { ...profileConfigs, [agentId]: config };
        const idx = modes.findIndex(m => m.id === agentId);
        if (idx >= 0 && Array.isArray(config.enabled_tools)) {
          modes[idx] = {
            ...modes[idx],
            toolCount: config.enabled_tools.length,
          };
        }
        return { handled: true, value: `Updated ${agentId}` };
      }
      case "reset_agent_profile_config": {
        const agentId = String(payload.agentId ?? "");
        profileConfigs = {
          ...profileConfigs,
          [agentId]: {
            profile_id: agentId,
            default_tools: ["Read", "Write", "Grep"],
            enabled_tools: ["Read", "Write", "Grep"],
          },
        };
        return { handled: true, value: `Reset ${agentId}` };
      }
      case "get_custom_agent_detail": {
        const agentId = String(payload.agentId ?? "");
        const found = customAgentDetails[agentId];
        if (!found) throw new Error(`Unknown custom agent: ${agentId}`);
        return { handled: true, value: found };
      }
      case "create_custom_agent": {
        const id = String(payload.id ?? "");
        const name = String(payload.name ?? id);
        const tools = Array.isArray(payload.tools) ? payload.tools : ["Read"];
        modes.push({
          id,
          name,
          description: String(payload.description ?? ""),
          source: String(payload.level ?? "user"),
          isReadonly: Boolean(payload.readonly),
          toolCount: tools.length,
          defaultTools: tools,
          configProfileId: id,
          model: payload.model ?? null,
        });
        customAgentDetails[id] = {
          agentId: id,
          kind: String(payload.kind ?? "mode"),
          level: String(payload.level ?? "user"),
          name,
          description: String(payload.description ?? ""),
          prompt: String(payload.prompt ?? ""),
          tools,
          readonly: Boolean(payload.readonly),
          review: false,
          model: String(payload.model ?? ""),
          path: `/tmp/agents/${id.toLowerCase()}.md`,
        };
        return { handled: true, value: null };
      }
      case "update_custom_agent": {
        const agentId = String(payload.agentId ?? "");
        const idx = modes.findIndex(m => m.id === agentId);
        if (idx >= 0) {
          modes[idx] = {
            ...modes[idx],
            name: String(payload.name ?? modes[idx].name),
            description: String(payload.description ?? modes[idx].description),
            isReadonly: payload.readonly !== undefined ? Boolean(payload.readonly) : modes[idx].isReadonly,
            defaultTools: Array.isArray(payload.tools) ? payload.tools : modes[idx].defaultTools,
            toolCount: Array.isArray(payload.tools) ? payload.tools.length : modes[idx].toolCount,
            model: payload.model ?? modes[idx].model,
          };
        }
        if (customAgentDetails[agentId]) {
          customAgentDetails[agentId] = {
            ...customAgentDetails[agentId],
            name: String(payload.name ?? customAgentDetails[agentId].name),
            description: String(payload.description ?? customAgentDetails[agentId].description),
            prompt: String(payload.prompt ?? customAgentDetails[agentId].prompt),
            tools: Array.isArray(payload.tools) ? payload.tools : customAgentDetails[agentId].tools,
            readonly: Boolean(payload.readonly),
            model: String(payload.model ?? ""),
          };
        }
        return { handled: true, value: null };
      }
      case "delete_custom_agent": {
        const agentId = String(payload.agentId ?? "");
        const idx = modes.findIndex(m => m.id === agentId);
        if (idx >= 0) modes.splice(idx, 1);
        delete customAgentDetails[agentId];
        return { handled: true, value: null };
      }
      case "reload_custom_agents":
      case "reload_subagents":
        return { handled: true, value: null };
      case "get_subagent_detail": {
        const subagentId = String(payload.subagentId ?? "");
        const found = customSubagentDetails[subagentId];
        if (!found) throw new Error(`Unknown subagent: ${subagentId}`);
        return { handled: true, value: found };
      }
      case "create_subagent": {
        const id = String(payload.id ?? payload.name ?? "");
        const name = String(payload.name ?? id);
        const level = String(payload.level ?? "user");
        const tools = Array.isArray(payload.tools) ? payload.tools : ["Read"];
        subagents.push({
          id,
          name,
          description: String(payload.description ?? ""),
          source: level,
          subagentSource: level,
          isReadonly: Boolean(payload.readonly ?? true),
          isReview: false,
          toolCount: tools.length,
          defaultTools: tools,
          effectiveEnabled: true,
          model: payload.model ?? null,
        });
        customSubagentDetails[id] = {
          subagentId: id,
          name,
          description: String(payload.description ?? ""),
          prompt: String(payload.prompt ?? ""),
          tools,
          readonly: Boolean(payload.readonly ?? true),
          review: false,
          enabled: true,
          model: String(payload.model ?? ""),
          level,
          path: `/tmp/agents/${id.toLowerCase()}.md`,
        };
        return { handled: true, value: null };
      }
      case "update_subagent": {
        const subagentId = String(payload.subagentId ?? "");
        const idx = subagents.findIndex(s => s.id === subagentId);
        if (idx >= 0) {
          subagents[idx] = {
            ...subagents[idx],
            name: String(payload.name ?? subagents[idx].name),
            description: String(payload.description ?? subagents[idx].description),
            isReadonly: Boolean(payload.readonly),
            defaultTools: Array.isArray(payload.tools) ? payload.tools : subagents[idx].defaultTools,
            toolCount: Array.isArray(payload.tools) ? payload.tools.length : subagents[idx].toolCount,
            model: payload.model ?? subagents[idx].model,
          };
        }
        if (customSubagentDetails[subagentId]) {
          customSubagentDetails[subagentId] = {
            ...customSubagentDetails[subagentId],
            name: String(payload.name ?? customSubagentDetails[subagentId].name),
            description: String(payload.description ?? customSubagentDetails[subagentId].description),
            prompt: String(payload.prompt ?? customSubagentDetails[subagentId].prompt),
            tools: Array.isArray(payload.tools) ? payload.tools : customSubagentDetails[subagentId].tools,
            readonly: Boolean(payload.readonly),
            model: String(payload.model ?? ""),
          };
        }
        return { handled: true, value: null };
      }
      case "delete_subagent": {
        const subagentId = String(payload.subagentId ?? "");
        const idx = subagents.findIndex(s => s.id === subagentId);
        if (idx >= 0) subagents.splice(idx, 1);
        delete customSubagentDetails[subagentId];
        return { handled: true, value: null };
      }
      case "list_manageable_subagents": {
        const parent = String(payload.parentAgentType ?? "");
        return {
          handled: true,
          value: subagents.map(sub => ({
            ...sub,
            effectiveEnabled: (sub as Record<string, unknown>)[`enabledFor:${parent}`] !== false,
          })),
        };
      }
      case "update_subagent_config": {
        if (payload.parentAgentType && payload.enabled !== undefined) {
          const target = subagents.find(s => s.id === String(payload.subagentId ?? ""));
          if (target) target[`enabledFor:${String(payload.parentAgentType)}`] = Boolean(payload.enabled);
        }
        const subagentId = String(payload.subagentId ?? "");
        const idx = subagents.findIndex(s => s.id === subagentId);
        if (idx >= 0) {
          subagents[idx] = {
            ...subagents[idx],
            effectiveEnabled: payload.enabled !== undefined ? Boolean(payload.enabled) : subagents[idx].effectiveEnabled,
            model: payload.model !== undefined ? payload.model : subagents[idx].model,
          };
        }
        return { handled: true, value: { availabilityUpdated: true, modelUpdated: true } };
      }
      case "get_skill_configs": {
        if (options.skillConfigsShape === "array") {
          return { handled: true, value: [...skills] };
        }
        return {
          handled: true,
          value: {
            skills: [...skills],
            diagnostics: [
              {
                path: "/tmp/broken-skill",
                sourceId: "codex",
                message: "Missing frontmatter description",
              },
            ],
            importOperationsVersion: 3,
          },
        };
      }
      case "get_global_skill_settings": {
        return {
          handled: true,
          value: {
            globallyDisabledUserSkillKeys: disabledSkills.filter(k => k.startsWith("user::")),
            globallyDisabledProjectSkillKeys: disabledSkills.filter(k => k.startsWith("project::")),
            directSkillManagementVersion: 1,
          },
        };
      }
      case "set_global_skill_disabled": {
        const skillKey = String(payload.skillKey ?? "");
        const disabled = Boolean(payload.disabled);
        disabledSkills = disabled
          ? Array.from(new Set([...disabledSkills, skillKey]))
          : disabledSkills.filter(k => k !== skillKey);
        return {
          handled: true,
          value: {
            globallyDisabledUserSkillKeys: disabledSkills.filter(k => k.startsWith("user::")),
            globallyDisabledProjectSkillKeys: disabledSkills.filter(k => k.startsWith("project::")),
            directSkillManagementVersion: 1,
          },
        };
      }
      case "validate_skill_path": {
        const path = String(payload.path ?? "");
        if (path.includes("invalid")) {
          return { handled: true, value: { valid: false, error: "Directory is missing SKILL.md file" } };
        }
        return {
          handled: true,
          value: { valid: true, name: "my-skill", description: "Validated folder skill." },
        };
      }
      case "add_skill": {
        const sourcePath = String(payload.sourcePath ?? "");
        const level = payload.level === "project" ? "project" : "user";
        const dirName = sourcePath.split("/").filter(Boolean).pop() || "my-skill";
        skills.push({
          key: `${level}::openbitfun::${dirName}`,
          name: dirName,
          description: "Validated folder skill.",
          path: sourcePath,
          level,
          sourceSlot: "openbitfun",
          sourceId: "openbitfun",
          sourceLabel: "OpenBitFun",
          dirName,
          isBuiltin: false,
          isShadowed: false,
        });
        return { handled: true, value: `Skill '${dirName}' added successfully` };
      }
      case "delete_skill": {
        const skillKey = String(payload.skillKey ?? "");
        const idx = skills.findIndex(s => s.key === skillKey);
        if (idx >= 0) skills.splice(idx, 1);
        return { handled: true, value: "Skill deleted successfully" };
      }
      case "list_skill_market": {
        if (options.marketShape === "array") {
          return { handled: true, value: [...marketItems] };
        }
        return {
          handled: true,
          value: {
            skills: [...marketItems],
            sourceErrors: ["PrivateMarket: timeout"],
          },
        };
      }
      case "search_skill_market": {
        const q = String(payload.query ?? "").trim().toLowerCase();
        const filtered = marketItems.filter(item =>
          `${String(item.name)} ${String(item.description)}`.toLowerCase().includes(q),
        );
        if (options.marketShape === "array") {
          return { handled: true, value: filtered };
        }
        return {
          handled: true,
          value: {
            skills: filtered,
            sourceErrors: [],
          },
        };
      }
      case "download_skill_market": {
        const pkg = String(payload.package ?? "");
        const level = payload.level === "project" ? "project" : "user";
        const shortName = pkg.split("@").pop() || "downloaded";
        skills.push({
          key: `${level}::openbitfun::${shortName}`,
          name: shortName,
          description: "Installed from marketplace.",
          path: `/skills/${shortName}`,
          level,
          sourceSlot: "openbitfun",
          sourceId: "openbitfun",
          sourceLabel: "OpenBitFun",
          installationSource: "team/skills",
          dirName: shortName,
          isBuiltin: false,
          isShadowed: false,
        });
        return {
          handled: true,
          value: {
            package: pkg,
            level,
            installedSkills: [shortName],
            output: "Skill downloaded successfully.",
          },
        };
      }
      case "read_file_content": {
        const filePath = String(payload.filePath ?? "");
        if (filePath in fileContents) {
          return { handled: true, value: fileContents[filePath] };
        }
        return { handled: false };
      }
      default:
        return { handled: false };
    }
  }

  const handlers: Record<string, (data: unknown) => unknown> = {
    ...base.handlers,
    "openbitfun.invoke": (data: unknown) => {
      const args = (data ?? {}) as { action?: string; request?: unknown; raw?: unknown };
      const action = args.action ?? "";
      const raw = Object.prototype.hasOwnProperty.call(args, "raw");
      const payload = (raw ? args.raw : args.request) ?? {};
      recorded.push({ action, request: payload, raw });

      if (RAW_ONLY.has(action) && !raw) {
        return { ok: false, error: `${action} must be called via invokeRawCommand (raw: true)` };
      }
      if (REQUEST_ONLY.has(action) && raw) {
        return { ok: false, error: `${action} must be called via invokeCommand (raw: false)` };
      }

      try {
        const custom = handleCustomAction(action, payload as Record<string, unknown>);
        if (custom.handled) {
          return { ok: true, value: custom.value, transport: "dev" };
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          transport: "dev",
        };
      }

      return baseInvoke(data);
    },
  };

  return {
    base,
    calls: recorded,
    handlers,
    callFor: (action: string) => recorded.filter(call => call.action === action),
  };
}

test("AgentsScene loads catalog with exact raw flags, filters, and Start Thread switches to Sessions", async () => {
  const mock = createAgentsSkillsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });

  await showAllSessions(app, "NSH skeleton");
  await openLibraryTab(app, "agents");
  await app.waitFor("Agents your sessions can use, and the helpers they call.");
  await app.waitFor("Reviewer");
  await app.waitFor("HelperSub");

  expect(mock.callFor("get_available_modes")[0]).toMatchObject({
    raw: false,
    request: { workspaceId: "workspace-1", workspacePath: "/repo" },
  });
  expect(mock.callFor("list_subagents")[0]).toMatchObject({
    raw: false,
    request: { workspaceId: "workspace-1", workspacePath: "/repo" },
  });
  expect(mock.callFor("list_agent_tool_names")[0]).toMatchObject({ raw: true });
  expect(mock.callFor("get_agent_profile_configs")[0]).toMatchObject({ raw: true });

  // SegmentedTabs filtering
  await app.press("agents-tab-subagent");
  await app.waitFor("HelperSub");
  expect(app.texts()).not.toContain("Reviewer");

  await app.press("agents-tab-mode");
  await app.waitFor("Reviewer");
  expect(app.texts()).not.toContain("HelperSub");

  await app.press("agents-tab-all");
  await app.waitFor("HelperSub");

  // Source SelectDropdown filter
  await app.press("agents-source-select");
  await app.press("agent-scope-user");
  await app.waitUntil(() => !app.texts().includes("OpenCode ACP"));
  expect(app.texts()).toContain("Reviewer");
  expect(app.texts()).not.toContain("OpenCode ACP");
  await app.press("agents-source-select");
  await app.press("agent-scope-all");
  await app.waitFor("OpenCode ACP");

  // Search filter
  await app.type("agents-search-input", "OpenCode");
  expect(app.texts()).toContain("OpenCode ACP");
  expect(app.texts()).not.toContain("HelperSub");
  await app.clear("agents-search-input");

  // Start Thread switches to Sessions with the requested mode
  await app.press("agent-start-thread-Reviewer");
  await app.waitFor("How can I help today?");
  await app.press("bot-capsule-trigger");
  await app.waitFor("label:agent-picker >> text:Reviewer");
  const createSessionCall = mock.calls.find(call => call.action === "create_session");
  expect(createSessionCall?.request).toMatchObject({
    agentType: "Reviewer",
    workspaceId: "workspace-1",
  });
});

test("AgentsScene creates, edits, deletes custom mode and configures/resets built-in profile", async () => {
  const mock = createAgentsSkillsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });

  await showAllSessions(app, "NSH skeleton");
  await openLibraryTab(app, "agents");
  await app.waitFor("Reviewer");

  // Create custom primary mode
  await app.press("agents-create-bot");
  await app.type("builder-id-input", "architect");
  await app.type("builder-name-input", "Architect");
  await app.type("builder-description-input", "Designs modular systems.");
  await app.type("builder-model-input", "gpt-4.1");
  await app.type("builder-prompt-input", "Write clean architecture plans.");
  await app.press("builder-readonly-toggle");
  await app.press("builder-tools-clear");
  await app.press("builder-tool-Read");
  await app.press("builder-tool-Grep");
  await app.press("builder-save");

  await app.waitFor("Architect");
  const createCall = mock.callFor("create_custom_agent")[0];
  expect(createCall?.raw).toBe(false);
  expect(createCall?.request).toMatchObject({
    kind: "mode",
    level: "user",
    id: "architect",
    name: "Architect",
    description: "Designs modular systems.",
    prompt: "Write clean architecture plans.",
    tools: ["Read", "Grep"],
    readonly: true,
    model: "gpt-4.1",
    workspaceId: "workspace-1",
  });

  // Edit custom mode
  await app.press("agent-configure-architect");
  await app.waitFor("Edit Primary Agent · Architect");
  expect(mock.callFor("get_custom_agent_detail")[0]).toMatchObject({
    raw: false,
    request: { agentId: "architect", workspaceId: "workspace-1" },
  });

  await app.clear("builder-description-input");
  await app.type("builder-description-input", "Updated design specialist.");
  await app.press("builder-save");

  await app.waitFor("Updated design specialist.");
  const updateCall = mock.callFor("update_custom_agent")[0];
  expect(updateCall?.raw).toBe(false);
  expect(updateCall?.request).toMatchObject({
    agentId: "architect",
    name: "Architect",
    description: "Updated design specialist.",
    workspaceId: "workspace-1",
  });

  // Delete custom mode via card action DropdownMenu in-place Cancel | Confirm
  await app.press("agent-actions-architect");
  await app.press("agent-menu-delete-architect");
  await app.waitFor("agent-delete-confirm");
  expect(app.shows("agent-delete-dialog")).toBe(false);
  await app.press("agent-delete-confirm");

  await app.waitUntil(() => !app.texts().includes("Architect"));
  expect(mock.callFor("delete_custom_agent")[0]).toMatchObject({
    raw: false,
    request: { agentId: "architect", workspaceId: "workspace-1" },
  });

  // Built-in profile tool configuration (raw: true) & reset (raw: true)
  await app.press("agent-configure-Standard");
  await app.waitFor("Configure Profile · Standard");
  await app.press("agent-capability-subagents");
  await app.press("mode-subagents-manage");
  await app.waitFor("parent-subagent-Explorer");
  expect(mock.callFor("list_manageable_subagents").at(-1)?.request).toMatchObject({
    parentAgentType: "Standard",
  });
  await app.press("parent-subagent-Explorer");
  expect(mock.callFor("update_subagent_config")).toHaveLength(0);
  await app.press("mode-subagents-save");
  await app.waitUntil(() => mock.callFor("update_subagent_config").length > 0);
  expect(mock.callFor("update_subagent_config")[0]?.request).toMatchObject({
    subagentId: "Explorer",
    parentAgentType: "Standard",
    enabled: false,
  });
  await app.waitFor("mode-subagents-manage");
  await app.press("mode-subagents-back");
  await app.press("agent-capability-tools");
  await app.press("profile-manage");
  await app.press("builder-tool-Bash");
  expect(mock.callFor("set_agent_profile_config")).toHaveLength(0);
  await app.press("profile-save");

  const setProfileCall = mock.callFor("set_agent_profile_config")[0];
  expect(setProfileCall?.raw).toBe(true);
  expect(setProfileCall?.request).toMatchObject({
    agentId: "Standard",
    config: {
      enabled_tools: ["Read", "Write", "Grep", "Bash"],
    },
  });

  await app.waitFor("profile-manage");
  await app.press("profile-reset");
  const resetProfileCall = mock.callFor("reset_agent_profile_config")[0];
  expect(resetProfileCall?.raw).toBe(true);
  expect(resetProfileCall?.request).toMatchObject({ agentId: "Standard" });
  await app.press("profile-back");
  await app.press("agent-builder-close");
});

test("Agent tool groups keep reusable definitions and profile permissions independently editable", async () => {
  const mock = createAgentsSkillsBackend();
  type SavedGroup = { id: string; name: string; toolNames: string[] };
  const original = { id: "daily", name: "Daily checks", toolNames: ["Read", "Bash", "RetiredTool"] };
  let groups: SavedGroup[] = [original];
  let storedVersion = 1;
  const groupWrites: SavedGroup[][] = [];
  const invoke = mock.handlers["openbitfun.invoke"];
  mock.handlers["openbitfun.invoke"] = data => {
    const args = data as { action: string; request?: Record<string, unknown>; raw?: unknown };
    const success = (value: unknown) => ({ ok: true, transport: "dev", value });
    if (args.action === "get_all_tools_info") {
      expect(args.raw).toEqual({});
      return success([
        { name: "GetToolSpec" },
        { name: "DocsLookup", description: "Query indexed documentation",
          dynamic_info: { providerId: "mcp:docs", mcp: { serverName: "Docs server" } } },
      ]);
    }
    if (args.request?.path === "app.user_tool_groups") {
      if (args.action === "get_config") return success({ version: storedVersion, groups });
      if (args.action === "set_config") {
        const value = args.request.value as { version: number; groups: SavedGroup[] };
        expect(value.version).toBe(1);
        groups = value.groups;
        groupWrites.push(groups);
        return success(null);
      }
    }
    return invoke(data);
  };
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });

  await showAllSessions(app, "NSH skeleton");
  await openLibraryTab(app, "agents");
  await app.press("agent-configure-Standard");
  await app.press("agent-capability-tools");
  await app.waitFor("Daily checks");
  await app.press("profile-manage");
  await app.type("builder-tools-search", "indexed documentation");
  await app.waitFor("Extension · Docs server");
  await app.waitFor("builder-tool-DocsLookup");
  expect(app.shows("builder-tool-Read")).toBe(false);
  await app.clear("builder-tools-search");
  expect(app.shows("builder-tool-GetToolSpec")).toBe(false);

  await app.press("id:agent-tool-group-user:daily");
  expect(mock.callFor("set_agent_profile_config")).toHaveLength(0);
  expect(groupWrites).toHaveLength(0);
  await app.press("agent-tool-groups-manage");
  await app.press("agent-tool-group-edit-daily");
  await app.waitFor("RetiredTool");
  await app.clear("agent-tool-group-name");
  await app.type("agent-tool-group-name", "Daily inspection");
  await app.press("agent-tool-group-save");
  await app.waitFor("agent-tool-group-add");
  expect(groups).toEqual([{ ...original, name: "Daily inspection" }]);

  await app.press("agent-tool-group-add");
  await app.type("agent-tool-group-name", "Documentation");
  await app.type("agent-tool-group-search", "docs");
  await app.press("agent-tool-group-tool-DocsLookup");
  await app.press("agent-tool-group-save");
  await app.waitFor("agent-tool-group-add");
  const added = groups[1];
  expect(added).toMatchObject({ name: "Documentation", toolNames: ["DocsLookup"] });
  await app.press(`agent-tool-group-up-${added.id}`);
  await app.waitUntil(() => groups[0]?.id === added.id);
  await app.press(`agent-tool-group-delete-${added.id}`);
  await app.press(`agent-tool-group-delete-${added.id}-confirm`);
  await app.waitUntil(() => groups.length === 1);
  expect(groupWrites).toHaveLength(4);
  expect(groups).toEqual([{ ...original, name: "Daily inspection" }]);

  await app.press("agent-tool-group-edit-daily");
  await app.clear("agent-tool-group-name");
  await app.type("agent-tool-group-name", "Stale draft");
  groups = [{ ...original, name: "Updated on another device" }];
  await app.press("agent-tool-group-save");
  await app.waitFor("This tool group changed elsewhere. Close and reopen Tools to load the latest groups.");
  await app.press("agent-tool-group-cancel");
  await app.waitFor("Discard your unsaved changes to this tool group?");
  await app.press("Discard changes");
  await app.waitFor("agent-tool-group-add");
  expect(groupWrites).toHaveLength(4);
  expect(mock.callFor("set_agent_profile_config")).toHaveLength(0);

  await app.press("agent-tool-group-done");
  await app.press("profile-save");
  await app.waitFor("profile-manage");
  expect(mock.callFor("set_agent_profile_config")[0]).toMatchObject({
    raw: true,
    request: { agentId: "Standard", config: { enabled_tools: ["Read", "Write", "Grep", "Bash"] } },
  });
  expect(groupWrites).toHaveLength(4);
  expect(groups).toEqual([{ ...original, name: "Updated on another device" }]);
  await app.press("profile-back");
  await app.press("agent-capability-tools");
  await app.waitFor("Updated on another device");

  storedVersion = 2;
  await app.press("profile-back");
  await app.press("agent-capability-tools");
  await app.waitFor("This version cannot edit the saved tool groups.");
  await app.press("profile-manage");
  await app.press("builder-tool-Bash");
  expect(groupWrites).toHaveLength(4);
  expect(mock.callFor("set_agent_profile_config")).toHaveLength(1);
});

test("subagent capability retry submits only the pending changes after a partial save", async () => {
  const mock = createAgentsSkillsBackend();
  const invoke = mock.handlers["openbitfun.invoke"];
  const updates: string[] = [];
  let refuseHelper = true;
  mock.handlers["openbitfun.invoke"] = data => {
    const args = data as { action: string; request?: Record<string, unknown> };
    if (args.action === "list_manageable_subagents") {
      const response = invoke(data) as { ok: boolean; value: unknown[] };
      return { ...response, value: [...response.value, {
        id: "External", name: "External assistant", source: "external", effectiveEnabled: true,
      }] };
    }
    if (args.action === "update_subagent_config") {
      const id = String(args.request?.subagentId);
      updates.push(id);
      if (refuseHelper && id === "HelperSub") return { ok: false, error: "Device is busy", transport: "dev" };
    }
    return invoke(data);
  };
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });
  await openLibraryTab(app, "agents");
  await app.press("agent-configure-Standard");
  await app.press("agent-capability-subagents");
  await app.press("mode-subagents-manage");
  expect(app.enabled("parent-subagent-External")).toBe(false);
  await app.press("parent-subagent-Explorer");
  await app.press("parent-subagent-HelperSub");
  expect(updates).toHaveLength(0);
  await app.press("mode-subagents-save");
  await app.waitFor("Some changes are already in effect. Retry to apply the remaining changes. Could not update the subagent: Device is busy");
  expect(updates).toEqual(["Explorer", "HelperSub"]);
  expect(app.accessibility("id:parent-subagent-Explorer")?.checked).toBe("false");
  expect(app.accessibility("id:parent-subagent-HelperSub")?.checked).toBe("false");
  refuseHelper = false;
  await app.press("mode-subagents-save");
  await app.waitFor("mode-subagents-manage");
  expect(updates).toEqual(["Explorer", "HelperSub", "HelperSub"]);
  expect(mock.callFor("update_subagent_config").map(call => call.request)).toEqual([
    { parentAgentType: "Standard", subagentId: "Explorer", enabled: false, workspaceId: "workspace-1" },
    { parentAgentType: "Standard", subagentId: "HelperSub", enabled: false, workspaceId: "workspace-1" },
  ]);
});

test("AgentsScene creates, edits, configures, reloads, and deletes subagents", async () => {
  const mock = createAgentsSkillsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });

  await showAllSessions(app, "NSH skeleton");
  await openLibraryTab(app, "agents");
  await app.waitFor("Explorer");

  // Create project subagent
  await app.press("agents-create-bot");
  await app.press("builder-kind-subagent");
  await app.press("builder-level-project");
  await app.type("builder-id-input", "qa-bot");
  await app.type("builder-name-input", "qa-bot");
  await app.type("builder-description-input", "Validates test suites.");
  await app.type("builder-prompt-input", "Check edge cases.");
  await app.press("builder-tool-Bash");
  await app.press("builder-save");

  await app.waitFor("qa-bot");
  const createSub = mock.callFor("create_subagent")[0];
  expect(createSub?.raw).toBe(false);
  expect(createSub?.request).toMatchObject({
    level: "project",
    id: "qa-bot",
    name: "qa-bot",
    description: "Validates test suites.",
    prompt: "Check edge cases.",
    readonly: true,
    workspaceId: "workspace-1",
  });

  // Edit custom subagent
  await app.press("agent-configure-qa-bot");
  await app.waitFor("Edit Subagent · qa-bot");
  expect(mock.callFor("get_subagent_detail")[0]).toMatchObject({
    raw: false,
    request: { subagentId: "qa-bot", workspaceId: "workspace-1" },
  });

  await app.clear("builder-description-input");
  await app.type("builder-description-input", "Runs full regression checks.");
  await app.press("builder-save");

  await app.waitFor("Runs full regression checks.");
  expect(mock.callFor("update_subagent")[0]).toMatchObject({
    raw: false,
    request: {
      subagentId: "qa-bot",
      description: "Runs full regression checks.",
      workspaceId: "workspace-1",
    },
  });

  // Configure built-in subagent enabled/model override
  await app.press("agent-configure-Explorer");
  await app.waitFor("Configure Subagent · Explorer");
  await app.press("subagent-enabled-toggle");
  // Availability is scoped to a parent the user picks; the host never gets a guessed one.
  await app.press("subagent-config-save");
  await app.waitFor("Choose the parent agent this availability applies to.");
  expect(mock.callFor("update_subagent_config").length).toBe(0);
  await app.press("subagent-parent-select");
  await app.press("subagent-parent-Reviewer");
  await app.press("subagent-model-select");
  await app.press("subagent-model-fast");
  await app.press("subagent-config-save");
  await app.waitUntil(() => mock.callFor("update_subagent_config").length > 0);

  const configSub = mock.callFor("update_subagent_config")[0];
  expect(configSub?.raw).toBe(false);
  expect(configSub?.request).toMatchObject({
    subagentId: "Explorer",
    enabled: false,
    parentAgentType: "Reviewer",
  });
  expect((configSub?.request as Record<string, unknown>).model).toBeUndefined();
  // A built-in's model is the desktop's model selection document, not a model string.
  await app.waitUntil(() =>
    mock.base.settingsWrites.some(w => w.path === "ai.agent_model_selections.subagents.builtin.Explorer"),
  );
  expect(
    mock.base.settingsWrites.find(w => w.path === "ai.agent_model_selections.subagents.builtin.Explorer")?.value,
  ).toEqual({ kind: "model", model_ref: "fast" });

  // Clearing the choice removes the override.
  await app.press("subagent-model-select");
  await app.press("subagent-model-default");
  await app.press("subagent-config-save");
  await app.waitUntil(
    () =>
      mock.base.settingsWrites.filter(w => w.path === "ai.agent_model_selections.subagents.builtin.Explorer")
        .length === 2,
  );
  expect(mock.base.settingsWrites.at(-1)?.value).toBe(null);
  await app.press("agent-builder-close");

  // Reload triggers both reload_custom_agents and reload_subagents
  await app.press("agents-reload");
  expect(mock.callFor("reload_custom_agents")[0]).toMatchObject({
    raw: false,
    request: { workspaceId: "workspace-1" },
  });
  expect(mock.callFor("reload_subagents")[0]).toMatchObject({
    raw: false,
    request: { workspaceId: "workspace-1" },
  });

  // Delete custom subagent via DropdownMenu in-place Cancel | Confirm
  await app.press("agent-actions-qa-bot");
  await app.press("agent-menu-delete-qa-bot");
  await app.waitFor("agent-delete-confirm");
  expect(app.shows("agent-delete-dialog")).toBe(false);
  await app.press("agent-delete-confirm");
  await app.waitUntil(() => !app.texts().includes("qa-bot"));
  expect(mock.callFor("delete_subagent")[0]).toMatchObject({
    raw: false,
    request: { subagentId: "qa-bot", workspaceId: "workspace-1" },
  });
});

test("SkillsScene toggles global disabled, inspects SKILL.md, validates, installs, and deletes skills", async () => {
  const mock = createAgentsSkillsBackend({ includeShadowedSkill: true });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });

  await showAllSessions(app, "NSH skeleton");
  await openLibraryTab(app, "skills");
  await app.waitFor("Code Reviewer");
  await app.waitFor("Shadowed · Overridden by user::openbitfun::reviewer");
  await app.waitFor("Discovery Diagnostics");

  expect(mock.callFor("get_skill_configs")[0]).toMatchObject({
    raw: true,
    request: {
      forceRefresh: false,
      includeDiagnostics: true,
      workspaceId: "workspace-1",
      workspacePath: "/repo",
    },
  });
  expect(mock.callFor("get_global_skill_settings")[0]).toMatchObject({
    raw: false,
    request: { workspaceId: "workspace-1", workspacePath: "/repo" },
  });

  // Toggle global disabled
  await app.press("label:skill-toggle-user::openbitfun::reviewer");
  expect(mock.callFor("set_global_skill_disabled")[0]).toMatchObject({
    raw: false,
    request: {
      skillKey: "user::openbitfun::reviewer",
      disabled: true,
      workspaceId: "workspace-1",
      workspacePath: "/repo",
    },
  });

  // Inspect SKILL.md via read_file_content
  await app.press("label:skill-inspect-user::openbitfun::reviewer");
  await app.waitFor("Path: /skills/reviewer");
  await app.waitFor("Inspect diffs for correctness and missing tests.");
  expect(mock.callFor("read_file_content")[0]).toMatchObject({
    raw: false,
    request: {
      workspaceId: "workspace-1",
      filePath: "/skills/reviewer/SKILL.md",
    },
  });
  await app.press("skill-inspect-close");

  // Install from Folder: invalid path -> Validate -> valid path -> Scope -> Install skill
  await app.press("skills-install-folder-toggle");
  await app.type("skill-folder-path-input", "/tmp/invalid-skill");
  await app.press("skill-folder-validate");
  await app.waitFor("Directory is missing SKILL.md file");
  expect(app.enabled("skill-folder-install")).toBe(false);

  await app.clear("skill-folder-path-input");
  await app.type("skill-folder-path-input", "/tmp/my-skill");
  await app.press("skill-folder-validate");
  await app.waitFor("Validated folder skill.");

  expect(mock.callFor("validate_skill_path")[1]).toMatchObject({
    raw: true,
    request: {
      path: "/tmp/my-skill",
      sourceKey: null,
      workspaceId: "workspace-1",
      workspacePath: "/repo",
    },
  });

  await app.press("skill-folder-scope-project");
  await app.press("skill-folder-install");
  await app.waitFor("my-skill");

  expect(mock.callFor("add_skill")[0]).toMatchObject({
    raw: true,
    request: {
      sourcePath: "/tmp/my-skill",
      level: "project",
      workspaceId: "workspace-1",
      workspacePath: "/repo",
      sourceKey: null,
      targetName: null,
      expectedSourceFingerprint: null,
    },
  });

  // Scope SelectDropdown filter
  await app.press("skills-scope-select");
  await app.press("skills-scope-builtin");
  await app.waitUntil(() => !app.texts().includes("Code Reviewer"));
  await app.press("skills-scope-select");
  await app.press("skills-scope-all");
  await app.waitFor("Code Reviewer");

  // Delete installed skill via card DropdownMenu in-place Cancel | Confirm
  await app.press("label:skill-actions-project::openbitfun::my-skill");
  await app.press("label:skill-menu-delete-project::openbitfun::my-skill");
  await app.waitFor("skill-delete-confirm");
  expect(app.shows("skill-delete-dialog")).toBe(false);
  await app.press("skill-delete-confirm");
  await app.waitUntil(() => !app.texts().includes("my-skill"));

  expect(mock.callFor("delete_skill")[0]).toMatchObject({
    raw: true,
    request: {
      skillKey: "project::openbitfun::my-skill",
      workspaceId: "workspace-1",
      workspacePath: "/repo",
      expectedImportId: null,
    },
  });
});

test("Skill Groups copy, edit, reorder and delete while preserving unavailable members and agent selections", async () => {
  const mock = createAgentsSkillsBackend();
  const reviewer = "user::openbitfun::reviewer";
  const core = "user::openbitfun-system::core-guide";
  const retired = "user::unavailable::retired";
  const disabled = "user::openbitfun::disabled";
  type SavedGroup = { id: string; name: string; skillKeys: string[] };
  let groups: SavedGroup[] = [{ id: "release", name: "Release checklist", skillKeys: [reviewer, retired, disabled] }];
  const groupWrites: SavedGroup[][] = [];
  const agentWrites: unknown[] = [];
  let enabled = [core];
  const invoke = mock.handlers["openbitfun.invoke"];
  mock.handlers["openbitfun.invoke"] = data => {
    const { action, request } = data as { action: string; request?: Record<string, unknown> };
    const success = (value: unknown) => ({ ok: true, transport: "dev", value });
    if (request?.path === "app.user_skill_groups") {
      if (action === "get_config") return success({ version: 1, groups });
      if (action === "set_config") {
        const value = request.value as { version: number; groups: SavedGroup[] };
        expect(value.version).toBe(1);
        groups = value.groups;
        groupWrites.push(groups);
        return success(null);
      }
    }
    if (action === "get_skill_configs") {
      const answer = invoke(data) as { value: { skills: Array<Record<string, unknown>> } };
      return success({ skills: [
        ...answer.value.skills.map(skill => skill.key === core ? { ...skill, groupKey: "meta" } : skill),
        { key: disabled, name: "Disabled Skill", path: "/skills/disabled", level: "user" },
      ], diagnostics: [] });
    }
    if (action === "get_agent_profile_configs") return success({ Standard: { enabled_tools: ["Read", "Skill"] } });
    if (action === "get_mode_skill_configs") return success([
      { key: reviewer, name: "Code Reviewer", globallyEnabled: true, effectiveEnabled: enabled.includes(reviewer) },
      { key: core, name: "Core Guide", isBuiltin: true, groupKey: "meta", globallyEnabled: true, effectiveEnabled: enabled.includes(core) },
      { key: disabled, name: "Disabled Skill", globallyEnabled: false, effectiveEnabled: false },
    ]);
    if (action === "replace_mode_skill_selection") {
      agentWrites.push(request);
      enabled = (request?.enabledSkillKeys ?? []) as string[];
      return success(null);
    }
    return invoke(data);
  };
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });
  await openLibraryTab(app, "skills");
  await app.press("skills-tab-groups");
  await app.waitFor("Release checklist");
  await app.waitFor("1 unavailable");

  await app.press("id:skill-group-open-builtin:meta");
  expect(app.shows("skill-group-editor-save")).toBe(false);
  await app.press("skill-group-editor-copy");
  await app.press("skill-group-editor-save");
  await app.waitFor("Meta copy");
  expect(groups[1]).toMatchObject({ name: "Meta copy", skillKeys: [core] });
  const copyId = groups[1].id;

  await app.press("id:skill-group-open-user:release");
  await app.waitFor(`text:${retired}`);
  await app.clear("skill-group-editor-name");
  await app.type("skill-group-editor-name", "Release checks");
  await app.press("skill-group-editor-save");
  await app.waitFor("Release checks");
  expect(groups[0]).toMatchObject({ id: "release", name: "Release checks", skillKeys: [reviewer, retired, disabled] });
  await app.press("label:skill-group-actions-user:release");
  await app.press("skill-group-move-down");
  await app.waitUntil(() => groups[0].id === copyId);

  await app.press("skill-group-create");
  await app.type("skill-group-editor-name", "Review Pack");
  await app.type("skill-group-editor-search", "Code Reviewer");
  await app.press(`id:skill-group-editor-member-${reviewer}`);
  await app.press("skill-group-editor-save");
  await app.waitFor("Review Pack");
  expect(groups[2]).toMatchObject({ name: "Review Pack", skillKeys: [reviewer] });
  await app.type("skills-groups-search-input", "Core Guide");
  await app.waitFor("Review Pack", { state: "gone" });
  await app.clear("skills-groups-search-input");

  await app.press(`label:skill-group-actions-user:${copyId}`);
  await app.press("skill-group-delete");
  await app.press("skill-group-delete-confirm");
  await app.waitFor("Meta copy", { state: "gone" });
  expect(groups.map(group => group.name)).toEqual(["Release checks", "Review Pack"]);

  await app.press("id:skill-group-open-user:release");
  await app.clear("skill-group-editor-name");
  await app.type("skill-group-editor-name", "Local edit");
  groups = groups.map(group => group.id === "release" ? { ...group, name: "Changed elsewhere" } : group);
  await app.press("skill-group-editor-save");
  await app.waitFor("This group changed elsewhere. Close the editor and refresh before editing it again.");
  expect(groupWrites).toHaveLength(5);
  expect(app.value("skill-group-editor-name")).toBe("Local edit");
  await app.press("skill-group-editor-close");
  await app.press("Discard changes");
  await app.waitFor("skill-group-editor", { state: "gone" });

  await openLibraryTab(app, "agents");
  await app.press("agent-configure-Standard");
  await app.press("agent-capability-skills");
  await app.press("mode-skills-manage");
  await app.waitFor("Changed elsewhere");
  await app.waitFor("Review Pack");
  expect(agentWrites).toHaveLength(0);
  await app.press("id:agent-skill-group-user:release");
  expect(agentWrites).toHaveLength(0);
  await app.press("mode-skills-save");
  await app.waitUntil(() => agentWrites.length === 1);
  expect(agentWrites[0]).toMatchObject({ modeId: "Standard", enabledSkillKeys: [reviewer, core] });
  expect(groupWrites).toHaveLength(5);
});

test("SkillsScene marketplace lists, searches, shows Installed badge, downloads, and degrades on remote/peer", async () => {
  const mock = createAgentsSkillsBackend({ skillConfigsShape: "array", marketShape: "array" });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });

  await showAllSessions(app, "NSH skeleton");
  await openLibraryTab(app, "skills");
  await app.waitFor("Code Reviewer");

  // Marketplace list
  await app.press("skills-tab-marketplace");
  await app.waitFor("testing");

  expect(mock.callFor("list_skill_market")[0]).toMatchObject({
    raw: false,
    request: { query: null, limit: 30, includeDiagnostics: false },
  });
  expect(app.texts()).toContain("Installed");

  // Search marketplace
  await app.type("market-search-input", "testing");
  await app.press("market-search-submit");
  expect(mock.callFor("search_skill_market")[0]).toMatchObject({
    raw: false,
    request: { query: "testing", limit: 30, includeDiagnostics: false },
  });

  // Download from marketplace
  await app.press("label:market-install-user-skills-sh:https://skills.sh#team/skills/testing");
  await app.waitFor("Installed 'testing' (user) from marketplace.");

  expect(mock.callFor("download_skill_market")[0]).toMatchObject({
    raw: false,
    request: {
      package: "skills-sh:https://skills.sh#team/skills@testing",
      level: "user",
      workspaceId: "workspace-1",
      workspacePath: "/repo",
    },
  });

  // Switch to remote workspace and verify explicit degradation for local-only folder installs & custom agents
  // The place a session runs is where it was asked for: New session here on the remote workspace.
  await showDevices(app);
  await app.hover("id:sidebar-workspace-row-workspace-2");
  await app.press("sidebar-new-session-workspace-2");
  await openLibraryTab(app, "skills");
  await app.waitFor("Remote workspace active: installing skills from a local folder path is unsupported.");
  await app.press("skills-install-folder-toggle");
  expect(app.enabled("skill-folder-validate")).toBe(false);
  expect(app.enabled("skill-folder-install")).toBe(false);

  await openLibraryTab(app, "agents");
  await app.waitFor("Remote workspace active: creating, editing, or deleting custom modes is unsupported on remote workspaces. You can still start sessions and inspect available modes.");
  expect(app.enabled("agents-create-bot")).toBe(false);
});

test("SkillsScene renders marketplace { skills, sourceErrors } object responses", async () => {
  const mock = createAgentsSkillsBackend({ marketShape: "diagnostics" });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });

  await showAllSessions(app, "NSH skeleton");
  await openLibraryTab(app, "skills");
  await app.waitFor("Code Reviewer");

  await app.press("skills-tab-marketplace");
  await app.waitFor("testing");
  await app.waitFor("PrivateMarket: timeout");
});

test("Agents and Skills load the user-level catalogue without a workspace, as the desktop does", async () => {
  const mock = createAgentsSkillsBackend({ openedWorkspaces: [], currentWorkspaceId: null });
  // No recent workspace either, so nothing is reopened at launch.
  const invoke = mock.handlers["openbitfun.invoke"];
  mock.handlers["openbitfun.invoke"] = (data: unknown) =>
    (data as { action?: string })?.action === "get_recent_workspaces"
      ? { ok: true, value: [], transport: "dev" }
      : (data as { action?: string })?.action === "get_workspace_navigator"
        ? { ok: true, value: { opened: [], recent: [], selectedId: null, selection: "none" }, transport: "dev" }
        : invoke(data);
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });
  await app.waitFor("nav-library");

  await openLibraryTab(app, "agents");
  await app.waitFor("Reviewer");
  const modes = mock.callFor("get_available_modes")[0];
  expect((modes?.request as Record<string, unknown> | undefined)?.workspaceId).toBeUndefined();
  expect(mock.callFor("list_subagents").length).toBeGreaterThan(0);

  await openLibraryTab(app, "skills");
  await app.waitUntil(() => mock.callFor("get_skill_configs").length > 0);
  expect(mock.callFor("get_skill_configs")[0]?.request).toMatchObject({
    workspaceId: null,
    workspacePath: null,
  });

  // Re-entering a scene reads the catalogue again.
  const before = mock.callFor("get_available_modes").length;
  await openLibraryTab(app, "agents");
  await app.waitUntil(() => mock.callFor("get_available_modes").length > before);
});

test("an agent skill draft can be discarded and retry preserves unrelated changes on the host", async () => {
  const mock = createAgentsSkillsBackend();
  let enabled = ["review", "deploy"];
  const replaced: unknown[] = [];
  let failSave = true;
  const invoke = mock.handlers["openbitfun.invoke"];
  mock.handlers["openbitfun.invoke"] = (data: unknown) => {
    const args = (data ?? {}) as { action?: string; request?: Record<string, unknown>; raw?: Record<string, unknown> };
    if (args.action === "get_available_modes") {
      return {
        ok: true,
        value: [
          {
            id: "Standard",
            name: "Standard",
            description: "Balanced default profile.",
            source: "builtin",
            toolCount: 2,
            defaultTools: ["Read", "Skill"],
            configProfileId: "Standard",
          },
        ],
        transport: "dev",
      };
    }
    if (args.action === "get_agent_profile_configs") {
      return { ok: true, value: { Standard: { enabled_tools: ["Read", "Skill"] } }, transport: "dev" };
    }
    if (args.action === "get_mode_skill_configs") {
      expect(args.raw).toMatchObject({ modeId: "Standard" });
      return {
        ok: true,
        value: ["review", "deploy", "report"].map(key => ({
          key,
          name: key,
          description: `${key} skill`,
          effectiveEnabled: enabled.includes(key),
          globallyEnabled: true,
        })),
        transport: "dev",
      };
    }
    if (args.action === "replace_mode_skill_selection") {
      replaced.push(args.request);
      if (failSave) return { ok: false, error: "The device is busy", transport: "dev" };
      enabled = ((args.request?.enabledSkillKeys ?? []) as string[]).slice();
      return { ok: true, value: "ok", transport: "dev" };
    }
    return invoke(data);
  };
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });
  await app.waitFor("nav-library");
  await openLibraryTab(app, "agents");
  await app.waitFor("id:agent-configure-Standard");
  expect(app.accessibility("id:agent-configure-Standard")).toMatchObject({ role: "button", label: "Standard" });
  await app.press("id:agent-configure-Standard");
  await app.press("agent-capability-skills");
  await app.waitFor("text:deploy");
  expect(app.shows("mode-skill-deploy")).toBe(false);
  await app.press("mode-skills-manage");
  await app.waitFor("mode-skill-deploy");
  await app.press("mode-skill-deploy");
  expect(replaced).toHaveLength(0);
  await app.press("mode-skills-cancel");
  await app.waitFor("Discard the unsaved changes to this agent's skills?");
  await app.press("Discard changes");
  await app.waitFor("mode-skills-manage");
  await app.waitFor("text:deploy");
  expect(replaced).toHaveLength(0);

  await app.press("mode-skills-manage");
  await app.press("mode-skill-deploy");
  await app.press("mode-skills-save");
  await app.waitUntil(() => replaced.length === 1);
  expect(replaced[0]).toMatchObject({ modeId: "Standard", enabledSkillKeys: ["review"] });
  await app.waitFor("Could not update the agent's skills: The device is busy");
  expect(app.enabled("mode-skills-save")).toBe(true);
  enabled.push("report");
  failSave = false;
  await app.press("mode-skills-save");
  await app.waitFor("mode-skills-manage");
  expect(replaced).toHaveLength(2);
  expect(replaced[1]).toMatchObject({ modeId: "Standard", enabledSkillKeys: ["review", "report"] });
  expect(app.shows("text:deploy")).toBe(false);
  await app.press("mode-skills-back");
  await app.waitFor("agent-capability-skills");
});

test("Agents and Skills switch to the compact layout at phone width and keep their primary action", async () => {
  const mock = createAgentsSkillsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });
  await showAllSessions(app, "NSH skeleton");

  await openLibraryTab(app, "agents");
  await app.waitFor("Reviewer");

  // At phone width the shell's sidebar is put away, as a phone user would, and the
  // Library keeps its tabs in a horizontal scroller above the hosted scene.
  await app.setViewport(390, 844);
  // The shell folds its sidebar away at phone width (or overlays it); make sure the scene is uncovered.
  if (app.shows("compact-drawer-scrim")) await app.press("compact-drawer-scrim");
  await app.waitFor("library-tabs-scroll");
  await app.waitFor("Primary agents");
  expect(app.texts()).toContain("Reviewer");
  expect(app.texts()).toContain("HelperSub");
  await app.press("agents-create-bot");
  await app.waitFor("builder-id-input");
  await app.press("agent-builder-close");
  await app.waitUntil(() => !app.shows("builder-id-input"));

  await app.press("library-tab-skills");
  await app.waitFor("Instructions and tools agents load when needed.");
  await app.waitFor("Code Reviewer");
  await app.press("label:skill-toggle-user::openbitfun::reviewer");
  await app.waitUntil(() => mock.callFor("set_global_skill_disabled").length > 0);
  await app.press("skills-install-folder-toggle");
  await app.waitFor("skill-folder-path-input");
  await app.press("skill-folder-close");
});

test("Agents and Skills follow the host's capability flags instead of their own source rules", async () => {
  const mock = createAgentsSkillsBackend({ skillConfigsShape: "array" });
  const invoke = mock.handlers["openbitfun.invoke"];
  // The host says the custom HelperSub is locked and the reviewer skill cannot be
  // toggled: the wave 4 flags win over the client's old source-based derivation.
  mock.handlers["openbitfun.invoke"] = async (data: unknown) => {
    const result = (await invoke(data)) as { ok?: boolean; value?: unknown };
    const action = (data as { action?: string }).action;
    if (result?.ok && Array.isArray(result.value)) {
      if (action === "list_subagents") {
        result.value = (result.value as Array<Record<string, unknown>>).map(row => ({
          ...row,
          canEdit: false,
          canDelete: false,
        }));
      }
      if (action === "get_skill_configs") {
        result.value = (result.value as Array<Record<string, unknown>>).map(row => ({
          ...row,
          canToggle: row.key !== "user::openbitfun::reviewer",
          canDelete: true,
        }));
      }
    }
    return result;
  };
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: mock.handlers } });
  await showAllSessions(app, "NSH skeleton");
  await openLibraryTab(app, "agents");
  await app.waitFor("HelperSub");
  await app.press("agent-actions-HelperSub");
  await app.waitFor("agent-menu-delete-HelperSub");
  expect(app.enabled("agent-menu-delete-HelperSub")).toBe(false);
  await app.keyboard.press("escape");

  await openLibraryTab(app, "skills");
  await app.waitFor("Code Reviewer");
  expect(app.enabled("label:skill-toggle-user::openbitfun::reviewer")).toBe(false);
});
