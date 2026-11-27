// State and backend operations for the Agents & Subagents Studio.
//
// Wire signatures follow the desktop Tauri command contracts:
// - `invokeCommand` wraps `{ request }` (agentic_api.rs, custom_agent_api.rs, subagent_api.rs)
// - `invokeRawCommand` sends positional top-level arguments (`list_agent_tool_names`,
//   `get_agent_profile_configs`, `set_agent_profile_config`, `reset_agent_profile_config`)

import { computed, signal } from "nsh";
import { reloadAgentModes } from "./agentModeStore";
import { readAgentToolMetadata, selectableToolNames as visibleToolNames, type ToolGroupMetadata } from "./agentToolGroups";
import { getConfig, setConfig } from "./api";
import { fleetDeviceContext, invokeCommand, invokeRawCommand } from "./bridge";
import { tr } from "./i18n";
import { skillsCatalogContextKey } from "./skillsCatalogStore";
import { activeWorkspace, activeWorkspaceId, activeWorkspaceRoot, startQuickPromptInSession } from "./state";

export type AgentKind = "mode" | "subagent";
export type AgentSource = "builtin" | "user" | "project" | "external";
export type AgentKindFilter = "all" | AgentKind;
export type AgentSourceFilter = "all" | AgentSource;
export type AgentBuilderMode = "create" | "edit-custom" | "configure-profile" | "configure-subagent" | "inspect-external";

export interface AgentCatalogItem {
  uid: string;
  id: string;
  kind: AgentKind;
  name: string;
  description: string;
  source: AgentSource;
  isReadonly: boolean;
  isReview: boolean;
  toolCount: number;
  defaultTools: string[];
  configProfileId: string;
  model: string | null;
  modelIsExplicit: boolean;
  effectiveEnabled: boolean;
  defaultEnabled?: boolean;
  path?: string;
  externalProviderLabel?: string;
  /** The host's verdict (wave 4); `undefined` on a host that predates the flag. */
  canEdit?: boolean;
  /** The host's verdict (wave 4); `undefined` on a host that predates the flag. */
  canDelete?: boolean;
}

export interface AgentBuilderDraft {
  mode: AgentBuilderMode;
  kind: AgentKind;
  level: "user" | "project";
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  readonly: boolean;
  model: string;
  enabled: boolean;
  parentAgentType: string;
  /** Whether the user picked a parent agent; availability is only written for a chosen one. */
  parentChosen?: boolean;
  source: AgentSource;
  path: string;
}

/**
 * A subagent's model choice as one token: "" (no override, the default
 * applies), "inherit", a model reference ("primary", "fast" or an `ai.models`
 * id) or `pool:<id>`. Built-ins store it as an `AgentModelTargetSelection`
 * under `ai.agent_model_selections.subagents.builtin.<id>`, custom subagents
 * as the `model` string `update_subagent_config` takes.
 */
export const POOL_TOKEN_PREFIX = "pool:";

export function modelSelectionToToken(selection: unknown): string {
  if (typeof selection === "string") return selection.trim();
  if (!selection || typeof selection !== "object") return "";
  const rec = selection as Record<string, unknown>;
  if (rec.kind === "inherit") return "inherit";
  if (rec.kind === "model" && typeof rec.model_ref === "string") return rec.model_ref.trim();
  if (rec.kind === "pool" && typeof rec.pool_id === "string") return `${POOL_TOKEN_PREFIX}${rec.pool_id}`;
  if (rec.kind === "fixed" && typeof rec.model_id === "string") return rec.model_id.trim();
  return "";
}

export function modelTokenToSelection(token: string): Record<string, string> | null {
  const value = token.trim();
  if (!value) return null;
  if (value === "inherit") return { kind: "inherit" };
  if (value.startsWith(POOL_TOKEN_PREFIX)) return { kind: "pool", pool_id: value.slice(POOL_TOKEN_PREFIX.length) };
  return { kind: "model", model_ref: value };
}

let initialRuntimeModel = "";
let initialRuntimeEnabled = true;

function emptyDraft(): AgentBuilderDraft {
  return {
    mode: "create",
    kind: "mode",
    level: "user",
    id: "",
    name: "",
    description: "",
    prompt: "",
    tools: [],
    readonly: false,
    model: "",
    enabled: true,
    parentAgentType: "Standard",
    source: "user",
    path: "",
  };
}

function normalizeSource(value: unknown): AgentSource {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "user" || raw === "project" || raw === "external" || raw === "builtin") {
    return raw;
  }
  return "builtin";
}

function readString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function readOptionalString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readBoolean(record: Record<string, unknown>, keys: string[], fallback = false): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return fallback;
}

