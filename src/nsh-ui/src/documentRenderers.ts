// Where the document renderers (Mermaid, KaTeX) are, as each app ships them.
//
// The files live once in the repository (`src/nsh-ui/assets/vendor`), and an
// app can only ship files inside its own directory, so every entry registers
// its own `?url` imports here before the UI's modules run: the web build from
// `src/nsh-ui/WebApp.tsx`, the desktop and phone apps from their `src/`
// (gitignored copies, `scripts/sync-nsh-vendor-assets.mjs`). `App.tsx` imports no
// renderer itself, because the native entries import it from outside its
// directory. Without a registration (tests, `nsh run` of `App.tsx`) diagrams
// and formulas show as their source.
//
// This module has no runtime imports, so an entry can load it first.
import type { ImageAsset } from "nsh";
import type { RegionalAtlasLayer } from "../../shared/visualize/regionalProjection";

export type FigureAtlasAssets = Record<RegionalAtlasLayer | "stylesheet" | "notices", string>;

export interface DocumentRendererAssets {
  /** `mermaid.min.js`. */
  mermaidScript: string;
  /** `katex.min.js`. */
  katexScript: string;
  /** `katex.css` with its fonts inlined. */
  katexStyle: string;
  /** `echarts.min.js`, for visualize figures that draw with ECharts. */
  echartsScript?: string;
  /** Browser-only script that reads the island's data under the host's CSP. */
  browserBootstrap?: string;
  /** The PDF.js engine, local worker and PDF reader, compiled into one script. */
  pdfScript?: string;
  /** ECharts and the declarative figure viewer, compiled as one script. */
  figureScript?: string;
  /** Trusted CORS image reader, used outside the figure preview. */
  figureImageLoader?: string;
  /** Local map layers and the FlowChat map stylesheet. */
  figureAtlas?: FigureAtlasAssets;
  /** Screenshots shipped with built-in Spaces. */
  spaceShowcases?: Readonly<Record<string, ImageAsset>>;
}

let registered: DocumentRendererAssets | null = null;

export function setRendererAssets(assets: DocumentRendererAssets): void {
  registered = assets;
}

export function rendererAssets(): DocumentRendererAssets | null {
  return registered;
}
