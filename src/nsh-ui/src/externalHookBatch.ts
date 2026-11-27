import type { InvokeCommandOptions } from "./bridge";
import { applyExternalHook, mutateExternalHook, planExternalHook, sameReviewedHookBehavior,
  type ExternalHookPlan, type ExternalHookSnapshot, type ExternalHookSource, type ImportedHook } from "./externalHookImport";
import { parseOperationError } from "./externalImportStore";
import { localizeHostError } from "./i18n";

export type ExternalBatchMode = "import" | "remove";
export type HookBatchStatus = "ready" | "skipped" | "stale" | "saved" | "removed" | "failed";

export interface HookBatchEntry {
  source: ExternalHookSource;
  plan?: ExternalHookPlan;
  imported?: ImportedHook;
  checked: boolean;
  status: HookBatchStatus;
  detail?: string;
}

interface HookBatchScope {
  workspace: Readonly<Record<string, string>>;
  route?: InvokeCommandOptions;
  current: () => boolean;
}

export function canApplyHook(plan: ExternalHookPlan): boolean {
  return (plan.disposition === "import" || plan.disposition === "update") && plan.handlers.length > 0;
}

export function hookBatchSelectable(entry: HookBatchEntry): boolean {
  return entry.status === "ready" || (entry.status === "stale" && Boolean(entry.plan && canApplyHook(entry.plan)));
}

function hookErrorDetail(error: unknown): string | undefined {
  const detail = parseOperationError(error)?.detail;
  return detail ? localizeHostError(detail) : undefined;
}

export async function planHookBatch(sources: readonly ExternalHookSource[], scope: HookBatchScope): Promise<HookBatchEntry[]> {
  const entries: HookBatchEntry[] = [];
  for (const source of sources) {
    if (!scope.current()) break;
    try {
      const plan = await planExternalHook(scope.workspace, source, scope.route);
      const checked = canApplyHook(plan);
      entries.push({ source: plan.source, plan, checked, status: checked ? "ready" : "skipped" });
    } catch (error) {
      entries.push({ source, checked: false, status: "failed", detail: hookErrorDetail(error) });
    }
  }
  return entries;
}

/** A batch may advance its own revisions. Unrelated edits still require a new review. */
export async function applyHookBatch(options: HookBatchScope & {
  mode: ExternalBatchMode;
  revision: string;
  entries: readonly HookBatchEntry[];
  publish: (snapshot: ExternalHookSnapshot) => void;
  update: (entry: HookBatchEntry, patch: Partial<HookBatchEntry>) => void;
}): Promise<boolean> {
  let revision = options.revision;
  let ownImportApplied = options.entries.some(entry => entry.status === "saved");
  let removalNeedsRefresh = false;
  const chosen = options.entries.filter(entry => entry.checked && hookBatchSelectable(entry));
  for (const entry of chosen) {
    if (!options.current()) break;
    const finish = (status: HookBatchStatus, patch?: Partial<HookBatchEntry>) =>
      options.update(entry, { checked: false, status, ...patch });
    if (removalNeedsRefresh) {
      finish("stale");
      continue;
    }
    try {
      if (entry.imported && options.mode === "remove") {
        const next = await mutateExternalHook(options.workspace, revision, { kind: "remove", importId: entry.imported.importId }, options.route);
        if (!options.current()) break;
        if (!next.revision) throw new Error("invalid_response");
        revision = next.revision;
        options.publish(next);
        finish("removed");
      } else if (entry.plan && options.mode === "import") {
        let plan = entry.plan;
        if (ownImportApplied) {
          const fresh = await planExternalHook(options.workspace, entry.source, options.route);
          if (!options.current()) break;
          if (!sameReviewedHookBehavior(plan, fresh)) {
            finish("stale", { plan: fresh });
            continue;
          }
          plan = fresh;
        }
        const result = await applyExternalHook(options.workspace, plan, options.route);
        if (!options.current()) break;
        if (result.kind === "stale") {
          finish("stale", { plan: result.refreshedPlan });
          continue;
        }
        ownImportApplied ||= result.kind === "applied";
        options.publish(result.snapshot);
        finish("saved");
      }
    } catch (error) {
      if (!options.current()) break;
      if (options.mode === "remove" && parseOperationError(error)?.code === "stale_revision") {
        finish("stale");
        removalNeedsRefresh = true;
      } else {
        finish("failed", { detail: hookErrorDetail(error) });
      }
    }
  }
  return removalNeedsRefresh;
}
