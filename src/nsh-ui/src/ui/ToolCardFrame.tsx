import { signal, View, type JSX } from "nsh";
import { designTokens } from "../generated/designTokens";
import { compactLayout, designControlColors, layout, palette, radii, space, textLineHeight } from "../theme";
import { Icon } from "./icons";
import {
  MOTION_DURATION,
  MorphSlot,
  SmoothDisclosure,
  paintTransition,
  pressTransition,
  rotatingChevronStyle,
} from "./motion";
import { focusRingStyle } from "./primitives";

export const toolCardMetrics = designTokens.metrics.toolCard;
const metrics = toolCardMetrics;

export function toolCardHeaderHeight(): number {
  if (compactLayout()) return layout.touchTarget;
  return textLineHeight(metrics.ambientBodySize, metrics.ambientBodyLineHeight);
}

export function ToolCardFrame(props: {
  name: string;
  expanded: boolean;
  canExpand: boolean;
  muted: boolean;
  confirmation: boolean;
  hint?: string;
  headerMinHeight?: number;
  /** Optional state key for in-place leading icon morphs (e.g. spinner → settled icon). */
  leadingKey?: string;
  onToggle: () => void;
  leading: JSX.Element;
  summary: (engaged: () => boolean) => JSX.Element;
  actions?: JSX.Element;
  body: () => JSX.Element;
}) {
  const expanded = () => props.canExpand && props.expanded;
  const hovered = signal(false);
  const focused = signal(false);
  const engaged = () => hovered() || focused();
  const inlineAffordance = () => props.canExpand && (expanded() || engaged() || compactLayout());

  return (
    <View testID="tool-card" style={{
      width: "100%", minWidth: 0,
      borderRadius: radii.md, borderCurve: "continuous",
      borderColor: props.confirmation ? palette().warningBorder : "transparent",
      backgroundColor: "transparent",
      opacity: props.muted ? designControlColors()?.mutedOpacity ?? 0.75 : 1,
      ...paintTransition(MOTION_DURATION.base),
    }}>
      <SmoothDisclosure
        open={expanded}
        contentGap={space.sm}
        content={() => (
          <View style={{
            minWidth: 0, gap: space.sm, paddingHorizontal: metrics.expandedPaddingInline,
            paddingVertical: space.sm,
            borderRadius: radii.md,
            backgroundColor: palette().surfaceTertiary,
          }}>{props.body()}</View>
        )}
      >
        <View style={{
          flexDirection: "row", minWidth: 0, alignItems: "center", gap: space.xs,
          paddingRight: space.sm,
        }}>
          <View role={props.canExpand ? "button" : undefined}
            accessibilityLabel={`tool-card-${props.name}`}
            accessibilityHint={props.hint}
            accessibilityState={props.canExpand ? { expanded: expanded() } : undefined}
            tooltip={props.hint}
            onPress={props.canExpand ? props.onToggle : undefined}
            onMouseEnter={() => hovered.set(true)}
            onMouseLeave={() => hovered.set(false)}
            onFocus={() => focused.set(true)}
            onBlur={() => focused.set(false)}
            style={{
              flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center",
              gap: metrics.iconGap,
              minHeight: Math.max(toolCardHeaderHeight(), props.headerMinHeight ?? 0),
              paddingLeft: 0,
              paddingVertical: 0,
              borderRadius: radii.sm,
              cursor: props.canExpand ? "pointer" : "default", userSelect: "none",
              ...pressTransition(),
            }}
            hoverStyle={props.canExpand ? { backgroundColor: palette().surfaceSubtle } : undefined}
            focusVisibleStyle={props.canExpand ? focusRingStyle() : undefined}>
            <MorphSlot
              morphKey={() => (inlineAffordance() ? "chevron" : (props.leadingKey ?? "icon"))}
              mode="scale"
              duration={MOTION_DURATION.fast}
              style={{
                width: metrics.iconSlot, height: metrics.iconSlot, flexShrink: 0,
                alignItems: "center", justifyContent: "center",
              }}
            >
              <If when={inlineAffordance()} else={props.leading}>
                <View style={rotatingChevronStyle(expanded())}>
                  <Icon name="chevron-right" size={metrics.iconSize} color={palette().textSecondary} />
                </View>
              </If>
            </MorphSlot>
            {props.summary(engaged)}
          </View>
          {props.actions}
        </View>
      </SmoothDisclosure>
    </View>
  );
}
