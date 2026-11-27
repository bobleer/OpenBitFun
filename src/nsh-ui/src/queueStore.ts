// Messages waiting for a running turn, as the host queues them.
//
// The queue belongs to the host: `manage_dialog_queue` reports what it holds
// (`list`), drains it when the running turn settles, and lets any client cancel,
// promote or reorder a row, so a queued message survives a reload of this
// surface and keeps its place next to whatever another surface (mobile, a bot,
// another desktop) queued. Whether a message is queued at all is decided by the
// host too (`submit_user_message`), not here.

import { signal } from "nsh";
import type { ImageAttachment } from "./attachmentStore";
import { invokeCommand } from "./bridge";
import { queuedCounts } from "./sessionStatusStore";
import { tr } from "./i18n";
import { sessionReferenceDraft, type SessionReferenceDraft } from "./sessionReferences";
import { activeSessionId, deviceOfSession, runningTurnId } from "./state";

export interface QueuedMessage {
  id: string;
  content: string;
  /** `queued`, `blocked` or `steering_pending`, as the host reports the row. */
  status: string;
  /** Why the host is holding the row back (`blocked` and friends). */
  reason: string;
  source: "host";
  ownerDevice?: string;
  referenceDraft?: SessionReferenceDraft;
  /** How many images the host holds with the message. */
  attachmentCount?: number;
  /** Client-cached image attachments so re-editing or starting a queued message preserves images. */
  attachments?: ImageAttachment[];
}

interface HostQueueItem {
  turnId?: string;
  displayContent?: string;
  status?: string;
  reason?: string | null;
  previewTruncated?: boolean;
  attachmentCount?: number;
  composerPresentation?: unknown;
}

interface HostQueueSnapshot {
  sessionId?: string;
  queueEpoch?: string;
  revision?: number;
  activeTurnId?: string | null;
  items?: HostQueueItem[];
  /** Absent on hosts that predate reorder; support is never inferred from a version. */
  supportsReorder?: boolean;
  capacity?: number;
  used?: number;
  ownerDevice?: string;
}

export const queuedMessages = signal<QueuedMessage[]>([]);
export const queueNotice = signal("");
/** Why there is no queue for this session (the host or peer needs an update); empty otherwise. */
export const queueFallbackReason = signal("");
/** `null` until the host has been asked; `false` means it has no queue. */
export const hostQueueAvailable = signal<boolean | null>(null);
/**
 * Whether the host can move a row inside its own queue. `null` means the last
 * snapshot did not say, which is what a host predating reorder answers.
 */
export const hostQueueReorderSupported = signal<boolean | null>(null);

let nextId = 1;
let hostEpoch = "";
let hostSessionId = "";
let hostDeviceId = "";
/** The revision the last snapshot was issued at; a reorder has to name it. */
let hostRevision = 0;
/** Per-session monotonic request sequence so an older in-flight `list` cannot overwrite newer state. */
const listSeqBySession = new Map<string, number>();
/** Per-session revision watermark per queue epoch to reject out-of-order snapshots. */
const sessionRevisionBySession = new Map<string, { epoch: string; revision: number }>();
/** Turn IDs already observed in `dialog-turn-started`, so stale snapshots never resurrect them. */
const startedTurnsBySession = new Map<string, Set<string>>();
/** Per-row image attachments cached client-side (keyed by `idFor(sessionId, turnId)`). */
const queuedAttachmentsById = new Map<string, ImageAttachment[]>();

function bumpSessionSeq(sessionId: string): number {
  const next = (listSeqBySession.get(sessionId) ?? 0) + 1;
  listSeqBySession.set(sessionId, next);
  return next;
}

/** The queue for one session, oldest first. */
export function queueForSession(sessionId: string | null): QueuedMessage[] {
  if (!sessionId) return [];
  const device = deviceOfSession(sessionId);
  return queuedMessages().filter(item => item.id.startsWith(`${sessionId}\u0000`) && (item.ownerDevice ?? "") === device)
    .map(item => ({ ...item, id: item.id.slice(sessionId.length + 1) }));
}

