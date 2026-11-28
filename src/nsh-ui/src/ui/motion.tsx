// Motion, layout transition, and spinner primitives backed by NSH's native
// LayoutAnimation, createMotion, ShaderTransition, and Canvas animations.
// Follows Emil Kowalski & Apple Fluid Interfaces craft discipline:
// - GPU-composited transitions (`transform`, `opacity`) and color-only paint fades (never `box-shadow`).
// - Strong custom ease-out curves (`cubic-bezier(0.23, 1, 0.32, 1)`) — never `ease-in` on UI.
// - Subtle tactile press feedback (`scale(0.97)` gated off under `reduceMotion()`).
// - Origin-aware popover entrances and non-uniform sub-300ms stagger waves.
// - Instant primary scene switching (100+/day navigation never blocks behind ShaderTransition).

import {
  Animated,
  Canvas,
  Easing,
  LayoutAnimation,
  ShaderTransition,
  Text,
  View,
  cleanup,
  computed,
  createAnimatedValue,
  createMotion,
  effect,
  lifecycle,
  platform,
  reduceMotion,
  shadersAvailable,
  signal,
  untracked,
  type Align,
  type AnimatedNode,
  type CompositeAnimation,
  type Easing as EasingType,
  type JSX,
  type LayoutAnimationConfig,
  type Motion,
  type MotionName,
  type MotionSpec,
  type Placement,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "nsh";
import { Collapsible } from "nsh/base";
import { backendConnection, windowShellId } from "../bridge";
import { formatDuration } from "../format";
import { palette, radii } from "../theme";

/** Standard strong ease-out cubic-bezier tuple for NSH `createMotion` / `Animated`. */
export const MOTION_EASE_STANDARD_BEZIER: [number, number, number, number] = [0.23, 1, 0.32, 1];

/** Smooth symmetrical cubic-bezier tuple for on-screen moves & morphs. */
export const MOTION_EASE_SMOOTH_BEZIER: [number, number, number, number] = [0.77, 0, 0.175, 1];

/** iOS-style drawer / sheet deceleration tuple. */
export const MOTION_EASE_DRAWER_BEZIER: [number, number, number, number] = [0.32, 0.72, 0, 1];

/** Standard decelerating ease-out curve (`--ease-standard`). */
export const MOTION_EASE_STANDARD = "cubic-bezier(0.23, 1, 0.32, 1)" as const;

/** Smooth symmetrical curve for folds, accordions, and on-screen morphs (`--ease-smooth`). */
export const MOTION_EASE_SMOOTH = "cubic-bezier(0.77, 0, 0.175, 1)" as const;

/** iOS-like sheet / drawer deceleration curve (`--ease-drawer`). */
export const MOTION_EASE_DRAWER = "cubic-bezier(0.32, 0.72, 0, 1)" as const;

/** Crisp decelerating exit curve (never `ease-in`; pairs with shorter exit durations). */
export const MOTION_EASE_EXIT = "cubic-bezier(0.23, 1, 0.32, 1)" as const;

/** Critically damped default UI spring (Apple damping ratio ~1.0, no bounce). */
export const MOTION_SPRING_DEFAULT = {
  stiffness: 320,
  damping: 36,
  mass: 1,
} as const;

/** Snappy critically damped UI spring for compact controls. */
export const MOTION_SPRING_SNAPPY = {
  stiffness: 420,
  damping: 41,
  mass: 1,
} as const;

/** Critically damped spring for accordion / thinking / tool-card height disclosures (~200ms settle, zero overshoot). */
export const MOTION_SPRING_DISCLOSURE = {
  stiffness: 460,
  damping: 42,
  mass: 1,
} as const;

/**
 * True inside the deterministic headless `nsh test` host (non-web OS + dev
 * fixture connection + host-page shell). Used to skip infinite UI-thread loops
 * and settle height-reveal unmount transitions synchronously in tests, while
 * keeping full native & web animations on desktop, mobile, and browser targets.
 */
export function isHeadlessMotionSync(): boolean {
  return (
    platform.os !== "web" &&
    windowShellId() === "host-page" &&
    backendConnection().kind === "dev"
  );
}

/** Shared duration scale in milliseconds (all regular UI stays under 300ms). */
export const MOTION_DURATION = {
  instant: 80,
  fast: 140,
  popover: 160,
  drawerOut: 180,
  base: 200,
  contentSwap: 200,
  drawerIn: 220,
  toast: 220,
  slow: 360,
  loop: 680,
} as const;

export type PaintTransitionStyle = Pick<
  ViewStyle,
  "transitionProperty" | "transitionDuration" | "transitionTimingFunction"
>;

/**
 * Paint-only transition style for sweeping rows, inputs, and non-scaling surfaces.
 * Intentionally excludes `box-shadow` (avoids per-frame shadow repaints) and keeps
 * a calm short color/opacity settle under `reduceMotion()`.
 */
export function paintTransition(
  ms: number = MOTION_DURATION.fast,
  easing: ViewStyle["transitionTimingFunction"] = MOTION_EASE_STANDARD,
): PaintTransitionStyle {
  return {
    transitionProperty: "background-color, border-color, color, opacity",
    transitionDuration: ms <= 0 ? 0 : reduceMotion() ? Math.min(ms, 100) : ms,
    transitionTimingFunction: easing,
  };
}

/**
 * GPU-friendly transition style for discrete pressable controls (`Button`,
 * `IconButton`, `PillChip`, `SegmentedTabs`, etc.) pairing color/opacity fades
 * with tactile `transform` press response (dropping `transform` under `reduceMotion()`).
 */
export function pressTransition(
  ms: number = MOTION_DURATION.fast,
  easing: ViewStyle["transitionTimingFunction"] = MOTION_EASE_STANDARD,
): PaintTransitionStyle {
  const reduced = reduceMotion();
  return {
    transitionProperty: reduced
      ? "background-color, border-color, color, opacity"
      : "transform, background-color, border-color, color, opacity",
    transitionDuration: ms <= 0 ? 0 : reduced ? Math.min(ms, 100) : ms,
    transitionTimingFunction: easing,
  };
}

/**
 * Tactile `:active` press style (`scale(0.97)` by default) that gracefully
 * degrades to a subtle opacity shift under `reduceMotion()`.
 */
export function tactileActiveStyle(scale = 0.97, extra?: ViewStyle): ViewStyle {
  if (reduceMotion()) {
    return { opacity: 0.88, ...extra };
  }
  return { transform: [{ scale }], ...extra };
}

export type LayoutPresetName = "easeInEaseOut" | "spring" | "linear";

const LAYOUT_EASE_OUT_CONFIG: LayoutAnimationConfig = {
  duration: 180,
  create: { type: "easeOut", property: "opacity", duration: 140 },
  update: { type: "easeOut", duration: 180 },
  delete: { type: "easeOut", property: "opacity", duration: 120 },
};

const LAYOUT_SPRING_CONFIG: LayoutAnimationConfig = {
  duration: 200,
  create: { type: "easeOut", property: "opacity", duration: 140 },
  update: { type: "spring", springDamping: 1.0 },
  delete: { type: "easeOut", property: "opacity", duration: 120 },
};

/** Runs a snappy native layout transition for the next tree commit unless reduced-motion is set. */
export function animateLayout(
  onEnd?: () => void,
  preset: LayoutPresetName = "easeInEaseOut",
): void {
  if (reduceMotion()) {
    onEnd?.();
    return;
  }
  const config =
    preset === "spring"
      ? LAYOUT_SPRING_CONFIG
      : preset === "linear"
        ? LayoutAnimation.create(160, "linear", "opacity")
        : LAYOUT_EASE_OUT_CONFIG;
  LayoutAnimation.configureNext(config, onEnd);
}

export type EnterMotionKind = Extract<
  MotionName,
  "fadeInUp" | "fadeInDown" | "fadeInLeft" | "fadeInRight" | "zoomIn" | "popIn" | "fadeIn"
>;

function buildEnterSpec(
  kind: EnterMotionKind,
  duration: number,
  delay: number,
  easing: EasingType = MOTION_EASE_STANDARD_BEZIER,
): MotionSpec {
  if (reduceMotion()) {
    return {
      keyframes: { opacity: [0, 1] },
      duration: duration <= 0 ? 0 : Math.min(duration, 110),
      delay: 0,
      easing: "ease",
      ignoreReduceMotion: true,
    };
  }
  switch (kind) {
    case "zoomIn":
      return {
        keyframes: { opacity: [0, 1], scale: [0.96, 1] },
        duration,
        delay,
        easing,
      };
    case "popIn":
      return {
        keyframes: { opacity: [0, 1], scale: [0.95, 1], translateY: [4, 0] },
        duration,
        delay,
        easing,
      };
    case "fadeInDown":
      return {
        keyframes: { opacity: [0, 1], translateY: [-5, 0], scale: [0.97, 1] },
        duration,
        delay,
        easing,
      };
    case "fadeInUp":
      return {
        keyframes: { opacity: [0, 1], translateY: [6, 0] },
        duration,
        delay,
        easing,
      };
    case "fadeInLeft":
      return {
        keyframes: { opacity: [0, 1], translateX: [-6, 0] },
        duration,
        delay,
        easing,
      };
    case "fadeInRight":
      return {
        keyframes: { opacity: [0, 1], translateX: [6, 0] },
        duration,
        delay,
        easing,
      };
    case "fadeIn":
    default:
      return {
        keyframes: { opacity: [0, 1] },
        duration,
        delay,
        easing,
      };
  }
}

/**
 * Creates a crisp Emil-tuned entrance motion handle (`scale: 0.96→1`, `4–6px`
 * nudge, strong `cubic-bezier(0.23, 1, 0.32, 1)` ease-out), degrading cleanly
 * to an opacity-only cross-fade under `reduceMotion()`.
 */
export function enterMotion(
  kind: EnterMotionKind = "fadeIn",
  duration: number = MOTION_DURATION.fast,
  delay = 0,
): Motion {
  return createMotion({
    enter: buildEnterSpec(kind, duration, delay),
  });
}

/**
 * A modal's entrance (visual spec §2.6): fade and scale .98 → 1 on the snappy
 * spring (420, 41); opacity only under `reduceMotion()`.
 */
export function modalEnterMotion(): Motion {
  if (reduceMotion()) {
    return createMotion({
      enter: {
        keyframes: { opacity: [0, 1] },
        duration: 110,
        easing: MOTION_EASE_STANDARD_BEZIER,
        ignoreReduceMotion: true,
      },
    });
  }
  return createMotion({
    enter: { keyframes: { opacity: [0, 1], scale: [0.98, 1] }, spring: MOTION_SPRING_SNAPPY },
  });
}

/**
 * Drawer / bottom-sheet slide entrance (`220ms` in, `180ms` out on the drawer
 * deceleration curve), degrading cleanly to an opacity-only fade under
 * `reduceMotion()`.
 */
export function drawerEnterMotion(edge: "left" | "right" | "bottom" = "left"): Motion {
  if (reduceMotion()) {
    return createMotion({
      enter: {
        keyframes: { opacity: [0, 1] },
        duration: 110,
        easing: "ease",
        ignoreReduceMotion: true,
      },
    });
  }
  const keyframes: MotionSpec["keyframes"] =
    edge === "bottom"
      ? { opacity: [0, 1], translateY: [24, 0] }
      : edge === "right"
        ? { opacity: [0, 1], translateX: [24, 0] }
        : { opacity: [0, 1], translateX: [-24, 0] };
  return createMotion({
    enter: {
      keyframes,
      duration: MOTION_DURATION.drawerIn,
      easing: MOTION_EASE_DRAWER_BEZIER,
    },
  });
}

/**
 * Resolves the trigger-anchored CSS `transformOrigin` for a popover or menu
 * based on its effective `<Overlay>` `placement` and `align`.
 */
export function popoverOrigin(
  placement: Placement = "bottom",
  align: Align = "start",
): string {
  if (placement === "top") {
    if (align === "end") return "bottom right";
    if (align === "center") return "bottom center";
    return "bottom left";
  }
  if (placement === "left") {
    if (align === "end") return "right bottom";
    if (align === "start") return "right top";
    return "right center";
  }
  if (placement === "right") {
    if (align === "end") return "left bottom";
    if (align === "start") return "left top";
    return "left center";
  }
  if (align === "end") return "top right";
  if (align === "center") return "top center";
  return "top left";
}

/**
 * Origin-aware popover/menu entrance (`scale: 0.96→1`, `opacity: 0→1`, subtle
 * 4px directional nudge emerging from the trigger along `placement`).
 */
export function popoverEnterMotion(
  placement: Placement = "bottom",
  _align: Align = "start",
  duration: number = MOTION_DURATION.popover,
): Motion {
  if (reduceMotion()) {
    return createMotion({
      enter: {
        keyframes: { opacity: [0, 1] },
        duration: duration <= 0 ? 0 : Math.min(duration, 100),
        easing: "ease",
        ignoreReduceMotion: true,
      },
    });
  }
  const keyframes: MotionSpec["keyframes"] =
    placement === "top"
      ? { opacity: [0, 1], scale: [0.96, 1], translateY: [4, 0] }
      : placement === "left"
        ? { opacity: [0, 1], scale: [0.96, 1], translateX: [4, 0] }
        : placement === "right"
          ? { opacity: [0, 1], scale: [0.96, 1], translateX: [-4, 0] }
          : { opacity: [0, 1], scale: [0.96, 1], translateY: [-4, 0] };

  return createMotion({
    enter: {
      keyframes,
      duration,
      easing: MOTION_EASE_STANDARD_BEZIER,
    },
  });
}

/** Decelerating non-uniform delay steps (ms) so group entrances feel organic and stay <= 280ms. */
const NON_UNIFORM_STAGGER_DELAYS: ReadonlyArray<number> = [0, 34, 62, 84, 100];

function computeNonUniformDelay(index: number, maxIndex: number, stepMs: number): number {
  const cap = Math.max(0, Math.min(maxIndex, NON_UNIFORM_STAGGER_DELAYS.length - 1));
  const clamped = Math.max(0, Math.min(index, cap));
  const base = NON_UNIFORM_STAGGER_DELAYS[clamped] ?? 100;
  const ratio = stepMs > 0 ? Math.min(1.15, stepMs / 34) : 1;
  return Math.min(100, Math.round(base * ratio));
}

/**
 * Non-uniform staggered entrance for rare / first-run welcome moments (e.g.
 * `WelcomeStudio`). Shrinking delay gaps (`0, 34, 62, 84, 100ms`) with 180ms
 * duration keep total group entrance under 280ms and collapse to a single gentle
 * fade under `reduceMotion()`.
 */
export function nonUniformStaggerMotion(
  index: number,
  maxIndex = 4,
  kind: EnterMotionKind = "fadeInUp",
): Motion {
  const delay = reduceMotion() ? 0 : computeNonUniformDelay(index, maxIndex, 34);
  return createMotion({
    enter: buildEnterSpec(kind, 180, delay),
  });
}

/**
 * Backwards-compatible staggered entrance upgraded to non-uniform decelerating
 * delays (capped at <= 100ms delay + 180ms duration = <= 280ms total).
 */
export function staggerEnterMotion(
  index: number,
  maxIndex = 4,
  kind: EnterMotionKind = "fadeInUp",
  stepMs = 34,
): Motion {
  const delay = reduceMotion() ? 0 : computeNonUniformDelay(index, maxIndex, stepMs);
  return createMotion({
    enter: buildEnterSpec(kind, 180, delay),
  });
}

export interface SceneTransitionProps {
  value: string | number | boolean;
  duration?: number;
  /** Opt-in shader crossfade (off by default: 100+/day route switches stay instant). */
  animated?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: JSX.Element;
}

/**
 * Scene container wrapper. Renders instantaneously by default so high-frequency
 * primary navigation never stalls behind full-viewport shader snapshots; pass
 * `animated` only for rare, deliberate transition surfaces.
 */
export function SceneTransition(props: SceneTransitionProps) {
  return (
    <If
      when={Boolean(props.animated) && shadersAvailable() && !reduceMotion()}
      else={
        <View style={[{ flex: 1, minWidth: 0, minHeight: 0 }, props.style]}>
          {props.children}
        </View>
      }
    >
      <ShaderTransition
        value={props.value}
        fallback="fade"
        duration={props.duration ?? MOTION_DURATION.fast}
        style={[{ flex: 1, minWidth: 0, minHeight: 0 }, props.style]}
      >
        {props.children}
      </ShaderTransition>
    </If>
  );
}

export interface SpinnerProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export function Spinner(props: SpinnerProps) {
  return (
    <View
      style={{
        width: props.size ?? 14,
        height: props.size ?? 14,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        animationName: reduceMotion() ? "none" : "spin",
        animationDuration: MOTION_DURATION.loop,
        animationTimingFunction: "linear",
        animationIterationCount: "infinite",
      }}
    >
      <Canvas
        style={{
          width: props.size ?? 14,
          height: props.size ?? 14,
          flexShrink: 0,
          pointerEvents: "none",
        }}
        draw={(cx, size) => {
          if (size.width <= 0 || size.height <= 0) return;
          const color = props.color ?? palette().accent;
          const sw = props.strokeWidth ?? 1.7;
          const cxMid = size.width / 2;
          const cyMid = size.height / 2;
          const r = Math.max(2, Math.min(cxMid, cyMid) - sw);
          cx.save();
          cx.lineCap = "round";
          cx.lineWidth = sw;
          cx.strokeStyle = palette().border;
          cx.beginPath();
          cx.arc(cxMid, cyMid, r, 0, Math.PI * 2);
          cx.stroke();
          cx.strokeStyle = color;
          cx.beginPath();
          cx.arc(cxMid, cyMid, r, -Math.PI / 2, Math.PI * 0.8);
          cx.stroke();
          cx.restore();
        }}
      />
    </View>
  );
}

export interface BrandSpinnerProps {
  size?: number;
  color?: string;
  variant?: "bars" | "matrix";
}

/** The working pulse's period (theme `motionTiming.pulse`, tuned for crisp orbital flow). */
const MATRIX_ORBIT_MS = 1400;
/** Clockwise ring index (0..7) for each cell of the 3×3 Bit Matrix; center cell (4) is -1. */
const MATRIX_CELL_RING_STEP: ReadonlyArray<number> = [
  0, 1, 2,
  7, -1, 3,
  6, 5, 4,
];
const MATRIX_SAMPLES = 16;
const MATRIX_INPUT_RANGE: number[] = Array.from({ length: MATRIX_SAMPLES + 1 }, (_, i) => i / MATRIX_SAMPLES);

function matrixCellWaveRanges(ringStep: number): { opacity: number[]; scale: number[] } {
  const opacity: number[] = [];
  const scale: number[] = [];
  if (ringStep < 0) {
    // Center anchor cell: soft breathing heartbeat twice per orbit.
    for (let i = 0; i <= MATRIX_SAMPLES; i += 1) {
      const t = i / MATRIX_SAMPLES;
      const wave = 0.5 - 0.5 * Math.cos(t * Math.PI * 4);
      opacity.push(Number((0.76 + 0.24 * wave).toFixed(3)));
      scale.push(Number((0.92 + 0.08 * wave).toFixed(3)));
    }
    return { opacity, scale };
  }
  const peak = ringStep / 8;
  for (let i = 0; i <= MATRIX_SAMPLES; i += 1) {
    const t = i / MATRIX_SAMPLES;
    // Directional clockwise wake: sharp leading edge, soft trailing tail.
    let delta = t - peak;
    if (delta < 0) delta += 1;
    // Leading head sits right at delta=0, trailing glow fades over delta in [0, 0.52].
    const trail = delta <= 0.52
      ? Math.pow(Math.cos((delta / 0.52) * (Math.PI / 2)), 1.6)
      : delta >= 0.9
        ? Math.pow(Math.cos(((1 - delta) / 0.1) * (Math.PI / 2)), 2)
        : 0;
    opacity.push(Number((0.22 + 0.78 * trail).toFixed(3)));
    scale.push(Number((0.74 + 0.32 * trail).toFixed(3)));
  }
  return { opacity, scale };
}

const MATRIX_WAVE_TABLES = MATRIX_CELL_RING_STEP.map(matrixCellWaveRanges);

/**
 * OpenBitFun brand loading indicator (`bars` 3-bar equalizer pulse or `matrix` 3×3
 * fluid clockwise orbital light wave). Runs natively on the UI thread with one
 * shared `AnimatedValue`, automatically pausing when hidden or under `reduceMotion()`.
 */
export function BrandSpinner(props: BrandSpinnerProps) {
  const isMatrix = () => (props.variant ?? "bars") === "matrix";
  const phase = createAnimatedValue(0);
  let activeLoop: CompositeAnimation | null = null;
  const shouldRunMatrix = computed(
    () => isMatrix() && !reduceMotion() && lifecycle() !== "background" && !isHeadlessMotionSync(),
  );

  effect(() => {
    if (shouldRunMatrix()) {
      phase.set(0);
      activeLoop = Animated.loop(
        Animated.timing(phase, {
          toValue: 1,
          duration: MATRIX_ORBIT_MS,
          easing: Easing.linear,
        }),
      );
      void activeLoop.start();
    } else if (activeLoop) {
      activeLoop.stop();
      activeLoop = null;
      phase.set(0);
    }
  });
  cleanup(() => {
    if (activeLoop) {
      activeLoop.stop();
      activeLoop = null;
    }
  });

  const cellNodes = MATRIX_WAVE_TABLES.map(table => ({
    opacity: phase.interpolate({ inputRange: MATRIX_INPUT_RANGE, outputRange: table.opacity }),
    scale: phase.interpolate({ inputRange: MATRIX_INPUT_RANGE, outputRange: table.scale }),
  }));

  return (
    <If
      when={isMatrix()}
      else={
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            gap: Math.max(2, Math.round((props.size ?? 14) * 0.16)),
            height: props.size ?? 14,
          }}
        >
          <Each of={[0, 1, 2]} key={idx => idx}>
            {idx => (
              <View
                style={{
                  width: Math.max(2, Math.round((props.size ?? 14) * 0.18)),
                  height:
                    idx() === 1
                      ? Math.max(8, Math.round((props.size ?? 14) * 0.85))
                      : Math.max(5, Math.round((props.size ?? 14) * 0.56)),
                  borderRadius: radii.pill,
                  backgroundColor: props.color ?? palette().accent,
                  animationName: reduceMotion() || lifecycle() === "background" ? "none" : "pulse",
                  animationDuration: MOTION_DURATION.loop,
                  animationDelay: reduceMotion() ? 0 : idx() * 140,
                  animationTimingFunction: "ease-in-out",
                  animationIterationCount: "infinite",
                }}
              />
            )}
          </Each>
        </View>
      }
    >
      <View
        style={{
          width: props.size ?? 16,
          height: props.size ?? 16,
          flexShrink: 0,
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: Math.max(1.5, Math.round((props.size ?? 16) * 0.12)),
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Each of={[0, 1, 2, 3, 4, 5, 6, 7, 8]} key={cell => cell}>
          {cell => {
            const index = untracked(cell);
            const node = cellNodes[index]!;
            return (
              <View
                style={{
                  width: "100%",
                  height: "100%",
                  borderRadius: Math.max(1, Math.round((props.size ?? 16) * 0.12)),
                  backgroundColor: props.color ?? palette().accent,
                  opacity: shouldRunMatrix() ? node.opacity : index === 4 ? 1 : 0.62,
                  scale: shouldRunMatrix() ? node.scale : 1,
                }}
              />
            );
          }}
        </Each>
      </View>
    </If>
  );
}

/**
 * Native UI-thread luminous flow for active streaming status labels ("Thinking…",
 * "Running", "Delegating", "Exploring"). Smoothly breathes text luminance between
 * `mutedColor` and `brightColor` while `active` is true, and settles cleanly to a
 * static palette color when inactive, hidden, or under `reduceMotion()`.
 */
export function ActiveFlowText(props: {
  active: boolean | (() => boolean);
  text: string | (() => string);
  mutedColor?: () => string;
  brightColor?: () => string;
  staticColor?: () => string;
  style?: StyleProp<TextStyle>;
}) {
  const pulse = createAnimatedValue(0);
  let activeLoop: CompositeAnimation | null = null;
  const isActive = computed(() => (typeof props.active === "function" ? props.active() : props.active));
  const animated = computed(
    () => isActive() && !reduceMotion() && lifecycle() !== "background" && !isHeadlessMotionSync(),
  );

  effect(() => {
    if (animated()) {
      pulse.set(0);
      activeLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 1,
            duration: 920,
            easing: Easing.inOut(Easing.sin),
          }),
          Animated.timing(pulse, {
            toValue: 0,
            duration: 920,
            easing: Easing.inOut(Easing.sin),
          }),
        ]),
      );
      void activeLoop.start();
    } else if (activeLoop) {
      activeLoop.stop();
      activeLoop = null;
      pulse.set(0);
    }
  });
  cleanup(() => {
    if (activeLoop) {
      activeLoop.stop();
      activeLoop = null;
    }
  });

  const animatedColor = computed<string | AnimatedNode>(() => {
    if (!animated()) {
      return props.staticColor ? props.staticColor() : (props.mutedColor ? props.mutedColor() : palette().textMuted);
    }
    const low = props.mutedColor ? props.mutedColor() : palette().textMuted;
    const high = props.brightColor ? props.brightColor() : palette().text;
    return pulse.interpolate({
      inputRange: [0, 1],
      outputRange: [low, high],
    });
  });

  const resolvedText = () => (typeof props.text === "function" ? props.text() : props.text);

  return (
    <Text style={[props.style, { color: animatedColor() }]}>
      {resolvedText()}
    </Text>
  );
}

