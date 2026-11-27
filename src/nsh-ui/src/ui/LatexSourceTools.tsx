import { cleanup, computed, effect, host, keymap, platform, signal, View, type ViewRef } from "nsh";
import type { EditorRef } from "nsh/base";
import { formatCount } from "../format";
import { tr } from "../i18n";
import { latexOutline, latexSnippetEdit, latexSnippets, latexStopSelection, moveLatexStops,
  type LatexSnippetName, type LatexSnippetStop } from "../latexSource";
import { DropdownMenu, type DropdownMenuItem } from "./overlays";
import { Button, IconButton } from "./primitives";
import { Toolbar, ToolbarSeparator } from "./Toolbar";

type SnippetSession = { before: string | null; text: string; stops: LatexSnippetStop[]; active: number };
const names = Object.keys(latexSnippets) as LatexSnippetName[];
let nextKeyCapture = 0;

function normalizeSource(source: string) {
  return source.replace(/\r\n?/g, "\n");
}

export function LatexSourceTools(props: {
  source: string;
  editor: EditorRef | null;
  focused: boolean;
  editable: boolean;
  afterMenu: (action: (editor: EditorRef) => void) => void;
}) {
  const outlineAnchor = signal<ViewRef | null>(null);
  const insertAnchor = signal<ViewRef | null>(null);
  const menu = signal<"outline" | "insert" | null>(null);
  const session = signal<SnippetSession | null>(null);
  const hasSession = computed(() => session() !== null);
  let pendingInsert = 0;
  cleanup(() => { pendingInsert++; });

  function run(command: "undo" | "redo") {
    session.set(null);
    props.editor?.focus();
    props.editor?.run(command);
  }

  async function insert(editor: EditorRef, name: LatexSnippetName) {
    const request = ++pendingInsert;
    const [text, selections] = await Promise.all([editor.value(), editor.selections()]);
    if (request !== pendingInsert || editor !== props.editor || !props.editable ||
        text !== normalizeSource(props.source)) return;
    const selection = selections.at(-1);
    if (!selection) return;

    const result = latexSnippetEdit(text, selection, name);
    session.set({ before: text, text: result.text, stops: result.stops, active: 0 });
    editor.focus();
    editor.edit([result.edit]);
    editor.setSelections([latexStopSelection(result.text, result.stops[0])]);
  }

  effect(() => {
    const current = session();
    if (!current) return;
    const text = normalizeSource(props.source);
    if (!props.editable || !props.editor) {
      session.set(null);
    } else if (text === current.text) {
      if (current.before !== null) session.set({ ...current, before: null });
    } else if (text !== current.before) {
      const stops = moveLatexStops(current.text, text, current.stops, current.active);
      session.set(stops ? { ...current, before: null, text, stops } : null);
    }
  });

  async function move(direction: -1 | 1) {
    const current = session();
    const editor = props.editor;
    if (!current || !editor) return;
    const actual = (await editor.selections().catch(() => [])).at(-1);
    if (session() !== current || editor !== props.editor || !props.focused) return;
    const field = latexStopSelection(current.text, current.stops[current.active]);
    const compare = (a: typeof field.anchor, b: typeof field.anchor) => a.line - b.line || a.column - b.column;
    if (!actual || [actual.anchor, actual.head].some(position =>
      compare(position, field.anchor) < 0 || compare(position, field.head) > 0)) {
      session.set(null);
      editor.run(direction === 1 ? "indent" : "outdent");
      return;
    }
    const index = Math.max(0, current.active + direction);
    const next = current.stops[index];
    editor.setSelections([latexStopSelection(current.text, next)]);
    session.set(index === current.stops.length - 1 ? null : { ...current, active: index });
  }

  effect(() => {
    if (!props.focused || !hasSession()) return;
    if (platform.os === "web" && host.available()) {
      // The web editor handles Tab before the page's NSH shortcut listener.
      const id = ++nextKeyCapture;
      cleanup(host.on<{ id: number; key: string }>("openbitfun.latexSnippetKey", event => {
        if (event?.id !== id) return;
        if (event.key === "escape") session.set(null);
        else if (event.key === "next" || event.key === "previous") void move(event.key === "next" ? 1 : -1);
      }));
      host.post("openbitfun.latexSnippetKeys", { id, active: true });
      cleanup(() => host.post("openbitfun.latexSnippetKeys", { id, active: false }));
      return;
    }
    cleanup(keymap.bind({
      tab: () => void move(1),
      "shift+tab": () => void move(-1),
      escape: () => session.set(null),
    }, { when: "always", overFocused: true }));
  });

  const outlineItems = (): DropdownMenuItem[] => {
    if (menu() !== "outline") return [];
    const headings = latexOutline(props.source);
    if (!headings.length) return [{ id: "empty", label: tr("doc.latexOutlineEmpty"), disabled: true }];
    return headings.map(heading => ({
      id: String(heading.line),
      label: heading.title,
      trailingHint: formatCount(heading.line + 1),
      hint: tr(headingLabels[heading.level]),
      accessibilityLabel: "file-tex-heading-" + (heading.line + 1),
      onSelect: () => props.afterMenu(editor => {
        session.set(null);
        editor.focus();
        editor.goToLine(heading.line);
      }),
    }));
  };
  const insertItems = () => names.map(name => ({
    id: name,
    label: tr(snippetLabels[name]),
    accessibilityLabel: "file-tex-snippet-" + name,
    onSelect: () => props.afterMenu(editor => { void insert(editor, name).catch(() => undefined); }),
  }));

  return <Toolbar size="sm" leading={<>
    <View ref={outlineAnchor.set}>
      <Button size="xs" variant={menu() === "outline" ? "secondary" : "ghost"}
        leadingIcon="list" label={tr("doc.latexOutline")} accessibilityLabel="file-tex-outline"
        onPress={() => menu.set(menu() === "outline" ? null : "outline")} />
      <DropdownMenu open={menu() === "outline"} anchor={outlineAnchor()} items={outlineItems()} maxHeight={320}
        minWidth={220} onClose={() => menu.set(null)} />
    </View>
    <View ref={insertAnchor.set}>
      <Button size="xs" variant={menu() === "insert" ? "secondary" : "ghost"}
        leadingIcon="plus" label={tr("doc.latexInsert")} accessibilityLabel="file-tex-insert" disabled={!props.editable}
        onPress={() => menu.set(menu() === "insert" ? null : "insert")} />
      <DropdownMenu open={menu() === "insert"} anchor={insertAnchor()} items={insertItems()} maxHeight={320}
        minWidth={160} onClose={() => menu.set(null)} />
    </View>
    <ToolbarSeparator />
    <IconButton icon="undo" size="xs" tooltip={tr("shell.menu.undo")} accessibilityLabel="file-tex-undo"
      disabled={!props.editable} onPress={() => run("undo")} />
    <IconButton icon="redo" size="xs" tooltip={tr("shell.menu.redo")} accessibilityLabel="file-tex-redo"
      disabled={!props.editable} onPress={() => run("redo")} />
  </>} />;
}

const headingLabels = ["doc.latexPart", "doc.latexChapter", "doc.latexSnippetSection",
  "doc.latexSubsection", "doc.latexSubsubsection", "doc.latexParagraph"] as const;
const snippetLabels = {
  section: "doc.latexSnippetSection", equation: "doc.latexSnippetEquation", figure: "doc.latexSnippetFigure",
  table: "doc.latexSnippetTable", cite: "doc.latexSnippetCite", reference: "doc.latexSnippetReference",
  bibliography: "doc.latexSnippetBibliography", itemize: "doc.latexSnippetItemize",
} as const;
