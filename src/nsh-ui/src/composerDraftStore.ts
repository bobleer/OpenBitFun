import { computed, signal, untracked, type Signal } from "nsh";
import type { ImageAttachment, FileAttachment } from "./attachmentStore";
import type { BackendConnection } from "./backendConnection";
import { backendConnection } from "./bridge";
import { activeSessionKey, secondarySessionKey } from "./sessionIdentity";
import type { SessionReferenceCandidate } from "./sessionReferences";

export interface ComposerDraft {
  text: string;
  images: ImageAttachment[];
  files: FileAttachment[];
  references: SessionReferenceCandidate[];
}

interface DraftEntry {
  value: Signal<ComposerDraft>;
  retired: boolean;
}

export interface ComposerDraftTarget {
  connection: BackendConnection;
  read: () => ComposerDraft;
  update: (update: (draft: ComposerDraft) => ComposerDraft) => ComposerDraft;
  isVisible: () => boolean;
}

// The controller's failover transport stays installed across entry changes.
// A separately installed connection gets its own drafts, including legacy
// session ids that carry no device id. Drafts live in memory as in main.
const connections = new WeakMap<BackendConnection, Map<string | symbol, DraftEntry>>();

function draftsFor(connection: BackendConnection): Map<string | symbol, DraftEntry> {
  let drafts = connections.get(connection);
  if (!drafts) {
    drafts = new Map();
    connections.set(connection, drafts);
  }
  return drafts;
}

function emptyDraft(): ComposerDraft {
  return { text: "", images: [], files: [], references: [] };
}

function draftEntry(connection: BackendConnection, key: string | symbol): DraftEntry {
  const drafts = draftsFor(connection);
  let entry = drafts.get(key);
  if (!entry) {
    entry = { value: signal(emptyDraft()), retired: false };
    drafts.set(key, entry);
  }
  return entry;
}

function composerFor(readSession: () => string | null) {
  const unbound = Symbol();
  const key = () => readSession() ?? unbound;
  const capture = (): ComposerDraftTarget => {
    const connection = backendConnection();
    const session = key();
    const entry = draftEntry(connection, session);
    return {
      connection,
      read: entry.value,
      update: change => untracked(() => {
        const current = entry.value();
        if (entry.retired) return current;
        const next = change(current);
        entry.value.set(next);
        return next;
      }),
      isVisible: () => !entry.retired && backendConnection() === connection && key() === session,
    };
  };
  function field<K extends keyof ComposerDraft>(name: K): Signal<ComposerDraft[K]> {
    const read = computed(() => draftEntry(backendConnection(), key()).value()[name]);
    const update = (change: (value: ComposerDraft[K]) => ComposerDraft[K]) => {
      capture().update(draft => {
        const next = change(draft[name]);
        return next === draft[name] ? draft : { ...draft, [name]: next };
      });
    };
    return Object.assign(read, { set: (value: ComposerDraft[K]) => update(() => value), update });
  }
  return { text: field("text"), images: field("images"), files: field("files"), references: field("references"), capture };
}

export const primaryComposerDraft = composerFor(activeSessionKey);
export const secondaryComposerDraft = composerFor(secondarySessionKey);

/** Apply an optimistic draft change. A later edit invalidates its recovery snapshot. */
export function stageComposerChange(target: ComposerDraftTarget, patch: Partial<ComposerDraft>): () => void {
  if (Object.keys(patch).length === 0) return () => undefined;
  const before = target.read();
  const cleared = target.update(draft => ({ ...draft, ...patch }));
  return () => target.update(draft => draft === cleared ? before : draft);
}

export function forgetComposerDraft(sessionKey: string, connection = backendConnection()): void {
  const drafts = draftsFor(connection);
  const entry = drafts.get(sessionKey);
  if (!entry) return;
  entry.retired = true;
  drafts.delete(sessionKey);
  entry.value.set(emptyDraft());
}