/**
 * Shared live elapsed duration caption (` · 2s`, ` · 3s`, …) anchored to a turn
 * or tool start timestamp so phase transitions (waiting → thinking → tool) keep
 * one continuous clock without resetting or vanishing.
 */
export function ElapsedDurationText(props: {
  startedAt?: () => number | undefined;
  active?: () => boolean;
  minSeconds?: number;
  prefix?: string;
  style?: StyleProp<TextStyle>;
}) {
  const mountedAt = Date.now();
  const minSeconds = props.minSeconds ?? 2;
  const originMs = () => {
    const reported = props.startedAt?.();
    return typeof reported === "number" && reported > 0 ? Math.min(reported, mountedAt) : mountedAt;
  };
  const elapsedSec = signal(Math.max(0, Math.floor((Date.now() - originMs()) / 1000)));
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  effect(() => {
    const running = props.active ? props.active() : true;
    if (!running) {
      stopTimer();
      return;
    }
    elapsedSec.set(Math.max(0, Math.floor((Date.now() - originMs()) / 1000)));
    if (timer === null) {
      timer = setInterval(() => {
        elapsedSec.set(Math.max(0, Math.floor((Date.now() - originMs()) / 1000)));
      }, 1000);
    }
  });
  cleanup(stopTimer);

  const visibleText = computed(() => {
    const running = props.active ? props.active() : true;
    if (!running || elapsedSec() < minSeconds) return "";
    const formatted = formatDuration(elapsedSec() * 1000);
    return formatted ? `${props.prefix ?? " · "}${formatted}` : "";
  });

  return (
    <If when={visibleText()}>
      {text => {
        const reveal = subtleCrossfadeMotion();
        return (
          <Text
            style={[
              {
                fontVariant: ["tabular-nums"],
              },
              props.style,
              reveal.style,
            ]}
          >
            {text()}
          </Text>
        );
      }}
    </If>
  );
}

