import { cleanup, Clipboard, effect, type Bounds, type PasteEvent } from "nsh";
import {
  createRichEditor, defineExtension, Document, HardBreak, Paragraph, RichEditor, RichEditorPlugin,
  history, keymap, type RichEditorRef, type RichNodeJSON,
} from "nsh/base";
import { promptReferenceParts, promptReferencesIn } from "../promptReferences";
import { inputFontSans, palette } from "../theme";
import { PromptReferenceCapsule } from "./PromptReferenceText";

const referenceNode = "promptReference";
const textNode = defineExtension({ name: "text", node: { group: "inline" } });
const referenceExtension = defineExtension({
  name: referenceNode,
  node: { inline: true, group: "inline", atom: true, selectable: true, attrs: { token: { default: "" } } },
  addOptions: () => ({ labelPrefix: "composer-prompt-reference" }),
  addNodeView: options => props => {
    const reference = () => promptReferencesIn(String(props.node.attrs.token))[0];
    return (
      <If when={reference()}>
        {item => <PromptReferenceCapsule reference={item()} labelPrefix={String(options.labelPrefix)} selected={props.selected} />}
      </If>
    );
  },
});

function draftDocument(text: string): RichNodeJSON {
  return {
    type: "doc",
    content: text.split(/\r\n?|\n/).map(line => ({
      type: "paragraph",
      content: promptReferenceParts(line).map(part => part.kind === "text"
        ? { type: "text", text: part.text }
        : { type: referenceNode, attrs: { token: part.token } }),
    })),
  };
}

/** Native positions count each reference atom once while the draft keeps its entire token. */
function draftProjection(doc: RichNodeJSON) {
  const spans: { text: string; width: number }[] = [];
  for (const [index, block] of (doc.content ?? []).entries()) {
    if (index > 0) spans.push({ text: "\n", width: 2 });
    for (const node of block.content ?? []) {
      if (node.type === referenceNode) spans.push({ text: String(node.attrs?.token ?? ""), width: 1 });
      else if (node.type === "hardBreak") spans.push({ text: "\n", width: 1 });
      else if (node.text) spans.push({ text: node.text, width: node.text.length });
    }
  }
  const translate = (value: number, toPosition: boolean) => {
    let offset = 0;
    let position = 1;
    for (const { text, width } of spans) {
      const start = toPosition ? offset : position;
      const end = start + (toPosition ? text.length : width);
      const target = toPosition ? position : offset;
      if (value < end) return target + (width === text.length ? Math.max(0, value - start) : 0);
      offset += text.length;
      position += width;
    }
    return toPosition ? position : offset;
  };
  return {
    text: spans.map(span => span.text).join(""),
    offsetAt: (position: number) => translate(position, false),
    positionAt: (offset: number) => translate(offset, true),
  };
}

export interface ComposerSelection {
  text: string;
  start: number;
  end: number;
}

export interface ComposerInputHandle {
  focus(): void;
  setSelection(start: number, end?: number): void;
  selection(): ComposerSelection | undefined;
}

let supported: boolean | undefined;
export function promptReferenceEditorAvailable(): boolean {
  if (supported === undefined) {
    try {
      createRichEditor({ extensions: [Document, Paragraph, textNode, referenceExtension] }).dispose();
      supported = true;
    } catch {
      supported = false;
    }
  }
  return supported;
}

