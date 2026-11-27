import { cleanup, computed, effect, signal, untracked } from "nsh";
import { EVENTS_DROPPED } from "./backendResync";
import { connectionState, entryDeviceId, fleetActive, invokeCommand, listenEvent, transportKind } from "./bridge";
import { fleetDeviceById } from "./fleetStore";
import { isCommandUnavailable } from "./hostCommands";
import { localizeHostError } from "./i18n";
import type { PullRequestReviewRun } from "./pullRequestReviewHistory";
import { reviewRecordChanged, type ReviewTarget } from "./reviewStore";

const COMMAND = "list_session_review_records";
const CAPABILITY = "session_review_records_v1";
const DURABLE_REFRESH_MS = 2500;

export type SessionReviewRecord = PullRequestReviewRun & {
  target: { kind: "workspace" }
    | { kind: "git_range"; baseRevision?: string; headRevision?: string }
    | { kind: "pull_request"; number: number; projectPath: string };
};

interface Cursor {
  createdAt: number;
  sessionId: string;
}

interface ReviewPage {
  records: SessionReviewRecord[];
  nextCursor?: Cursor | null;
}

export function useSessionReviewRecords(target: () => ReviewTarget | null) {
  const scope = computed(() => {
    const current = target();
    if (!current?.workspaceId) return null;
    const deviceId = current.deviceId ?? "";
    if (fleetActive() && !(transportKind() === "native" && deviceId === entryDeviceId())
        && !fleetDeviceById(deviceId)?.hostCapabilities?.includes(CAPABILITY)) return null;
    return { sessionId: current.sessionId, workspaceId: current.workspaceId, deviceId };
  });
  const key = computed(() => JSON.stringify(scope()));
  const page = signal<ReviewPage | null>(null);
  const positions = signal<Cursor[]>([]);
  const error = signal("");
  const loading = signal(false);
  let scopeKey = "";
  let ticket = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  async function read(cursors = positions(), quiet = false): Promise<void> {
    const requested = scope();
    if (!requested || disposed || connectionState() !== "connected") return;
    const requestedKey = key();
    const requestTicket = ++ticket;
    const current = () => requestTicket === ticket && key() === requestedKey && connectionState() === "connected";
    clearTimeout(timer);
    if (!quiet) loading.set(true);
    error.set("");
    try {
      const response = await invokeCommand<ReviewPage>(COMMAND, {
        workspaceId: requested.workspaceId, sessionId: requested.sessionId,
        ...(cursors.length ? { before: cursors.at(-1) } : {}),
      }, { target: requested.deviceId });
      if (!current() || !Array.isArray(response?.records)) return;
      page.set(response);
      positions.set(cursors);
      if (response.records.some(record => record.phase === "running")) {
        timer = setTimeout(() => { if (current()) void read(cursors, true); }, DURABLE_REFRESH_MS);
      }
    } catch (failure) {
      if (current() && !isCommandUnavailable(failure, COMMAND)) error.set(localizeHostError(failure));
    } finally {
      if (current()) loading.set(false);
    }
  }

  effect(() => {
    const currentKey = key();
    const connected = connectionState() === "connected";
    untracked(() => {
      ++ticket;
      clearTimeout(timer);
      loading.set(false);
      if (currentKey !== scopeKey) {
        scopeKey = currentKey;
        page.set(null);
        positions.set([]);
        error.set("");
      }
      if (connected) void read();
    });
  });
  effect(() => {
    const changed = reviewRecordChanged();
    untracked(() => {
      const selected = scope();
      if (changed && selected && selected.sessionId === changed.sessionId
          && selected.workspaceId === changed.workspaceId && selected.deviceId === (changed.deviceId ?? "")) void read([]);
    });
  });
  const onRecord = listenEvent<{ parentSessionId?: string; workspaceId?: string }>("agentic://review-record-changed", (event, meta) => {
    const selected = scope();
    if (!selected || (fleetActive() && meta.origin !== selected.deviceId)) return;
    if (event?.parentSessionId === selected.sessionId && event.workspaceId === selected.workspaceId) void read([]);
  });
  const onSettle = listenEvent<{ sessionId?: string; session_id?: string }>("agentic://session-history-changed", (event, meta) => {
    const selected = scope();
    if (!selected || (fleetActive() && meta.origin !== selected.deviceId)) return;
    if (page()?.records.some(record => record.sessionId === (event?.sessionId ?? event?.session_id))) void read(positions(), true);
  });
  const onGap = listenEvent<{ origin?: string }>(EVENTS_DROPPED, (event, meta) => {
    const selected = scope();
    const origin = event?.origin || meta.origin;
    if (selected && (!origin || origin === selected.deviceId)) void read();
  });
  cleanup(() => { disposed = true; ++ticket; clearTimeout(timer); onRecord(); onSettle(); onGap(); });

  return {
    key, page, error, loading,
    hasNewer: () => positions().length > 0,
    reload: () => void read(),
    latest: () => void read([]),
    newer: () => void read(positions().slice(0, -1)),
    older: () => {
      const cursor = page()?.nextCursor;
      if (cursor) void read([...positions(), cursor]);
    },
  };
}