/**
 * Crisp upward settle for a newly sent user bubble lifting out of the composer
 * (`opacity: 0 → 1`, `translateY: 8 → 0`, `scale: 0.985 → 1`, 200ms ease-out).
 */
export function userBubbleEnterMotion(): Motion {
  if (reduceMotion()) {
    return createMotion({
      enter: {
        keyframes: { opacity: [0.4, 1] },
        duration: 100,
        easing: MOTION_EASE_STANDARD_BEZIER,
        ignoreReduceMotion: true,
      },
    });
  }
  return createMotion({
    enter: {
      keyframes: { opacity: [0, 1], translateY: [8, 0], scale: [0.985, 1] },
      duration: MOTION_DURATION.base,
      easing: MOTION_EASE_STANDARD_BEZIER,
    },
  });
}

/**
 * Cohesive entrance for a newly arriving live conversation block (thinking row,
 * tool card, explore group, answer text segment, waiting row, or turn notice).
 */
export function liveBlockEnterMotion(opts?: {
  travel?: number;
  delay?: number;
  duration?: number;
}): Motion {
  const duration = opts?.duration ?? 185;
  const delay = opts?.delay ?? 0;
  const travel = opts?.travel ?? 5;
  if (reduceMotion()) {
    return createMotion({
      enter: {
        keyframes: { opacity: [0.45, 1] },
        duration: Math.min(duration, 90),
        delay: 0,
        easing: MOTION_EASE_STANDARD_BEZIER,
        ignoreReduceMotion: true,
      },
    });
  }
  return createMotion({
    enter: {
      keyframes: { opacity: [0, 1], translateY: [travel, 0] },
      duration,
      delay,
      easing: MOTION_EASE_STANDARD_BEZIER,
    },
  });
}

