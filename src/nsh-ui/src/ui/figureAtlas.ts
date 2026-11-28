import { Buffer } from "buffer";
import { platform, Storage } from "nsh";
import { parseFragment } from "parse5";
import { numberFormatterAtLocale } from "../../../shared/i18n/formatNumber";
import { projectAtlasMap, type RegionalAtlasLayer } from "../../../shared/visualize/regionalProjection";
import { rendererAssets } from "../documentRenderers";
import { readBindings } from "../figureBindingDeclarations";
import { currentLocale, normalizeLocale, tr, trForLocale } from "../i18n";
import { readRendererAsset, resolveBrowserAsset } from "./documentRendererAssets";

const MAX_FIGURE_BYTES = 1024 * 1024;
// The published Natural Earth layers are immutable and contain no figure or user data.
const ATLAS_LAYERS_URL = "https://raw.githubusercontent.com/openBitFun/OpenBitFun/6445275da6af446d47b66688198791a244649990/third_party/visualize/atlas/";
const STREET_CREDIT = '<small class="text-muted"><a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · VersaTiles</small>';
const STREET_ORIGINS = new Set(["https://tiles.versatiles.org", "https://photon.komoot.io"]);

type StreetCache = { revision: string; maps: Record<string, string> };
type AtlasPreview = { html: string; streetPending: boolean; streetFailed: boolean; saveStreet?: () => void };
type AtlasSpec = { detail?: unknown; language?: unknown; places?: { coordinates?: unknown }[] };

function atlasDeclarations(source: string) {
  const found: { startOffset: number; endOffset: number; spec: string }[] = [];
  const pending = [...parseFragment(source, { sourceCodeLocationInfo: true }).childNodes];
  while (pending.length) {
    const element = pending.pop()!;
    if (!("tagName" in element)) continue;
    const location = element.sourceCodeLocation;
    if (element.tagName === "script" && location?.endTag &&
        element.attrs.some(attr => attr.name === "data-visual-atlas" && attr.value === "1") &&
        element.attrs.some(attr => attr.name === "type" && attr.value === "application/json")) {
      found.push({ startOffset: location.startOffset, endOffset: location.endOffset,
        spec: source.slice(location.startTag!.endOffset, location.endTag.startOffset) });
    } else {
      pending.push(...element.childNodes);
    }
  }
  return found.sort((a, b) => a.startOffset - b.startOffset);
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function streetCacheRevision(source: string, language: string) {
  try {
    const input = JSON.stringify([language, source]);
    if (typeof crypto.createHash === "function") return crypto.createHash("sha256").update(input).digest("hex");
    return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))).toString("hex");
  } catch { return null; }
}

async function readStreetCache(key: string, revision: string): Promise<StreetCache["maps"]> {
  try {
    const raw = await Storage.getItem(key);
    if (!raw || Buffer.byteLength(raw, "utf8") > MAX_FIGURE_BYTES) return {};
    const value = JSON.parse(raw) as Partial<StreetCache>;
    if (value.revision === revision && value.maps && Object.values(value.maps).every(map =>
      typeof map === "string" && map.startsWith("<svg ") && map.includes("data-street-ground="))) {
      return value.maps;
    }
  } catch { /* A missing or unreadable cache does not prevent viewing the figure. */ }
  return {};
}

