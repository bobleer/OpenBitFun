import { Buffer } from "buffer";
import { host, platform } from "nsh";
import { rendererAssets } from "../documentRenderers";
import { readBindings } from "../figureBindingDeclarations";
import { readRendererAsset } from "./documentRendererAssets";
import { figureBindingValue, type BoundValue } from "./figureBindingGuest";

export type FigureImageLoader = {
  html: string;
  receive: (message: string) => void;
  fail: () => void;
};
export type LoadedFigureImages = ReadonlyMap<string, Extract<BoundValue, { kind: "image" }>>;

let cachedReader: { asset: string; source: Promise<string> } | undefined;

function readerSource(asset: string) {
  if (cachedReader?.asset !== asset) {
    const current = { asset, source: readRendererAsset(asset) };
    cachedReader = current;
    void current.source.catch(() => { if (cachedReader === current) cachedReader = undefined; });
  }
  return cachedReader.source;
}

function requestId() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

async function loadBrowserImage(asset: string, url: string, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return;
  const nonce = requestId();
  const cancel = () => { void host.call("openbitfun.cancelFigureImage", { nonce }).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await host.call("openbitfun.loadFigureImage", { nonce, asset, url });
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function loadNativeImages(
  asset: string, urls: readonly string[], signal: AbortSignal,
  mount: (loader: FigureImageLoader | null) => void,
): Promise<Map<string, unknown>> {
  const results = new Map<string, unknown>();
  const source = await readerSource(asset).catch(() => undefined);
  if (!source || signal.aborted) return results;
  const nonce = requestId();
  const pending = new Set(urls);
  const config = JSON.stringify({ nonce, urls }).replaceAll("<", "\\u003c");
  const origins = [...new Set(urls.map(url => new URL(url).origin))].join(" ");
  const policy = `default-src 'none'; script-src 'unsafe-inline'; connect-src ${origins}; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<script type="application/json" id="figure-image-request">${config}</script>` +
    `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      mount(null);
      resolve(results);
    };
    const timeout = setTimeout(finish, 7000);
    signal.addEventListener("abort", finish, { once: true });
    mount({
      html, fail: finish,
      receive(message) {
        if (done || message.length > 384 * 1024) return;
        try {
          const entry = JSON.parse(message);
          if (entry?.nonce !== nonce || !pending.delete(entry.url)) return;
          if (typeof entry.value === "string") results.set(entry.url, entry.value);
          if (!pending.size) finish();
        } catch { /* Replies must come from this exact loader. */ }
      },
    });
  });
}

/** Localizes only missing declarations, before the authored figure renders. */
export async function localizeFigureImages(
  source: string, sealed: unknown, signal: AbortSignal,
  mount: (loader: FigureImageLoader | null) => void,
  prior?: LoadedFigureImages,
) {
  const loaded = new Map<string, Extract<BoundValue, { kind: "image" }>>();
  const names = new Set<string>();
  const asset = rendererAssets()?.figureImageLoader;
  if (!asset) return { bindings: sealed, loaded, names };
  const snapshots = sealed && typeof sealed === "object" && !Array.isArray(sealed)
    ? sealed as Record<string, unknown> : {};
  const missing = Object.entries(readBindings(source) ?? {}).flatMap(([name, binding]) =>
    binding.type === "image" && !figureBindingValue(binding, Object.hasOwn(snapshots, name) ? snapshots[name] : undefined)
      ? [{ name, binding }] : [],
  );
  if (!missing.length || signal.aborted) return { bindings: sealed, loaded, names };
  const urls = [...new Set(missing.map(({ binding }) => binding.url).filter(url => !prior?.has(url)))];
  const fetched = !urls.length ? new Map<string, unknown>() : platform.os === "web"
    ? new Map(await Promise.all(urls.map(async url => [url, await loadBrowserImage(asset, url, signal)] as const)))
    : await loadNativeImages(asset, urls, signal, mount);
  if (signal.aborted) return { bindings: sealed, loaded, names };
  const bindings = { ...snapshots };
  for (const { name, binding } of missing) {
    const value = prior?.get(binding.url) ??
      figureBindingValue(binding, { kind: "image", value: fetched.get(binding.url) });
    if (value?.kind !== "image") continue;
    bindings[name] = value;
    loaded.set(binding.url, value);
    names.add(name);
  }
  return { bindings, loaded, names };
}