/** Gentle scale + opacity entrance for compact inline status badges & affordances. */
export function inlineStateEnterMotion(delay = 0): Motion {
  if (reduceMotion()) {
    return createMotion({
      enter: {
        keyframes: { opacity: [0.5, 1] },
        duration: 80,
        delay: 0,
        easing: MOTION_EASE_STANDARD_BEZIER,
        ignoreReduceMotion: true,
      },
    });
  }
  return createMotion({
    enter: {
      keyframes: { opacity: [0, 1], scale: [0.94, 1] },
      duration: MOTION_DURATION.popover,
      delay,
      easing: MOTION_EASE_STANDARD_BEZIER,
    },
  });
}

/**
 * In-place morph transition without remounting children: plays a subtle GPU
 * settle whenever `morphKey()` changes after initial mount (`skipInitial`
 * default true). Ideal for icon swaps (spinner → settled icon), verb changes
 * ("Running" → "Ran"), generated session titles, and Send ↔ Stop glyph swaps.
 */
export function MorphSlot(props: {
  morphKey: () => string;
  mode?: "rise" | "scale" | "fade";
  duration?: number;
  skipInitial?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: JSX.Element;
}) {
  const motion = createMotion();
  const initialSentinel = Symbol("morph-init");
  let previous: string | symbol = props.skipInitial === false ? initialSentinel : untracked(() => props.morphKey());

  effect(() => {
    const next = props.morphKey();
    if (next === previous) return;
    previous = next;
    if (isHeadlessMotionSync()) return;
    const duration = props.duration ?? 150;
    if (reduceMotion()) {
      void motion.play({
        keyframes: { opacity: [0.45, 1] },
        duration: Math.min(duration, 90),
        easing: MOTION_EASE_STANDARD_BEZIER,
        ignoreReduceMotion: true,
      });
      return;
    }
    const mode = props.mode ?? "rise";
    const keyframes =
      mode === "scale"
        ? { opacity: [0.3, 1], scale: [0.86, 1] }
        : mode === "fade"
          ? { opacity: [0.3, 1] }
          : { opacity: [0.28, 1], translateY: [2.5, 0] };
    void motion.play({
      keyframes,
      duration,
      easing: MOTION_EASE_STANDARD_BEZIER,
    });
  });

  return (
    <View style={[props.style, motion.style]}>
      {props.children}
    </View>
  );
}

