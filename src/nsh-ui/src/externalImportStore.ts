// External import: what other AI applications installed on the host expose
// (their config sources, commands, tools, subagents and MCP servers), the one
// switch that lets the host scan for them, the MCP servers that can be copied
// into OpenBitFun, and the source sessions a user removed from the session list.
//
// Every command here takes one `request` struct whose fields are camelCase and
// `deny_unknown_fields`, so a field the host does not know is refused: the
// workspace travels as `workspaceId` (or `workspacePath` for a Peer that never
// advertised `workspace_id_references_v1`). With a workspace open, it also
// identifies the owner device for edits to that device's defaults. The host refuses an SSH workspace for all of
// them, so this surface never sends one and says why instead. A host that lacks a
// command answers with its name and "not found" / "unknown command"; that is read
// as an older host (`incompatible`) rather than as a failure, the same mapping the
// desktop's ExternalSourcesAPI uses, and the older read is tried before giving up.

import { signal } from "nsh";
import { fleetDeviceContext, invokeCommand } from "./bridge";
import { currentDeviceScopeKey, isDesktopLocalShell, isDeviceOnThisMachine } from "./shared/deviceScope";
import { isRemoteWorkspace } from "./shared/workspaceUtils";
import { activeWorkspace } from "./state";
import { getConfig, setConfig, type WorkspaceRecord } from "./api";
import type { MessageKey } from "./i18n";
import { mcpConfigSavedWithRuntimeError, readMcpConfig, writeMcpConfig, type McpConfigSnapshot } from "./mcpConfigAccess";
import { isMcpEntry } from "./mcpServerForm";
import { refreshLoadedMcpConfig } from "./mcpStore";
import {
  mapExternalRuntimeReviews, runtimeManagementCommand, runtimeReviewCommand,
  type ExternalRuntimeReviews, type RuntimeManagementDecision, type RuntimeReviewDecision,
} from "./externalRuntimeReview";
import {
  externalPolicySelection, isExternalPolicyAccess, isExternalPolicyMode, readExternalIntegrationPolicy,
  type ExternalIntegrationPolicy, type ExternalPolicyChange, type ExternalPolicyScope,
} from "./externalIntegrationPolicy";

export type ExternalSourceHealth = "available" | "partial" | "degraded" | "unavailable";

export interface ExternalSourceRow {
  stableKey: string;
  ecosystemId: string;
  displayName: string;
  scope: string;
  location: string;
  health: string;
  lifecycle: string;
}

export interface ExternalDiscoveryState {
  enabled: boolean;
  canChange: boolean;
  hasScanned: boolean;
  preferenceRevision: number;
}

export interface ExternalSourceControlState {
  scope: string;
  preferenceRevision: number;
  safeMode: boolean;
  canSetSafeMode: boolean;
  canManageSources: boolean;
  canRevealSourceLocation: boolean;
  canApproveRuntime: boolean;
  canMutatePolicy: boolean;
  policy: ExternalIntegrationPolicy | null;
  discoveryPending: boolean;
  catalogSources: ExternalSourceRow[];
  runtimeReviews: ExternalRuntimeReviews;
  sources: ReadonlyMap<string, { enabled: boolean; effectiveStatus: string }>;
}

type SourceControlAction = { type: "set_safe_mode"; enabled: boolean }
  | { type: "set_source_enabled"; sourceKey: string; enabled: boolean };

export type ExternalCatalogKind = "command" | "tool" | "subagent" | "mcp";

export interface ExternalCatalogItem {
  id: string;
  kind: ExternalCatalogKind;
  name: string;
  description: string;
  ecosystemIds: string[];
  sources: ExternalSourceRow[];
  mcpDetails?: { endpoint: string; environmentKeys: string[]; headerNames: string[] };
}

export interface ExternalImportSnapshot {
  /** `null` when the host predates the discovery snapshot (read-only switch). */
  discovery: ExternalDiscoveryState | null;
  generation: number;
  discoveryPending: boolean;
  canRefresh: boolean;
  sources: ExternalSourceRow[];
  items: ExternalCatalogItem[];
  counts: { commands: number; tools: number; subagents: number; mcpServers: number };
  /** Ecosystems the host has an adapter for, in the host's order. */
  ecosystems: Array<{ id: string; displayName: string }>;
}

export type McpImportDisposition = "eligible" | "automatic_rename" | "already_imported" | "unavailable";

export interface McpImportItem {
  candidateId: string;
  displayName: string;
  transport: string;
  proposedNativeId: string;
  disposition: string;
  reasonCode: string;
}

export interface McpImportPlan {
  planFingerprint: string;
  items: McpImportItem[];
}

export const MAX_MCP_IMPORT_SELECTIONS = 256;

export interface McpImportedItem {
  candidateId: string;
  nativeId: string;
}

export interface McpUndoReview {
  scope: string;
  generation: number;
  snapshot: McpConfigSnapshot;
  copies: McpImportedItem[];
}

export interface RemovedExternalSessionRow {
  ecosystemId: string;
  sessionId: string;
  sessionName: string;
  workspaceId: string;
  workspaceName: string;
}

/** Why the page cannot read the host, when it cannot. */
export type ExternalImportBlock = "" | "remoteWorkspace" | "incompatible";

export type ExternalLoadState = "idle" | "loading" | "ready" | "error";

export type RemovedSessionsState =
  | "idle"
  | "loading"
  | "ready"
  | "unsupportedHost"
  | "error";

