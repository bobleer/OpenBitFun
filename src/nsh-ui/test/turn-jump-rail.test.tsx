// Progressive TurnJumpRail bucketing invariants (1..1,500 turns) and interactive
// UI tests: 1:1 hairlines <= 20, prefix-aligned multi-tier folding up to 1,000
// turns, click-to-pin group picker, sub-range chips, search filter, and short
// viewport adaptive bar capping.
import { expect, open, test } from "nsh/test";
import {
  DEFAULT_RAIL_MAX_BARS,
  MIN_RAIL_MAX_BARS,
  activeProgressInBucket,
  buildTurnJumpBuckets,
  maxBarsForRailHeight,
  subRangesForBucket,
} from "../src/ui/turnJumpRailModel";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const FIXTURE = "./fixtures/turnJumpRailFixture.tsx";

function makeRowRefs(count: number) {
  return Array.from({ length: count }, (_, idx) => ({ key: `t-${idx + 1}` }));
}

test("bucketing invariants hold across every turn count from 1 to 1,500 and tight budgets", () => {
  for (const maxBars of [DEFAULT_RAIL_MAX_BARS, MIN_RAIL_MAX_BARS]) {
    for (let total = 1; total <= 1500; total += total < 120 ? 1 : total < 400 ? 7 : 13) {
      const rows = makeRowRefs(total);
      const buckets = buildTurnJumpBuckets(rows, { maxBars });

      expect(buckets.length).toBeLessThanOrEqual(maxBars);
      expect(buckets.length).toBeGreaterThan(0);

      // Contiguous [0, total - 1] coverage, non-increasing bar height from oldest to newest.
      let cursor = 0;
      for (let i = 0; i < buckets.length; i += 1) {
        const b = buckets[i]!;
        expect(b.startIndex).toBe(cursor);
        expect(b.endIndex).toBe(cursor + b.count - 1);
        expect(b.grouped).toBe(b.count > 1);
        expect(b.barHeight).toBe(b.grouped ? 4 : 2);
        expect(b.barRadius).toBe(1);
        if (i > 0) {
          expect(b.barHeight).toBeLessThanOrEqual(buckets[i - 1]!.barHeight);
        }
        cursor += b.count;
      }
      expect(cursor).toBe(total);

      if (total <= maxBars) {
        expect(buckets.length).toBe(total);
        expect(buckets.every(b => !b.grouped && b.count === 1)).toBe(true);
      }
    }
  }
});

test("default 20-bar ladder produces exact clean milestones up to 1,000 turns", () => {
  const countsOf = (total: number) => buildTurnJumpBuckets(makeRowRefs(total)).map(b => b.count);

  expect(countsOf(20)).toEqual(Array(20).fill(1));
  expect(countsOf(21)).toEqual([5, ...Array(16).fill(1)]);
  expect(countsOf(25)).toEqual([5, 5, ...Array(15).fill(1)]);
  expect(countsOf(60)).toEqual([...Array(10).fill(5), ...Array(10).fill(1)]);
  expect(countsOf(100)).toEqual([20, 20, 20, ...Array(6).fill(5), ...Array(10).fill(1)]);
  expect(countsOf(200)).toEqual([100, 20, 20, 20, 20, 5, 5, ...Array(10).fill(1)]);
  expect(countsOf(500)).toEqual([100, 100, 100, 100, 20, 20, 20, 20, 5, 5, ...Array(10).fill(1)]);
  expect(countsOf(1000)).toEqual([500, 100, 100, 100, 100, 20, 20, 20, 20, 5, 5, 5, 1, 1, 1, 1, 1]);

  // Prefix stability: adding 1 turn within a tier never shifts older folded boundaries.
  const b21 = buildTurnJumpBuckets(makeRowRefs(21));
  const b22 = buildTurnJumpBuckets(makeRowRefs(22));
  expect(b21[0]!.id).toBe("group:0-4");
  expect(b22[0]!.id).toBe("group:0-4");

  // Sub-ranges and active progress helpers.
  const b1000 = buildTurnJumpBuckets(makeRowRefs(1000));
  expect(subRangesForBucket(b1000[0]!).map(r => [r.startIndex + 1, r.endIndex + 1])).toEqual([
    [1, 100],
    [101, 200],
    [201, 300],
    [301, 400],
    [401, 500],
  ]);
  expect(subRangesForBucket(b1000[1]!).map(r => [r.startIndex + 1, r.endIndex + 1])).toEqual([
    [501, 520],
    [521, 540],
    [541, 560],
    [561, 580],
    [581, 600],
  ]);
  expect(subRangesForBucket(b1000[5]!)).toEqual([]);
  expect(activeProgressInBucket(b1000[0]!, 0)).toBe(0);
  expect(activeProgressInBucket(b1000[0]!, 499)).toBe(1);
  expect(activeProgressInBucket(b1000[0]!, 500)).toBeNull();

  // Viewport height budget clamps cleanly between 12 and 20.
  expect(maxBarsForRailHeight(undefined)).toBe(20);
  expect(maxBarsForRailHeight(500)).toBe(20);
  expect(maxBarsForRailHeight(320)).toBe(16);
  expect(maxBarsForRailHeight(250)).toBe(12);
});

