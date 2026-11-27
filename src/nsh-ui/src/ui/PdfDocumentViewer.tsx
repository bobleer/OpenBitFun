import { cleanup, effect, platform, signal, Text, untracked, View, WebView, type ViewRef, type WebViewRef } from "nsh";
import { rendererAssets } from "../documentRenderers";
import { formatCount } from "../format";
import { tr } from "../i18n";
import { MAX_REVIEW_JSON, MAX_REVIEW_PDF, PDF_REVIEW_CHUNK, parsePdfReview,
  type PdfReviewAnnotation, type PdfReviewColor, type PdfReviewData, type PdfReviewTool } from "../pdfReviewData";
import { palette, space, textStyle } from "../theme";
import { readRendererAsset, resolveBrowserAsset } from "./documentRendererAssets";
import { Spinner } from "./motion";
import { DropdownMenu, type DropdownMenuItem } from "./overlays";
import { Button, EmptyStateCard, IconButton, InputBox } from "./primitives";
import { Toolbar, ToolbarSeparator } from "./Toolbar";

const PDF_CHUNK = 128 * 1024;
const zoomPresets = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
let cachedRenderer: { asset: string; nativeScript: Promise<string> } | null = null;

function nativeRenderer(asset: string): Promise<string> {
  if (cachedRenderer?.asset !== asset) {
    const nativeScript = readRendererAsset(asset);
    cachedRenderer = { asset, nativeScript };
    nativeScript.catch(() => {
      if (cachedRenderer?.nativeScript === nativeScript) cachedRenderer = null;
    });
  }
  return cachedRenderer.nativeScript;
}

