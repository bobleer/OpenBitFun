// Markdown documents: the rendered preview and the visual (WYSIWYG) editor that
// the Files pane, the assistant persona documents and other Markdown surfaces
// share.
//
// - `MarkdownPreview` uses `TextView` for workspace-aware images and links and
//   for inline math. Mermaid and display math use a web view when available.
//   The source stays visible as code if the renderer cannot draw.
// - `MarkdownDocumentEditor` is NSH's native `RichEditor` (a ProseMirror/Tiptap
//   kernel) over the file's Markdown: parsed once when it opens, serialized on
//   every change and handed back as text, so the caller saves exactly what it
//   saves for the source editor (`write_file_content` and its conflict check).
// - `visualEditBlock` is the fidelity guard: a file the visual editor cannot
//   write back unchanged (front matter, raw HTML, reference links, ...) opens
//   as source, and the caller says why. It reads only the file's text.
//
// Inline AI asks the document's device through `editorAiStore.ts`.

import { cleanup, Clipboard, computed, effect, keymap, openUrl, Overlay, platform, Scroll, signal, Text, untracked, View, WebView, type JSX, type Point, type ViewRef, type WebViewRef } from "nsh";
import {
  chain,
  createRichEditor,
  Input,
  insertContent,
  insertText,
  RichEditor,
  RichEditorPlugin,
  RichImage,
  RichTable,
  RichTableCell,
  RichTableHeader,
  RichTableRow,
  selectAll,
  scrollIntoView,
  setTextSelection,
  StarterKit,
  TextView,
  type RichEditorSession,
  type RichEditorStyles,
  type RichExtension,
  type RichExtensionClass,
  type RichNodeJSON,
  type RichNodeViewProps,
  type TextViewBlock,
  type TextViewCustomNode,
  type TextViewImage,
  type TextViewLinkPressEvent,
} from "nsh/base";
import {
  askInlineAi,
  cancelInlineAi,
  closeInlineAiComposer,
  finishInlineAi,
  inlineAi,
  inlineAiComposer,
  inlineAiMarkdown,
  openInlineAiComposer,
  type InlineAiIntent,
} from "../editorAiStore";
import { windowShellId } from "../bridge";
import { currentLocale, localizeHostError, tr } from "../i18n";
import {
  cjkTypography,
  fontMono,
  fontSans,
  layout,
  palette,
  radii,
  resolvedAppearanceId,
  resolvedScheme,
  space,
  textLineHeight,
  textSize,
  textStyle,
  textTracking,
  typeScale,
  uiFontBasePx,
  type Palette,
} from "../theme";
import {
  MARKDOWN_MEDIA_EXTENSION,
  MarkdownImageView,
  MarkdownMediaEmbed,
  openMarkdownImageInLightbox,
  transformEmbeddedMediaMarkdown,
} from "./markdownMedia";
import { activeWorkspace, activeWorkspaceRoot, deviceContext, openInAuxPane } from "../state";
import { isRemoteWorkspace } from "../shared/workspaceUtils";
import { Icon } from "./icons";
import {
  createMarkdownCodeActions,
  createMarkdownStyles,
  resolveWorkspaceMarkdownLink,
  STATIC_MARKDOWN_OPTIONS,
} from "./markdown";
import { MOTION_DURATION, paintTransition, popoverEnterMotion, pressTransition, rotatingChevronStyle, Spinner, tactileActiveStyle } from "./motion";
import { menuSurfaceStyle, ModalDialog, pushToast, registerEscapeDismiss } from "./overlays";
import { Button, focusRingStyle, IconButton, InputBox, SegmentedTabs, type SegmentedTabOption } from "./primitives";
import { Toolbar } from "./Toolbar";
import { rendererAssets } from "../documentRenderers";
import { readRendererAsset, resolveBrowserAsset } from "./documentRendererAssets";
import { MarkdownDocumentImage, type MarkdownImageWorkspace } from "./markdownDocumentImage";

export type MarkdownDocumentMode = "preview" | "visual" | "source";

export async function copyDocumentMarkdown(markdown: string): Promise<void> {
  try {
    await Clipboard.writeText(markdown);
    pushToast(tr("files.copied"), "success");
  } catch (error) {
    pushToast(localizeHostError(error), "error");
  }
}

export function MarkdownDocumentToolbar(props: {
  mode: MarkdownDocumentMode;
  onModeChange: (mode: MarkdownDocumentMode) => void;
  markdown: string;
  copyDisabled?: boolean;
  sourceOnly?: boolean;
  ids: Record<MarkdownDocumentMode | "copy", string>;
}) {
  const options = (): SegmentedTabOption<MarkdownDocumentMode>[] => {
    const modes: SegmentedTabOption<MarkdownDocumentMode>[] = [
      { value: "preview", label: tr("common.preview"), accessibilityLabel: props.ids.preview },
    ];
    if (!props.sourceOnly) {
      modes.push({ value: "visual", label: tr("doc.richText"), accessibilityLabel: props.ids.visual });
    }
    modes.push({ value: "source", label: tr(props.sourceOnly ? "files.editAnyway" : "doc.source"),
      accessibilityLabel: props.ids.source });
    return modes;
  };


  return <Toolbar size="sm"
    leading={<SegmentedTabs size="sm" options={options()} value={props.mode} onChange={props.onModeChange} />}
    trailing={<IconButton icon="copy" size="sm" tooltip={tr("doc.copyMarkdown")} accessibilityLabel={props.ids.copy}
      disabled={props.copyDisabled} onPress={() => void copyDocumentMarkdown(props.markdown)} />} />;
}

// ── Frontmatter splitting & Markdown analysis ──────────────────────────────

export interface MarkdownFrontmatterSplit {
  /** Exact leading YAML frontmatter block including delimiters and trailing gap, or `""`. */
  frontmatter: string;
  /** The Markdown body following the frontmatter. */
  body: string;
  /** The YAML content inside the `---` delimiters. */
  yaml: string;
  /** The exact whitespace/newlines between the closing `---` and `body`. */
  separator: string;
  /** Line ending used by the frontmatter block. */
  eol: "\r\n" | "\n";
}

const FRONTMATTER_RE = /^---(\r?\n)([\s\S]*?)\r?\n---([ \t]*(?:\r?\n)*)/;

/**
 * Splits a leading YAML frontmatter block (`---\n...\n---`) from the Markdown
 * body without altering a single byte (`frontmatter + body === text`).
 */
export function splitFrontmatter(text: string): MarkdownFrontmatterSplit {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return { frontmatter: "", body: text, yaml: "", separator: "", eol: "\n" };
  }
  const eol: "\r\n" | "\n" = match[1] === "\r\n" ? "\r\n" : "\n";
  const yaml = match[2];
  const separator = match[3] ?? "";
  // Confirm the block is YAML metadata, not a horizontal rule followed by prose.
  const lines = yaml.split(/\r?\n/);
  let hasKey = false;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^[ \t]/.test(line)) continue;
    if (/^[A-Za-z0-9_.-]+[ \t]*:/.test(line)) {
      hasKey = true;
      continue;
    }
    return { frontmatter: "", body: text, yaml: "", separator: "", eol: "\n" };
  }
  if (!hasKey) {
    return { frontmatter: "", body: text, yaml: "", separator: "", eol: "\n" };
  }
  const frontmatter = match[0];
  return { frontmatter, body: text.slice(frontmatter.length), yaml, separator, eol };
}

function frontmatterSummary(yaml: string): string {
  const pairs: string[] = [];
  for (const raw of yaml.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(raw);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    pairs.push(value ? `${key}: ${value}` : key);
    if (pairs.length >= 2) break;
  }
  return pairs.join(" · ");
}

interface MarkdownSyntaxScan {
  hasLossySyntax: boolean;
  hasRichBlocks: boolean;
  linkDestinations: string[];
}

/** Strips inline code spans so syntax checks ignore code examples like `` `<div>` ``. */
function stripInlineCode(line: string): string {
  return line.replace(/(`+)([^`]*?)\1/g, " ");
}

/**
 * Scans Markdown outside fenced code blocks and inline code for:
 * - truly lossy constructs that `RichEditor` escapes or drops (raw HTML tags/comments,
 *   reference-style links/definitions, footnotes, GitHub callout alerts);
 * - rich preview blocks (` ```mermaid ` fences, display math `$$...$$`) that
 *   `MarkdownPreview` renders as interactive SVG/KaTeX web view islands.
 */
function scanMarkdownSyntax(body: string): MarkdownSyntaxScan {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  let inMathFence = false;
  let hasLossySyntax = false;
  let hasRichBlocks = false;
  const linkDestinations: string[] = [];

  for (const line of lines) {
    if (fenceChar) {
      const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
      if (closeRe.test(line)) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }

    const fenceOpen = /^[ \t]{0,3}(`{3,}|~{3,})([ \t]*([^\s`~]*))?/.exec(line);
    if (fenceOpen) {
      fenceChar = fenceOpen[1][0] as "`" | "~";
      fenceLen = fenceOpen[1].length;
      const lang = (fenceOpen[3] ?? "").toLowerCase();
      if (lang === "mermaid") hasRichBlocks = true;
      continue;
    }

    if (/^[ \t]{0,3}\$\$[ \t]*$/.test(line)) {
      inMathFence = !inMathFence;
      hasRichBlocks = true;
      continue;
    }
    if (inMathFence) continue;
    if (/^[ \t]{0,3}\$\$[^\n$]+\$\$[ \t]*$/.test(line)) {
      hasRichBlocks = true;
      continue;
    }

    // GitHub-style alerts (`> [!NOTE]`) are escaped by RichEditor's serializer.
    if (/^[ \t]*>[ \t]*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s|$)/i.test(line)) {
      hasLossySyntax = true;
    }
    // Reference link definitions (`[id]: https://...`) and footnote definitions (`[^1]: ...`).
    if (/^[ \t]{0,3}\[[^\]]+\]:[ \t]+\S/.test(line)) {
      hasLossySyntax = true;
    }

    const plain = stripInlineCode(line);
    // Footnote references (`[^1]`).
    if (/\[\^[^\]]+\]/.test(plain)) {
      hasLossySyntax = true;
    }
    // Full or collapsed reference links (`[text][ref]` or `[text][]`).
    if (/\[[^\]\n]+\]\[[^\]\n]*\]/.test(plain)) {
      hasLossySyntax = true;
    }
    // Raw HTML comments or tags (skipping autolinks like `<https://...>` and `<a@b.c>`).
    if (/<!--/.test(plain) || /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[\s/][^>\n]*)?>/.test(plain)) {
      hasLossySyntax = true;
    }

    // Collect simple inline link destinations so round-trip verification catches any dropped URL.
    const linkRe = /\]\(([^\s()]+)(?:\s+["'][^"']*["'])?\)/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(plain)) !== null) {
      linkDestinations.push(m[1]);
    }
  }

  return { hasLossySyntax, hasRichBlocks, linkDestinations };
}

