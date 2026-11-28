import { host } from "nsh";

export async function resolveBrowserAsset(asset: string): Promise<string> {
  const url = await host.call<string | null>("openbitfun.documentRendererAsset", { asset });
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("The browser host did not resolve a document asset");
  return url;
}

export async function readRendererAsset(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Document renderer asset answered ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

let echartsScript: { url: string; load: Promise<string> } | undefined;

/** The same full ECharts distribution is used by both native figure views. */
export function readEchartsScript(url: string): Promise<string> {
  if (echartsScript?.url === url) return echartsScript.load;
  const load = readRendererAsset(url);
  echartsScript = { url, load };
  void load.catch(() => { if (echartsScript?.load === load) echartsScript = undefined; });
  return load;
}
