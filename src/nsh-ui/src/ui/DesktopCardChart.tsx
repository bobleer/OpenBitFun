import { Canvas, computed, Text, View } from "nsh";
import {
  cardLineGeometry, chartShare, desktopCardChart, formatChartLabel,
  type CardChartSeries,
} from "../desktopCardChart";
import { formatCardPercent, formatCardValue, type CardTone } from "../desktopCardData";
import { tr } from "../i18n";
import { palette, radii, space, textStyle } from "../theme";
import { TooltipBubble } from "./primitives";

const ringSize = space.x6l + space.xl + space.xs;
const shades = [1, 0.78, 0.58, 0.42, 0.3, 0.2];
const caption = () => textStyle("caption", { color: palette().textMuted });
const ellipsis = { numberOfLines: 1, textOverflow: "ellipsis" } as const;

interface ChartPart {
  label: string;
  value: string;
  hint?: string;
  fraction: number;
  share: number;
  color: string;
  opacity: number;
}

function Swatch(props: { color: string; opacity: number }) {
  return <View style={{ width: space.sm, height: space.sm, borderRadius: radii.xs, flexShrink: 0,
    overflow: "hidden", backgroundColor: palette().surfaceElevated }}>
    <View style={{ flex: 1, backgroundColor: props.color, opacity: props.opacity }} />
  </View>;
}

