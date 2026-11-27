// Whole tool results, read when a card is opened.
//
// A transcript read asks for `tool_detail: "summary"`: a long session's tool
// outputs are megabytes nobody opened, and shipping, parsing and holding them is
// what made opening and scrolling such a session stutter. The host shortens them
// and marks the call `detailOmitted`; opening that call reads its one turn whole.
// A host that does not know the field answers whole results and never marks one.

import { Buffer } from "buffer";
import { signal, untracked } from "nsh";
import type { SessionTranscriptView, TranscriptItemView, TranscriptToolView, TranscriptTurnView } from "./api";
import { backendConnection, fleetActive, invokeCommand } from "./bridge";
import type { BackendConnection } from "./backendConnection";
import { toolCallOf, type ToolCallView } from "./format";

export interface TranscriptSource {
  sessionId: string;
  workspaceId: string;
  deviceId: string;
}

export interface FigureOwner extends TranscriptSource {
  viaFleet: boolean;
  connection: BackendConnection;
}

type FigureBindingRefresh = { name: string; turnId: string; turnIndex: number; requestToken?: string };
type FigureRead = { uri: string; bindingRefresh?: FigureBindingRefresh };

/** Opened calls kept whole; the oldest is dropped (and read again if reopened). */
const MAX_HELD_DETAILS = 48;

const sources = new WeakMap<object, FigureOwner>();
const held = signal<Record<string, ToolCallView>>({});
const failures = signal<Record<string, true>>({});
const inFlight = new Map<string, Promise<TranscriptTurnView>>();

/** Remembers where these turns were read from, so an opened call can be read whole. */
export function noteTranscriptSource(turns: ReadonlyArray<TranscriptTurnView> | undefined, source: TranscriptSource): void {
  const origin = { ...source, viaFleet: untracked(fleetActive), connection: untracked(backendConnection) };
  for (const turn of turns ?? []) sources.set(turn, origin);
}

export function figureTurnOwnedBy(turn: TranscriptTurnView | undefined, owner: FigureOwner): boolean {
  const origin = turn ? sources.get(turn) : undefined;
  return !!origin && origin.connection === owner.connection && origin.viaFleet === owner.viaFleet &&
    origin.deviceId === owner.deviceId && origin.workspaceId === owner.workspaceId && origin.sessionId === owner.sessionId;
}

function turnKeyOf(turn: TranscriptTurnView, source: TranscriptSource): string {
  return `${source.deviceId}/${source.sessionId}/${turn.turnIndex}/${turn.turnId}`;
}

function keyOf(call: ToolCallView): string | null {
  const turn = call.detailTurn;
  const source = turn ? sources.get(turn) : undefined;
  return turn && source && call.id ? `${turnKeyOf(turn, source)}/${call.id}` : null;
}

function findTool(items: ReadonlyArray<TranscriptItemView>, id: string): TranscriptToolView | null {
  for (const item of items) {
    if (item.kind !== "tool") continue;
    if (item.tool.id === id) return item.tool;
    const nested = findTool(item.tool.subagentItems ?? [], id);
    if (nested) return nested;
  }
  return null;
}

async function readTurn(turn: TranscriptTurnView, source: TranscriptSource, figure?: FigureRead): Promise<TranscriptTurnView> {
  const view = await invokeCommand<SessionTranscriptView>(
    "get_session_transcript_view",
    {
      session_id: source.sessionId,
      workspace_id: source.workspaceId,
      limit: 1,
      before_turn_index: turn.turnIndex + 1,
      ...(figure ? { figure_source: { turnId: turn.turnId, ...figure } } : {}),
    },
    fleetActive() && source.deviceId ? { target: source.deviceId } : undefined,
  );
  const found = view.turns?.find(item => item.turnId === turn.turnId && item.turnIndex === turn.turnIndex);
  if (!found) throw new Error(`Turn ${turn.turnIndex} is no longer in the transcript`);
  return found;
}

const SESSION_FIGURE_URI = /^openbitfun:\/\/current-session\/artifacts\/visualizations\/v2\/[a-z0-9][a-z0-9-]{0,95}\.html$/;
const MAX_FIGURE_BYTES = 1024 * 1024;

