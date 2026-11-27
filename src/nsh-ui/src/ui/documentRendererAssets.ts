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
