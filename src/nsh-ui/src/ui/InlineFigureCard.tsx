import { cleanup, Clipboard, effect, Scroll, signal, Text, untracked, View, WebView, type WebViewRef } from "nsh";
import type { TranscriptTurnView } from "../api";
import { backendConnection } from "../bridge";
import type { Binding, RefreshableBinding } from "../figureBindingDeclarations";
import { formatCount } from "../format";
import { tr } from "../i18n";
import { parseFigureReaderEvent, writeFigureReaderState } from "../figureReaderStore";
import { compactLayout, fontMono, palette, radii, space, textLineHeight, textSize, textStyle } from "../theme";
import { figureTurnOwnedBy, publishedFigure, readPublishedFigureSource } from "../toolDetailStore";
import { createFigurePreviewDocument, hasFigureDeclaration, type FigurePreviewDocument } from "./figurePreviewDocument";
import { bindingUpdate, type BoundValue } from "./figureBindingGuest";
import { localizeFigureImages, type FigureImageLoader, type LoadedFigureImages } from "./figureImageBindings";
import { createFigureResourceBinding } from "./figureResourceBinding";
import { createFigureSessionBinding, type FigureSession } from "./figureSessionBinding";
import { FigureResourceControls } from "./FigureResourceControls";
import { Icon } from "./icons";
import type { InlineFigureDirective } from "./markdown";
import { BrandSpinner } from "./motion";
import { ModalDialog, pushToast } from "./overlays";
import { Badge, Button, InlineBanner, ToggleSwitch } from "./primitives";

type FigureFollowUp = (message: string) => boolean;
type Preview = { kind: "closed" | "loading" | "failed" } | {
  kind: "ready";
  document: FigurePreviewDocument;
  followUp?: FigureFollowUp;
  loadedImages: ReadonlySet<string>;
};

function refreshable(binding: Binding): RefreshableBinding | undefined {
  return binding.type === "tool" || binding.type === "library" ? binding : undefined;
}

