import { Text, View, type ViewRef } from "nsh";
import { designTokens } from "../generated/designTokens";
import { designControlColors, palette, textStyle } from "../theme";
import { Icon, type IconName } from "./icons";
import { pressTransition } from "./motion";
import { focusRingStyle } from "./primitives";

const metrics = designTokens.metrics.actionCard;

export function ActionCard(props: {
  label: string;
  detail?: string;
  description?: string;
  icon: IconName;
  iconColor?: string;
  compact?: boolean;
  selected?: boolean;
  testID: string;
  multilineDetail?: boolean;
  onPress: () => void;
  onHover?: () => void;
  viewRef?: (node: ViewRef | null) => void;
}) {
  const selection = () => designControlColors()?.rowSelection ?? palette().panelHover;
  return (
    <View ref={props.viewRef} role={props.selected === undefined ? "button" : "option"}
      testID={props.testID} accessibilityLabel={props.label}
      accessibilityDescription={[props.detail, props.description].filter(Boolean).join("\n") || undefined}
      accessibilityState={props.selected === undefined ? undefined : { selected: props.selected }}
      onPress={props.onPress} onMouseEnter={props.onHover}
      style={{
        flexDirection: "row", alignItems: "center", gap: metrics.gap, minWidth: 0,
        minHeight: props.compact ? metrics.compactHeight : metrics.minHeight,
        paddingHorizontal: metrics.paddingInline, paddingVertical: metrics.paddingBlock,
        borderRadius: metrics.radius, borderCurve: "continuous", borderWidth: 1,
        borderColor: props.selected ? palette().border : "transparent",
        backgroundColor: props.selected ? selection() : designControlColors()?.actionCardSurface ?? palette().surfaceSubtle,
        cursor: "pointer", ...pressTransition(),
      }} hoverStyle={{ backgroundColor: selection() }} focusVisibleStyle={focusRingStyle()}>
      <View style={{ width: metrics.leadingSize, height: metrics.leadingSize, flexShrink: 0,
        alignItems: "center", justifyContent: "center" }}>
        <Icon name={props.icon} size={metrics.iconSize} color={props.iconColor ?? palette().textSecondary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: metrics.contentGap }}>
        <Text style={{ ...textStyle("label"), numberOfLines: 1, textOverflow: "ellipsis" }}>{props.label}</Text>
        <If when={props.detail}>
          {detail => <Text style={{ ...textStyle("caption"), numberOfLines: props.multilineDetail ? 2 : 1,
            textOverflow: "ellipsis" }}>{detail()}</Text>}
        </If>
        <If when={props.description}>
          {description => <Text style={{ ...textStyle("body"), color: palette().textSecondary,
            numberOfLines: 4, textOverflow: "ellipsis" }}>{description()}</Text>}
        </If>
      </View>
    </View>
  );
}
