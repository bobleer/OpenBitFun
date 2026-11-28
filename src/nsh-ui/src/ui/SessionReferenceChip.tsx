import { Text, View } from "nsh";
import { tr } from "../i18n";
import type { SessionReferenceCandidate } from "../sessionReferences";
import { controlHeight, palette, radii, space, textStyle } from "../theme";
import { Icon } from "./icons";
import { IconButton, TooltipBubble, focusRingStyle } from "./primitives";

export function SessionReferenceChip(props: {
  reference: SessionReferenceCandidate;
  label: string;
  onRemove?: () => void;
  onOpen?: () => void;
}) {
  const hasAction = () => Boolean(props.onOpen);
  return (
    <View accessibilityLabel={props.label} style={{ flexDirection: "row", alignItems: "center",
      borderRadius: radii.md, borderWidth: 1, borderColor: palette().borderSubtle,
      backgroundColor: palette().surfaceTertiary, maxWidth: 224, minHeight: controlHeight.sm }}>
      <View role={hasAction() ? "button" : undefined} onPress={props.onOpen}
        accessibilityLabel={hasAction() ? tr("sessions.openSessionReference", { name: props.reference.sessionName }) : undefined}
        tooltip={
          props.reference.workspaceLabel && props.reference.workspaceLabel !== props.reference.sessionName
            ? <TooltipBubble text={props.reference.workspaceLabel} />
            : undefined
        }
        focusVisibleStyle={hasAction() ? focusRingStyle() : undefined}
        style={{ flexDirection: "row", alignItems: "center", minWidth: 0, flexShrink: 1, gap: space.xs,
          paddingHorizontal: space.sm, cursor: hasAction() ? "pointer" : "default" }}>
        <Icon name="chat" size={14} color={palette().textSecondary} />
        <Text style={{ ...textStyle("caption"), flexShrink: 1, minWidth: 0, numberOfLines: 1, textOverflow: "ellipsis" }}>
          {props.reference.sessionName}
        </Text>
      </View>
      <If when={props.onRemove}>
        <IconButton icon="close" size="xs" accessibilityLabel={`remove-${props.label}`}
          tooltip={tr("sessions.removeSessionReference", { name: props.reference.sessionName })}
          onPress={() => props.onRemove?.()} />
      </If>
    </View>
  );
}