export function publishedFigure(turn: TranscriptTurnView | undefined, uri: string) {
  if (!turn?.settled || !SESSION_FIGURE_URI.test(uri) || !Array.isArray(turn.publishedFigures)) return undefined;
  const figure = turn.publishedFigures.find(entry => entry?.uri === uri);
  const size = figure?.contentBytes;
  return typeof size === "number" && Number.isSafeInteger(size) && size > 0 && size <= MAX_FIGURE_BYTES
    ? figure
    : undefined;
}

/** Read immutable HTML from the original turn on the device that owns the session. */
export async function readPublishedFigureSource(turn: TranscriptTurnView, uri: string): Promise<{
  source: string; readerKey: string; bindings?: unknown; owner: FigureOwner; bindingRefreshSupported: boolean;
}> {
  const owner = sources.get(turn);
  const summary = publishedFigure(turn, uri);
  if (!owner || !summary || backendConnection() !== owner.connection ||
      owner.viaFleet !== fleetActive() || (owner.viaFleet && !owner.deviceId)) {
    throw new Error("The published figure has no reachable transcript source");
  }
  const saved = publishedFigure(await readTurn(turn, owner, { uri }), uri);
  if (backendConnection() !== owner.connection || typeof saved?.source !== "string" || saved.contentBytes !== summary.contentBytes ||
    Buffer.byteLength(saved.source, "utf8") !== saved.contentBytes) {
    throw new Error("The published figure does not match its transcript summary");
  }
  const readerKey = "openbitfun.nsh.figure-reader.v1:" + JSON.stringify([
    owner.viaFleet, owner.deviceId, owner.workspaceId, owner.sessionId, turn.turnIndex, turn.turnId, uri,
  ]);
  return { source: saved.source, readerKey, bindings: saved.bindings, owner,
    bindingRefreshSupported: saved.bindingRefreshSupported === true };
}

export async function readFigureBindingRefresh(
  turn: TranscriptTurnView,
  owner: FigureOwner,
  uri: string,
  bindingRefresh: FigureBindingRefresh,
): Promise<unknown> {
  if (backendConnection() !== owner.connection || fleetActive() !== owner.viaFleet) {
    throw new Error("The figure transcript source changed");
  }
  const saved = publishedFigure(await readTurn(turn, owner, { uri, bindingRefresh }), uri);
  if (backendConnection() !== owner.connection || saved?.bindingRefreshSupported !== true ||
      saved.contentBytes !== publishedFigure(turn, uri)?.contentBytes) {
    throw new Error("The figure binding refresh is unavailable");
  }
  const value = saved.bindingRefresh;
  return value?.name === bindingRefresh.name && value.turnId === bindingRefresh.turnId ? value.value : undefined;
}

/** Reads the opened call whole, once. Several cards of one turn share the read. */
export async function loadToolDetail(call: ToolCallView): Promise<void> {
  const key = keyOf(call);
  const turn = call.detailTurn;
  if (!call.detailOmitted || !key || !turn || !call.id || untracked(held)[key]) return;
  const source = sources.get(turn)!;
  const turnKey = turnKeyOf(turn, source);
  if (untracked(failures)[key]) {
    failures.update(({ [key]: _, ...rest }) => rest);
  }
  let read = inFlight.get(turnKey);
  if (!read) {
    read = readTurn(turn, source).finally(() => inFlight.delete(turnKey));
    inFlight.set(turnKey, read);
  }
  try {
    const tool = findTool((await read).items, call.id);
    if (!tool) throw new Error(`Tool call ${call.id} is no longer in the transcript`);
    held.update(current => {
      const entries = Object.entries(current);
      const kept = entries.length >= MAX_HELD_DETAILS ? Object.fromEntries(entries.slice(entries.length - MAX_HELD_DETAILS + 1)) : current;
      return { ...kept, [key]: toolCallOf(tool) };
    });
  } catch (error) {
    console.warn(`Tool result could not be read: ${error instanceof Error ? error.message : String(error)}`);
    failures.update(current => ({ ...current, [key]: true }));
  }
}

/** The call as it was read whole, or the call itself until then. */
export function detailedToolCall(call: ToolCallView): ToolCallView {
  if (!call.detailOmitted) return call;
  const key = keyOf(call);
  return (key && held()[key]) || call;
}

export type ToolDetailState = "whole" | "loading" | "failed";

export function toolDetailState(call: ToolCallView): ToolDetailState {
  if (!call.detailOmitted) return "whole";
  const key = keyOf(call);
  if (!key || failures()[key]) return "failed";
  return held()[key] ? "whole" : "loading";
}
