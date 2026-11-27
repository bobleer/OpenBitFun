import { View, type JSX, type StyleProp, type ViewRef, type ViewStyle } from "nsh";
import { designTokens } from "../generated/designTokens";
import { designControlColors, palette } from "../theme";
import { pressTransition } from "./motion";
import { focusRingStyle } from "./primitives";

const metrics = designTokens.metrics.card;

/** The subtle catalog Card with one accessible detail target and an independent action area. */
export function CatalogCard(props: {
  label: string;
  description?: string;
  testID: string;
  children: JSX.Element;
  actions?: JSX.Element;
  actionPlacement?: "trailing";
  viewRef?: (node: ViewRef | null) => void;
  style?: StyleProp<ViewStyle>;
  onOpen: () => void;
}) {
  return (
    <View style={[{ minWidth: 0, justifyContent: "space-between", gap: metrics.footerGap,
      flexDirection: props.actionPlacement === "trailing" ? "row" : undefined,
      alignItems: props.actionPlacement === "trailing" ? "flex-start" : undefined,
      borderRadius: metrics.radius, borderCurve: "continuous", padding: metrics.padding,
      backgroundColor: palette().surfaceTertiary, ...pressTransition() }, props.style]}
      hoverStyle={{ backgroundColor: palette().surfaceSubtle }}>
      <View ref={props.viewRef} role="button" testID={props.testID} accessibilityLabel={props.label}
        accessibilityDescription={props.description} onPress={props.onOpen}
        style={{ flexGrow: 1, flexBasis: props.actionPlacement === "trailing" ? 0 : undefined,
          minWidth: 0, gap: metrics.gap, borderRadius: metrics.radius, cursor: "pointer" }}
        activeStyle={{ backgroundColor: designControlColors()?.navigationPressed ?? palette().panelHover }}
        focusVisibleStyle={focusRingStyle()}>
        {props.children}
      </View>
      {props.actions}
    </View>
  );
}
