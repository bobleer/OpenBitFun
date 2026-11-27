import { cardNumber, cardTimestamp, cardTone, formatCardDate, resolvePointer, type CardTone } from "./desktopCardData";

const limits = { bar: 12, column: 24, line: 120, donut: 6, stacked: 6 } as const;
type ChartStyle = keyof typeof limits;

export interface CardChartPoint {
  label: string;
  value: number;
  tone?: CardTone;
  hint?: string;
}

function labelText(raw: unknown): string | undefined {
  if (typeof raw === "string" || (typeof raw === "number" && Number.isFinite(raw))) return String(raw);
  return undefined;
}

function readPoints(template: Record<string, unknown>, data: unknown): CardChartPoint[] {
  const staticItems = template.itemsPath === undefined;
  const source = staticItems ? template.items : resolvePointer(data, template.itemsPath);
  if (!Array.isArray(source)) return [];
  const labels = resolvePointer(data, template.labelsPath);
  const labelKey = !staticItems && typeof template.labelKey === "string" ? template.labelKey : "label";
  const valueKey = !staticItems && typeof template.valueKey === "string" ? template.valueKey : "value";
  const hintKey = !staticItems && typeof template.hintKey === "string" ? template.hintKey : "hint";

  return source.flatMap((row, index): CardChartPoint[] => {
    const fallbackLabel = staticItems ? ""
      : (Array.isArray(labels) ? labelText(labels[index]) : undefined) ?? String(index + 1);
    if (!staticItems && Array.isArray(row)) {
      const value = cardNumber(row[1]);
      return value === null ? [] : [{ label: labelText(row[0]) ?? fallbackLabel, value }];
    }
    if (row !== null && typeof row === "object" && !Array.isArray(row)) {
      const record = row as Record<string, unknown>;
      const value = cardNumber(record[valueKey]);
      if (value === null) return [];
      const hint = typeof record[hintKey] === "string" ? record[hintKey] : undefined;
      return [{ label: labelText(record[labelKey]) ?? fallbackLabel, value, tone: cardTone(record.tone),
        hint: hint?.trim() ? hint : undefined }];
    }
    const value = staticItems ? null : cardNumber(row);
    return value === null ? [] : [{ label: fallbackLabel, value }];
  });
}

/** Adapts the saved chart template to the same bounded series used by the desktop card. */
export function desktopCardChart(template: Record<string, unknown>, data: unknown, otherLabel: string) {
  if (typeof template.chart !== "string" || !Object.hasOwn(limits, template.chart)) return null;
  const style = template.chart as ChartStyle;
  const limit = limits[style];
  let points = readPoints(template, data);
  if (style !== "line") points = points.map(point => point.value < 0 ? { ...point, value: 0 } : point);
  if (points.length > limit) {
    if (style === "line") {
      points = points.slice(-limit);
    } else if (style === "donut" || style === "stacked") {
      const other = points.slice(limit - 1).reduce((sum, point) => sum + point.value, 0);
      points = [...points.slice(0, limit - 1), { label: otherLabel, value: other }];
    } else {
      points = points.slice(0, limit);
    }
  }
  const sum = points.reduce((total, point) => total + point.value, 0);
  const rawTotal = cardNumber(template.totalPath === undefined ? template.total : resolvePointer(data, template.totalPath));
  const total = style !== "line" && rawTotal !== null && rawTotal > 0 ? rawTotal : null;
  const remainder = total === null ? 0 : Math.max(0, total - sum);
  const measured = style === "donut" || style === "stacked" ? sum : Math.max(0, ...points.map(point => point.value));
  return { style, points, sum, total, remainder, scale: Math.max(total ?? 0, measured) };
}

export type CardChartSeries = NonNullable<ReturnType<typeof desktopCardChart>>;

export function chartShare(value: number, scale: number): number {
  const ratio = scale > 0 ? value / scale : 0;
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
}

const dateOptions: Record<string, Intl.DateTimeFormatOptions> = {
  date: { month: "short", day: "numeric" },
  time: { hour: "2-digit", minute: "2-digit" },
  weekday: { weekday: "short" },
  datetime: { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
};

export function formatChartLabel(label: string, format: unknown): string {
  if (typeof format !== "string" || !Object.hasOwn(dateOptions, format) || !label.trim()) return label;
  // A civil day is local to the controller, even in a timezone west of UTC.
  const civil = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label.trim());
  const ms = civil
    ? new Date(Number(civil[1]), Number(civil[2]) - 1, Number(civil[3])).getTime()
    : cardTimestamp(label);
  return (ms !== null && formatCardDate(ms, dateOptions[format])) || label;
}

export function cardLineGeometry(points: readonly CardChartPoint[]) {
  if (points.length < 2) return null;
  const values = points.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const coordinates = values.map((value, index) => ({
    x: index / (values.length - 1),
    y: span > 0 ? 0.95 - 0.9 * chartShare(value - min, span) : 0.5,
  }));
  return { coordinates, min, max, first: values[0], last: values[values.length - 1] };
}