/**
 * Spring-animated height disclosure backed by NSH's native `<Collapsible reveal>`.
 * Lazily mounts `content` only on the first open so collapsed transcript cards
 * never build heavy diff/markdown trees or fire detail loads ahead of time, while
 * keeping content mounted across smooth spring collapses on desktop/mobile/web.
 */
export function SmoothDisclosure(props: {
  open: () => boolean;
  style?: StyleProp<ViewStyle>;
  contentGap?: number;
  contentStyle?: StyleProp<ViewStyle>;
  children: JSX.Element;
  content: () => JSX.Element;
}) {
  const openedOnce = signal(untracked(() => props.open()));
  const contentMotion = createMotion();
  let wasOpen = untracked(() => props.open());

  effect(() => {
    const isOpen = props.open();
    if (isOpen && !untracked(openedOnce)) {
      openedOnce.set(true);
    }
    if (isOpen !== wasOpen) {
      wasOpen = isOpen;
      if (!isHeadlessMotionSync()) {
        if (isOpen) {
          if (reduceMotion()) {
            void contentMotion.play({
              keyframes: { opacity: [0.5, 1] },
              duration: 90,
              easing: MOTION_EASE_STANDARD_BEZIER,
              ignoreReduceMotion: true,
            });
          } else {
            void contentMotion.play({
              keyframes: { opacity: [0, 1], translateY: [-3, 0] },
              duration: 170,
              easing: MOTION_EASE_STANDARD_BEZIER,
            });
          }
        } else if (!reduceMotion()) {
          // Dissolve inner content & rail slightly faster than the height spring
          // settles so no stray vertical border peeks out at the end of collapse.
          void contentMotion.play({
            keyframes: { opacity: [1, 0] },
            duration: 110,
            easing: MOTION_EASE_STANDARD_BEZIER,
          });
        }
      }
    }
  });

  const shouldReveal = () => !reduceMotion() && !isHeadlessMotionSync();

  return (
    <Collapsible
      open={props.open()}
      reveal={shouldReveal()}
      revealSpring={MOTION_SPRING_DISCLOSURE}
      style={props.style}
      content={
        <If when={openedOnce()}>
          {() => (
            <View
              style={[
                props.contentGap ? { paddingTop: props.contentGap } : undefined,
                props.contentStyle,
                contentMotion.style,
              ]}
            >
              {props.content()}
            </View>
          )}
        </If>
      }
    >
      {props.children}
    </Collapsible>
  );
}

