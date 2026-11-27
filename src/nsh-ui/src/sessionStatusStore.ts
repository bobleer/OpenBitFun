// What each session row states about itself.
//
// The desktop list marks a row that is running, waiting for approval, holding a
// queued message, or has something the user has not read yet. Running, approval
// and queued come from live events and the host queue. Unread and failed are the
// host's: it records an unread receipt when a turn settles and every client reads
// it from the session page (`unread` / `failed`), so two clients mark the same
// rows. Opening a session acknowledges that receipt on the host
// (`mark_session_seen`); nothing about it is kept in this surface's storage.

import { tr } from "./i18n";
import { computed, signal } from "nsh";
import { markSessionSeenOnHost, type SessionSummary } from "./api";
import { fleetActive } from "./bridge";
import { fleetSessionOwners, fleetSessionRow } from "./fleetStore";
import { pendingPermissions } from "./permissionStore";
import {
  activeSessionDevice,
  activeSessionId,
  activeWorkspaceId,
  deviceContext,
  runningTurns,
  secondarySessionDevice,
  secondarySessionId,
  secondaryWorkspaceId,
  sessionKey,
  sessions,
  splitPaneOpen,
} from "./state";

export type SessionStatusKind = "running" | "approval" | "queued" | "unread" | "failed";

export interface SessionStatusMark {
  kind: SessionStatusKind;
  label: string;
}

/**
 * `sessionKey` → when this surface acknowledged the session on the host. A row the
 * list still reports as unread is read once its newest activity is not newer than
 * this, which covers a list read that raced the acknowledgement and cross-host clock skew.
 */
export const acknowledgedAt = signal<Record<string, number>>({});
/** `sessionKey` → a failure a live turn event reported before the next list read. */
export const failedAt = signal<Record<string, number>>({});
/** Sessions the host queue reported rows for, keyed by `sessionKey` or bare session id, with their count. */
export const queuedCounts = signal<Record<string, number>>({});

/** In-flight `mark_session_seen` count per `sessionKey`, avoiding duplicate concurrent calls. */
const seenInFlight = new Map<string, number>();
/** Last activity stamp (`ms`) that the host confirmed cleared (`changed: true`). */
const hostClearedActivity = new Map<string, number>();
/** Last activity stamp (`ms`) for which we sent an acknowledgement after observing `unread`/`failed`. */
const unreadAckAttemptedActivity = new Map<string, number>();

/** O(1) index of fleet session id → owning device id (the fleet store's, rebuilt only when `fleetDevices()` changes). */
const fleetOwnerBySession = fleetSessionOwners;

function resolveDeviceOf(sessionId: string, deviceId?: string): string {
  if (!fleetActive()) return "";
  if (deviceId !== undefined) return deviceId;
  if (sessionId === activeSessionId() && activeSessionDevice()) return activeSessionDevice();
  if (splitPaneOpen() && sessionId === secondarySessionId() && secondarySessionDevice()) {
    return secondarySessionDevice();
  }
  return fleetOwnerBySession().get(sessionId) ?? deviceContext();
}

function statusKeyOf(sessionId: string, deviceId?: string): string {
  return `${resolveDeviceOf(sessionId, deviceId)}/${sessionId}`;
}

function resolveWorkspaceOf(sessionId: string, device: string, explicitWorkspaceId?: string): string | undefined {
  if (explicitWorkspaceId) return explicitWorkspaceId;
  const localRow = sessions().find(
    row => row.sessionId === sessionId && (!fleetActive() || !row.deviceId || row.deviceId === device),
  );
  if (localRow?.workspaceId) return localRow.workspaceId;
  if (fleetActive()) {
    const fleetRow = fleetSessionRow(device, sessionId);
    if (fleetRow?.workspaceId) return fleetRow.workspaceId;
  }
  if (sessionId === activeSessionId() && (!fleetActive() || !activeSessionDevice() || activeSessionDevice() === device)) {
    return activeWorkspaceId() ?? undefined;
  }
  if (
    splitPaneOpen() &&
    sessionId === secondarySessionId() &&
    (!fleetActive() || !secondarySessionDevice() || secondarySessionDevice() === device)
  ) {
    return secondaryWorkspaceId() ?? undefined;
  }
  return undefined;
}

function resolveActivityOf(sessionId: string, device: string, explicitActivityMs?: number): number {
  let activity = typeof explicitActivityMs === "number" && Number.isFinite(explicitActivityMs) ? explicitActivityMs : 0;
  const localRow = sessions().find(
    row => row.sessionId === sessionId && (!fleetActive() || !row.deviceId || row.deviceId === device),
  );
  const localMs = localRow?.lastActiveAt ?? localRow?.lastUpdated ?? 0;
  if (localMs > activity) activity = localMs;
  if (fleetActive()) {
    const fleetMs = fleetSessionRow(device, sessionId)?.lastActivityMs ?? 0;
    if (fleetMs > activity) activity = fleetMs;
  }
  return activity;
}

