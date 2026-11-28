// A visualize figure in the transcript: the sealed fragment in an offline web
// view, sized to its content and colored like the conversation.
//
// What the figure asks for goes to the reader: a follow-up fills the composer
// for them to send, links open in the system browser. State a figure keeps
// (`window.openai.setWidgetState`) lives per figure while this window shows
// the transcript. Where this client shows no web views the caller keeps the
// reference card.

import { computed, effect, openUrl, signal, untracked, View, WebView } from "nsh";
import type { WebViewRef } from "nsh";
import { rendererAssets } from "../documentRenderers";
import { currentLocale, tr } from "../i18n";
import { composerText } from "../state";
import { palette, radii, resolvedScheme, space } from "../theme";
import { readEchartsScript } from "../ui/documentRendererAssets";
import { pushToast } from "../ui/overlays";
import { appearanceScript, figureDocument, figureStyleVariables, parseFigureMessage, usesEcharts } from "./figureDocument";

const FONT_SANS = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', system-ui, sans-serif";
const INITIAL_HEIGHT = 240;
const MAX_HEIGHT = 4000;

/** Figure state by figure, for the lifetime of this window. */
const figureStates = new Map<string, unknown>();
/** Last measured height by figure, so a remount does not jump. */
const figureHeights = new Map<string, number>();

function currentVars(): Record<string, string> {
  return figureStyleVariables(palette(), resolvedScheme() === "dark", FONT_SANS);
}

export function FigureFrame(props: { figureKey: string; source: string; onUnavailable: () => void }) {
  const height = signal(figureHeights.get(props.figureKey) ?? INITIAL_HEIGHT);
  const charts = signal<string | null | undefined>(usesEcharts(props.source) ? undefined : null);
  let ref: WebViewRef | undefined;

  if (charts() === undefined) {
    const url = rendererAssets()?.echartsScript;
    if (url) readEchartsScript(url).then(script => charts.set(script), () => charts.set(null));
    else charts.set(null);
  }

  // Built once per load: a theme change is applied in place, keeping the figure's own state.
  const html = computed(() => {
    const script = charts();
    if (script === undefined) return null;
    return untracked(() =>
      figureDocument({
        fragment: props.source,
        vars: currentVars(),
        state: figureStates.get(props.figureKey) ?? null,
        lang: currentLocale(),
        echarts: script ?? undefined,
      }),
    );
  });

  // Disposed with the component.
  effect(() => {
    const vars = currentVars();
    ref?.injectJavaScript(appearanceScript(vars));
  });

  return (
    <If when={html()}>
      {() => (
        <View
          style={{
            alignSelf: "stretch",
            borderRadius: radii.md,
            borderCurve: "continuous",
            overflow: "hidden",
            minHeight: space.x4l,
          }}
        >
          <WebView
            ref={node => {
              ref = node;
            }}
            accessibilityLabel={`figure-${props.figureKey}`}
            html={html()!}
            scrollable={false}
            incognito
            style={{ alignSelf: "stretch", height: height(), backgroundColor: palette().canvas }}
            onError={() => props.onUnavailable()}
            onMessage={event => {
              const message = parseFigureMessage(event.data);
              if (!message) return;
              switch (message.type) {
                case "height": {
                  const next = Math.max(space.x4l, Math.min(MAX_HEIGHT, Math.ceil(Number(message.height) || 0)));
                  figureHeights.set(props.figureKey, next);
                  height.set(next);
                  break;
                }
                case "follow-up": {
                  const prompt = String(message.prompt ?? "").trim();
                  if (!prompt) break;
                  composerText.set(prompt);
                  pushToast(tr("nativeUi.askReady"), "info");
                  break;
                }
                case "open-external": {
                  const href = String(message.href ?? "");
                  if (/^https?:\/\//i.test(href)) void openUrl(href).catch(() => pushToast(tr("nativeUi.openFailed"), "error"));
                  break;
                }
                case "widget-state": {
                  try {
                    figureStates.set(props.figureKey, JSON.parse(String(message.state ?? "null")));
                  } catch {
                    // A state the page could not serialize stays with the page.
                  }
                  break;
                }
                case "error":
                  break;
              }
            }}
          />
        </View>
      )}
    </If>
  );
}