function readStringArray(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  return [];
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function normalizeAgentRow(record: Record<string, unknown>, kind: AgentKind): AgentCatalogItem | null {
  const id = readString(record, ["id", "agentId", "subagentId"]);
  if (!id) return null;
  const defaultTools = readStringArray(record, ["defaultTools", "default_tools", "tools"]);
  const toolCount = readNumber(record, ["toolCount", "tool_count"]) ?? defaultTools.length;
  const source = normalizeSource(
    record.source ?? record.subagentSource ?? record.subagent_source,
  );
  return {
    uid: `${kind}:${id}`,
    id,
    kind,
    name: readString(record, ["name"]) || id,
    description: readString(record, ["description"]),
    source,
    isReadonly: readBoolean(record, ["isReadonly", "is_readonly", "readonly"], false),
    isReview: readBoolean(record, ["isReview", "is_review", "review"], false),
    toolCount,
    defaultTools,
    configProfileId: readString(record, ["configProfileId", "config_profile_id"]) || id,
    model: readOptionalString(record, ["model"]),
    modelIsExplicit: readBoolean(record, ["modelIsExplicit", "model_is_explicit"], false),
    effectiveEnabled: readBoolean(record, ["effectiveEnabled", "effective_enabled", "enabled"], true),
    defaultEnabled: typeof (record.defaultEnabled ?? record.default_enabled) === "boolean"
      ? Boolean(record.defaultEnabled ?? record.default_enabled)
      : undefined,
    path: readOptionalString(record, ["path"]) ?? undefined,
    externalProviderLabel:
      readOptionalString(record, ["externalProviderLabel", "external_provider_label"]) ?? undefined,
    canEdit: typeof record.canEdit === "boolean" ? record.canEdit : undefined,
    canDelete: typeof record.canDelete === "boolean" ? record.canDelete : undefined,
  };
}

export const agentsLoading = signal(false);
export const agentsCatalogError = signal<string | null>(null);
export const agentsNotice = signal<string | null>(null);
export const availableModes = signal<AgentCatalogItem[]>([]);
export const availableSubagents = signal<AgentCatalogItem[]>([]);
export const agentToolNames = signal<string[]>([]);
export const agentToolMetadata = signal<ReadonlyMap<string, ToolGroupMetadata>>(new Map());
export const toolCatalogError = signal<string | null>(null);
export const agentProfileConfigs = signal<Record<string, Record<string, unknown>>>({});
export const agentKindFilter = signal<AgentKindFilter>("all");
export const agentSourceFilter = signal<AgentSourceFilter>("all");
export const agentSearchQuery = signal("");
export const confirmDeleteAgentUid = signal<string | null>(null);
export const builderOpen = signal(false);
const inspectorScope = signal("");
export const agentInspectorScopeCurrent = computed(() => inspectorScope() === skillsCatalogContextKey());
export const builderLoading = signal(false);
export const builderSaving = signal(false);
export const builderError = signal<string | null>(null);
export const builderDraft = signal<AgentBuilderDraft>(emptyDraft());
export const agentsLoadedKey = signal<string | null>(null);
/** Tracks the initial model when editing a custom subagent so `update_subagent_config` runs only when changed. */
let initialEditModel = "";

export const allCatalogAgents = computed<AgentCatalogItem[]>(() => [
  ...availableModes(),
  ...availableSubagents(),
]);

export const pendingDeleteAgent = computed<AgentCatalogItem | null>(
  () => allCatalogAgents().find(item => item.uid === confirmDeleteAgentUid()) ?? null,
);

export const filteredAgents = computed<AgentCatalogItem[]>(() => {
  const kind = agentKindFilter();
  const source = agentSourceFilter();
  const query = agentSearchQuery().trim().toLowerCase();
  return allCatalogAgents().filter(item => {
    if (kind !== "all" && item.kind !== kind) return false;
    if (source !== "all" && item.source !== source) return false;
    if (!query) return true;
    const haystack = `${item.id} ${item.name} ${item.description} ${item.model ?? ""} ${item.source}`.toLowerCase();
    return haystack.includes(query);
  });
});

export const selectableToolNames = computed(() => visibleToolNames([...agentToolNames(), ...builderDraft().tools]));

export function isRemoteAgentWorkspace(): boolean {
  return activeWorkspace()?.workspaceKind === "remote";
}

export function canMutateCustomAgents(): boolean {
  return !isRemoteAgentWorkspace();
}

export function isCustomSource(source: AgentSource): boolean {
  return source === "user" || source === "project";
}

/** Whether this agent's definition can be edited from here (host decision). */
export function agentCanEdit(item: AgentCatalogItem): boolean {
  return item.canEdit === true;
}

/** Whether this agent can be deleted from here (host decision). */
export function agentCanDelete(item: AgentCatalogItem): boolean {
  return item.canDelete === true;
}

export function effectiveToolsForAgent(item: AgentCatalogItem): string[] {
  if (item.kind === "mode") {
    const configs = agentProfileConfigs();
    const profile = configs[item.configProfileId] ?? configs[item.id];
    if (profile) {
      const configured = readStringArray(profile, ["enabled_tools", "enabledTools"]);
      if (configured.length > 0 || Array.isArray(profile.enabled_tools) || Array.isArray(profile.enabledTools)) {
        return configured;
      }
    }
  }
  return item.defaultTools;
}

export function effectiveToolCountForAgent(item: AgentCatalogItem): number {
  if (item.kind === "mode") {
    const configs = agentProfileConfigs();
    const profile = configs[item.configProfileId] ?? configs[item.id];
    if (profile && (Array.isArray(profile.enabled_tools) || Array.isArray(profile.enabledTools))) {
      return readStringArray(profile, ["enabled_tools", "enabledTools"]).length;
    }
  }
  return item.defaultTools.length > 0 ? item.defaultTools.length : item.toolCount;
}

let catalogLoadTicket = 0;

export async function loadAgentsCatalog(contextKey?: string): Promise<void> {
  const ticket = ++catalogLoadTicket;
  const workspace = activeWorkspace();
  const workspaceId = workspace?.id ?? activeWorkspaceId() ?? undefined;
  const workspacePath = workspace?.rootPath || activeWorkspaceRoot() || undefined;
  const key = contextKey ?? `local:${workspaceId ?? "none"}:${workspacePath ?? ""}`;

  agentsLoading.set(true);
  agentsCatalogError.set(null);
  toolCatalogError.set(null);
  confirmDeleteAgentUid.set(null);

  const target = fleetDeviceContext();
  const [modesRes, subagentsRes, toolsRes, profilesRes, metadataRes] = await Promise.allSettled([
    invokeCommand<Array<Record<string, unknown>>>("get_available_modes", {
      workspaceId,
      ...(workspacePath ? { workspacePath } : {}),
    }),
    invokeCommand<Array<Record<string, unknown>>>("list_subagents", {
      workspaceId,
      ...(workspacePath ? { workspacePath } : {}),
    }),
    invokeRawCommand<string[]>("list_agent_tool_names", {}),
    invokeRawCommand<Record<string, Record<string, unknown>>>("get_agent_profile_configs", {}),
    readAgentToolMetadata(target),
  ]);

  if (ticket !== catalogLoadTicket) return;

  const errors: string[] = [];
  if (modesRes.status === "fulfilled") {
    const rows = Array.isArray(modesRes.value) ? modesRes.value : [];
    availableModes.set(
      rows
        .map(row => normalizeAgentRow(row ?? {}, "mode"))
        .filter((item): item is AgentCatalogItem => item !== null),
    );
  } else {
    availableModes.set([]);
    errors.push(modesRes.reason instanceof Error ? modesRes.reason.message : String(modesRes.reason));
  }

  if (subagentsRes.status === "fulfilled") {
    const rows = Array.isArray(subagentsRes.value) ? subagentsRes.value : [];
    availableSubagents.set(
      rows
        .map(row => normalizeAgentRow(row ?? {}, "subagent"))
        .filter((item): item is AgentCatalogItem => item !== null),
    );
  } else {
    availableSubagents.set([]);
    errors.push(subagentsRes.reason instanceof Error ? subagentsRes.reason.message : String(subagentsRes.reason));
  }

  const names = toolsRes.status === "fulfilled" && Array.isArray(toolsRes.value)
    ? toolsRes.value.filter((name): name is string => typeof name === "string") : [];
  const metadata = metadataRes.status === "fulfilled" ? metadataRes.value : new Map<string, ToolGroupMetadata>();
  agentToolMetadata.set(metadata);
  agentToolNames.set(visibleToolNames([...names, ...metadata.keys()]));
  if (toolsRes.status === "rejected" && metadataRes.status === "rejected") {
    toolCatalogError.set(toolsRes.reason instanceof Error ? toolsRes.reason.message : String(toolsRes.reason));
  }

  if (profilesRes.status === "fulfilled" && profilesRes.value && typeof profilesRes.value === "object") {
    agentProfileConfigs.set(profilesRes.value);
  } else if (profilesRes.status === "rejected") {
    agentProfileConfigs.set({});
  }

  if (modesRes.status === "rejected" && subagentsRes.status === "rejected") {
    agentsCatalogError.set(errors.join(" | "));
  } else if (errors.length > 0) {
    agentsNotice.set(errors.join(" | "));
  }

  agentsLoadedKey.set(key);
  agentsLoading.set(false);
}

export async function reloadAgentsCatalog(): Promise<void> {
  const workspace = activeWorkspace();
  const workspaceId = workspace?.id ?? activeWorkspaceId() ?? undefined;
  agentsNotice.set(null);

  if (workspace?.workspaceKind !== "remote") {
    await Promise.allSettled([
      invokeCommand<unknown>("reload_custom_agents", {
        ...(workspaceId ? { workspaceId } : {}),
      }),
      ...(workspaceId
        ? [invokeCommand<unknown>("reload_subagents", { workspaceId })]
        : []),
    ]);
  }
  await loadAgentsCatalog();
  reloadAgentModes();
  if (!agentsCatalogError()) {
    agentsNotice.set(tr("agents.store.reloaded"));
  }
}

export function startThreadWithMode(modeId: string): void {
  void startQuickPromptInSession("", modeId);
}

export function closeBuilder(): void {
  builderOpen.set(false);
  builderLoading.set(false);
  builderSaving.set(false);
  builderError.set(null);
}

export function openCreateBotBuilder(defaultKind: AgentKind = "mode"): void {
  if (isRemoteAgentWorkspace()) {
    agentsNotice.set(tr("agents.store.createRemote"));
    return;
  }
  inspectorScope.set(skillsCatalogContextKey());
  confirmDeleteAgentUid.set(null);
  const availableTools = agentToolNames();
  const initialTools = defaultKind === "mode"
    ? availableTools.slice(0, Math.min(8, availableTools.length))
    : ["LS", "Read", "Glob", "Grep"].filter(tool => availableTools.length === 0 || availableTools.includes(tool));
  builderError.set(null);
  builderLoading.set(false);
  builderSaving.set(false);
  builderDraft.set({
    mode: "create",
    kind: defaultKind,
    level: "user",
    id: "",
    name: "",
    description: "",
    prompt: "",
    tools: initialTools,
    readonly: defaultKind === "subagent",
    model: "",
    enabled: true,
    parentAgentType: availableModes()[0]?.id ?? "Standard",
    source: "user",
    path: "",
  });
  builderOpen.set(true);
}

export function updateBuilderDraft(patch: Partial<AgentBuilderDraft>): void {
  builderDraft.update(current => {
    const next = { ...current, ...patch };
    if (patch.kind === "mode" && next.mode === "create") {
      next.level = "user";
    }
    return next;
  });
}

export async function openAgentInspector(item: AgentCatalogItem): Promise<void> {
  const workspaceId = activeWorkspaceId() ?? undefined;
  inspectorScope.set(skillsCatalogContextKey());
  confirmDeleteAgentUid.set(null);
  builderError.set(null);
  builderSaving.set(false);
  builderOpen.set(true);
  // A primary agent's builder also lists which subagents it may call.
  if (item.kind === "mode" && item.source !== "external") {
    void loadParentSubagents(item.id);
    // The desktop reads an agent's skills only when it can call the Skill tool.
    if (effectiveToolsForAgent(item).includes("Skill")) {
      void loadModeSkills(item.id);
    } else {
      modeSkillsFor.set(null);
      modeSkills.set([]);
    }
  } else {
    modeSkillsFor.set(null);
    modeSkills.set([]);
    parentSubagentsFor.set(null);
    parentSubagents.set([]);
  }

  if (item.source === "external") {
    builderLoading.set(false);
    builderDraft.set({
      mode: "inspect-external",
      kind: item.kind,
      level: "user",
      id: item.id,
      name: item.name,
      description: item.description,
      prompt: "",
      tools: [...item.defaultTools],
      readonly: item.isReadonly,
      model: item.model ?? "",
      enabled: item.effectiveEnabled,
      parentAgentType: availableModes()[0]?.id ?? "Standard",
      source: item.source,
      path: item.path ?? "",
    });
    return;
  }

  if (item.kind === "mode" && item.source === "builtin") {
    builderLoading.set(false);
    const tools = effectiveToolsForAgent(item);
    builderDraft.set({
      mode: "configure-profile",
      kind: "mode",
      level: "user",
      id: item.id,
      name: item.name,
      description: item.description,
      prompt: "",
      tools: [...tools],
      readonly: item.isReadonly,
      model: item.model ?? "",
      enabled: true,
      parentAgentType: item.id,
      source: "builtin",
      path: item.path ?? "",
    });
    return;
  }

  if (item.kind === "subagent" && item.source === "builtin") {
    builderLoading.set(false);
    initialRuntimeModel = (item.model ?? "").trim();
    initialRuntimeEnabled = item.effectiveEnabled;
    // The stored selection is the truth for a built-in (a pool has no model string).
    void getConfig(`ai.agent_model_selections.subagents.builtin.${item.id}`, true)
      .then(selection => {
        const draft = builderDraft();
        if (draft.mode !== "configure-subagent" || draft.id !== item.id) return;
        const token = modelSelectionToToken(selection);
        initialRuntimeModel = token;
        builderDraft.update(current => ({ ...current, model: token }));
      })
      .catch(() => undefined);
    builderDraft.set({
      mode: "configure-subagent",
      kind: "subagent",
      level: "user",
      id: item.id,
      name: item.name,
      description: item.description,
      prompt: "",
      tools: [...item.defaultTools],
      readonly: item.isReadonly,
      model: item.model ?? "",
      enabled: item.effectiveEnabled,
      parentAgentType: availableModes()[0]?.id ?? "Standard",
      source: "builtin",
      path: item.path ?? "",
    });
    return;
  }

  if (isRemoteAgentWorkspace()) {
    builderLoading.set(false);
    builderDraft.set({
      mode: "inspect-external",
      kind: item.kind,
      level: item.source === "project" ? "project" : "user",
      id: item.id,
      name: item.name,
      description: item.description,
      prompt: "",
      tools: [...item.defaultTools],
      readonly: item.isReadonly,
      model: item.model ?? "",
      enabled: item.effectiveEnabled,
      parentAgentType: availableModes()[0]?.id ?? "Standard",
      source: item.source,
      path: item.path ?? "",
    });
    builderError.set(tr("agents.store.inspectRemote"));
    return;
  }

  builderLoading.set(true);
  initialEditModel = item.kind === "subagent" ? (item.model ?? "").trim() : "";
  initialRuntimeModel = initialEditModel;
  initialRuntimeEnabled = item.effectiveEnabled;
  builderDraft.set({
    mode: "edit-custom",
    kind: item.kind,
    level: item.source === "project" ? "project" : "user",
    id: item.id,
    name: item.name,
    description: item.description,
    prompt: "",
    tools: [...item.defaultTools],
    readonly: item.isReadonly,
    model: item.model ?? "",
    enabled: item.effectiveEnabled,
    parentAgentType: availableModes()[0]?.id ?? "Standard",
    source: item.source,
    path: item.path ?? "",
  });

  try {
    if (item.kind === "mode") {
      const detail = await invokeCommand<Record<string, unknown>>("get_custom_agent_detail", {
        agentId: item.id,
        ...(workspaceId ? { workspaceId } : {}),
      });
      const tools = readStringArray(detail, ["tools", "defaultTools"]);
      builderDraft.update(current => ({
        ...current,
        id: readString(detail, ["agentId", "id"]) || current.id,
        name: readString(detail, ["name"]) || current.name,
        description: readString(detail, ["description"]) || current.description,
        prompt: readString(detail, ["prompt"]),
        tools: tools.length > 0 ? tools : current.tools,
        readonly: readBoolean(detail, ["readonly", "isReadonly"], current.readonly),
        model: readOptionalString(detail, ["model"]) ?? current.model,
        level: readString(detail, ["level"]) === "project" ? "project" : "user",
        path: readString(detail, ["path"]) || current.path,
      }));
    } else {
      const detail = await invokeCommand<Record<string, unknown>>("get_subagent_detail", {
        subagentId: item.id,
        ...(workspaceId ? { workspaceId } : {}),
      });
      const tools = readStringArray(detail, ["tools", "defaultTools"]);
      const loadedModel = (readOptionalString(detail, ["model"]) ?? item.model ?? "").trim();
      initialEditModel = loadedModel;
      initialRuntimeModel = loadedModel;
      builderDraft.update(current => ({
        ...current,
        id: readString(detail, ["subagentId", "agentId", "id"]) || current.id,
        name: readString(detail, ["name"]) || current.name,
        description: readString(detail, ["description"]) || current.description,
        prompt: readString(detail, ["prompt"]),
        tools: tools.length > 0 ? tools : current.tools,
        readonly: readBoolean(detail, ["readonly", "isReadonly"], current.readonly),
        model: loadedModel,
        enabled: readBoolean(detail, ["enabled", "effectiveEnabled"], current.enabled),
        level: readString(detail, ["level"]) === "project" ? "project" : "user",
        path: readString(detail, ["path"]) || current.path,
      }));
    }
  } catch (error) {
    builderError.set(error instanceof Error ? error.message : String(error));
  } finally {
    builderLoading.set(false);
  }
}

export async function saveBuilderBot(): Promise<void> {
  const draft = builderDraft();
  const workspaceId = activeWorkspaceId() ?? undefined;
  builderError.set(null);

  if (isRemoteAgentWorkspace()) {
    builderError.set(tr("agents.store.manageRemote"));
    return;
  }

  const trimmedId = draft.id.trim();
  const trimmedName = draft.name.trim() || trimmedId;
  const resolvedId = trimmedId || trimmedName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const trimmedDesc = draft.description.trim();
  const trimmedPrompt = draft.prompt.trim();
  const trimmedModel = draft.model.trim();

  if (draft.mode === "create" && !resolvedId) {
    builderError.set(tr("agents.store.idRequired"));
    return;
  }
  if (!trimmedName) {
    builderError.set(tr("agents.store.nameRequired"));
    return;
  }
  if (!trimmedDesc) {
    builderError.set(tr("agents.store.descriptionRequired"));
    return;
  }
  if (!trimmedPrompt) {
    builderError.set(tr("agents.store.promptRequired"));
    return;
  }
  if (draft.kind === "subagent" && draft.level === "project" && !workspaceId) {
    builderError.set(tr("agents.store.projectNeedsWorkspace"));
    return;
  }

  builderSaving.set(true);
  try {
    if (draft.mode === "create") {
      if (draft.kind === "mode") {
        await invokeCommand<unknown>("create_custom_agent", {
          kind: "mode",
          level: draft.level,
          id: resolvedId,
          name: trimmedName,
          description: trimmedDesc,
          prompt: trimmedPrompt,
          tools: draft.tools,
          readonly: draft.readonly,
          model: trimmedModel || null,
          ...(workspaceId ? { workspaceId } : {}),
        });
      } else {
        // Real Rust `create_subagent` (`subagent_api.rs`) derives the subagent
        // ID from `name.to_lowercase()` (writing `<name.to_lowercase()>.md`),
        // so pass that canonical ID to both `create_subagent` and the follow-up
        // `update_subagent_config`.
        const subagentId = trimmedName.toLowerCase();
        await invokeCommand<unknown>("create_subagent", {
          level: draft.level,
          id: subagentId,
          name: trimmedName,
          description: trimmedDesc,
          prompt: trimmedPrompt,
          tools: draft.tools,
          readonly: draft.readonly,
          ...(workspaceId ? { workspaceId } : {}),
        });
        // Real Rust `CreateSubagentRequest` has no `model` field; subagent
        // model overrides are persisted via `update_subagent_config`.
        if (trimmedModel) {
          await invokeCommand<unknown>("update_subagent_config", {
            subagentId,
            model: trimmedModel,
            ...(workspaceId ? { workspaceId } : {}),
          });
        }
      }
      agentsNotice.set(
        draft.kind === "mode"
          ? tr("agents.store.createdMode", { name: trimmedName })
          : tr("agents.store.createdSubagent", { name: trimmedName }),
      );
    } else if (draft.mode === "edit-custom") {
      let noticeName = trimmedName;
      if (draft.kind === "mode") {
        await invokeCommand<unknown>("update_custom_agent", {
          agentId: draft.id,
          name: trimmedName,
          description: trimmedDesc,
          prompt: trimmedPrompt,
          tools: draft.tools,
          readonly: draft.readonly,
          model: trimmedModel || null,
          ...(workspaceId ? { workspaceId } : {}),
        });
      } else {
        // Real Rust `UpdateSubagentRequest` has no `name` field (a subagent's
        // filename/ID is immutable); omit ignored `name` and keep its persisted name.
        const existingSubagent = availableSubagents().find(item => item.id === draft.id);
        noticeName = existingSubagent?.name || draft.id;
        await invokeCommand<unknown>("update_subagent", {
          subagentId: draft.id,
          description: trimmedDesc,
          prompt: trimmedPrompt,
          tools: draft.tools,
          readonly: draft.readonly,
          ...(workspaceId ? { workspaceId } : {}),
        });
        // Real Rust `UpdateSubagentRequest` has no `model` field; persist
        // model changes (or clears) through `update_subagent_config`.
        if (trimmedModel !== initialEditModel) {
          await invokeCommand<unknown>("update_subagent_config", {
            subagentId: draft.id,
            ...(trimmedModel ? { model: trimmedModel } : { clearModelOverride: true }),
            ...(workspaceId ? { workspaceId } : {}),
          });
          initialEditModel = trimmedModel;
        }
      }
      agentsNotice.set(tr("agents.store.updated", { name: noticeName }));
    }
    builderOpen.set(false);
    await loadAgentsCatalog();
    reloadAgentModes();
  } catch (error) {
    builderError.set(error instanceof Error ? error.message : String(error));
  } finally {
    builderSaving.set(false);
  }
}

function canWriteProfileTools(): boolean {
  return builderDraft().mode === "configure-profile" && agentInspectorScopeCurrent() &&
    !builderSaving() && !isRemoteAgentWorkspace() && !toolCatalogError();
}

async function refreshProfileTools(agentId: string, scope: string): Promise<void> {
  await loadAgentsCatalog(scope);
  if (scope !== skillsCatalogContextKey() || builderDraft().id !== agentId) return;
  const refreshed = availableModes().find(item => item.id === agentId);
  if (refreshed) {
    const tools = [...effectiveToolsForAgent(refreshed)];
    builderDraft.update(current => ({ ...current, tools }));
    if (tools.includes("Skill") && modeSkillsFor() !== agentId) void loadModeSkills(agentId);
    if (!tools.includes("Skill")) {
      modeSkillsFor.set(null);
      modeSkills.set([]);
    }
  }
  reloadAgentModes();
}

export async function saveProfileToolSelection(changes: ReadonlyMap<string, boolean>): Promise<boolean> {
  const draft = builderDraft();
  if (!canWriteProfileTools()) return false;
  const scope = skillsCatalogContextKey();
  const target = fleetDeviceContext();
  const current = () => scope === skillsCatalogContextKey() && builderOpen() && builderDraft().id === draft.id;
  builderError.set(null);
  builderSaving.set(true);
  try {
    const configs = await invokeRawCommand<Record<string, Record<string, unknown>>>("get_agent_profile_configs", {}, { target });
    if (!current()) return false;
    if (!configs || typeof configs !== "object" || Array.isArray(configs)) {
      throw new Error(tr("agents.toolPermissionsCatalogUnavailable"));
    }
    const modeItem = availableModes().find(item => item.id === draft.id);
    const profileKey = modeItem?.configProfileId || draft.id;
    const existing = configs[profileKey] ?? configs[draft.id] ?? {};
    const selected = new Set(Array.isArray(existing.enabled_tools) || Array.isArray(existing.enabledTools)
      ? readStringArray(existing, ["enabled_tools", "enabledTools"])
      : modeItem?.defaultTools ?? draft.tools);
    for (const [tool, enabled] of changes) {
      if (enabled) selected.add(tool);
      else selected.delete(tool);
    }
    const config = {
      ...existing,
      profile_id: (existing.profile_id as string | undefined) ?? profileKey,
      default_tools: (existing.default_tools as string[] | undefined) ?? modeItem?.defaultTools ?? [],
      enabled_tools: [...selected],
    };
    await invokeRawCommand<unknown>("set_agent_profile_config", {
      agentId: draft.id,
      config,
    }, { target });
    if (!current()) return false;
    builderDraft.update(value => ({ ...value, tools: [...selected] }));
    agentsNotice.set(tr("agents.store.profileSaved", { name: draft.name }));
    await refreshProfileTools(draft.id, scope);
    return current();
  } catch (error) {
    if (current()) builderError.set(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    builderSaving.set(false);
  }
}

export async function resetProfileConfig(): Promise<void> {
  const draft = builderDraft();
  if (!canWriteProfileTools()) return;
  const scope = skillsCatalogContextKey();
  const target = fleetDeviceContext();
  const current = () => scope === skillsCatalogContextKey() && builderOpen() && builderDraft().id === draft.id;
  builderError.set(null);
  builderSaving.set(true);
  try {
    await invokeRawCommand<unknown>("reset_agent_profile_config", {
      agentId: draft.id,
    }, { target });
    if (!current()) return;
    await refreshProfileTools(draft.id, scope);
    if (!current()) return;
    agentsNotice.set(tr("agents.store.profileReset", { name: draft.name }));
  } catch (error) {
    if (current()) builderError.set(error instanceof Error ? error.message : String(error));
  } finally {
    builderSaving.set(false);
  }
}

export async function saveSubagentRuntimeConfig(): Promise<void> {
  const draft = builderDraft();
  if (draft.kind !== "subagent") return;
  const workspaceId = activeWorkspaceId() ?? undefined;
  if (isRemoteAgentWorkspace()) {
    builderError.set(tr("agents.subagentRemoteUnsupported"));
    return;
  }
  const token = draft.model.trim();
  const modelChanged = token !== initialRuntimeModel;
  const availabilityChanged = Boolean(draft.parentChosen) || draft.enabled !== initialRuntimeEnabled;
  if (availabilityChanged && !draft.parentChosen) {
    // The host scopes availability to one parent agent; it never guesses one.
    builderError.set(tr("agents.chooseParentFirst"));
    return;
  }
  if (!modelChanged && !availabilityChanged) {
    agentsNotice.set(tr("agents.runtimeNothingChanged"));
    return;
  }
  const isBuiltin = draft.source === "builtin";
  if (modelChanged && token.startsWith(POOL_TOKEN_PREFIX) && !isBuiltin) {
    builderError.set(tr("agents.poolUnsupportedForAgent"));
    return;
  }
  builderError.set(null);
  builderSaving.set(true);
  try {
    if (availabilityChanged) {
      await invokeCommand<unknown>("update_subagent_config", {
        subagentId: draft.id,
        enabled: draft.enabled,
        parentAgentType: draft.parentAgentType,
        ...(workspaceId ? { workspaceId } : {}),
      });
      initialRuntimeEnabled = draft.enabled;
    }
    if (modelChanged) {
      if (isBuiltin) {
        await setConfig(
          `ai.agent_model_selections.subagents.builtin.${draft.id}`,
          modelTokenToSelection(token),
        );
      } else {
        await invokeCommand<unknown>("update_subagent_config", {
          subagentId: draft.id,
          ...(token ? { model: token } : { clearModelOverride: true }),
          ...(workspaceId ? { workspaceId } : {}),
        });
      }
      initialRuntimeModel = token;
    }
    agentsNotice.set(tr("agents.runtimeUpdated", { name: draft.name }));
    await loadAgentsCatalog();
  } catch (error) {
    builderError.set(error instanceof Error ? error.message : String(error));
  } finally {
    builderSaving.set(false);
  }
}

export async function deleteCatalogAgent(item: AgentCatalogItem): Promise<void> {
  if (!isCustomSource(item.source)) return;
  if (!agentCanDelete(item)) {
    agentsNotice.set(tr("agents.store.deleteRemote"));
    return;
  }
  const workspaceId = activeWorkspaceId() ?? undefined;
  agentsNotice.set(null);
  try {
    if (item.kind === "mode") {
      await invokeCommand<unknown>("delete_custom_agent", {
        agentId: item.id,
        ...(workspaceId ? { workspaceId } : {}),
      });
    } else {
      await invokeCommand<unknown>("delete_subagent", {
        subagentId: item.id,
        ...(workspaceId ? { workspaceId } : {}),
      });
    }
    confirmDeleteAgentUid.set(null);
    if (builderOpen() && builderDraft().id === item.id && builderDraft().kind === item.kind) {
      closeBuilder();
    }
    agentsNotice.set(tr("agents.store.deleted", { name: item.name }));
    await loadAgentsCatalog();
    reloadAgentModes();
  } catch (error) {
    agentsNotice.set(error instanceof Error ? error.message : String(error));
  }
}

// --- Per-parent subagent availability ---

export const parentSubagents = signal<AgentCatalogItem[]>([]);
export const parentSubagentsFor = signal<string | null>(null);
export const parentSubagentsLoading = signal(false);
export const parentSubagentsError = signal<string | null>(null);
export const parentSubagentsSaving = signal(false);
const parentSubagentScope = signal("");
export const parentSubagentsScopeCurrent = computed(() => parentSubagentScope() === skillsCatalogContextKey());
let parentSubagentsTicket = 0;

async function readParentSubagents(parentAgentType: string, workspaceId: string | undefined, target: string | null) {
  const rows = await invokeCommand<Array<Record<string, unknown>>>("list_manageable_subagents", {
    parentAgentType,
    ...(workspaceId ? { workspaceId } : {}),
  }, { target });
  return (Array.isArray(rows) ? rows : [])
    .map(row => normalizeAgentRow(row ?? {}, "subagent"))
    .filter((item): item is AgentCatalogItem => item !== null);
}

export async function loadParentSubagents(parentAgentType: string): Promise<void> {
  const ticket = ++parentSubagentsTicket;
  const scope = skillsCatalogContextKey();
  const target = fleetDeviceContext();
  const workspaceId = activeWorkspaceId() ?? undefined;
  const current = () => ticket === parentSubagentsTicket && scope === skillsCatalogContextKey();
  if (parentSubagentsFor() !== parentAgentType || parentSubagentScope() !== scope) parentSubagents.set([]);
  parentSubagentScope.set(scope);
  parentSubagentsFor.set(parentAgentType);
  parentSubagentsLoading.set(true);
  parentSubagentsError.set(null);
  try {
    const rows = await readParentSubagents(parentAgentType, workspaceId, target);
    if (current()) parentSubagents.set(rows);
  } catch (error) {
    if (current()) {
      parentSubagents.set([]);
      parentSubagentsError.set(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (ticket === parentSubagentsTicket) parentSubagentsLoading.set(false);
  }
}

/** The host writes individual subagents. Keep only changes it has yet to acknowledge. */
export async function saveParentSubagentSelection(
  parentAgentType: string,
  changes: ReadonlyMap<string, boolean>,
): Promise<ReadonlyMap<string, boolean> | null> {
  if (parentSubagentsSaving() || parentSubagentsLoading() || !parentSubagentsScopeCurrent() ||
    parentSubagentsFor() !== parentAgentType || isRemoteAgentWorkspace()) return null;
  const scope = skillsCatalogContextKey();
  const target = fleetDeviceContext();
  const workspaceId = activeWorkspaceId() ?? undefined;
  const current = () => scope === skillsCatalogContextKey() && parentSubagentsFor() === parentAgentType;
  const remaining = new Map(changes);
  parentSubagentsSaving.set(true);
  parentSubagentsError.set(null);
  try {
    let failure: string | null = null;
    try {
      const rows = await readParentSubagents(parentAgentType, workspaceId, target);
      const byId = new Map(rows.map(row => [row.id, row]));
      for (const [subagentId, enabled] of changes) {
        if (!current()) return null;
        const row = byId.get(subagentId);
        if (!row || row.source === "external") throw new Error(tr("agents.subagentSelectionUnavailable"));
        if (row.effectiveEnabled !== enabled) {
          await invokeCommand("update_subagent_config", {
            subagentId, parentAgentType, enabled,
            ...(workspaceId ? { workspaceId } : {}),
          }, { target });
        }
        remaining.delete(subagentId);
      }
    } catch (error) {
      failure = tr("agents.subagentToggleFailed", { error: error instanceof Error ? error.message : String(error) });
    }
    if (!current()) return null;
    await loadParentSubagents(parentAgentType);
    if (!current()) return null;
    const partlyApplied = remaining.size < changes.size;
    if (failure) parentSubagentsError.set(partlyApplied ? tr("agents.subagentPartialSave", { error: failure }) : failure);
    if (partlyApplied) reloadAgentModes();
    return remaining;
  } finally {
    parentSubagentsSaving.set(false);
  }
}

// --- Per-agent skill selection (get_mode_skill_configs / replace / reset) ---

export interface ModeSkillRow {
  key: string;
  name: string;
  description: string;
  isBuiltin: boolean;
  groupKey: string;
  sourceLabel: string;
  effectiveEnabled: boolean;
  globallyEnabled: boolean;
}

export const modeSkills = signal<ModeSkillRow[]>([]);
export const modeSkillsFor = signal<string | null>(null);
export const modeSkillsLoading = signal(false);
export const modeSkillsError = signal<string | null>(null);
export const modeSkillsSaving = signal(false);
const modeSkillsScope = signal("");
export const modeSkillsScopeCurrent = computed(() => modeSkillsScope() === skillsCatalogContextKey());
let modeSkillsTicket = 0;

function readModeSkill(raw: unknown): ModeSkillRow | null {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!rec) return null;
  const key = readString(rec, ["key", "skillKey", "skill_key"]);
  if (!key) return null;
  return {
    key,
    name: readString(rec, ["name"]) || key,
    description: readString(rec, ["description"]),
    isBuiltin: readBoolean(rec, ["isBuiltin", "is_builtin"]),
    groupKey: readString(rec, ["groupKey", "group_key"]),
    sourceLabel: readString(rec, ["sourceLabel", "source_label"]),
    effectiveEnabled: readBoolean(rec, ["effectiveEnabled", "effective_enabled"], false),
    globallyEnabled: readBoolean(rec, ["globallyEnabled", "globally_enabled"], true),
  };
}

async function readModeSkillRows(modeId: string, workspace: ReturnType<typeof activeWorkspace>, target: string | null): Promise<ModeSkillRow[]> {
  const raw = await invokeRawCommand<unknown>("get_mode_skill_configs", {
    modeId,
    workspaceId: workspace?.id ?? null,
    workspacePath: workspace?.rootPath || null,
  }, { target });
  const list = Array.isArray(raw) ? raw : (raw as { skills?: unknown } | null)?.skills;
  return Array.isArray(list) ? list.map(readModeSkill).filter((row): row is ModeSkillRow => row !== null) : [];
}

/** Reads which skills one agent runs with (`get_mode_skill_configs`, positional). */
export async function loadModeSkills(modeId: string): Promise<void> {
  const ticket = ++modeSkillsTicket;
  const workspace = activeWorkspace();
  const scope = skillsCatalogContextKey();
  const target = fleetDeviceContext();
  const current = () => ticket === modeSkillsTicket && scope === skillsCatalogContextKey();
  if (modeSkillsFor() !== modeId || modeSkillsScope() !== scope) modeSkills.set([]);
  modeSkillsScope.set(scope);
  modeSkillsFor.set(modeId);
  modeSkillsLoading.set(true);
  modeSkillsError.set(null);
  try {
    const rows = await readModeSkillRows(modeId, workspace, target);
    if (!current()) return;
    modeSkills.set(rows);
  } catch (error) {
    if (!current()) return;
    modeSkills.set([]);
    modeSkillsError.set(error instanceof Error ? error.message : String(error));
  } finally {
    if (ticket === modeSkillsTicket) modeSkillsLoading.set(false);
  }
}

/** Applies the draft to the current host selection and submits one replacement. */
export async function saveModeSkillSelection(modeId: string, changes: ReadonlyMap<string, boolean>): Promise<boolean> {
  if (modeSkillsSaving() || modeSkillsLoading() || !modeSkillsScopeCurrent() || modeSkillsFor() !== modeId || isRemoteAgentWorkspace()) return false;
  const scope = skillsCatalogContextKey();
  const target = fleetDeviceContext();
  const workspace = activeWorkspace();
  const workspaceId = activeWorkspaceId() ?? undefined;
  const current = () => scope === skillsCatalogContextKey() && modeSkillsFor() === modeId;
  modeSkillsSaving.set(true);
  modeSkillsError.set(null);
  try {
    const rows = await readModeSkillRows(modeId, workspace, target);
    if (!current()) return false;
    const selected = (row: ModeSkillRow) => (row.globallyEnabled ? changes.get(row.key) : undefined) ?? row.effectiveEnabled;
    if (!rows.some(row => selected(row) !== row.effectiveEnabled)) {
      modeSkills.set(rows);
      return true;
    }
    const enabledSkillKeys = rows.filter(selected).map(row => row.key);
    await invokeCommand<unknown>("replace_mode_skill_selection", {
      modeId,
      enabledSkillKeys,
      ...(workspaceId ? { workspaceId } : {}),
    }, { target });
    if (!current()) return false;
    await loadModeSkills(modeId);
    if (!current()) return false;
    reloadAgentModes();
    return true;
  } catch (error) {
    if (current()) {
      modeSkillsError.set(
        tr("agents.modeSkillsFailed", { error: error instanceof Error ? error.message : String(error) }),
      );
    }
    return false;
  } finally {
    modeSkillsSaving.set(false);
  }
}

export async function resetModeSkills(modeId: string): Promise<void> {
  if (modeSkillsSaving() || !modeSkillsScopeCurrent() || modeSkillsFor() !== modeId || isRemoteAgentWorkspace()) return;
  const scope = skillsCatalogContextKey();
  const target = fleetDeviceContext();
  const workspaceId = activeWorkspaceId() ?? undefined;
  modeSkillsSaving.set(true);
  modeSkillsError.set(null);
  try {
    await invokeCommand<unknown>("reset_mode_skill_selection", {
      modeId,
      ...(workspaceId ? { workspaceId } : {}),
    }, { target });
    if (scope !== skillsCatalogContextKey() || modeSkillsFor() !== modeId) return;
    await loadModeSkills(modeId);
    reloadAgentModes();
  } catch (error) {
    if (scope !== skillsCatalogContextKey() || modeSkillsFor() !== modeId) return;
    modeSkillsError.set(
      tr("agents.modeSkillsFailed", { error: error instanceof Error ? error.message : String(error) }),
    );
  } finally {
    modeSkillsSaving.set(false);
  }
}
