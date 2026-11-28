/**
 * Left-edge progressive turn minimap shared by Primary, Secondary Split, and BTW panes.
 *
 * - Up to the viewport bar budget (default 20): 1:1 thin horizontal hairlines.
 * - Beyond the budget (up to 1,000+ turns): progressively folds the oldest prefix
 *   into taller bars (`5 → 20 → 100 → 500 → ...`) while preserving recent turns 1:1.
 * - Hovering a single bar previews that turn; hovering or clicking a grouped bar
 *   opens an interactive right-anchored picker with sub-range chips and filter.
 */

import {
  cleanup,
  computed,
  effect,
  List,
  Overlay,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  type ListRef,
  type ViewRef,
} from "nsh";
import { Input } from "nsh/base";
import { formatCount, formatTimestamp } from "../format";
import { tr } from "../i18n";
import {
  compactLayout,
  controlHeight,
  inputFontSans,
  palette,
  radii,
  space,
  textLineHeight,
  textSize,
} from "../theme";
import { Icon } from "./icons";
import { MOTION_DURATION, enterMotion, paintTransition, pressTransition, tactileActiveStyle } from "./motion";
import { listRowHoverBg, registerEscapeDismiss } from "./overlays";
import { focusRingStyle } from "./primitives";
import {
  buildTurnJumpBuckets,
  maxBarsForRailHeight,
  subRangesForBucket,
  type TurnJumpBucket,
  type TurnJumpRowRef,
  type TurnJumpSubRange,
} from "./turnJumpRailModel";

export interface TurnJumpPreviewData {
  prompt: string;
  reply: string;
  timestamp?: number;
}

export interface TurnJumpRailProps {
  rows: () => ReadonlyArray<TurnJumpRowRef>;
  previewOf: (key: string) => TurnJumpPreviewData | null;
  activeKey: () => string;
  onJump: (key: string) => void;
  accessibilityLabel?: string;
  tickPrefix?: string;
}

interface TurnGroupListItem {
  key: string;
  index: number;
  prompt: string;
  reply: string;
  timestamp?: number;
}

const HOVER_CLOSE_DELAY_MS = 180;
const GROUP_FILTER_THRESHOLD = 10;
const GROUP_VIRTUALIZE_THRESHOLD = 24;
const GROUP_ROW_HEIGHT = 34;

