import { signal, View, type JSX } from "nsh";
import { designTokens } from "../generated/designTokens";
import { compactLayout, designControlColors, layout, palette, radii, space, textLineHeight } from "../theme";
import { Icon } from "./icons";
import { paintTransition, pressTransition, rotatingChevronStyle, subtleCrossfadeMotion } from "./motion";
import { focusRingStyle } from "./primitives";

export const toolCardMetrics = designTokens.metrics.toolCard;
const metrics = toolCardMetrics;

export function toolCardHeaderHeight(prominent: boolean): number {
  if (compactLayout()) return layout.touchTarget;
  if (!prominent) return textLineHeight(metrics.ambientBodySize, metrics.ambientBodyLineHeight);
  return Math.max(metrics.prominentHeight - 2 * metrics.borderWidth,
    textLineHeight(metrics.fontSize, metrics.lineHeight) + 2 * metrics.prominentPaddingBlock);
}

export function ToolCardFrame(props: {
  name: string;
  prominent: boolean;
  expanded: boolean;
  canExpand: boolean;
  muted: boolean;
  confirmation: boolean;
  hint?: string;
  headerMinHeight?: number;
  onToggle: () => void;
  leading: JSX.Element;
  summary: (engaged: () => boolean) => JSX.Element;
  actions?: JSX.Element;
  body: () => JSX.Element;
}) {
  const prominent = () => props.prominent;
  const expanded = () => props.canExpand && props.expanded;
  const hovered = signal(false);
  const focused = signal(false);
  const engaged = () => hovered() || focused();
  const inlineAffordance = () => !prominent() && props.canExpand &&
    (expanded() || engaged() || compactLayout());
  const border = () => props.confirmation ? palette().warningBorder : palette().border;
  const emphasisBorder = () => props.confirmation ? palette().warningBorder : palette().borderStrong;

  return (
    <View testID={prominent() ? "prominent-tool-card" : "ambient-tool-card"} style={{
      width: "100%", minWidth: 0, borderWidth: prominent() ? metrics.borderWidth : 0,
      borderRadius: prominent() ? metrics.prominentRadius : radii.md, borderCurve: "continuous",
      borderColor: prominent() ? border() : "transparent",
      backgroundColor: prominent() ? designControlColors()?.toolCardSurface ?? palette().panelRaised : "transparent",
      opacity: props.muted ? designControlColors()?.mutedOpacity ?? 0.75 : 1, ...paintTransition(),
    }} hoverStyle={prominent() ? { borderColor: emphasisBorder() } : undefined}
      focusWithinStyle={prominent() ? { borderColor: emphasisBorder() } : undefined}>
      <View style={{
        flexDirection: "row", minWidth: 0, alignItems: "center", gap: space.xs,
        paddingRight: prominent() ? metrics.prominentPaddingInline : space.sm,
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
            gap: prominent() ? space.sm : metrics.iconGap,
            minHeight: Math.max(toolCardHeaderHeight(prominent()), props.headerMinHeight ?? 0),
            paddingLeft: prominent() ? metrics.prominentPaddingInline : 0,
            paddingVertical: prominent() ? metrics.prominentPaddingBlock : 0,
            borderRadius: prominent() ? metrics.prominentRadius : radii.sm,
            cursor: props.canExpand ? "pointer" : "default", userSelect: "none",
            ...pressTransition(),
          }}
          hoverStyle={props.canExpand && !prominent() ? { backgroundColor: palette().surfaceSubtle } : undefined}
          focusVisibleStyle={props.canExpand ? focusRingStyle() : undefined}>
          <View style={{ width: metrics.iconSlot, height: metrics.iconSlot, flexShrink: 0,
            alignItems: "center", justifyContent: "center" }}>
            <If when={inlineAffordance()} else={props.leading}>
              <View style={rotatingChevronStyle(expanded())}>
                <Icon name="chevron-right" size={metrics.iconSize} color={palette().textSecondary} />
              </View>
            </If>
          </View>
          {props.summary(engaged)}
        </View>
        {props.actions}
      </View>
      <If when={expanded()}>
        {() => {
          const reveal = subtleCrossfadeMotion();
          return <View style={[{
            minWidth: 0, gap: space.sm, paddingHorizontal: metrics.expandedPaddingInline,
            paddingVertical: space.sm,
            marginTop: prominent() ? 0 : space.sm,
            borderTopWidth: prominent() ? metrics.borderWidth : 0,
            borderColor: palette().borderSubtle,
            borderRadius: prominent() ? 0 : radii.md,
            backgroundColor: prominent() ? "transparent" : palette().surfaceTertiary,
          }, reveal.style]}>{props.body()}</View>;
        }}
      </If>
    </View>
  );
}
