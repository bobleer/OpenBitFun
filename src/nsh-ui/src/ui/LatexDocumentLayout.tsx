import { cleanup, effect, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import { rendererAssets } from "../documentRenderers";
import { activeFileEditorOptions, editingContent, fileSaving, hasUnsavedEdit, openFile,
  saveEditedFile, setActiveFileEditorOptions } from "../fileStore";
import { localizeHostError, tr } from "../i18n";
import { compileWorkspaceLatex, latexMainPath, latexPreviewSupported, latexRootHint, type LatexEngine,
  type LatexPaneMode, type LatexTabView } from "../latexDocument";
import { basenameOfPath, isRemoteWorkspace } from "../shared/workspaceUtils";
import { activeWorkspace, activeWorkspaceKey } from "../state";
import { palette, space, textStyle } from "../theme";
import { PdfReviewWorkspace } from "./PdfReviewWorkspace";
import { Button, EmptyStateCard, InlineBanner, InputBox, SegmentedTabs, SplitHandle, splitDragging, ToggleSwitch } from "./primitives";
import { Toolbar } from "./Toolbar";
import { createSceneWidth } from "./workbenchLayout";

type BuildInput = NonNullable<LatexTabView["lastAttempt"]>;

export function LatexDocumentLayout(props: { path: string; renderSource: () => JSX.Element }) {
  const retained = untracked(() => activeFileEditorOptions()?.latex);
  const engine = signal<LatexEngine>(retained?.engine ?? "pdflatex");
  const auto = signal(retained?.auto ?? false);
  const mode = signal<LatexPaneMode>(retained?.mode ?? "split");
  const root = signal(retained?.root ?? "");
  const rootDraft = signal(retained?.rootDraft ?? "");
  const build = signal<LatexTabView["build"]>(retained?.build ?? null);
  const log = signal(retained?.log ?? "");
  const logOpen = signal(retained?.logOpen ?? false);
  const error = signal(retained?.error ?? "");
  const compiling = signal(false);
  const divider = signal(retained?.divider ?? 0.5);
  const scene = createSceneWidth();
  const workspace = untracked(activeWorkspaceKey);
  const sourcePath = untracked(() => props.path);
  let mounted = true;
  let lastAttempt = retained?.lastAttempt;
  let revision = retained?.build?.revision ?? 0;
  cleanup(() => { mounted = false; });

  const ownsSource = () => {
    const current = activeWorkspaceKey();
    return mounted && current?.deviceId === workspace?.deviceId && current?.workspaceId === workspace?.workspaceId &&
      openFile()?.path === sourcePath;
  };
  const supported = () => Boolean(workspace?.workspaceId) && latexPreviewSupported(workspace?.deviceId) &&
    Boolean(rendererAssets()?.pdfScript);
  const remote = () => isRemoteWorkspace(activeWorkspace());
  const source = () => editingContent() ?? openFile()?.content ?? "";
  const hint = () => latexRootHint(source());
  const mainPath = () => latexMainPath(sourcePath, root() || hint(), remote());
  const narrow = () => scene.stacked() || (scene.width() > 0 && scene.width() < 700);
  const canSplit = () => !narrow() && mode() === "split";
  const showSource = () => mode() !== "preview";
  const showPreview = () => mode() === "preview" || canSplit();
  const sourceWidth = () => Math.max(240, Math.min(scene.width() - 340, scene.width() * divider()));

  effect(() => {
    if (!ownsSource()) return;
    const view: LatexTabView = { engine: engine(), auto: auto(), mode: mode(), root: root(), rootDraft: rootDraft(),
      divider: divider(), build: build(), log: log(), logOpen: logOpen(), error: error(), lastAttempt };
    untracked(() => setActiveFileEditorOptions({ latex: view }));
  });

  function currentInput(): BuildInput {
    return { path: mainPath(), engine: engine(), source: source() };
  }

  async function compile(manual: boolean) {
    if (!workspace?.workspaceId || !ownsSource() || !supported() || compiling() || fileSaving()) return;
    if (manual) root.set(rootDraft().trim());
    const requested = currentInput();
    lastAttempt = requested;
    compiling.set(true);
    error.set("");
    try {
      if (hasUnsavedEdit()) await saveEditedFile();
      if (!ownsSource()) return;
      if (hasUnsavedEdit() || openFile()?.content !== requested.source) {
        if (manual) error.set(tr("doc.latexSaveBeforeBuild"));
        return;
      }
      const reply = await compileWorkspaceLatex(workspace.workspaceId, workspace.deviceId || undefined,
        requested.path, requested.engine);
      if (!ownsSource()) return;
      if (typeof reply?.pdfBase64 !== "string" || !reply.pdfBase64) throw new Error(tr("doc.pdfUnavailable"));
      const name = basenameOfPath(requested.path, remote()).replace(/\.tex$/i, "") + ".pdf";
      build.set({ base64: reply.pdfBase64, name, path: requested.path, revision: ++revision });
      log.set(reply.log ?? "");
      if (manual && narrow()) mode.set("preview");
    } catch (problem) {
      if (ownsSource()) {
        const diagnostic = localizeHostError(problem);
        error.set(diagnostic.split(/\r?\n/, 1)[0] || tr("doc.latexBuildFailed"));
        log.set(diagnostic);
      }
    } finally {
      if (mounted) compiling.set(false);
    }
  }

  effect(() => {
    if (!auto() || !supported() || compiling() || fileSaving() || !ownsSource()) return;
    const next = currentInput();
    if (lastAttempt?.path === next.path && lastAttempt.engine === next.engine && lastAttempt.source === next.source) return;
    const pending = setTimeout(() => void compile(false), 500);
    cleanup(() => clearTimeout(pending));
  });

  const modes = () => [
    { value: "source" as const, label: tr("doc.source"), accessibilityLabel: "file-tex-source" },
    ...(!narrow() ? [{ value: "split" as const, label: tr("doc.latexSplit"), accessibilityLabel: "file-tex-split" }] : []),
    { value: "preview" as const, label: tr("files.preview"), accessibilityLabel: "file-tex-preview" },
  ];

  return <View onLayout={scene.onLayout} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
    <Toolbar size="sm" leading={<SegmentedTabs size="sm" options={modes()}
      value={narrow() && mode() === "split" ? "source" : mode()} onChange={mode.set} />}
      trailing={<>
        <Button label={tr("doc.latexLog")} size="xs" variant={logOpen() ? "secondary" : "ghost"}
          accessibilityLabel="file-tex-log" disabled={!log()} onPress={() => logOpen.set(!logOpen())} />
        <Button label={tr(compiling() ? "doc.latexBuilding" : "doc.latexBuild")} variant="primary" size="xs"
          accessibilityLabel="file-tex-build" disabled={!supported() || compiling() || fileSaving()}
          onPress={() => void compile(true)} />
      </>} />
    <View style={{ flexDirection: "row", padding: space.sm, gap: space.sm, flexWrap: "wrap", alignItems: "center",
      flexShrink: 0, borderBottomWidth: 1, borderColor: palette().borderSubtle }}>
      <View style={{ flex: 1, minWidth: 145 }}>
        <InputBox size="sm" value={rootDraft()} onChange={rootDraft.set} onSubmit={value => root.set(value.trim())}
          accessibilityLabel="file-tex-main" placeholder={hint() || basenameOfPath(sourcePath, remote())}
          accessibilityDescription={tr("doc.latexMainFile")} />
      </View>
      <SegmentedTabs size="sm" value={engine()} onChange={engine.set} options={[
        { value: "pdflatex", label: "pdfLaTeX", accessibilityLabel: "file-tex-engine-pdf" },
        { value: "xelatex", label: "XeLaTeX", accessibilityLabel: "file-tex-engine-xe" },
      ]} />
      <ToggleSwitch checked={auto()} label={tr("doc.latexAutoBuild")} accessibilityLabel="file-tex-auto"
        disabled={!supported()} onChange={auto.set} />
    </View>
    <If when={!supported() || error()}>
      <InlineBanner tone={error() ? "warning" : "neutral"}
        message={error() ? (build() ? tr("doc.latexPreviousBuild") + " " : "") + error() : tr("doc.latexUnavailable")} />
    </If>
    <If when={logOpen() && log()}>
      <Scroll style={{ maxHeight: 160, borderBottomWidth: 1, borderColor: palette().borderSubtle }}>
        <Text style={{ ...textStyle("monoBlock", { color: palette().textMuted }), padding: space.md, userSelect: "text" }}>
          {log()}
        </Text>
      </Scroll>
    </If>
    <View style={{ flex: 1, flexDirection: "row", minWidth: 0, minHeight: 0 }}>
      <View style={{ display: showSource() ? "flex" : "none", minWidth: 0, minHeight: 0,
        flexBasis: canSplit() ? sourceWidth() : 0, flexGrow: canSplit() ? 0 : 1 }}>
        {props.renderSource()}
      </View>
      <If when={canSplit()}>
        <SplitHandle accessibilityLabel={tr("doc.latexResize")} onReset={() => divider.set(0.5)}
          onDelta={dx => divider.set((sourceWidth() + dx) / Math.max(1, scene.width()))} />
      </If>
      <If when={showPreview()}>
        <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <If when={build()} else={<View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.md }}>
            <EmptyStateCard icon="file-text" title={tr("doc.latexPdfPreview")} subtitle={tr("doc.latexBuildToPreview")} />
          </View>}>
            {output => <Each of={[output().revision]} key={value => value}>{() =>
              <PdfReviewWorkspace path={output().path} name={output().name} base64={output().base64} blockInput={splitDragging()} />
            }</Each>}
          </If>
        </View>
      </If>
    </View>
  </View>;
}
