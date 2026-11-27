import { Text, View, type JSX } from "nsh";
import { controlHeight, layout, palette, radii, space, textStyle } from "../theme";
import { Icon, type IconName } from "./icons";
import { MOTION_DURATION, paintTransition } from "./motion";

export function SidebarRow(props: {
  label: string;
  icon?: IconName;
  leading?: JSX.Element;
  active: boolean;
  accessibilityLabel?: string;
  trailing?: JSX.Element;
  disabled?: boolean;
  tooltip?: string;
  touchSized?: boolean;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ selected: props.active, disabled: props.disabled }}
      tooltip={props.tooltip}
      onPress={props.disabled ? undefined : props.onPress}
      style={{
        height: props.touchSized ? layout.touchTarget : controlHeight.md,
        paddingHorizontal: space.sm,
        borderRadius: radii.md,
        borderCurve: "continuous",
        backgroundColor: props.active ? palette().chromeActive : "transparent",
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm + space.hair,
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.55 : 1,
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={props.disabled ? undefined : { backgroundColor: props.active ? palette().chromeActive : palette().chromeHover }}
      activeStyle={{ backgroundColor: palette().chromeActive }}
      focusVisibleStyle={{ outlineWidth: 2, outlineColor: palette().chromeAccent, outlineOffset: -1 }}
    >
      <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <If when={props.leading} else={<Icon name={props.icon ?? "inbox"} size={16} color={palette().chromeTextMuted} />}>
          {props.leading}
        </If>
      </View>
      <Text
        style={{
          ...textStyle("label", { color: palette().chromeText }),
          flex: 1,
          minWidth: 0,
          numberOfLines: 1,
          textOverflow: "ellipsis",
        }}
      >
        {props.label}
      </Text>
      {props.trailing}
    </View>
  );
}
