import { Clipboard, openUrl, signal, View } from "nsh";
import { localTextFileExport } from "../bridge";
import { formatReviewMarkdown, type CodeReviewReport } from "../codeReviewReport";
import { localizeHostError, tr } from "../i18n";
import { space } from "../theme";
import {
  MarkdownDocumentEditor, MarkdownDocumentToolbar, MarkdownPreview,
  visualEditBlock, visualEditorAvailable, type MarkdownDocumentMode,
} from "./markdownEditor";
import { ModalDialog, pushToast } from "./overlays";
import { Button, IconButton, InlineConfirmBar, InputBox } from "./primitives";

export function ReviewMarkdownActions(props: { report: CodeReviewReport }) {
  const original = signal<string | null>(null);
  const draft = signal("");
  const mode = signal<MarkdownDocumentMode>("preview");
  const discarding = signal(false);
  const exporting = signal(false);
  const fileExport = localTextFileExport();
  const sharing = fileExport?.kind === "share";
  const exportLabel = () => tr(sharing ? "chat.review.shareMarkdown" : "chat.review.saveMarkdown");
  const title = () => tr("chat.review.report");

  async function copy(): Promise<void> {
    try {
      await Clipboard.writeText(formatReviewMarkdown(props.report));
      pushToast(tr("common.copied"), "success");
    } catch (error) {
      pushToast(localizeHostError(error), "error");
    }
  }

  function openEditor(): void {
    const markdown = formatReviewMarkdown(props.report);
    original.set(markdown);
    draft.set(markdown);
    mode.set(visualEditBlock(markdown) ? "source" : "visual");
    discarding.set(false);
  }

  function closeEditor(): void {
    if (exporting()) return;
    if (draft() !== original()) discarding.set(true);
    else original.set(null);
  }

  function chooseMode(next: MarkdownDocumentMode): void {
    if (next === "visual" && visualEditBlock(draft())) {
      mode.set("source");
      pushToast(tr("doc.sourceFallback"), "info");
      return;
    }
    mode.set(next);
  }

  async function exportMarkdown(markdown: string, fromEditor = false): Promise<void> {
    if (!fileExport || exporting()) return;
    exporting.set(true);
    try {
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const outcome = await fileExport.run({
        text: markdown, title: exportLabel(), fileName: `review-${timestamp}.md`,
      });
      if (outcome === "saved") {
        if (fromEditor) original.set(markdown);
        pushToast(tr("common.saved"), "success");
      }
      if (outcome === "started") pushToast(tr("chat.review.downloadStarted"), "info");
    } catch (error) {
      pushToast(localizeHostError(error), "error");
    } finally {
      exporting.set(false);
    }
  }

  return <>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.xs }}>
      <IconButton icon="copy" size="sm" tooltip={tr("doc.copyMarkdown")}
        accessibilityLabel="review-copy-markdown" onPress={() => void copy()} />
      <IconButton icon="external-link" size="sm" tooltip={tr("chat.review.openMarkdown")}
        accessibilityLabel="review-open-markdown" onPress={openEditor} />
      <If when={!!fileExport}>
        <IconButton icon={sharing ? "upload" : "download"} size="sm" tooltip={exportLabel()}
          accessibilityLabel={sharing ? "review-share-markdown" : "review-save-markdown"} disabled={exporting()}
          onPress={() => void exportMarkdown(formatReviewMarkdown(props.report))} />
      </If>
    </View>
    <ModalDialog open={original() !== null} title={title()} size="lg" accessibilityLabel="review-markdown-editor"
      keepOpenOnBackdrop={draft() !== original() || exporting()} onClose={closeEditor}
      footer={<View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
        <Button label={tr("common.close")} size="md" variant="secondary" disabled={exporting()}
          accessibilityLabel="review-editor-close" onPress={closeEditor} />
        <If when={!!fileExport}>
          <Button label={exportLabel()} size="md" variant="primary" loading={exporting()}
            accessibilityLabel={sharing ? "review-editor-share" : "review-editor-save"}
            onPress={() => void exportMarkdown(draft(), true)} />
        </If>
      </View>}>
      <View style={{ gap: space.sm }}>
        <MarkdownDocumentToolbar mode={mode()} markdown={draft()} onModeChange={chooseMode}
          sourceOnly={!visualEditorAvailable()}
          ids={{ preview: "review-editor-preview", visual: "review-editor-rich-text",
            source: "review-editor-source", copy: "review-editor-copy" }} />
        <If when={discarding()}>
          <InlineConfirmBar message={tr("common.discardChanges")} danger
            onCancel={() => discarding.set(false)}
            onConfirm={() => { discarding.set(false); original.set(null); }} />
        </If>
        <If when={mode() === "preview"}>
          <MarkdownPreview markdown={draft()} links="report" onLinkPress={event => {
            if (/^https?:\/\//i.test(event.url)) void openUrl(event.url).catch(error => pushToast(localizeHostError(error), "error"));
          }} />
        </If>
        <If when={mode() === "visual"}>
          <MarkdownDocumentEditor documentKey="review-export" text={draft()} onChange={draft.set}
            documentName={title()} accessibilityLabel="review-editor-document" />
        </If>
        <If when={mode() === "source"}>
          <InputBox multiline monospace minHeight={220} value={draft()} onChange={draft.set}
            accessibilityLabel="review-editor-text" />
        </If>
      </View>
    </ModalDialog>
  </>;
}