export function PromptReferenceEditor(props: {
  draft: () => string;
  inputLabel: string;
  placeholder: string;
  disabled: boolean;
  fontSize: number;
  lineHeight: number;
  minHeight: number;
  maxHeight: number;
  labelPrefix?: string;
  pickerOpen?: () => boolean;
  onChange: (draft: string, caret: number) => void;
  onSelection?: (selection: ComposerSelection) => void;
  onCaretMove?: (bounds: Bounds) => void;
  onFocus?: () => void;
  onComposition?: (composing: boolean) => void;
  onMount?: (handle: ComposerInputHandle | undefined) => void;
  onSubmit?: () => void;
  onPickerKey?: (key: string) => void;
  onPaste?: (event: PasteEvent) => void;
}) {
  let ref: RichEditorRef | undefined;
  let composition = false;
  const submitKeys = new RichEditorPlugin("composer-enter").captureKeys(["Enter"], () => {
    if (props.disabled || composition || editor.composing) return;
    emitChange();
    props.onSubmit?.();
  });
  const pickerKeys = new RichEditorPlugin("composer-picker").captureKeys(
    ["ArrowUp", "ArrowDown", "Escape", "Tab"], key => {
      if (!composition && !editor.composing) props.onPickerKey?.(key);
    },
  );
  const clipboard = new RichEditorPlugin("composer-clipboard")
    .handlePaste((_slice, data) => {
      if (props.disabled) return true;
      if (!data.text) return false;
      if (!props.onPaste) {
        const selection = currentSelection();
        const text = data.text.replace(/\r\n?/g, "\n");
        const next = selection.text.slice(0, selection.start) + text + selection.text.slice(selection.end);
        editor.setContent(draftDocument(next), "json");
        const pos = draftProjection(editor.doc).positionAt(selection.start + text.length);
        ref?.setSelection(pos, pos);
        emitChange();
        return true;
      }
      props.onPaste({ ...data, files: [], uris: [], tooLarge: [] });
      return true;
    })
    .captureKeys(["Mod-c", "Mod-x"], key => {
      const selection = currentSelection();
      if (selection.end === selection.start) return;
      const version = editor.revision;
      void Clipboard.writeText(selection.text.slice(selection.start, selection.end)).then(() => {
        const current = currentSelection();
        if (key.toLowerCase().endsWith("x") && !props.disabled && editor.revision === version &&
          current?.start === selection.start && current.end === selection.end) {
          editor.run({ command: "deleteSelection" });
        }
      }).catch(error => console.warn("Could not copy the composer selection", error));
    });
  const behavior = defineExtension({
    name: "composerBehavior",
    priority: 1000,
    addProseMirrorPlugins: () => [submitKeys, pickerKeys, clipboard, history(), keymap({
      "Mod-z": { command: "undo" },
      "Mod-y": { command: "redo" },
      "Mod-Shift-z": { command: "redo" },
      "Alt-Enter": { command: "insertContent", content: { type: "hardBreak" } },
    })],
  });
  const references = props.labelPrefix ? referenceExtension.configure({ labelPrefix: props.labelPrefix }) : referenceExtension;
  const initialText = props.draft();
  const initialDoc = draftDocument(initialText);
  const end = draftProjection(initialDoc).positionAt(initialText.length);
  const editor = createRichEditor({
    doc: initialDoc,
    selection: { type: "text", anchor: end, head: end },
    extensions: [behavior, Document, Paragraph, textNode, HardBreak, references],
  });
  submitKeys.capturing = Boolean(props.onSubmit);
  clipboard.capturing = true;
  effect(() => { pickerKeys.capturing = Boolean(props.pickerOpen?.()); });
  let lastRevision = editor.revision;
  function currentSelection(): ComposerSelection {
    const snapshot = draftProjection(editor.doc);
    const selection = editor.selection;
    if (selection.type === "all") return { text: snapshot.text, start: 0, end: snapshot.text.length };
    const anchor = typeof selection.anchor === "number" ? selection.anchor : 1;
    const head = typeof selection.head === "number" ? selection.head : selection.type === "node" ? anchor + 1 : anchor;
    return { text: snapshot.text, start: snapshot.offsetAt(Math.min(anchor, head)), end: snapshot.offsetAt(Math.max(anchor, head)) };
  }
  function emitChange() {
    const snapshot = draftProjection(editor.doc);
    if (snapshot.text === props.draft()) return;
    lastRevision = editor.revision;
    props.onChange(snapshot.text, currentSelection().end);
  }
  effect(() => {
    const text = props.draft();
    if (text === draftProjection(editor.doc).text) return;
    editor.setContent(draftDocument(text), "json");
    lastRevision = editor.revision;
  });
  cleanup(() => {
    props.onMount?.(undefined);
    editor.dispose();
    behavior.dispose();
    if (references !== referenceExtension) references.dispose();
    submitKeys.dispose();
    pickerKeys.dispose();
    clipboard.dispose();
  });
  return (
    <RichEditor
      ref={value => {
        ref = value;
        props.onMount?.({
          focus: () => ref?.focus(),
          setSelection: (start, end = start) => {
            const snapshot = draftProjection(editor.doc);
            ref?.setSelection(snapshot.positionAt(start), snapshot.positionAt(end));
          },
          selection: currentSelection,
        });
      }}
      editor={editor}
      accessibilityLabel={props.inputLabel}
      placeholder={props.placeholder}
      editable={!props.disabled}
      style={{ flex: 1, minWidth: 0, minHeight: props.minHeight, maxHeight: props.maxHeight }}
      styles={{
        content: { padding: 0, color: palette().text, fontFamily: inputFontSans(), fontSize: props.fontSize, lineHeight: props.lineHeight },
        nodes: { paragraph: { margin: 0, padding: 0 } },
        caret: { backgroundColor: palette().accent },
        placeholder: { color: palette().textMuted },
      }}
      onChange={event => {
        if (event.change.revision > lastRevision) emitChange();
      }}
      onSelectionChange={({ selection }) => {
        props.onSelection?.(currentSelection());
        if (props.onCaretMove) {
          const rect = editor.pageCoordsAtPos(selection.head) as { x: number; y: number; width: number; height: number } | null;
          if (rect) props.onCaretMove({ origin: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } });
        }
      }}
      onPasteFiles={props.onPaste ? ({ paste }) => props.onPaste?.({
        text: "", html: "", uris: paste.uris, tooLarge: [],
        files: paste.files.map(file => new File([file.data], file.name, { type: file.mime })),
      }) : undefined}
      onFocus={props.onFocus}
      onCompositionChange={event => {
        composition = event.composing;
        props.onComposition?.(composition);
      }}
    />
  );
}
