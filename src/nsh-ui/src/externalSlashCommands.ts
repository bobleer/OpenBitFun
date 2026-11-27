import { signal } from "nsh";
import type { FreshExternalSubagentExecution } from "./api";
import { invokeCommand, type InvokeCommandOptions } from "./bridge";
import { isCommandMissing, parseOperationError } from "./externalImportStore";
import { tr } from "./i18n";

type Availability = { state: string; reason?: string };
type SourceKey = { providerId: string; sourceId: string };
type ExecutionTarget = { kind: "inline" } | FreshExternalSubagentExecution;

interface Catalog {
  discoveryPending?: boolean;
  preferenceRevision?: number;
  hostCapabilities?: { canExecuteExternalAssets?: boolean };
  sources?: { record: { key: SourceKey; displayName: string } }[];
  commands?: {
    candidateId?: string;
    definition: {
      id: { source: SourceKey };
      name: string;
      description?: string;
      contentVersion: string;
      availability: Availability;
      executionTarget?: ExecutionTarget;
    };
  }[];
  commandConflicts?: {
    conflictKey: string;
    commandName: string;
    selectedCandidateId?: string;
    candidates: {
      candidateId: string;
      sourceDisplayName: string;
      commandDescription?: string;
      contentVersion: string;
      availability: Availability;
      executionTarget?: ExecutionTarget;
    }[];
  }[];
}

export interface ExternalSlashItem {
  id: string;
  name: string;
  source: string;
  description?: string;
  version: string;
  availability: Availability;
  executionTarget?: ExecutionTarget;
  externalConflictKey?: string;
  selectedInCatalog?: boolean;
}

interface NativeDescriptor {
  commandName: string;
  candidateId: string;
  behaviorVersion: string;
}

export interface NativeSlashItem {
  descriptor: NativeDescriptor;
  label: string;
  description?: string;
  run: () => void | Promise<void>;
}

interface NativeConflicts {
  preferenceRevision: number;
  conflicts: { conflictKey: string; externalCandidateId: string; selectedCandidateId?: string }[];
  reconfirmations?: { nativeCandidateId: string }[];
}

export interface ShellReview {
  schemaVersion: number;
  planFingerprint: string;
  sourceDisplayName: string;
  workingDirectory: string;
  shellDisplayName: string;
  shellExecutable: string;
  commands: string[];
  canRemember: boolean;
  preferenceRevision: number;
}

type ReviewMode = "run_once" | "remember";
type Expansion = { state: "ready"; content: string; executionTarget: ExecutionTarget }
  | { state: "review_required"; review: ShellReview };

export interface ExternalSlashScope {
  pane: 0 | 1;
  key: string;
  workspaceId: string;
  workspaceRoot: string;
  route?: InvokeCommandOptions;
}

interface Submission {
  scope: ExternalSlashScope;
  current: () => boolean;
  native: () => Promise<NativeSlashItem[]>;
  pick?: { id: string; version?: string };
  line: { name: string; args: string };
  canSend: (target: ExecutionTarget) => boolean;
  send: (text: string, execution?: FreshExternalSubagentExecution) => Promise<void>;
  notice: (message: string) => void;
}

interface DialogChoice {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  pick: () => void;
}

type ExternalSlashDialog =
  | { kind: "choice"; name: string; options: DialogChoice[]; current: () => boolean }
  | { kind: "shell"; review: ShellReview; approve: (mode: ReviewMode) => void; current: () => boolean };

export const externalSlashDialog = signal<ExternalSlashDialog | null>(null);
const pendingSubmission = signal<Submission | null>(null);
export const externalSlashBusy = () => pendingSubmission()?.current() ?? false;
const catalogs = [signal<{ key: string; catalog: Catalog } | null>(null), signal<{ key: string; catalog: Catalog } | null>(null)] as const;
const requests: Partial<Record<0 | 1, { key: string; promise: Promise<Catalog | null> }>> = {};

const controlCommand = "get_external_source_control_snapshot";
const legacyCatalogCommand = "get_external_source_snapshot";
const nativeConflictsCommand = "get_native_prompt_command_conflicts_command";
const expandCommand = "expand_external_prompt_command_command";

