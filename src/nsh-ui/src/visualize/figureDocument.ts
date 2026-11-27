// The document a visualize figure runs in: the sealed HTML fragment the
// Agent wrote, the reader's colors as CSS variables, the guest bridge
// (`window.openai`) and, when the fragment draws with it, ECharts.
//
// The page is offline (a CSP with no network) and talks to this UI only
// through `window.nsh.postMessage`: its height, a follow-up for the composer,
// a link to open, and state to keep. Restored from the FlowChat frame of the
// retired web UI (`src/web-ui/src/tools/visualize`), with the MessagePort
// replaced by the NSH web view's message channel.

import type { Palette } from "../theme";

/** Messages the page posts (JSON in `window.nsh.postMessage`). */
export type FigureMessage =
  | { type: "height"; height: number }
  | { type: "follow-up"; prompt?: string }
  | { type: "open-external"; href?: string }
  | { type: "widget-state"; state?: string }
  | { type: "error"; message?: string };

const OFFLINE_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "script-src 'unsafe-inline' blob: data:",
  "style-src 'unsafe-inline' blob: data:",
  "connect-src blob: data:",
  "worker-src blob:",
  "img-src blob: data:",
  "font-src blob: data:",
  "media-src blob: data:",
].join("; ");

/** Text that cannot end or comment out the inline element it goes into. */
function inlineSafe(text: string): string {
  return text.replace(/<\/(script|style)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

function scriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** The CSS variables the visualize skill tells the Agent to use, from the reader's palette. */
export function figureStyleVariables(p: Palette, dark: boolean, fontFamily: string): Record<string, string> {
  const series = [p.accent, p.brandWarm, p.success, p.warning, p.danger, p.accentBorder, p.textSecondary];
  const vars: Record<string, string> = {
    "color-scheme": dark ? "dark" : "light",
    "--background": p.canvas,
    "--foreground": p.text,
    "--card": p.panelRaised,
    "--card-foreground": p.text,
    "--popover": p.popoverBg,
    "--popover-foreground": p.text,
    "--muted": p.surfaceTertiary,
    "--muted-foreground": p.textMuted,
    "--accent": p.accentSoft,
    "--accent-foreground": p.accent,
    "--primary": p.accent,
    "--primary-foreground": p.actionPrimaryFg,
    "--border": p.border,
    "--input": p.border,
    "--ring": p.borderFocus,
    "--blue": p.accent,
    "--font-sans": fontFamily,
    "--openbitfun-color-action-primary-background": p.actionPrimaryBg,
    "--openbitfun-color-action-primary-hover": p.actionPrimaryHover,
    "--openbitfun-color-action-primary-content": p.actionPrimaryFg,
  };
  for (let index = 0; index < 12; index++) vars[`--viz-series-${index + 1}`] = series[index % series.length];
  return vars;
}

const BASE_STYLE = `
:root{background:transparent!important}
html,body{margin:0;padding:0;overflow:hidden}
body{display:flow-root;color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5}
:where(figure,h1,h2,h3,p){margin:0}
h1{font-size:20px}h2{font-size:17px}h3{font-size:15px}
:where(a){color:var(--accent-foreground)}
:where(.card){background:var(--card);color:var(--card-foreground)}
:where(.popover,.tooltip){background:var(--popover);color:var(--popover-foreground)}
:where(.form-control,.form-select){background-color:var(--card);border:1px solid var(--input);color:var(--card-foreground)}
:where(input,progress){accent-color:var(--viz-series-1)}
:where(button,a,input,select,textarea):focus-visible{outline:2px solid var(--ring);outline-offset:2px}
:where(input,textarea)::placeholder{color:var(--muted-foreground)}
.text-muted{color:var(--muted-foreground)}
:where(button,select,input){font:inherit}
:where(.nav-pills,.viz-controls){display:flex;flex-wrap:wrap;gap:.45em}
:where(.btn,.nav-link){border-radius:8px;padding:.27em .65em;background:transparent;color:var(--foreground);border:1px solid var(--border);cursor:pointer}
.nav-link{border-color:transparent;color:var(--muted-foreground)}
.nav-link.active,.nav-link[aria-selected='true']{color:var(--foreground);background:var(--muted)}
.btn.btn-primary,.btn:is([aria-pressed='true'],[aria-selected='true'],.is-selected){background:var(--openbitfun-color-action-primary-background);border-color:var(--openbitfun-color-action-primary-background);color:var(--openbitfun-color-action-primary-content)}
[hidden]:not([hidden="until-found" i]){display:none!important}
`;

/** `window.openai` over the NSH web view's message channel, plus tabs that select their panels. */
const GUEST = `(() => {
  const post = (message) => { try { window.nsh && window.nsh.postMessage(JSON.stringify(message)); } catch (e) {} };
  const initial = JSON.parse(document.getElementById('openbitfun-figure-state').textContent);
  const api = {
    widgetState: initial,
    setWidgetState(state) {
      const serialized = JSON.stringify(state);
      if (serialized.length > 16384) return Promise.reject(Error('Figure state is limited to 16 KiB'));
      api.widgetState = JSON.parse(serialized);
      post({ type: 'widget-state', state: serialized });
      dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { widgetState: api.widgetState } } }));
      return Promise.resolve();
    },
    sendFollowUpMessage({ prompt }) { post({ type: 'follow-up', prompt: String(prompt || '') }); },
    openExternal({ href }) { post({ type: 'open-external', href: String(href || '') }); },
    notifyIntrinsicHeight(height) { post({ type: 'height', height: Math.ceil(height) }); },
    visualization: { bindings: {}, onData(name, callback) { if (typeof callback === 'function') callback(undefined); return () => {}; } },
  };
  window.openai = api;
  // Saved figures that keep selections in privateContent and read them at the top level.
  const fields = initial && initial.privateContent;
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    for (const name of Object.keys(fields)) {
      if (!(name in initial)) Object.defineProperty(initial, name, { configurable: true, get: () => fields[name] });
    }
  }
  window.__openbitfunApplyAppearance = (vars) => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(vars)) {
      if (name === 'color-scheme') { root.style.colorScheme = value; root.dataset.theme = value; }
      else root.style.setProperty(name, value);
    }
    dispatchEvent(new Event('openbitfun:figure-appearance'));
  };
  addEventListener('error', (event) => post({ type: 'error', message: String(event.message || 'error') }));
  const report = () => api.notifyIntrinsicHeight(document.documentElement.getBoundingClientRect().height);
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener('load', report);
  function tabsFor(tab) { return [...tab.closest('[role=tablist]').querySelectorAll('[role=tab]')]; }
  function select(tab) {
    for (const item of tabsFor(tab)) {
      const panel = document.getElementById(item.getAttribute('aria-controls'));
      if (!panel) continue;
      panel.hidden = item !== tab;
      item.tabIndex = item === tab ? 0 : -1;
      item.setAttribute('aria-selected', String(item === tab));
      item.classList.toggle('active', item === tab);
    }
  }
  document.addEventListener('click', (event) => {
    const tab = event.target.closest && event.target.closest('[role=tablist] [role=tab][aria-controls]');
    if (tab) select(tab);
    const link = event.target.closest && event.target.closest('a[href]');
    if (link && /^https?:/i.test(link.href)) { event.preventDefault(); api.openExternal({ href: link.href }); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    for (const list of document.querySelectorAll('[role=tablist]')) {
      const tab = list.querySelector('[role=tab][aria-selected=true][aria-controls], [role=tab].active[aria-controls]') || list.querySelector('[role=tab][aria-controls]');
      if (tab) select(tab);
    }
    report();
  });
})();`;

/** ECharts resolves its palette into paint values; hand it the reader's, and follow theme changes. */
const CHART_THEME = `(() => {
  const library = window.echarts;
  if (!library) return;
  const nativeInit = library.init;
  const charts = new Set();
  function readTheme() {
    const style = getComputedStyle(document.documentElement);
    const read = (name) => style.getPropertyValue(name).trim();
    const ink = read('--foreground'), label = read('--muted-foreground'), border = read('--border');
    const axis = { axisLabel: { color: label }, nameTextStyle: { color: label }, axisLine: { lineStyle: { color: border } }, splitLine: { lineStyle: { color: border } } };
    return {
      darkMode: style.colorScheme === 'dark',
      color: Array.from({ length: 12 }, (_, i) => read('--viz-series-' + (i + 1))),
      backgroundColor: 'transparent',
      textStyle: { color: ink, fontFamily: read('--font-sans') },
      title: { textStyle: { color: ink }, subtextStyle: { color: label } },
      legend: { textStyle: { color: ink }, inactiveColor: label },
      tooltip: { backgroundColor: read('--popover'), borderColor: border, textStyle: { color: read('--popover-foreground') } },
      categoryAxis: axis, valueAxis: axis, timeAxis: axis, logAxis: axis,
    };
  }
  let theme = readTheme();
  library.init = function (dom, explicitTheme, options) {
    const chart = nativeInit(dom, explicitTheme == null ? theme : explicitTheme, options);
    if (explicitTheme == null) charts.add(chart);
    return chart;
  };
  addEventListener('resize', () => { for (const chart of charts) chart.resize(); });
  addEventListener('openbitfun:figure-appearance', () => {
    theme = readTheme();
    for (const chart of charts) {
      const option = chart.getOption();
      const dom = chart.getDom();
      chart.dispose();
      charts.delete(chart);
      const next = library.init(dom);
      next.setOption(option);
    }
  });
})();`;

/** Whether the fragment draws with ECharts. */
export function usesEcharts(fragment: string): boolean {
  return /\becharts\s*\./.test(fragment);
}

export function figureDocument(options: {
  fragment: string;
  vars: Record<string, string>;
  state: unknown;
  lang: string;
  echarts?: string;
}): string {
  const rootStyle = Object.entries(options.vars)
    .map(([name, value]) => (name === "color-scheme" ? `color-scheme:${value}` : `${name}:${value}`))
    .join(";");
  const lang = /^[a-z\d-]+$/i.test(options.lang) ? options.lang : "en";
  const charts =
    options.echarts && usesEcharts(options.fragment)
      ? `<script>${inlineSafe(options.echarts)}</script><script>${CHART_THEME}</script>`
      : "";
  return (
    `<!doctype html><html lang="${lang}" style="${rootStyle.replace(/"/g, "&quot;")}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${OFFLINE_CSP}">` +
    `<meta name="referrer" content="no-referrer">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>${BASE_STYLE}</style></head><body>` +
    `<script type="application/json" id="openbitfun-figure-state">${scriptLiteral(options.state ?? null)}</script>` +
    `<script>${GUEST}</script>${charts}` +
    options.fragment +
    `</body></html>`
  );
}

/** The script that applies new colors to an open figure without reloading it. */
export function appearanceScript(vars: Record<string, string>): string {
  return `window.__openbitfunApplyAppearance && window.__openbitfunApplyAppearance(${scriptLiteral(vars)}); true;`;
}

export function parseFigureMessage(data: unknown): FigureMessage | null {
  if (typeof data !== "string" || !data.startsWith("{")) return null;
  try {
    const value = JSON.parse(data) as FigureMessage;
    return value && typeof value === "object" && typeof value.type === "string" ? value : null;
  } catch {
    return null;
  }
}
