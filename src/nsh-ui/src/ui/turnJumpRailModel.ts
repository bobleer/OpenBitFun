/**
 * Progressive multi-tier bucketing model for the left-edge `TurnJumpRail`.
 *
 * Keeps recent turns 1:1 while progressively folding the oldest turns into
 * prefix-aligned, round-number blocks (`1 → 5 → 20 → 100 → 500 → ...`) so the
 * rail handles 1,000+ turns within a bounded bar budget and never requires
 * hidden internal scrolling.
 */

export interface TurnJumpRowRef {
  key: string;
}

export interface TurnJumpBucket {
  /** Stable key for `<Each>`: `single:<rowKey>` or `group:<startIndex>-<endIndex>`. */
  id: string;
  /** 0-based inclusive start index into `rows`. */
  startIndex: number;
  /** 0-based inclusive end index into `rows`. */
  endIndex: number;
  /** Number of turns represented by this bar (`endIndex - startIndex + 1`). */
  count: number;
  /** Tier depth (0 = single turn, 1 = 5, 2 = 20, 3 = 100, 4 = 500, ...). */
  tier: number;
  /** True when multiple turns are folded into this bar. */
  grouped: boolean;
  /** Original row key when `grouped === false`, else `null`. */
  singleKey: string | null;
  /** Visual height of the bar in px (scales sub-linearly with `count`). */
  barHeight: number;
  /** Visual corner radius in px. */
  barRadius: number;
}

export interface TurnJumpSubRange {
  /** 0-based inclusive start index into `rows`. */
  startIndex: number;
  /** 0-based inclusive end index into `rows`. */
  endIndex: number;
  /** Number of turns in this sub-range. */
  count: number;
}

export interface BuildTurnJumpBucketsOptions {
  /** Maximum bars displayed at once (default 20). */
  maxBars?: number;
}

/** Default maximum number of bars on standard desktop viewports. */
export const DEFAULT_RAIL_MAX_BARS = 20;
/** Floor for responsive shrinking on short split panes. */
export const MIN_RAIL_MAX_BARS = 12;

/** Human-friendly decimal tier sizes; higher tiers continue by `×5`. */
const BASE_TIER_CAPACITIES = [1, 5, 20, 100, 500] as const;

export function tierCapacity(tier: number): number {
  if (tier < BASE_TIER_CAPACITIES.length) return BASE_TIER_CAPACITIES[tier]!;
  return BASE_TIER_CAPACITIES[BASE_TIER_CAPACITIES.length - 1]! * Math.pow(5, tier - (BASE_TIER_CAPACITIES.length - 1));
}

function tierMergeFactor(tier: number): number {
  // 1 × 5 = 5, 5 × 4 = 20, 20 × 5 = 100, 100 × 5 = 500, ...
  return tier === 1 ? 4 : 5;
}

/**
 * Computes the bar budget for the rail container's inner height (already inset
 * from the transcript top/bottom edges) so the rail stays comfortably centered
 * on desktop/laptop screens (`20` bars) and shrinks smoothly on short panes.
 */
export function maxBarsForRailHeight(viewportHeight: number | undefined): number {
  if (!viewportHeight || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return DEFAULT_RAIL_MAX_BARS;
  }
  const available = viewportHeight * 0.72;
  const fitted = Math.floor(available / 14);
  return Math.max(MIN_RAIL_MAX_BARS, Math.min(DEFAULT_RAIL_MAX_BARS, fitted));
}

/**
 * Maps turn count inside a bar to crisp visual geometry:
 * - Single turn: 2 px thin bar with 1 px corner radius.
 * - Grouped turns: 4 px bar (2× height) with the exact same 1 px corner radius.
 */
export function barMetricsForCount(count: number): { barHeight: number; barRadius: number } {
  if (count <= 1) return { barHeight: 2, barRadius: 1 };
  return { barHeight: 4, barRadius: 1 };
}

/**
 * Folds `rows` into at most `maxBars` ordered visual buckets (oldest → newest).
 *
 * Properties:
 * - Up to `maxBars` turns: strictly 1:1 single hairlines.
 * - Above `maxBars`: merges oldest prefix blocks first in clean multiples
 *   (`5 → 20 → 100 → 500 → ...`) while preserving recent turns as 1:1 hairlines.
 * - Prefix alignment ensures appending a new turn never shifts older block ranges.
 * - Contiguously covers every turn `[0, rows.length - 1]` with `buckets.length <= maxBars`.
 */
