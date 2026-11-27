import { cleanup, computed, effect, signal, untracked } from "nsh";
import { invokeCommand } from "./bridge";
import { isCommandUnavailable } from "./hostCommands";
import { localizeHostError } from "./i18n";
import type { ReviewPlatformAuthProvider } from "./reviewPlatform";

const COMMAND = "review_platform_list_pull_request_reviews";
const RUNNING_REFRESH_MS = 2500;

export type PullRequestReviewPhase = "running" | "completed" | "failed" | "stopped" | "interrupted" | "pending" | "unknown";
export type PullRequestReviewFreshness = "current" | "stale" | "unknown";
export type PullRequestReviewOutcome =
  | { state: "available"; findingCount?: number | null; riskLevel?: string | null;
      recommendedAction?: string | null; assessment?: string | null; evidenceCoverage?: string | null;
      targetChangedDuringReview?: boolean }
  | { state: "missing" | "invalid" };

export interface PullRequestReviewRun {
  sessionId: string;
  sessionName: string;
  agentType: string;
  parentSessionId?: string | null;
  createdAt: number;
  finishedAt?: number | null;
  phase: PullRequestReviewPhase;
  freshness: PullRequestReviewFreshness;
  preparedEvidenceLimited?: boolean;
  revision?: { recordId: string; previousSessionId?: string | null; number: number };
  latestForRecord?: boolean;
  recordHistoryComplete?: boolean;
  outcome?: PullRequestReviewOutcome | null;
}

interface ReviewHistoryCursor {
  createdAt: number;
  sessionId: string;
}

interface ReviewHistoryPage {
  runs: PullRequestReviewRun[];
  currentRunning?: PullRequestReviewRun | null;
  nextCursor?: ReviewHistoryCursor | null;
  supportsLinkedReReview?: boolean;
}

export interface PullRequestReviewHistoryTarget {
  workspaceId: string;
  deviceId: string;
  selection: {
    platform: ReviewPlatformAuthProvider;
    host: string;
    projectPath: string;
    pullRequestId: string;
    baseRevision?: string | null;
    headRevision?: string | null;
  };
}

export function usePullRequestReviewHistory(target: () => PullRequestReviewHistoryTarget | null) {
  const key = computed(() => JSON.stringify(target()));
  const page = signal<ReviewHistoryPage | null>(null);
  const cursors = signal<ReviewHistoryCursor[]>([]);
  const loading = signal(false);
  const error = signal("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticket = 0;
  let disposed = false;

  async function read(positions = cursors(), quiet = false): Promise<void> {
    const requested = target();
    if (disposed || !requested) return;
    const requestedKey = key();
    const requestTicket = ++ticket;
    const current = () => requestTicket === ticket && requestedKey === key();
    clearTimeout(timer);
    if (!quiet) loading.set(true);
    error.set("");

    try {
      const response = await invokeCommand<ReviewHistoryPage>(COMMAND, {
        workspaceId: requested.workspaceId, selection: requested.selection,
        ...(positions.length ? { before: positions.at(-1) } : {}),
      }, { target: requested.deviceId });
      if (!current()) return;
      page.set(response);
      cursors.set(positions);
      if (response.currentRunning || response.runs.some(run => run.phase === "running")) {
        timer = setTimeout(() => { if (current()) void read(positions, true); }, RUNNING_REFRESH_MS);
      }
    } catch (failure) {
      if (!current()) return;
      page.set(null);
      if (!isCommandUnavailable(failure, COMMAND)) error.set(localizeHostError(failure));
    } finally {
      if (current()) loading.set(false);
    }
  }

  effect(() => {
    key();
    untracked(() => {
      ++ticket;
      clearTimeout(timer);
      page.set(null);
      cursors.set([]);
      error.set("");
      loading.set(false);
      if (target()) void read([]);
    });
  });
  cleanup(() => { disposed = true; ++ticket; clearTimeout(timer); });

  return {
    page, loading, error,
    hasNewer: () => cursors().length > 0,
    hasOlder: () => Boolean(page()?.nextCursor),
    reload: () => void read(),
    latest: () => void read([]),
    newer: () => void read(cursors().slice(0, -1)),
    older: () => {
      const cursor = page()?.nextCursor;
      if (cursor) void read([...cursors(), cursor]);
    },
  };
}