function parseTurnNumberQuery(query: string): number | null {
  const match = query.match(/^#?(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatGroupTimeSpan(firstTs?: number, lastTs?: number): string {
  const start = firstTs ? formatTimestamp(firstTs) : "";
  const end = lastTs ? formatTimestamp(lastTs) : "";
  if (start && end && start !== end) return `${start} – ${end}`;
  return start || end;
}

export function TurnJumpRail(props: TurnJumpRailProps) {
  const railHeight = signal<number | undefined>(undefined);
  const hoveredBucketId = signal("");
  const pinnedBucketId = signal("");
  const popoverAnchor = signal<ViewRef | null>(null);
  const pointerInPopover = signal(false);
  const availablePopoverHeight = signal<number | null>(null);
  const groupQuery = signal("");
  const selectedSubRangeIndex = signal(-1);
  const bucketRefs = new Map<string, ViewRef>();
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearCloseTimer = () => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  cleanup(() => {
    clearCloseTimer();
    bucketRefs.clear();
  });

  const visible = computed(() => !compactLayout() && props.rows().length >= 2);
  const maxBars = computed(() => maxBarsForRailHeight(railHeight()));
  const buckets = computed(() => buildTurnJumpBuckets(props.rows(), { maxBars: maxBars() }));

  const resolvedActiveIndex = computed(() => {
    const list = props.rows();
    if (list.length === 0) return -1;
    const current = props.activeKey();
    if (current) {
      const found = list.findIndex(row => row.key === current);
      if (found >= 0) return found;
    }
    return list.length - 1;
  });

  const activePopoverId = computed(() => pinnedBucketId() || hoveredBucketId());
  const isPinned = computed(() => Boolean(pinnedBucketId()));

  const activePopoverBucket = computed<TurnJumpBucket | null>(() => {
    const id = activePopoverId();
    if (!id) return null;
    return buckets().find(bucket => bucket.id === id) ?? null;
  });

  const closePopover = () => {
    clearCloseTimer();
    pointerInPopover.set(false);
    pinnedBucketId.set("");
    hoveredBucketId.set("");
    popoverAnchor.set(null);
    groupQuery.set("");
    selectedSubRangeIndex.set(-1);
  };

  const scheduleHoverClose = () => {
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (!pinnedBucketId() && !pointerInPopover()) {
        hoveredBucketId.set("");
        popoverAnchor.set(null);
        groupQuery.set("");
        selectedSubRangeIndex.set(-1);
      }
    }, HOVER_CLOSE_DELAY_MS);
  };

  // Clear stale hover/pin state if the underlying bucket vanishes after a session switch or reset.
  effect(() => {
    const id = activePopoverId();
    const list = buckets();
    if (!id) return;
    if (!list.some(bucket => bucket.id === id)) {
      untracked(() => closePopover());
      return;
    }
    const nextAnchor = bucketRefs.get(id) ?? null;
    if (nextAnchor && untracked(() => popoverAnchor()) !== nextAnchor) {
      popoverAnchor.set(nextAnchor);
    }
  });

  const singlePreviewEntry = computed(() => {
    const bucket = activePopoverBucket();
    if (!bucket || bucket.grouped || !bucket.singleKey) return null;
    const preview = props.previewOf(bucket.singleKey);
    if (!preview) return null;
    return {
      key: bucket.singleKey,
      ...preview,
      index: bucket.startIndex,
      total: props.rows().length,
    };
  });

  const tickPrefix = props.tickPrefix ?? "turn-jump-";

  const handleTickEnter = (bucket: TurnJumpBucket, ref: ViewRef | null) => {
    clearCloseTimer();
    if (pinnedBucketId()) return;
    const prevId = hoveredBucketId();
    hoveredBucketId.set(bucket.id);
    popoverAnchor.set(ref ?? bucketRefs.get(bucket.id) ?? null);
    if (prevId !== bucket.id) {
      groupQuery.set("");
      selectedSubRangeIndex.set(-1);
    }
  };

  const handleTickLeave = (bucket: TurnJumpBucket) => {
    if (pinnedBucketId()) return;
    if (hoveredBucketId() !== bucket.id) return;
    if (!bucket.grouped) {
      hoveredBucketId.set("");
      popoverAnchor.set(null);
      return;
    }
    scheduleHoverClose();
  };

  const handleTickPress = (bucket: TurnJumpBucket, ref: ViewRef | null) => {
    clearCloseTimer();
    if (!bucket.grouped && bucket.singleKey) {
      const targetKey = bucket.singleKey;
      closePopover();
      props.onJump(targetKey);
      return;
    }
    if (pinnedBucketId() === bucket.id) {
      closePopover();
      return;
    }
    const switching = activePopoverId() !== bucket.id;
    pinnedBucketId.set(bucket.id);
    hoveredBucketId.set("");
    popoverAnchor.set(ref ?? bucketRefs.get(bucket.id) ?? null);
    if (switching) {
      groupQuery.set("");
      selectedSubRangeIndex.set(-1);
    }
  };

  const handleJumpFromGroup = (key: string) => {
    closePopover();
    props.onJump(key);
  };

  const pinActiveGroup = () => {
    const bucket = activePopoverBucket();
    if (!bucket || !bucket.grouped) return;
    clearCloseTimer();
    if (pinnedBucketId() !== bucket.id) {
      pinnedBucketId.set(bucket.id);
      hoveredBucketId.set("");
    }
  };

  const renderTicks = () => (
    <View style={{ alignItems: "flex-start" }}>
      <Each of={buckets()} key={bucket => bucket.id}>
        {bucket => {
          let tickRef: ViewRef | null = null;
          const id = () => bucket().id;
          const isGrouped = () => bucket().grouped;
          const isHighlighted = () => activePopoverId() === id();
          const isActive = () => {
            const active = resolvedActiveIndex();
            const b = bucket();
            return active >= b.startIndex && active <= b.endIndex;
          };
          const tickLabel = () => {
            const b = bucket();
            return b.grouped
              ? `${tickPrefix}group-${b.startIndex + 1}-${b.endIndex + 1}`
              : `${tickPrefix}${b.startIndex + 1}`;
          };

          return (
            <View
              ref={el => {
                const prev = tickRef;
                tickRef = el;
                const keyId = id();
                if (el) bucketRefs.set(keyId, el);
                else if (prev && bucketRefs.get(keyId) === prev) bucketRefs.delete(keyId);
              }}
              role="button"
              accessibilityLabel={tickLabel()}
              accessibilityState={{
                selected: isActive(),
                expanded: isGrouped() ? isHighlighted() : undefined,
              }}
              onMouseEnter={() => handleTickEnter(bucket(), tickRef)}
              onMouseLeave={() => handleTickLeave(bucket())}
              onPress={() => handleTickPress(bucket(), tickRef)}
              style={{
                width: 24,
                height: 12,
                justifyContent: "center",
                alignItems: "flex-start",
                cursor: "pointer",
                userSelect: "none",
              }}
              focusVisibleStyle={{ ...focusRingStyle(), outlineOffset: -1 }}
            >
              <View
                style={{
                  width: 9,
                  height: bucket().barHeight,
                  borderRadius: bucket().barRadius,
                  transformOrigin: "left center",
                  pointerEvents: "none",
                  backgroundColor: isHighlighted() || isActive() ? palette().text : palette().borderStrong,
                  opacity: isHighlighted() ? 1 : isActive() ? 0.9 : 0.55,
                  transform: isHighlighted()
                    ? [{ scaleX: 2.0 }, { scaleY: isGrouped() ? 1 : 1.75 }]
                    : isActive()
                      ? [{ scaleX: 1.45 }, { scaleY: isGrouped() ? 1 : 1.25 }]
                      : [{ scaleX: 1 }, { scaleY: 1 }],
                  ...pressTransition(MOTION_DURATION.fast),
                }}
              />
            </View>
          );
        }}
      </Each>
    </View>
  );

  return (
    <If when={visible()}>
      <View
        accessibilityLabel={props.accessibilityLabel ?? "turn-jump-rail"}
        onLayout={event => {
          const height = event.bounds.size.height;
          if (Number.isFinite(height) && height > 0 && Math.abs((railHeight() ?? 0) - height) >= 8) {
            railHeight.set(height);
          }
        }}
        style={{
          position: "absolute",
          left: 8,
          top: space.xl,
          bottom: space.xl,
          justifyContent: "center",
          pointerEvents: "box-none",
        }}
      >
        <View
          style={{
            paddingVertical: space.xs,
            paddingRight: space.xs,
            pointerEvents: "auto",
          }}
        >
          {renderTicks()}
        </View>

        <If when={Boolean(singlePreviewEntry() && popoverAnchor())}>
          <Overlay
            anchor={popoverAnchor()}
            placement="right"
            align="center"
            offset={10}
            margin={12}
          >
            <TurnJumpPreview entry={singlePreviewEntry} />
          </Overlay>
        </If>

        <If when={Boolean(activePopoverBucket()?.grouped && popoverAnchor())}>
          <Overlay
            anchor={popoverAnchor()}
            placement="right"
            align="center"
            offset={10}
            margin={12}
            onPosition={pos => {
              if (pos.available.height > 0) availablePopoverHeight.set(pos.available.height);
            }}
            onPressOutside={isPinned() ? closePopover : undefined}
            onCancel={isPinned() ? closePopover : undefined}
          >
            <TurnJumpGroupPopover
              bucket={() => {
                const b = activePopoverBucket();
                return b?.grouped ? b : null;
              }}
              rows={props.rows}
              previewOf={props.previewOf}
              activeIndex={resolvedActiveIndex}
              tickPrefix={tickPrefix}
              pinned={isPinned}
              query={groupQuery}
              onQueryChange={value => {
                groupQuery.set(value);
                pinActiveGroup();
              }}
              selectedSubRangeIndex={selectedSubRangeIndex}
              onSelectSubRange={idx => {
                selectedSubRangeIndex.set(idx);
                pinActiveGroup();
              }}
              maxHeight={() => {
                const avail = availablePopoverHeight();
                return avail && avail > 0 ? Math.max(180, Math.min(380, Math.floor(avail - 8))) : 360;
              }}
              onPointerEnter={() => {
                clearCloseTimer();
                pointerInPopover.set(true);
              }}
              onPointerLeave={() => {
                pointerInPopover.set(false);
                if (!pinnedBucketId()) scheduleHoverClose();
              }}
              onSelectTurn={handleJumpFromGroup}
              onClose={closePopover}
            />
          </Overlay>
        </If>
      </View>
    </If>
  );
}

