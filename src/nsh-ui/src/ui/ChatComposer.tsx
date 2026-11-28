import { View, type JSX, type ViewRef } from "nsh";
import { designTokens } from "../generated/designTokens";
import { designControlColors, palette, space } from "../theme";
import { MOTION_DURATION, paintTransition } from "./motion";

export const chatComposerMetrics = designTokens.metrics.chatComposer;
export const CHAT_COMPOSER_MAX_LINES = 5;
const metrics = chatComposerMetrics;
const border = metrics.borderWidth;

export function ChatComposer(props: {
  editor: JSX.Element;
  startActions: JSX.Element;
  endActions: JSX.Element;
  attachmentStrip?: JSX.Element;
  cardRef?: (view: ViewRef | null) => void;
  dragging?: boolean;
}) {
  return (
    <View
      ref={node => props.cardRef?.(node)}
      testID="chat-composer-surface"
      style={{
        flexDirection: "column",
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        gap: space.sm,
        paddingHorizontal: metrics.expandedPadding,
        paddingVertical: metrics.expandedPadding,
        borderRadius: metrics.radius,
        borderCurve: "continuous",
        borderWidth: border,
        borderColor: props.dragging ? palette().accent : designControlColors()?.composerBorder ?? palette().border,
        backgroundColor: props.dragging ? palette().accentSoft : palette().panelRaised,
        boxShadow: palette().shadowComposer,
        overflow: "hidden",
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{ borderColor: props.dragging ? palette().accent : palette().borderStrong }}
      focusWithinStyle={{ borderColor: props.dragging ? palette().accent : palette().border }}
    >
      <View style={{ minWidth: 0, padding: metrics.editorPadding }}>
        {props.attachmentStrip}
        {props.editor}
      </View>
      <View style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: metrics.expandedGap,
        minWidth: 0,
      }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" }}>
          {props.startActions}
        </View>
        <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center" }}>
          {props.endActions}
        </View>
      </View>
    </View>
  );
}
