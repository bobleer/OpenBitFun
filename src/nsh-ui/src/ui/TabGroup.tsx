import { Text, type JSX } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { designTokens } from "../generated/designTokens";
import { compactLayout, designControlColors, layout, palette, textStyle } from "../theme";
import { paintTransition } from "./motion";
import { focusRingStyle } from "./primitives";

const metrics = designTokens.metrics.tabGroup;

export function TabGroup<T extends string>(props: {
  items: ReadonlyArray<{ value: T; label: string; disabled?: boolean; testID?: string; icon?: JSX.Element }>;
  value: T;
  size?: "sm" | "md";
  wrap?: boolean;
  accessibilityLabel?: string;
  onChange: (value: T) => void;
}) {
  const size = () => metrics[props.size ?? "md"];
  const colors = designControlColors;
  return (
    <Tabs orientation="horizontal" accessibilityLabel={props.accessibilityLabel}
      style={{ flexDirection: "row", flexWrap: props.wrap ? "wrap" : undefined, alignItems: "center", gap: metrics.gap }}>
      <Each of={props.items} key={item => item.value}>
        {item => (
          <Tab selected={item().value === props.value} disabled={item().disabled} testID={item().testID}
            accessibilityLabel={item().label} onPress={() => props.onChange(item().value)}
            style={{
              height: compactLayout() ? layout.touchTarget : size().height,
              paddingHorizontal: size().padding, minWidth: 0, alignItems: "center", justifyContent: "center",
              flexDirection: "row", gap: metrics.gap,
              borderWidth: 1, borderRadius: metrics.radius, borderCurve: "continuous",
              borderColor: item().value === props.value ? "transparent" : colors()?.buttonOutlineBorder ?? palette().borderSubtle,
              backgroundColor: item().value === props.value ? colors()?.rowSelection ?? palette().chromeActive : "transparent",
              ...paintTransition(),
            }} focusVisibleStyle={focusRingStyle()}
            hoverStyle={item().disabled ? undefined : { backgroundColor: colors()?.buttonFill ?? palette().panelHover }}>
            {item().icon}
            <Text style={{ ...textStyle("label", { color: item().disabled ? palette().textMuted : palette().text }),
              fontWeight: item().value === props.value ? metrics.selectedWeight : textStyle("label").fontWeight,
              numberOfLines: 1, textOverflow: "ellipsis" }}>{item().label}</Text>
          </Tab>
        )}
      </Each>
    </Tabs>
  );
}