export function buildTurnJumpBuckets(
  rows: ReadonlyArray<TurnJumpRowRef>,
  options?: BuildTurnJumpBucketsOptions,
): TurnJumpBucket[] {
  const total = rows.length;
  if (total === 0) return [];

  const maxBars = Math.max(2, Math.floor(options?.maxBars ?? DEFAULT_RAIL_MAX_BARS));
  if (total <= maxBars) {
    const metrics = barMetricsForCount(1);
    return rows.map((row, index) => ({
      id: `single:${row.key}`,
      startIndex: index,
      endIndex: index,
      count: 1,
      tier: 0,
      grouped: false,
      singleKey: row.key,
      barHeight: metrics.barHeight,
      barRadius: metrics.barRadius,
    }));
  }

  const counts: number[] = [total];
  let barCount = total;
  const preferredMinSingles = Math.min(8, Math.max(4, Math.floor(maxBars * 0.4)));
  const hardMinSingles = Math.min(5, Math.max(2, Math.floor(maxBars * 0.25)));

  const foldTier = (tier: number): void => {
    const factor = tierMergeFactor(tier);
    counts[tier] = (counts[tier] ?? 0) - factor;
    counts[tier + 1] = (counts[tier + 1] ?? 0) + 1;
    barCount -= factor - 1;
  };

  while (barCount > maxBars) {
    const f0 = tierMergeFactor(0);
    if ((counts[0] ?? 0) - f0 >= preferredMinSingles) {
      foldTier(0);
      continue;
    }

    let mergedHigher = false;
    for (let tier = 1; tier < counts.length; tier += 1) {
      if ((counts[tier] ?? 0) >= tierMergeFactor(tier)) {
        foldTier(tier);
        mergedHigher = true;
        break;
      }
    }
    if (mergedHigher) continue;

    if ((counts[0] ?? 0) - f0 >= hardMinSingles) {
      foldTier(0);
      continue;
    }

    if ((counts[0] ?? 0) - f0 >= 1) {
      foldTier(0);
      continue;
    }

    break;
  }

  const raw: Array<{ startIndex: number; count: number; tier: number }> = [];
  let cursor = 0;
  for (let tier = counts.length - 1; tier >= 0; tier -= 1) {
    const n = counts[tier] ?? 0;
    const cap = tierCapacity(tier);
    for (let i = 0; i < n; i += 1) {
      raw.push({ startIndex: cursor, count: cap, tier });
      cursor += cap;
    }
  }

  // Fallback for tight responsive budgets (e.g. short split panes at 1,000 turns):
  // pair the earliest adjacent equal-size grouped bars so boundaries stay round
  // and bar count remains strictly <= maxBars while keeping recent singles intact.
  while (raw.length > maxBars) {
    let mergeAt = -1;
    for (let i = 0; i < raw.length - 1; i += 1) {
      if (raw[i]!.count > 1 && raw[i]!.count === raw[i + 1]!.count) {
        mergeAt = i;
        break;
      }
    }
    if (mergeAt < 0) {
      mergeAt = 0;
    }
    const left = raw[mergeAt]!;
    const right = raw[mergeAt + 1]!;
    raw.splice(mergeAt, 2, {
      startIndex: left.startIndex,
      count: left.count + right.count,
      tier: Math.max(left.tier, right.tier),
    });
  }

  return raw.map(entry => {
    const endIndex = entry.startIndex + entry.count - 1;
    const grouped = entry.count > 1;
    const metrics = barMetricsForCount(entry.count);
    return {
      id: grouped ? `group:${entry.startIndex}-${endIndex}` : `single:${rows[entry.startIndex]!.key}`,
      startIndex: entry.startIndex,
      endIndex,
      count: entry.count,
      tier: entry.tier,
      grouped,
      singleKey: grouped ? null : rows[entry.startIndex]!.key,
      barHeight: metrics.barHeight,
      barRadius: metrics.barRadius,
    };
  });
}

/**
 * Splits large grouped buckets (> 25 turns) into at most ~5–6 quick sub-range
 * chips (e.g. `1–500` → `1–100, 101–200, ...`; `1–100` → `1–20, 21–40, ...`).
 */
export function subRangesForBucket(bucket: TurnJumpBucket): TurnJumpSubRange[] {
  if (bucket.count <= 25) return [];

  let step: number;
  if (bucket.count <= 100) {
    step = 20;
  } else if (bucket.count <= 500) {
    step = 100;
  } else {
    step = Math.max(100, Math.ceil(bucket.count / 5 / 100) * 100);
  }

  const ranges: TurnJumpSubRange[] = [];
  for (let start = bucket.startIndex; start <= bucket.endIndex; start += step) {
    const end = Math.min(bucket.endIndex, start + step - 1);
    ranges.push({
      startIndex: start,
      endIndex: end,
      count: end - start + 1,
    });
  }
  return ranges.length > 1 ? ranges : [];
}

/**
 * Returns the normalized vertical position `[0, 1]` of `activeIndex` inside
 * `bucket`, or `null` when `activeIndex` falls outside this bucket.
 */
export function activeProgressInBucket(bucket: TurnJumpBucket, activeIndex: number): number | null {
  if (activeIndex < bucket.startIndex || activeIndex > bucket.endIndex) return null;
  if (!bucket.grouped) return 0.5;
  return (activeIndex - bucket.startIndex) / Math.max(1, bucket.count - 1);
}
