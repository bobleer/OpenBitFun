// Model pools: an ordered group of configured models a session can be bound to.
//
// The pools belong to the execution host and live in its main configuration, so
// this store owns no state of its own beyond the snapshot it just read and the
// draft being edited. A pool's members are `ai.models[].id` values, which is what
// the desktop editor puts in `member_model_ids`, and a draft with an empty id is
// how a new pool is created: the host allocates the stable id.

import { computed, signal } from "nsh";
import { fleetDeviceContext, invokeCommand } from "./bridge";
import { tr } from "./i18n";
import { errorText, invokeSettingsMutation, isMissingCommand } from "./settingsMutations";

export interface ModelPool {
  id: string;
  name: string;
  strategy: string;
  memberModelIds: string[];
}

export interface PoolMemberStatus {
  modelId: string;
  status: string;
  reason?: string;
}

export interface PoolDraft {
  id: string;
  name: string;
  strategy: string;
  members: string[];
}

interface PoolDocument {
  version?: number;
  pools?: unknown[];
}

export const pools = signal<ModelPool[]>([]);
/** `null` until the host has been asked; `false` means it has no pools at all. */
export const poolsSupported = signal<boolean | null>(null);
export const poolsLoading = signal(false);
export const poolsNotice = signal("");
export const poolDraft = signal<PoolDraft | null>(null);
export const poolStatuses = signal<Record<string, PoolMemberStatus[]>>({});
export const poolStatusLoading = signal<string | null>(null);
export const poolBusy = signal(false);
const poolDraftBaseline = signal<PoolDraft | null>(null);
export const poolDraftDirty = computed(() => Boolean(poolDraft()) && JSON.stringify(poolDraft()) !== JSON.stringify(poolDraftBaseline()));

/** The strategies the desktop editor offers, in its order. */
export const POOL_STRATEGIES = ["ordered", "balanced"] as const;

function readablePools(document: PoolDocument): ModelPool[] {
  const rows = Array.isArray(document?.pools) ? document.pools : [];
  const result: ModelPool[] = [];
  for (const value of rows) {
    const pool = value as Partial<{ id: string; name: string; strategy: string; member_model_ids: string[] }>;
    if (typeof pool?.id !== "string" || typeof pool?.name !== "string") continue;
    if (typeof pool?.strategy !== "string" || !Array.isArray(pool?.member_model_ids)) continue;
    if (!pool.member_model_ids.every(id => typeof id === "string")) continue;
    result.push({
      id: pool.id,
      name: pool.name,
      strategy: pool.strategy,
      memberModelIds: pool.member_model_ids,
    });
  }
  return result;
}

let poolDevice: string | null | undefined;
let scopeRevision = 0;
let listRequest = 0;
let statusRequest = 0;

function poolScope() {
  const target = fleetDeviceContext();
  const revision = scopeRevision;
  return { target, current: () => target === fleetDeviceContext() && revision === scopeRevision };
}

/** Reads the pools on first use and on a device change. */
export function ensurePools(): void {
  if (poolDevice !== fleetDeviceContext()) void loadPools();
}

export async function loadPools(): Promise<void> {
  const target = fleetDeviceContext();
  if (poolDevice !== target) {
    poolDevice = target;
    scopeRevision += 1;
    closePoolDraft();
    pools.set([]);
    poolStatuses.set({});
    poolsSupported.set(null);
    poolBusy.set(false);
    poolStatusLoading.set(null);
  }
  const scope = poolScope();
  const request = ++listRequest;
  const current = () => scope.current() && listRequest === request;
  poolsLoading.set(true);
  poolsNotice.set("");
  try {
    const document = await invokeCommand<PoolDocument>("get_model_pools", undefined, scope);
    if (current()) {
      pools.set(readablePools(document));
      poolsSupported.set(true);
    }
  } catch (error) {
    if (!current()) return;
    if (isMissingCommand(error, "get_model_pools")) poolsSupported.set(false);
    else poolsNotice.set(errorText(error));
  } finally {
    if (current()) poolsLoading.set(false);
  }
}

export function openPoolDraft(pool?: ModelPool): void {
  const draft = pool
    ? { id: pool.id, name: pool.name, strategy: pool.strategy, members: [...pool.memberModelIds] }
    : { id: "", name: "", strategy: "ordered", members: [] };
  poolDraftBaseline.set(draft);
  poolDraft.set(draft);
  poolsNotice.set("");
  if (pool) void loadPoolStatus(pool.id);
}

