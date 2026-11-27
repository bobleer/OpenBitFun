// NSH 0.7.1's ANSI palette is fixed. Use darker xterm palette entries for
// low-contrast foregrounds on a light default background. The entries keep
// their hue or grayscale role without changing the PTY stream or its history.
const lightForegrounds: Readonly<Partial<Record<number, number>>> = {
  2: 22,
  3: 94,
  4: 25,
  5: 90,
  6: 24,
  7: 240,
  9: 124,
  10: 22,
  11: 94,
  12: 25,
  13: 90,
  14: 24,
  15: 236,
};

/** One projection per renderer. Keep incomplete control sequences across PTY chunks. */
export function createLightTerminalOutput(): (chunk: string) => string {
  const csi = /\x1b\[([0-?]*)([ -/]*)([@-~])/y;
  const oscEnd = /\x07|\x18|\x1a|\x1b\\/g;
  const stringEnd = /\x18|\x1a|\x1b\\/g;
  let pending = "";
  let endOfString: RegExp | undefined;
  let foreground: number | undefined;
  let backgroundSet = false;
  let inverse = false;

  const reset = () => {
    foreground = undefined;
    backgroundSet = false;
    inverse = false;
  };
  const adjustedForeground = () =>
    foreground !== undefined && !backgroundSet && !inverse ? lightForegrounds[foreground] : undefined;

  function projectSgr(sequence: string, parameters: string): string {
    const wasAdjusted = adjustedForeground() !== undefined;
    const fields = parameters.split(";");
    for (let i = 0; i < fields.length; i++) {
      const [code, ...colon] = fields[i]!.split(":");
      const n = Number(code);
      if (n === 38 || n === 48 || n === 58) {
        // Skip extended-color arguments. Channel values can look like SGR
        // modes (for example 93), but they are part of the color.
        const mode = Number(colon.length ? colon[0] : fields[i + 1]);
        const size = mode === 5 ? 2 : mode === 2 ? 4 : 0;
        if (!size) break;
        if (n === 38) foreground = mode === 5 ? Number(colon.length ? colon[1] : fields[i + 2]) : undefined;
        if (n === 48) backgroundSet = true;
        if (!colon.length) i += size;
      } else if (n === 0) reset();
      else if (n === 7 || n === 27) inverse = n === 7;
      else if (n === 39) foreground = undefined;
      else if (n >= 30 && n <= 37) foreground = n - 30;
      else if (n >= 90 && n <= 97) foreground = n - 82;
      else if (n === 49) backgroundSet = false;
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) backgroundSet = true;
    }
    const adjusted = adjustedForeground();
    // Restore the program's original foreground when a colored background
    // or inverse video takes over. Explicit RGB colors are left to the app.
    const index = adjusted ?? (wasAdjusted && foreground !== undefined ? foreground : undefined);
    return index === undefined ? sequence : sequence + `\x1b[38;5;${index}m`;
  }

  return chunk => {
    const data = pending + chunk;
    pending = "";
    let result = "";
    let offset = 0;
    while (offset < data.length) {
      if (endOfString) {
        endOfString.lastIndex = offset;
        const end = endOfString.exec(data);
        if (!end) {
          // Only retain an ESC that may be the start of an ST delimiter.
          if (data.endsWith("\x1b")) pending = "\x1b";
          return result + data.slice(offset, data.length - pending.length);
        }
        result += data.slice(offset, endOfString.lastIndex);
        offset = endOfString.lastIndex;
        endOfString = undefined;
        continue;
      }
      const escape = data.indexOf("\x1b", offset);
      if (escape < 0) return result + data.slice(offset);
      result += data.slice(offset, escape);
      csi.lastIndex = escape;
      const match = csi.exec(data);
      if (match) {
        const [sequence, parameters, intermediates, final] = match;
        result += final === "m" && !intermediates && /^[0-9;:]*$/.test(parameters!)
          ? projectSgr(sequence, parameters!) : sequence;
        offset = csi.lastIndex;
        continue;
      }
      const suffix = data.slice(escape);
      if (suffix.length <= 128 && /^\x1b(?:\[[0-?]*[ -/]*)?$/.test(suffix)) {
        pending = suffix;
        break;
      }
      const next = data[escape + 1];
      if (next === "]") endOfString = oscEnd;
      else if (next && "PX^_".includes(next)) endOfString = stringEnd;
      else if (next === "c") reset();
      offset = escape + (next && next !== "\x1b" ? 2 : 1);
      result += data.slice(escape, offset);
    }
    return result;
  };
}