/** Whether the document contains Mermaid diagrams or display math (`$$...$$`) islands. */
export function hasRichPreviewBlocks(text: string): boolean {
  const { body } = splitFrontmatter(text);
  return scanMarkdownSyntax(body).hasRichBlocks;
}

// ── The visual editor's schema and the fidelity guard ──────────────────────

/** Paragraphs, headings, lists, task lists, quotes, code, rules, images, links, marks and tables. */
function markdownExtensions(
  renderImage?: (image: TextViewImage) => JSX.Element,
  imageView?: (props: RichNodeViewProps) => JSX.Element,
): Array<RichExtension | RichExtensionClass> {
  if (!renderImage && !imageView) {
    return [StarterKit, RichTable, RichTableRow, RichTableHeader, RichTableCell];
  }
  const WorkspaceImage = RichImage.extend({
    addNodeView: () => imageView ?? (nodeProps => renderImage!(imageAttributes(nodeProps))),
  });
  return [
    StarterKit.configure({ image: false }),
    WorkspaceImage,
    RichTable,
    RichTableRow,
    RichTableHeader,
    RichTableCell,
  ];
}

function createMarkdownSession(
  text: string,
  renderImage?: (image: TextViewImage) => JSX.Element,
  imageView?: (props: RichNodeViewProps) => JSX.Element,
  plugins?: RichEditorPlugin[],
): RichEditorSession {
  return createRichEditor({
    content: text,
    format: "markdown",
    extensions: markdownExtensions(renderImage, imageView),
    plugins,
  });
}

let visualEditorProbe: boolean | null = null;

/** Whether this client has the rich text kernel (checked once). */
export function visualEditorAvailable(): boolean {
  if (visualEditorProbe !== null) return visualEditorProbe;
  try {
    const probe = createMarkdownSession("# probe\n");
    probe.dispose();
    visualEditorProbe = true;
  } catch {
    visualEditorProbe = false;
  }
  return visualEditorProbe;
}

/** Text compared for clean-state/undo checks: line endings, BOM, trailing whitespace and extra blank runs outside fenced code blocks do not count. */
function normalizeMarkdown(text: string): string {
  let value = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  value = value.replace(/\r\n?/g, "\n");
  const lines = value.split("\n").map(line => line.replace(/[ \t]+$/, ""));
  const out: string[] = [];
  let inFence = false;
  let blankRun = 0;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      blankRun = 0;
      out.push(line);
      continue;
    }
    if (!inFence && line === "") {
      blankRun += 1;
      if (blankRun <= 1) out.push(line);
      continue;
    }
    blankRun = 0;
    out.push(line);
  }
  return out.join("\n").replace(/\n+$/, "");
}

/** Whether two Markdown texts are the same document byte for byte, but for whitespace at line ends. */
export function sameMarkdown(left: string, right: string): boolean {
  return left === right || normalizeMarkdown(left) === normalizeMarkdown(right);
}

const fidelityCache = new Map<string, boolean>();

/**
 * Whether the visual editor can edit `text` without losing or corrupting content.
 *
 * Benign formatting canonicalization (`*` vs `-` bullets, `_italic_` vs `*italic*`,
 * nested list blank lines, tight table spacing, heading spacing) is allowed because
 * untouched documents never emit edits and edited documents keep full semantics.
 * YAML frontmatter is split and preserved verbatim outside the rich editor.
 * Genuinely lossy constructs (raw HTML, reference links, footnotes, GitHub alerts,
 * or round-trip URL/HTML corruption) are blocked so the source stays safe.
 */
export function visualEditKeepsText(text: string): boolean {
  const cached = fidelityCache.get(text);
  if (cached !== undefined) return cached;
  let keeps = false;
  try {
    const { body } = splitFrontmatter(text);
    const scan = scanMarkdownSyntax(body);
    if (!scan.hasLossySyntax) {
      const session = createMarkdownSession(body);
      const out = session.getMarkdown();
      session.dispose();
      const nonEmptyDropped = body.trim().length > 0 && out.trim().length === 0;
      const escapedHtmlAdded = /\\<[a-zA-Z!/]/.test(out) && !/\\<[a-zA-Z!/]/.test(body);
      const linksPreserved = scan.linkDestinations.every(dest => out.includes(dest));
      keeps = !nonEmptyDropped && !escapedHtmlAdded && linksPreserved;
    }
  } catch {
    keeps = false;
  }
  if (fidelityCache.size > 64) fidelityCache.clear();
  fidelityCache.set(text, keeps);
  return keeps;
}

/** Why a document opens as source instead of in the visual editor, or `null` when it need not. */
export type VisualEditBlock = "unavailable" | "fidelity";

export function visualEditBlock(text: string): VisualEditBlock | null {
  if (!visualEditorAvailable()) return "unavailable";
  return visualEditKeepsText(text) ? null : "fidelity";
}

/** The one muted line a surface shows when a document opens as source on its own. */
export function visualEditBlockMessage(block: VisualEditBlock): string {
  return block === "unavailable" ? tr("doc.visualUnavailable") : tr("doc.sourceFallback");
}

export function VisualEditNotice(props: { block: VisualEditBlock; inset?: number }) {
  return (
    <View
      style={{
        paddingHorizontal: props.inset ?? space.md,
        paddingVertical: space.xs,
        borderBottomWidth: 1,
        borderColor: palette().borderSubtle,
      }}
    >
      <Text accessibilityLabel="doc-source-fallback" style={textStyle("caption")}>
        {visualEditBlockMessage(props.block)}
      </Text>
    </View>
  );
}

// ── Diagrams and formulas ──────────────────────────────────────────────────

/**
 * The renderers ship with the app as assets (`assets/vendor`, pinned and
 * unchanged from their npm packages; KaTeX's fonts are inlined into its
 * stylesheet), registered by the app's entry (`documentRenderers.ts`): read
 * only when a document has a diagram or a formula, then kept for the session.
 * A browser gets the same files through the device's UI bundle. The island's
 * page loads nothing from anywhere (its content security policy allows inline
 * code, inline styles and data: fonts only).
 */
function rendererFiles(kind: IslandKind): { script: string; style: string | null } | null {
  const assets = rendererAssets();
  if (!assets) return null;
  return kind === "math"
    ? { script: assets.katexScript, style: assets.katexStyle }
    : { script: assets.mermaidScript, style: null };
}

interface IslandRenderer {
  script: string;
  style: string;
  browser?: { scriptUrl: string; bootstrapUrl: string };
}

interface CachedDiagramSvg {
  svg: string;
  height: number;
}

const MAX_CACHED_SVG_DIAGRAMS = 32;
const MAX_CONCURRENT_MERMAID_ISLANDS = 2;
const MERMAID_SCRIPT_EVICT_MS = 2000;

const renderedSvgCache = new Map<string, CachedDiagramSvg>();
const rendererLoads = new Map<IslandKind, Promise<IslandRenderer>>();
let activeMermaidCompiles = 0;
let mermaidEvictTimer: ReturnType<typeof setTimeout> | null = null;
const mermaidSlotWaiters: Array<() => void> = [];

function cacheDiagramSvg(key: string, entry: CachedDiagramSvg): void {
  if (renderedSvgCache.has(key)) renderedSvgCache.delete(key);
  renderedSvgCache.set(key, entry);
  if (renderedSvgCache.size > MAX_CACHED_SVG_DIAGRAMS) {
    const oldest = renderedSvgCache.keys().next().value;
    if (oldest !== undefined) renderedSvgCache.delete(oldest);
  }
}

function acquireMermaidSlot(onReady: () => void): () => void {
  if (activeMermaidCompiles < MAX_CONCURRENT_MERMAID_ISLANDS) {
    activeMermaidCompiles += 1;
    if (mermaidEvictTimer) {
      clearTimeout(mermaidEvictTimer);
      mermaidEvictTimer = null;
    }
    onReady();
    return () => releaseMermaidSlot();
  }
  let granted = false;
  const waiter = () => {
    granted = true;
    activeMermaidCompiles += 1;
    if (mermaidEvictTimer) {
      clearTimeout(mermaidEvictTimer);
      mermaidEvictTimer = null;
    }
    onReady();
  };
  mermaidSlotWaiters.push(waiter);
  return () => {
    if (granted) {
      releaseMermaidSlot();
      return;
    }
    const idx = mermaidSlotWaiters.indexOf(waiter);
    if (idx >= 0) mermaidSlotWaiters.splice(idx, 1);
  };
}

function releaseMermaidSlot(): void {
  activeMermaidCompiles = Math.max(0, activeMermaidCompiles - 1);
  const next = mermaidSlotWaiters.shift();
  if (next) {
    next();
    return;
  }
  if (activeMermaidCompiles === 0 && rendererLoads.has("mermaid")) {
    if (mermaidEvictTimer) clearTimeout(mermaidEvictTimer);
    mermaidEvictTimer = setTimeout(() => {
      mermaidEvictTimer = null;
      if (activeMermaidCompiles === 0) rendererLoads.delete("mermaid");
    }, MERMAID_SCRIPT_EVICT_MS);
  }
}