export function InlineFigureCard(props: {
  figure: InlineFigureDirective;
  turn?: TranscriptTurnView;
  onOpenPath: (path: string) => void;
  captureSession?: () => FigureSession | undefined;
}) {
  const state = signal<Preview>({ kind: "closed" });
  const sourcesOpen = signal(false);
  const loadingStreet = signal(false);
  const streetLoadError = signal(false);
  const liveValues = signal<Record<string, BoundValue>>({});
  const resourceReader = signal<ReturnType<typeof createFigureResourceBinding> | null>(null);
  const sessionReader = signal<ReturnType<typeof createFigureSessionBinding> | null>(null);
  const notice = signal<"chat.figures.saveFailed" | "chat.figures.draftUnavailable" | null>(null);
  const imageLoader = signal<FigureImageLoader | null>(null);
  const title = () => props.figure.title || props.figure.slug;
  const summary = () => publishedFigure(props.turn, props.figure.path);
  let revision = 0;
  let frame: WebViewRef | undefined;
  let streetRequest: AbortController | undefined;
  let previewRequest: AbortController | undefined;
  let lastImages: { key: string; source: string; values: LoadedFigureImages } | undefined;
  cleanup(() => {
    revision += 1;
    streetRequest?.abort();
    previewRequest?.abort();
    lastImages = undefined;
    resourceReader()?.dispose();
    sessionReader()?.dispose();
  });
  effect(() => {
    const reader = sessionReader();
    if (!reader) return;
    const turns = reader.session.turns();
    queueMicrotask(() => reader.observe(turns));
  });

  function clearPreviewBindings() {
    resourceReader()?.dispose();
    resourceReader.set(null);
    sessionReader()?.dispose();
    sessionReader.set(null);
    liveValues.set({});
  }

  function cancelStreetRequest() {
    streetRequest?.abort();
    streetRequest = undefined;
    loadingStreet.set(false);
  }

  function close() {
    revision += 1;
    cancelStreetRequest();
    previewRequest?.abort();
    lastImages = undefined;
    clearPreviewBindings();
    state.set({ kind: "closed" });
  }

  async function open() {
    const turn = props.turn;
    if (!turn || !summary()) return;
    const uri = props.figure.path;
    const session = props.captureSession?.();
    const request = ++revision;
    previewRequest?.abort();
    const loading = new AbortController();
    previewRequest = loading;
    cancelStreetRequest();
    clearPreviewBindings();
    sourcesOpen.set(false);
    notice.set(null);
    streetLoadError.set(false);
    state.set({ kind: "loading" });
    try {
      const { source, readerKey, bindings, owner, bindingRefreshSupported } = await readPublishedFigureSource(turn, uri);
      if (request !== revision) return;
      const sameSource = () => backendConnection() === owner.connection && props.figure.path === uri &&
        props.turn?.turnId === turn.turnId && props.turn.turnIndex === turn.turnIndex && figureTurnOwnedBy(props.turn, owner);
      if (!sameSource()) { close(); return; }
      const prior = lastImages?.key === readerKey && lastImages.source === source ? lastImages.values : undefined;
      const localized = hasFigureDeclaration(source) ? null
        : await localizeFigureImages(source, bindings, loading.signal, imageLoader.set, prior);
      if (request !== revision) return;
      if (!sameSource()) { close(); return; }
      const document = await untracked(() => createFigurePreviewDocument(source, readerKey, !!session, title(), {
        bindings: localized?.bindings ?? bindings,
        signal: loading.signal,
      }));
      if (request === revision) {
        if (!sameSource()) { close(); return; }
        const current = () => request === revision && state().kind === "ready" && sameSource();
        resourceReader.set(createFigureResourceBinding(owner, current, publishLive));
        if (localized) lastImages = { key: readerKey, source, values: localized.loaded };
        state.set({ kind: "ready", document, followUp: session?.appendDraft, loadedImages: localized?.names ?? new Set() });
        if (session && document.bindingNonce && bindingRefreshSupported && document.sources?.length) {
          sessionReader.set(createFigureSessionBinding({
            owner, original: turn, uri, readerKey, session, sources: document.sources, current, publish: publishLive,
          }));
        }
      }
    } catch {
      if (request === revision) state.set({ kind: "failed" });
    } finally {
      if (previewRequest === loading) previewRequest = undefined;
    }
  }

  const document = () => {
    const preview = state();
    return preview.kind === "ready" ? preview.document : undefined;
  };
  const sources = () => document()?.sources ?? [];
  const loadedImage = (name: string) => {
    const preview = state();
    return preview.kind === "ready" && preview.loadedImages.has(name);
  };
  const supportsResources = () => !!document()?.bindingNonce && resourceReader()?.available() === true;

  function publishLive(name: string, value: BoundValue) {
    const nonce = document()?.bindingNonce;
    if (!nonce) return false;
    const next = { ...liveValues(), [name]: value };
    const message = bindingUpdate(nonce, next);
    if (!message) return false;
    liveValues.set(next);
    frame?.postMessage(message);
    return true;
  }

  async function loadStreetMap() {
    const preview = state();
    if (preview.kind !== "ready" || !preview.document.streetMap || streetRequest) return;
    const controller = new AbortController();
    streetRequest = controller;
    loadingStreet.set(true);
    streetLoadError.set(false);
    try {
      const next = await preview.document.streetMap.load(controller.signal);
      if (!controller.signal.aborted && state() === preview) state.set({ ...preview, document: next });
    } catch {
      if (!controller.signal.aborted && state() === preview) streetLoadError.set(true);
    } finally {
      if (streetRequest === controller) {
        streetRequest = undefined;
        loadingStreet.set(false);
      }
    }
  }

  function receive(message: string, current: FigurePreviewDocument) {
    const preview = state();
    if (preview.kind !== "ready" || preview.document !== current || !current.reader) return;
    const event = parseFigureReaderEvent(message, current.reader.nonce);
    if (event?.type === "state") {
      void writeFigureReaderState(current.reader.key, event.state).then(
        () => { if (document() === current && notice() === "chat.figures.saveFailed") notice.set(null); },
        () => { if (document() === current) notice.set("chat.figures.saveFailed"); },
      );
    } else if (event?.type === "followUp" && preview.followUp) {
      if (preview.followUp(event.message)) close();
      else notice.set("chat.figures.draftUnavailable");
    }
  }

  return (
    <View
      testID={`inline-figure-${props.figure.slug}`}
      style={{
        flexDirection: "row", alignItems: "center", gap: space.sm,
        paddingHorizontal: space.md, paddingVertical: space.sm,
        borderRadius: radii.md, borderCurve: "continuous", borderWidth: 1,
        borderColor: palette().borderSubtle, backgroundColor: palette().surfaceTertiary,
      }}
    >
      <Icon name="sparkles" size={14} color={palette().accent} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ ...textStyle("label", { color: palette().text }), numberOfLines: 1, textOverflow: "ellipsis" }}>
          {title()}
        </Text>
        <Text style={{
          color: palette().textMuted, fontFamily: fontMono(), fontSize: textSize(11),
          lineHeight: textLineHeight(11, 1.3), numberOfLines: 1, textOverflow: "ellipsis-middle",
        }}>
          {props.figure.path}
        </Text>
      </View>
      <If when={summary()}>
        <Button label={tr("common.preview")} variant="ghost" size="xs"
          accessibilityLabel={`preview-figure-${props.figure.slug}`} onPress={() => void open()} />
      </If>
      <If when={!props.figure.path.startsWith("openbitfun://")}>
        <Button label={tr("common.open")} variant="ghost" size="xs"
          accessibilityLabel={`open-figure-${props.figure.slug}`} onPress={() => props.onOpenPath(props.figure.path)} />
      </If>
      <Button label={tr("pane.files.copyPath")} variant="ghost" size="xs"
        accessibilityLabel={`copy-figure-${props.figure.slug}`}
        onPress={() => void Clipboard.writeText(props.figure.path).then(
          () => pushToast(tr("common.copied"), "success"),
          () => undefined,
        )}
      />
      <ModalDialog open={state().kind !== "closed"} title={title()} size="xl"
        accessibilityLabel="inline-figure-preview" onClose={close}>
        <If when={imageLoader()}>
          {loader => (
            <WebView html={loader().html} incognito accessibilityElementsHidden
              onMessage={event => loader().receive(event.data)} onError={() => loader().fail()}
              style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
          )}
        </If>
        <If when={state().kind === "loading"}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.md }}>
            <BrandSpinner size={12} variant="matrix" />
            <Text style={textStyle("label", { color: palette().textMuted })}>{tr("common.loading")}</Text>
          </View>
        </If>
        <If when={state().kind === "failed"}>
          <View style={{ gap: space.sm }}>
            <InlineBanner tone="danger" message={tr("chat.figures.previewUnavailable")} />
            <Button label={tr("common.tryAgain")} variant="ghost" size="sm" onPress={() => void open()} />
          </View>
        </If>
        <If when={document()?.invalidBindings}>
          <InlineBanner tone="warning" message={tr("chat.figures.sources.invalid")} />
        </If>
        <If when={sources().some(row => row.declaration.type === "image" && !row.available)}>
          <View style={{ gap: space.xs, alignItems: "flex-start" }}>
            <InlineBanner tone="warning" message={tr("chat.figures.sources.imagesUnavailable")} />
            <Button size="xs" variant="ghost" label={tr("common.tryAgain")}
              accessibilityLabel="figure-retry-images" onPress={() => void open()} />
          </View>
        </If>
        <If when={sources().length > 0}>
          <View style={{ alignSelf: "flex-start" }}>
            <Button label={tr("chat.figures.sources.title")} size="sm"
              variant={sourcesOpen() ? "secondary" : "ghost"} accessibilityLabel="figure-data-sources"
              onPress={() => sourcesOpen.set(!sourcesOpen())} />
          </View>
          <If when={sourcesOpen()}>
            <Scroll accessibilityLabel={tr("chat.figures.sources.title")} style={{ maxHeight: 168, alignSelf: "stretch" }}>
              <View style={{ gap: space.sm }}>
                <Each of={sources()} key={row => row.name}>
                  {row => (
                    <View style={{ gap: space.xs, padding: space.sm, backgroundColor: palette().surfaceSubtle, borderRadius: radii.sm }}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                        <Text style={textStyle("label")}>{row().name}</Text>
                        <Badge tone={Object.hasOwn(liveValues(), row().name) || row().available ? "success" : "warning"}
                          label={tr(Object.hasOwn(liveValues(), row().name) ? "chat.figures.sources.updated"
                            : row().available ? loadedImage(row().name) ? "chat.figures.sources.imageLoaded" : "chat.figures.sources.saved"
                              : "chat.figures.sources.unavailable")} />
                      </View>
                      <If when={refreshable(row().declaration)}>
                        {binding => (
                          <>
                            <If when={resourceReader()}>
                              {reader => <FigureResourceControls name={row().name} binding={binding()}
                                reader={reader()} supported={supportsResources()} />}
                            </If>
                            <If when={sessionReader()}>
                              {reader => (
                                <View style={{ gap: space.xs }}>
                                  <ToggleSwitch value={reader().isWatching(row().name)}
                                    label={tr("chat.figures.sources.watchSession", {
                                      seconds: formatCount(binding().refreshIntervalSeconds),
                                    })}
                                    accessibilityLabel={`figure-watch-session-${row().name}`}
                                    onChange={enabled => reader().watch(row().name, binding(), enabled)} />
                                  <If when={reader().watchFailed(row().name)}>
                                    <Text style={textStyle("smallBody", { color: palette().textMuted })}>
                                      {tr("chat.figures.sources.watchFailed")}
                                    </Text>
                                  </If>
                                  <View style={{ alignSelf: "flex-start" }}>
                                    <Button size="xs" variant="secondary" label={tr("chat.figures.sources.refreshSource")}
                                      accessibilityLabel={`figure-refresh-source-${row().name}`}
                                      onPress={() => {
                                        if (reader().request(row().name, binding())) close();
                                        else notice.set("chat.figures.draftUnavailable");
                                      }} />
                                  </View>
                                  <If when={reader().feedback(row().name)}>
                                    {phase => <Text style={textStyle("smallBody", { color: palette().textMuted })}>
                                      {tr(phase() === "pending" ? "chat.figures.sources.refreshPending"
                                        : phase() === "noResult" ? "chat.figures.sources.refreshNoResult"
                                          : "chat.figures.sources.refreshFailed")}
                                    </Text>}
                                  </If>
                                </View>
                              )}
                            </If>
                          </>
                        )}
                      </If>
                      <Text style={{ fontFamily: fontMono(), fontSize: textSize(12), lineHeight: textLineHeight(12, 1.45),
                        color: palette().textMuted }}>{JSON.stringify(row().declaration, null, 2)}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </Scroll>
          </If>
        </If>
        <If when={document()?.streetMap}>
          {street => (
            <View style={{ gap: space.sm }}>
              <InlineBanner tone={street().failed || streetLoadError() ? "warning" : "info"}
                message={tr(street().failed || streetLoadError() ? "chat.figures.map.streetLoadFailed" : "chat.figures.map.streetUnavailable")} />
              <View style={{ alignSelf: "flex-start" }}>
                <Button label={tr("chat.figures.map.loadStreet")} loading={loadingStreet()}
                  accessibilityLabel="figure-load-street-map" size="sm"
                  onPress={() => void loadStreetMap()} />
              </View>
            </View>
          )}
        </If>
        <If when={document()}>
          {current => (
            <WebView html={current().html} src={current().src} incognito accessibilityLabel="inline-figure-document"
              ref={ref => { frame = ref; }}
              onMessage={current().reader ? event => receive(event.data, current()) : undefined}
              onLoad={({ url }) => {
                if (document() !== current()) return;
                current().saveStreet?.();
                const bindingNonce = current().bindingNonce;
                if (bindingNonce && Object.keys(liveValues()).length) {
                  const message = bindingUpdate(bindingNonce, liveValues());
                  if (message) frame?.postMessage(message);
                }
                if (!current().inject) return;
                if (url && url !== "about:blank" && url !== "about:srcdoc" && !url.startsWith("data:text/html")) return;
                frame?.injectJavaScript(current().inject!);
              }}
              onError={() => {
                if (document() === current()) {
                  clearPreviewBindings();
                  state.set({ kind: "failed" });
                }
              }}
              style={{ alignSelf: "stretch", height: compactLayout() ? 400 : 520, borderRadius: radii.md, overflow: "hidden" }}
            />
          )}
        </If>
        <If when={notice()}>
          {key => <InlineBanner tone="warning" message={tr(key())} />}
        </If>
      </ModalDialog>
    </View>
  );
}