function reconcileOneVisibleRow(
  sessionId: string,
  device: string,
  workspaceId: string | undefined,
  unread: boolean,
  failed: boolean,
  activityMs: number,
): void {
  const key = `${device}/${sessionId}`;
  if (!unread && !failed) {
    unreadAckAttemptedActivity.delete(key);
    hostClearedActivity.delete(key);
    return;
  }
  if ((seenInFlight.get(key) ?? 0) > 0) return;
  if ((hostClearedActivity.get(key) ?? -1) >= activityMs && activityMs > 0) return;
  if (unreadAckAttemptedActivity.get(key) === activityMs) return;
  markSessionSeen(sessionId, activityMs, device, workspaceId, { observedUnread: true });
}

/**
 * Called after every session list read: acknowledges any visible session
 * (primary or secondary split pane) whose result the host recorded as unread
 * while it was on screen.
 */
export function reconcileSessionReadState(rows: ReadonlyArray<SessionSummary>): void {
  const visible: Array<{ id: string; device: string }> = [];
  const open = activeSessionId();
  if (open) visible.push({ id: open, device: fleetActive() ? activeSessionDevice() : "" });
  if (splitPaneOpen()) {
    const sec = secondarySessionId();
    if (sec) visible.push({ id: sec, device: fleetActive() ? secondarySessionDevice() : "" });
  }
  for (const target of visible) {
    const row = rows.find(
      item => item.sessionId === target.id && (!fleetActive() || !item.deviceId || item.deviceId === target.device),
    );
    if (!row) continue;
    const device = resolveDeviceOf(row.sessionId, row.deviceId ?? target.device);
    const activityMs = row.lastActiveAt ?? row.lastUpdated ?? 0;
    reconcileOneVisibleRow(row.sessionId, device, row.workspaceId, Boolean(row.unread), Boolean(row.failed), activityMs);
  }
}

/**
 * Reconciles every visible session (both primary and secondary split panes,
 * regardless of which device or workspace is currently selected) against the
 * latest fleet navigator rows.
 */
export function reconcileVisibleFleetReadState(): void {
  if (!fleetActive()) return;
  const visible: Array<{ id: string; device: string }> = [];
  const open = activeSessionId();
  if (open) visible.push({ id: open, device: activeSessionDevice() });
  if (splitPaneOpen()) {
    const sec = secondarySessionId();
    if (sec) visible.push({ id: sec, device: secondarySessionDevice() });
  }
  for (const target of visible) {
    if (!target.device) continue;
    const row = fleetSessionRow(target.device, target.id);
    if (!row) continue;
    reconcileOneVisibleRow(
      row.sessionId,
      target.device,
      row.workspaceId,
      Boolean(row.unread),
      Boolean(row.failed || row.status === "error"),
      row.lastActivityMs ?? 0,
    );
  }
}

function isAcknowledgedByMap(
  sessionId: string,
  lastActivityMs: number,
  acknowledged: Record<string, number>,
  deviceId?: string,
): boolean {
  const key = statusKeyOf(sessionId, deviceId);
  const at = acknowledged[key] ?? (!fleetActive() ? acknowledged[sessionId] : undefined);
  if (at === undefined) return false;
  return lastActivityMs <= at;
}

function isAcknowledged(row: SessionSummary, acknowledged: Record<string, number>, deviceId?: string): boolean {
  return isAcknowledgedByMap(
    row.sessionId,
    row.lastActiveAt ?? row.lastUpdated ?? 0,
    acknowledged,
    deviceId ?? row.deviceId,
  );
}

/** Reactive helper: whether `sessionId` on `deviceId` was acknowledged through `lastActivityMs`. */
export function isSessionAcknowledged(
  sessionId: string,
  lastActivityMs?: number,
  deviceId?: string,
): boolean {
  return isAcknowledgedByMap(sessionId, lastActivityMs ?? 0, acknowledgedAt(), deviceId);
}

/**
 * Acknowledges a session on the host for every client. The row is drawn as read
 * right away; the next list read or fleet digest carries the host's own answer.
 */
export function markSessionSeen(
  sessionId: string,
  lastActivityMs?: number,
  deviceId?: string,
  workspaceId?: string,
  options?: { observedUnread?: boolean },
): void {
  const device = resolveDeviceOf(sessionId, deviceId);
  const key = `${device}/${sessionId}`;
  const resolvedWorkspaceId = resolveWorkspaceOf(sessionId, device, workspaceId);
  const rowActivity = resolveActivityOf(sessionId, device, lastActivityMs);
  // Cover remote host clock skew: acknowledging a row with `rowActivity`
  // ahead of our local clock must still mark that activity as read.
  const stamp = Math.max(Date.now(), rowActivity);
  acknowledgedAt.update(current => {
    const held = current[key] ?? 0;
    if (held >= stamp) return current;
    return { ...current, [key]: stamp };
  });
  failedAt.update(current => {
    if (!(key in current) && !(sessionId in current)) return current;
    const next = { ...current };
    delete next[key];
    if (!fleetActive()) delete next[sessionId];
    return next;
  });

  const fleetRow = fleetActive() ? fleetSessionRow(device, sessionId) : null;
  const localRow = sessions().find(
    row => row.sessionId === sessionId && (!fleetActive() || !row.deviceId || row.deviceId === device),
  );
  const currentlyUnread = Boolean(
    options?.observedUnread ||
      fleetRow?.unread ||
      fleetRow?.failed ||
      fleetRow?.status === "error" ||
      localRow?.unread ||
      localRow?.failed,
  );
  if (currentlyUnread) {
    unreadAckAttemptedActivity.set(key, rowActivity);
  }

  const target = fleetActive() && device ? { target: device } : undefined;
  seenInFlight.set(key, (seenInFlight.get(key) ?? 0) + 1);
  void markSessionSeenOnHost(
    { sessionId, ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}) },
    target,
  )
    .then(result => {
      if (result?.changed) {
        hostClearedActivity.set(key, Math.max(hostClearedActivity.get(key) ?? 0, rowActivity));
      }
    })
    .catch(() => undefined)
    .finally(() => {
      const next = (seenInFlight.get(key) ?? 1) - 1;
      if (next <= 0) seenInFlight.delete(key);
      else seenInFlight.set(key, next);
    });
}