export function hasPendingSteeringForSession(sessionId: string | null): boolean {
  return queueForSession(sessionId).some(item => item.status === "steering_pending");
}

/**
 * Drops a queued row the instant its turn starts running (`dialog-turn-started`),
 * invalidating any older in-flight `list` snapshot that was captured before the
 * host dequeued it, and returns any cached image attachments so the live user
 * bubble can render them immediately.
 */
export function markQueuedTurnStarted(sessionId: string | null, turnId: string | null): ImageAttachment[] {
  if (!sessionId || !turnId) return [];
  let started = startedTurnsBySession.get(sessionId);
  if (!started) {
    started = new Set<string>();
    startedTurnsBySession.set(sessionId, started);
  }
  if (started.size >= 64) {
    const oldest = started.values().next().value;
    if (oldest !== undefined) started.delete(oldest);
  }
  started.add(turnId);
  bumpSessionSeq(sessionId);
  const targetId = idFor(sessionId, turnId);
  const cachedAttachments = queuedAttachmentsById.get(targetId) ?? [];
  queuedAttachmentsById.delete(targetId);
  const current = queuedMessages();
  if (!current.some(item => item.id === targetId)) return cachedAttachments;
  const next = current.filter(item => item.id !== targetId);
  queuedMessages.set(next);
  const remaining = next.filter(item => item.id.startsWith(`${sessionId}\u0000`)).length;
  queuedCounts.update(counts => ({ ...counts, [sessionId]: remaining }));
  return cachedAttachments;
}

/**
 * Inserts a newly queued row immediately when `submit_user_message` returns
 * `{ outcome: "queued", turnId }`, avoiding an extra `list` round-trip delay
 * before the row appears in the queue tray.
 */
export function recordQueuedFromSubmit(
  sessionId: string | null,
  turnId: string | null,
  content: string,
  attachmentCount = 0,
  attachments: ImageAttachment[] = [],
  referenceDraft?: SessionReferenceDraft,
): void {
  if (!sessionId || !turnId) return;
  if (startedTurnsBySession.get(sessionId)?.has(turnId)) return;
  const targetId = idFor(sessionId, turnId);
  const ownerDevice = deviceOfSession(sessionId);
  const cloned = attachments.length > 0 ? [...attachments] : [];
  if (cloned.length > 0) {
    queuedAttachmentsById.set(targetId, cloned);
  }
  const effectiveCount = Math.max(attachmentCount, cloned.length);
  const current = queuedMessages();
  if (current.some(item => item.id === targetId && (item.ownerDevice ?? "") === ownerDevice)) {
    if (cloned.length > 0 || referenceDraft) {
      queuedMessages.set(
        current.map(item =>
          item.id === targetId && (item.ownerDevice ?? "") === ownerDevice
            ? { ...item, ...(cloned.length ? { attachmentCount: effectiveCount, attachments: cloned } : {}),
              ...(referenceDraft ? { referenceDraft } : {}) }
            : item,
        ),
      );
    }
    return;
  }
  const next: QueuedMessage[] = [
    ...current,
    {
      id: targetId,
      content,
      status: "queued",
      reason: "",
      source: "host",
      ownerDevice,
      ...(referenceDraft ? { referenceDraft } : {}),
      ...(effectiveCount > 0 ? { attachmentCount: effectiveCount } : {}),
      ...(cloned.length > 0 ? { attachments: cloned } : {}),
    },
  ];
  queuedMessages.set(next);
  const count = next.filter(item => item.id.startsWith(`${sessionId}\u0000`)).length;
  queuedCounts.update(counts => ({ ...counts, [sessionId]: count }));
}

