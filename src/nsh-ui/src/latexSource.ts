import type { EditorEdit, EditorPosition, EditorSelection } from "nsh/base";

const headingLevels = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph"];

function visibleLine(line: string): string {
  return /^(?:\\.|[^%\\])*/.exec(line)?.[0] ?? line;
}

export function latexOutline(source: string): { title: string; line: number; level: number }[] {
  return source.split(/\r\n|\r|\n/).flatMap((raw, line) => {
    const visible = visibleLine(raw);
    const match = /^(?:\\.|[^\\])*?\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\]\s*)?\{/.exec(visible);
    if (!match) return [];
    const start = match[0].length;
    let depth = 1;
    for (let end = start; end < visible.length; end++) {
      if (visible[end] === "\\") end++;
      else if (visible[end] === "{") depth++;
      else if (visible[end] === "}" && --depth === 0) {
        const title = visible.slice(start, end).replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, "$1").trim();
        return title ? [{ title, line, level: headingLevels.indexOf(match[1]) }] : [];
      }
    }
    return [];
  });
}

function bodyStart(source: string): number | undefined {
  let offset = 0;
  for (const raw of source.split("\n")) {
    const match = /^(?:\\.|[^\\])*?\\begin\s*\{\s*document\s*\}/.exec(visibleLine(raw));
    if (match) return offset + match[0].length;
    offset += raw.length + 1;
  }
  return undefined;
}

const field = (defaultText: string) => ({ defaultText });

export const latexSnippets = {
  section: ["\\section{", field("Title"), "}\n"],
  equation: ["\\begin{equation}\n  ", field("E = mc^2"), "\n  \\label{eq:", field("energy"), "}\n\\end{equation}\n"],
  figure: ["\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=", field("0.8"), "\\linewidth]{",
    field("figure.pdf"), "}\n  \\caption{", field("Caption"), "}\n  \\label{fig:", field("example"), "}\n\\end{figure}\n"],
  table: ["\\begin{table}[htbp]\n  \\centering\n  \\caption{", field("Caption"), "}\n  \\label{tab:", field("example"),
    "}\n  \\begin{tabular}{", field("ll"), "}\n    \\hline\n    ", field("Column A & Column B"), " \\\\", "\n    \\hline\n    ",
    field("Value A & Value B"), " \\\\", "\n    \\hline\n  \\end{tabular}\n\\end{table}\n"],
  cite: ["\\cite{", field("key"), "}"],
  reference: ["\\ref{", field("label"), "}"],
  bibliography: ["\\bibliographystyle{", field("plain"), "}\n\\bibliography{", field("refs"), "}\n"],
  itemize: ["\\begin{itemize}\n  \\item ", field("Item"), "\n\\end{itemize}\n"],
} as const;

export type LatexSnippetName = keyof typeof latexSnippets;
export type LatexSnippetStop = { start: number; end: number };

function offsetAt(text: string, position: EditorPosition): number {
  const lines = text.split("\n");
  if (position.line >= lines.length) return text.length;
  let offset = 0;
  for (let line = 0; line < position.line; line++) offset += lines[line].length + 1;
  return offset + Math.min(position.column, lines[position.line].length);
}

function positionAt(text: string, offset: number): EditorPosition {
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length - 1, column: lines.at(-1)!.length };
}

export function latexStopSelection(text: string, stop: LatexSnippetStop): EditorSelection {
  return { anchor: positionAt(text, stop.start), head: positionAt(text, stop.end) };
}

/** The Editor works in UTF-16 offsets in its LF-normalized document. */
export function latexSnippetEdit(text: string, selection: EditorSelection, name: LatexSnippetName): {
  edit: EditorEdit; text: string; stops: LatexSnippetStop[];
} {
  const anchor = offsetAt(text, selection.anchor);
  const head = offsetAt(text, selection.head);
  const body = bodyStart(text);
  let start = Math.min(anchor, head);
  let end = Math.max(anchor, head);
  const inPreamble = body !== undefined && start < body;
  if (inPreamble) start = end = body;
  const stops: LatexSnippetStop[] = [];
  let inserted = inPreamble ? "\n" : "";
  for (const part of latexSnippets[name]) {
    if (typeof part === "string") inserted += part;
    else {
      const fieldStart = start + inserted.length;
      inserted += part.defaultText;
      stops.push({ start: fieldStart, end: start + inserted.length });
    }
  }
  const final = start + inserted.length;
  stops.push({ start: final, end: final });
  return {
    edit: { range: { start: positionAt(text, start), end: positionAt(text, end) }, text: inserted },
    text: text.slice(0, start) + inserted + text.slice(end),
    stops,
  };
}

/** Keep later fields aligned when typing replaces or grows the active field. */
export function moveLatexStops(previous: string, next: string, stops: LatexSnippetStop[], active: number) {
  const stop = stops[active];
  const shift = next.length - previous.length;
  if (stop.end + shift < stop.start || !next.startsWith(previous.slice(0, stop.start)) ||
      !next.endsWith(previous.slice(stop.end))) return null;
  return stops.map((range, index) => index < active ? range :
    index === active ? { start: range.start, end: range.end + shift } :
    { start: range.start + shift, end: range.end + shift });
}
