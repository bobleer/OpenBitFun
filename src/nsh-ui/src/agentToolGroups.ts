import { invokeCommand, invokeRawCommand } from "./bridge";
import { tr } from "./i18n";

const configPath = "app.user_tool_groups";
const configVersion = 1;
const internalTools = new Set(["GetToolSpec", "CallDeferredTool"]);

export interface UserToolGroup {
  id: string;
  name: string;
  toolNames: string[];
  [field: string]: unknown;
}

interface UserToolGroupsConfig {
  version: number;
  groups: UserToolGroup[];
  [field: string]: unknown;
}

export interface ToolGroupMetadata {
  description?: string;
  providerId?: string;
  providerName?: string;
}

export interface AgentToolGroup {
  id: string;
  label: string;
  toolNames: string[];
  kind: "user" | "builtin" | "extension" | "other";
}

// Product presentation groups from main. All member IDs are registry names.
const builtinGroups = [
  ["filesSearch", ["LS", "Read", "Glob", "Grep"]],
  ["fileEditing", ["Write", "Edit", "Delete"]],
  ["commands", ["ExecCommand", "WriteStdin", "ExecControl"]],
  ["delegation", ["AgentSpawn", "AgentFork", "AgentSendInput", "AgentControl", "AgentList", "ListModels", "AgentWait", "Skill"]],
  ["web", ["WebSearch", "WebFetch"]],
  ["imageUnderstanding", ["analyze_image", "view_image"]],
  ["interactionCanvas", ["AskUserQuestion"]],
  ["computerAutomation", ["ComputerUse", "ControlHub", "Playbook"]],
] as const;

export function selectableToolNames(names: readonly string[]): string[] {
  return [...new Set(names.filter(name => Boolean(name.trim()) && !internalTools.has(name)))];
}

export function setToolSelection(current: readonly string[], names: readonly string[], enabled: boolean): string[] {
  if (enabled) return [...new Set([...current, ...names])];
  const removed = new Set(names);
  return current.filter(name => !removed.has(name));
}

export function resolveAgentToolGroups(
  names: readonly string[], personal: readonly UserToolGroup[], metadata: ReadonlyMap<string, ToolGroupMetadata>,
): AgentToolGroup[] {
  const available = new Set(selectableToolNames(names));
  const categorized = new Set<string>();
  const groups: AgentToolGroup[] = [];
  const add = (kind: AgentToolGroup["kind"], id: string, label: string, candidates: readonly string[]) => {
    const toolNames = selectableToolNames(candidates).filter(name => available.has(name)).sort((a, b) => a.localeCompare(b));
    if (!toolNames.length) return;
    groups.push({ kind, id, label, toolNames });
    if (kind !== "user") toolNames.forEach(name => categorized.add(name));
  };
  for (const group of personal) add("user", `user:${group.id}`, group.name, group.toolNames);
  for (const [key, items] of builtinGroups) add("builtin", `builtin:${key}`, tr(`agents.toolGroups.${key}`), items);

  const extensions = new Map<string, { label: string; names: string[] }>();
  for (const name of available) {
    const item = metadata.get(name);
    if (!item?.providerId) continue;
    const group = extensions.get(item.providerId) ?? { label: item.providerName ?? item.providerId, names: [] };
    group.names.push(name);
    extensions.set(item.providerId, group);
  }
  for (const [id, group] of extensions) {
    add("extension", `extension:${id}`, tr("agents.toolGroups.extension", { provider: group.label }), group.names);
  }
  add("other", "other", tr("agents.toolGroups.other"), [...available].filter(name => !categorized.has(name)));
  return groups;
}

export async function readAgentToolMetadata(target: string | null): Promise<Map<string, ToolGroupMetadata>> {
  const rows = await invokeRawCommand<unknown>("get_all_tools_info", {}, { target });
  if (!Array.isArray(rows)) throw new Error(tr("agents.toolPermissionsCatalogUnavailable"));
  const entries = new Map<string, ToolGroupMetadata>();
  for (const row of rows) {
    if (typeof row?.name !== "string" || !row.name.trim()) continue;
    const dynamic = row.dynamic_info ?? row.dynamicInfo;
    const providerId = dynamic?.providerId ?? dynamic?.provider_id;
    const providerName = dynamic?.mcp?.serverName ?? dynamic?.mcp?.server_name;
    entries.set(row.name, {
      description: typeof row.description === "string" ? row.description : undefined,
      providerId: typeof providerId === "string" && providerId.trim() ? providerId.trim() : undefined,
      providerName: typeof providerName === "string" && providerName.trim() ? providerName.trim() : undefined,
    });
  }
  return entries;
}

export async function readUserToolGroups(target: string | null): Promise<UserToolGroupsConfig> {
  const empty = () => ({ version: configVersion, groups: [] });
  let raw: unknown;
  try {
    raw = await invokeCommand<unknown>("get_config", { path: configPath, skipRetryOnNotFound: true }, { target });
  } catch (error) {
    if (String(error).includes(`Config path '${configPath}' not found`)) return empty();
    throw error;
  }
  if (raw == null) return empty();
  const invalid = () => new Error(tr("agents.toolGroups.invalidConfig"));
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const doc = raw as Record<string, unknown>;
  const version = doc.version === undefined ? configVersion : doc.version;
  if (version !== configVersion) throw new Error(tr("agents.toolGroups.versionUnavailable"));
  const groups = doc.groups;
  const ids = new Set<string>();
  if (!Array.isArray(groups)) throw invalid();
  for (const group of groups) {
    if (typeof group?.id !== "string" || !group.id.trim() || ids.has(group.id) ||
      typeof group.name !== "string" || !group.name.trim() || !Array.isArray(group.toolNames) ||
      group.toolNames.some((name: unknown) => typeof name !== "string" || !name.trim())) throw invalid();
    ids.add(group.id);
  }
  return { ...doc, version, groups };
}

/** Re-read the owning device before editing its preference document. */
export async function updateUserToolGroups(
  target: string | null, current: () => boolean, update: (groups: UserToolGroup[]) => UserToolGroup[],
): Promise<UserToolGroupsConfig | undefined> {
  if (!current()) return;
  const doc = await readUserToolGroups(target);
  if (!current()) return;
  const groups = update(doc.groups);
  const next = { ...doc, groups };
  if (groups !== doc.groups) await invokeCommand("set_config", { path: configPath, value: next }, { target });
  return current() ? next : undefined;
}
