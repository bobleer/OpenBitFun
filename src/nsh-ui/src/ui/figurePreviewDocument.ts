import { Buffer } from "buffer";
import { host, platform } from "nsh";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { WidgetMessages } from "../../assets/figure-renderer/widgetI18n";
import { rendererAssets } from "../documentRenderers";
import { readFigureReaderState } from "../figureReaderStore";
import { currentLocale, tr } from "../i18n";
import { palette, radii, resolvedScheme, space, textSize, textStyle } from "../theme";
import { readEchartsScript, readRendererAsset, resolveBrowserAsset } from "./documentRendererAssets";
import { materializeFigureAtlas } from "./figureAtlas";
import { buildFigureBindingGuest, figureBindingRelay, type FigureSourceRow } from "./figureBindingGuest";

const SHELL_POLICY = "default-src 'none'; frame-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";
const FRAME_POLICY = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";
const DATA_ROOT = "openbitfun-figure-data";

export type FigurePreviewDocument = (
  | { html: string; inject?: string; src?: never; reader?: { key: string; nonce: string } }
  | { src: string; html?: never; inject?: never; reader?: never }
) & {
  streetMap?: { failed: boolean; load: (signal: AbortSignal) => Promise<FigurePreviewDocument> };
  saveStreet?: () => void;
  sources?: readonly FigureSourceRow[];
  invalidBindings?: boolean;
  bindingNonce?: string;
};

/** HTML snapshots with a direct JSON declaration use the built-in renderer. */
export function hasFigureDeclaration(source: string): boolean {
  if (!/data-openbitfun-visualize/i.test(source)) return false;
  type Parent = DefaultTreeAdapterTypes.ParentNode;
  const pending: Parent[] = [parseFragment(source)];
  while (pending.length > 0) {
    for (const child of pending.pop()!.childNodes) {
      if (!("tagName" in child)) continue;
      if (child.tagName === "figure" && child.attrs.some(attr => attr.name === "data-openbitfun-visualize") &&
          child.childNodes.some(node => "tagName" in node && node.tagName === "script" &&
            node.attrs.some(attr => attr.name === "type" && attr.value === "application/json"))) return true;
      pending.push(child);
    }
  }
  return false;
}

function figureThemeCss(): string {
  const colors = palette();
  const tokens = {
    background: colors.canvas,
    foreground: colors.text,
    "muted-foreground": colors.textMuted,
    border: colors.border,
    primary: colors.accent,
    "primary-foreground": colors.actionSolidFg,
    "surface-raised": colors.surfaceTertiary,
    blue: colors.accent,
    green: colors.success,
    red: colors.danger,
    "viz-success": colors.success,
    "viz-warning": colors.warning,
    "viz-info": colors.gitLanes[3],
    "viz-danger": colors.danger,
    ...Object.fromEntries(colors.gitLanes.map((color, index) => [`viz-series-${index + 1}`, color])),
  };
  const declarations = Object.entries(tokens).map(([key, color]) => `--${key}:${color.replace(/[<>{};]/g, "")}`).join(";");
  return `:root{${declarations};color-scheme:${resolvedScheme()}}
    body{margin:0;color:var(--foreground);background:var(--background);font:${textSize(14)}px/1.5 system-ui,sans-serif}
    :where(button,input,select){font:inherit;color:inherit;background:var(--background);border:1px solid var(--border);border-radius:${radii.sm}px}
    :where(button,select){padding:${space.xs}px ${space.sm}px}
    :where(button){cursor:pointer}
    :where(:focus-visible){outline:2px solid var(--primary);outline-offset:2px}
    .text-muted{color:var(--muted-foreground)}.text-small{font-size:${textSize(12)}px}`;
}