/**
 * GPU-composited chevron rotation (`0deg → 90deg` on `cubic-bezier(0.23, 1, 0.32, 1)`).
 * Replaces abrupt `chevron-right` / `chevron-down` icon swaps on collapsible rows.
 */
export function rotatingChevronStyle(expanded: boolean): ViewStyle {
  if (reduceMotion()) {
    return { transform: [{ rotate: expanded ? "90deg" : "0deg" }] };
  }
  return {
    transform: [{ rotate: expanded ? "90deg" : "0deg" }],
    transitionProperty: "transform",
    transitionDuration: MOTION_DURATION.fast,
    transitionTimingFunction: MOTION_EASE_STANDARD,
  };
}

/**
 * Ultra-fast opacity-only settle (`0.86 → 1` over `110ms`) for scene/tab/page
 * swaps: readable and interactive immediately at `t = 0`, removing harsh binary
 * hard-cuts without introducing sluggish travel or layout shift.
 */
export function subtleCrossfadeMotion(): Motion {
  const reduced = reduceMotion();
  return createMotion({
    enter: {
      keyframes: { opacity: [reduced ? 0.94 : 0.86, 1] },
      duration: reduced ? 60 : 110,
      easing: MOTION_EASE_STANDARD_BEZIER,
      ...(reduced ? { ignoreReduceMotion: true } : {}),
    },
  });
}

