import { computed, signal, Text, View, type JSX, type ViewRef } from "nsh";
import { designTokens } from "../generated/designTokens";
import { designControlColors, inputFontSans, palette, textSize } from "../theme";
import { MOTION_DURATION, paintTransition } from "./motion";

export const chatComposerMetrics = designTokens.metrics.chatComposer;
const metrics = chatComposerMetrics;
const border = metrics.borderWidth;

export function ChatComposer(props: {
  value: () => string;
  forceExpanded: () => boolean;
  editorFontSize: () => number;
  editor: (expanded: () => boolean) => JSX.Element;
  startActions: JSX.Element;
  endActions: JSX.Element;
  attachmentStrip?: JSX.Element;
  cardRef?: (view: ViewRef | null) => void;
  dragging?: boolean;
}) {
  const surfaceWidth = signal(0);
  const startWidth = signal(0);
  const endWidth = signal(0);
  const draftWidth = signal(0);
  const canMeasureDraft = () => !props.forceExpanded() && !!props.value() && !props.value().includes("\n");
  const expanded = computed(() => {
    if (props.forceExpanded() || props.value().includes("\n")) return true;
    const available = surfaceWidth() - startWidth() - endWidth() -
      2 * (metrics.compactPaddingInline + metrics.compactGap + border);
    return surfaceWidth() > 0 && Math.max(textSize(metrics.textSize) * 4, canMeasureDraft() ? draftWidth() : 0) > available;
  });

  return (
    <View
      ref={node => props.cardRef?.(node)}
      testID="chat-composer-surface"
      onLayout={event => surfaceWidth.set(event.bounds.size.width)}
      style={{
        display: "grid", width: "100%", minWidth: 0, boxSizing: "border-box",
        gridTemplateColumns: expanded() ? "minmax(0, 1fr) auto" : "auto minmax(0, 1fr) auto",
        gridTemplateRows: expanded() ? `minmax(${metrics.editorMinHeight}px, 1fr) auto` : `${metrics.compactTrackHeight}px`,
        minHeight: expanded() ? metrics.expandedHeight : metrics.compactHeight,
        height: expanded() ? undefined : metrics.compactHeight,
        alignItems: expanded() ? "end" : "center", alignContent: expanded() ? "stretch" : "center",
        gap: expanded() ? metrics.expandedGap : metrics.compactGap,
        paddingHorizontal: expanded() ? metrics.expandedPadding : metrics.compactPaddingInline,
        paddingVertical: expanded() ? metrics.expandedPadding : metrics.compactPaddingBlock,
        borderRadius: metrics.radius, borderCurve: "continuous", borderWidth: border,
        borderColor: props.dragging ? palette().accent : designControlColors()?.composerBorder ?? palette().border,
        backgroundColor: props.dragging ? palette().accentSoft : palette().panelRaised,
        boxShadow: palette().shadowComposer, overflow: "hidden",
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{ borderColor: props.dragging ? palette().accent : palette().borderStrong }}
      focusWithinStyle={{ borderColor: props.dragging ? palette().accent : palette().border }}
    >
      <View style={{ gridColumn: expanded() ? "1 / 3" : 2, gridRow: 1,
        minWidth: 0, alignSelf: expanded() ? "stretch" : "center",
        padding: expanded() ? metrics.editorPadding : 0 }}>
        {props.attachmentStrip}
        {props.editor(expanded)}
      </View>
      <View onLayout={event => startWidth.set(event.bounds.size.width)} style={{
        gridColumn: 1, gridRow: expanded() ? 2 : 1, alignSelf: "center", justifySelf: "start", minWidth: 0,
      }}>
        {props.startActions}
      </View>
      <View onLayout={event => endWidth.set(event.bounds.size.width)} style={{
        gridColumn: expanded() ? 2 : 3, gridRow: expanded() ? 2 : 1, alignSelf: "center", justifySelf: "end", minWidth: 0,
      }}>
        {props.endActions}
      </View>
      <If when={canMeasureDraft()}>
        <Text
          accessible={false}
          accessibilityElementsHidden
          onLayout={event => draftWidth.set(event.bounds.size.width)}
          style={{ position: "absolute", left: 0, top: 0, width: "max-content",
            visibility: "hidden", pointerEvents: "none", fontFamily: inputFontSans(), fontSize: props.editorFontSize(), numberOfLines: 1 }}
        >{props.value()}</Text>
      </If>
    </View>
  );
}
