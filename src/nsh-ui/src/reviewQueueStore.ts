import { signal } from "nsh";

export interface ReviewQueueSample {
  toolId: string;
  status: "queued_for_capacity" | "paused_by_user" | "running" | "capacity_skipped";
  reason?: string | null;
  activeReviewerCount?: number | null;
  optionalReviewerCount?: number | null;
  queueElapsedMs?: number | null;
  maxQueueWaitSeconds?: number | null;
  sessionConcurrencyHigh?: boolean;
  controlsAvailable?: boolean;
}

interface ReviewQueueTurn {
  deviceId: string;
  turnId: string;
  waiting: readonly ReviewQueueSample[];
}

const queues = signal<Record<string, ReviewQueueTurn>>({});

export function reviewQueueFor(key: string): ReviewQueueTurn | undefined {
  return queues()[key];
}

export function clearReviewQueue(key: string, turnId?: string): void {
  queues.update(current => {
    const previous = current[key];
    if (!previous || (turnId && previous.turnId !== turnId)) return current;
    const next = { ...current };
    delete next[key];
    return next;
  });
}

export function clearReviewQueueOrigins(origins: ReadonlySet<string> | null): void {
  queues.update(current => {
    if (origins === null) return {};
    return Object.fromEntries(Object.entries(current).filter(([, queue]) => !origins.has(queue.deviceId)));
  });
}

export function removeReviewWait(key: string, turnId: string, toolId: string): void {
  const previous = queues()[key];
  if (!previous || previous.turnId !== turnId || !previous.waiting.some(item => item.toolId === toolId)) return;
  const waiting = previous.waiting.filter(item => item.toolId !== toolId);
  if (!waiting.length) clearReviewQueue(key, turnId);
  else queues.update(current => ({ ...current, [key]: { ...previous, waiting } }));
}

export function applyReviewQueueSample(key: string, deviceId: string, turnId: string, sample: ReviewQueueSample): void {
  if (typeof sample.toolId !== "string" || !sample.toolId) return;
  if (sample.status === "running" || sample.status === "capacity_skipped") {
    removeReviewWait(key, turnId, sample.toolId);
    return;
  }
  if (sample.status !== "queued_for_capacity" && sample.status !== "paused_by_user") return;
  queues.update(current => {
    const previous = current[key];
    const waiting = previous?.turnId === turnId ? previous.waiting : [];
    const update = waiting.some(item => item.toolId === sample.toolId)
      ? waiting.map(item => item.toolId === sample.toolId ? sample : item)
      : [...waiting, sample];
    return { ...current, [key]: { deviceId, turnId, waiting: update } };
  });
}