test("TurnJumpRail stays 1:1 up to 20 turns and folds into click-to-pin grouped bars at 25, 100, and 1,000 turns", async () => {
  const app = await open(FIXTURE, DESKTOP);
  await app.waitFor("turn-jump-rail");

  // 20 turns: strictly 1:1 single hairlines.
  expect(app.shows("turn-jump-1")).toBe(true);
  expect(app.shows("turn-jump-20")).toBe(true);
  expect(app.shows("turn-jump-group-1-5")).toBe(false);

  await app.hover("turn-jump-1");
  await app.waitFor("turn-jump-preview");
  expect(app.shows("label:turn-jump-preview >> text:Prompt #1: Topic 1 architecture note")).toBe(true);
  await app.press("turn-jump-1");
  await app.waitFor("text:jumped=turn-1 active=turn-1 total=20");

  // 25 turns: oldest 10 fold into [1–5] and [6–10]; small group popover omits filter box.
  await app.press("Count 25");
  await app.waitFor("turn-jump-group-1-5");
  expect(app.shows("turn-jump-group-6-10")).toBe(true);
  expect(app.shows("turn-jump-11")).toBe(true);
  expect(app.shows("turn-jump-25")).toBe(true);
  expect(app.shows("turn-jump-1")).toBe(false);

  await app.press("turn-jump-group-1-5");
  await app.waitFor("turn-jump-group-popover");
  expect(app.shows("turn-jump-group-filter")).toBe(false);
  expect(app.shows("turn-jump-item-3")).toBe(true);
  await app.press("turn-jump-item-3");
  await app.waitFor("text:jumped=turn-3 active=turn-3 total=25");
  expect(app.shows("turn-jump-group-popover")).toBe(false);

  // 100 turns: [1–20] group exposes filter input; filtering by #14 jumps straight to turn 14.
  await app.press("Count 100");
  await app.waitFor("turn-jump-group-1-20");
  expect(app.shows("turn-jump-group-61-65")).toBe(true);
  expect(app.shows("turn-jump-100")).toBe(true);

  await app.press("turn-jump-group-1-20");
  await app.waitFor("turn-jump-group-filter");
  await app.type("turn-jump-group-filter", "#14");
  await app.waitFor("turn-jump-item-14");
  expect(app.shows("turn-jump-item-1")).toBe(false);
  await app.press("turn-jump-item-14");
  await app.waitFor("text:jumped=turn-14 active=turn-14 total=100");
  expect(app.shows("turn-jump-group-popover")).toBe(false);

  // 1,000 turns: full multi-tier ladder (500 / 100 / 20 / 5 / 1), sub-range chips, and Escape dismiss.
  await app.press("Count 1000");
  await app.waitFor("turn-jump-group-1-500");
  expect(app.shows("turn-jump-group-501-600")).toBe(true);
  expect(app.shows("turn-jump-group-901-920")).toBe(true);
  expect(app.shows("turn-jump-group-981-985")).toBe(true);
  expect(app.shows("turn-jump-996")).toBe(true);
  expect(app.shows("turn-jump-1000")).toBe(true);

  await app.press("turn-jump-group-1-500");
  await app.waitFor("turn-jump-group-popover");
  expect(app.shows("turn-jump-subrange-1-100")).toBe(true);
  expect(app.shows("turn-jump-subrange-301-400")).toBe(true);

  // Filter across the entire 500-turn block by keyword.
  await app.type("turn-jump-group-filter", "Quantum");
  await app.waitFor("turn-jump-item-357");
  await app.press("turn-jump-item-357");
  await app.waitFor("text:jumped=turn-357 active=turn-357 total=1000");

  // Re-open pinned popover and dismiss with Escape.
  await app.press("turn-jump-group-501-600");
  await app.waitFor("turn-jump-group-popover");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("turn-jump-group-popover"));

  // Short viewport (300px) dynamically shrinks bar cap (12 bars) so 1,000 turns stay bounded.
  await app.press("Height 300");
  await app.waitFor("turn-jump-group-501-900");
  expect(app.shows("turn-jump-group-501-600")).toBe(false);
  expect(app.shows("turn-jump-group-901-940")).toBe(true);
  expect(app.shows("turn-jump-1000")).toBe(true);
});