function TurnJumpPreview(props: {
  entry: () => (TurnJumpPreviewData & { key: string; index: number; total: number }) | null;
}) {
  const motion = enterMotion("fadeIn", MOTION_DURATION.fast);
  return (
    <If when={props.entry()}>
      {current => (
        <View
          accessibilityLabel="turn-jump-preview"
          style={[
            {
              width: 312,
              paddingHorizontal: space.lg,
              paddingVertical: space.md,
              borderRadius: radii.lg,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: palette().borderStrong,
              backgroundColor: palette().glassOverlayBg,
              backdropFilter: "blur(16px)",
              boxShadow: palette().shadowOverlay,
              gap: space.xs,
              pointerEvents: "none",
            },
            motion.style,
          ]}
        >
          <If when={current().prompt}>
            <Text
              style={{
                color: palette().text,
                fontSize: textSize(13),
                lineHeight: textLineHeight(13, 1.4),
                fontWeight: "600",
                numberOfLines: 2,
                textOverflow: "ellipsis",
              }}
            >
              {current().prompt}
            </Text>
          </If>
          <If when={current().reply}>
            <Text
              style={{
                color: palette().textSecondary,
                fontSize: textSize(12),
                lineHeight: textLineHeight(12, 1.45),
                numberOfLines: 3,
                textOverflow: "ellipsis",
              }}
            >
              {current().reply}
            </Text>
          </If>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.sm,
              paddingTop: space.hair,
            }}
          >
            <Text
              style={{
                color: palette().textMuted,
                fontSize: textSize(12),
                lineHeight: textLineHeight(12, 1.3),
                fontVariant: ["tabular-nums"],
              }}
            >
              {tr("sessions.turnPosition", { current: current().index + 1, total: current().total })}
            </Text>
            <If when={current().timestamp ? formatTimestamp(current().timestamp) : ""}>
              {formatted => (
                <Text
                  style={{
                    color: palette().textMuted,
                    fontSize: textSize(12),
                    lineHeight: textLineHeight(12, 1.3),
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {formatted()}
                </Text>
              )}
            </If>
          </View>
        </View>
      )}
    </If>
  );
}

