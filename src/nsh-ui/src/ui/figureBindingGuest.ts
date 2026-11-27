import { Buffer } from "buffer";
import { readBindings, type Binding, type Declarations } from "../figureBindingDeclarations";

const MAX_FIGURE_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const RASTER = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,/;
const FILE_MIME = new Set([
  "application/json", "text/csv", "text/tab-separated-values", "text/plain", "text/markdown", "application/octet-stream",
]);

type FileValue = { name: string; mimeType: string } & ({ text: string } | { base64: string });
export type BoundValue = { kind: "json"; value: unknown } | { kind: "image"; value: string } | { kind: "file"; value: FileValue };
export type FigureSourceRow = { name: string; declaration: Binding; available: boolean };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validBase64(value: string): boolean {
  if (value.length % 4 !== 0 || value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || !BASE64.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding <= MAX_FILE_BYTES;
}

export function figureBindingValue(binding: Binding, saved: unknown): BoundValue | undefined {
  if (binding.type === "json") return { kind: "json", value: binding.value };
  const entry = record(saved);
  if (!entry) return;
  const value = entry.value;
  if (binding.type === "tool" && entry.kind === "json" && Object.hasOwn(entry, "value")) {
    try {
      const json = JSON.stringify(value);
      if (json && Buffer.byteLength(json, "utf8") <= MAX_JSON_BYTES) return { kind: "json", value };
    } catch { /* Ignore an unreadable recorded value. */ }
  }
  if (binding.type === "image" && entry.kind === "image" && typeof value === "string") {
    const prefix = value.match(RASTER)?.[0];
    if (prefix && value.length > prefix.length && validBase64(value.slice(prefix.length))) {
      return { kind: "image", value };
    }
  }
  if ((binding.type !== "file" && binding.type !== "library") || entry.kind !== "file") return;
  const file = record(value);
  if (!file || typeof file.name !== "string" || !file.name || file.name.length > 512) return;
  const mimeType = typeof file.mimeType === "string" && FILE_MIME.has(file.mimeType)
    ? file.mimeType : "application/octet-stream";
  if (typeof file.text === "string" && Buffer.byteLength(file.text, "utf8") <= MAX_FILE_BYTES) {
    return { kind: "file", value: { name: file.name, mimeType, text: file.text } };
  }
  if (typeof file.base64 === "string" && validBase64(file.base64)) {
    return { kind: "file", value: { name: file.name, mimeType, base64: file.base64 } };
  }
}

function scriptData(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function bindingUpdate(nonce: string, values: Record<string, BoundValue>): string | null {
  const message = JSON.stringify({ type: "openbitfun.figure.bindings.v1", nonce, values });
  return Buffer.byteLength(message, "utf8") <= MAX_FIGURE_BYTES ? message : null;
}

// The gateway shell mirrors this one-way relay for URL-backed WebViews.
export const figureBindingRelay = `(() => {
  const frame = document.querySelector("iframe");
  let latest;
  const forward = () => { if (latest) frame.contentWindow?.postMessage(latest, "*"); };
  frame.addEventListener("load", forward);
  addEventListener("message", event => {
    if ((event.source !== parent && event.source !== window && event.source !== null) ||
        typeof event.data !== "string" || event.data.length > 1048576) return;
    try {
      if (JSON.parse(event.data)?.type !== "openbitfun.figure.bindings.v1") return;
      latest = event.data;
      forward();
    } catch {}
  });
})();`;

// Runs before authored scripts in the opaque guest. Data arrives in the document
// envelope and this API never calls the host.
const bindingGuest = `<script>
(() => {
  const payload = document.getElementById('openbitfun-visual-data');
  const { declarations, values, nonce } = JSON.parse(payload.textContent);
  payload.remove();
  const sources = new Map();
  const listeners = new Map();
  const api = window.openai ??= {};
  api.visualization = {
    bindings: Object.freeze(declarations),
    onData(name, callback) {
      if (typeof callback !== 'function') throw new TypeError('onData requires a callback');
      if (!Object.hasOwn(declarations, name)) return () => {};
      if (!listeners.has(name)) listeners.set(name, new Set());
      const subscribers = listeners.get(name);
      subscribers.add(callback);
      callback(sources.get(name)?.value);
      return () => subscribers.delete(callback);
    },
  };
  api.visualizationData = { updates: [] };
  function applyValues(changed, initial) {
    const updates = [];
    for (const [name, record] of Object.entries(changed)) {
      if (!Object.hasOwn(declarations, name)) continue;
      const type = declarations[name].type;
      if (!initial && !(type === 'tool' && record.kind === 'json' || type === 'library' && record.kind === 'file')) continue;
      const previous = sources.get(name);
      const serialized = JSON.stringify(record);
      if (serialized === previous?.serialized) continue;
      let value = record.value;
      let blobUrl;
      if (record.kind === 'file') {
        const bytes = typeof value.base64 === 'string'
          ? Uint8Array.from(atob(value.base64), character => character.charCodeAt(0))
          : value.text;
        const blob = new Blob([bytes], { type: value.mimeType });
        blobUrl = URL.createObjectURL(blob);
        value = { name: value.name, blob, url: blobUrl };
      }
      const revision = (previous?.revision ?? 0) + 1;
      sources.set(name, { value, blobUrl, revision, serialized });
      updates.push({ name, revision, state: 'ready', value: { type: record.kind, value } });
      for (const callback of listeners.get(name) ?? []) {
        try { callback(value); } catch (error) { globalThis.reportError?.(error); }
      }
      if (previous?.blobUrl) URL.revokeObjectURL(previous.blobUrl);
    }
    if (updates.length) {
      api.visualizationData = { updates };
      dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { visualizationData: { updates } } } }));
    }
  }
  applyValues(values, true);
  if (nonce) addEventListener('message', event => {
    if (event.source !== parent || typeof event.data !== 'string' || event.data.length > 1048576) return;
    try {
      const update = JSON.parse(event.data);
      if (update?.type === "openbitfun.figure.bindings.v1" && update.nonce === nonce &&
          update.values && typeof update.values === 'object' && !Array.isArray(update.values)) {
        applyValues(update.values, false);
      }
    } catch {}
  });
})();
</script>`;

/** Exposes only declared values from the same sealed figure revision. */
export function buildFigureBindingGuest(source: string, sealed: unknown, renderedLength: number, nonce?: string) {
  const parsed = readBindings(source);
  if (!parsed) return { prefix: "", sources: [], invalid: true } as const;
  if (Object.keys(parsed).length === 0) return { prefix: "", sources: [], invalid: false } as const;

  const declarations: Declarations = Object.fromEntries(Object.entries(parsed).map(([name, declaration]) =>
    [name, declaration.type === "image" ? { ...declaration, url: "" } : declaration],
  ));
  const values: Record<string, BoundValue> = Object.create(null);
  const snapshots = record(sealed);
  const sources: FigureSourceRow[] = [];
  const budget = MAX_FIGURE_BYTES - renderedLength - Buffer.byteLength(bindingGuest, "utf8");
  for (const [name, declaration] of Object.entries(parsed)) {
    const saved = snapshots && Object.hasOwn(snapshots, name) ? snapshots[name] : undefined;
    const data = figureBindingValue(declaration, saved);
    if (data) {
      values[name] = data;
      if (data.kind === "image") declarations[name] = { type: "image", url: data.value };
      if (Buffer.byteLength(scriptData({ declarations, values, nonce }), "utf8") > budget) {
        delete values[name];
        if (data.kind === "image") declarations[name] = { type: "image", url: "" };
      }
    }
    sources.push({ name, declaration, available: Object.hasOwn(values, name) });
  }
  const prefix = `<script type="application/json" id="openbitfun-visual-data">${scriptData({ declarations, values, nonce })}</script>${bindingGuest}`;
  return { prefix, sources, invalid: false };
}
