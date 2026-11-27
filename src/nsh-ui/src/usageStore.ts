// Token usage over a time range: what the desktop's Data > Usage page shows.
//
// The period read supplies the totals and distributions. The activity panel
// stays on the host's independent, day-keyed six-month view shared with Home.

import { signal } from "nsh";
import { backendConnection, invokeCommand } from "./bridge";
import { tr } from "./i18n";
import { deviceContext } from "./state";
import {
  fetchUsageActivity,
  localTimeZone,
  UsageActivityUnavailable,
  type UsageActivityCell,
  type UsageActivityView,
} from "./usageActivity";

/** One aggregated row: a model, a group or an endpoint. */
export interface UsageEntry {
  key: string;
  name: string;
  providerName: string | null;
  requests: number;
  tokens: number;
  cacheHitRate: number | null;
}

/** One bucket of the trend the host chose for this range. */
export interface UsageBucket {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface UsageTotals {
  requests: number;
  unknownRequests: number;
  failedRequests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  cacheReportedInputTokens: number;
}

/** The ranges the desktop offers; `custom` is only used for the heatmap window. */
export const USAGE_RANGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "last24Hours", label: "24h" },
  { value: "today", label: "Today" },
  { value: "thisWeek", label: "This week" },
  { value: "thisMonth", label: "This month" },
  { value: "all", label: "All" },
];

/** One cell of the activity grid, as the host keyed it. */
export type UsageActivityDay = UsageActivityCell;

export type UsageActivity = UsageActivityView;

/** The two ways the desktop groups the same usage: by model, or by group. */
export const USAGE_DISTRIBUTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "model", label: "Model" },
  { value: "group", label: "Group" },
];

/** How many distribution rows are drawn before "Show all". */
const DISTRIBUTION_ROWS = 5;

export const usageRange = signal("thisMonth");
export const usageLoading = signal(false);
export const usageActivityLoading = signal(false);
export const usageTotals = signal<UsageTotals | null>(null);
export const usageModels = signal<UsageEntry[]>([]);
export const usageGroups = signal<UsageEntry[]>([]);
/** Per-endpoint totals; the desktop lists these under the detail rows. */
export const usageEndpoints = signal<UsageEntry[]>([]);
/** `model` or `group`; both are read in one answer and only one is drawn. */
export const usageDistribution = signal("model");
/** The reader's filter over the distribution rows; empty shows everything. */
export const usageEntryFilter = signal("");
/** False while the distribution shows its first five rows only. */
export const usageExpanded = signal(false);
export const usageBuckets = signal<UsageBucket[]>([]);
export const usageGranularity = signal("");
export const usageNotice = signal("");
/** The host refused the command because it does not offer usage statistics. */
export const usageUnsupported = signal(false);
/** The fixed six-month window behind the heatmap; `null` when unread. */
export const usageActivity = signal<UsageActivity | null>(null);
/** Why the heatmap has no data, when the range above still does. */
export const usageActivityNotice = signal("");

function usageScope() {
  return { connection: backendConnection(), target: deviceContext(), timeZone: localTimeZone() };
}

type UsageScope = ReturnType<typeof usageScope>;
let loadedScope: UsageScope | null = null;
let rangeRequest = 0;
let activityRequest = 0;

function sameUsageScope(left: UsageScope, right: UsageScope | null): boolean {
  return left.connection === right?.connection && left.target === right.target && left.timeZone === right.timeZone;
}

function isCurrentUsageDevice(scope: UsageScope): boolean {
  return backendConnection() === scope.connection && deviceContext() === scope.target;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readEntry(record: Record<string, unknown>): UsageEntry {
  return {
    key: String(record.key ?? ""),
    name: String(record.name ?? record.key ?? ""),
    providerName: typeof record.providerName === "string" ? record.providerName : null,
    requests: number(record.requests),
    tokens: number(record.tokens),
    cacheHitRate: optionalNumber(record.cacheHitRate),
  };
}

/** One of the host's grouped lists, busiest first, the way the desktop sorts. */
function readEntries(raw: unknown): UsageEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map(entry => readEntry((entry ?? {}) as Record<string, unknown>))
    .sort((left, right) => right.tokens - left.tokens);
}

/** The trend the host returned, read once so both the rows and the grid agree. */
function readBuckets(raw: unknown): UsageBucket[] {
  const trend = Array.isArray(raw) ? raw : [];
  return trend.map(entry => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      bucket: String(record.bucket ?? ""),
      inputTokens: number(record.inputTokens),
      outputTokens: number(record.outputTokens),
      cachedTokens: number(record.cacheReadTokens),
    };
  });
}

/** A range shorter than a day is bucketed by hour, the way the desktop asks. */
function granularityFor(range: string): string {
  return range === "last24Hours" || range === "today" ? "hour" : "day";
}

function clearUsageRange(): void {
  usageTotals.set(null);
  usageModels.set([]);
  usageGroups.set([]);
  usageEndpoints.set([]);
  usageBuckets.set([]);
  usageGranularity.set("");
}

