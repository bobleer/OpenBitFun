/**
 * Adapted from Monaco Editor 0.52.2, vs/editor/common/model/indentationGuesser.
 * Copyright (c) 2016 - present Microsoft Corporation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export interface EditorIndentation {
  tabSize: number;
  hardTabs: boolean;
}

export interface EditorIndentationConfig {
  fallback: EditorIndentation;
  detect: boolean;
}

/** Older hosts have explicit indentation settings without a detection switch. */
export function readEditorIndentationConfig(raw: unknown): EditorIndentationConfig {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const width = value.tab_size;
  return {
    fallback: {
      tabSize: typeof width === "number" && Number.isSafeInteger(width) && width > 0 ? width : 4,
      hardTabs: value.insert_spaces === false,
    },
    detect: value.detect_indentation === true,
  };
}

interface LineIndentation {
  end: number;
  spaces: number;
  tabs: number;
}

function readLineIndentation(line: string, from = 0): LineIndentation {
  let end = from;
  let spaces = 0;
  let tabs = 0;
  for (; end < line.length; end++) {
    const char = line.charCodeAt(end);
    if (char === 32) spaces++;
    else if (char === 9) tabs++;
    else break;
  }
  return { end, spaces, tabs };
}

function indentationDifference(a: string, aEnd: number, b: string, bEnd: number) {
  let shared = 0;
  while (shared < aEnd && shared < bEnd && a[shared] === b[shared]) shared++;
  const first = readLineIndentation(a, shared);
  const second = readLineIndentation(b, shared);
  if ((first.tabs > 0 && first.spaces > 0) || (second.tabs > 0 && second.spaces > 0)) return null;
  const spaces = Math.abs(first.spaces - second.spaces);
  const tabs = Math.abs(first.tabs - second.tabs);
  if (tabs > 0) return spaces % tabs === 0 ? { width: spaces / tabs, alignment: false } : null;

  // Continuation lines after a comma may be aligned under a previous token.
  const alignment = spaces > 0 &&
    second.spaces > 0 && second.spaces < b.length &&
    a[second.spaces - 1] === " " && b[second.spaces] !== " " && a.endsWith(",");
  return { width: spaces, alignment };
}

export function guessEditorIndentation(text: string, fallback: EditorIndentation): EditorIndentation {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const scores = Array<number>(9).fill(0);
  let tabLines = 0;
  let spaceLines = 0;
  let previous = "";
  let previousEnd = 0;

  for (const line of content.split(/\r\n|\r|\n/, 10_000)) {
    const indent = readLineIndentation(line);
    if (indent.end === line.length) continue;
    if (indent.tabs > 0) tabLines++;
    else if (indent.spaces > 1) spaceLines++;

    const difference = indentationDifference(previous, previousEnd, line, indent.end);
    if (difference?.alignment && (fallback.hardTabs || difference.width !== fallback.tabSize)) continue;
    if (difference && difference.width <= 8) scores[difference.width]++;
    previous = line;
    previousEnd = indent.end;
  }

  const hardTabs = tabLines === spaceLines ? fallback.hardTabs : tabLines > spaceLines;
  if (hardTabs) return { hardTabs, tabSize: fallback.tabSize };

  let tabSize = fallback.tabSize;
  let score = 0;
  for (const size of [2, 4, 6, 8, 3, 5, 7]) {
    if (scores[size] <= score) continue;
    score = scores[size];
    tabSize = size;
  }
  if (tabSize === 4 && scores[4] > 0 && scores[2] > 0 && scores[2] >= scores[4] / 2) tabSize = 2;
  return { hardTabs, tabSize };
}
