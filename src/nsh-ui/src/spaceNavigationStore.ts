import { computed, signal, Storage } from "nsh";
import { isDeviceOnThisMachine } from "./shared/deviceScope";
import { spaces, spacesCatalogDevice } from "./spacesStore";
import { deviceContext } from "./state";
import { tr } from "./i18n";
import { pushToast } from "./ui/overlays";

/** Same preference shape as the main desktop navigation. */
export const SPACE_NAVIGATION_KEY = "openbitfun-miniapp-navigation";
const pinnedByDevice = signal<Record<string, string[]>>({});
const emptyPins: readonly string[] = [];
export const spacePinsReady = signal(false);
let loading: Promise<void> | undefined;
let pendingWrite = Promise.resolve();

function pinScope(deviceId: string): string {
  return !deviceId || isDeviceOnThisMachine(deviceId) ? "local" : deviceId;
}

function readPins(raw: string | null): Record<string, string[]> {
  if (!raw) return {};
  const stored = JSON.parse(raw) as { state?: { pinnedAppIdsBySurface?: unknown } } | null;
  const value = stored?.state?.pinnedAppIdsBySurface;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([scope, ids]) =>
    scope && Array.isArray(ids)
      ? [[scope, [...new Set(ids.filter((id): id is string => typeof id === "string" && Boolean(id.trim())))]]]
      : [],
  ));
}

export function loadSpacePins(): Promise<void> {
  loading ??= Storage.getItem(SPACE_NAVIGATION_KEY)
    .then(raw => pinnedByDevice.set(readPins(raw)))
    .catch(() => undefined)
    .then(() => { spacePinsReady.set(true); });
  return loading;
}

export const pinnedSpaceIds = computed<readonly string[]>(
  () => pinnedByDevice()[pinScope(deviceContext())] ?? emptyPins,
);

export const pinnedSpaces = computed(() => {
  if (spacesCatalogDevice() !== deviceContext()) return [];
  const catalog = new Map(spaces().map(item => [item.id, item]));
  return pinnedSpaceIds().flatMap(id => catalog.get(id) ?? []);
});

export function setSpacePinned(appId: string, pinned: boolean, deviceId: string): void {
  if (!spacePinsReady() || !appId || deviceId !== deviceContext()) return;
  const scope = pinScope(deviceId);
  const current = pinnedByDevice()[scope] ?? emptyPins;
  if (current.includes(appId) === pinned) return;
  const next = {
    ...pinnedByDevice(),
    [scope]: pinned ? [...current, appId] : current.filter(id => id !== appId),
  };
  pinnedByDevice.set(next);
  const stored = JSON.stringify({ state: { pinnedAppIdsBySurface: next }, version: 0 });
  pendingWrite = pendingWrite.then(() => Storage.setItem(SPACE_NAVIGATION_KEY, stored)).catch(() => {
    pushToast(tr("spaces.pinSaveFailed"), "error");
  });
}
