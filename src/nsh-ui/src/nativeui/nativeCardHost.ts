// NativeUI cards: what a `NativeUI` tool call carries and where the host that
// runs it is.
//
// A card runs in an NSH engine of its own that only some hosts embed (the
// macOS desktop runner's `openbitfun.genui-card` native component). The host
// installs it here (`src/apps/desktop-nsh/src/nativeCards.ts`); elsewhere the
// transcript shows the card's title and source and says why.

import { signal } from "nsh";
import type { JSX } from "nsh";
import type { ToolCallView } from "../format";

/** The compiled card format this UI runs; others show as unsupported. */
export const NATIVE_UI_FORMAT = "openbitfun.native-ui/1";
/** The newest kit API this UI's host ships. */
export const NATIVE_UI_KIT_API = 1;

export interface NativeCardEvents {
  onAsk?: (event: { text?: string }) => void;
  onCopy?: (event: { text?: string }) => void;
  onState?: (event: { key?: string; value?: unknown }) => void;
  onOpenUrl?: (event: { url?: string }) => void;
  onError?: (event: { message?: string }) => void;
}

export interface NativeCardProps extends NativeCardEvents {
  factory: string;
  theme: Record<string, unknown>;
  state: Record<string, unknown>;
  style?: object;
}

export interface NativeCardHost {
  Card: (props: NativeCardProps) => JSX.Element;
}

const host = signal<NativeCardHost | null>(null);

/** Called by a host that runs cards, before or after the transcript shows. */
export function installNativeCardHost(next: NativeCardHost): void {
  host.set(next);
}

export function nativeCardHost(): NativeCardHost | null {
  return host();
}

export interface NativeUiCall {
  title: string;
  /** The TSX the Agent wrote, from the call's arguments. */
  source: string;
  /** The compiled factory, once the call succeeded. */
  factory?: string;
  format?: string;
  kitApi?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The arguments of a direct `NativeUI` call or of one made through `CallDeferredTool`. */
function nativeUiArgs(call: ToolCallView): Record<string, unknown> | null {
  if (call.name === "NativeUI") return record(call.input) ?? {};
  if (call.name === "CallDeferredTool") {
    const input = record(call.input);
    if (input?.tool_name === "NativeUI") return record(input.args) ?? {};
  }
  return null;
}

export function isNativeUiCall(call: ToolCallView): boolean {
  return nativeUiArgs(call) !== null;
}

/** What the call carries; `null` when it is not a NativeUI call. */
export function nativeUiCallOf(call: ToolCallView): NativeUiCall | null {
  const args = nativeUiArgs(call);
  if (!args) return null;
  const result = record(call.result);
  const title =
    (typeof result?.title === "string" && result.title) || (typeof args.title === "string" ? args.title : "");
  return {
    title,
    source: typeof args.source === "string" ? args.source : "",
    ...(typeof result?.factory === "string" ? { factory: result.factory } : {}),
    ...(typeof result?.format === "string" ? { format: result.format } : {}),
    ...(typeof result?.kitApi === "number" ? { kitApi: result.kitApi } : {}),
  };
}

/** Why a compiled card cannot run here, or `null` when it can. */
export function unsupportedReason(card: NativeUiCall): "format" | "kit" | null {
  if (card.format !== NATIVE_UI_FORMAT) return "format";
  if ((card.kitApi ?? 1) > NATIVE_UI_KIT_API) return "kit";
  return null;
}