function Breakdown(props: { parts: ChartPart[]; bars?: boolean; showShare: boolean }) {
  return <View style={{ gap: space.xs, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
    <Each of={props.parts} key={(_part, index) => String(index)}>
      {part => <View style={{ gap: space.hair }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minWidth: 0 }}>
          <If when={!props.bars}><Swatch color={part().color} opacity={part().opacity} /></If>
          <Text style={{ ...textStyle("label", { color: palette().textSecondary }), ...ellipsis, flex: 1, minWidth: 0 }}>{part().label}</Text>
          <Text style={{ ...textStyle("label", { tabular: true }), userSelect: "text", flexShrink: 1, ...ellipsis }}>{part().value}</Text>
          <If when={props.showShare}>
            <Text style={{ ...textStyle("caption", { color: palette().textMuted, tabular: true }), flexShrink: 0 }}>{formatCardPercent(part().share)}</Text>
          </If>
        </View>
        <If when={props.bars}>
          <View style={{ height: space.xs, borderRadius: radii.pill, overflow: "hidden", backgroundColor: palette().surfaceTertiary }}>
            <View style={{ height: space.xs, width: `${part().fraction * 100}%`, backgroundColor: part().color,
              borderRadius: radii.pill }} />
          </View>
        </If>
        <If when={part().hint}>{hint => <Text style={{ ...textStyle("micro", { color: palette().textMuted }), userSelect: "text" }}>{hint()}</Text>}</If>
      </View>}
    </Each>
  </View>;
}

function Columns(props: { parts: ChartPart[] }) {
  const count = () => props.parts.length;
  return <View testID="desktop-card-chart-columns" style={{ flexDirection: "row", gap: space.hair }}>
    <Each of={props.parts} key={(_part, index) => String(index)}>
      {(part, index) => <View accessibilityLabel={partDescription(part())} tooltip={<TooltipBubble text={partDescription(part())} />}
        style={{ flex: 1, minWidth: 0, gap: space.hair, justifyContent: "flex-end" }}>
        <If when={count() <= 8}>
          <Text style={{ ...textStyle("micro", { tabular: true }), ...ellipsis, textAlign: "center" }}>{part().value}</Text>
        </If>
        <View style={{ height: space.x6l, justifyContent: "flex-end" }}>
          <View style={{ width: "100%", height: `${part().fraction * 100}%`, backgroundColor: part().color,
            borderTopLeftRadius: radii.xs, borderTopRightRadius: radii.xs }} />
        </View>
        <Text style={{ ...textStyle("micro"), ...ellipsis, color: palette().textMuted, textAlign: "center" }}>
          {index() % Math.ceil(count() / 8) === 0 || index() === count() - 1 ? part().label : "\u00a0"}
        </Text>
      </View>}
    </Each>
  </View>;
}

function partDescription(part: ChartPart): string {
  return part.hint ? `${part.label} ${part.value}\n${part.hint}` : `${part.label} ${part.value}`;
}

function Ring(props: { parts: ChartPart[]; center: string }) {
  return <View style={{ width: ringSize, height: ringSize, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
    <Canvas testID="desktop-card-chart-ring" style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}
      draw={(ctx, size) => {
        const x = size.width / 2;
        const y = size.height / 2;
        const radius = Math.min(x, y) - space.sm;
        if (radius <= 0) return;
        const start = -Math.PI / 2;
        const full = 2 * Math.PI;
        const arc = (from: number, through: number, color: string, opacity = 1) => {
          ctx.globalAlpha = opacity;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, radius, from, through);
          ctx.stroke();
        };
        ctx.lineWidth = space.sm + space.hair;
        ctx.lineCap = "butt";
        arc(start, start + full, palette().surfaceTertiary);
        let angle = start;
        for (const part of props.parts) {
          if (part.fraction <= 0) continue;
          const end = Math.min(start + full, angle + full * part.fraction);
          if (end <= angle) break;
          if (part.opacity < 1) arc(angle, end, palette().surfaceElevated);
          arc(angle, end, part.color, part.opacity);
          angle = end;
        }
        ctx.globalAlpha = 1;
      }} />
    <Text style={{ ...textStyle("label", { tabular: true }), ...ellipsis, maxWidth: ringSize - space.xl }}>{props.center}</Text>
  </View>;
}

function Stack(props: { parts: ChartPart[] }) {
  return <View testID="desktop-card-chart-stack" style={{ height: space.sm + space.hair, flexDirection: "row",
    borderRadius: radii.pill, overflow: "hidden", backgroundColor: palette().surfaceTertiary }}>
    <Each of={props.parts} key={(_part, index) => String(index)}>
      {part => <View style={{ width: `${part().fraction * 100}%`, height: "100%", flexShrink: 0,
        backgroundColor: palette().surfaceElevated }}>
        <View style={{ flex: 1, backgroundColor: part().color, opacity: part().opacity }} />
      </View>}
    </Each>
  </View>;
}

function Summary(props: { value: string; detail?: string }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
    <Text style={{ ...textStyle("pageTitle", { tabular: true }), userSelect: "text" }}>{props.value}</Text>
    <If when={props.detail}>{detail => <Text style={caption()}>{detail()}</Text>}</If>
  </View>;
}

function Line(props: { series: CardChartSeries; parts: ChartPart[]; value: (n: number) => string; color: string }) {
  const geometry = computed(() => cardLineGeometry(props.series.points));
  return <If when={geometry()} else={<Text style={caption()}>{tr("cards.noData")}</Text>}>
    {line => {
      const change = () => line().last - line().first;
      const changeText = () => `${change() > 0 ? "+" : change() < 0 ? "−" : "±"}${props.value(Math.abs(change()))}`;
      return <>
        <Summary value={props.value(line().last)}
          detail={tr("cards.chart.changeSince", { change: changeText(), label: props.parts[0]?.label ?? "" })} />
        <Canvas testID="desktop-card-chart-line" style={{ height: space.x5l, alignSelf: "stretch" }}
          draw={(ctx, size) => {
            const plotWidth = size.width - space.hair * 2;
            if (plotWidth <= 0 || size.height <= 0) return;
            const points = line().coordinates.map(point => ({
              x: space.hair + point.x * plotWidth, y: point.y * size.height,
            }));
            const trace = () => {
              ctx.beginPath();
              ctx.moveTo(points[0].x, points[0].y);
              for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
            };
            trace();
            ctx.lineTo(points.at(-1)!.x, size.height);
            ctx.lineTo(points[0].x, size.height);
            ctx.closePath();
            ctx.fillStyle = props.color;
            ctx.globalAlpha = 0.16;
            ctx.fill();
            ctx.globalAlpha = 1;
            trace();
            ctx.strokeStyle = props.color;
            ctx.lineWidth = space.hair;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.stroke();
          }} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.xs }}>
          <Text style={caption()}>{props.parts[0]?.label}</Text>
          <Text style={caption()}>{tr("cards.chart.range", { min: props.value(line().min), max: props.value(line().max) })}</Text>
          <Text style={caption()}>{props.parts.at(-1)?.label}</Text>
        </View>
      </>;
    }}
  </If>;
}

