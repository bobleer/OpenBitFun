// The NativeUI card kit (`openbitfun/genui`, API 1): the styled components and
// host helpers a card the Agent writes imports. It is compiled with the same
// compiler as the cards (`openbitfun-native-ui`) by
// `scripts/generate-genui-kit.mjs` into the runner's
// `native/src/genui_kit.generated.js`, and runs inside each card's sandboxed
// engine, never in this app's.
//
// The look follows the reading device: the card host passes the current
// palette subset as `host.params.theme` and sends `theme` events when it
// changes, so the kit names no color of its own. The API is additive: cards in
// old transcripts keep importing what they imported.

import type { JSX } from "nsh";
import { computed, ErrorBoundary, host, Scroll, signal, Text, View } from "nsh";
import { Input, Progress as BaseProgress, Slider as BaseSlider, Switch, TextView } from "nsh/base";
import { Bar, Grid as PlotGrid, Line, Pie, Plot, PlotAxis } from "nsh/base/plot";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
type Child = JSX.Element;

interface Theme {
  canvas?: string;
  panelRaised?: string;
  surfaceTertiary?: string;
  inputBg?: string;
  border?: string;
  borderSubtle?: string;
  text?: string;
  textSecondary?: string;
  textMuted?: string;
  accent?: string;
  accentSoft?: string;
  actionPrimaryBg?: string;
  actionPrimaryFg?: string;
  buttonSecondaryBg?: string;
  buttonSecondaryHover?: string;
  success?: string;
  successSoft?: string;
  warning?: string;
  warningSoft?: string;
  danger?: string;
  dangerSoft?: string;
  toggleTrackOff?: string;
  switchOn?: string;
  series?: string[];
  fontScale?: number;
  fontMono?: string;
}