function pdfFrameHtml(scriptUrl: string | null) {
  const background = palette().canvasSubtle;
  const scriptOrigin = scriptUrl ? new URL(scriptUrl).origin : "'unsafe-inline'";
  const csp = `default-src 'none'; script-src ${scriptOrigin} 'wasm-unsafe-eval'; style-src 'unsafe-inline'; font-src blob: data:; img-src blob: data:`;
  const script = scriptUrl?.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{margin:0;background:${background}}#pdf-pages{position:relative;box-sizing:border-box;width:max-content;min-width:100%;display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px}
.pdf-page{position:relative;overflow:hidden;flex:none;background:Canvas}.pdf-page>canvas{display:block;width:100%;height:100%}
.pdf-review-overlay{position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:none}
#pdf-pages[data-review-tool=note] .pdf-page,#pdf-pages[data-review-tool=ink] .pdf-page{user-select:none;cursor:crosshair}
#pdf-pages[data-review-tool=ink] .pdf-page{touch-action:none}
.textLayer{position:absolute;inset:0;overflow:clip;text-align:initial;line-height:1;transform-origin:0 0;text-size-adjust:none;-webkit-text-size-adjust:none;forced-color-adjust:none;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor)*var(--min-font-size))}
.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}
.textLayer>:not(.markedContent),.textLayer .markedContent span:not(.markedContent){z-index:1;--font-height:0;--scale-x:1;--rotate:0deg;font-size:calc(var(--text-scale-factor)*var(--font-height));transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(calc(1 / var(--min-font-size)))}
.textLayer .markedContent{display:contents}.textLayer span[role="img"]{user-select:none;cursor:default}.textLayer ::selection{background:color-mix(in srgb,AccentColor,transparent 75%)}.textLayer br::selection{background:transparent}</style>
</head><body><main id="pdf-pages"></main>${script ? `<script src="${script}"></script>` : ""}</body></html>`;
}

interface PdfViewerReview {
  tool: PdfReviewTool;
  color: PdfReviewColor;
  selected?: string;
  annotations: PdfReviewAnnotation[];
}

export type PdfCopyBlock = "encrypted" | "unreadable";
export type PdfCopyFactory = (review: PdfReviewData) => Promise<string>;

interface PendingCopy {
  id: number;
  chunks: string[];
  length: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (base64: string) => void;
  reject: (reason: Error) => void;
}

/** A shared accessible toolbar over the PDF.js page and text layers. */
export function PdfDocumentViewer(props: {
  name: string;
  base64: string;
  blockInput?: boolean;
  hideSurface?: boolean;
  review?: PdfViewerReview;
  reviewJump?: { page: number };
  onReviewReady?: (fingerprint: string, canCopy: boolean, embedded?: PdfReviewData, blocked?: PdfCopyBlock) => void;
  onCopyFactory?: (factory: PdfCopyFactory | undefined) => void;
  onReviewAdd?: (message: Record<string, unknown>) => void;
  onReviewSelect?: (id: string) => void;
}) {
  const status = signal<"loading" | "ready" | "failed" | "password">("loading");
  const html = signal("");
  const page = signal(1);
  const count = signal(0);
  const scale = signal(1);
  const requestedZoom = signal<number | null>(null);
  const rotation = signal(0);
  const pageDraft = signal<string | null>(null);
  const password = signal("");
  const incorrectPassword = signal(false);
  const pageError = signal<number | null>(null);
  const zoomMenu = signal(false);
  const zoomAnchor = signal<ViewRef | null>(null);
  let frame: WebViewRef | null = null;
  let disposed = false;
  let sentBytes = false;
  let installScript = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let pendingCopy: PendingCopy | undefined;
  let nextCopy = 0;
  let embeddedText = "";
  const isWeb = platform.os === "web";
  const initialFrame = untracked(() => pdfFrameHtml(null));
  const source = untracked(() => props.base64);

  function clearDeadline() {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
  }

  function failed(reason: string) {
    clearDeadline();
    rejectCopy("unreadable");
    console.warn("PDF preview failed", reason);
    status.set("failed");
  }

  function awaitRenderer() {
    clearDeadline();
    timeout = setTimeout(() => failed("Renderer timed out"), 45_000);
  }

  cleanup(() => {
    disposed = true;
    clearDeadline();
    rejectCopy("closed");
    props.onCopyFactory?.(undefined);
  });

  const asset = rendererAssets()?.pdfScript;
  if (asset) {
    awaitRenderer();
    const load = isWeb ? resolveBrowserAsset(asset) : nativeRenderer(asset);
    void load.then(result => {
      if (disposed || status() === "failed") return;
      if (!isWeb) installScript = result;
      html.set(isWeb ? pdfFrameHtml(result) : initialFrame);
    }, error => { if (!disposed) failed(error instanceof Error ? error.message : "Renderer asset unavailable"); });
  } else {
    failed("No renderer asset was registered");
  }

  function send(type: string, payload: Record<string, unknown> = {}) {
    frame?.postMessage(JSON.stringify({ channel: "openbitfun-pdf", type, ...payload }));
  }

  function rejectCopy(reason: string) {
    const copy = pendingCopy;
    if (!copy) return;
    pendingCopy = undefined;
    clearTimeout(copy.timer);
    copy.reject(new Error(reason));
  }

  function makeCopy(review: PdfReviewData): Promise<string> {
    if (disposed || !frame || status() !== "ready" || pendingCopy) return Promise.reject(new Error("unreadable"));
    const text = JSON.stringify(review);
    if (text.length > MAX_REVIEW_JSON) return Promise.reject(new Error("review-too-large"));
    const id = ++nextCopy;
    return new Promise((resolve, reject) => {
      pendingCopy = { id, chunks: [], length: 0, resolve, reject,
        timer: setTimeout(() => rejectCopy("timeout"), 45_000) };
      for (let index = 0; index < text.length; index += PDF_REVIEW_CHUNK) {
        send("review-copy-data", { id, chunk: text.slice(index, index + PDF_REVIEW_CHUNK) });
      }
      send("review-copy", { id });
    });
  }

  function onCopyMessage(message: Record<string, unknown>) {
    const copy = pendingCopy;
    if (!copy || message.id !== copy.id) return;
    if (message.type === "review-copy-chunk") {
      if (typeof message.chunk !== "string" || message.chunk.length > PDF_REVIEW_CHUNK ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(message.chunk) || message.chunk.length % 4 !== 0 ||
          copy.length + message.chunk.length > Math.ceil(MAX_REVIEW_PDF / 3) * 4) {
        rejectCopy("unreadable");
        return;
      }
      copy.chunks.push(message.chunk);
      copy.length += message.chunk.length;
    } else if (message.type === "review-copy-done") {
      const size = message.byteLength;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_REVIEW_PDF ||
          copy.length !== Math.ceil(size / 3) * 4) {
        rejectCopy("unreadable");
        return;
      }
      pendingCopy = undefined;
      clearTimeout(copy.timer);
      copy.resolve(copy.chunks.join(""));
    } else if (message.type === "review-copy-error") {
      rejectCopy(typeof message.reason === "string" ? message.reason : "unreadable");
    }
  }

  function onMessage(raw: unknown) {
    if (disposed || status() === "failed" || typeof raw !== "string") return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.type === "ready" && frame && !sentBytes) {
      sentBytes = true;
      awaitRenderer();
      for (let offset = 0; offset < source.length; offset += PDF_CHUNK) {
        send("data", { chunk: source.slice(offset, offset + PDF_CHUNK) });
      }
      send("open", { inspectReview: Boolean(props.onReviewReady) });
      return;
    }
    if (message.type === "error") {
      failed(typeof message.reason === "string" ? message.reason : "The renderer rejected the document");
      return;
    }
    if (message.type === "password") {
      clearDeadline();
      incorrectPassword.set(message.incorrect === true);
      status.set("password");
      return;
    }
    if (message.type === "page-error" && typeof message.page === "number") pageError.set(message.page);
    if (message.type === "painted" && message.page === pageError()) pageError.set(null);
    if (message.type === "review-embedded" && status() === "loading" && typeof message.chunk === "string" &&
        message.chunk.length <= PDF_REVIEW_CHUNK && embeddedText.length + message.chunk.length <= MAX_REVIEW_JSON) {
      embeddedText += message.chunk;
    }
    if (typeof message.type === "string" && message.type.startsWith("review-copy-")) onCopyMessage(message);
    if (message.type === "review-add") {
      if (message.kind === "note") frame?.blur();
      props.onReviewAdd?.(message);
    }
    if (message.type === "review-select" && typeof message.id === "string") props.onReviewSelect?.(message.id);
    if (message.type !== "position" && message.type !== "loaded") return;
    if (typeof message.pages !== "number" || !Number.isInteger(message.pages) || message.pages < 1 ||
        typeof message.page !== "number" || !Number.isInteger(message.page) || message.page < 1 ||
        message.page > message.pages || typeof message.scale !== "number" || !Number.isFinite(message.scale) ||
        message.scale <= 0) return;
    page.set(message.page);
    count.set(message.pages);
    scale.set(message.scale);
    if (message.zoom === null || (typeof message.zoom === "number" && Number.isFinite(message.zoom) &&
      message.zoom >= 0.25 && message.zoom <= 4)) requestedZoom.set(message.zoom);
    if (message.type === "loaded") {
      clearDeadline();
      status.set("ready");
      let blocked: PdfCopyBlock | undefined =
        message.copyBlock === "encrypted" || message.copyBlock === "unreadable" ? message.copyBlock : undefined;
      let embedded: PdfReviewData | undefined;
      if (embeddedText) {
        try { embedded = parsePdfReview(embeddedText); } catch { blocked = "unreadable"; }
        embeddedText = "";
      }
      props.onReviewReady?.(typeof message.fingerprint === "string" ? message.fingerprint : "",
        message.canCopy === true, embedded, blocked);
      if (!blocked) props.onCopyFactory?.(makeCopy);
    }
  }

  function changeView(nextPage?: number) {
    send("view", { page: nextPage ?? null, rotation: rotation(), zoom: requestedZoom() });
  }

  function jump(value: string) {
    const number = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
    pageDraft.set(null);
    if (!Number.isSafeInteger(number) || number < 1 || number > count()) return;
    changeView(number);
  }

  function zoomTo(value: number | null) {
    requestedZoom.set(value);
    changeView();
  }

  function stepZoom(direction: -1 | 1) {
    const next = Math.round(scale() * 100 + direction * 25) / 100;
    zoomTo(Math.min(4, Math.max(0.25, next)));
  }

  function unlock() {
    if (!password()) return;
    send("password", { value: password() });
    password.set("");
    status.set("loading");
    awaitRenderer();
  }

  const ready = () => status() === "ready";
  effect(() => {
    const review = props.review;
    if (ready() && review) send("review", {
      tool: review.tool, color: review.color, selected: review.selected,
      annotations: review.annotations.map(({ id, page, kind, rect, color, quads, strokes }) =>
        ({ id, page, kind, rect, color, quads, strokes })),
    });
  });
  effect(() => {
    const request = props.reviewJump;
    if (ready() && request && request.page <= count()) changeView(request.page);
  });
  const zoomLabel = () => `${formatCount(Math.round(scale() * 100))}%`;
  const zoomItems = (): DropdownMenuItem[] => [
    { id: "fit", label: tr("doc.pdfFitWidth"), active: requestedZoom() === null, onSelect: () => zoomTo(null) },
    ...zoomPresets.map(value => ({ id: String(value), label: `${formatCount(value * 100)}%`,
      accessibilityLabel: `file-pdf-zoom-${value * 100}`, active: requestedZoom() === value, onSelect: () => zoomTo(value) })),
  ];

  return <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
    <Toolbar size="sm"
      leading={<Text style={{ ...textStyle("caption", { color: palette().text }),
        numberOfLines: 1, textOverflow: "ellipsis-middle", fontWeight: "600", flexShrink: 1 }}>{props.name}</Text>}
      trailing={<>
        <IconButton icon="chevron-left" size="xs" tooltip={tr("doc.pdfPreviousPage")}
          accessibilityLabel="file-pdf-previous" disabled={!ready() || page() <= 1} onPress={() => changeView(page() - 1)} />
        <View style={{ width: 44 }}>
          <InputBox value={pageDraft() ?? String(page())} onChange={pageDraft.set} size="sm" content="number"
            disabled={!ready()} accessibilityLabel="file-pdf-page" onSubmit={jump} />
        </View>
        <Text accessibilityLabel="file-pdf-count" style={textStyle("caption", { color: palette().textMuted, tabular: true })}>
          {count() ? `/ ${formatCount(count())}` : ""}
        </Text>
        <IconButton icon="chevron-right" size="xs" tooltip={tr("doc.pdfNextPage")}
          accessibilityLabel="file-pdf-next" disabled={!ready() || page() >= count()} onPress={() => changeView(page() + 1)} />
        <ToolbarSeparator />
        <IconButton icon="minus" size="xs" tooltip={tr("files.zoomOut")} accessibilityLabel="file-pdf-zoom-out"
          disabled={!ready() || scale() <= 0.25} onPress={() => stepZoom(-1)} />
        <View ref={node => zoomAnchor.set(node)}>
          <Button label={zoomLabel()} size="xs" variant="ghost" disabled={!ready()}
            accessibilityLabel="file-pdf-zoom" onPress={() => zoomMenu.set(!zoomMenu())} />
          <DropdownMenu open={zoomMenu()} anchor={zoomAnchor()} placement="bottom" align="end"
            minWidth={130} maxHeight={300} items={zoomItems()} onClose={() => zoomMenu.set(false)} />
        </View>
        <IconButton icon="plus" size="xs" tooltip={tr("files.zoomIn")} accessibilityLabel="file-pdf-zoom-in"
          disabled={!ready() || scale() >= 4} onPress={() => stepZoom(1)} />
        <ToolbarSeparator />
        <IconButton icon="maximize" size="xs" tooltip={tr("doc.pdfFitWidth")} active={requestedZoom() === null}
          accessibilityLabel="file-pdf-fit" disabled={!ready()} onPress={() => zoomTo(null)} />
        <IconButton icon="rotate-cw" size="xs" tooltip={tr("files.rotateImage")} accessibilityLabel="file-pdf-rotate"
          disabled={!ready()} onPress={() => { rotation.set((rotation() + 90) % 360); changeView(); }} />
      </>} />
    <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      <If when={html() && status() !== "failed"}>
        <WebView ref={ref => { frame = ref; }} html={html()} incognito accessibilityLabel="file-pdf-view"
          onLoad={event => {
            if (isWeb || !installScript || sentBytes || disposed) return;
            const url = event.url;
            if (url && url !== "about:blank" && url !== "about:srcdoc" && !url.startsWith("data:text/html")) return;
            frame?.injectJavaScript(installScript);
          }}
          onMessage={event => onMessage(event.data)} onError={event => failed(event.code ?? event.message)}
          style={{ flex: 1, minWidth: 0, minHeight: 0, visibility: props.hideSurface ? "hidden" : "visible",
            pointerEvents: props.blockInput || props.hideSurface || !ready() ? "none" : "auto" }} />
      </If>
      <If when={!ready()}>
        <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center",
          justifyContent: "center", padding: space.lg, gap: space.sm, backgroundColor: palette().canvas }}>
          <If when={status() === "loading"}>
            <Spinner size={18} />
            <Text style={textStyle("body", { color: palette().textMuted })}>{tr("doc.pdfLoading")}</Text>
          </If>
          <If when={status() === "failed"}>
            <EmptyStateCard icon="file-text" title={props.name} subtitle={tr("doc.pdfUnavailable")} />
          </If>
          <If when={status() === "password"}>
            <View style={{ width: "100%", maxWidth: 320, gap: space.sm }}>
              <Text style={textStyle("body", { color: palette().text })}>
                {tr(incorrectPassword() ? "doc.pdfIncorrectPassword" : "doc.pdfPassword")}
              </Text>
              <InputBox value={password()} onChange={password.set} masked
                accessibilityLabel="file-pdf-password" onSubmit={unlock} />
              <Button label={tr("doc.pdfUnlock")} variant="primary" size="sm" disabled={!password()}
                accessibilityLabel="file-pdf-unlock" onPress={unlock} />
            </View>
          </If>
        </View>
      </If>
      <If when={ready() && pageError() === page()}>
        <Text style={{ ...textStyle("caption", { color: palette().warning }), padding: space.sm }}>
          {tr("doc.pdfPageUnavailable")}
        </Text>
      </If>
    </View>
  </View>;
}