export function DesktopCardChart(props: {
  template: Record<string, unknown>;
  data: unknown;
  color: (tone?: CardTone) => string;
}) {
  const chart = computed(() => desktopCardChart(props.template, props.data, tr("cards.chart.other")));
  const value = (amount: number) => formatCardValue(props.template, amount, "number");
  const parts = computed(() => {
    const current = chart();
    if (!current) return [];
    const segmented = current.style === "donut" || current.style === "stacked";
    return current.points.map((point, index): ChartPart => ({
      label: formatChartLabel(point.label, props.template.labelFormat),
      value: value(point.value), hint: point.hint,
      fraction: chartShare(point.value, current.scale), color: props.color(point.tone),
      share: chartShare(point.value, current.style === "bar" ? current.total ?? current.scale : current.scale),
      opacity: segmented && !point.tone ? shades[index % shades.length] : 1,
    }));
  });
  const legend = computed(() => {
    const current = chart();
    if (!current || current.remainder <= 0) return parts();
    const remainder = props.template.remainderLabel;
    return [...parts(), {
      label: typeof remainder === "string" && remainder.trim() ? remainder : tr("cards.chart.remaining"),
      value: value(current.remainder), fraction: chartShare(current.remainder, current.scale),
      share: chartShare(current.remainder, current.scale),
      color: palette().surfaceTertiary, opacity: 1,
    }];
  });
  return <If when={chart()} else={<Text style={caption()}>{tr("cards.unknownTemplate")}</Text>}>
    {series => <If when={parts().length} else={<Text style={caption()}>{tr("cards.noData")}</Text>}>
      <View role="group" testID="desktop-card-chart" accessibilityLabel={parts().map(part => `${part.label} ${part.value}`).join(", ")}
        style={{ gap: space.sm, minWidth: 0 }}>
        <If when={series().style === "bar"}>
          <Breakdown parts={parts()} bars showShare={series().total !== null} />
        </If>
        <If when={series().style === "column"}><Columns parts={parts()} /></If>
        <If when={series().style === "line"}>
          <Line parts={parts()} series={series()} value={value} color={props.color()} />
        </If>
        <If when={series().style === "stacked"}>
          <Summary value={value(series().sum)} detail={series().total === null ? undefined :
            `${tr("cards.chart.ofTotal", { total: value(series().total!) })} · ${formatCardPercent(chartShare(series().sum, series().total!))}`} />
          <Stack parts={parts()} />
          <Breakdown parts={legend()} showShare />
        </If>
        <If when={series().style === "donut"}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md }}>
            <Ring parts={parts()} center={series().total === null ? value(series().sum) :
              formatCardPercent(chartShare(series().sum, series().total!))} />
            <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: space.x6l * 2, minWidth: 0 }}>
              <Breakdown parts={legend()} showShare />
            </View>
          </View>
        </If>
        <If when={typeof props.template.caption === "string" ? props.template.caption : ""}>
          {text => <Text style={{ ...textStyle("label", { color: palette().textSecondary }), userSelect: "text" }}>{text()}</Text>}
        </If>
      </View>
    </If>}
  </If>;
}