async function readUsageRange(scope: UsageScope, keepContent: boolean): Promise<void> {
  const request = ++rangeRequest;
  const range = usageRange();
  const { target, timeZone } = scope;
  const current = () => request === rangeRequest && isCurrentUsageDevice(scope);
  usageLoading.set(true);
  usageNotice.set("");
  usageUnsupported.set(false);
  if (!keepContent) clearUsageRange();
  try {
    const stats = await invokeCommand<Record<string, unknown>>("get_token_usage_statistics", {
      timeRange: range,
      granularity: granularityFor(range),
      includeSubagent: true,
      ...(timeZone ? { timeZone } : {}),
    }, { target });
    if (current()) {
      usageTotals.set({
        requests: number(stats.totalRequests),
        unknownRequests: number(stats.unknownUsageRequests),
        failedRequests: number(stats.failedRequests),
        tokens: number(stats.totalTokens),
        inputTokens: number(stats.totalInputTokens),
        outputTokens: number(stats.totalOutputTokens),
        cachedTokens: number(stats.totalCachedTokens),
        cacheWriteTokens: number(stats.totalCacheWriteTokens),
        cacheReportedInputTokens: number(stats.totalCacheReportedInputTokens),
      });
      usageModels.set(readEntries(stats.byModel));
      usageGroups.set(readEntries(stats.byGroup));
      usageEndpoints.set(readEntries(stats.byEndpoint));
      usageBuckets.set(readBuckets(stats.trend));
      usageGranularity.set(typeof stats.granularity === "string" ? stats.granularity : "");
    }
  } catch (error) {
    if (!current()) return;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("token_usage_statistics_unsupported")) {
      clearUsageRange();
      usageUnsupported.set(true);
    } else {
      usageNotice.set(message);
    }
  } finally {
    if (request === rangeRequest) {
      if (!isCurrentUsageDevice(scope)) loadedScope = null;
      usageLoading.set(false);
    }
  }
}

async function readActivity(scope: UsageScope, keepContent: boolean): Promise<void> {
  const request = ++activityRequest;
  const current = () => request === activityRequest && isCurrentUsageDevice(scope);
  usageActivityLoading.set(true);
  usageActivityNotice.set("");
  if (!keepContent) usageActivity.set(null);
  try {
    const activity = await fetchUsageActivity(undefined, { target: scope.target }, scope.timeZone);
    if (current()) usageActivity.set(activity);
  } catch (error) {
    if (!current()) return;
    usageActivityNotice.set(
      error instanceof UsageActivityUnavailable && error.reason === "host_outdated"
        ? tr("usage.activityHostOutdated")
        : tr("settings.usage.activityFailed"),
    );
  } finally {
    if (request === activityRequest) {
      if (!isCurrentUsageDevice(scope)) loadedScope = null;
      usageActivityLoading.set(false);
    }
  }
}

/** Entering a device's usage page and refreshing read both sections. */
export async function loadUsage(force = false): Promise<void> {
  const scope = usageScope();
  const keepContent = sameUsageScope(scope, loadedScope);
  if (keepContent && !force) return;
  loadedScope = scope;
  await Promise.all([readUsageRange(scope, keepContent), readActivity(scope, keepContent)]);
}

/** Switches the range and reads it again. */
export async function chooseUsageRange(range: string): Promise<void> {
  if (usageRange() === range || usageLoading()) return;
  usageRange.set(range);
  await readUsageRange(usageScope(), false);
}

/**
 * Switches between the model and group view of the same answer. The desktop
 * clears its filter and collapses the list on every switch, so the two views
 * cannot inherit each other's narrowing.
 */
export function chooseUsageDistribution(kind: string): void {
  if (usageDistribution() === kind) return;
  usageDistribution.set(kind);
  usageEntryFilter.set("");
  usageExpanded.set(false);
}

/** Narrowing the rows collapses them, so a new filter starts from the top five. */
export function setUsageEntryFilter(text: string): void {
  usageEntryFilter.set(text);
  usageExpanded.set(false);
}

export function toggleUsageExpanded(): void {
  usageExpanded.set(!usageExpanded());
}

/** The rows of the selected view, before the filter is applied. */
export function usageDistributionRows(): UsageEntry[] {
  return usageDistribution() === "group" ? usageGroups() : usageModels();
}

/**
 * The rows the distribution draws: the filter matched against the same text the
 * rows show, cut to five unless the reader asked for all of them. `total` is the
 * match count, so a filter that matches nothing is told apart from an empty host
 * answer, and `hidden` decides whether "Show all" is offered.
 */
export function usageVisibleRows(): {
  rows: UsageEntry[];
  total: number;
  hidden: boolean;
} {
  const query = usageEntryFilter().trim().toLowerCase();
  const matched = query
    ? usageDistributionRows().filter(entry =>
        `${entry.name} ${entry.providerName ?? ""}`.toLowerCase().includes(query))
    : usageDistributionRows();
  const rows = usageExpanded() ? matched : matched.slice(0, DISTRIBUTION_ROWS);
  return { rows, total: matched.length, hidden: matched.length > DISTRIBUTION_ROWS };
}

/** The overall cache hit rate, or `null` when no request reported telemetry. */
export function usageCacheHitRate(totals: UsageTotals): number | null {
  if (totals.cacheReportedInputTokens <= 0) return null;
  return totals.cachedTokens / totals.cacheReportedInputTokens;
}