/** Text that cannot end or comment out the inline `<script>` / `<style>` element it goes into. */
function inlineSafe(text: string): string {
  return text.replace(/<\/(script|style)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function loadRenderer(kind: IslandKind): Promise<IslandRenderer> {
  let load = rendererLoads.get(kind);
  if (!load) {
    const assets = rendererFiles(kind);
    if (!assets) return Promise.reject(new Error("this app registered no document renderers"));
    const styleLoad = assets.style ? readRendererAsset(assets.style) : Promise.resolve("");
    const bootstrap = rendererAssets()?.browserBootstrap;
    load = platform.os === "web" && bootstrap
      ? Promise.all([resolveBrowserAsset(assets.script), resolveBrowserAsset(bootstrap), styleLoad])
        .then(([scriptUrl, bootstrapUrl, style]) => ({ script: "", style, browser: { scriptUrl, bootstrapUrl } }))
      : Promise.all([readRendererAsset(assets.script), styleLoad]).then(([script, style]) => ({ script, style }));
    // A failed read is tried again by the next island, not remembered.
    load.catch(() => rendererLoads.delete(kind));
    rendererLoads.set(kind, load);
  }
  return load;
}

/** How long an island may take to draw after its renderer assets are ready. */
const ISLAND_TIMEOUT_MS = 8000;

type IslandKind = "mermaid" | "math";

const ISLAND_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:";
const STATIC_SVG_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** A JSON literal that is safe inside a `<script>` element. */
function scriptLiteral(value: string | object): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function staticSvgIslandHtml(svg: string, colors: { text: string; background: string }): string {
  const style =
    `<style>html,body{margin:0;padding:0;background:${colors.background};color:${colors.text};` +
    `font-family:-apple-system,system-ui,sans-serif;overflow:hidden}#out{display:flex;justify-content:center}` +
    `#out svg{max-width:100%;height:auto}</style>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${STATIC_SVG_CSP}">` +
    `${style}</head><body><div id="out">${svg}</div></body></html>`
  );
}

/** Keep the HTML under WebView2's 2 MiB NavigateToString limit, including UTF-16 and the shell. */
const MAX_INLINE_ISLAND_UNITS = 1024 * 1024 - 8192;
const ISLAND_OUTPUT_ID = "openbitfun-document-renderer";

function mermaidAppearance() {
  const p = palette();
  return {
    theme: "base",
    startOnLoad: false,
    securityLevel: "strict",
    themeVariables: {
      darkMode: resolvedScheme() === "dark",
      fontFamily: "system-ui, sans-serif",
      fontSize: `${textSize(typeScale.label)}px`,
      primaryColor: p.surfaceTertiary,
      primaryTextColor: p.text,
      primaryBorderColor: p.borderStrong,
      secondaryColor: p.panelHover,
      secondaryTextColor: p.text,
      secondaryBorderColor: p.accent,
      tertiaryColor: p.canvasSubtle,
      tertiaryTextColor: p.textSecondary,
      tertiaryBorderColor: p.border,
      lineColor: p.textMuted,
      textColor: p.text,
      clusterBkg: p.canvasSubtle,
      clusterBorder: p.border,
      edgeLabelBackground: p.surfaceElevated,
      actorBkg: p.surfaceTertiary,
      actorBorder: p.borderStrong,
      actorTextColor: p.text,
      actorLineColor: p.textMuted,
      signalColor: p.textMuted,
      signalTextColor: p.text,
      noteBkgColor: p.warningSoft,
      noteBorderColor: p.warning,
      noteTextColor: p.text,
      pie1: p.accent,
      pie2: p.success,
      pie3: p.warning,
      pie4: p.danger,
    },
  };
}

function islandDrawScript(kind: IslandKind, source: string): string {
  const draw = kind === "math"
    ? `try{katex.render(${scriptLiteral(source)},output(),{displayMode:true,throwOnError:true});done()}catch(e){fail()}`
    : `try{mermaid.initialize(${scriptLiteral(mermaidAppearance())});` +
      `mermaid.render('d',${scriptLiteral(source)}).then(function(r){var o=output();o.innerHTML=r.svg;` +
      `var h=Math.ceil(o.getBoundingClientRect().height);post('svg:'+h+':'+r.svg);post('h:'+h)}).catch(fail)}catch(e){fail()}`;
  return `if(typeof ${kind === "math" ? "katex" : "mermaid"}==='undefined'){fail()}else{${draw}}`;
}

function islandHtml(
  renderer: IslandRenderer,
  colors: { text: string; background: string },
  input: { kind: IslandKind; source: string },
  injectScript: boolean,
): string {
  const style =
    `<style>html,body{margin:0;padding:0;background:${colors.background};color:${colors.text};` +
    `font-family:-apple-system,system-ui,sans-serif;overflow:hidden}#${ISLAND_OUTPUT_ID}{display:flex;justify-content:center}` +
    `#${ISLAND_OUTPUT_ID} svg{max-width:100%;height:auto}</style>`;
  const report =
    `function output(){return document.getElementById('${ISLAND_OUTPUT_ID}')}` +
    "function post(m){try{window.nsh&&window.nsh.postMessage(m)}catch(e){}}" +
    "function fail(){post('error')}" +
    "function done(){post('h:'+Math.ceil(output().getBoundingClientRect().height))}" +
    "window.addEventListener('error',function(){fail()});";
  if (renderer.browser) {
    const { scriptUrl, bootstrapUrl } = renderer.browser;
    // `srcdoc` has an opaque origin. Grant the bundle's origin explicitly and
    // use external scripts so the embedding page's strict CSP also allows them.
    const origin = escapeAttr(new URL(scriptUrl).origin);
    const csp = `default-src 'none'; script-src ${origin}; style-src 'unsafe-inline'; font-src data:; img-src data:`;
    const config = input.kind === "mermaid" ? mermaidAppearance() : undefined;
    const data = escapeAttr(JSON.stringify({ ...input, config }));
    return `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `${renderer.style ? `<style>${inlineSafe(renderer.style)}</style>` : ""}${style}</head>` +
      `<body><div id="${ISLAND_OUTPUT_ID}" data-diagram="${data}"></div>` +
      `<script src="${escapeAttr(scriptUrl)}"></script><script src="${escapeAttr(bootstrapUrl)}"></script></body></html>`;
  }
  const scriptTag = injectScript ? "" : `<script>${inlineSafe(renderer.script)}</script>`;
  const drawTag = injectScript ? "" : `<script>${islandDrawScript(input.kind, input.source)}</script>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${ISLAND_CSP}">` +
    `${renderer.style ? `<style>${inlineSafe(renderer.style)}</style>` : ""}${style}<script>${report}</script>` +
    `${scriptTag}</head><body><div id="${ISLAND_OUTPUT_ID}"></div>` +
    `${drawTag}</body></html>`
  );
}

/** Whether this client shows web views (checked once; `null` while it checks). */
const islandsAvailable = signal<boolean | null>(null);
let islandsProbe: Promise<void> | null = null;

function probeIslands(): void {
  if (islandsProbe) return;
  // The desktop app grants its web views (`src/apps/desktop-nsh/nsh.json`); a
  // web engine that still fails reports `onError`, and the island falls back.
  if (windowShellId() === "nsh-desktop") {
    islandsProbe = Promise.resolve();
    islandsAvailable.set(true);
    return;
  }
  islandsProbe = WebView.available()
    .then(shows => islandsAvailable.set(Boolean(shows)))
    .catch(() => islandsAvailable.set(false));
}

/** Whether this client shows web views (`null` while it checks): diagrams, HTML and PDF previews need one. */
export function documentWebViewsAvailable(): boolean | null {
  probeIslands();
  return islandsAvailable();
}

/** The source of a diagram or formula, as the code it is (the island's fallback). */
function IslandSource(props: { source: string; kind: IslandKind }) {
  return (
    <View
      accessibilityLabel={`doc-${props.kind}-source`}
      style={{
        alignSelf: "stretch",
        padding: space.md,
        borderRadius: radii.md,
        backgroundColor: palette().surfaceTertiary,
      }}
    >
      <Text style={{ ...textStyle("monoBlock"), userSelect: "text" }}>{props.source}</Text>
    </View>
  );
}

/**
 * A diagram or display formula drawn in a web view, sized to what it drew.
 * Until it draws (the renderer read, the page run) the source shows; after
 * `ISLAND_TIMEOUT_MS` without a drawing, or on any failure, the source stays.
 */
function DiagramIsland(props: { kind: IslandKind; source: string; sourceVisible?: boolean }) {
  probeIslands();
  const height = signal(0);
  const failed = signal(false);
  const renderer = signal<IslandRenderer | null>(null);
  const cachedSvg = signal<CachedDiagramSvg | null>(null);
  let disposed = false;
  let releaseSlot: (() => void) | null = null;
  const freeSlot = () => {
    if (releaseSlot) {
      releaseSlot();
      releaseSlot = null;
    }
  };
  cleanup(() => {
    disposed = true;
    freeSlot();
    renderer.set(null);
  });

  const cacheKey = () => `${props.kind}:${resolvedAppearanceId()}:${textSize(typeScale.label)}:${props.source}`;
  const renderContent = () => islandsAvailable() === true && !failed() ? (cachedSvg() ?? renderer()) : null;

  effect(() => {
    const kind = props.kind;
    void props.source;
    const key = cacheKey();
    const hit = kind === "mermaid" ? renderedSvgCache.get(key) ?? null : null;
    if (hit) {
      freeSlot();
      cachedSvg.set(hit);
      renderer.set(null);
      height.set(hit.height);
      failed.set(false);
      return;
    }
    cachedSvg.set(null);
    height.set(0);
    failed.set(false);
  });

  effect(() => {
    void cacheKey();
    if (!renderer() || cachedSvg() || failed()) return;
    const timer = setTimeout(() => {
      if (!disposed && height() === 0 && !cachedSvg()) {
        freeSlot();
        renderer.set(null);
        failed.set(true);
      }
    }, ISLAND_TIMEOUT_MS);
    cleanup(() => clearTimeout(timer));
  });

  effect(() => {
    const kind = props.kind;
    if (islandsAvailable() !== true || cachedSvg()) return;
    untracked(() => {
      if (renderer()) return;
      const startLoad = () => {
        loadRenderer(kind)
          .then(loaded => {
            if (!disposed && !cachedSvg()) renderer.set(loaded);
            else freeSlot();
          })
          .catch(() => {
            freeSlot();
            if (!disposed) failed.set(true);
          });
      };
      if (kind === "mermaid") {
        releaseSlot = acquireMermaidSlot(() => {
          if (!disposed && !cachedSvg()) startLoad();
          else freeSlot();
        });
      } else {
        startLoad();
      }
    });
  });

  return <>
    <If when={renderContent()}>
      {() => {
        const hit = cachedSvg();
        if (hit) {
          return (
            <WebView
              accessibilityLabel={`doc-${props.kind}-view`}
              html={staticSvgIslandHtml(hit.svg, { text: palette().text, background: palette().canvas })}
              javaScriptEnabled={false}
              scrollable={false}
              incognito={true}
              style={{ alignSelf: "stretch", height: Math.max(hit.height, space.x4l) }}
              onError={() => {
                cachedSvg.set(null);
                failed.set(true);
              }}
            />
          );
        }
        const loaded = renderer()!;
        let view: WebViewRef | undefined;
        const draw = () => islandDrawScript(props.kind, props.source);
        const injectScript = () => platform.os === "windows" &&
          loaded.script.length + loaded.style.length + draw().length > MAX_INLINE_ISLAND_UNITS;
        return (
          <WebView
            ref={ref => { view = ref; }}
            accessibilityLabel={`doc-${props.kind}-view`}
            html={islandHtml(
              loaded,
              { text: palette().text, background: palette().canvas },
              { kind: props.kind, source: props.source },
              injectScript(),
            )}
            scrollable={false}
            incognito={true}
            style={{ alignSelf: "stretch", height: Math.max(height(), space.x4l) }}
            onLoad={event => {
              if (!injectScript() || disposed || renderer() !== loaded || cachedSvg()) return;
              const url = event.url;
              if (url && url !== "about:blank" && url !== "about:srcdoc" && !url.startsWith("data:text/html")) return;
              view?.injectJavaScript(
                `if (document.getElementById('${ISLAND_OUTPUT_ID}')) {\n${loaded.script}\n;\n${draw()}\n}`,
              );
            }}
            onMessage={event => {
              const data = String(event.data ?? "");
              if (data === "error") {
                freeSlot();
                renderer.set(null);
                failed.set(true);
                return;
              }
              if (props.kind === "mermaid" && data.startsWith("svg:")) {
                const secondColon = data.indexOf(":", 4);
                if (secondColon > 4) {
                  const h = Math.max(1, Number(data.slice(4, secondColon)) || space.x4l);
                  const svg = data.slice(secondColon + 1);
                  if (svg.includes("<svg")) {
                    const entry = { svg, height: h };
                    cacheDiagramSvg(cacheKey(), entry);
                    height.set(h);
                    cachedSvg.set(entry);
                    renderer.set(null);
                    freeSlot();
                    return;
                  }
                }
              }
              const match = /^h:(\d+)/.exec(data);
              if (match) height.set(Math.max(1, Number(match[1])));
            }}
            onError={() => {
              freeSlot();
              renderer.set(null);
              failed.set(true);
            }}
          />
        );
      }}
    </If>
    <If when={props.kind === "mermaid" && failed() && islandsAvailable() === true && Boolean(rendererAssets())}>
      <Text accessibilityLabel="doc-mermaid-render-failed"
        style={{ ...textStyle("caption", { color: palette().warning }), padding: space.md }}>
        {tr("doc.mermaidRenderFailed")}
      </Text>
    </If>
    <If when={!renderContent() || props.sourceVisible === true}>
      <IslandSource kind={props.kind} source={props.source} />
    </If>
  </>;
}

export const MERMAID_MARKDOWN_EXTENSIONS = [{ name: "mermaid", language: "mermaid" }];

function MermaidMarkdownBlock(props: { source: string }) {
  const sourceVisible = signal(false);
  async function copySource() {
    try {
      await Clipboard.writeText(props.source);
      pushToast(tr("files.copied"), "success");
    } catch (error) {
      pushToast(localizeHostError(error), "error");
    }
  }
  return (
    <View style={{ alignSelf: "stretch", overflow: "hidden", borderRadius: radii.md,
      borderWidth: 1, borderColor: palette().borderSubtle }}>
      <Toolbar size="sm"
        leading={<Text style={textStyle("caption", { color: palette().textSecondary })}>{tr("doc.mermaidDiagram")}</Text>}
        trailing={<>
          <If when={documentWebViewsAvailable() !== false && Boolean(rendererAssets())}>
            <IconButton icon="code" size="sm" active={sourceVisible()}
              tooltip={tr(sourceVisible() ? "doc.mermaidHideSource" : "doc.mermaidShowSource")}
              accessibilityLabel="doc-mermaid-toggle-source"
              onPress={() => sourceVisible.update(value => !value)} />
          </If>
          <IconButton icon="copy" size="sm" tooltip={tr("common.copyCode")}
            accessibilityLabel="doc-mermaid-copy-source" onPress={() => void copySource()} />
        </>} />
      <DiagramIsland kind="mermaid" source={props.source} sourceVisible={sourceVisible()} />
    </View>
  );
}

const MARKDOWN_PREVIEW_EXTENSIONS = [
  { name: "mermaid", language: "mermaid" },
  MARKDOWN_MEDIA_EXTENSION,
];
export function renderMarkdownDiagram(node: TextViewCustomNode): JSX.Element {
  return node.name === "mermaid"
    ? <MermaidMarkdownBlock source={node.text ?? ""} />
    : <Text style={textStyle("body")}>{node.text ?? ""}</Text>;
}

export interface MarkdownPreviewProps {
  markdown: string;
  compact?: boolean;
  /** Document path for resolving relative workspace images, videos, and audio. */
  documentPath?: string;
  /** Optional workspace root override (e.g. assistant persona folder). */
  workspaceRoot?: string;
  /** Optional custom image renderer; defaults to the shared workspace-aware image renderer. */
  renderImage?: (image: TextViewImage) => JSX.Element;
  imageWorkspace?: MarkdownImageWorkspace;
  onLinkPress?: (event: TextViewLinkPressEvent) => void;
  onImagePress?: (event: { image: TextViewImage }) => void;
  /** Called when an embedded local media fallback asks to open a workspace path. */
  onOpenWorkspacePath?: (path: string) => void;
  /** `"open"` lets the view open web links itself. */
  links?: "open" | "report";
  accessibilityLabel?: string;
}

function openDefaultMarkdownUrl(url: string): void {
  const isRemote = isRemoteWorkspace(activeWorkspace());
  const resolved = resolveWorkspaceMarkdownLink(url, activeWorkspaceRoot(), isRemote);
  if (resolved.kind === "external") {
    void openUrl(resolved.url).catch(() => undefined);
  } else if (resolved.kind === "workspace") {
    openInAuxPane("files", resolved.path);
  }
}

function defaultPreviewLinkPress(event: TextViewLinkPressEvent): void {
  openDefaultMarkdownUrl(event.url);
}

const DISPLAY_FORMULA_NODE = "displayFormula";

export function DisplayMath(props: { tex: string }) {
  return <DiagramIsland kind="math" source={props.tex} />;
}

/** Only display formulas use an island. Inline math stays in the selectable text flow. */
function withDisplayFormulaIslands(blocks: TextViewBlock[]): TextViewBlock[] {
  return blocks.map(block => {
    if (block.type === "math") return { type: "custom", name: DISPLAY_FORMULA_NODE, text: block.tex };
    if (block.type === "list") {
      return {
        ...block,
        items: block.items.map(item => ({ ...item, children: withDisplayFormulaIslands(item.children) })),
      };
    }
    if ("children" in block && block.children) {
      return { ...block, children: withDisplayFormulaIslands(block.children) };
    }
    return block;
  });
}

/** A Markdown document as a reader sees it, with typeset formulas and Mermaid diagrams. */
export function MarkdownPreview(props: MarkdownPreviewProps) {
  const columnWidth = signal<number>(layout.conversationWidth);
  const preparedMarkdown = () => transformEmbeddedMediaMarkdown(props.markdown);
  const document = computed(() => {
    const markdown = preparedMarkdown();
    if (!markdown.includes("$$")) return null;
    const parsed = TextView.parse(markdown, STATIC_MARKDOWN_OPTIONS, MARKDOWN_PREVIEW_EXTENSIONS);
    return {
      ...parsed,
      blocks: withDisplayFormulaIslands(parsed.blocks),
      footnotes: parsed.footnotes?.map(note => ({ ...note, children: withDisplayFormulaIslands(note.children) })),
    };
  });
  return (
    <View
      accessibilityLabel={props.accessibilityLabel}
      onLayout={event => {
        const nextW = Math.round(event.bounds.size.width);
        if (nextW > 0 && nextW !== untracked(() => columnWidth())) columnWidth.set(nextW);
      }}
      style={{ alignSelf: "stretch", minWidth: 0 }}
    >
    <TextView
      markdown={document() ? null : preparedMarkdown()}
      document={document()}
      selectable={true}
      links={props.links ?? "report"}
      options={STATIC_MARKDOWN_OPTIONS}
      extensions={MARKDOWN_PREVIEW_EXTENSIONS}
      styles={createMarkdownStyles({ compact: props.compact })}
      codeBlockActions={createMarkdownCodeActions()}
      renderImage={image =>
        props.renderImage ? (
          props.renderImage(image)
        ) : props.documentPath && props.imageWorkspace ? (
          <MarkdownDocumentImage image={image} documentPath={props.documentPath}
            workspace={props.imageWorkspace} workspaceRoot={props.workspaceRoot} maxWidth={columnWidth()} />
        ) : (
          <MarkdownImageView
            image={image}
            documentPath={props.documentPath}
            workspaceRoot={props.workspaceRoot}
            containerWidth={() => columnWidth()}
          />
        )
      }
      onImagePress={event => {
        if (props.onImagePress) {
          props.onImagePress(event);
          return;
        }
        void openMarkdownImageInLightbox(event.image, {
          documentPath: props.documentPath,
          workspaceRoot: props.workspaceRoot,
        });
      }}
      onLinkPress={props.onLinkPress ?? defaultPreviewLinkPress}
      renderCustom={node => {
        if (node.name === "mermaid") {
          return renderMarkdownDiagram(node);
        }
        if (node.name === DISPLAY_FORMULA_NODE) return <DisplayMath tex={node.text ?? ""} />;
        if (node.name === "media") {
          return (
            <MarkdownMediaEmbed
              rawJson={node.text ?? ""}
              documentPath={props.documentPath}
              workspaceRoot={props.workspaceRoot}
              containerWidth={() => columnWidth()}
              onOpenWorkspacePath={props.onOpenWorkspacePath}
            />
          );
        }
        return <Text style={textStyle("body")}>{node.text ?? ""}</Text>;
      }}
      renderMath={math =>
        math.display ? (
          <DiagramIsland kind="math" source={math.tex} />
        ) : (
          <Text
            style={{
              fontFamily: fontMono(),
              fontSize: textSize(typeScale.label),
              color: palette().text,
              backgroundColor: palette().surfaceTertiary,
              borderRadius: radii.xs,
              paddingHorizontal: space.xs,
            }}
          >
            {math.tex}
          </Text>
        )
      }
    />
    </View>
  );
}

// ── The visual editor ──────────────────────────────────────────────────────

export interface MarkdownDocumentEditorProps {
  /** The document's identity (its path): a new key makes a new editor. */
  documentKey: string;
  /** The Markdown the editor shows; a change from outside (a reload) replaces the document. */
  text: string;
  /** A one-based source line to reveal in the rendered document. */
  revealLine?: { line: number } | null;
  onRevealLine?: (target: { line: number }, revealed: boolean) => void;
  /** Every edit, as Markdown. */
  onChange: (markdown: string) => void;
  /** The document's name, for the AI prompt. */
  documentName: string;
  /** Document path for resolving relative workspace images (defaults to `documentKey`). */
  documentPath?: string;
  /** Optional workspace root override for relative images. */
  workspaceRoot?: string;
  accessibilityLabel?: string;
  placeholder?: string;
  compact?: boolean;
  /** The reading column's width. */
  maxWidth?: number;
  /** The workspace owning the document and its relative image references. */
  imageWorkspace?: MarkdownImageWorkspace;
  /** Inline AI is scoped to the owning workspace and device. */
  ai?: boolean | { documentKey: string; target: string | null };
  /** Workspace-aware image renderer (`read_file_content` base64 for local and remote workspaces). */
  renderImage?: (image: TextViewImage) => JSX.Element;
  /** Link opener for links clicked in the visual editor's link bubble. */
  onLinkPress?: (url: string) => void;
}

function imageAttributes(node: RichNodeViewProps) {
  const attrs = node.node.attrs;
  return { src: String(attrs.src ?? ""), alt: String(attrs.alt ?? ""), title: String(attrs.title ?? "") };
}

function ImageAttributesDialog(props: { node: RichNodeViewProps; onClose: () => void }) {
  const initial = untracked(() => imageAttributes(props.node));
  const src = signal(initial.src);
  const alt = signal(initial.alt);
  const title = signal(initial.title);
  const canApply = () => Boolean(src().trim()) && (src() !== initial.src || alt() !== initial.alt || title() !== initial.title);
  const apply = () => {
    if (!canApply()) return;
    if (props.node.getPos() != null) {
      props.node.updateAttributes({ src: src().trim(), alt: alt(), title: title() || null });
    }
    props.onClose();
  };
  return <ModalDialog open title={tr("doc.editImage")} accessibilityLabel="doc-edit-image-dialog"
    onClose={props.onClose} onSubmit={apply} size="md" footer={<>
      <Button label={tr("common.cancel")} variant="secondary" onPress={props.onClose} />
      <Button label={tr("common.apply")} variant="primary" disabled={!canApply()} onPress={apply} />
    </>}>
    <View style={{ gap: space.md }}>
      <InputBox label={tr("doc.imageSource")} value={src()} onChange={src.set} accessibilityLabel="doc-image-source" />
      <InputBox label={tr("doc.imageAlt")} value={alt()} onChange={alt.set} accessibilityLabel="doc-image-alt" />
      <InputBox label={tr("doc.imageTitle")} value={title()} onChange={title.set} accessibilityLabel="doc-image-title" />
    </View>
  </ModalDialog>;
}

/** The mounted editors' actions, so the file menu can open AI at the caret. */
const openMountedAi = new Map<string, () => void>();

/** Opens the "Ask AI" field over the mounted editor's selection (or at its caret). */
export function askAiInDocument(documentKey: string): void {
  openMountedAi.get(documentKey)?.();
}

function selectionRange(session: RichEditorSession): { from: number; to: number } {
  const selection = session.selection;
  if (selection.type === "all") {
    return { from: 0, to: (session.doc.content ?? []).reduce((size, node) => size + richNodeSize(node), 0) };
  }
  const anchor = selection.anchor ?? 0;
  const head = selection.head ?? anchor;
  return { from: Math.min(anchor, head), to: Math.max(anchor, head) };
}

let editorStylesCache: {
  palette: Palette;
  fontPx: number;
  loc: string;
  cjk: boolean;
  compact: boolean;
  styles: RichEditorStyles;
} | null = null;

function editorStyles(compact: boolean): RichEditorStyles {
  const p = palette();
  const fontPx = uiFontBasePx();
  const loc = currentLocale();
  const cjk = cjkTypography();
  if (
    editorStylesCache &&
    editorStylesCache.palette === p &&
    editorStylesCache.fontPx === fontPx &&
    editorStylesCache.loc === loc &&
    editorStylesCache.cjk === cjk &&
    editorStylesCache.compact === compact
  ) {
    return editorStylesCache.styles;
  }
  const base = compact ? 13 : typeScale.prose;
  const codeBase = Math.max(11, base - 2);
  const tableBase = Math.max(12, base - 1);
  const h1Size = base + (compact ? 5 : 6);
  const h2Size = base + 3;
  const h3Size = base + 1;
  const h5Size = Math.max(12, base - 1);
  const h6Size = Math.max(11, base - 2);

  const styles: RichEditorStyles = {
    root: {
      color: p.text,
      fontFamily: fontSans(),
      fontSize: textSize(base),
      lineHeight: textLineHeight(base, 1.6),
      letterSpacing: textTracking(base),
    },
    content: {
      paddingHorizontal: compact ? space.lg : space.x3l,
      paddingVertical: compact ? space.lg : space.xxl,
    },
    caret: { backgroundColor: p.accent },
    selection: { backgroundColor: p.accentSoft },
    placeholder: { color: p.textMuted },
    listMarker: { color: p.textMuted, fontVariant: ["tabular-nums"] },
    taskCheckbox: { borderColor: p.borderStrong, borderRadius: radii.xs },
    nodes: {
      paragraph: { marginBottom: compact ? space.sm : space.md },
      heading: { color: p.text, fontWeight: "600" as const, marginTop: compact ? space.md : space.lg, marginBottom: space.xs },
      bulletList: { marginBottom: compact ? space.sm : space.md },
      orderedList: { marginBottom: compact ? space.sm : space.md },
      taskList: { marginBottom: compact ? space.sm : space.md },
      table: { marginBottom: compact ? space.sm : space.md },
      "heading[level=1]": {
        fontSize: textSize(h1Size),
        fontWeight: "600" as const,
        lineHeight: textLineHeight(h1Size, 1.28),
        letterSpacing: textTracking(h1Size),
        marginTop: compact ? space.md : space.lg,
        marginBottom: space.sm,
      },
      "heading[level=2]": {
        fontSize: textSize(h2Size),
        fontWeight: "600" as const,
        lineHeight: textLineHeight(h2Size, 1.34),
        letterSpacing: textTracking(h2Size),
        marginTop: compact ? space.md : space.lg,
        marginBottom: space.xs,
      },
      "heading[level=3]": {
        fontSize: textSize(h3Size),
        fontWeight: "600" as const,
        lineHeight: textLineHeight(h3Size, 1.38),
        letterSpacing: textTracking(h3Size),
        marginTop: space.sm,
        marginBottom: space.xs,
      },
      "heading[level=4]": {
        fontSize: textSize(base),
        fontWeight: "600" as const,
        lineHeight: textLineHeight(base, 1.42),
        letterSpacing: textTracking(base),
      },
      "heading[level=5]": {
        fontSize: textSize(h5Size),
        fontWeight: "600" as const,
        lineHeight: textLineHeight(h5Size, 1.42),
        color: p.textSecondary,
      },
      "heading[level=6]": {
        fontSize: textSize(h6Size),
        fontWeight: "600" as const,
        lineHeight: textLineHeight(h6Size, 1.42),
        color: p.textMuted,
      },
      codeBlock: {
        fontFamily: fontMono(),
        fontSize: textSize(codeBase),
        lineHeight: textLineHeight(codeBase, 1.54),
        color: p.text,
        backgroundColor: p.surfaceTertiary,
        borderWidth: 1,
        borderColor: p.borderSubtle,
        borderRadius: radii.lg,
        paddingHorizontal: space.md,
        paddingVertical: space.md,
        marginBottom: compact ? space.sm : space.md,
      },
      blockquote: {
        borderLeftWidth: 3,
        borderColor: p.borderStrong,
        paddingLeft: space.md,
        paddingVertical: space.xs,
        marginBottom: compact ? space.sm : space.md,
        color: p.textSecondary,
      },
      horizontalRule: { backgroundColor: p.borderSubtle, height: 1, marginVertical: space.md },
      tableHeader: {
        fontWeight: "600" as const,
        fontSize: textSize(tableBase),
        lineHeight: textLineHeight(tableBase, 1.48),
        color: p.text,
        backgroundColor: p.surfaceSubtle,
        borderWidth: 1,
        borderColor: p.borderSubtle,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
      },
      tableCell: {
        fontSize: textSize(tableBase),
        lineHeight: textLineHeight(tableBase, 1.48),
        color: p.text,
        borderWidth: 1,
        borderColor: p.borderSubtle,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
      },
    },
    marks: {
      bold: { fontWeight: "600" as const, color: p.text },
      italic: { fontStyle: "italic" as const },
      strike: { color: p.textMuted },
      code: {
        fontFamily: fontMono(),
        fontSize: textSize(codeBase),
        color: p.text,
        backgroundColor: p.surfaceTertiary,
        borderRadius: radii.xs,
        paddingHorizontal: space.xs,
      },
      link: { color: p.accent },
    },
  };
  editorStylesCache = { palette: p, fontPx, loc, cjk, compact, styles };
  return styles;
}

function BubbleFormatButton(props: {
  label: string;
  active: boolean;
  accessibilityLabel: string;
  mono?: boolean;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: props.active }}
      onPress={props.onPress}
      style={{
        minWidth: 26,
        height: 24,
        paddingHorizontal: space.xs,
        borderRadius: radii.sm,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: props.active ? palette().accentSoft : "transparent",
        cursor: "pointer",
        userSelect: "none",
        ...pressTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{ backgroundColor: props.active ? palette().accentSoft : palette().panelHover }}
      activeStyle={tactileActiveStyle(0.96)}
      focusVisibleStyle={focusRingStyle()}
    >
      <Text
        style={{
          fontFamily: props.mono ? fontMono() : fontSans(),
          fontSize: textSize(typeScale.caption),
          lineHeight: textLineHeight(typeScale.caption, 1.2),
          fontWeight: props.bold ? "600" : "500",
          fontStyle: props.italic ? "italic" : "normal",
          textDecorationLine: props.strike ? "line-through" : "none",
          color: props.active ? palette().accent : palette().text,
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}

function richNodeSize(node: RichNodeJSON): number {
  if (node.text !== undefined) return node.text.length;
  if (node.type === "image" || node.type === "hardBreak" || node.type === "horizontalRule") return 1;
  return 2 + (node.content ?? []).reduce((size, child) => size + richNodeSize(child), 0);
}

interface InlineAiAnchor {
  original: string[];
  all: boolean;
  first: number;
  last: number;
  from: number;
  to: number;
}

function captureInlineAiAnchor(session: RichEditorSession): InlineAiAnchor | null {
  const nodes = session.doc.content ?? [];
  const { from, to } = selectionRange(session);
  let start = 0;
  let first = -1;
  let firstStart = 0;
  for (let index = 0; index < nodes.length; index++) {
    const end = start + richNodeSize(nodes[index]);
    if (first === -1 && from < end) {
      first = index;
      firstStart = start;
    }
    if (first !== -1 && to <= end) {
      return { original: nodes.map(node => JSON.stringify(node)), all: session.selection.type === "all", first, last: index,
        from: from - firstStart, to: to - firstStart };
    }
    start = end;
  }
  return null;
}

/** NSH exposes no persistent block IDs. A changed snapshot must still contain
 * the same target blocks, uniquely identified by their content or neighbours. */
function resolveInlineAiAnchor(session: RichEditorSession, anchor: InlineAiAnchor) {
  const nodes = session.doc.content ?? [];
  const current = nodes.map(node => JSON.stringify(node));
  let first = anchor.first;
  if (current.length !== anchor.original.length || !current.every((node, index) => node === anchor.original[index])) {
    if (anchor.all) return null;
    const target = anchor.original.slice(anchor.first, anchor.last + 1);
    const matchingBlocks = (blocks: string[]) => blocks.flatMap((node, index) => node === target[0] &&
      target.every((block, relative) => blocks[index + relative] === block) ? [index] : []);
    const candidates = matchingBlocks(current);
    const anchored = candidates.length === 1 && matchingBlocks(anchor.original).length === 1 ? candidates : candidates.filter(index =>
      current[index - 1] === anchor.original[anchor.first - 1] &&
      current[index + target.length] === anchor.original[anchor.last + 1]);
    if (anchored.length !== 1) return null;
    first = anchored[0];
  }
  const start = nodes.slice(0, first).reduce((position, node) => position + richNodeSize(node), 0);
  return { from: start + anchor.from, to: start + anchor.to, blockStart: start };
}

function atEmptyTopLevelParagraph(session: RichEditorSession): boolean {
  const { from, to } = selectionRange(session);
  if (from !== to) return false;
  const parent = session.resolve(from) as { depth: number; parent: string; start: number; end: number };
  return parent.depth === 1 && parent.parent === "paragraph" && parent.start === parent.end;
}

function richNodeText(node: RichNodeJSON): string {
  return node.text ?? (node.content ?? []).map(richNodeText).join("");
}

/** Locate where the native parser stopped, using identical preceding nodes as anchors. */
function endOfMarkdownPrefix(
  document: RichNodeJSON, prefix: RichNodeJSON, from: number,
): { from: number; to: number; caret: number } | null {
  if (document.type !== prefix.type || JSON.stringify(document.attrs) !== JSON.stringify(prefix.attrs)) return null;
  if (document.type === "paragraph" || document.type === "heading" || document.type === "codeBlock") {
    const text = richNodeText(prefix);
    if (!text || !richNodeText(document).startsWith(text)) return null;
    const lineOffset = document.type === "codeBlock" ? text.replace(/\n$/, "").lastIndexOf("\n") + 1 : 0;
    return { from, to: from + richNodeSize(document), caret: from + 1 + lineOffset };
  }
  const children = document.content ?? [];
  const leading = prefix.content ?? [];
  const last = leading.length - 1;
  if (last < 0 || last >= children.length) return null;
  let start = document.type === "doc" ? from : from + 1;
  for (let index = 0; index < last; index++) {
    if (JSON.stringify(children[index]) !== JSON.stringify(leading[index])) return null;
    start += richNodeSize(children[index]);
  }
  return endOfMarkdownPrefix(children[last], leading[last], start);
}

function markdownLineRange(session: RichEditorSession, source: string, line: number) {
  const lines = source.split(/\r\n?|\n/);
  if (!Number.isInteger(line) || !lines[line - 1]?.trim()) return null;
  // Parsing the exact prefix in the same schema handles adjacent blocks, nested
  // lists and multiline code. If later lines reinterpret the prefix (for example
  // a table delimiter), the source editor can still show the exact line.
  let prefix: RichEditorSession | undefined;
  try {
    prefix = createMarkdownSession(lines.slice(0, line).join("\n"));
    return endOfMarkdownPrefix(session.doc, prefix.doc, 0);
  } catch {
    return null;
  } finally {
    prefix?.dispose();
  }
}

const FILE_SEARCH_HIGHLIGHT = "file-search-line";
const FILE_SEARCH_HIGHLIGHT_MS = 3000;
const INLINE_AI_CONTEXT_CHARS = 4500;
const INLINE_AI_WIDTH = 416;
const INLINE_AI_MAX_HEIGHT = 336;

/** One editor over one document; remade when the document changes. */
function VisualEditorBody(props: { owner: MarkdownDocumentEditorProps }) {
  const owner = props.owner;
  const key = untracked(() => owner.documentKey);
  const aiOwner = untracked(() => typeof owner.ai === "object" ? owner.ai
    : owner.ai ? { documentKey: key, target: deviceContext() || null } : undefined);
  const aiKey = aiOwner?.documentKey;
  /** The text the document was last set from: an edit that returns to it reads as that text. */
  let baseline = untracked(() => owner.text);
  let baselineSplit = splitFrontmatter(baseline);
  let lastEmitted = baseline;
  let normalizedBaselineBody: string | null = null;
  const frontmatterText = signal(baselineSplit.frontmatter);
  const frontmatterYaml = signal(baselineSplit.yaml);
  const frontmatterExpanded = signal(false);

  const editingImage = signal<RichNodeViewProps | null>(null);
  const width = signal(0);
  const contentWidth = () => {
    const outer = Math.min(width(), owner.maxWidth ?? width());
    const padding = owner.compact ? space.lg : space.x3l;
    return outer > 0 ? Math.max(1, outer - padding * 2) : 0;
  };
  const searchHighlight = new RichEditorPlugin(FILE_SEARCH_HIGHLIGHT);
  const session = createMarkdownSession(baselineSplit.body, undefined, node => <View style={{ gap: space.xs, maxWidth: "100%" }}>
    <If when={owner.imageWorkspace} else={owner.renderImage?.(imageAttributes(node)) ?? (
      <MarkdownImageView image={imageAttributes(node)} documentPath={owner.documentPath ?? key}
        workspaceRoot={owner.workspaceRoot} containerWidth={contentWidth} />
    )}>
      <MarkdownDocumentImage image={imageAttributes(node)} documentPath={owner.documentPath ?? key}
        workspace={owner.imageWorkspace} workspaceRoot={owner.workspaceRoot} maxWidth={contentWidth()} />
    </If>
    <IconButton icon="edit" size="xs" tooltip={tr("doc.editImage")} accessibilityLabel="doc-edit-image"
      onPress={() => editingImage.set(node)} />
  </View>, [searchHighlight]);
  let normalizedInitialBody = normalizeMarkdown(session.getMarkdown());
  let quietRevision = session.revision;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  const editorLaidOut = signal(false);
  const hasSelection = signal(false);
  const activeLinkHref = signal("");
  const activeBold = signal(false);
  const activeItalic = signal(false);
  const activeStrike = signal(false);
  const activeCode = signal(false);

  const canTriggerOnSpace = signal(false);
  let mounted = true;
  let aiAnchor: InlineAiAnchor | null = null;
  let aiPositionFrame: number | undefined;
  const aiPosition = signal<Point | null>(null);
  const aiAnchorView = signal<ViewRef | null>(null);
  const aiFallbackView = signal<ViewRef | null>(null);
  const aiPanelHeight = signal(INLINE_AI_MAX_HEIGHT);
  const placementError = signal<"doc.aiTargetChanged" | "doc.aiInsertFailed" | null>(null);
  const aiOpen = () => aiKey && inlineAiComposer()?.documentKey === aiKey ? aiKey : null;

  function measureAiPosition(): void {
    if (!mounted || !aiAnchor) return;
    const range = resolveInlineAiAnchor(session, aiAnchor);
    const line = range ? session.coordsAtPos(range.from) as { x: number; y: number; height: number } | null : null;
    const block = range ? session.nodeRect(range.blockStart) as { x: number; y: number; height: number } | null : null;
    const vertical = line ?? block;
    const next = vertical && { x: (block ?? vertical).x, y: vertical.y + vertical.height };
    const last = aiPosition();
    if (next?.x !== last?.x || next?.y !== last?.y) aiPosition.set(next);
  }

  function scheduleAiPosition(): void {
    if (!mounted || !aiOpen() || aiPositionFrame !== undefined) return;
    aiPositionFrame = requestAnimationFrame(() => {
      aiPositionFrame = undefined;
      if (aiOpen()) measureAiPosition();
    });
  }

  function openAi(): void {
    if (!aiKey || inlineAiComposer()?.documentKey === aiKey) return;
    aiAnchor = captureInlineAiAnchor(session);
    if (!aiAnchor) return;
    const { from, to } = selectionRange(session);
    const previous = inlineAi();
    if (previous && previous.documentKey !== aiKey) void cancelInlineAi();
    placementError.set(null);
    aiPanelHeight.set(INLINE_AI_MAX_HEIGHT);
    measureAiPosition();
    openInlineAiComposer(aiKey, from < to ? session.textBetween(from, to, "\n") : "");
    scheduleAiPosition();
  }

  function dismissAi(): void {
    if (!mounted || !aiOpen()) return;
    void cancelInlineAi();
    closeInlineAiComposer();
    if (!owner.compact) session.focus();
  }

  if (aiKey) {
    openMountedAi.set(aiKey, openAi);
    const syncTrigger = () => {
      // NSH may already have queued a focus or revision callback before cleanup.
      if (!mounted) return;
      canTriggerOnSpace.set(session.isFocused && !session.composing && atEmptyTopLevelParagraph(session));
    };
    cleanup(session.on("revision", syncTrigger));
    cleanup(session.on("focus", syncTrigger));
    cleanup(session.on("blur", syncTrigger));
    effect(() => {
      if (!canTriggerOnSpace() || inlineAiComposer()) return;
      cleanup(keymap.bind("space", () => {
        if (!mounted || !session.isFocused || session.composing) return;
        if (!inlineAiComposer() && atEmptyTopLevelParagraph(session)) openAi();
        else session.run(insertText(" "));
      }, { when: "always", forFocus: true, overFocused: true }));
    });
  }
  cleanup(() => {
    mounted = false;
    if (aiPositionFrame !== undefined) cancelAnimationFrame(aiPositionFrame);
    clearTimeout(highlightTimer);
    if (aiKey && openMountedAi.get(aiKey) === openAi) {
      openMountedAi.delete(aiKey);
      if (inlineAi()?.documentKey === aiKey) void cancelInlineAi();
      if (inlineAiComposer()?.documentKey === aiKey) closeInlineAiComposer();
    }
    session.dispose();
    searchHighlight.dispose();
  });

  const syncSelectionState = (empty: boolean) => {
    hasSelection.set(!empty);
    const linkAttrs = session.isActive("link")
      ? (session.getAttributes("link") as { href?: unknown } | null)
      : null;
    activeLinkHref.set(typeof linkAttrs?.href === "string" ? linkAttrs.href : "");
    if (!empty) {
      activeBold.set(session.isActive("bold"));
      activeItalic.set(session.isActive("italic"));
      activeStrike.set(session.isActive("strike"));
      activeCode.set(session.isActive("code"));
    } else {
      activeBold.set(false);
      activeItalic.set(false);
      activeStrike.set(false);
      activeCode.set(false);
    }
  };

  // A reload from disk (or a reset / switch from Source) replaces the text from outside:
  // the document follows it without counting as an edit.
  effect(() => {
    const text = owner.text;
    untracked(() => {
      if (text === lastEmitted) return;
      baseline = text;
      baselineSplit = splitFrontmatter(text);
      normalizedBaselineBody = null;
      lastEmitted = text;
      editingImage.set(null);
      frontmatterText.set(baselineSplit.frontmatter);
      frontmatterYaml.set(baselineSplit.yaml);
      session.setContent(baselineSplit.body, "markdown");
      normalizedInitialBody = normalizeMarkdown(session.getMarkdown());
      quietRevision = session.revision;
      scheduleAiPosition();
    });
  });

  const composeFullMarkdown = (serializedBody: string, fm: string): string => {
    if (normalizedBaselineBody === null) normalizedBaselineBody = normalizeMarkdown(baselineSplit.body);
    const normOut = normalizeMarkdown(serializedBody);
    const bodyUnchanged =
      serializedBody === baselineSplit.body ||
      normOut === normalizedBaselineBody ||
      normOut === normalizedInitialBody;
    const fmUnchanged = fm === baselineSplit.frontmatter;
    if (bodyUnchanged && fmUnchanged) return baseline;
    return fm + (bodyUnchanged ? baselineSplit.body : serializedBody);
  };

  effect(() => {
    const target = owner.revealLine;
    if (!target || !editorLaidOut()) return;
    const frame = requestAnimationFrame(() => {
      if (owner.revealLine !== target) return;
      const range = markdownLineRange(session, splitFrontmatter(owner.text).body,
        target.line - (splitFrontmatter(owner.text).frontmatter.match(/\n/g)?.length ?? 0));
      if (range && !owner.compact) session.focus();
      if (!range || !session.run(chain([setTextSelection(range.caret), scrollIntoView()]))) {
        owner.onRevealLine?.(target, false);
        return;
      }
      const color = palette().warningSoft.replace(/\s/g, "");
      session.setDecorations(FILE_SEARCH_HIGHLIGHT, [{
        kind: "node", from: range.from, to: range.to,
        attrs: { class: `bg-[${color}]` },
      }]);
      clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => session.setDecorations(FILE_SEARCH_HIGHLIGHT, []), FILE_SEARCH_HIGHLIGHT_MS);
      owner.onRevealLine?.(target, true);
    });
    cleanup(() => cancelAnimationFrame(frame));
  });

  const emit = (revision: number) => {
    if (revision <= quietRevision) return;
    const text = composeFullMarkdown(session.getMarkdown(), frontmatterText());
    if (text === lastEmitted) return;
    lastEmitted = text;
    owner.onChange(text);
  };

  const updateFrontmatterYaml = (nextYaml: string) => {
    frontmatterYaml.set(nextYaml);
    const nextFm =
      nextYaml === baselineSplit.yaml
        ? baselineSplit.frontmatter
        : `---${baselineSplit.eol}${nextYaml}${baselineSplit.eol}---${
            baselineSplit.separator || `${baselineSplit.eol}${baselineSplit.eol}`
          }`;
    frontmatterText.set(nextFm);
    const text = composeFullMarkdown(session.getMarkdown(), nextFm);
    if (text === lastEmitted) return;
    lastEmitted = text;
    owner.onChange(text);
  };

  const toggleMark = (mark: "bold" | "italic" | "strike" | "code") => {
    if (!session.run({ command: "toggleMark", name: mark })) return;
    emit(session.revision);
    syncSelectionState(false);
  };

  const openActiveLink = () => {
    const href = activeLinkHref();
    if (!href) return;
    if (owner.onLinkPress) {
      owner.onLinkPress(href);
      return;
    }
    openDefaultMarkdownUrl(href);
  };

  const askAtAnchor = (intent: InlineAiIntent, instruction: string) => {
    if (!aiKey) return;
    const range = aiAnchor && resolveInlineAiAnchor(session, aiAnchor);
    if (!range) {
      placementError.set("doc.aiTargetChanged");
      return;
    }
    placementError.set(null);
    void askInlineAi(aiKey, aiOwner?.target ?? null, {
      intent, instruction, documentName: owner.documentName,
      document: session.getMarkdown(),
      selection: inlineAiComposer()?.selection ?? "",
      before: session.textBetween(Math.max(0, range.from - INLINE_AI_CONTEXT_CHARS), range.from, "\n"),
      after: session.textBetween(range.to, range.to + INLINE_AI_CONTEXT_CHARS, "\n"),
    });
  };

  const insertAnswer = () => {
    const answer = inlineAi();
    if (!answer || answer.documentKey !== aiKey || answer.status !== "ready") return;
    const anchor = aiAnchor;
    const range = anchor && resolveInlineAiAnchor(session, anchor);
    if (!anchor || !range) {
      placementError.set("doc.aiTargetChanged");
      return;
    }
    const markdown = inlineAiMarkdown(answer.text);
    try {
      const selectTarget = anchor.all ? selectAll() : setTextSelection(range.from, range.to);
      if (!markdown || !session.run(chain([selectTarget, insertContent(markdown, "markdown"), scrollIntoView()]))) {
        placementError.set("doc.aiInsertFailed");
        return;
      }
    } catch {
      placementError.set("doc.aiInsertFailed");
      return;
    }
    finishInlineAi();
    emit(session.revision);
    if (!owner.compact) session.focus();
  };

  const showBubble = () => hasSelection() || Boolean(activeLinkHref());

  return (
    <View onLayout={event => width.set(event.bounds.size.width)} style={{ flex: 1, minHeight: 0, minWidth: 0, flexDirection: "column" }}>
      <If when={editingImage()}>{node => <ImageAttributesDialog node={node()} onClose={() => editingImage.set(null)} />}</If>
      <If when={Boolean(frontmatterText())}>
        <View
          style={{
            alignSelf: "center",
            width: "100%",
            maxWidth: owner.maxWidth,
            paddingHorizontal: owner.compact ? space.lg : space.x3l,
            paddingTop: space.sm,
          }}
        >
          <View
            style={{
              borderBottomWidth: 1,
              borderColor: palette().borderSubtle,
              paddingBottom: space.xs,
            }}
          >
            <View
              role="button"
              accessibilityLabel="doc-frontmatter-toggle"
              accessibilityState={{ expanded: frontmatterExpanded() }}
              onPress={() => frontmatterExpanded.set(!frontmatterExpanded())}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.xs,
                minHeight: 26,
                paddingHorizontal: space.xs,
                borderRadius: radii.sm,
                cursor: "pointer",
                userSelect: "none",
                ...paintTransition(MOTION_DURATION.fast),
              }}
              hoverStyle={{ backgroundColor: palette().panelHover }}
              focusVisibleStyle={focusRingStyle()}
            >
              <View style={rotatingChevronStyle(frontmatterExpanded())}>
                <Icon name="chevron-right" size={12} color={palette().textMuted} />
              </View>
              <Text style={{ ...textStyle("caption", { color: palette().textSecondary }), fontWeight: "600", flexShrink: 0 }}>
                {tr("doc.frontmatter")}
              </Text>
              <If when={!frontmatterExpanded() ? frontmatterSummary(frontmatterYaml()) : ""}>
                {summary => (
                  <Text
                    style={{
                      flex: 1,
                      minWidth: 0,
                      ...textStyle("caption", { color: palette().textMuted }),
                      numberOfLines: 1,
                      textOverflow: "ellipsis",
                    }}
                  >
                    {summary()}
                  </Text>
                )}
              </If>
            </View>
            <If when={frontmatterExpanded()}>
              <View
                style={{
                  marginTop: space.xs,
                  paddingHorizontal: space.sm,
                  paddingVertical: space.xs,
                  borderRadius: radii.md,
                  borderWidth: 1,
                  borderColor: palette().borderSubtle,
                  backgroundColor: palette().surfaceTertiary,
                }}
              >
                <Input
                  value={frontmatterYaml()}
                  accessibilityLabel="doc-frontmatter-input"
                  multiline={true}
                  submitBehavior="newline"
                  style={{
                    minHeight: 56,
                    maxHeight: 180,
                    color: palette().text,
                    placeholderColor: palette().textMuted,
                    caretColor: palette().accent,
                    fontFamily: fontMono(),
                    fontSize: textSize(typeScale.caption),
                    lineHeight: textLineHeight(typeScale.caption, 1.5),
                  }}
                  onChange={event => updateFrontmatterYaml(event.value)}
                />
              </View>
            </If>
          </View>
        </View>
      </If>
      <RichEditor
        editor={session}
        onLayout={event => {
          editorLaidOut.set(event.bounds.size.height > 0);
          scheduleAiPosition();
        }}
        accessibilityLabel={owner.accessibilityLabel}
        placeholder={owner.placeholder}
        placeholders={aiKey && !owner.compact && !inlineAiComposer()
          ? { paragraph: tr("doc.aiSpaceHint") } : undefined}
        styles={editorStyles(Boolean(owner.compact))}
        style={{ flex: 1, minHeight: 0, minWidth: 0, alignSelf: "center", width: "100%", maxWidth: owner.maxWidth }}
        onChange={event => {
          emit(event.change.revision);
          scheduleAiPosition();
        }}
        onContentSizeChange={aiKey ? scheduleAiPosition : undefined}
        onTableScroll={aiKey ? scheduleAiPosition : undefined}
        onSelectionChange={event => syncSelectionState(event.selection.empty)}
        bubbleMenu={
          showBubble() ? (
            <View
              {...popoverEnterMotion("top")}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 2,
                padding: space.xs,
                borderRadius: radii.lg,
                borderWidth: 1,
                borderColor: palette().borderSubtle,
                backgroundColor: palette().surfaceElevated,
                boxShadow: palette().shadowOverlay,
              }}
            >
              <If when={hasSelection()}>
                <BubbleFormatButton
                  label="B"
                  bold
                  active={activeBold()}
                  accessibilityLabel="doc-format-bold"
                  onPress={() => toggleMark("bold")}
                />
                <BubbleFormatButton
                  label="I"
                  italic
                  active={activeItalic()}
                  accessibilityLabel="doc-format-italic"
                  onPress={() => toggleMark("italic")}
                />
                <BubbleFormatButton
                  label="S"
                  strike
                  active={activeStrike()}
                  accessibilityLabel="doc-format-strike"
                  onPress={() => toggleMark("strike")}
                />
                <BubbleFormatButton
                  label="<>"
                  mono
                  active={activeCode()}
                  accessibilityLabel="doc-format-code"
                  onPress={() => toggleMark("code")}
                />
              </If>
              <If when={Boolean(activeLinkHref())}>
                <If when={hasSelection()}>
                  <View style={{ width: 1, height: 14, backgroundColor: palette().borderSubtle, marginHorizontal: 2 }} />
                </If>
                <Button
                  label={tr("doc.openLink")}
                  leadingIcon="external-link"
                  variant="ghost"
                  size="xs"
                  accessibilityLabel="doc-open-link"
                  onPress={openActiveLink}
                />
              </If>
              <If when={aiKey && hasSelection() && !aiOpen()}>
                <View style={{ width: 1, height: 14, backgroundColor: palette().borderSubtle, marginHorizontal: 2 }} />
                <Button
                  label={tr("doc.askAi")}
                  leadingIcon="sparkles"
                  variant="ghost"
                  size="xs"
                  accessibilityLabel="doc-ask-ai-selection"
                  onPress={openAi}
                />
              </If>
            </View>
          ) : undefined
        }
        contentLayer={aiOpen() && aiPosition() ? (
          <View ref={aiAnchorView.set}
            style={{ position: "absolute", top: aiPosition()?.y, left: aiPosition()?.x, width: 1, height: 1, pointerEvents: "none" }} />
        ) : undefined}
      />
      <If when={aiOpen()}>
        {activeKey => <>
          <View ref={aiFallbackView.set} style={{
            position: "absolute", top: space.lg, left: (width() - (contentWidth() || width())) / 2,
            width: 1, height: 1, pointerEvents: "none",
          }} />
          <If when={aiAnchorView() ?? aiFallbackView()}>
            <Overlay anchor={aiAnchorView() ?? aiFallbackView()} placement="bottom" align="start"
              offset={space.sm} margin={space.sm} onCancel={dismissAi}
              onPosition={event => aiPanelHeight.set(Math.min(INLINE_AI_MAX_HEIGHT, Math.max(100, event.available.height)))}>
              <InlineAiPanel
                documentKey={activeKey()}
                width={Math.min(INLINE_AI_WIDTH, contentWidth() || INLINE_AI_WIDTH)}
                maxHeight={aiPanelHeight()}
                placementError={placementError()}
                onAsk={askAtAnchor}
                onInsert={insertAnswer}
                onDismiss={dismissAi}
              />
            </Overlay>
          </If>
        </>}
      </If>
    </View>
  );
}

