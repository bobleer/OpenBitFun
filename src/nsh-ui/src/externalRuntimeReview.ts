/** The public facts in the workspace owner's external source control catalog. */
export type RuntimeKind = "command" | "tool" | "subagent" | "mcp";
export type ManagedRuntimeKind = Exclude<RuntimeKind, "command">;
export type RuntimeDetailKind = "source" | "location" | "scope" | "domain" | "runtime" | "modules" | "directory"
  | "capabilities" | "tools" | "model" | "compatibility" | "description" | "transport" | "command" | "url"
  | "argumentCount" | "startupTimeout" | "catalogTimeout" | "executionTimeout"
  | "environment" | "environmentReads" | "headers" | "reason" | "role" | "requestedModel" | "unavailableTools";

export interface RuntimeDetail {
  kind: RuntimeDetailKind;
  values: string[];
}

interface RuntimeSubject {
  id: string;
  name: string;
  ecosystemIds: string[];
  details: RuntimeDetail[];
}

export type RuntimeApproval = RuntimeSubject & (
  | { kind: "tool"; approvalKey: string; decisionKey: string }
  | { kind: "subagent" | "mcp"; decisionKey: string; generation: number | null }
);

export interface RuntimeCandidate extends RuntimeSubject {
  external: boolean;
  available: boolean;
}

export interface RuntimeConflict {
  kind: RuntimeKind;
  key: string;
  name: string;
  generation: number | null;
  selectedId: string;
  candidates: RuntimeCandidate[];
  ecosystemIds: string[];
}

export interface ExternalRuntimeReviews {
  approvals: RuntimeApproval[];
  conflicts: RuntimeConflict[];
  items: RuntimeItem[];
  generation: Record<ManagedRuntimeKind, number | null>;
  modelBindings: RuntimeModelBinding[];
  modelOptions: RuntimeModelOption[];
}

export interface RuntimeItem {
  key: string;
  kind: ManagedRuntimeKind;
  name: string;
  ecosystemIds: string[];
  details: RuntimeDetail[];
  state: string;
  approval: RuntimeApproval | null;
}

export type RuntimeModelTarget = { kind: "primary" | "fast" } | { kind: "model"; modelId: string };

export interface RuntimeModelOption {
  target: RuntimeModelTarget;
  label: string;
  effort: string;
}

export interface RuntimeModelBinding {
  key: string;
  ecosystemIds: string[];
  affectedCount: number;
  requestKind: string;
  requestedModel: string;
  profile: string;
  method: string;
  selected: RuntimeModelTarget | null;
  unknownSelection: boolean;
  effective: string;
}

export const DISABLED_SUBAGENT_CHOICE = "__openbitfun_disabled__";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return list(value).map(text).filter(Boolean);
}

