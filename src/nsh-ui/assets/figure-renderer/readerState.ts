export const MAX_FIGURE_READER_BYTES = 16 * 1024;

export interface FigureChartState {
  hidden: string[];
  row?: number;
  limit?: number;
}

export interface FigureReaderState {
  group: string | null;
  charts: [string, FigureChartState][];
  widget?: Record<string, string>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function decodeFigureReaderState(value: unknown): FigureReaderState | null {
  const candidate = record(value);
  if (!candidate || !(candidate.group === null || typeof candidate.group === "string") ||
      !Array.isArray(candidate.charts) || candidate.charts.length > 3) return null;
  const charts: FigureReaderState["charts"] = [];
  const ids = new Set<string>();
  for (const item of candidate.charts) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || ids.has(item[0])) return null;
    const chart = record(item[1]);
    if (!chart || !Array.isArray(chart.hidden) || !chart.hidden.every(name => typeof name === "string")) return null;
    const { row, limit } = chart;
    if (row !== undefined && (typeof row !== "number" || !Number.isSafeInteger(row) || row < 0)) return null;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)) return null;
    ids.add(item[0]);
    charts.push([item[0], { hidden: [...new Set<string>(chart.hidden)], row, limit }]);
  }
  const result: FigureReaderState = { group: candidate.group, charts };
  if (candidate.widget !== undefined) {
    const widget = record(candidate.widget);
    if (!widget) return null;
    const fields: [string, string][] = [];
    for (const [name, value] of Object.entries(widget)) {
      if (typeof value !== "string") return null;
      fields.push([name, value]);
    }
    result.widget = Object.fromEntries(fields);
  }
  return result;
}

export type FigureReaderEvent = { type: "state"; state: FigureReaderState } | { type: "followUp"; message: string };

export function decodeFigureReaderEvent(value: unknown, nonce: string): FigureReaderEvent | null {
  const event = record(value);
  if (!event || event.figureReader !== nonce) return null;
  if (event.type === "state") {
    const state = decodeFigureReaderState(event.state);
    return state ? { type: "state", state } : null;
  }
  if (event.type === "followUp" && typeof event.message === "string" && event.message.trim()) {
    return { type: "followUp", message: event.message };
  }
  return null;
}