export default function kit() {
  const params = (host.available() ? host.params : {}) as Record<string, unknown>;
  const themeSignal = signal<Theme>((params.theme as Theme) ?? {});
  const savedState = ((params.state as Record<string, unknown>) ?? {}) as Record<string, unknown>;

  const post = (name: string, data: unknown) => {
    try {
      if (host.available()) host.post(name, data as never);
    } catch {
      // The host refused or went away; the card keeps working locally.
    }
  };
  if (host.available()) {
    host.on("theme", (next: unknown) => themeSignal.set((next as Theme) ?? {}));
  }

  const theme = () => themeSignal();
  const size = (base: number) => Math.round(base * (theme().fontScale ?? 1));
  const toneColor = (tone: Tone | undefined) => {
    const t = theme();
    switch (tone) {
      case "success":
        return { fg: t.success, bg: t.successSoft };
      case "warning":
        return { fg: t.warning, bg: t.warningSoft };
      case "danger":
        return { fg: t.danger, bg: t.dangerSoft };
      case "accent":
        return { fg: t.accent, bg: t.accentSoft };
      default:
        return { fg: t.textSecondary, bg: t.surfaceTertiary };
    }
  };
  const seriesColor = (index: number) => {
    const series = theme().series ?? [];
    return series.length ? series[index % series.length] : theme().accent;
  };

  // ── Host helpers ───────────────────────────────────────────────────────

  /** Puts `text` in the reader's composer as a follow-up; the reader sends it. */
  function ask(text: string) {
    post("genui.ask", { text: String(text ?? "") });
  }
  /** Asks the reader's app to open an http(s) link (it may confirm first). */
  function openLink(url: string) {
    post("genui.openUrl", { url: String(url ?? "") });
  }
  /** Copies text to the reader's clipboard. */
  function copyText(text: string) {
    post("genui.copy", { text: String(text ?? "") });
  }
  /** A signal the reader's device keeps for this card while the transcript is open. */
  function persisted<T>(key: string, initial: T) {
    const value = signal<T>(key in savedState ? (savedState[key] as T) : initial);
    const read = () => value();
    read.set = (next: T) => {
      value.set(next);
      post("genui.state", { key, value: next });
    };
    return read as (() => T) & { set(next: T): void };
  }

  // ── Layout ─────────────────────────────────────────────────────────────

  function Card(props: { title?: string; subtitle?: string; children?: Child; style?: object }) {
    return (
      <View
        style={[
          {
            gap: 12,
            padding: 16,
            borderRadius: 12,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: theme().borderSubtle,
            backgroundColor: theme().panelRaised,
          },
          props.style,
        ]}
      >
        {props.title ? (
          <View style={{ gap: 2 }}>
            <Text style={{ color: theme().text, fontSize: size(15), fontWeight: "600" }}>{props.title}</Text>
            {props.subtitle ? (
              <Text style={{ color: theme().textMuted, fontSize: size(12) }}>{props.subtitle}</Text>
            ) : null}
          </View>
        ) : null}
        {props.children}
      </View>
    );
  }

  function Stack(props: { gap?: number; children?: Child; style?: object }) {
    return <View style={[{ gap: props.gap ?? 8 }, props.style]}>{props.children}</View>;
  }

  function Row(props: { gap?: number; align?: "start" | "center" | "end"; wrap?: boolean; children?: Child; style?: object }) {
    return (
      <View
        style={[
          {
            flexDirection: "row",
            gap: props.gap ?? 8,
            alignItems: props.align === "start" ? "flex-start" : props.align === "end" ? "flex-end" : "center",
            flexWrap: props.wrap ? "wrap" : "nowrap",
          },
          props.style,
        ]}
      >
        {props.children}
      </View>
    );
  }

  function Grid(props: { columns?: number; gap?: number; children?: Child; style?: object }) {
    return (
      <View
        style={[
          {
            display: "grid",
            gridTemplateColumns: `repeat(${Math.max(1, Math.min(6, props.columns ?? 2))}, minmax(0, 1fr))`,
            gap: props.gap ?? 8,
          },
          props.style,
        ]}
      >
        {props.children}
      </View>
    );
  }

  function Divider() {
    return <View style={{ height: 1, alignSelf: "stretch", backgroundColor: theme().borderSubtle }} />;
  }

  function Spacer(props: { size?: number }) {
    return <View style={props.size ? { height: props.size, width: props.size } : { flex: 1 }} />;
  }

  // ── Text ───────────────────────────────────────────────────────────────

  function Heading(props: { level?: 1 | 2 | 3; children?: Child }) {
    const base = props.level === 1 ? 20 : props.level === 3 ? 14 : 17;
    return <Text style={{ color: theme().text, fontSize: size(base), fontWeight: "600" }}>{props.children}</Text>;
  }

  function Body(props: { children?: Child; style?: object }) {
    return <Text style={[{ color: theme().text, fontSize: size(14), lineHeight: size(21) }, props.style]}>{props.children}</Text>;
  }

  function Muted(props: { children?: Child }) {
    return <Text style={{ color: theme().textMuted, fontSize: size(12), lineHeight: size(17) }}>{props.children}</Text>;
  }

  function Code(props: { children?: Child }) {
    return (
      <Text
        style={{
          color: theme().text,
          fontFamily: theme().fontMono,
          fontSize: size(12),
          lineHeight: size(18),
          padding: 8,
          borderRadius: 6,
          backgroundColor: theme().surfaceTertiary,
        }}
      >
        {props.children}
      </Text>
    );
  }

  function Markdown(props: { text: string }) {
    return (
      <TextView
        markdown={props.text}
        selectable
        styles={{ text: { color: theme().text, fontSize: size(14) } } as never}
      />
    );
  }

  // ── Controls ───────────────────────────────────────────────────────────

  function Button(props: {
    label: string;
    onPress?: () => void;
    variant?: "primary" | "secondary" | "ghost" | "danger";
    disabled?: boolean;
  }) {
    const variant = () => props.variant ?? "secondary";
    const bg = () => {
      const t = theme();
      if (variant() === "primary") return t.actionPrimaryBg;
      if (variant() === "danger") return t.danger;
      if (variant() === "ghost") return "transparent";
      return t.buttonSecondaryBg;
    };
    const fg = () => (variant() === "primary" ? theme().actionPrimaryFg : variant() === "danger" ? theme().canvas : theme().text);
    return (
      <View
        role="button"
        accessibilityLabel={props.label}
        disabled={Boolean(props.disabled)}
        onPress={() => {
          if (!props.disabled) props.onPress?.();
        }}
        style={{
          height: 32,
          paddingHorizontal: 12,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          alignSelf: "flex-start",
          borderRadius: 8,
          borderCurve: "continuous",
          borderWidth: variant() === "secondary" ? 1 : 0,
          borderColor: theme().border,
          backgroundColor: bg(),
          cursor: props.disabled ? "not-allowed" : "pointer",
        }}
        hoverStyle={{ opacity: 0.88 }}
        activeStyle={{ opacity: 0.76 }}
        disabledStyle={{ opacity: 0.4 }}
      >
        <Text style={{ color: fg(), fontSize: size(13), fontWeight: "500" }}>{props.label}</Text>
      </View>
    );
  }

  function Toggle(props: { label?: string; value: boolean; onChange?: (value: boolean) => void }) {
    return (
      <Row gap={10}>
        <Switch
          checked={props.value}
          accessibilityLabel={props.label}
          onChange={(event: { checked: boolean }) => props.onChange?.(event.checked)}
          trackStyle={{ backgroundColor: props.value ? theme().switchOn : theme().toggleTrackOff }}
        />
        {props.label ? <Text style={{ color: theme().text, fontSize: size(13) }}>{props.label}</Text> : null}
      </Row>
    );
  }

  function Slider(props: {
    label?: string;
    value: number;
    min?: number;
    max?: number;
    step?: number;
    format?: (value: number) => string;
    onChange?: (value: number) => void;
  }) {
    return (
      <View style={{ gap: 6 }}>
        {props.label ? (
          <Row>
            <Text style={{ flex: 1, color: theme().textSecondary, fontSize: size(12) }}>{props.label}</Text>
            <Text style={{ color: theme().text, fontSize: size(12), fontVariant: ["tabular-nums"] }}>
              {props.format ? props.format(props.value) : String(props.value)}
            </Text>
          </Row>
        ) : null}
        <BaseSlider
          value={props.value}
          min={props.min ?? 0}
          max={props.max ?? 100}
          step={props.step ?? 1}
          accessibilityLabel={props.label}
          onChange={(event: { value: number | number[] }) =>
            props.onChange?.(Array.isArray(event.value) ? event.value[0] : event.value)
          }
        />
      </View>
    );
  }

  function TextField(props: {
    label?: string;
    value: string;
    placeholder?: string;
    onChange?: (value: string) => void;
    onSubmit?: (value: string) => void;
  }) {
    return (
      <View style={{ gap: 6 }}>
        {props.label ? <Text style={{ color: theme().textSecondary, fontSize: size(12) }}>{props.label}</Text> : null}
        <Input
          value={props.value}
          placeholder={props.placeholder}
          onChange={(event: { value: string }) => props.onChange?.(event.value)}
          onSubmit={() => props.onSubmit?.(props.value)}
          style={{
            height: 34,
            paddingHorizontal: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme().border,
            backgroundColor: theme().inputBg,
            color: theme().text,
            placeholderColor: theme().textMuted,
            caretColor: theme().accent,
            fontSize: size(13),
          } as never}
        />
      </View>
    );
  }

  function Segmented(props: {
    options: Array<string | { value: string; label: string }>;
    value: string;
    onChange?: (value: string) => void;
  }) {
    const items = () =>
      (props.options ?? []).map(option => (typeof option === "string" ? { value: option, label: option } : option));
    return (
      <View
        style={{
          flexDirection: "row",
          alignSelf: "flex-start",
          padding: 2,
          gap: 2,
          borderRadius: 8,
          backgroundColor: theme().surfaceTertiary,
        }}
      >
        {items().map(item => (
          <View
            role="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: item.value === props.value }}
            onPress={() => props.onChange?.(item.value)}
            style={{
              paddingHorizontal: 10,
              height: 26,
              justifyContent: "center",
              borderRadius: 6,
              backgroundColor: item.value === props.value ? theme().panelRaised : "transparent",
              cursor: "pointer",
            }}
          >
            <Text
              style={{
                color: item.value === props.value ? theme().text : theme().textSecondary,
                fontSize: size(12),
                fontWeight: item.value === props.value ? "600" : "400",
              }}
            >
              {item.label}
            </Text>
          </View>
        ))}
      </View>
    );
  }

  function Tabs(props: {
    tabs: Array<{ value: string; label: string; content?: Child }>;
    value?: string;
    onChange?: (value: string) => void;
  }) {
    const own = signal<string>(props.value ?? props.tabs?.[0]?.value ?? "");
    const current = () => props.value ?? own();
    const active = computed(() => (props.tabs ?? []).find(tab => tab.value === current()));
    return (
      <View style={{ gap: 12 }}>
        <Segmented
          options={(props.tabs ?? []).map(tab => ({ value: tab.value, label: tab.label }))}
          value={current()}
          onChange={value => {
            own.set(value);
            props.onChange?.(value);
          }}
        />
        {active()?.content}
      </View>
    );
  }

  // ── Display ────────────────────────────────────────────────────────────

  function Badge(props: { label: string; tone?: Tone }) {
    return (
      <View
        style={{
          alignSelf: "flex-start",
          paddingHorizontal: 8,
          height: 20,
          justifyContent: "center",
          borderRadius: 999,
          backgroundColor: toneColor(props.tone).bg,
        }}
      >
        <Text style={{ color: toneColor(props.tone).fg, fontSize: size(11), fontWeight: "600" }}>{props.label}</Text>
      </View>
    );
  }

  function Stat(props: { label: string; value: string | number; delta?: string; tone?: Tone; hint?: string }) {
    return (
      <View
        style={{
          gap: 4,
          padding: 12,
          borderRadius: 10,
          backgroundColor: theme().surfaceTertiary,
          minWidth: 0,
        }}
      >
        <Text style={{ color: theme().textMuted, fontSize: size(12) }}>{props.label}</Text>
        <Row gap={6} align="end">
          <Text style={{ color: theme().text, fontSize: size(22), fontWeight: "600", fontVariant: ["tabular-nums"] }}>
            {String(props.value)}
          </Text>
          {props.delta ? (
            <Text style={{ color: toneColor(props.tone ?? "neutral").fg, fontSize: size(12), paddingBottom: 3 }}>
              {props.delta}
            </Text>
          ) : null}
        </Row>
        {props.hint ? <Text style={{ color: theme().textMuted, fontSize: size(11) }}>{props.hint}</Text> : null}
      </View>
    );
  }

  function Progress(props: { value: number; label?: string; tone?: Tone }) {
    const clamped = () => Math.max(0, Math.min(1, Number(props.value) || 0));
    return (
      <View style={{ gap: 6 }}>
        {props.label ? (
          <Row>
            <Text style={{ flex: 1, color: theme().textSecondary, fontSize: size(12) }}>{props.label}</Text>
            <Text style={{ color: theme().text, fontSize: size(12), fontVariant: ["tabular-nums"] }}>
              {`${Math.round(clamped() * 100)}%`}
            </Text>
          </Row>
        ) : null}
        <BaseProgress
          value={clamped() * 100}
          accessibilityLabel={props.label}
          trackStyle={{ height: 6, borderRadius: 3, backgroundColor: theme().surfaceTertiary }}
          indicatorStyle={{ borderRadius: 3, backgroundColor: toneColor(props.tone ?? "accent").fg }}
        />
      </View>
    );
  }

  function Table(props: {
    columns: Array<{ key: string; label: string; align?: "left" | "right" | "center"; width?: number }>;
    rows: Array<Record<string, unknown>>;
    maxHeight?: number;
  }) {
    const align = (value?: string) => (value === "right" ? "flex-end" : value === "center" ? "center" : "flex-start");
    const cell = (column: { align?: string; width?: number }) => ({
      flex: column.width ? undefined : 1,
      width: column.width,
      minWidth: 0,
      alignItems: align(column.align),
    }) as never;
    const body = (
      <View>
        {(props.rows ?? []).map((row, index) => (
          <View
            style={{
              flexDirection: "row",
              gap: 12,
              paddingVertical: 8,
              paddingHorizontal: 4,
              borderTopWidth: index === 0 ? 0 : 1,
              borderColor: theme().borderSubtle,
            }}
          >
            {(props.columns ?? []).map(column => (
              <View style={cell(column)}>
                <Text style={{ color: theme().text, fontSize: size(13), fontVariant: ["tabular-nums"] }}>
                  {row[column.key] == null ? "" : String(row[column.key])}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    );
    return (
      <View style={{ gap: 2 }}>
        <View
          style={{
            flexDirection: "row",
            gap: 12,
            paddingVertical: 6,
            paddingHorizontal: 4,
            borderBottomWidth: 1,
            borderColor: theme().border,
          }}
        >
          {(props.columns ?? []).map(column => (
            <View style={cell(column)}>
              <Text style={{ color: theme().textMuted, fontSize: size(12), fontWeight: "600" }}>{column.label}</Text>
            </View>
          ))}
        </View>
        {props.maxHeight ? <Scroll style={{ maxHeight: props.maxHeight }}>{body}</Scroll> : body}
      </View>
    );
  }

  function List(props: { children?: Child }) {
    return <View style={{ gap: 2 }}>{props.children}</View>;
  }

  function ListItem(props: { title: string; subtitle?: string; trailing?: Child; icon?: string; onPress?: () => void }) {
    return (
      <View
        onPress={props.onPress}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 8,
          paddingHorizontal: 8,
          borderRadius: 8,
          cursor: props.onPress ? "pointer" : undefined,
        }}
        hoverStyle={props.onPress ? { backgroundColor: theme().buttonSecondaryHover } : undefined}
      >
        {props.icon ? <Text style={{ fontSize: size(16) }}>{props.icon}</Text> : null}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ color: theme().text, fontSize: size(13), fontWeight: "500" }}>{props.title}</Text>
          {props.subtitle ? <Text style={{ color: theme().textMuted, fontSize: size(12) }}>{props.subtitle}</Text> : null}
        </View>
        {typeof props.trailing === "string" || typeof props.trailing === "number" ? (
          <Text style={{ color: theme().textSecondary, fontSize: size(13), fontVariant: ["tabular-nums"] }}>
            {String(props.trailing)}
          </Text>
        ) : (
          props.trailing
        )}
      </View>
    );
  }

  function Callout(props: { tone?: Tone; title?: string; children?: Child }) {
    return (
      <View
        style={{
          gap: 4,
          padding: 12,
          borderRadius: 10,
          borderLeftWidth: 3,
          borderColor: toneColor(props.tone ?? "accent").fg,
          backgroundColor: toneColor(props.tone ?? "accent").bg,
        }}
      >
        {props.title ? (
          <Text style={{ color: theme().text, fontSize: size(13), fontWeight: "600" }}>{props.title}</Text>
        ) : null}
        {typeof props.children === "string" ? (
          <Text style={{ color: theme().text, fontSize: size(13), lineHeight: size(19) }}>{props.children}</Text>
        ) : (
          props.children
        )}
      </View>
    );
  }

  function KeyValue(props: { items: Array<{ key: string; value: string | number }> }) {
    return (
      <View style={{ gap: 6 }}>
        {(props.items ?? []).map(item => (
          <Row gap={12}>
            <Text style={{ width: 120, color: theme().textMuted, fontSize: size(12) }}>{item.key}</Text>
            <Text style={{ flex: 1, color: theme().text, fontSize: size(13) }}>
              {String(item.value)}
            </Text>
          </Row>
        ))}
      </View>
    );
  }

  // ── Charts ─────────────────────────────────────────────────────────────

  type Datum = Record<string, unknown>;
  const axisLabel = () => ({ color: theme().textMuted, fontSize: size(11) });

  function BarChart(props: {
    data: Datum[];
    x: string;
    y: string | string[];
    height?: number;
    stacked?: boolean;
    format?: (value: number) => string;
  }) {
    const keys = () => (Array.isArray(props.y) ? props.y : [props.y]);
    return (
      <Plot
        data={props.data ?? []}
        xScale={{ type: "band", paddingInner: 0.3, paddingOuter: 0.1 } as never}
        style={{ width: "100%", height: props.height ?? 200 }}
      >
        <PlotGrid ticks={4} style={{ stroke: theme().borderSubtle, strokeWidth: 1 } as never} />
        <PlotAxis placement="left" ticks={4} format={props.format} labelStyle={axisLabel() as never} />
        <PlotAxis
          placement="bottom"
          format={(value: number) => String((props.data ?? [])[Math.round(value)]?.[props.x] ?? "")}
          labelStyle={axisLabel() as never}
        />
        {keys().map((key, index) => (
          <Bar
            value={key}
            stack={props.stacked ? "stack" : undefined}
            cornerRadii={{ topLeft: 3, topRight: 3 } as never}
            style={{ fill: seriesColor(index) } as never}
          />
        ))}
      </Plot>
    );
  }

  function LineChart(props: {
    data: Datum[];
    x: string;
    y: string | string[];
    height?: number;
    dots?: boolean;
    format?: (value: number) => string;
  }) {
    const keys = () => (Array.isArray(props.y) ? props.y : [props.y]);
    return (
      <Plot data={props.data ?? []} style={{ width: "100%", height: props.height ?? 200 }}>
        <PlotGrid ticks={4} style={{ stroke: theme().borderSubtle, strokeWidth: 1 } as never} />
        <PlotAxis placement="left" ticks={4} format={props.format} labelStyle={axisLabel() as never} />
        <PlotAxis
          placement="bottom"
          ticks={Math.min(6, Math.max(1, (props.data ?? []).length))}
          format={(value: number) => String((props.data ?? [])[Math.round(value)]?.[props.x] ?? "")}
          labelStyle={axisLabel() as never}
        />
        {keys().map((key, index) => (
          <Line y={key} curve={"monotone" as never} dot={props.dots} style={{ stroke: seriesColor(index), strokeWidth: 2 } as never} />
        ))}
      </Plot>
    );
  }

  function PieChart(props: { data: Datum[]; label: string; value: string; height?: number; donut?: boolean }) {
    return (
      <View style={{ gap: 8 }}>
        <Plot data={props.data ?? []} style={{ width: "100%", height: props.height ?? 200 }}>
          <Pie
            value={props.value}
            innerRadius={props.donut === false ? 0 : "55%"}
            padAngle={0.02}
            cornerRadius={3}
            sliceStyle={{} as never}
            color={((_: Datum, index: number) => seriesColor(index)) as never}
          />
        </Plot>
        <Row wrap gap={12}>
          {(props.data ?? []).map((row, index) => (
            <Row gap={6}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: seriesColor(index) }} />
              <Text style={{ color: theme().textSecondary, fontSize: size(12) }}>
                {`${String(row[props.label] ?? "")} · ${String(row[props.value] ?? "")}`}
              </Text>
            </Row>
          ))}
        </Row>
      </View>
    );
  }

  // ── Mount ──────────────────────────────────────────────────────────────

  /** Mounts the card: reports its height to the host and shows a failure in place. */
  function mountCard(App: () => JSX.Element) {
    let lastHeight = -1;
    let lastWidth = -1;
    return (
      <View
        style={{ position: "absolute", top: 0, left: 0, right: 0 }}
        onLayout={event => {
          const height = Math.ceil(Number(event.bounds.size.height));
          const width = Math.ceil(Number(event.bounds.size.width));
          if (height !== lastHeight || width !== lastWidth) {
            lastHeight = height;
            lastWidth = width;
            post("genui.size", { height, width });
          }
        }}
      >
        <ErrorBoundary
          fallback={(error: unknown) => {
            post("genui.error", { message: String((error as { message?: string })?.message ?? error) });
            return (
              <Callout tone="danger" title="This card failed">
                {String((error as { message?: string })?.message ?? error)}
              </Callout>
            );
          }}
        >
          <App />
        </ErrorBoundary>
      </View>
    );
  }

  return {
    Card,
    Stack,
    Row,
    Grid,
    Divider,
    Spacer,
    Heading,
    Body,
    Muted,
    Code,
    Markdown,
    Button,
    Toggle,
    Slider,
    TextField,
    Segmented,
    Tabs,
    Badge,
    Stat,
    Progress,
    Table,
    List,
    ListItem,
    Callout,
    KeyValue,
    BarChart,
    LineChart,
    PieChart,
    theme,
    ask,
    openLink,
    copyText,
    persisted,
    __mountCard: mountCard,
  };
}
