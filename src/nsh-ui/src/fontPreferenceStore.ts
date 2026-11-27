// The host's font preference: one baseline px that the whole surface scales from.
//
// The desktop keeps it in the `font` config as `{ uiSize: { level, customPx? } }`
// and derives its type ramp from the baseline — the presets are 12/13/14/15/16 px
// and `custom` takes 12–20. This surface reads the same document and writes it the
// same way, so a size picked in either frontend is the size the other draws.

import { signal } from "nsh";
import { getEntryConfig, setEntryConfig } from "./api";
import { backendConnection } from "./bridge";
import { tr } from "./i18n";
import { BASE_FONT_SIZE, uiFontBasePx } from "./theme";

export type FontLevel = "compact" | "small" | "default" | "medium" | "large" | "custom";

/** Where both surfaces keep it. */
const CONFIG_PATH = "font";

export const MIN_FONT_PX = 12;
export const MAX_FONT_PX = 20;

/** The levels the desktop's picker draws, with the baseline each one means. */
export const FONT_LEVELS: ReadonlyArray<{ level: Exclude<FontLevel, "custom">; label: string; px: number }> = [
  { level: "compact", label: "Compact", px: 12 },
  { level: "small", label: "Small", px: 13 },
  { level: "default", label: "Default", px: 14 },
  { level: "medium", label: "Medium", px: 15 },
  { level: "large", label: "Large", px: 16 },
];

export const fontLevel = signal<FontLevel>("default");
/** The baseline in px the scale comes from, resolved for the level. */
export const fontPx = signal(BASE_FONT_SIZE);
export const fontNotice = signal("");
let writeQueue = Promise.resolve();
let revision = 0;
let latestRead = 0;
let needsRetry = false;

function isLevel(value: unknown): value is FontLevel {
  return value === "compact" || value === "small" || value === "default"
    || value === "medium" || value === "large" || value === "custom";
}

function clampPx(value: number): number {
  return Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, Math.round(value)));
}

/** The px a level means, with `custom` taken from the stored size. */
export function pxOfLevel(level: FontLevel, customPx?: number): number {
  if (level === "custom") return clampPx(customPx ?? BASE_FONT_SIZE);
  const preset = FONT_LEVELS.find(entry => entry.level === level);
  return preset ? preset.px : BASE_FONT_SIZE;
}

/** Applies a baseline to the surface, which repaints every text size from it. */
function apply(level: FontLevel, px: number): void {
  fontLevel.set(level);
  fontPx.set(px);
  uiFontBasePx.set(px);
}

/**
 * Reads the stored preference. A host that stores nothing keeps this surface at
 * the default, which is what the desktop's own default is.
 */
export async function loadFontPreference(): Promise<void> {
  const read = ++latestRead;
  const before = revision;
  const connection = backendConnection();
  const current = () => read === latestRead && before === revision && backendConnection() === connection;
  await writeQueue;
  if (!current()) return;
  try {
    const stored = (await getEntryConfig(CONFIG_PATH)) as
      | { uiSize?: { level?: unknown; customPx?: unknown } }
      | null;
    if (!current()) return;
    const level = isLevel(stored?.uiSize?.level) ? stored.uiSize.level : "default";
    const customPx = typeof stored?.uiSize?.customPx === "number" && Number.isFinite(stored.uiSize.customPx)
      ? stored.uiSize.customPx : undefined;
    apply(level, pxOfLevel(level, customPx));
  } catch {
    // A transient read failure keeps the known baseline.
  }
}

/** Writes the whole document, which is the shape the desktop stores. */
async function store(level: FontLevel, px: number): Promise<void> {
  if (level === fontLevel() && px === fontPx() && !needsRetry) return;
  const change = ++revision;
  const connection = backendConnection();
  needsRetry = false;
  apply(level, px);
  fontNotice.set("");
  writeQueue = writeQueue.then(async () => {
    if (backendConnection() !== connection) return;
    try {
      await setEntryConfig(CONFIG_PATH, {
        uiSize: level === "custom" ? { level, customPx: px } : { level },
      });
    } catch {
      if (change === revision && backendConnection() === connection) {
        needsRetry = true;
        fontNotice.set(tr("settings.appearance.fontSaveFailed"));
      }
    }
  });
  await writeQueue;
}

export async function chooseFontLevel(level: FontLevel): Promise<void> {
  await store(level, pxOfLevel(level, fontPx()));
}

/** Writes a custom baseline chosen in the stepper. */
export async function setCustomFontPx(px: number): Promise<void> {
  if (!Number.isFinite(px)) return;
  await store("custom", clampPx(px));
}

export async function resetFontPreference(): Promise<void> {
  await store("default", BASE_FONT_SIZE);
}