function unsupported(command: string, error: unknown): boolean {
  return isCommandMissing(command, error) || parseOperationError(error)?.code === "host_capability_unavailable";
}

function call<T>(scope: ExternalSlashScope, command: string, args = {}): Promise<T> {
  return invokeCommand<T>(command, { workspaceId: scope.workspaceId, ...args }, scope.route);
}

function catalogItems(catalog: Catalog): ExternalSlashItem[] {
  const labels = new Map((catalog.sources ?? []).map(({ record }) => [
    JSON.stringify([record.key.providerId, record.key.sourceId]), record.displayName,
  ]));
  const items = new Map<string, ExternalSlashItem>();
  for (const entry of catalog.commands ?? []) {
    if (!entry.candidateId) continue;
    const { name, description, id: { source }, contentVersion, availability, executionTarget } = entry.definition;
    items.set(entry.candidateId, {
      id: entry.candidateId, name, description, version: contentVersion, availability, executionTarget,
      source: labels.get(JSON.stringify([source.providerId, source.sourceId])) ?? source.providerId,
    });
  }
  for (const conflict of catalog.commandConflicts ?? []) {
    for (const candidate of conflict.candidates) {
      items.set(candidate.candidateId, {
        id: candidate.candidateId, name: conflict.commandName, source: candidate.sourceDisplayName,
        description: candidate.commandDescription, version: candidate.contentVersion,
        availability: candidate.availability, executionTarget: candidate.executionTarget,
        externalConflictKey: conflict.conflictKey,
        selectedInCatalog: conflict.selectedCandidateId === candidate.candidateId,
      });
    }
  }
  return Array.from(items.values()).sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}

async function fetchCatalog(scope: ExternalSlashScope): Promise<Catalog | null> {
  try {
    const reply = await call<{ catalog: Catalog }>(scope, controlCommand);
    if (reply?.catalog) return reply.catalog.hostCapabilities?.canExecuteExternalAssets === false ? null : reply.catalog;
  } catch (error) {
    if (!unsupported(controlCommand, error)) throw error;
  }
  try {
    const catalog = await call<Catalog>(scope, legacyCatalogCommand);
    if (catalog?.hostCapabilities?.canExecuteExternalAssets === false) return null;
    return catalog ?? null;
  } catch (error) {
    if (!unsupported(legacyCatalogCommand, error)) throw error;
    return null;
  }
}

function readCatalog(scope: ExternalSlashScope): Promise<Catalog | null> {
  const request = requests[scope.pane];
  if (request?.key === scope.key) return request.promise;
  const promise = fetchCatalog(scope).then(catalog => {
    if (requests[scope.pane]?.promise === promise) {
      catalogs[scope.pane].set(catalog ? { key: scope.key, catalog } : null);
    }
    return catalog;
  }).finally(() => {
    if (requests[scope.pane]?.promise === promise) delete requests[scope.pane];
  });
  requests[scope.pane] = { key: scope.key, promise };
  return promise;
}

export function prefetchExternalSlashCatalog(scope: ExternalSlashScope, first: boolean): void {
  const entry = catalogs[scope.pane]();
  if (!first && (entry?.key !== scope.key || !entry.catalog.discoveryPending)) return;
  void readCatalog(scope).catch(() => undefined);
}

export function externalSlashMatches(scope: ExternalSlashScope | null, draft: string): ExternalSlashItem[] {
  if (!scope || !/^\/\S*$/.test(draft)) return [];
  const entry = catalogs[scope.pane]();
  if (entry?.key !== scope.key) return [];
  const query = draft.slice(1).toLowerCase();
  return catalogItems(entry.catalog).filter(item => item.name.toLowerCase().includes(query));
}

export function resetExternalSlashCatalog(pane: 0 | 1): void {
  delete requests[pane];
  catalogs[pane].set(null);
}

export function externalSlashInvocation(draft: string): Submission["line"] | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(draft.trim());
  return match ? { name: match[1]!.toLowerCase(), args: match[2] ?? "" } : null;
}

export function dismissExternalSlashDialog(): void {
  externalSlashDialog.set(null);
}

