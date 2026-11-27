import { Buffer } from "buffer";
import { signal } from "nsh";
import type { TranscriptTurnView } from "../api";
import type { BackendConnection } from "../backendConnection";
import type { RefreshableBinding } from "../figureBindingDeclarations";
import { tr } from "../i18n";
import { figureTurnOwnedBy, readFigureBindingRefresh, type FigureOwner } from "../toolDetailStore";
import { figureBindingValue, type BoundValue, type FigureSourceRow } from "./figureBindingGuest";

export type FigureSession = {
  appendDraft: (message: string) => boolean;
  isVisible: () => boolean;
  turns: () => readonly TranscriptTurnView[];
};

type Feedback = "pending" | "noResult" | "failed";
type Watch = { timer?: ReturnType<typeof setTimeout> };
const pendingByConnection = new WeakMap<BackendConnection, Map<string, Map<string, string>>>();

export function createFigureSessionBinding(options: {
  owner: FigureOwner;
  original: TranscriptTurnView;
  uri: string;
  readerKey: string;
  session: FigureSession;
  sources: readonly FigureSourceRow[];
  current: () => boolean;
  publish: (name: string, value: BoundValue) => boolean;
}) {
  const { owner, original, uri, readerKey, session, sources, current, publish } = options;
  const figures = pendingByConnection.get(owner.connection) ?? new Map<string, Map<string, string>>();
  pendingByConnection.set(owner.connection, figures);
  const pending = () => figures.get(readerKey);
  const feedback = signal<Record<string, Feedback | undefined>>(Object.fromEntries(
    Array.from(pending()?.keys() ?? [], name => [name, "pending"]),
  ));
  const watching = signal<string[]>([]);
  const watchFailures = signal<string[]>([]);
  const watches = new Map<string, Watch>();
  const reading = new Set<string>();
  const latest = new Map<string, number>();
  const visible = () => current() && session.isVisible();
  const isNewer = (name: string, turn: TranscriptTurnView) => turn.turnIndex > (latest.get(name) ?? original.turnIndex);

  function deliver(name: string, value: BoundValue, turn: TranscriptTurnView) {
    if (!isNewer(name, turn)) return true;
    if (!publish(name, value)) return false;
    latest.set(name, turn.turnIndex);
    return true;
  }

  async function read(name: string, binding: RefreshableBinding, candidate: TranscriptTurnView, requestToken?: string) {
    const value = await readFigureBindingRefresh(original, owner, uri, {
      name, turnId: candidate.turnId, turnIndex: candidate.turnIndex, requestToken,
    });
    return figureBindingValue(binding, value);
  }

  function request(name: string, binding: RefreshableBinding): boolean {
    if (!visible()) return false;
    const token = `[visualize:${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}]`;
    const message = tr("chat.figures.sources.refreshPrompt", {
      name, source: JSON.stringify(binding), request: token,
    });
    if (!session.appendDraft(message)) return false;
    const entries = pending() ?? new Map();
    entries.set(name, token);
    figures.set(readerKey, entries);
    return true;
  }

  function isCandidate(turn: TranscriptTurnView) {
    return turn.settled && turn.kind === "user_dialog" && turn.turnIndex > original.turnIndex &&
      figureTurnOwnedBy(turn, owner);
  }

  function setFeedback(name: string, next: Feedback | undefined) {
    feedback.update(all => ({ ...all, [name]: next }));
  }

  function observe(turns: readonly TranscriptTurnView[]) {
    if (!visible()) return;
    for (const [name, token] of pending() ?? []) {
      if (reading.has(name)) continue;
      const binding = sources.find(row => row.name === name)?.declaration;
      if (binding?.type !== "tool" && binding?.type !== "library") continue;
      const candidate = turns.find(turn => isCandidate(turn) && turn.user.text?.includes(token));
      if (!candidate) continue;
      reading.add(name);
      void read(name, binding, candidate, token).then(value => {
        const entries = pending();
        if (!visible() || entries?.get(name) !== token) return;
        if (value && !deliver(name, value, candidate)) {
          setFeedback(name, "failed");
          return;
        }
        entries.delete(name);
        if (!entries.size) figures.delete(readerKey);
        setFeedback(name, value ? undefined : "noResult");
      }, () => {
        if (visible() && pending()?.get(name) === token) setFeedback(name, "failed");
      }).finally(() => reading.delete(name));
    }
  }

  function watch(name: string, binding: RefreshableBinding, enabled: boolean) {
    const prior = watches.get(name);
    if (prior?.timer !== undefined) clearTimeout(prior.timer);
    watches.delete(name);
    watchFailures.update(names => names.filter(key => key !== name));
    if (!enabled || !visible()) {
      watching.set(Array.from(watches.keys()));
      return;
    }
    const watch: Watch = {};
    const checked = new WeakSet<TranscriptTurnView>();
    watches.set(name, watch);
    watching.set(Array.from(watches.keys()));
    const active = () => visible() && watches.get(name) === watch;
    const toolName = binding.type === "tool" ? binding.tool : "Write";
    async function refresh() {
      try {
        const turns = session.turns();
        for (let index = turns.length - 1; active() && index >= 0; index--) {
          const turn = turns[index];
          if (!isNewer(name, turn) || checked.has(turn) || !isCandidate(turn) ||
              !turn.items.some(item => item.kind === "tool" && item.tool.name === toolName && item.tool.success)) continue;
          const value = await read(name, binding, turn);
          if (!active()) return;
          if (value) {
            if (!deliver(name, value, turn)) throw new Error("Figure could not accept session data");
            break;
          }
          checked.add(turn);
        }
        if (active()) watchFailures.update(names => names.filter(key => key !== name));
      } catch {
        if (active()) watchFailures.update(names => names.includes(name) ? names : [...names, name]);
      } finally {
        if (active()) watch.timer = setTimeout(() => void refresh(), binding.refreshIntervalSeconds * 1000);
      }
    }
    void refresh();
  }

  return {
    session, request, observe, watch,
    isWatching: (name: string) => watching().includes(name),
    watchFailed: (name: string) => watchFailures().includes(name),
    feedback: (name: string) => Object.hasOwn(feedback(), name) ? feedback()[name] : undefined,
    dispose: () => {
      for (const watch of watches.values()) clearTimeout(watch.timer);
      watches.clear();
    },
  };
}