function TurnJumpGroupPopover(props: {
  bucket: () => TurnJumpBucket | null;
  rows: () => ReadonlyArray<TurnJumpRowRef>;
  previewOf: (key: string) => TurnJumpPreviewData | null;
  activeIndex: () => number;
  tickPrefix: string;
  pinned: () => boolean;
  query: () => string;
  onQueryChange: (value: string) => void;
  selectedSubRangeIndex: () => number;
  onSelectSubRange: (index: number) => void;
  maxHeight: () => number;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onSelectTurn: (key: string) => void;
  onClose: () => void;
}) {
  const motion = enterMotion("fadeIn", MOTION_DURATION.fast);
  let listRef: ListRef | undefined;
  let cachedBucketId = "";
  let cachedRowsRef: ReadonlyArray<TurnJumpRowRef> | null = null;
  const previewCache = new Map<string, TurnJumpPreviewData | null>();

  effect(() => {
    if (!props.pinned()) return;
    return registerEscapeDismiss(() => props.onClose());
  });

  const cachedPreview = (key: string): TurnJumpPreviewData | null => {
    const currentBucketId = props.bucket()?.id ?? "";
    const currentRows = props.rows();
    if (currentBucketId !== cachedBucketId || currentRows !== cachedRowsRef) {
      cachedBucketId = currentBucketId;
      cachedRowsRef = currentRows;
      previewCache.clear();
    }
    if (!previewCache.has(key)) {
      previewCache.set(key, props.previewOf(key));
    }
    return previewCache.get(key) ?? null;
  };

  const subRanges = computed<TurnJumpSubRange[]>(() => {
    const bucket = props.bucket();
    return bucket ? subRangesForBucket(bucket) : [];
  });

  const resolvedSubRangeIndex = computed(() => {
    const ranges = subRanges();
    if (ranges.length === 0) return -1;
    const explicit = props.selectedSubRangeIndex();
    if (explicit >= 0 && explicit < ranges.length) return explicit;
    const active = props.activeIndex();
    const containing = ranges.findIndex(range => active >= range.startIndex && active <= range.endIndex);
    return containing >= 0 ? containing : 0;
  });

  const normalizedQuery = computed(() => props.query().trim().toLowerCase());
  const showFilter = computed(() => (props.bucket()?.count ?? 0) > GROUP_FILTER_THRESHOLD);
  const showSubRanges = computed(() => subRanges().length > 1 && !normalizedQuery());

  const headerTimeSpan = computed(() => {
    const bucket = props.bucket();
    const rows = props.rows();
    if (!bucket || rows.length === 0) return "";
    const firstRow = rows[bucket.startIndex];
    const lastRow = rows[bucket.endIndex];
    const firstTs = firstRow ? cachedPreview(firstRow.key)?.timestamp : undefined;
    const lastTs = lastRow ? cachedPreview(lastRow.key)?.timestamp : undefined;
    return formatGroupTimeSpan(firstTs, lastTs);
  });

  const displayedItems = computed<TurnGroupListItem[]>(() => {
    const bucket = props.bucket();
    const rows = props.rows();
    if (!bucket || rows.length === 0) return [];

    const query = normalizedQuery();
    const ranges = subRanges();
    let rangeStart = bucket.startIndex;
    let rangeEnd = bucket.endIndex;
    if (!query && ranges.length > 1) {
      const sub = ranges[resolvedSubRangeIndex()] ?? ranges[0];
      if (sub) {
        rangeStart = sub.startIndex;
        rangeEnd = sub.endIndex;
      }
    }

    const boundedStart = Math.max(0, rangeStart);
    const boundedEnd = Math.min(rows.length - 1, rangeEnd);
    const targetNumber = query ? parseTurnNumberQuery(query) : null;
    const out: TurnGroupListItem[] = [];

    for (let i = boundedStart; i <= boundedEnd; i += 1) {
      const row = rows[i];
      if (!row) continue;
      const preview = cachedPreview(row.key);
      const prompt = preview?.prompt ?? "";
      const reply = preview?.reply ?? "";
      if (query) {
        const turnNum = i + 1;
        const numberMatch = targetNumber !== null
          ? turnNum === targetNumber || String(turnNum).includes(String(targetNumber))
          : false;
        const textMatch =
          prompt.toLowerCase().includes(query) ||
          reply.toLowerCase().includes(query);
        if (!numberMatch && !textMatch) continue;
      }
      out.push({
        key: row.key,
        index: i,
        prompt,
        reply,
        timestamp: preview?.timestamp,
      });
    }
    return out;
  });

  const listMaxHeight = computed(() => {
    const chromeHeight = 46 + (showFilter() ? 38 : 0) + (showSubRanges() ? 34 : 0);
    return Math.max(100, props.maxHeight() - chromeHeight);
  });

  const renderTurnRow = (item: () => TurnGroupListItem) => {
    const isCurrent = () => item().index === props.activeIndex();
    const title = () => {
      const current = item();
      return current.prompt || current.reply || tr("sessions.turnFallbackTitle", { index: current.index + 1 });
    };
    return (
      <View
        role="menuitem"
        accessibilityLabel={`${props.tickPrefix}item-${item().index + 1}`}
        accessibilityState={{ selected: isCurrent() }}
        onPress={() => props.onSelectTurn(item().key)}
        style={{
          height: GROUP_ROW_HEIGHT,
          minHeight: GROUP_ROW_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingHorizontal: space.sm,
          borderRadius: radii.sm,
          borderCurve: "continuous",
          cursor: "pointer",
          userSelect: "none",
          ...pressTransition(MOTION_DURATION.fast),
        }}
        hoverStyle={{ backgroundColor: listRowHoverBg() }}
        activeStyle={tactileActiveStyle(0.99, { backgroundColor: palette().buttonSecondaryHover })}
        focusVisibleStyle={{ ...focusRingStyle(), outlineOffset: -1 }}
      >
        <Text
          style={{
            minWidth: 28,
            textAlign: "right",
            color: isCurrent() ? palette().text : palette().textMuted,
            fontSize: textSize(11),
            lineHeight: textLineHeight(11, 1.3),
            fontWeight: isCurrent() ? "600" : "400",
            fontVariant: ["tabular-nums"],
            flexShrink: 0,
          }}
        >
          {item().index + 1}
        </Text>
        <Text
          style={{
            flex: 1,
            minWidth: 0,
            color: palette().text,
            fontSize: textSize(12),
            lineHeight: textLineHeight(12, 1.35),
            fontWeight: isCurrent() ? "600" : "400",
            numberOfLines: 1,
            textOverflow: "ellipsis",
          }}
        >
          {title()}
        </Text>
        <If when={isCurrent()}>
          <Icon name="check" size={12} color={palette().accent} />
        </If>
      </View>
    );
  };

  return (
    <If when={props.bucket()}>
      {currentBucket => (
        <View
          role="menu"
          accessibilityLabel="turn-jump-group-popover"
          onMouseEnter={props.onPointerEnter}
          onMouseLeave={props.onPointerLeave}
          style={[
            {
              width: 320,
              maxHeight: props.maxHeight(),
              padding: space.sm,
              borderRadius: radii.lg,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: palette().borderStrong,
              backgroundColor: palette().glassOverlayBg,
              backdropFilter: "blur(16px)",
              boxShadow: palette().shadowOverlay,
              gap: space.xs,
            },
            motion.style,
          ]}
        >
          {/* Header: turn range, count, and optional time span */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.sm,
              paddingHorizontal: space.sm,
              paddingTop: space.hair,
              paddingBottom: space.xs,
              borderBottomWidth: 1,
              borderColor: palette().borderSubtle,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.chip, minWidth: 0 }}>
              <Text
                style={{
                  color: palette().text,
                  fontSize: textSize(12),
                  lineHeight: textLineHeight(12, 1.3),
                  fontWeight: "600",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {tr("sessions.turnRange", {
                  start: currentBucket().startIndex + 1,
                  end: currentBucket().endIndex + 1,
                })}
              </Text>
              <Text
                style={{
                  color: palette().textMuted,
                  fontSize: textSize(11),
                  lineHeight: textLineHeight(11, 1.3),
                  fontVariant: ["tabular-nums"],
                }}
              >
                {tr("sessions.turnCount", { count: formatCount(currentBucket().count) })}
              </Text>
            </View>
            <If when={headerTimeSpan()}>
              {span => (
                <Text
                  style={{
                    color: palette().textMuted,
                    fontSize: textSize(11),
                    lineHeight: textLineHeight(11, 1.3),
                    fontVariant: ["tabular-nums"],
                    flexShrink: 0,
                  }}
                >
                  {span()}
                </Text>
              )}
            </If>
          </View>

          {/* Filter box for buckets larger than 10 turns */}
          <If when={showFilter()}>
            <View
              style={{
                boxSizing: "border-box",
                height: controlHeight.sm,
                minHeight: controlHeight.sm,
                flexShrink: 0,
                flexDirection: "row",
                alignItems: "center",
                gap: space.chip,
                paddingHorizontal: space.sm,
                borderRadius: radii.sm,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: palette().border,
                backgroundColor: palette().inputBg,
                ...paintTransition(MOTION_DURATION.fast),
              }}
              focusWithinStyle={{
                borderColor: palette().fieldFocusBorder,
                boxShadow: `0 0 0 2px ${palette().accentSoft}`,
              }}
            >
              <Icon name="search" size={12} color={palette().textElevatedMuted} />
              <Input
                value={props.query()}
                placeholder={tr("sessions.turnJumpFilterPlaceholder")}
                accessibilityLabel="turn-jump-group-filter"
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: "100%",
                  minHeight: controlHeight.sm - 2,
                  color: palette().text,
                  placeholderColor: palette().textElevatedMuted,
                  caretColor: palette().accent,
                  fontFamily: inputFontSans(),
                  fontSize: textSize(12),
                }}
                onChange={event => props.onQueryChange(event.value)}
                onSubmit={() => {
                  const first = displayedItems()[0];
                  if (first) props.onSelectTurn(first.key);
                }}
                onKeyPress={event => {
                  if (event.key === "Escape") props.onClose();
                }}
              />
              <If when={props.query()}>
                <View
                  role="button"
                  accessibilityLabel="turn-jump-group-filter-clear"
                  onPress={() => props.onQueryChange("")}
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: radii.pill,
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                  }}
                  hoverStyle={{ backgroundColor: palette().buttonSecondaryHover }}
                >
                  <Icon name="close" size={11} color={palette().textMuted} />
                </View>
              </If>
            </View>
          </If>

          {/* Sub-range chips for large buckets (e.g. 1–100 → 1–20, 21–40, ...; 1–500 → 1–100, ...) */}
          <If when={showSubRanges()}>
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: space.xs,
                paddingHorizontal: space.hair,
              }}
            >
              <Each of={subRanges()} key={sub => `${sub.startIndex}-${sub.endIndex}`}>
                {(sub, subIdx) => {
                  const isSelected = () => resolvedSubRangeIndex() === subIdx();
                  const hasActive = () => {
                    const active = props.activeIndex();
                    return active >= sub().startIndex && active <= sub().endIndex;
                  };
                  return (
                    <View
                      role="button"
                      accessibilityLabel={`turn-jump-subrange-${sub().startIndex + 1}-${sub().endIndex + 1}`}
                      accessibilityState={{ selected: isSelected() }}
                      onPress={() => {
                        props.onSelectSubRange(subIdx());
                        listRef?.scrollToOffset({ offset: 0, animated: false });
                      }}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: space.xs,
                        height: 22,
                        paddingHorizontal: space.sm,
                        borderRadius: radii.pill,
                        borderWidth: 1,
                        borderColor: isSelected() ? palette().borderStrong : "transparent",
                        backgroundColor: isSelected() ? palette().buttonSecondaryBg : "transparent",
                        cursor: "pointer",
                        userSelect: "none",
                        ...pressTransition(MOTION_DURATION.fast),
                      }}
                      hoverStyle={{ backgroundColor: listRowHoverBg() }}
                      focusVisibleStyle={{ ...focusRingStyle(), outlineOffset: -1 }}
                    >
                      <If when={hasActive()}>
                        <View
                          style={{
                            width: 4,
                            height: 4,
                            borderRadius: radii.pill,
                            backgroundColor: palette().accent,
                          }}
                        />
                      </If>
                      <Text
                        style={{
                          color: isSelected() ? palette().text : palette().textMuted,
                          fontSize: textSize(11),
                          lineHeight: textLineHeight(11, 1.25),
                          fontWeight: isSelected() ? "600" : "400",
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        {`${sub().startIndex + 1}–${sub().endIndex + 1}`}
                      </Text>
                    </View>
                  );
                }}
              </Each>
            </View>
          </If>

          {/* Turn list: compact Scroll for small groups, virtualized List for large slices */}
          <If
            when={displayedItems().length > 0}
            else={
              <View style={{ paddingVertical: space.lg, alignItems: "center" }}>
                <Text
                  style={{
                    color: palette().textMuted,
                    fontSize: textSize(12),
                    lineHeight: textLineHeight(12, 1.35),
                  }}
                >
                  {tr("sessions.turnJumpNoMatches")}
                </Text>
              </View>
            }
          >
            <If
              when={displayedItems().length > GROUP_VIRTUALIZE_THRESHOLD}
              else={
                <Scroll
                  smoothWheel
                  style={{
                    flexShrink: 1,
                    minHeight: 0,
                    maxHeight: listMaxHeight(),
                  }}
                  scrollbar={displayedItems().length > 8}
                >
                  <View style={{ gap: space.hair }}>
                    <Each of={displayedItems()} key={item => item.key}>
                      {item => renderTurnRow(item)}
                    </Each>
                  </View>
                </Scroll>
              }
            >
              <List<TurnGroupListItem>
                ref={el => {
                  listRef = el;
                }}
                style={{
                  height: Math.min(listMaxHeight(), displayedItems().length * GROUP_ROW_HEIGHT),
                  minHeight: 0,
                }}
                each={displayedItems()}
                keyExtractor={item => item.key}
                estimatedItemSize={GROUP_ROW_HEIGHT}
              >
                {item => renderTurnRow(item)}
              </List>
            </If>
          </If>
        </View>
      )}
    </If>
  );
}
