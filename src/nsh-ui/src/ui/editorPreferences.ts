import { readEditorIndentationConfig } from "./editorIndentation";

function validNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value : undefined;
}

/** Project the owning device's saved EditorConfig onto the native editor's controls. */
export function readFileEditorConfig(raw: unknown) {
  const config = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const primaryFont = typeof config.font_family === "string"
    ? config.font_family.split(",")[0]?.trim().replace(/^(['"])(.*)\1$/, "$2")
    : undefined;
  const wrap = config.word_wrap;
  return {
    indentation: readEditorIndentationConfig(config),
    fontFamily: primaryFont || undefined,
    fontSize: validNumber(config.font_size, 8, 72),
    lineHeightRatio: validNumber(config.line_height, 1, 3),
    // Hosts still share settings with Monaco. Native supports viewport wrap and absolute numbers.
    softWrap: wrap === "off" ? false : wrap === "on" || wrap === "bounded" || wrap === "wordWrapColumn" ? true : undefined,
    lineNumbers: config.line_numbers !== "off",
    activeLine: config.render_line_highlight !== "none" && config.render_line_highlight !== "gutter",
    showWhitespaces: config.render_whitespace === "all",
    scrollBeyondLastLine: config.scroll_beyond_last_line === true,
  };
}