async function withSubmission(submission: Submission, action: () => Promise<void>): Promise<void> {
  if (externalSlashBusy() || !submission.current()) return;
  pendingSubmission.set(submission);
  try {
    await action();
  } catch (error) {
    if (!submission.current()) return;
    const detail = parseOperationError(error)?.detail;
    submission.notice(detail || (error instanceof Error ? error.message : String(error)));
  } finally {
    if (pendingSubmission() === submission) pendingSubmission.set(null);
  }
}

function promptChoice(submission: Submission, picked: string): void {
  if (!submission.current()) return;
  dismissExternalSlashDialog();
  void submitExternalSlash({ ...submission, pick: { id: picked } });
}

async function expand(
  submission: Submission,
  item: ExternalSlashItem,
  nativeCommands: NativeDescriptor[],
  conflicts: NativeConflicts | undefined,
  previous?: ShellReview,
  mode?: ReviewMode,
): Promise<void> {
  if (!submission.current()) return;
  if (item.executionTarget && !submission.canSend(item.executionTarget)) return;
  const guard = conflicts?.conflicts.find(entry => entry.externalCandidateId === item.id);
  const reply = await call<Expansion>(submission.scope, expandCommand, {
    name: item.name,
    arguments: submission.line.args,
    candidateId: item.id,
    expectedContentVersion: item.version,
    nativeCommands,
    ...(guard && conflicts ? {
      expectedNativeConflictKey: guard.conflictKey,
      expectedPreferenceRevision: conflicts.preferenceRevision,
    } : {}),
    ...(previous && mode ? { shellReviewDecision: {
      planFingerprint: previous.planFingerprint,
      expectedPreferenceRevision: previous.preferenceRevision,
      mode,
    } } : {}),
  });
  if (!submission.current()) return;
  if (reply.state === "review_required") {
    const review = reply.review;
    if (review.schemaVersion !== 1 || previous?.planFingerprint === review.planFingerprint) {
      submission.notice(tr("chat.externalSlash.changed"));
      return;
    }
    externalSlashDialog.set({
      kind: "shell", review, current: submission.current,
      approve: decision => {
        if (decision === "remember" && !review.canRemember) return;
        dismissExternalSlashDialog();
        void withSubmission(submission, () => expand(submission, item, nativeCommands, conflicts, review, decision));
      },
    });
    return;
  }
  if (reply.state !== "ready" || !reply.content.trim() || !["inline", "fresh_external_subagent"].includes(reply.executionTarget.kind)) {
    submission.notice(tr("chat.externalSlash.changed"));
    return;
  }
  if (submission.canSend(reply.executionTarget)) {
    await submission.send(reply.content, reply.executionTarget.kind === "fresh_external_subagent" ? reply.executionTarget : undefined);
  }
}

