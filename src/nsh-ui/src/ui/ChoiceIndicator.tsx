import { View, type JSX, type StyleProp, type ViewStyle } from "nsh";
import { Checkbox } from "nsh/base";
import { designControlColors, palette, radii, space } from "../theme";
import { Icon } from "./icons";
import { MOTION_DURATION, paintTransition } from "./motion";
import { focusRingStyle } from "./primitives";

/** The check or radio mark inside an already accessible, pressable row. */
export function ChoiceIndicator(props: {
  kind: "checkbox" | "radio";
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  size?: "md" | "lg";
  style?: StyleProp<ViewStyle>;
}) {
  const radio = () => props.kind === "radio";
  const marked = () => props.checked || props.indeterminate;
  // Match the Checkbox and Radio size variants from the public component CSS.
  const diameter = () => (radio() ? 16 : 14) + (props.size === "lg" ? 2 : 0);
  const checkedFill = () => radio() ? palette().accent : designControlColors()?.selectionIndicator ?? palette().accent;
  const checkedMark = () => {
    const colors = designControlColors();
    if (props.disabled) return colors?.contentDisabled ?? palette().textMuted;
    return (radio() ? colors?.contentInverse : colors?.switchThumb) ?? palette().actionSolidFg;
  };

  return (
    <View
      accessibilityElementsHidden
      style={[{
        boxSizing: "border-box",
        pointerEvents: "none",
        width: diameter(),
        height: diameter(),
        flexShrink: 0,
        borderRadius: radio() ? radii.pill : radii.sm,
        borderWidth: 1,
        borderColor: marked() ? checkedFill() : designControlColors()?.fieldBorder ?? palette().borderStrong,
        backgroundColor: marked() && (!props.disabled || radio()) ? checkedFill() : palette().inputBg,
        alignItems: "center",
        justifyContent: "center",
        ...paintTransition(MOTION_DURATION.fast),
      }, props.style]}
    >
      <If when={marked()}>
        <If when={radio()} else={
          <If when={props.indeterminate} else={<Icon name="check" size={diameter() - 4} color={checkedMark()} />}>
            <View style={{ width: diameter() - 6, height: 2, borderRadius: radii.pill, backgroundColor: checkedMark() }} />
          </If>
        }>
          <View style={{ width: diameter() / 2, height: diameter() / 2, borderRadius: radii.pill, backgroundColor: checkedMark() }} />
        </If>
      </If>
    </View>
  );
}

export function ChoiceCheckbox(props: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  children?: JSX.Element;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Checkbox checked={props.checked} indeterminate={props.indeterminate} disabled={props.disabled}
      accessibilityLabel={props.accessibilityLabel} testID={props.testID}
      onChange={event => props.onChange(event.checked)}
      style={[{ minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm,
        borderRadius: radii.sm, cursor: props.disabled ? "default" : "pointer" }, props.style]}
      focusVisibleStyle={focusRingStyle()} disabledStyle={{ opacity: designControlColors()?.disabledOpacity ?? 0.48 }}
      indicator={<ChoiceIndicator kind="checkbox" checked={props.checked}
        indeterminate={props.indeterminate} disabled={props.disabled} />}>
      {props.children}
    </Checkbox>
  );
}