/** Requests public map data from the consenting controller, outside the figure sandbox. */
function requestStreetData(cancel: AbortSignal): typeof fetch {
  return (url, options) => {
    if (cancel.aborted || !(typeof url === "string" || url instanceof URL) ||
        !STREET_ORIGINS.has(new URL(url).origin)) return Promise.reject(new Error("Street map request refused"));
    const signal = options?.signal ? AbortSignal.any([cancel, options.signal]) : cancel;
    return fetch(url, { ...options, signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
  };
}

async function fetchAtlasLayer(layer: RegionalAtlasLayer, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(ATLAS_LAYERS_URL + layer + ".json", {
    signal,
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error(`Regional map layer answered ${response.status}`);
  return response.json();
}

/** Materializes sealed map declarations without changing the saved snapshot. */
export async function materializeFigureAtlas(source: string, options: {
  readerKey?: string;
  signal?: AbortSignal;
  online?: AbortSignal;
} = {}): Promise<AtlasPreview | null> {
  if (!/data-visual-atlas/i.test(source)) return null;
  const declarations = atlasDeclarations(source);
  if (!declarations.length) return null;

  const specs = declarations.map(({ spec }) => {
    try { return JSON.parse(spec) as AtlasSpec | null; } catch { return null; }
  });
  const hasStreet = specs.some(spec => spec?.detail === "street");
  const fallbackLocale = currentLocale();
  const cacheKey = hasStreet && options.readerKey ? "openbitfun.nsh.street-map.v1:" + options.readerKey : null;
  const revision = cacheKey ? await streetCacheRevision(source, fallbackLocale) : null;
  const maps = cacheKey && revision ? await readStreetCache(cacheKey, revision) : {};
  const bindings = hasStreet ? readBindings(source) : null;
  const canGeocode = !!bindings && Object.values(bindings).every(binding => binding.type === "image");
  const online = options.online && requestStreetData(options.online);

  const assets = rendererAssets()?.figureAtlas;
  const layerSignal = AbortSignal.any(
    [AbortSignal.timeout(30_000), options.signal, options.online].filter(signal => signal !== undefined),
  );
  const layerCache = new Map<RegionalAtlasLayer, Promise<unknown>>();
  async function readAsset(asset: string) {
    return readRendererAsset(platform.os === "web" ? await resolveBrowserAsset(asset) : asset);
  }
  function readLayer(layer: RegionalAtlasLayer) {
    let pending = layerCache.get(layer);
    if (!pending) {
      pending = fetchAtlasLayer(layer, layerSignal);
      layerCache.set(layer, pending);
    }
    return pending;
  }

  let stylesheet: Promise<string> | undefined;
  let streetPending = false;
  let streetFailed = false;
  let changed = false;
  let html = "";
  let offset = 0;
  for (const [index, declaration] of declarations.entries()) {
    html += source.slice(offset, declaration.startOffset);
    offset = declaration.endOffset;
    const spec = specs[index];
    const street = spec?.detail === "street";
    const beyondLimit = (markup: string) =>
      Buffer.byteLength(html + markup + source.slice(offset), "utf8") > MAX_FIGURE_BYTES;
    try {
      if (street) {
        if (!canGeocode && (!Array.isArray(spec.places) || spec.places.some(place => !place?.coordinates))) {
          html += `<p role="alert">${escapeText(tr("chat.figures.map.boundStreetUnavailable"))}</p>`;
          continue;
        }
        const cached = maps[index];
        if (cached && !beyondLimit(cached)) {
          html += cached;
          continue;
        }
        if (!online) {
          streetPending = true;
          continue;
        }
      }
      if (!spec || !assets) throw new Error("Missing regional map declaration or assets");
      const locale = normalizeLocale(spec.language) ?? fallbackLocale;
      const svg = await projectAtlasMap(spec, readLayer, locale, {
        north: trForLocale(locale, "chat.figures.map.north"),
        km: trForLocale(locale, "chat.figures.map.kilometers"),
        m: trForLocale(locale, "chat.figures.map.meters"),
        formatNumber: numberFormatterAtLocale(locale),
      }, street ? online : undefined);
      stylesheet ??= readAsset(assets.stylesheet);
      const rendered = svg.replace(">", `><style>${await stylesheet}</style>`) +
        (street ? STREET_CREDIT : `<small class="text-muted">${escapeText(trForLocale(locale, "chat.figures.map.credit"))}</small>`);
      if (beyondLimit(rendered)) throw new Error("Projected map exceeds the figure size limit");
      if (street) {
        maps[index] = rendered;
        changed = true;
      }
      html += rendered;
    } catch {
      if (street) {
        streetPending = true;
        streetFailed = true;
      } else {
        html += `<p role="alert">${escapeText(tr("chat.figures.map.unavailable"))}</p>`;
      }
    }
  }
  let saved = false;
  const saveStreet = changed && cacheKey && revision ? () => {
    if (options.online?.aborted || saved) return;
    saved = true;
    const packed = JSON.stringify({ revision, maps });
    if (Buffer.byteLength(packed, "utf8") <= MAX_FIGURE_BYTES) void Storage.setItem(cacheKey, packed).catch(() => undefined);
  } : undefined;
  return { html: html + source.slice(offset), streetPending, streetFailed, saveStreet };
}
