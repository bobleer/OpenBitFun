// This app's copy of the document renderers (Mermaid, KaTeX) for the shared
// UI (`src/nsh-ui/src/documentRenderers.ts`). nsh ships only files inside the
// app's directory (symlinks resolve outside and are refused), so `assets/vendor`
// is a gitignored copy of `src/nsh-ui/assets/vendor`, the one in the repository,
// written by `scripts/sync-nsh-vendor-assets.mjs` before every native build.
import { setRendererAssets } from "../../../nsh-ui/src/documentRenderers";
import mermaidScript from "../assets/vendor/mermaid-10.9.1/mermaid.min.js?url";
import katexScript from "../assets/vendor/katex-0.16.11/katex.min.js?url";
import katexStyle from "../assets/vendor/katex-0.16.11/katex.css?url";
import echartsScript from "../assets/vendor/echarts-6.0.0/echarts.min.js?url";

import pdfScript from "../assets/vendor/pdf-reader.js?url";
import figureScript from "../assets/vendor/figure-renderer.js?url";
import figureImageLoader from "../assets/vendor/figure-image-loader.js?url";
import atlasStyle from "../assets/vendor/figure-atlas/regional-map.css?url";
import atlasNotices from "../assets/vendor/figure-atlas/NOTICES.txt?url";
import borders from "../assets/vendor/figure-atlas/borders.json?url";
import lakes from "../assets/vendor/figure-atlas/lakes.json?url";
import land from "../assets/vendor/figure-atlas/land.json?url";
import places from "../assets/vendor/figure-atlas/places.json?url";
import provinces from "../assets/vendor/figure-atlas/provinces.json?url";
import rivers from "../assets/vendor/figure-atlas/rivers.json?url";
import seas from "../assets/vendor/figure-atlas/seas.json?url";
import routingStrategies from "../assets/model-pools/routing-strategies-v1.png";
import codingShowcase from "../assets/vendor/space-showcases/coding-footprint.webp";
import divinationShowcase from "../assets/vendor/space-showcases/daily-divination.webp";
import gomokuShowcase from "../assets/vendor/space-showcases/gomoku.webp";
import pptShowcase from "../assets/vendor/space-showcases/ppt-live.webp";
import regexShowcase from "../assets/vendor/space-showcases/regex-playground.webp";
import { poolStrategyArtwork } from "../../../nsh-ui/src/poolStrategyArtwork";

setRendererAssets({
  mermaidScript, katexScript, katexStyle, echartsScript, pdfScript, figureScript, figureImageLoader,
  figureAtlas: { stylesheet: atlasStyle, notices: atlasNotices, borders, lakes, land, places, provinces, rivers, seas },
  spaceShowcases: { "builtin-coding-selfie": codingShowcase, "builtin-daily-divination": divinationShowcase,
    "builtin-gomoku": gomokuShowcase, "builtin-ppt-live": pptShowcase, "builtin-regex-playground": regexShowcase },
});
poolStrategyArtwork.set(routingStrategies);
