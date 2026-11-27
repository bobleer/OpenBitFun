import { invokeCommand, type InvokeCommandOptions } from "./bridge";
import { isCommandMissing } from "./externalImportStore";

interface HookSourceKey {
  providerId: string;
  sourceId: string;
}

export interface ExternalHookSource {
  key: HookSourceKey;
  ecosystemId: string;
  displayName: string;
  locationHint: string;
  scope: string;
  contentVersion?: string;
  diagnostics?: HookDiagnostic[];
}

interface HookDiagnostic {
  source?: HookSourceKey;
  message: string;
}

interface ExternalHookCatalog {
  schemaVersion: number;
  discoveryPending: boolean;
  sources: ExternalHookSource[];
  providers: Array<{ providerId: string; ecosystemId: string }>;
  staleProviderIds?: string[];
  failedProviderIds?: string[];
  diagnostics?: HookDiagnostic[];
}

export interface ImportedHook {
  importId: string;
  source: ExternalHookSource;
  enabled: boolean;
  state: string;
}

export interface ExternalHookSnapshot {
  catalog: ExternalHookCatalog;
  imports: ImportedHook[];
  revision: string | null;
  diagnostics?: HookDiagnostic[];
}

type HookDependency = { kind: "managed"; relativePath: string } | { kind: "external"; location: string };

export interface ExternalHookPlan {
  schemaVersion: number;
  source: ExternalHookSource;
  disposition: string;
  behaviorVersion?: string;
  planFingerprint: string;
  handlers: Array<{
    stableKey: string;
    event: string;
    matcher?: string;
    command: string;
    commandWindows?: string;
    timeoutSeconds?: number;
    statusMessage?: string;
    dependencies?: HookDependency[];
  }>;
  skipped: Array<{ reasonCode: string; count: number }>;
}

type HookApplyOutcome =
  | { kind: "applied" | "unchanged"; snapshot: ExternalHookSnapshot }
  | { kind: "stale"; refreshedPlan: ExternalHookPlan };

export type HookMutation = { kind: "set_enabled"; importId: string; enabled: boolean } | { kind: "remove"; importId: string };
type WorkspaceFields = Readonly<Record<string, string>>;

export function hookSourceId(key: HookSourceKey): string {
  return JSON.stringify([key.providerId, key.sourceId]);
}

/** A preceding batch write may advance the target revision without changing the reviewed commands. */
export function sameReviewedHookBehavior(reviewed: ExternalHookPlan, fresh: ExternalHookPlan): boolean {
  return (reviewed.planFingerprint === fresh.planFingerprint || Boolean(reviewed.behaviorVersion && reviewed.source.contentVersion))
    && reviewed.behaviorVersion === fresh.behaviorVersion
    && reviewed.source.contentVersion === fresh.source.contentVersion
    && reviewed.disposition === fresh.disposition
    && reviewed.source.scope === fresh.source.scope
    && reviewed.source.locationHint === fresh.source.locationHint
    && JSON.stringify(reviewed.handlers) === JSON.stringify(fresh.handlers)
    && JSON.stringify(reviewed.skipped) === JSON.stringify(fresh.skipped);
}

function validCatalog(catalog: ExternalHookCatalog | undefined): catalog is ExternalHookCatalog {
  return catalog?.schemaVersion === 1 && Array.isArray(catalog.sources) && Array.isArray(catalog.providers);
}

function checkedSnapshot(raw: ExternalHookSnapshot & { schemaVersion?: number }): ExternalHookSnapshot {
  if (raw?.schemaVersion !== 1 || typeof raw.revision !== "string" || !raw.revision
    || !validCatalog(raw.catalog) || !Array.isArray(raw.imports)) throw new Error("invalid_response");
  return raw;
}

function checkedPlan(plan: ExternalHookPlan, source: ExternalHookSource): ExternalHookPlan {
  if (plan?.schemaVersion !== 1 || !plan.source?.key || plan.source.ecosystemId !== source.ecosystemId
    || hookSourceId(plan.source.key) !== hookSourceId(source.key)
    || typeof plan.planFingerprint !== "string" || !plan.planFingerprint
    || !Array.isArray(plan.handlers) || !Array.isArray(plan.skipped)
    || plan.handlers.some(handler => !handler?.stableKey || typeof handler.event !== "string"
      || typeof handler.command !== "string" || !handler.command.trim()
      || (handler.commandWindows !== undefined && typeof handler.commandWindows !== "string")
      || (handler.dependencies !== undefined && !Array.isArray(handler.dependencies))
      || handler.dependencies?.some(dep => (
        dep?.kind === "managed" ? typeof dep.relativePath !== "string"
          : dep?.kind !== "external" || typeof dep.location !== "string"
      )))) throw new Error("invalid_response");
  return plan;
}

export async function readExternalHooks(workspace: WorkspaceFields, refresh: boolean, route?: InvokeCommandOptions): Promise<ExternalHookSnapshot> {
  try {
    return checkedSnapshot(await invokeCommand("get_external_hook_import_snapshot", { ...workspace, refreshUpdates: refresh }, route));
  } catch (error) {
    if (!isCommandMissing("get_external_hook_import_snapshot", error)) throw error;
  }
  const catalog = await invokeCommand<ExternalHookCatalog>("get_external_hook_catalog", { ...workspace, forceRefresh: refresh }, route);
  if (!validCatalog(catalog)) throw new Error("invalid_response");
  return { catalog, revision: null, imports: [] };
}

export async function planExternalHook(workspace: WorkspaceFields, source: ExternalHookSource, route?: InvokeCommandOptions): Promise<ExternalHookPlan> {
  return checkedPlan(await invokeCommand("plan_external_hook_import_command", { ...workspace, source: source.key }, route), source);
}

export async function applyExternalHook(workspace: WorkspaceFields, plan: ExternalHookPlan, route?: InvokeCommandOptions): Promise<HookApplyOutcome> {
  const result = await invokeCommand<{ schemaVersion: number; outcome: HookApplyOutcome }>(
    "apply_external_hook_import_command",
    { ...workspace, importRequest: { schemaVersion: 1, source: plan.source.key, planFingerprint: plan.planFingerprint } },
    route,
  );
  if (result?.schemaVersion !== 1) throw new Error("invalid_response");
  const outcome = result.outcome;
  if (outcome?.kind === "stale") return { ...outcome, refreshedPlan: checkedPlan(outcome.refreshedPlan, plan.source) };
  if (outcome?.kind === "applied" || outcome?.kind === "unchanged") {
    return { ...outcome, snapshot: checkedSnapshot(outcome.snapshot) };
  }
  throw new Error("invalid_response");
}

export async function mutateExternalHook(workspace: WorkspaceFields, revision: string, action: HookMutation, route?: InvokeCommandOptions): Promise<ExternalHookSnapshot> {
  return checkedSnapshot(await invokeCommand("mutate_external_hook_import_command", {
    ...workspace, mutation: { schemaVersion: 1, expectedRevision: revision, action },
  }, route));
}
