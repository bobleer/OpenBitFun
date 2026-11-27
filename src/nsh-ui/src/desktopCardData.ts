import { dateFormatterAtLocale } from "../../shared/i18n/formatDate";
import { numberFormatterAtLocale } from "../../shared/i18n/formatNumber";
import { computed } from "nsh";
import { formatRelativeTime } from "./format";
import { currentLocale } from "./i18n";

const numberFormat = computed(() => numberFormatterAtLocale(currentLocale()));
const dateFormat = computed(() => dateFormatterAtLocale(currentLocale()));
const CARD_TONES = ["neutral", "accent", "info", "success", "warning", "danger"] as const;
export type CardTone = (typeof CARD_TONES)[number];

export function cardTone(value: unknown): CardTone | undefined {
  return CARD_TONES.find(tone => tone === value);
}

/** RFC 6901 JSON Pointer lookup. A missing path returns undefined. */
export function resolvePointer(root: unknown, pointer: unknown): unknown {
  if (pointer === "") return root;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return undefined;
  let current = root;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function cardNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function cardTimestamp(value: unknown): number | null {
  const numeric = cardNumber(value);
  if (numeric !== null) return Math.abs(numeric) < 1e11 ? numeric * 1000 : numeric;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatCardDate(ms: number, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? dateFormat()(date, options) : "";
}

export function formatCardPercent(share: number): string {
  return numberFormat()(share, { style: "percent", maximumFractionDigits: share > 0 && share < 0.01 ? 1 : 0 });
}

export function formatCardValue(item: Record<string, unknown>, raw: unknown, defaultFormat?: "number"): string {
  if (raw === undefined || raw === null || raw === "") return "—";
  const precision = typeof item.digits === "number" && Number.isFinite(item.digits)
    ? Math.min(Math.max(Math.trunc(item.digits), 0), 8) : undefined;
  const digits = precision === undefined ? undefined : { minimumFractionDigits: precision, maximumFractionDigits: precision };
  const numeric = cardNumber(raw);
  let text: string;
  switch (item.format ?? defaultFormat) {
    case "number":
      text = numeric === null ? String(raw) : numberFormat()(numeric, digits);
      break;
    case "percent":
      text = numeric === null ? String(raw) : numberFormat()(numeric / 100, { style: "percent", ...digits });
      break;
    case "currency":
      text = numeric === null ? String(raw) : numberFormat()(numeric, {
        style: "currency", currency: typeof item.currency === "string" && item.currency ? item.currency : "USD", ...digits,
      });
      break;
    case "datetime": {
      const ms = cardTimestamp(raw);
      text = (ms !== null && formatCardDate(ms, { dateStyle: "medium", timeStyle: "short" })) || String(raw);
      break;
    }
    case "relativeTime": {
      const ms = cardTimestamp(raw);
      text = (ms !== null && formatRelativeTime(ms)) || String(raw);
      break;
    }
    default:
      text = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  }
  return `${typeof item.prefix === "string" ? item.prefix : ""}${text}${typeof item.suffix === "string" ? item.suffix : ""}`;
}