function generation(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function countText(value: unknown): string {
  const count = generation(value);
  return count === null ? "" : String(count);
}

function sourceKey(value: unknown): string {
  const source = record(value);
  const provider = text(source.providerId);
  const id = text(source.sourceId);
  return provider && id ? JSON.stringify([provider, id]) : "";
}

function details(...entries: Array<[RuntimeDetailKind, string | string[]]>): RuntimeDetail[] {
  return entries.flatMap(([kind, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return values.some(Boolean) ? [{ kind, values: values.filter(Boolean) }] : [];
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function modelTarget(value: unknown): RuntimeModelTarget | null {
  const raw = record(value);
  if (raw.kind === "primary" || raw.kind === "fast") return { kind: raw.kind };
  const modelId = text(raw.modelId);
  return raw.kind === "model" && modelId ? { kind: "model", modelId } : null;
}

export function runtimeModelTargetKey(target: RuntimeModelTarget | null): string {
  return target?.kind === "model" ? `model:${target.modelId}` : target?.kind ?? "source";
}

function requestedModelLabel(value: unknown): string {
  const model = record(value);
  return [text(model.providerHint), text(model.modelName)].filter(Boolean).join("/");
}

export function mapExternalRuntimeReviews(raw: unknown): ExternalRuntimeReviews {
  const catalog = record(raw);
  const sourceMap = new Map(list(catalog.sources).flatMap(item => {
    const source = record(record(item).record);
    const key = sourceKey(source.key);
    return key ? [[key, source] as const] : [];
  }));
  const findSource = (key: unknown) => sourceMap.get(sourceKey(key)) ?? {};
  const ecosystems = (keys: unknown[]) => unique(keys.map(key => text(findSource(key).ecosystemId)));
  const sourceDetails = (key: unknown) => {
    const source = findSource(key);
    return details(["source", text(source.displayName)], ["location", text(source.location)],
      ["scope", text(source.scope)], ["domain", text(source.executionDomainId)]);
  };
  const mcpGeneration = generation(catalog.mcpGeneration);
  const subagentGeneration = generation(catalog.subagentGeneration);
  const approvals: RuntimeApproval[] = [];
  const items: RuntimeItem[] = [];
  const toolDefinitions = list(catalog.tools).map(item => record(item));
  const toolExports = new Map<string, string[]>();
  for (const tool of toolDefinitions) {
    const approvalKey = text(tool.approvalKey);
    const name = text(record(tool.definition).name);
    if (approvalKey && name) toolExports.set(approvalKey, [...(toolExports.get(approvalKey) ?? []), name]);
  }
  for (const tool of toolDefinitions) {
    const definition = record(tool.definition);
    const id = record(definition.id);
    const target = record(id.target);
    const activation = record(tool.activation);
    const state = text(activation.state);
    const name = text(definition.name);
    const approvalKey = text(tool.approvalKey);
    const decisionKey = text(tool.decisionKey);
    if (!name || !state) continue;
    const ecosystemIds = ecosystems([target.source]);
    const subject = { id: approvalKey, name, ecosystemIds,
      details: [...sourceDetails(target.source), ...details(
        ["description", text(definition.descriptionPreview)], ["tools", unique(toolExports.get(approvalKey) ?? [])],
        ["modules", text(definition.modulePath)], ["directory", text(definition.workingDirectory)],
        ["runtime", text(definition.runtimeKind)], ["capabilities", strings(definition.capabilities)],
        ["reason", text(activation.reason)])],
    };
    items.push({
      key: JSON.stringify([sourceKey(target.source), text(target.localId) || approvalKey, text(id.exportId) || name]),
      kind: "tool", name, ecosystemIds, details: subject.details, state,
      approval: approvalKey && decisionKey ? { ...subject, kind: "tool", approvalKey, decisionKey } : null,
    });
  }
  for (const item of list(catalog.toolApprovalRequests)) {
    const row = record(item);
    const approvalKey = text(row.approvalKey);
    const decisionKey = text(row.decisionKey);
    const name = text(row.sourceDisplayName) || strings(row.toolNames).join(", ");
    if (!approvalKey || !decisionKey || !name) continue;
    const source = record(row.targetId).source;
    const modules = unique(toolDefinitions.filter(tool => tool.approvalKey === approvalKey && tool.decisionKey === decisionKey)
      .map(tool => text(record(tool.definition).modulePath)));
    approvals.push({ kind: "tool", id: approvalKey, approvalKey, decisionKey, name, ecosystemIds: ecosystems([source]),
      details: details(["capabilities", strings(row.capabilities)], ["tools", strings(row.toolNames)],
        ["modules", modules], ["location", text(row.sourceLocation)],
        ["scope", text(row.sourceScope)], ["domain", text(findSource(source).executionDomainId)],
        ["runtime", text(row.runtimeKind)], ["directory", text(row.workingDirectory)]),
    });
  }

  const agents = new Map<string, RuntimeSubject>();
  const pendingAgents = new Set(strings(catalog.pendingSubagentApprovals));
  for (const item of list(catalog.subagents)) {
    const row = record(item);
    const id = text(row.candidateId);
    const name = text(row.displayName);
    const decisionKey = text(row.decisionKey);
    if (!id || !name) continue;
    const keys = list(row.sourceKeys);
    const subject = { id, name, ecosystemIds: ecosystems(keys),
      details: details(["model", text(row.effectiveModelLabel)], ["tools", strings(row.effectiveToolLabels)],
        ["requestedModel", requestedModelLabel(row.requestedModel)], ["role", text(row.mode)],
        ["unavailableTools", strings(row.unavailableToolLabels)],
        ["compatibility", text(row.compatibilityState)], ["description", text(row.description)], ["source", text(row.providerLabel)],
        ["location", strings(row.sourceLocationLabels)], ["scope", text(row.scope)],
        ["domain", unique(keys.map(key => text(findSource(key).executionDomainId)))],
        ["reason", list(row.diagnostics).map(value => text(record(value).code))]),
    };
    agents.set(id, subject);
    const approval: RuntimeApproval | null = decisionKey ? { ...subject, kind: "subagent", decisionKey, generation: subagentGeneration } : null;
    const state = text(record(row.activationState).state);
    if (state) items.push({ key: id, kind: "subagent", name, ecosystemIds: subject.ecosystemIds, details: subject.details, state, approval });
    if (pendingAgents.has(id) && approval) approvals.push(approval);
  }

  const servers = new Map<string, RuntimeSubject>();
  function mapServer(item: unknown): RuntimeSubject | null {
    const row = record(item);
    const definition = record(row.definition);
    const id = text(row.candidateId);
    const name = text(definition.name);
    if (!id || !name) return null;
    const source = record(definition.id).source;
    const timeouts = record(definition.timeouts);
    return { id, name, ecosystemIds: ecosystems([source, ...list(definition.provenance)]),
      details: [...details(["transport", text(definition.transport)],
        ["command", text(definition.commandPreview)], ["url", text(definition.remoteUrlPreview)],
        ["environment", strings(definition.environmentKeys)], ["environmentReads", strings(definition.environmentReferenceNames)],
        ["headers", strings(definition.headerNames)]), ...sourceDetails(source), ...details(
        ["argumentCount", countText(definition.argumentCount)], ["startupTimeout", countText(timeouts.startupMs)],
        ["catalogTimeout", countText(timeouts.catalogMs)], ["executionTimeout", countText(timeouts.executionMs)],
        ["directory", text(definition.workingDirectory)])],
    };
  }
  for (const item of list(catalog.mcpServers)) {
    const server = mapServer(item);
    if (!server) continue;
    servers.set(server.id, server);
    const row = record(item);
    const activation = record(row.activationState);
    const state = text(activation.state);
    const decisionKey = text(row.decisionKey);
    const approval: RuntimeApproval | null = decisionKey ? { ...server, kind: "mcp", decisionKey, generation: mcpGeneration } : null;
    if (state) items.push({ ...server, key: server.id, kind: "mcp", state, approval,
      details: [...server.details, ...details(["reason", text(activation.reason)])],
    });
  }
  for (const item of list(catalog.mcpApprovalRequests)) {
    const server = mapServer(item);
    const decisionKey = text(record(item).decisionKey);
    if (server && decisionKey) {
      servers.set(server.id, server);
      approvals.push({ ...server, kind: "mcp", decisionKey, generation: mcpGeneration });
    }
  }

  const conflicts: RuntimeConflict[] = [];
  const sections = [
    { kind: "command", rows: catalog.commandConflicts, name: "commandName", generation: null },
    { kind: "tool", rows: catalog.toolConflicts, name: "toolName", generation: null },
    { kind: "subagent", rows: catalog.subagentConflicts, name: "logicalId", generation: subagentGeneration },
    { kind: "mcp", rows: catalog.mcpConflicts, name: "serverName", generation: mcpGeneration },
  ] as const;
  for (const section of sections) {
    for (const item of list(section.rows)) {
      const row = record(item);
      const key = text(row.conflictKey);
      const name = text(row[section.name]);
      if (!key || !name) continue;
      const candidates = list(row.candidates).flatMap(item => {
        const option = record(item);
        const id = text(option.candidateId);
        const label = text(option.displayName) || text(option.sourceDisplayName);
        if (!id || !label) return [];
        const subject = section.kind === "subagent" ? agents.get(id) : section.kind === "mcp" ? servers.get(id) : undefined;
        const external = section.kind === "mcp" || section.kind === "subagent" ? option.external === true
          : section.kind === "tool" ? option.kind === "external" || option.kind === "mcp" : true;
        const knownType = section.kind === "tool" ? ["external", "mcp", "built_in"].includes(text(option.kind))
          : section.kind === "command" || typeof option.external === "boolean";
        const status = record(option.availability);
        const reportedAvailable = section.kind === "mcp" ? option.available === true : option.available !== false;
        const available = knownType && (section.kind === "command" ? status.state === "available"
          : reportedAvailable && (!external || section.kind === "tool" || Boolean(subject)));
        return [{
          id, name: label, external, available,
          ecosystemIds: unique([...(subject?.ecosystemIds ?? []), ...ecosystems([option.source]), text(option.ecosystemId)]),
          details: subject?.details ?? details(["source", text(option.sourceDisplayName) || text(option.sourceLabel)
              || text(findSource(option.source).displayName) || text(option.providerId)],
            ["location", text(option.sourceLocation) || text(findSource(option.source).location)],
            ["scope", text(option.sourceScope)], ["description", text(option.commandDescription)],
            ["reason", text(option.unavailableReason) || text(status.reason)]),
        }];
      });
      if (!candidates.length) continue;
      conflicts.push({ kind: section.kind, key, name, generation: section.generation,
        selectedId: text(row.selectedCandidateId), candidates, ecosystemIds: unique(candidates.flatMap(option => option.ecosystemIds)),
      });
    }
  }
  const modelBindings = list(catalog.subagentModelBindingGroups).flatMap(value => {
    const group = record(value);
    const key = text(group.bindingKey);
    if (!key) return [];
    const affected = strings(group.affectedCandidateIds);
    const profile = record(group.profileRequest);
    const selected = modelTarget(group.selectedTarget);
    return [{
      key, affectedCount: affected.length,
      ecosystemIds: unique(affected.flatMap(id => agents.get(id)?.ecosystemIds ?? [])),
      requestKind: text(record(group.request).kind), requestedModel: requestedModelLabel(group.request),
      profile: text(profile.name) || text(profile.value), method: text(group.method),
      selected, unknownSelection: Boolean(group.selectedTarget && !selected), effective: text(group.effectiveModelLabel),
    }];
  });
  const modelOptions = list(catalog.subagentModelBindingOptions).flatMap(value => {
    const row = record(value);
    const target = modelTarget(row.target);
    const label = text(row.effectiveModelLabel);
    return target && label ? [{ target, label, effort: text(row.configuredReasoningEffort) }] : [];
  });
  return {
    approvals, conflicts, items, modelBindings, modelOptions,
    generation: { tool: generation(catalog.generation), subagent: subagentGeneration, mcp: mcpGeneration },
  };
}

export function canEnableRuntimeItem(item: RuntimeItem): boolean {
  if (item.kind === "mcp") return ["approval_required", "declined", "configuration_changed"].includes(item.state);
  return item.state === "approval_required" || item.state === "declined";
}

export function canDisableRuntimeItem(item: RuntimeItem): boolean {
  if (item.kind === "tool") return ["active", "conflict", "load_failed"].includes(item.state);
  if (item.kind === "mcp") return ["active", "starting", "runtime_unavailable"].includes(item.state);
  return item.state === "active";
}

export function runtimeBatchItems(catalog: ExternalRuntimeReviews, kind: ManagedRuntimeKind, ecosystem: string, enabled: boolean): RuntimeApproval[] {
  const candidates = enabled ? catalog.approvals : catalog.items.flatMap(item =>
    item.approval && (canDisableRuntimeItem(item) || canEnableRuntimeItem(item)) ? [item.approval] : []);
  const items = new Map<string, RuntimeApproval>();
  for (const item of candidates) {
    if (item.kind === kind && item.ecosystemIds.includes(ecosystem)) items.set(item.id, item);
  }
  return [...items.values()];
}

export function canEditRuntimeModelBinding(binding: RuntimeModelBinding): boolean {
  return ["binding_required", "binding_unavailable", "explicit"].includes(binding.method);
}

export type RuntimeManagementDecision =
  | { kind: "item"; assetKind: ManagedRuntimeKind; itemKey: string; approved: boolean }
  | { kind: "batch"; assetKind: ManagedRuntimeKind; ecosystemId: string; enabled: boolean }
  | { kind: "model"; bindingKey: string; targetKey: string };

export function runtimeManagementCommand(
  catalog: ExternalRuntimeReviews,
  decision: RuntimeManagementDecision,
): { command: string; fields: Record<string, unknown>; key: string } | null {
  if (decision.kind === "item") {
    const item = catalog.items.find(row => row.kind === decision.assetKind && row.key === decision.itemKey);
    if (!item?.approval || !(decision.approved ? canEnableRuntimeItem(item) : canDisableRuntimeItem(item))) return null;
    const request = runtimeReviewCommand({ kind: "approval", item: item.approval, approved: decision.approved });
    return request && { ...request, key: item.key };
  }
  if (decision.kind === "model") {
    const binding = catalog.modelBindings.find(row => row.key === decision.bindingKey);
    const version = catalog.generation.subagent;
    if (!binding || !canEditRuntimeModelBinding(binding) || version === null) return null;
    const target = catalog.modelOptions.find(option => runtimeModelTargetKey(option.target) === decision.targetKey)?.target;
    if (!target && decision.targetKey !== "source") return null;
    return { key: binding.key, command: "set_external_subagent_model_binding_command",
      fields: { bindingKey: binding.key, target: target ?? null, expectedSubagentGeneration: version } };
  }
  const kind = decision.assetKind;
  const version = catalog.generation[kind];
  const items = runtimeBatchItems(catalog, kind, decision.ecosystemId, decision.enabled);
  if (version === null || !items.length) return null;
  const decisions = items.map(item => item.kind === "tool"
    ? { approvalKey: item.approvalKey, decisionKey: item.decisionKey }
    : { candidateId: item.id, decisionKey: item.decisionKey });
  const fields = { decisions, enabled: decision.enabled };
  const key = `runtime-batch:${kind}`;
  if (kind === "tool") return { key, command: "set_external_tool_targets_enabled_command",
    fields: { ...fields, expectedCatalogGeneration: version } };
  if (kind === "mcp") return { key, command: "set_external_mcp_servers_enabled_command",
    fields: { ...fields, expectedMcpGeneration: version } };
  return { key, command: "set_external_subagents_enabled_command",
    fields: { ...fields, expectedSubagentGeneration: version } };
}

export type RuntimeReviewDecision =
  | { kind: "approval"; item: RuntimeApproval; approved: boolean }
  | { kind: "conflict"; item: RuntimeConflict; candidateId: string };

export function runtimeReviewCommand(decision: RuntimeReviewDecision): { command: string; fields: Record<string, unknown> } | null {
  const item = decision.item;
  if (decision.kind === "approval") {
    const item = decision.item;
    const fields = { decisionKey: item.decisionKey, approved: decision.approved };
    if (item.kind === "tool") return { command: "set_external_tool_target_decision_command",
      fields: { ...fields, approvalKey: item.approvalKey } };
    if (item.generation === null) return null;
    return item.kind === "subagent"
      ? { command: "set_external_subagent_activation_command",
        fields: { ...fields, candidateId: item.id, expectedSubagentGeneration: item.generation } }
      : { command: "set_external_mcp_server_decision_command",
        fields: { ...fields, candidateId: item.id, expectedMcpGeneration: item.generation } };
  }
  const candidate = decision.item.candidates.find(option => option.id === decision.candidateId);
  const disableSubagent = decision.item.kind === "subagent" && decision.candidateId === DISABLED_SUBAGENT_CHOICE;
  if (!disableSubagent && !candidate?.available) return null;
  const fields = { conflictKey: decision.item.key, candidateId: decision.candidateId };
  if (item.kind === "command") return { command: "set_external_source_conflict_choice_command", fields };
  if (item.kind === "tool") return { command: "set_external_tool_conflict_choice_command", fields };
  if (decision.item.generation === null) return null;
  const approval = { ...fields, approveExternal: candidate?.external === true };
  return item.kind === "subagent"
    ? { command: "choose_external_subagent_conflict_command",
      fields: { ...approval, expectedSubagentGeneration: decision.item.generation } }
    : { command: "choose_external_mcp_conflict_command", fields: { ...approval, expectedMcpGeneration: decision.item.generation } };
}