function idFor(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function activeQueueRow(id: string): QueuedMessage | undefined {
  const sessionId = activeSessionId();
  if (!sessionId) return undefined;
  const device = deviceOfSession(sessionId);
  const key = id.startsWith(`${sessionId}\u0000`) ? id : idFor(sessionId, id);
  return queuedMessages().find(item => item.id === key && (item.ownerDevice ?? "") === device);
}

async function callQueue(sessionId: string, request: Record<string, unknown>): Promise<HostQueueSnapshot> {
  const ownerDevice = deviceOfSession(sessionId);
  const snapshot = await invokeCommand<HostQueueSnapshot>("manage_dialog_queue", {
    sessionId,
    ...(hostEpoch && sessionId === hostSessionId && ownerDevice === hostDeviceId ? { queueEpoch: hostEpoch } : {}),
    ...request,
  }, ownerDevice ? { target: ownerDevice } : undefined);
  return { ...snapshot, ownerDevice };
}

/** Rows the host still holds for the next turn; a started one has left the queue. */
const HELD_STATUSES = ["queued", "blocked", "steering_pending"];

function adoptSnapshot(
  sessionId: string,
  snapshot: HostQueueSnapshot,
  options?: { fromListSeq?: number },
): void {
  const ownerDevice = snapshot.ownerDevice ?? deviceOfSession(sessionId);
  if (ownerDevice !== deviceOfSession(sessionId)) return;
  if (options?.fromListSeq !== undefined && options.fromListSeq < (listSeqBySession.get(sessionId) ?? 0)) {
    return;
  }
  const epoch = snapshot.queueEpoch ?? (sessionId === hostSessionId ? hostEpoch : "");
  const previous = sessionRevisionBySession.get(sessionId);
  if (
    options?.fromListSeq !== undefined &&
    previous &&
    epoch &&
    previous.epoch === epoch &&
    typeof snapshot.revision === "number" &&
    snapshot.revision < previous.revision
  ) {
    return;
  }
  if (typeof snapshot.revision === "number") {
    sessionRevisionBySession.set(sessionId, { epoch, revision: snapshot.revision });
  }
  hostEpoch = snapshot.queueEpoch ?? hostEpoch;
  hostSessionId = sessionId;
  hostDeviceId = ownerDevice;
  hostRevision = snapshot.revision ?? hostRevision;
  hostQueueReorderSupported.set(snapshot.supportsReorder ?? null);
  const activeId = typeof snapshot.activeTurnId === "string" && snapshot.activeTurnId ? snapshot.activeTurnId : null;
  const started = startedTurnsBySession.get(sessionId);
  const snapshotTurnIds = new Set<string>();
  const current = queuedMessages();
  const others = current.filter(item => !item.id.startsWith(`${sessionId}\u0000`) || (item.ownerDevice ?? "") !== ownerDevice);
  const rows: QueuedMessage[] = [];
  for (const item of snapshot.items ?? []) {
    const turnId = item.turnId;
    if (!turnId) continue;
    snapshotTurnIds.add(turnId);
    if (!HELD_STATUSES.includes(item.status ?? "queued")) continue;
    if (activeId === turnId || started?.has(turnId)) continue;
    const rowId = idFor(sessionId, turnId);
    const cachedAttachments = queuedAttachmentsById.get(rowId);
    const referenceDraft = sessionReferenceDraft(item.composerPresentation) ??
      current.find(row => row.id === rowId && (row.ownerDevice ?? "") === ownerDevice)?.referenceDraft;
    const attachmentCount = Math.max(item.attachmentCount ?? 0, cachedAttachments?.length ?? 0);
    rows.push({
      id: rowId,
      content: item.displayContent ?? "",
      status: item.status ?? "queued",
      reason: item.reason ?? "",
      source: "host",
      ownerDevice,
      ...(referenceDraft ? { referenceDraft } : {}),
      ...(attachmentCount > 0 ? { attachmentCount } : {}),
      ...(cachedAttachments && cachedAttachments.length > 0 ? { attachments: cachedAttachments } : {}),
    });
  }
  for (const cachedKey of [...queuedAttachmentsById.keys()]) {
    if (cachedKey.startsWith(`${sessionId}\u0000`)) {
      const turnId = cachedKey.slice(sessionId.length + 1);
      if (!snapshotTurnIds.has(turnId)) {
        queuedAttachmentsById.delete(cachedKey);
      }
    }
  }
  if (started) {
    for (const id of started) {
      if (!snapshotTurnIds.has(id) && id !== activeId) started.delete(id);
    }
    if (started.size === 0) startedTurnsBySession.delete(sessionId);
  }
  queuedMessages.set([...others, ...rows]);
  queuedCounts.update(current => ({ ...current, [sessionId]: rows.length }));
}

function markQueueUnavailable(sessionId: string): void {
  hostQueueAvailable.set(false);
  queuedMessages.update(current => current.filter(item => !item.id.startsWith(`${sessionId}\u0000`)));
  queuedCounts.update(current => ({ ...current, [sessionId]: 0 }));
  hostSessionId = sessionId;
  queueFallbackReason.set(tr("chat.queue.hostUpdateRequired"));
}

/**
 * Asks the host what it holds for a session. `force` re-reads a session already
 * known, which is how the rows follow a drain or a message another client queued.
 */
export async function loadQueueForSession(sessionId: string | null, force = false): Promise<void> {
  if (!sessionId) return;
  if (!force && sessionId === hostSessionId && deviceOfSession(sessionId) === hostDeviceId) return;
  const seq = bumpSessionSeq(sessionId);
  try {
    adoptSnapshot(sessionId, await callQueue(sessionId, { action: "list" }), { fromListSeq: seq });
    hostQueueAvailable.set(true);
    queueFallbackReason.set("");
  } catch {
    if (seq === (listSeqBySession.get(sessionId) ?? 0)) {
      markQueueUnavailable(sessionId);
    }
  }
}

export async function removeQueued(id: string): Promise<void> {
  const row = activeQueueRow(id);
  const sessionId = activeSessionId();
  if (!row || !sessionId) return;
  const turnId = row.id.slice(row.id.indexOf("\u0000") + 1);
  const previous = queuedMessages();
  const next = previous.filter(item => item !== row);
  const seq = bumpSessionSeq(sessionId);
  queuedMessages.set(next);
  queuedCounts.update(counts => ({
    ...counts,
    [sessionId]: next.filter(item => item.id.startsWith(`${sessionId}\u0000`)).length,
  }));
  try {
    adoptSnapshot(sessionId, await callQueue(sessionId, {
      action: "cancel",
      turnId,
      operationId: `cancel-${nextId++}`,
    }));
  } catch {
    // The host kept it; restore the row rather than lying about it.
    if (seq === (listSeqBySession.get(sessionId) ?? 0)) {
      queuedMessages.set(previous);
      queuedCounts.update(counts => ({
        ...counts,
        [sessionId]: previous.filter(item => item.id.startsWith(`${sessionId}\u0000`)).length,
      }));
    }
    queueNotice.set(tr("chat.queue.cancelRefused"));
  }
}

/** Hands a queued message (and its cached attachments) back to the composer and drops it from the queue. */
export async function takeQueuedEntry(id: string): Promise<{
  content: string; attachments: ImageAttachment[]; referenceDraft?: SessionReferenceDraft;
} | null> {
  const row = activeQueueRow(id);
  if (!row) return null;
  const cachedAttachments = [...(row.attachments ?? queuedAttachmentsById.get(row.id) ?? [])];
  await removeQueued(row.id);
  // Only a row the host actually let go of goes back to the composer.
  if (queuedMessages().some(item => item.id === row.id && item.ownerDevice === row.ownerDevice)) {
    return null;
  }
  queuedAttachmentsById.delete(row.id);
  return { content: row.content, attachments: cachedAttachments, referenceDraft: row.referenceDraft };
}

/** Hands a queued message back to the composer and drops it from the queue. */
export async function takeQueued(id: string): Promise<string> {
  const entry = await takeQueuedEntry(id);
  return entry?.content ?? "";
}

/** Sends one queued message now: the host promotes it, steering a running turn. */
export async function sendQueuedNow(id: string): Promise<void> {
  const row = activeQueueRow(id);
  const sessionId = activeSessionId();
  if (!row || !sessionId) return;
  const turnId = row.id.slice(row.id.indexOf("\u0000") + 1);
  const previous = queuedMessages();
  const next = previous.filter(item => item !== row);
  const seq = bumpSessionSeq(sessionId);
  queuedMessages.set(next);
  queuedCounts.update(counts => ({
    ...counts,
    [sessionId]: next.filter(item => item.id.startsWith(`${sessionId}\u0000`)).length,
  }));
  try {
    adoptSnapshot(sessionId, await callQueue(sessionId, {
      action: "promote",
      turnId,
      operationId: `promote-${nextId++}`,
      expectedActiveTurnId: runningTurnId(),
    }));
  } catch {
    if (seq === (listSeqBySession.get(sessionId) ?? 0)) {
      queuedMessages.set(previous);
      queuedCounts.update(counts => ({
        ...counts,
        [sessionId]: previous.filter(item => item.id.startsWith(`${sessionId}\u0000`)).length,
      }));
    }
    queueNotice.set(tr("chat.queue.promoteRefused"));
  }
}

/**
 * Moves one queued message up or down the queue (`direction` of -1 or 1).
 *
 * The snapshot is read again first — support is negotiated from a fresh reply,
 * never remembered from an older one — and the reorder names the revision that
 * read was issued at, so a queue another surface changed in between is refused
 * instead of being overwritten.
 */
export async function moveQueued(id: string, direction: -1 | 1): Promise<void> {
  const row = activeQueueRow(id);
  const sessionId = activeSessionId();
  if (!row || !sessionId) return;
  const turnId = row.id.slice(row.id.indexOf("\u0000") + 1);
  const previous = queuedMessages();
  // Optimistically swap the two session rows immediately so reordering feels instant.
  const sessionIndices: number[] = [];
  previous.forEach((item, idx) => {
    if (item.id.startsWith(`${sessionId}\u0000`)) sessionIndices.push(idx);
  });
  const localPos = sessionIndices.findIndex(idx => previous[idx]?.id === row.id);
  const targetPos = localPos + direction;
  if (localPos >= 0 && targetPos >= 0 && targetPos < sessionIndices.length) {
    const swapped = [...previous];
    const a = sessionIndices[localPos]!;
    const b = sessionIndices[targetPos]!;
    [swapped[a], swapped[b]] = [swapped[b]!, swapped[a]!];
    queuedMessages.set(swapped);
  }
  const seq = bumpSessionSeq(sessionId);
  let snapshot: HostQueueSnapshot;
  try {
    snapshot = await callQueue(sessionId, { action: "list" });
  } catch {
    if (seq === (listSeqBySession.get(sessionId) ?? 0)) queuedMessages.set(previous);
    queueNotice.set(tr("chat.queue.listRefused"));
    return;
  }
  adoptSnapshot(sessionId, snapshot, { fromListSeq: seq });
  if (hostQueueReorderSupported() !== true) {
    queueNotice.set(tr("chat.queue.reorderUnsupported"));
    return;
  }
  const turnIds = queueForSession(sessionId).map(item => item.id);
  const index = turnIds.indexOf(turnId);
  const target = index + direction;
  // A row that left the queue, or an end already reached, has nothing to move.
  if (index < 0 || target < 0 || target >= turnIds.length) return;
  // "Move before" the row on the far side of the destination, so the moved row
  // lands where the press asked for; the end of the list is `null`.
  const beforeTurnId = direction < 0 ? turnIds[index - 1] : (turnIds[index + 2] ?? null);
  const reorderSeq = bumpSessionSeq(sessionId);
  try {
    adoptSnapshot(sessionId, await callQueue(sessionId, {
      action: "reorder",
      turnId,
      beforeTurnId,
      operationId: `reorder-${nextId++}`,
      expectedRevision: hostRevision,
    }));
    queueNotice.set("");
  } catch {
    if (reorderSeq === (listSeqBySession.get(sessionId) ?? 0)) {
      adoptSnapshot(sessionId, snapshot);
    }
    queueNotice.set(tr("chat.queue.reorderRefused"));
  }
}