/** Returns true when the command was handled or deliberately held for a decision. */
export async function submitExternalSlash(submission: Submission): Promise<boolean> {
  if (externalSlashBusy() || externalSlashDialog()) return true;
  const { scope, line, pick } = submission;
  let handled = true;
  await withSubmission(submission, async () => {
    const seen = catalogs[scope.pane]();
    const wasExternal = seen?.key === scope.key && catalogItems(seen.catalog)
      .some(item => item.name.toLowerCase() === line.name);
    const catalog = await readCatalog(scope);
    if (!submission.current()) return;
    if (!catalog && !wasExternal && !pick?.version) {
      handled = false;
      return;
    }
    const native = await submission.native();
    if (!submission.current()) return;
    const nativeCommands = native.map(item => item.descriptor);
    const items = catalog ? catalogItems(catalog).filter(item => item.name.toLowerCase() === line.name) : [];
    if (catalog?.discoveryPending && !native.length && !items.length && !pick) {
      submission.notice(tr("chat.externalSlash.loading"));
      return;
    }
    let conflicts: NativeConflicts | undefined;
    if (catalog && native.length) {
      try {
        conflicts = await call<NativeConflicts>(scope, nativeConflictsCommand, { nativeCommands });
      } catch (error) {
        if (!unsupported(nativeConflictsCommand, error)) throw error;
        if (!items.length && !pick?.version) {
          handled = false;
          return;
        }
        submission.notice(tr("chat.externalSlash.hostUnavailable"));
        return;
      }
      if (!submission.current()) return;
    }
    const nativeChoice = native.find(item => item.descriptor.candidateId === pick?.id);
    const selectedId = pick?.id ?? conflicts?.conflicts.find(entry => entry.selectedCandidateId)?.selectedCandidateId;
    const selectedNative = nativeChoice ?? native.find(item => item.descriptor.candidateId === selectedId);
    const reconfirm = conflicts?.reconfirmations?.length;
    if (selectedNative) {
      const id = selectedNative.descriptor.candidateId;
      if (conflicts && (conflicts.reconfirmations?.some(entry => entry.nativeCandidateId === id)
        || conflicts.conflicts.some(entry => entry.selectedCandidateId !== id))) {
        await call(scope, "set_native_prompt_command_conflict_choice_command", {
          nativeCommands, selectedCandidateId: id, expectedPreferenceRevision: conflicts.preferenceRevision,
        });
      }
      if (submission.current()) await selectedNative.run();
      return;
    }
    if (!items.length && !reconfirm) {
      if (wasExternal || (pick && !nativeChoice)) submission.notice(tr("chat.externalSlash.changed"));
      else handled = false;
      return;
    }
    if (native.length && items.length && !conflicts?.conflicts.length) {
      submission.notice(tr("chat.externalSlash.changed"));
      return;
    }
    const item = selectedId ? items.find(entry => entry.id === selectedId)
      : !native.length ? items.find(entry => entry.selectedInCatalog) ?? (items.length === 1 ? items[0] : undefined)
        : undefined;
    if (pick && (!item || (pick.version && pick.version !== item.version))) {
      submission.notice(tr("chat.externalSlash.changed"));
      return;
    }
    if (!item) {
      externalSlashDialog.set({
        kind: "choice", name: line.name, current: submission.current,
        options: [
          ...native.map(entry => ({
            id: entry.descriptor.candidateId, label: entry.label, description: entry.description,
            pick: () => promptChoice(submission, entry.descriptor.candidateId),
          })),
          ...items.map(entry => ({
            id: entry.id, label: entry.source, description: externalSlashItemDetail(entry),
            disabled: entry.availability.state !== "available",
            pick: () => {
              if (!submission.current()) return;
              dismissExternalSlashDialog();
              void submitExternalSlash({ ...submission, pick: { id: entry.id, version: entry.version } });
            },
          })),
        ],
      });
      return;
    }
    if (item.availability.state !== "available") {
      submission.notice(externalSlashItemDetail(item));
      return;
    }
    if (item.executionTarget && !submission.canSend(item.executionTarget)) return;
    if (item.externalConflictKey && !item.selectedInCatalog) {
      await call<Catalog>(scope, "set_external_source_conflict_choice_command", {
        conflictKey: item.externalConflictKey, candidateId: item.id, expectedPreferenceRevision: catalog?.preferenceRevision ?? 0,
      });
      if (!submission.current()) return;
      if (conflicts) conflicts = await call<NativeConflicts>(scope, nativeConflictsCommand, { nativeCommands });
    }
    if (!submission.current()) return;
    if (conflicts) {
      const guard = conflicts.conflicts.find(entry => entry.externalCandidateId === item.id);
      if (!guard) {
        submission.notice(tr("chat.externalSlash.changed"));
        return;
      }
      if (guard.selectedCandidateId !== item.id) {
        conflicts = await call<NativeConflicts>(scope, "set_native_prompt_command_conflict_choice_command", {
          nativeCommands, selectedCandidateId: item.id, expectedPreferenceRevision: conflicts.preferenceRevision,
        });
        if (!conflicts.conflicts.some(entry => entry.externalCandidateId === item.id && entry.selectedCandidateId === item.id)) {
          submission.notice(tr("chat.externalSlash.changed"));
          return;
        }
      }
    }
    await expand(submission, item, nativeCommands, conflicts);
  });
  return handled || !submission.current();
}

export function externalSlashItemDetail(item: ExternalSlashItem): string {
  return item.availability.state === "available" ? item.description ?? ""
    : item.availability.reason || tr("chat.externalSlash.restricted");
}