export type McpPlanState = "idle" | "loading" | "ready" | "unsupported" | "error";

export const externalSnapshot = signal<ExternalImportSnapshot | null>(null);
export const externalSourceControl = signal<ExternalSourceControlState | null>(null);
export const externalSourceControlBusy = signal<string | null>(null);
export const externalSourceControlError = signal<{ key: "changed" | "saveFailed" | "revealFailed"; detail?: string } | null>(null);
export const externalLoadState = signal<ExternalLoadState>("idle");
export const externalBlock = signal<ExternalImportBlock>("");
/** The host's own message for the last failed read, shown under the page. */
export const externalError = signal("");
export const externalDiscoverySaving = signal(false);
export const externalDiscoveryError = signal("");

export const mcpImportPlan = signal<McpImportPlan | null>(null);
export const mcpPlanState = signal<McpPlanState>("idle");
export const mcpImportBusy = signal<string | null>(null);
/** The result of the last import, as a message key and its parameters. */
export const externalMcpNotice = signal<{ tone: "success" | "warning" | "danger"; key: MessageKey; name?: string } | null>(null);

export const removedSessions = signal<RemovedExternalSessionRow[]>([]);
export const removedSessionsState = signal<RemovedSessionsState>("idle");
export const removedRestoreBusy = signal<string | null>(null);
export const removedRestoreFailed = signal<string | null>(null);
export const supportedSessionSources = signal<ReadonlySet<string>>(new Set());
export const sessionDiscoveryConfig = signal<Record<string, unknown> | null>(null);
export const sessionDiscoveryLoad = signal<"idle" | "loading" | "ready" | "unsupported" | "error">("idle");
export const sessionDiscoveryBusy = signal<string | null>(null);
export const sessionDiscoveryError = signal("");

/** The session ecosystems the host can import from, as the desktop names them. */
export const EXTERNAL_SESSION_NAMES: Readonly<Record<string, string>> = {
  codex: "Codex",
  cursor: "Cursor",
  zcode: "Zcode",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
  "deepseek-harness": "DeepSeek Harness",
};

let loadTicket = 0;
let planTicket = 0;
let removedTicket = 0;
let mcpApplyTicket = 0;
let mcpScopeGeneration = 0;
let sessionDiscoveryTicket = 0;
let sessionDiscoveryWriteTicket = 0;
let sourceControlReadTicket = 0;
let sourceControlOperationTicket = 0;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The host's `ExternalSourceOperationError`, when the message carries one. */
export function parseOperationError(error: unknown): { code: string; detail: string } | null {
  const text = errorText(error).trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = asRecord(JSON.parse(text.slice(start)));
    if (typeof parsed.code === "string") {
      return { code: parsed.code, detail: str(parsed.detail) };
    }
  } catch {
    // Not a serialized operation error.
  }
  return null;
}

/**
 * True when the host does not have `command` at all: its error names the command
 * and says it is unknown, or it is a CLI peer or server host that never
 * implemented it. Mirrors the desktop's `incompatible_version` mapping.
 */
export function isCommandMissing(command: string, error: unknown): boolean {
  const raw = errorText(error);
  const parsed = parseOperationError(error);
  if (parsed?.code === "host_capability_unavailable" && parsed.detail === "Unknown Server Host operation") {
    return true;
  }
  if (parsed?.code === "incompatible_version") return true;
  if (!raw.includes(command)) return false;
  return /unknown command|not found|not registered|not supported on cli peer host|no fixture|no answer/i.test(raw);
}

/**
 * The workspace fields one request carries: none for the user scope, the id
 * otherwise.
 */
export function workspaceFields(workspace: WorkspaceRecord | null): Record<string, string> {
  if (!workspace) return {};
  return { workspaceId: workspace.id };
}

function scopeKey(): string {
  return `${currentDeviceScopeKey()}|${activeWorkspace()?.id ?? ""}`;
}

function mapSourceControl(value: unknown): ExternalSourceControlState | null {
  const surface = asRecord(value);
  const control = asRecord(surface.control);
  const revision = control.preferenceRevision;
  if (control.schemaVersion !== 1 || typeof revision !== "number" || !Number.isSafeInteger(revision)
    || revision < 0 || typeof control.safeMode !== "boolean" || !Array.isArray(control.sources)) return null;
  const capabilities = asRecord(control.hostCapabilities);
  const sources = new Map<string, { enabled: boolean; effectiveStatus: string }>();
  for (const item of control.sources) {
    const row = asRecord(item);
    const key = str(row.stableKey);
    if (!key || (row.desired !== "enabled" && row.desired !== "disabled")) continue;
    sources.set(key, { enabled: row.desired === "enabled", effectiveStatus: str(row.effectiveStatus) });
  }
  const catalog = asRecord(surface.catalog);
  return { scope: scopeKey(), preferenceRevision: revision, safeMode: control.safeMode, sources,
    discoveryPending: catalog.discoveryPending === true,
    catalogSources: asArray(catalog.sources).map(mapSourceRow),
    runtimeReviews: mapExternalRuntimeReviews(catalog),
    canApproveRuntime: capabilities.canApproveRuntime === true,
    canMutatePolicy: capabilities.canMutatePolicy === true,
    policy: readExternalIntegrationPolicy(catalog.integrationPolicy),
    canSetSafeMode: capabilities.canSetSafeMode === true, canManageSources: capabilities.canManageSources === true,
    canRevealSourceLocation: capabilities.canRevealSourceLocation === true };
}

