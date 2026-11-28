import { context, Scroll, View, type JSX, type ViewStyle } from "nsh";
import { layout, palette } from "../theme";

/** Width of this scene header occupied by the host's caption buttons, in layout points. */
export const SceneCaptionInset = context<() => number>(() => 0);

/** True when this scene sits at the top edge of a native window whose title bar uses native drag regions. */
export const SceneAtWindowTop = context<() => boolean>(() => false);

/**
 * Reserves the native top-right caption row (e.g. Windows minimize/maximize/close)
 * inside scrolling or split-column scenes that do not have a full-width 44 px
 * toolbar header, keeping scrolled content clear of the OS caption buttons and
 * giving the top strip a native drag / double-click-maximize region.
 */
export function CaptionDragStrip(props: { testID?: string; backgroundColor?: string } = {}) {
  const captionInset = SceneCaptionInset();
  const atWindowTop = SceneAtWindowTop();
  return (
    <If when={captionInset() > 0}>
      <View
        testID={props.testID}
        focusable={false}
        desktop={atWindowTop() ? { windowDrag: true } : undefined}
        style={{
          height: layout.topBarHeight,
          flexShrink: 0,
          backgroundColor: props.backgroundColor ?? palette().canvas,
        }}
      />
    </If>
  );
}

/** Narrow panes let the actions scroll within the space left by the caption. */
export function CaptionActionStrip(props: {
  inset: number;
  gap: number;
  role?: "tablist";
  children?: JSX.Element;
}) {
  const row = (): ViewStyle => ({
    flexDirection: "row",
    alignItems: props.role === "tablist" ? "stretch" : "center",
    gap: props.gap,
  });
  return (
    <If
      when={props.inset > 0}
      else={
        <View role={props.role} style={{ ...row(), minWidth: 0, flexShrink: props.role === "tablist" ? 1 : 0 }}>
          {props.children}
        </View>
      }
    >
      <Scroll horizontal role={props.role} style={{ minWidth: 0, flexShrink: 1 }} contentStyle={row()}>
        {props.children}
      </Scroll>
    </If>
  );
}