function InlineAiPanel(props: {
  documentKey: string;
  width: number;
  maxHeight: number;
  placementError: "doc.aiTargetChanged" | "doc.aiInsertFailed" | null;
  onAsk: (intent: InlineAiIntent, instruction: string) => void;
  onInsert: () => void;
  onDismiss: () => void;
}) {
  const instruction = signal("");
  const answer = () => {
    const current = inlineAi();
    return current && current.documentKey === props.documentKey ? current : null;
  };
  const replacing = () => Boolean(inlineAiComposer()?.selection.trim());
  cleanup(registerEscapeDismiss(() => props.onDismiss()));
  const submitAsk = (raw?: string, intent: InlineAiIntent = "ask") => {
    const query = (raw ?? instruction()).trim();
    if ((intent === "ask" && !query) || answer()?.status === "streaming") return;
    props.onAsk(intent, query);
  };
  return (
    <View
      accessibilityLabel="doc-ai-panel"
      style={{ ...menuSurfaceStyle(), width: props.width, maxHeight: props.maxHeight, flexDirection: "column" }}
    >
      <Scroll smoothWheel accessibilityLabel="doc-ai-body"
        style={{ flexShrink: 1, minHeight: 0 }} contentStyle={{ gap: space.sm, padding: space.sm }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
          <View style={{ flex: 1, minWidth: 160, flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Icon name="sparkles" size={14} color={palette().textSecondary} />
            <InputBox
              value={instruction()}
              onChange={value => instruction.set(value)}
              onSubmit={text => submitAsk(text)}
              onKeyPress={event => {
                if (event.key === "Escape") props.onDismiss();
              }}
              placeholder={replacing() ? tr("doc.askAiRewritePlaceholder") : tr("doc.askAiPlaceholder")}
              size="sm"
              autoFocus={true}
              accessibilityLabel="doc-ai-input"
              style={{ flex: 1, minWidth: 0 }}
            />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
            <If
              when={answer()?.status === "streaming"}
              else={
                <Button
                  label={tr("doc.askAiSend")}
                  variant="secondary"
                  size="sm"
                  disabled={!instruction().trim()}
                  accessibilityLabel="doc-ai-send"
                  onPress={() => submitAsk()}
                />
              }
            >
              <Button
                label={tr("common.stop")}
                variant="secondary"
                size="sm"
                accessibilityLabel="doc-ai-stop"
                onPress={() => void cancelInlineAi()}
              />
            </If>
            <Button
              label={tr("common.cancel")}
              variant="ghost"
              size="sm"
              accessibilityLabel="doc-ai-cancel"
              onPress={props.onDismiss}
            />
          </View>
        </View>
        <If when={!replacing()}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            <Each of={[
              { intent: "continue" as const, label: "doc.aiContinue" as const },
              { intent: "summary" as const, label: "doc.aiSummary" as const },
              { intent: "todo" as const, label: "doc.aiTodo" as const },
            ]} key={action => action.intent}>
              {action => <Button
                label={tr(action().label)}
                variant="secondary"
                size="xs"
                accessibilityLabel={`doc-ai-quick-${action().intent}`}
                disabled={answer()?.status === "streaming"}
                onPress={() => submitAsk("", action().intent)}
              />}
            </Each>
          </View>
        </If>
        <If when={props.placementError}>
          {error => <Text accessibilityLabel="doc-ai-placement-error"
            style={textStyle("caption", { color: palette().danger })}>{tr(error())}</Text>}
        </If>
        <If when={answer()}>
          {state => (
            <View style={{ gap: space.sm, minHeight: 0 }}>
              <If
                when={state().status !== "failed"}
                else={
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                    <Text
                      accessibilityLabel="doc-ai-error"
                      style={{ ...textStyle("caption", { color: palette().danger }), flex: 1, minWidth: 0 }}
                    >
                      {tr("doc.aiFailed", { error: localizeHostError(state().error ?? "") })}
                    </Text>
                    <Button
                      label={tr("common.tryAgain")}
                      variant="ghost"
                      size="xs"
                      accessibilityLabel="doc-ai-retry"
                      onPress={() => submitAsk(instruction() || state().instruction, state().intent)}
                    />
                  </View>
                }
              >
                <View style={{
                  borderRadius: radii.md, backgroundColor: palette().surfaceTertiary, padding: space.md,
                }}>
                  <If
                    when={inlineAiMarkdown(state().text)}
                    else={
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                        <If when={state().status === "streaming"}>
                          <Spinner size={12} color={palette().textMuted} />
                        </If>
                        <Text style={textStyle("caption")}>
                          {state().status === "streaming" ? tr("doc.aiWorking") : tr("doc.aiEmpty")}
                        </Text>
                      </View>
                    }
                  >
                    {text => (
                      <MarkdownPreview
                        markdown={text()}
                        compact={true}
                        links="report"
                        onLinkPress={defaultPreviewLinkPress}
                        accessibilityLabel="doc-ai-answer"
                      />
                    )}
                  </If>
                </View>
              </If>
            </View>
          )}
        </If>
      </Scroll>
      <If when={answer()}>
        {state => <View style={{
          flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap",
          gap: space.sm, flexShrink: 0, padding: space.sm, borderTopWidth: 1, borderColor: palette().borderSubtle,
        }}>
          <Button label={tr("doc.aiDiscard")} variant="ghost" size="xs"
            accessibilityLabel="doc-ai-discard" onPress={() => void cancelInlineAi()} />
          <Button label={state().replacesSelection ? tr("doc.aiReplace") : tr("doc.aiInsert")} variant="primary" size="xs"
            disabled={state().status !== "ready" || !inlineAiMarkdown(state().text) || Boolean(props.placementError)}
            accessibilityLabel="doc-ai-insert" onPress={props.onInsert} />
        </View>}
      </If>
    </View>
  );
}

/**
 * The visual editor over one Markdown document. The caller decides when it
 * shows (`visualEditBlock`) and keeps the text: this view only edits it.
 */
export function MarkdownDocumentEditor(props: MarkdownDocumentEditorProps) {
  return (
    <Each of={[typeof props.ai === "object" ? props.ai.documentKey : props.documentKey]} key={key => key}>
      {() => <VisualEditorBody owner={props} />}
    </Each>
  );
}