export async function readExternalSourceControl(forceRefresh = false): Promise<void> {
  if (isRemoteWorkspace(activeWorkspace())) return;
  const scope = scopeKey();
  const ticket = ++sourceControlReadTicket;
  try {
    const result = await invokeCommand<unknown>("get_external_source_control_snapshot",
      { ...workspaceFields(activeWorkspace()), forceRefresh });
    if (ticket === sourceControlReadTicket && scope === scopeKey()) externalSourceControl.set(mapSourceControl(result));
  } catch {
    if (ticket === sourceControlReadTicket && scope === scopeKey()) externalSourceControl.set(null);
  }
}

function sourceIdentity(value: unknown): string {
  const key = asRecord(value);
  const provider = str(key.providerId);
  const source = str(key.sourceId);
  return provider && source ? JSON.stringify([provider, source]) : "";
}

function mapSourceRow(item: unknown): ExternalSourceRow {
  const source = asRecord(item);
  const record = asRecord(source.record);
  return {
    stableKey: str(source.stableKey),
    ecosystemId: str(record.ecosystemId),
    displayName: str(record.displayName),
    scope: str(record.scope),
    location: str(record.location),
    health: str(record.health),
    lifecycle: str(source.lifecycle),
  };
}

function mapCatalog(raw: unknown, discovery: ExternalDiscoveryState | null): ExternalImportSnapshot {
  const catalog = asRecord(raw);
  const capabilities = asRecord(catalog.hostCapabilities);
  const sourceByKey = new Map<string, ExternalSourceRow>();
  const sources = asArray(catalog.sources).map(item => {
    const record = asRecord(asRecord(item).record);
    const row = mapSourceRow(item);
    const key = sourceIdentity(record.key);
    if (key) sourceByKey.set(key, row);
    return row;
  });
  const items: ExternalCatalogItem[] = [];
  const add = (kind: ExternalCatalogKind, id: string, name: string, description: string, keys: unknown[],
    mcpDetails?: ExternalCatalogItem["mcpDetails"]) => {
    if (!id || !name) return;
    const related = [...new Set(keys.map(key => sourceByKey.get(sourceIdentity(key))))].filter(row => row !== undefined);
    items.push({ id, kind, name, description, sources: related, ecosystemIds: [...new Set(related.map(row => row.ecosystemId))], mcpDetails });
  };
  for (const item of asArray(catalog.commands)) {
    const row = asRecord(item);
    const def = asRecord(row.definition);
    const id = asRecord(def.id);
    const key = sourceIdentity(id.source);
    add("command", str(row.candidateId) || (key && JSON.stringify([key, str(id.localId)])), str(def.name), str(def.description), [id.source]);
  }
  for (const item of asArray(catalog.tools)) {
    const row = asRecord(item);
    const def = asRecord(row.definition);
    const id = asRecord(def.id);
    const target = asRecord(id.target);
    const key = sourceIdentity(target.source);
    add("tool", key && JSON.stringify([key, str(target.localId), str(id.exportId)]), str(def.name), str(def.descriptionPreview), [target.source]);
  }
  for (const item of asArray(catalog.subagents)) {
    const row = asRecord(item);
    add("subagent", str(row.candidateId), str(row.displayName), str(row.description), asArray(row.sourceKeys));
  }
  for (const item of asArray(catalog.mcpServers)) {
    const row = asRecord(item);
    const def = asRecord(row.definition);
    add("mcp", str(row.candidateId), str(def.name), "", [...asArray(def.provenance), asRecord(def.id).source], {
      endpoint: str(def.commandPreview) || str(def.remoteUrlPreview),
      environmentKeys: asArray(def.environmentKeys).map(str).filter(Boolean),
      headerNames: asArray(def.headerNames).map(str).filter(Boolean),
    });
  }
  const policy = asRecord(catalog.integrationPolicy);
  const ecosystems: Array<{ id: string; displayName: string }> = [];
  const seen = new Set<string>();
  for (const item of asArray(policy.registeredEcosystems)) {
    const record = asRecord(item);
    const id = str(record.ecosystemId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ecosystems.push({ id, displayName: str(record.displayName) || id });
  }
  for (const source of sources) {
    if (!source.ecosystemId || seen.has(source.ecosystemId)) continue;
    seen.add(source.ecosystemId);
    ecosystems.push({ id: source.ecosystemId, displayName: source.displayName || source.ecosystemId });
  }
  return {
    discovery,
    generation: typeof catalog.generation === "number" ? catalog.generation : 0,
    discoveryPending: catalog.discoveryPending === true,
    canRefresh: capabilities.canRefresh !== false,
    sources,
    items,
    // Every list but `commands` is left out when empty.
    counts: {
      commands: asArray(catalog.commands).length,
      tools: asArray(catalog.tools).length,
      subagents: asArray(catalog.subagents).length,
      mcpServers: asArray(catalog.mcpServers).length,
    },
    ecosystems,
  };
}

function mapDiscoverySnapshot(raw: unknown): ExternalImportSnapshot {
  const value = asRecord(raw);
  if (value.schemaVersion !== 1) {
    throw new Error(`Unsupported discovery snapshot version: ${String(value.schemaVersion)}`);
  }
  return mapCatalog(value.catalog, {
    enabled: value.automaticDiscovery === true,
    canChange: value.canChangeAutomaticDiscovery === true,
    hasScanned: value.hasScanned === true,
    preferenceRevision: typeof value.preferenceRevision === "number" ? value.preferenceRevision : 0,
  });
}

/**
 * Reads the newest snapshot the host offers: the discovery snapshot, then the
 * control snapshot, then the legacy catalog. Only the first carries the
 * automatic-discovery switch; the older two draw it read-only.
 */
async function readSnapshot(request: Record<string, unknown>): Promise<ExternalImportSnapshot | null> {
  try {
    return mapDiscoverySnapshot(
      await invokeCommand<unknown>("get_external_source_discovery_snapshot", request),
    );
  } catch (error) {
    if (!isCommandMissing("get_external_source_discovery_snapshot", error)) throw error;
  }
  try {
    const surface = asRecord(await invokeCommand<unknown>("get_external_source_control_snapshot", request));
    return mapCatalog(surface.catalog, null);
  } catch (error) {
    if (!isCommandMissing("get_external_source_control_snapshot", error)) throw error;
  }
  try {
    return mapCatalog(await invokeCommand<unknown>("get_external_source_snapshot", request), null);
  } catch (error) {
    if (!isCommandMissing("get_external_source_snapshot", error)) throw error;
  }
  return null;
}

/** Clears everything a previous host or workspace answered. */
export function resetExternalImport(): void {
  loadTicket += 1;
  planTicket += 1;
  removedTicket += 1;
  mcpApplyTicket += 1;
  mcpScopeGeneration += 1;
  sessionDiscoveryTicket += 1;
  sessionDiscoveryWriteTicket += 1;
  sourceControlReadTicket += 1;
  sourceControlOperationTicket += 1;
  externalSnapshot.set(null);
  externalSourceControl.set(null);
  externalSourceControlBusy.set(null);
  externalSourceControlError.set(null);
  externalLoadState.set("idle");
  externalBlock.set("");
  externalError.set("");
  externalDiscoveryError.set("");
  externalDiscoverySaving.set(false);
  mcpImportPlan.set(null);
  mcpPlanState.set("idle");
  mcpImportBusy.set(null);
  externalMcpNotice.set(null);
  removedSessions.set([]);
  removedSessionsState.set("idle");
  removedRestoreBusy.set(null);
  removedRestoreFailed.set(null);
  supportedSessionSources.set(new Set());
  sessionDiscoveryConfig.set(null);
  sessionDiscoveryLoad.set("idle");
  sessionDiscoveryBusy.set(null);
  sessionDiscoveryError.set("");
}

let lastScope = "";

/** Loads the page for the current host and workspace, once per scope unless forced. */
export function syncExternalImportScope(force = false): void {
  const key = scopeKey();
  if (!force && key === lastScope && externalLoadState() !== "idle") return;
  if (key !== lastScope) resetExternalImport();
  lastScope = key;
  void loadExternalImport(false);
}

/** Reads the snapshot (asking the host to rescan when `forceRefresh`), then the MCP plan and removed sessions. */
export async function loadExternalImport(forceRefresh: boolean): Promise<void> {
  const workspace = activeWorkspace();
  const ticket = ++loadTicket;
  externalError.set("");
  if (isRemoteWorkspace(workspace)) {
    externalBlock.set("remoteWorkspace");
    externalSnapshot.set(null);
    externalSourceControl.set(null);
    externalLoadState.set("ready");
    mcpPlanState.set("idle");
    void loadRemovedSessions();
    return;
  }
  externalBlock.set("");
  externalLoadState.set("loading");
  let sourceControlRefresh: Promise<void> | undefined;
  try {
    const snapshot = await readSnapshot({ ...workspaceFields(workspace), forceRefresh });
    if (ticket !== loadTicket) return;
    if (!snapshot) {
      externalBlock.set("incompatible");
      externalSnapshot.set(null);
      externalLoadState.set("ready");
      return;
    }
    externalSnapshot.set(snapshot);
    externalLoadState.set("ready");
    sourceControlRefresh = readExternalSourceControl(forceRefresh);
    void loadMcpImportPlan();
    if (sessionDiscoveryLoad() === "idle" || forceRefresh) void loadExternalSessionDiscovery();
  } catch (error) {
    if (ticket !== loadTicket) return;
    externalError.set(parseOperationError(error)?.detail || errorText(error));
    externalLoadState.set("error");
  } finally {
    // Removed sessions do not depend on the snapshot, so they are read whatever it
    // answered (an older host gets its own sentence); the snapshot only narrows
    // which ecosystems are asked.
    if (ticket === loadTicket) void loadRemovedSessions();
  }
  await sourceControlRefresh;
}

/** Turns the host's automatic discovery on or off, then reads the snapshot again. */
export async function setAutomaticDiscovery(enabled: boolean): Promise<void> {
  const snapshot = externalSnapshot();
  const discovery = snapshot?.discovery;
  if (!discovery || !discovery.canChange || externalDiscoverySaving() || externalSourceControlBusy()) return;
  const workspace = activeWorkspace();
  if (isRemoteWorkspace(workspace)) return;
  const scope = scopeKey();
  const ticket = ++sourceControlOperationTicket;
  const current = () => ticket === sourceControlOperationTicket && scope === scopeKey();
  sourceControlReadTicket += 1;
  externalDiscoverySaving.set(true);
  externalDiscoveryError.set("");
  try {
    await invokeCommand<unknown>("update_external_integration_policy_command", {
      ...workspaceFields(workspace),
      mutation: {
        expectedPreferenceRevision: discovery.preferenceRevision,
        scope: workspace ? "workspace" : "user",
        change: { operation: "set_automatic_discovery", enabled },
      },
    });
  } catch (error) {
    if (current()) externalDiscoveryError.set(parseOperationError(error)?.detail || errorText(error));
  } finally {
    if (current()) {
      await loadExternalImport(false);
      if (current()) externalDiscoverySaving.set(false);
    }
  }
}

async function runSourceControlMutation(
  key: string,
  mutate: (workspace: Record<string, string>) => Promise<ExternalSourceControlState | undefined | null>,
): Promise<boolean> {
  const workspace = activeWorkspace();
  if (externalLoadState() !== "ready" || externalSourceControlBusy() || externalDiscoverySaving()
    || isRemoteWorkspace(workspace)) return false;
  const scope = scopeKey();
  const ticket = ++sourceControlOperationTicket;
  const current = () => ticket === sourceControlOperationTicket && scope === scopeKey();
  sourceControlReadTicket += 1;
  externalSourceControlBusy.set(key);
  externalSourceControlError.set(null);
  try {
    const next = await mutate(workspaceFields(workspace));
    if (current() && next !== undefined) {
      sourceControlReadTicket += 1;
      externalSourceControl.set(next);
    }
    return current();
  } catch (error) {
    if (current()) {
      const parsed = parseOperationError(error);
      externalSourceControlError.set({ key: parsed?.code === "stale_revision" ? "changed" : "saveFailed", detail: parsed?.detail });
    }
    return false;
  } finally {
    if (current()) {
      await loadExternalImport(false);
      if (current()) externalSourceControlBusy.set(null);
    }
  }
}

export async function changeExternalSourceControl(action: SourceControlAction): Promise<void> {
  const control = externalSourceControl();
  if (!control) return;
  const key = action.type === "set_safe_mode" ? "safe-mode" : action.sourceKey;
  if (action.type === "set_safe_mode" ? !control.canSetSafeMode
    : !control.canManageSources || control.sources.get(key)?.enabled === undefined) return;
  await runSourceControlMutation(key, async workspace => mapSourceControl(
    await invokeCommand("apply_external_source_control_action_command", {
      ...workspace,
      control: { schemaVersion: 1, operationId: `nsh-source-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        expectedPreferenceRevision: control.preferenceRevision, action },
    }),
  ));
}

export async function changeExternalRuntimePolicy(
  reviewed: ExternalSourceControlState,
  scope: ExternalPolicyScope,
  change: ExternalPolicyChange,
): Promise<boolean> {
  const current = externalSourceControl();
  if (!current?.policy || !current.canMutatePolicy || current.scope !== scopeKey()
    || reviewed.scope !== current.scope || reviewed.preferenceRevision !== current.preferenceRevision) return false;
  const policy = current.policy;
  if (scope === "workspace" && !activeWorkspace()) return false;
  if (change.operation === "reset_incompatible_policy") {
    if (scope !== "user" || policy.status !== "incompatible_schema") return false;
  } else if (policy.status !== "compatible") return false;
  if (change.operation === "reset_workspace" && (scope !== "workspace" || !policy.workspaceOverride)) return false;
  if (change.operation === "set_ecosystem_mode" || change.operation === "set_capability_access") {
    const selected = externalPolicySelection(policy, scope, change.ecosystemId);
    if (!selected.enabled || !selected.ecosystem) return false;
    if (change.operation === "set_ecosystem_mode") {
      if (!isExternalPolicyMode(change.mode)) return false;
    } else {
      const capability = selected.ecosystem.capabilities?.find(row => row.capabilityId === change.capabilityId);
      if (!capability || !isExternalPolicyAccess(change.access)
        || (change.access === "auto" && capability.safetyCeiling !== "auto")) return false;
    }
  }
  return runSourceControlMutation(`integration-policy:${scope}`, async workspace => {
    await invokeCommand("update_external_integration_policy_command", {
      ...workspace,
      mutation: { expectedPreferenceRevision: reviewed.preferenceRevision, scope, change },
    });
    return undefined;
  });
}

export async function submitExternalRuntimeReview(
  snapshot: ExternalSourceControlState,
  decision: RuntimeReviewDecision,
): Promise<boolean> {
  if (!canChangeExternalRuntime(snapshot) || snapshot !== externalSourceControl()) return false;
  const request = runtimeReviewCommand(decision);
  if (!request) return false;
  const key = decision.kind === "approval" ? decision.item.id : decision.item.key;
  return runSourceControlMutation(key, async workspace => {
    await invokeCommand(request.command, { ...workspace, ...request.fields, expectedPreferenceRevision: snapshot.preferenceRevision });
    return undefined;
  });
}

export function canChangeExternalRuntime(snapshot: ExternalSourceControlState | null): boolean {
  return Boolean(snapshot?.canApproveRuntime && snapshot.scope === scopeKey()
    && (!snapshot.policy || snapshot.policy.status === "compatible"));
}

export async function submitExternalRuntimeManagement(
  snapshot: ExternalSourceControlState,
  decision: RuntimeManagementDecision,
): Promise<boolean> {
  if (!canChangeExternalRuntime(snapshot) || snapshot !== externalSourceControl()) return false;
  const request = runtimeManagementCommand(snapshot.runtimeReviews, decision);
  if (!request) return false;
  return runSourceControlMutation(request.key, async workspace => {
    await invokeCommand(request.command, { ...workspace, ...request.fields, expectedPreferenceRevision: snapshot.preferenceRevision });
    return undefined;
  });
}

export function canRevealExternalSource(): boolean {
  return externalSourceControl()?.canRevealSourceLocation === true && isDesktopLocalShell() && isDeviceOnThisMachine();
}

export async function revealExternalSource(sourceKey: string): Promise<void> {
  const workspace = activeWorkspace();
  if (!canRevealExternalSource() || isRemoteWorkspace(workspace) || !sourceKey || externalSourceControlBusy()
    || externalDiscoverySaving()) return;
  const scope = scopeKey();
  const ticket = ++sourceControlOperationTicket;
  const current = () => ticket === sourceControlOperationTicket && scope === scopeKey();
  externalSourceControlBusy.set(sourceKey);
  externalSourceControlError.set(null);
  try {
    await invokeCommand("reveal_external_source_location", { ...workspaceFields(workspace), sourceKey });
  } catch (error) {
    if (current()) externalSourceControlError.set({ key: "revealFailed", detail: parseOperationError(error)?.detail });
  } finally {
    if (current()) externalSourceControlBusy.set(null);
  }
}

/** True when this surface may copy MCP servers into OpenBitFun here. */
export function mcpImportSupported(): boolean {
  return !isRemoteWorkspace(activeWorkspace());
}

export async function loadMcpImportPlan(): Promise<void> {
  const snapshot = externalSnapshot();
  const ticket = ++planTicket;
  const scope = scopeKey();
  const route = { target: fleetDeviceContext() };
  if (!snapshot || snapshot.counts.mcpServers === 0 || snapshot.discovery?.enabled === false) {
    mcpImportPlan.set(null);
    mcpPlanState.set("idle");
    return;
  }
  if (!mcpImportSupported()) {
    mcpImportPlan.set(null);
    mcpPlanState.set("unsupported");
    return;
  }
  mcpPlanState.set("loading");
  try {
    const plan = mapPlan(
      await invokeCommand<unknown>("plan_external_mcp_import_command", workspaceFields(activeWorkspace()), route),
    );
    if (ticket !== planTicket || scope !== scopeKey()) return;
    mcpImportPlan.set(plan);
    mcpPlanState.set("ready");
  } catch (error) {
    if (ticket !== planTicket || scope !== scopeKey()) return;
    mcpImportPlan.set(null);
    mcpPlanState.set(isCommandMissing("plan_external_mcp_import_command", error) ? "unsupported" : "error");
  }
}

function mapPlan(raw: unknown): McpImportPlan {
  const plan = asRecord(raw);
  return {
    planFingerprint: str(plan.planFingerprint),
    items: asArray(plan.items).map(item => {
      const record = asRecord(item);
      return {
        candidateId: str(record.candidateId),
        displayName: str(record.displayName) || str(record.candidateId),
        transport: str(record.transport),
        proposedNativeId: str(record.proposedNativeId),
        disposition: str(record.disposition),
        reasonCode: str(record.reasonCode),
      };
    }),
  };
}

/** An item the host will copy: eligible as is, or under an automatic rename. */
export function mcpItemSelectable(item: McpImportItem): boolean {
  return item.disposition === "eligible" || item.disposition === "automatic_rename";
}

/** The message key that states one item's disposition. */
export function mcpItemStateKey(item: McpImportItem): MessageKey {
  switch (item.disposition) {
    case "eligible":
      return "settings.externalImports.state.ready";
    case "automatic_rename":
      return "settings.externalImports.state.readyRename";
    case "already_imported":
      return "settings.externalImports.state.imported";
    default:
      return item.reasonCode === "external_mcp.import_setup_required"
        ? "settings.externalImports.state.setupRequired"
        : "settings.externalImports.state.unavailable";
  }
}

type McpImportResult =
  | { status: "applied"; imported: McpImportedItem[] }
  | { status: "stale"; plan: McpImportPlan };

function startMcpOperation(label: string) {
  if (mcpImportBusy() || !mcpImportSupported()) return null;
  const scope = scopeKey();
  if (scope !== lastScope) return null;
  const generation = mcpScopeGeneration;
  const route = { target: fleetDeviceContext() };
  const ticket = ++mcpApplyTicket;
  mcpImportBusy.set(label);
  externalMcpNotice.set(null);
  const current = () => scope === scopeKey() && ticket === mcpApplyTicket;
  return { scope, generation, route, current, finish: () => { if (current()) mcpImportBusy.set(null); } };
}

/** Copies only the items approved against the plan visible in the user's review. */
export async function applyMcpImport(plan: McpImportPlan, candidateIds: readonly string[]): Promise<McpImportResult | null> {
  const selectedIds = new Set(candidateIds);
  const rows = plan.items.filter(item => selectedIds.has(item.candidateId) && mcpItemSelectable(item));
  if (!plan.planFingerprint || rows.length !== selectedIds.size || rows.length === 0 || rows.length > MAX_MCP_IMPORT_SELECTIONS) return null;
  const op = startMcpOperation("import");
  if (!op) return null;
  try {
    const latest = mcpImportPlan();
    if (!latest || latest.planFingerprint !== plan.planFingerprint) {
      externalMcpNotice.set({ tone: "warning", key: "settings.externalImports.stale" });
      return latest ? { status: "stale", plan: latest } : null;
    }
    const result = asRecord(await invokeCommand<unknown>("apply_external_mcp_import_command", {
      ...workspaceFields(activeWorkspace()),
      importRequest: {
        schemaVersion: 1,
        planFingerprint: plan.planFingerprint,
        selections: rows.map(item => ({ candidateId: item.candidateId })),
      },
    }, op.route));
    if (!op.current()) return null;
    const outcome = asRecord(result.outcome);
    if (outcome.status === "stale") {
      const refreshed = mapPlan(outcome.refreshedPlan);
      if (!refreshed.planFingerprint) throw new Error("Missing MCP import preview");
      // This response supersedes a plan read that was started before it arrived.
      planTicket += 1;
      mcpImportPlan.set(refreshed);
      mcpPlanState.set("ready");
      externalMcpNotice.set({ tone: "warning", key: "settings.externalImports.stale" });
      return { status: "stale", plan: refreshed };
    }
    if (outcome.status !== "applied") throw new Error("Unknown MCP import receipt");
    const receipts = new Map<string, McpImportedItem>();
    for (const value of asArray(outcome.imported)) {
      const item = asRecord(value);
      const candidateId = str(item.candidateId);
      const nativeId = str(item.nativeId);
      if (selectedIds.has(candidateId) && nativeId) receipts.set(candidateId, { candidateId, nativeId });
    }
    const imported = [...receipts.values()];
    externalMcpNotice.set(imported.length === rows.length
      ? { tone: "success", key: "settings.externalImports.importSuccess",
        name: rows.map(item => item.displayName).join(", ") }
      : { tone: "warning", key: "settings.externalImports.importUnconfirmed" });
    refreshLoadedMcpConfig();
    await loadMcpImportPlan();
    return op.current() ? { status: "applied", imported } : null;
  } catch (error) {
    if (!op.current()) return null;
    externalMcpNotice.set({ tone: "danger",
      key: isCommandMissing("apply_external_mcp_import_command", error)
        ? "settings.externalImports.importUnsupported" : "settings.externalImports.importFailed" });
    return null;
  } finally {
    op.finish();
  }
}

/** Reviews the native copies by their stored import provenance, never by display name. */
export async function prepareMcpUndo(items: readonly McpImportItem[]): Promise<McpUndoReview | null> {
  if (!items.length || items.some(item => item.disposition !== "already_imported")) return null;
  const op = startMcpOperation("reviewUndo");
  if (!op) return null;
  try {
    const snapshot = await readMcpConfig(op.route);
    if (!op.current()) return null;
    if (!snapshot?.fingerprint) throw new Error("Missing MCP configuration fingerprint");
    const servers: unknown = asRecord(JSON.parse(snapshot.text)).mcpServers;
    if (!isMcpEntry(servers)) throw new Error("Missing MCP servers");
    const copies: McpImportedItem[] = [];
    for (const item of items) {
      const matches = Object.entries(servers).filter(([, config]) =>
        asRecord(asRecord(config)._openbitfunImport).sourceCandidateId === item.candidateId);
      if (matches.length !== 1) throw new Error("MCP copy has no unique import provenance");
      copies.push({ candidateId: item.candidateId, nativeId: matches[0]![0] });
    }
    return { scope: op.scope, generation: op.generation, snapshot, copies };
  } catch (error) {
    if (op.current()) externalMcpNotice.set({ tone: "warning",
      key: isCommandMissing("load_mcp_json_config", error) ? "settings.externalImports.importUnsupported" : "settings.externalImports.undoUnavailable" });
    return null;
  } finally {
    op.finish();
  }
}

export async function applyMcpUndo(review: McpUndoReview, candidateIds: readonly string[]): Promise<"removed" | "stale" | "failed"> {
  if (review.scope !== scopeKey() || review.generation !== mcpScopeGeneration) return "stale";
  const selection = new Set(candidateIds);
  const copies = review.copies.filter(copy => selection.has(copy.candidateId));
  if (!copies.length || selection.size !== copies.length) return "failed";
  const op = startMcpOperation("undo");
  if (!op) return "failed";
  try {
    let runtimePending = false;
    try {
      // A single fingerprint-checked write removes the reviewed union and retains all other fields.
      const config = asRecord(JSON.parse(review.snapshot.text));
      const servers = asRecord(config.mcpServers);
      for (const copy of copies) delete servers[copy.nativeId];
      await writeMcpConfig({ text: JSON.stringify(config, null, 2), fingerprint: review.snapshot.fingerprint }, op.route);
    } catch (error) {
      if (!op.current()) return "stale";
      const text = errorText(error);
      if (!mcpConfigSavedWithRuntimeError(text)) {
        const stale = text.includes("MCP configuration changed");
        externalMcpNotice.set({ tone: stale ? "warning" : "danger",
          key: stale ? "settings.externalImports.undoStale"
            : isCommandMissing("save_mcp_json_config", error) ? "settings.externalImports.importUnsupported" : "settings.externalImports.undoFailed" });
        return stale ? "stale" : "failed";
      }
      runtimePending = true;
    }
    if (!op.current()) return "stale";
    externalMcpNotice.set(runtimePending ? { tone: "warning", key: "settings.externalImports.undoRuntimePending" }
      : { tone: "success", key: "settings.externalImports.undoSuccess" });
    refreshLoadedMcpConfig();
    await loadMcpImportPlan();
    return op.current() ? "removed" : "stale";
  } finally {
    op.finish();
  }
}

/** The ecosystems whose removed sessions are listed: the host's, limited to the ones with session import. */
export function sessionEcosystems(): string[] {
  const snapshot = externalSnapshot();
  const ids = snapshot ? snapshot.ecosystems.map(item => item.id) : [];
  const known = ids.filter(id => id in EXTERNAL_SESSION_NAMES);
  return known.length > 0 ? known : Object.keys(EXTERNAL_SESSION_NAMES);
}

const SESSION_DISCOVERY_PATH = "app.external_session_discovery";

export async function loadExternalSessionDiscovery(): Promise<void> {
  if (isRemoteWorkspace(activeWorkspace()) || sessionDiscoveryBusy()) return;
  const ticket = ++sessionDiscoveryTicket;
  const scope = scopeKey();
  sessionDiscoveryLoad.set("loading");
  sessionDiscoveryError.set("");
  try {
    const value = await getConfig(SESSION_DISCOVERY_PATH, true);
    if (ticket !== sessionDiscoveryTicket || scope !== scopeKey()) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      sessionDiscoveryConfig.set(null);
      sessionDiscoveryLoad.set("unsupported");
      return;
    }
    sessionDiscoveryConfig.set(asRecord(value));
    sessionDiscoveryLoad.set("ready");
  } catch (error) {
    if (ticket !== sessionDiscoveryTicket || scope !== scopeKey()) return;
    sessionDiscoveryConfig.set(null);
    sessionDiscoveryLoad.set(isCommandMissing("get_config", error) ? "unsupported" : "error");
    sessionDiscoveryError.set(errorText(error));
  }
}

export function canSetSessionDiscovery(ecosystemId: string): boolean {
  return sessionDiscoveryLoad() === "ready" && Object.hasOwn(EXTERNAL_SESSION_NAMES, ecosystemId)
    && (ecosystemId === "codex" || ecosystemId === "zcode" || supportedSessionSources().has(ecosystemId));
}

export async function setSessionDiscovery(ecosystemId: string, enabled: boolean): Promise<void> {
  const config = sessionDiscoveryConfig();
  if (!config || !canSetSessionDiscovery(ecosystemId) || sessionDiscoveryBusy() || isRemoteWorkspace(activeWorkspace())) return;
  const scope = scopeKey();
  const operation = ++sessionDiscoveryWriteTicket;
  const current = () => scope === scopeKey() && operation === sessionDiscoveryWriteTicket;
  sessionDiscoveryBusy.set(ecosystemId);
  sessionDiscoveryError.set("");
  try {
    await setConfig(`${SESSION_DISCOVERY_PATH}.${ecosystemId}`, enabled);
    if (current()) sessionDiscoveryConfig.update(config => config && { ...config, [ecosystemId]: enabled });
  } catch (error) {
    if (current()) sessionDiscoveryError.set(errorText(error));
  } finally {
    if (current()) sessionDiscoveryBusy.set(null);
  }
}

/**
 * Lists the source sessions removed from the session list, for every ecosystem
 * the host imports sessions from.
 */
export async function loadRemovedSessions(): Promise<void> {
  const ticket = ++removedTicket;
  removedRestoreFailed.set(null);
  removedSessionsState.set("loading");
  const rows: RemovedExternalSessionRow[] = [];
  const supported = new Set<string>();
  let missing = 0;
  const ecosystems = sessionEcosystems();
  for (const ecosystemId of ecosystems) {
    try {
      const list = await invokeCommand<unknown>("list_removed_external_sessions", { ecosystemId });
      if (ticket !== removedTicket) return;
      supported.add(ecosystemId);
      for (const item of asArray(list)) {
        const record = asRecord(item);
        rows.push({
          ecosystemId: str(record.ecosystemId) || ecosystemId,
          sessionId: str(record.sessionId),
          sessionName: str(record.sessionName) || str(record.sessionId),
          workspaceId: str(record.workspaceId),
          workspaceName: str(record.workspaceName),
        });
      }
    } catch (error) {
      if (ticket !== removedTicket) return;
      if (isCommandMissing("list_removed_external_sessions", error)) {
        missing += 1;
        break;
      }
      // An ecosystem this host build has no importer for is refused as
      // `unsupported`; the others still list.
      if (parseOperationError(error)?.code === "unsupported") continue;
      removedSessions.set([]);
      removedSessionsState.set("error");
      return;
    }
  }
  if (ticket !== removedTicket) return;
  supportedSessionSources.set(supported);
  if (missing > 0) {
    removedSessions.set([]);
    removedSessionsState.set("unsupportedHost");
    return;
  }
  removedSessions.set(rows);
  removedSessionsState.set("ready");
}

export function removedSessionKey(row: RemovedExternalSessionRow): string {
  return `${row.ecosystemId}|${row.workspaceId}|${row.sessionId}`;
}

/** Puts one removed source session back into its workspace's session list. */
export async function restoreRemovedSession(row: RemovedExternalSessionRow): Promise<void> {
  if (removedRestoreBusy()) return;
  const key = removedSessionKey(row);
  removedRestoreBusy.set(key);
  removedRestoreFailed.set(null);
  try {
    await invokeCommand<unknown>("restore_removed_external_session", {
      ecosystemId: row.ecosystemId,
      targetWorkspaceId: row.workspaceId,
      sessionId: row.sessionId,
    });
    removedSessions.update(current => current.filter(item => removedSessionKey(item) !== key));
  } catch {
    // The host keeps the removal record; the row stays so the user can retry.
    removedRestoreFailed.set(key);
  } finally {
    removedRestoreBusy.set(null);
  }
}
