import { cleanup, platform, Scroll, signal, Text, untracked, View, type InputRef, type ViewRef } from "nsh";
import { localBinaryFileExport } from "../bridge";
import { activeFileEditorOptions, openFile, setActiveFileEditorOptions } from "../fileStore";
import { formatCount } from "../format";
import { localizeHostError, tr } from "../i18n";
import { annotatedPdfPath, isPdfReviewAnnotation, MAX_REVIEW_PDF,
  type PdfReviewAnnotation, type PdfReviewColor, type PdfReviewTool } from "../pdfReviewData";
import { pdfReviewId, PdfReviewSession } from "../pdfReviewSession";
import { basenameOfPath, isRemoteWorkspace } from "../shared/workspaceUtils";
import { binaryFileHash, workspaceBinaryHash, writeWorkspaceBinary } from "../workspaceBinaryFile";
import { activeWorkspace, activeWorkspaceKey } from "../state";
import { palette, space, textStyle } from "../theme";
import { PdfDocumentViewer, type PdfCopyBlock, type PdfCopyFactory } from "./PdfDocumentViewer";
import { DropdownMenu, ModalDialog, pushToast } from "./overlays";
import { Button, IconButton, InlineBanner, InlineConfirmBar, InputBox, SegmentedTabs } from "./primitives";
import { Toolbar } from "./Toolbar";
import { createSceneWidth } from "./workbenchLayout";

const toolKeys = { select: "pdfReview.select", note: "pdfReview.note", highlight: "pdfReview.highlight", ink: "pdfReview.ink" } as const;
const tools = Object.keys(toolKeys) as PdfReviewTool[];
const colorKeys = { yellow: "pdfReview.yellow", green: "pdfReview.green", blue: "pdfReview.blue", pink: "pdfReview.pink" } as const;
const colors = Object.keys(colorKeys) as PdfReviewColor[];