export function closePoolDraft(): void {
  statusRequest += 1;
  poolStatusLoading.set(null);
  poolDraft.set(null);
  poolDraftBaseline.set(null);
}

export function updatePoolDraft(patch: Partial<PoolDraft>): void {
  poolDraft.update(current => (current ? { ...current, ...patch } : current));
}

/** Adds a model to the draft when it is not already a member. */
export function togglePoolMember(modelId: string): void {
  poolDraft.update(current => {
    if (!current) return current;
    const members = current.members.includes(modelId)
      ? current.members.filter(id => id !== modelId)
      : [...current.members, modelId];
    return { ...current, members };
  });
}

/** Moves a member one place, which is what an ordered pool's priority is. */
export function movePoolMember(modelId: string, delta: number): void {
  poolDraft.update(current => {
    if (!current) return current;
    const index = current.members.indexOf(modelId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= current.members.length) return current;
    const members = [...current.members];
    const [moved] = members.splice(index, 1);
    members.splice(target, 0, moved);
    return { ...current, members };
  });
}

export function canSavePoolDraft(): boolean {
  const draft = poolDraft();
  return Boolean(draft?.name.trim()) && !poolBusy() && !poolsLoading() && poolDevice === fleetDeviceContext();
}

export async function savePoolDraft(): Promise<boolean> {
  const draft = poolDraft();
  if (!draft || !canSavePoolDraft()) return false;
  return mutatePools("save_model_pool", {
    pool: { id: draft.id, name: draft.name.trim(), strategy: draft.strategy, member_model_ids: draft.members },
  }, tr("settings.pools.saved", { name: draft.name.trim() }));
}

export async function deletePool(poolId: string): Promise<boolean> {
  return mutatePools("delete_model_pool", { poolId }, tr("settings.pools.deleted"));
}

async function mutatePools(command: "save_model_pool" | "delete_model_pool", request: Record<string, unknown>, notice: string): Promise<boolean> {
  if (poolBusy() || poolsLoading() || poolDevice !== fleetDeviceContext()) return false;
  const scope = poolScope();
  poolBusy.set(true);
  poolsNotice.set("");
  try {
    const document = await invokeSettingsMutation<PoolDocument>(command, request, scope);
    if (!scope.current()) return false;
    poolStatuses.set({});
    pools.set(readablePools(document));
    closePoolDraft();
    poolsNotice.set(notice);
    return true;
  } catch (error) {
    if (scope.current()) poolsNotice.set(errorText(error));
    return false;
  } finally {
    if (scope.current()) poolBusy.set(false);
  }
}

/** Checks a stored pool. An optional retry asks the host to reset that member first. */
async function loadPoolStatus(poolId: string, retryModelId?: string): Promise<void> {
  const scope = poolScope();
  const request = ++statusRequest;
  const current = () => scope.current() && statusRequest === request;
  poolStatusLoading.set(poolId);
  try {
    if (retryModelId) {
      await invokeSettingsMutation("retry_model_pool_member", { modelId: retryModelId }, scope);
      if (!current()) return;
    }
    const rows = await invokeSettingsMutation<Array<{ modelId?: string; model_id?: string; status?: string; reason?: string }>>(
      "get_model_pool_status", { poolId }, scope,
    );
    if (!current()) return;
    const statuses: PoolMemberStatus[] = [];
    for (const row of rows ?? []) {
      const modelId = row.modelId ?? row.model_id;
      if (modelId) statuses.push({ modelId, status: row.status ?? "unverified", reason: row.reason });
    }
    poolStatuses.update(value => ({ ...value, [poolId]: statuses }));
  } catch (error) {
    if (current()) poolsNotice.set(errorText(error));
  } finally {
    if (current()) poolStatusLoading.set(null);
  }
}

export async function retryPoolMember(modelId: string): Promise<void> {
  const draft = poolDraft();
  if (!draft?.id || !draft.members.includes(modelId) || poolBusy() || poolStatusLoading() || poolDevice !== fleetDeviceContext()) return;
  const scope = poolScope();
  poolBusy.set(true);
  poolsNotice.set("");
  try {
    await loadPoolStatus(draft.id, modelId);
  } finally {
    if (scope.current()) poolBusy.set(false);
  }
}
