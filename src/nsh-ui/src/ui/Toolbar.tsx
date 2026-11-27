import { View, type JSX, type StyleProp, type ViewStyle } from "nsh";
import { designTokens } from "../generated/designTokens";
import { compactLayout, layout, palette } from "../theme";

const metrics = designTokens.metrics.toolbar;

export function Toolbar(props: {
  size?: "sm" | "md";
  leading: JSX.Element;
  trailing?: JSX.Element;
  style?: StyleProp<ViewStyle>;
}) {
  const height = () => props.size === "md" ? metrics.mdHeight : metrics.smHeight;
  const padding = () => props.size === "md" ? {
    paddingTop: metrics.mdPaddingTop, paddingBottom: metrics.mdPaddingBottom,
    paddingLeft: metrics.mdPaddingLeft, paddingRight: metrics.mdPaddingRight,
  } : { paddingHorizontal: metrics.smPaddingInline, paddingVertical: metrics.smPaddingBlock };
  return (
    <View style={[{
      width: "100%", minWidth: 0, flexShrink: 0, flexDirection: "row", alignItems: "center",
      minHeight: compactLayout() ? Math.max(height(), layout.touchTarget) : height(),
      gap: metrics.groupGapMd, ...padding(), borderBottomWidth: 1,
      borderColor: palette().borderSubtle, backgroundColor: palette().panelRaised,
    }, props.style]}>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: metrics.groupGapMd }}>
        {props.leading}
      </View>
      <If when={Boolean(props.trailing)}>
        <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: metrics.groupGapSm }}>
          {props.trailing}
        </View>
      </If>
    </View>
  );
}

export function ToolbarSeparator() {
  return <View accessibilityElementsHidden style={{ width: 1, height: metrics.separatorHeight,
    flexShrink: 0, backgroundColor: palette().borderSubtle }} />;
}