export function PdfReviewWorkspace(props: { path: string; name: string; base64: string; blockInput?: boolean }) {
  const workspace = untracked(activeWorkspaceKey);
  if (!workspace) return <PdfDocumentViewer name={props.name} base64={props.base64} blockInput={props.blockInput} />;
  const path = untracked(() => props.path);
  const tabPath = untracked(() => openFile()?.path);
  const outputPath = annotatedPdfPath(path);
  const outputName = basenameOfPath(outputPath, untracked(() => isRemoteWorkspace(activeWorkspace())));
  const localExport = localBinaryFileExport();
  let disposed = false;
  cleanup(() => { disposed = true; });
  const sessions = untracked(() => activeFileEditorOptions()?.pdfReviews ?? {});
  const previous = Object.hasOwn(sessions, path) ? sessions[path] : null;
  const session = previous ?? new PdfReviewSession(workspace, path);
  if (!previous) untracked(() => setActiveFileEditorOptions({ pdfReviews: { ...sessions, [path]: session } }));
  void session.load();

  const reviewOpen = signal(Boolean(session.commentDraft()?.value.trim()));
  const selected = signal<string | undefined>(session.commentDraft()?.id);
  const tool = signal<PdfReviewTool>("select");
  const color = signal<PdfReviewColor>("yellow");
  const colorMenu = signal(false);
  const colorAnchor = signal<ViewRef | null>(null);
  const fingerprint = signal("");
  const canCopy = signal(false);
  const jump = signal<{ page: number } | undefined>(undefined);
  const replacing = signal(false);
  const resolving = signal(false);
  const copyFactory = signal<PdfCopyFactory | undefined>(undefined);
  const blockedCopy = signal<PdfCopyBlock | undefined>(undefined);
  const copying = signal<"workspace" | "controller" | null>(null);
  const copyError = signal("");
  const overwrite = signal<string | undefined>(undefined);
  const commentDialog = signal(false);
  // On Windows the PDF's child WebView keeps keyboard focus until the native dialog takes it.
  const separateComposer = platform.os === "windows";
  const scene = createSceneWidth();
  let commentInput: InputRef | null = null;
  const snapshot = session.snapshot;
  const data = () => snapshot().data;
  const editable = () => snapshot().loaded && !snapshot().readOnly && !snapshot().conflict;
  const ready = () => Boolean(fingerprint());
  const stale = () => data().annotations.length > 0 && !!data().fingerprint && ready() && data().fingerprint !== fingerprint();
  const active = () => data().annotations.find(item => selected() === item.id);
  const draft = () => session.commentDraft()?.id === selected() ? session.commentDraft()?.value ?? "" : "";
  const sideBySide = () => scene.width() >= 820;
  const canExport = () => editable() && ready() && Boolean(copyFactory()) && !copying();

  function assertCurrent() {
    const current = activeWorkspaceKey();
    if (disposed || current?.deviceId !== workspace?.deviceId || current?.workspaceId !== workspace?.workspaceId ||
        openFile()?.path !== tabPath) throw new Error("closed");
  }

  function describeCopyFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "encrypted") return tr("pdfReview.encrypted");
    if (message === "missing-page") return tr("pdfReview.missingPage");
    if (message === "pdf-too-large" || message === "review-too-large") return tr("pdfReview.copyTooLarge");
    if (message === "unreadable") return tr("pdfReview.copyUnavailable");
    if (message === "destination-is-directory") return tr("pdfReview.destinationDirectory");
    if (message === "timeout") return tr("pdfReview.copyTimeout");
    return localizeHostError(error);
  }

  async function saveCopy(destination: "workspace" | "controller", confirmedHash?: string) {
    const factory = copyFactory();
    if (!workspace || !factory || !canExport() || !session.commitDraft()) return;
    copying.set(destination);
    copyError.set("");
    overwrite.set(undefined);
    try {
      let expectedHash = "";
      if (destination === "workspace") {
        await session.save();
        assertCurrent();
        if (session.hasPending() || !editable()) throw new Error(tr("pdfReview.saveNotesFirst"));
        expectedHash = await workspaceBinaryHash(workspace, outputPath, MAX_REVIEW_PDF);
        assertCurrent();
        if (expectedHash && expectedHash !== (confirmedHash ?? session.exportedHash)) {
          overwrite.set(expectedHash);
          return;
        }
      }
      const base64 = await factory({ ...data(), fingerprint: data().fingerprint || fingerprint() });
      assertCurrent();
      if (destination === "controller") {
        if (!localExport) return;
        const action = await localExport.run({
          title: tr("pdfReview.exportCopy"), fileName: outputName, base64, mimeType: "application/pdf",
        });
        if (!disposed && action !== "cancelled") pushToast(tr("pdfReview.copyExported"), "success");
      } else {
        const sha256 = await binaryFileHash(base64);
        await writeWorkspaceBinary({ workspace, path: outputPath, base64, sha256, expectedHash, assertCurrent });
        session.exportedHash = sha256;
        pushToast(tr("pdfReview.copySaved", { name: outputName }), "success");
      }
    } catch (error) {
      if (disposed || String(error).includes("Error: closed")) return;
      if (destination === "workspace" && String(error).includes("FILE_CONFLICT")) {
        try {
          const current = await workspaceBinaryHash(workspace, outputPath, MAX_REVIEW_PDF);
          assertCurrent();
          if (current) overwrite.set(current);
          else copyError.set(tr("pdfReview.destinationChanged"));
        } catch (failure) {
          if (!disposed) copyError.set(describeCopyFailure(failure));
        }
      } else {
        copyError.set(describeCopyFailure(error));
      }
    } finally {
      if (!disposed) copying.set(null);
    }
  }

  function select(id: string, navigate = false) {
    const annotation = data().annotations.find(item => item.id === id);
    if (!annotation || (id !== selected() && !session.commitDraft())) return;
    selected.set(id);
    tool.set("select");
    reviewOpen.set(true);
    if (navigate) jump.set({ page: annotation.page });
  }

  function add(message: Record<string, unknown>) {
    if (!reviewOpen() || !editable() || !ready() || message.kind !== tool()) return;
    if (message.kind === "highlight" && !canCopy()) return;
    const candidate = { id: pdfReviewId(), kind: message.kind, page: message.page, rect: message.rect,
      quads: message.quads, strokes: message.strokes, quote: message.quote, color: color(),
      comments: [], createdAt: new Date().toISOString() };
    if (!isPdfReviewAnnotation(candidate) || !session.commitDraft()) return;
    if (session.replace([...data().annotations, candidate], fingerprint()) && candidate.kind === "note") {
      select(candidate.id);
      if (separateComposer) commentDialog.set(true);
      else requestAnimationFrame(() => commentInput?.focus());
    }
  }

  function modify(current: PdfReviewAnnotation, next?: PdfReviewAnnotation) {
    if (!session.commitDraft()) return;
    if (session.replace(data().annotations.flatMap(annotation => {
      if (annotation.id !== current.id) return [annotation];
      return next ? [{ ...annotation, resolved: next.resolved }] : [];
    }), fingerprint()) && !next) selected.set(undefined);
  }

  async function resolve(action: "keep" | "reload") {
    if (resolving()) return;
    resolving.set(true);
    replacing.set(false);
    try {
      if (action === "keep") await session.keepLocal();
      else await session.reloadHost();
    } finally {
      resolving.set(false);
    }
  }

  function commentField() {
    return <InputBox value={draft()} multiline inputRef={ref => { commentInput = ref; }} onChange={value => {
      const id = selected();
      if (id) session.commentDraft.set({ id, value, commentId: session.commentDraft()?.commentId });
    }} accessibilityLabel="pdf-review-comment" placeholder={tr("pdfReview.comment")} readonly={!editable()} />;
  }

  function replyButton() {
    return <Button size="xs" variant="primary" label={tr(session.commentDraft()?.commentId ? "pdfReview.saveComment" : "pdfReview.reply")}
      accessibilityLabel="pdf-review-reply" disabled={!editable() || !draft().trim()} onPress={() => {
        if (session.commitDraft()) commentDialog.set(false);
      }} />;
  }

  return <View onLayout={scene.onLayout} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
    <Toolbar size="sm"
      leading={<Button size="xs" leadingIcon="chat" variant={reviewOpen() ? "secondary" : "ghost"}
        accessibilityLabel="pdf-review-toggle" label={tr("pdfReview.review")} onPress={() => {
          if (reviewOpen()) {
            session.commitDraft();
            tool.set("select");
          }
          reviewOpen.set(!reviewOpen());
        }} />}
      trailing={<If when={snapshot().saving || snapshot().dirty}>
        <Text style={textStyle("caption", { color: palette().textMuted })}>
          {tr(snapshot().saving ? "common.saving" : "pdfReview.unsaved")}
        </Text>
      </If>} />
    <If when={stale()}>
      <InlineBanner tone="warning" message={tr("pdfReview.layoutChanged")} actionLabel={tr("pdfReview.confirmLayout")}
        onAction={editable() ? () => session.confirmLayout(fingerprint()) : undefined} />
    </If>
    <If when={reviewOpen()}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs,
        padding: space.sm, borderBottomWidth: 1, borderColor: palette().borderSubtle }}>
        <SegmentedTabs size="sm" value={tool()} onChange={tool.set} options={tools.map(value => ({
          value, label: tr(toolKeys[value]), accessibilityLabel: "pdf-review-tool-" + value,
          disabled: value !== "select" && (!editable() || !ready() || (value === "highlight" && !canCopy())),
        }))} />
        <View ref={colorAnchor.set}>
          <Button size="xs" variant="ghost" label={tr(colorKeys[color()])} trailingIcon="chevron-down"
            accessibilityLabel="pdf-review-color" onPress={() => colorMenu.set(!colorMenu())} />
          <DropdownMenu open={colorMenu()} anchor={colorAnchor()} onClose={() => colorMenu.set(false)} items={colors.map(value => ({
            id: value, label: tr(colorKeys[value]), active: value === color(), onSelect: () => color.set(value),
          }))} />
        </View>
        <IconButton icon="undo" size="xs" accessibilityLabel="pdf-review-undo" tooltip={tr("shell.menu.undo")}
          disabled={!editable() || !snapshot().canUndo} onPress={() => session.undo()} />
        <IconButton icon="redo" size="xs" accessibilityLabel="pdf-review-redo" tooltip={tr("shell.menu.redo")}
          disabled={!editable() || !snapshot().canRedo} onPress={() => session.redo()} />
        <Button size="xs" label={tr("pdfReview.saveCopy")} accessibilityLabel="pdf-review-save-copy"
          disabled={!canExport()} loading={copying() === "workspace"} onPress={() => void saveCopy("workspace")} />
        <If when={Boolean(localExport)}>
          <Button size="xs" variant="ghost" leadingIcon={localExport?.kind === "share" ? "upload" : "download"}
            label={tr(localExport?.kind === "share" ? "pdfReview.shareCopy" : "pdfReview.exportCopy")}
            accessibilityLabel="pdf-review-export-copy" disabled={!canExport()} loading={copying() === "controller"}
            onPress={() => void saveCopy("controller")} />
        </If>
      </View>
      <If when={blockedCopy() || copyError()}>
        <InlineBanner tone="warning" message={copyError() || tr(blockedCopy() === "encrypted"
          ? "pdfReview.encrypted" : "pdfReview.copyUnavailable")} />
      </If>
      <If when={overwrite()}>
        {hash => <InlineConfirmBar danger message={tr("pdfReview.replaceCopy", { name: outputName })}
          confirmLabel={tr("pdfReview.replaceCopyAction")} cancelLabel={tr("common.cancel")}
          onCancel={() => overwrite.set(undefined)} onConfirm={() => void saveCopy("workspace", hash())} />}
      </If>
      <If when={snapshot().conflict}>
        <InlineBanner tone="warning" message={tr("pdfReview.conflict")} action={<>
          <Button size="xs" label={tr("pdfReview.reload")} accessibilityLabel="pdf-review-reload" disabled={resolving()}
            onPress={() => void resolve("reload")} />
          <Button size="xs" label={tr("pdfReview.keep")} accessibilityLabel="pdf-review-keep"
            disabled={!snapshot().conflictReadable || resolving()} onPress={() => replacing.set(true)} />
        </>} />
        <If when={replacing()}>
          <InlineConfirmBar danger message={tr("pdfReview.replaceConfirm")} confirmLabel={tr("pdfReview.keep")}
            cancelLabel={tr("common.cancel")} onCancel={() => replacing.set(false)} onConfirm={() => void resolve("keep")} />
        </If>
      </If>
      <If when={snapshot().error}>
        {failure => <InlineBanner tone="warning" message={localizeHostError(failure())}
          actionLabel={tr("common.retry")} onAction={() => { if (snapshot().conflict) void resolve("reload"); else void session.retry(); }} />}
      </If>
    </If>
    <View style={{ flex: 1, flexDirection: sideBySide() ? "row" : "column", minHeight: 0, minWidth: 0 }}>
      <PdfDocumentViewer name={props.name} base64={props.base64} blockInput={props.blockInput}
        hideSurface={separateComposer && commentDialog()}
        review={{ tool: reviewOpen() && editable() ? tool() : "select", color: color(), selected: selected(), annotations: data().annotations }}
        reviewJump={jump()} onReviewReady={(hash, copy, embedded, blocked) => {
          if (embedded) session.importEmbedded(embedded);
          blockedCopy.set(blocked);
          fingerprint.set(hash);
          canCopy.set(copy);
        }}
        onCopyFactory={copyFactory.set}
        onReviewSelect={select} onReviewAdd={add} />
      <If when={reviewOpen()}>
        <View style={{ width: sideBySide() ? 264 : "100%", maxHeight: sideBySide() ? undefined : 236,
          minHeight: 0, flexShrink: 0, backgroundColor: palette().panelRaised,
          borderLeftWidth: sideBySide() ? 1 : 0, borderTopWidth: sideBySide() ? 0 : 1, borderColor: palette().borderSubtle }}>
          <Scroll style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
            <View style={{ padding: space.sm, gap: space.sm }}>
              <If when={!data().annotations.length}>
                <Text style={textStyle("caption", { color: palette().textMuted })}>
                  {tr(tool() === "note" ? "pdfReview.placeNote" : "pdfReview.empty")}
                </Text>
              </If>
              <Each of={data().annotations} key={item => item.id}>{item => <View style={{ gap: space.xs }}>
                <Button size="xs" variant={selected() === item().id ? "secondary" : "ghost"}
                  accessibilityLabel={"pdf-review-thread-" + item().id} onPress={() => select(item().id, true)}
                  label={tr("pdfReview.thread", { page: formatCount(item().page), kind: tr(toolKeys[item().kind]) })} />
                <If when={item().quote}>{quote => <Text style={{ ...textStyle("caption",
                  { color: palette().textMuted }), numberOfLines: 3 }}>{quote()}</Text>}</If>
                <If when={item().resolved}>
                  <Text style={textStyle("caption", { color: palette().textMuted })}>{tr("pdfReview.resolved")}</Text>
                </If>
                <Each of={item().comments} key={comment => comment.id}>{comment =>
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.xs }}>
                    <Text style={{ ...textStyle("body", { color: palette().text }), flex: 1, minWidth: 0 }}>{comment().body}</Text>
                    <IconButton icon="edit" size="xs" tooltip={tr("pdfReview.editComment")}
                      accessibilityLabel={"pdf-review-edit-comment-" + comment().id} disabled={!editable()} onPress={() => {
                        if (!session.commitDraft()) return;
                        select(item().id);
                        session.commentDraft.set({ id: item().id, value: comment().body, commentId: comment().id });
                        if (separateComposer) commentDialog.set(true);
                      }} />
                  </View>
                }</Each>
              </View>}</Each>
            </View>
          </Scroll>
          <If when={active()}>{item => <View style={{ padding: space.sm, gap: space.xs, borderTopWidth: 1, borderColor: palette().borderSubtle }}>
            <If when={!separateComposer}>{commentField()}</If>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
              <If when={separateComposer} else={replyButton()}>
                <Button size="xs" variant="primary" label={tr("pdfReview.reply")} disabled={!editable()}
                  accessibilityLabel="pdf-review-open-reply" onPress={() => commentDialog.set(true)} />
              </If>
              <Button size="xs" label={tr(item().resolved ? "pdfReview.reopen" : "pdfReview.resolve")} disabled={!editable()}
                accessibilityLabel="pdf-review-resolve" onPress={() => modify(item(), { ...item(), resolved: !item().resolved })} />
              <IconButton icon="trash" size="xs" tooltip={tr("pdfReview.remove")} accessibilityLabel="pdf-review-remove"
                disabled={!editable()} onPress={() => modify(item())} />
            </View>
          </View>}</If>
        </View>
      </If>
    </View>
    <If when={separateComposer}>
      <ModalDialog open={commentDialog()} title={tr("pdfReview.comment")} size="sm" keepsInputOnClose
        onClose={() => commentDialog.set(false)} footer={<>
          <Button label={tr("common.cancel")} size="sm" variant="ghost" onPress={() => commentDialog.set(false)} />
          {replyButton()}
        </>}>
        {commentField()}
      </ModalDialog>
    </If>
  </View>;
}