function encode(source: string): string {
  return Buffer.from(source).toString("base64");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The main widget styles consume the same visual roles as the NSH chat surface. */
function widgetThemeCss(): string {
  const roles = {
    "body-md": "body", "body-sm": "smallBody", "label-md": "label", "label-selected": "sectionTitle",
    "heading-dialog": "modalTitle", "heading-panel": "sectionTitle", "heading-section": "sectionTitle",
    "flow-body": "prose", "flow-code": "mono",
  } as const;
  const typography = Object.entries(roles).map(([alias, role]) => {
    const style = textStyle(role);
    const family = (style.fontFamily ?? "system-ui, sans-serif").replace(/[<>{};]/g, "");
    const key = `--openbitfun-type-${alias}`;
    return `${key}-font-family:${family};${key}-font-size:${style.fontSize}px;` +
      `${key}-font-weight:${style.fontWeight};${key}-line-height:${style.lineHeight}px;` +
      `${key}-letter-spacing:${style.letterSpacing ?? 0}px;`;
  }).join("");
  return `.figure-widget{
    ${typography}
    --openbitfun-color-surface-canvas:var(--background);--openbitfun-color-content-primary:var(--foreground);
    --openbitfun-color-content-secondary:var(--muted-foreground);--openbitfun-color-border-default:var(--border);
    --openbitfun-color-accent-default:var(--primary);--openbitfun-color-action-neutral-surface-hover:var(--surface-raised);
    --openbitfun-color-status-info-content:var(--viz-info);--openbitfun-color-status-success-content:var(--viz-success);
    --openbitfun-color-status-warning-content:var(--viz-warning);--openbitfun-color-status-danger-content:var(--viz-danger);
  }.figure-widget>.visual-answer{margin:0}`;
}

function documentHead(scriptPolicy: string, style: string, localBindings = false): string {
  const assets = localBindings ? "img-src data: blob:; connect-src data: blob:" : "img-src data:";
  return `<!doctype html><html lang="${currentLocale()}" data-scheme="${resolvedScheme()}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}; ${assets}; script-src ${scriptPolicy}">` +
    `<style>${figureThemeCss()}${style}</style></head>`;
}

async function htmlPreview(source: string, localBindings: boolean, nonce?: string): Promise<FigurePreviewDocument> {
  const encoded = encode(`${documentHead("'unsafe-inline'", "", localBindings)}<body>${source}</body></html>`);
  const browserShell = platform.os === "web" ? await host.call<string | {
    url: string; bindingUpdates: boolean;
  } | null>("openbitfun.figurePreviewShell", { capabilities: !!nonce }) : null;
  if (browserShell) {
    const url = typeof browserShell === "string" ? browserShell : browserShell.url;
    return { src: `${url}#${encoded}`, bindingNonce: typeof browserShell !== "string" && browserShell.bindingUpdates ? nonce : undefined };
  }
  return {
    html: `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SHELL_POLICY}">` +
      `<style>html,body,iframe{width:100%;height:100%;margin:0;border:0}iframe{display:block}</style>` +
      `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="data:text/html;base64,${encoded}"></iframe>` +
      (nonce ? `<script>${figureBindingRelay}</script>` : ""),
    bindingNonce: platform.os === "web" ? undefined : nonce,
  };
}

let nativeRenderer: { asset: string; load: Promise<string> } | undefined;

function loadNativeRenderer(asset: string): Promise<string> {
  if (nativeRenderer?.asset === asset) return nativeRenderer.load;
  const load = readRendererAsset(asset);
  nativeRenderer = { asset, load };
  void load.catch(() => { if (nativeRenderer?.load === load) nativeRenderer = undefined; });
  return load;
}

async function declarationPreview(source: string, key: string, followUp: boolean, previewTitle: string): Promise<FigurePreviewDocument> {
  const assets = rendererAssets();
  if (!assets?.figureScript || !assets.echartsScript) throw new Error("This app has no declarative figure renderer");
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const reader = { key, nonce };
  const state = await readFigureReaderState(key);
  const widget: WidgetMessages = {
    "shared:tools.search": tr("common.search"),
    "visualize.asyncBoundary": tr("chat.figures.widget.asyncBoundary"),
    "visualize.critical": tr("chat.figures.widget.critical"),
    "visualize.day": tr("chat.figures.widget.day"),
    "visualize.direct": tr("chat.figures.widget.direct"),
    "visualize.draftUnavailable": tr("chat.figures.draftUnavailable"),
    "visualize.end": tr("chat.figures.end"),
    "visualize.estimatedPath": tr("chat.figures.widget.estimatedPath"),
    "visualize.followUp": tr("chat.figures.followUp"),
    "visualize.functions": tr("chat.figures.widget.functions"),
    "visualize.month": tr("chat.figures.widget.month"),
    "visualize.next": tr("chat.figures.widget.next"),
    "visualize.now": tr("chat.figures.widget.now"),
    "visualize.previous": tr("chat.figures.widget.previous"),
    "visualize.range": tr("chat.figures.widget.range"),
    "visualize.runtimeFrames": tr("chat.figures.widget.runtimeFrames"),
    "visualize.saveFailed": tr("chat.figures.saveFailed"),
    "visualize.sort": tr("chat.figures.widget.sort"),
    "visualize.start": tr("chat.figures.start"),
    "visualize.total": tr("chat.figures.widget.total"),
    "visualize.view": tr("chat.figures.widget.view"),
    "visualize.week": tr("chat.figures.widget.week"),
    "visualize.zoomIn": tr("chat.figures.widget.zoomIn"),
    "visualize.zoomOut": tr("chat.figures.widget.zoomOut"),
  };
  const labels = {
    widget,
    previewTitle,
    all: tr("common.all"), data: tr("chat.figures.data"), empty: tr("chat.figures.noData"),
    unavailable: tr("chat.figures.declarationUnavailable"), more: tr("chat.figures.showMore"),
    start: tr("chat.figures.start"), end: tr("chat.figures.end"),
    selection: tr("chat.figures.selection"), followUp: tr("chat.figures.followUp"),
    draftUnavailable: tr("chat.figures.draftUnavailable"),
    saveFailed: tr("chat.figures.saveFailed"),
  };
  const style = `${widgetThemeCss()}
    main,.viz-content,.viz-content>section{display:flex;flex-direction:column;gap:${space.sm}px;min-width:0}
    main{padding:${space.sm}px;overflow-wrap:anywhere}
    .viz-content>section+section{padding-top:${space.md}px;border-top:1px solid var(--border)}
    h1,h2,p{margin:0}h1{font-size:${textSize(18)}px}h2{font-size:${textSize(15)}px}
    .viz-controls,.viz-filter,label:has(input[type=range]){display:flex;align-items:center;flex-wrap:wrap;gap:${space.xs}px}
    .viz-controls:empty,output:empty,.viz-notice:empty{display:none}.viz-plot{width:100%;min-width:0}
    button[aria-pressed=true]{background:var(--surface-raised);border-color:var(--primary)}
    button[aria-pressed=false],output{color:var(--muted-foreground)}
    details{border-top:1px solid var(--border);padding-top:${space.xs}px}
    summary{cursor:pointer}.viz-table{max-width:100%;overflow:auto}
    table{width:100%;border-collapse:collapse;text-align:start}
    th,td{text-align:start;padding:${space.xs}px ${space.sm}px;border-bottom:1px solid var(--border)}
    th{background:var(--surface-raised)}
    dl{display:grid;grid-template-columns:auto 1fr;gap:${space.xs}px ${space.sm}px;margin:0}dd{margin:0}`;
  // The original HTML is inert input. Only the shipped script is executable in this document.
  const data = `<body><main id="${DATA_ROOT}" data-source="${encode(source)}" data-labels="${escapeAttr(JSON.stringify(labels))}"` +
    ` data-reader="${escapeAttr(JSON.stringify({ nonce, state, followUp }))}"></main>`;
  if (platform.os === "web") {
    const scripts = await Promise.all([assets.echartsScript, assets.figureScript].map(resolveBrowserAsset));
    const origins = [...new Set(scripts.map(script => new URL(script).origin))].join(" ");
    const html = documentHead(escapeAttr(origins), style) + data;
    return { html: `${html}${scripts.map(script => `<script src="${escapeAttr(script)}"></script>`).join("")}</body></html>`, reader };
  }
  const scripts = await Promise.all([readEchartsScript(assets.echartsScript), loadNativeRenderer(assets.figureScript)]);
  const script = scripts.join("\n;\n");
  const html = documentHead("'unsafe-inline'", style) + data;
  // The combined scripts exceed WebView2's UTF-16 HTML navigation limit.
  if (platform.os === "windows") {
    return { html: `${html}</body></html>`, reader, inject: `if (document.getElementById('${DATA_ROOT}')?.dataset.source) {\n${script}\n}` };
  }
  const inline = script.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  return { html: `${html}<script>${inline}</script></body></html>`, reader };
}

export async function createFigurePreviewDocument(
  source: string, readerKey: string, followUp: boolean, title: string,
  options: { bindings?: unknown; signal?: AbortSignal; online?: AbortSignal } = {},
): Promise<FigurePreviewDocument> {
  const atlas = await materializeFigureAtlas(source, { readerKey, online: options.online });
  if (!atlas && hasFigureDeclaration(source)) return declarationPreview(source, readerKey, followUp, title);
  const fragment = atlas?.html ?? source;
  const nonce = source.startsWith("<!-- vis-bindings\n") ? Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex") : undefined;
  const bindings = buildFigureBindingGuest(source, options.bindings, Buffer.byteLength(fragment, "utf8"), nonce);
  const canUpdate = bindings.sources.some(row => row.declaration.type === "tool" || row.declaration.type === "library");
  const preview = await htmlPreview(bindings.prefix + fragment, !!bindings.prefix, canUpdate ? nonce : undefined);
  return {
    ...preview,
    streetMap: atlas?.streetPending ? {
      failed: atlas.streetFailed,
      load: signal => createFigurePreviewDocument(source, readerKey, followUp, title, { ...options, online: signal }),
    } : undefined,
    saveStreet: atlas?.saveStreet,
    sources: bindings.sources,
    invalidBindings: bindings.invalid,
  };
}
