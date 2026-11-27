import { Buffer } from "buffer";
import { Storage } from "nsh";
import { decodeFigureReaderEvent, decodeFigureReaderState, MAX_FIGURE_READER_BYTES, type FigureReaderState } from "../assets/figure-renderer/readerState";

const pending = new Map<string, Promise<void>>();

function decode(value: unknown): unknown {
  if (typeof value !== "string" || !value || value.length > MAX_FIGURE_READER_BYTES ||
      Buffer.byteLength(value, "utf8") > MAX_FIGURE_READER_BYTES) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function readFigureReaderState(key: string): Promise<FigureReaderState | null> {
  await pending.get(key)?.catch(() => undefined);
  return decodeFigureReaderState(decode(await Storage.getItem(key).catch(() => null)));
}

export function writeFigureReaderState(key: string, state: FigureReaderState): Promise<void> {
  const serialized = JSON.stringify(state);
  const previous = pending.get(key);
  const write = (previous?.catch(() => undefined) ?? Promise.resolve()).then(() => Storage.setItem(key, serialized));
  pending.set(key, write);
  const release = () => { if (pending.get(key) === write) pending.delete(key); };
  void write.then(release, release);
  return write;
}

export function parseFigureReaderEvent(message: unknown, nonce: string) {
  return decodeFigureReaderEvent(decode(message), nonce);
}