/** A failure a live turn event reported, shown until the next list read says so too. */
export function markSessionFailed(sessionId: string, deviceId?: string): void {
  const key = statusKeyOf(sessionId, deviceId);
  failedAt.update(current => ({ ...current, [key]: Date.now() }));
}

/** O(1) index of sessions waiting for approval (`"<deviceId>/<sessionId>"`). */
const approvalSessionKeys = computed<Set<string>>(() => {
  const keys = new Set<string>();
  for (const request of pendingPermissions()) {
    if (!request.sessionId) continue;
    keys.add(`${fleetActive() ? request.deviceId : ""}/${request.sessionId}`);
  }
  return keys;
});

/** O(1) index of the active workspace's session rows by `"<deviceId>/<sessionId>"`, cached by array identity to avoid a module-init cycle with `state.ts`. */
let cachedRowsRef: ReadonlyArray<SessionSummary> | null = null;
let cachedRowsCtx = "";
let cachedRowsActive = false;
let cachedRowsMap = new Map<string, SessionSummary>();

function getSessionRowsByKey(
  rows: ReadonlyArray<SessionSummary>,
  active: boolean,
  ctx: string,
): Map<string, SessionSummary> {
  if (rows === cachedRowsRef && active === cachedRowsActive && ctx === cachedRowsCtx) {
    return cachedRowsMap;
  }
  const map = new Map<string, SessionSummary>();
  for (const row of rows) {
    const device = active ? (row.deviceId ?? ctx) : "";
    map.set(`${device}/${row.sessionId}`, row);
  }
  cachedRowsRef = rows;
  cachedRowsActive = active;
  cachedRowsCtx = ctx;
  cachedRowsMap = map;
  return map;
}

type StatusOfSessionFn = (
  sessionId: string,
  lastActivityMs?: number,
  messageCount?: number,
  deviceId?: string,
) => SessionStatusMark | null;

/**
 * The mark one row shows, matching backend fleet roll-up priority:
 * approval (`needs_you`) ranks above `running`, then queued, failed, unread.
 *
 * Reads the underlying signals directly (rather than caching a lazily-created
 * `computed` that would bind to and be disposed with the first mounted scene,
 * or creating a top-level `computed` that would hit a module-init cycle with
 * `state.ts`). Heavy indexes (`approvalSessionKeys`, `fleetOwnerBySession`,
 * `getSessionRowsByKey`) are already memoized in O(1).
 */
export function statusOfSession(): StatusOfSessionFn {
  // Reading these subscribes the caller's reactive scope to any status change.
  const running = runningTurns();
  const approvals = approvalSessionKeys();
  const queued = queuedCounts();
  const failed = failedAt();
  const acknowledged = acknowledgedAt();
  const owners = fleetOwnerBySession();
  const active = fleetActive();
  const ctx = active ? deviceContext() : "";
  const rowsByKey = getSessionRowsByKey(sessions(), active, ctx);
  const openId = activeSessionId();
  const openDevice = activeSessionDevice();

  return (sessionId, _lastActivityMs, _messageCount, deviceId) => {
    const device = !active
      ? ""
      : deviceId !== undefined
        ? deviceId
        : sessionId === openId && openDevice
          ? openDevice
          : (owners.get(sessionId) ?? ctx);
    const key = `${device}/${sessionId}`;

    if (approvals.has(key)) return { kind: "approval", label: tr("chat.status.approval") };
    if (running[key] || (!active && running[sessionKey(sessionId, "")])) {
      return { kind: "running", label: tr("chat.status.running") };
    }
    const queuedCount = queued[key] ?? (!active || device === ctx ? queued[sessionId] : 0) ?? 0;
    if (queuedCount > 0) return { kind: "queued", label: tr("chat.status.queued") };
    if (failed[key] || (!active && failed[sessionId])) return { kind: "failed", label: tr("chat.status.failed") };
    const row = rowsByKey.get(key);
    if (!row || isAcknowledged(row, acknowledged, device)) return null;
    if (row.failed) return { kind: "failed", label: tr("chat.status.failed") };
    if (row.unread) return { kind: "unread", label: tr("chat.status.unread") };
    return null;
  };
}
