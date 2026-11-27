// The content width preference: how wide the conversation column grows.
//
// Both frontends use the same local storage key. The controller's entry also
// keeps the width in account settings when the host supports it.

import { Storage, signal } from "nsh";
import { getEntryConfig, setEntryConfig } from "./api";
import { backendConnection } from "./bridge";

/**
 * The host keeps the width as `appearance.content_width` too, which account
 * settings sync carries to the account's other devices; the page storage
 * stays the fast first read.
 */
const HOST_WIDTH_PATH = "appearance.content_width";

/** The conversation column default (visual spec §2.2: ≈72 characters at 15 px); stored values keep theirs. */
export const DEFAULT_CONTENT_WIDTH = 760;
/** Where the stepper stops narrowing (two thirds of the desktop's old 900 default). */
export const MIN_CONTENT_WIDTH = 600;
/** The step its stepper takes. */
export const CONTENT_WIDTH_STEP = 10;
/** Where the desktop keeps it. */
export const CONTENT_WIDTH_STORAGE_KEY = "openbitfun:appearance:flowChatWidth";

export const contentWidth = signal(DEFAULT_CONTENT_WIDTH);
/** Set when the stored value could not be read or written. */
export const contentWidthNotice = signal("");
let localWrites = Promise.resolve();
let hostWrites = Promise.resolve();
let widthRevision = 0;
let latestRead = 0;

function clampWidth(value: number): number {
  return Math.max(MIN_CONTENT_WIDTH, Math.round(value));
}

/**
 * Reads the stored width. A saved value below the floor is treated as unset, the
 * way the desktop falls back to its default instead of honouring a number its own
 * stepper can no longer reach.
 */
export async function loadContentWidth(): Promise<void> {
  const revision = widthRevision;
  try {
    const raw = await Storage.getItem(CONTENT_WIDTH_STORAGE_KEY);
    if (revision !== widthRevision) return;
    if (!raw || !raw.trim()) return;
    const saved = Number(raw);
    if (Number.isFinite(saved) && saved >= MIN_CONTENT_WIDTH) contentWidth.set(clampWidth(saved));
  } catch {
    if (revision === widthRevision) contentWidthNotice.set("The saved content width could not be read.");
  }
}

/**
 * Shows the host's width when it differs (account settings sync changed it on
 * another device). A host that never stored one gets this surface's width
 * once it is not the default (the first read after an upgrade).
 */
export async function syncContentWidthFromHost(): Promise<void> {
  const read = ++latestRead;
  const revision = widthRevision;
  const connection = backendConnection();
  const current = () => read === latestRead && revision === widthRevision && backendConnection() === connection;
  await hostWrites;
  if (!current()) return;
  let stored: unknown;
  try {
    stored = await getEntryConfig(HOST_WIDTH_PATH);
  } catch {
    return;
  }
  if (!current()) return;
  if (typeof stored === "number" && Number.isFinite(stored) && stored >= MIN_CONTENT_WIDTH) {
    applyWidth(clampWidth(stored), false);
  } else if (stored == null && contentWidth() !== DEFAULT_CONTENT_WIDTH) {
    persistWidth(contentWidth(), true);
  }
}

/** Applies a width, which the conversation panes read on every paint. */
export function setContentWidth(width: number): void {
  if (!Number.isFinite(width)) return;
  applyWidth(clampWidth(width), true);
}

function applyWidth(next: number, toHost: boolean): void {
  if (next === contentWidth()) return;
  widthRevision += 1;
  contentWidth.set(next);
  contentWidthNotice.set("");
  persistWidth(next, toHost);
}

function persistWidth(next: number, toHost: boolean): void {
  const revision = widthRevision;
  const connection = backendConnection();
  localWrites = localWrites.then(() => Storage.setItem(CONTENT_WIDTH_STORAGE_KEY, String(next))).catch(() => {
    if (revision === widthRevision) contentWidthNotice.set("The content width could not be saved locally.");
  });
  if (!toHost) return;
  hostWrites = hostWrites.then(async () => {
    if (backendConnection() === connection) await setEntryConfig(HOST_WIDTH_PATH, next);
  }).catch(() => {
    // An older or unreachable host keeps the width in this surface.
  });
}

export function resetContentWidth(): void {
  setContentWidth(DEFAULT_CONTENT_WIDTH);
}