/** Wraps a switching scene/tab/page body so every key change settles smoothly on the GPU. */
export function SmoothSwap(props: {
  swapKey: () => string;
  skipInitial?: boolean;
  style?: StyleProp<ViewStyle>;
  children: (key: string) => JSX.Element;
}) {
  let mountCount = 0;
  return (
    <Each of={[props.swapKey()]} key={k => k}>
      {k => {
        const keyVal = untracked(k);
        const shouldAnimate = !(props.skipInitial && mountCount === 0);
        mountCount += 1;
        const motion = shouldAnimate ? subtleCrossfadeMotion() : null;
        return (
          <View style={[{ flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }, props.style, motion?.style]}>
            {props.children(keyVal)}
          </View>
        );
      }}
    </Each>
  );
}

function RollingDigit(props: {
  text: string;
  animate: boolean;
  direction: 1 | -1;
  style?: StyleProp<TextStyle>;
}) {
  const motion =
    props.animate && !reduceMotion()
      ? createMotion({
          enter: {
            keyframes: {
              opacity: [0.15, 1],
              translateY: [props.direction > 0 ? 6 : -6, 0],
            },
            duration: 160,
            easing: MOTION_EASE_STANDARD_BEZIER,
          },
        })
      : null;
  return (
    <Text
      style={[
        {
          fontVariant: ["tabular-nums"],
        },
        props.style,
        motion?.style,
      ]}
    >
      {props.text}
    </Text>
  );
}

/**
 * Smooth in-place numeric ticker: initial value renders statically; subsequent
 * increments/decrements slide only the digits vertically inside a clipped box
 * while surrounding row labels stay completely still.
 */
export function RollingCount(props: {
  value: () => number;
  format?: (n: number) => string;
  style?: StyleProp<TextStyle>;
}) {
  let prev = untracked(() => props.value());
  let dir: 1 | -1 = 1;
  let tick = 0;
  const entry = computed(() => {
    const next = props.value();
    if (next !== prev) {
      dir = next >= prev ? 1 : -1;
      prev = next;
      tick += 1;
    }
    return {
      key: `${tick}:${next}`,
      text: props.format ? props.format(next) : String(next),
      animate: tick > 0,
      direction: dir,
    };
  });
  return (
    <View style={{ overflow: "hidden", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <Each of={[entry()]} key={item => item.key}>
        {item => (
          <RollingDigit
            text={item().text}
            animate={item().animate}
            direction={item().direction}
            style={props.style}
          />
        )}
      </Each>
    </View>
  );
}
