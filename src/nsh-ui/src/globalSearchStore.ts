// The one search field over what this run can reach: the sessions of the active
// workspace by name, the host's message hits (`search_session_content`) across
// every opened workspace, the active workspace's files (`search_files`), the
// opened and recent workspaces and assistants, and this surface's own commands
// behind a leading `>`. Settings sections are added by the shell, which owns the
// settings navigation.
//
// Two rules matter here: typing is debounced because the message and file reads
// are host round trips, and every run takes a ticket so a late answer from an
// older query cannot overwrite a newer one. A failing source is collected into
// `searchNotice` and the other groups still render. A remote workspace's files
// are not searched (the host's file search walks this machine's disk); that is
// said in the notice instead of returning an empty group.

import { basename } from "./format";
import { searchWorkspaceFiles, type WorkspaceRecord } from "./api";
import { invokeCommand } from "./bridge";
import type { ControlDestination } from "./controlPresenter";
import { tr } from "./i18n";
import { isRemoteWorkspace } from "./shared/workspaceUtils";
import {
  activeWorkspace,
  activeWorkspaceId,
  isSessionArchived,
  loadSessions,
  navigateScene,
  openRecentWorkspace,
  recentWorkspaces,
  runStep,
  selectSession,
  selectWorkspace,
  sessions,
  workspaces,
  type SceneId,
} from "./state";
import { openFileAt } from "./fileStore";
import { computed, signal } from "nsh";

export type SearchItemKind =
  | "command"
  | "capability"
  | "session"
  | "message"
  | "file"
  | "workspace"
  | "assistant"
  | "setting";

export interface SearchItem {
  /** Unique across kinds, so a list key stays stable while results change. */
  id: string;
  kind: SearchItemKind;
  label: string;
  detail: string;
  /** A session id, a file path, a workspace id, or the scene a command switches to. */
  target: string;
  /** The workspace a session or message hit belongs to, when it is not the active one. */
  workspaceId?: string;
  /** The turn a message hit was found in. */
  turnId?: string;
  /** Settings hits can reveal a destination inside their page. */
  settingsAnchor?: string;
  /** Capability hits use the same destination vocabulary as product control. */
  controlDestination?: ControlDestination;
}

export type SearchScope = "all" | "actions" | "content";

export const searchOpen = signal(false);
export const searchQuery = signal("");
export const searchBusy = signal(false);
export const searchItems = signal<SearchItem[]>([]);
export const searchNotice = signal("");
const searchScope = signal<SearchScope>("all");
export const searchActionPrefix = computed(() => searchQuery().trimStart().startsWith(">"));
export const effectiveSearchScope = computed(() => searchActionPrefix() ? "actions" : searchScope());
export const searchText = computed(() => {
  const query = searchQuery().trim();
  return query.startsWith(">") ? query.slice(1).trim() : query;
});

/**
 * The turn a message hit pointed at, for the session scene to scroll to once the
 * transcript is loaded; it clears the request after acting on it.
 */
export const searchRevealTurn = signal<{ sessionId: string; turnId: string } | null>(null);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// A late answer from an older query must not overwrite a newer one, so every run
// takes a ticket and only the newest may write.
let runTicket = 0;

function sessionNameItems(query: string): SearchItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return sessions()
    .filter(session => (session.sessionName ?? "").toLowerCase().includes(needle))
    .slice(0, 8)
    .map(session => ({
      id: `session:${session.sessionId}`,
      kind: "session" as const,
      label: session.sessionName || session.sessionId,
      detail: isSessionArchived(session)
        ? tr("search.sessionArchivedDetail")
        : tr("search.sessionDetail", { count: session.messageCount ?? 0 }),
      target: session.sessionId,
    }));
}

function workspaceName(ws: WorkspaceRecord): string {
  const named = ws.name?.trim();
  if (named) return named;
  return basename(ws.rootPath) || ws.rootPath;
}

function isAssistant(ws: WorkspaceRecord): boolean {
  return (ws.workspaceKind ?? "").toLowerCase().includes("assistant");
}

export function searchWorkspaceItems(query: string): SearchItem[] {
  const needle = query.trim().toLowerCase();
  const opened = workspaces().map(ws => ({ ws, recent: false }));
  const openedIds = new Set(opened.map(({ ws }) => ws.id));
  const recent = recentWorkspaces().filter(ws => !openedIds.has(ws.id)).map(ws => ({ ws, recent: true }));
  return [...opened, ...recent]
    .filter(({ ws }) => {
      const name = workspaceName(ws).toLowerCase();
      return name.includes(needle) || ws.rootPath.toLowerCase().includes(needle);
    })
    .slice(0, 10)
    .map(({ ws, recent: isRecent }) => ({
      id: `${isAssistant(ws) ? "assistant" : "workspace"}:${ws.id}`,
      kind: isAssistant(ws) ? ("assistant" as const) : ("workspace" as const),
      label: workspaceName(ws),
      detail: isRecent ? tr("search.recentDetail", { path: ws.rootPath }) : ws.rootPath,
      target: ws.id,
    }));
}

/** The host's own message hits, from every opened workspace: one row per match inside a turn. */
async function messageItems(query: string): Promise<SearchItem[]> {
  if (!query.trim()) return [];
  const active = activeWorkspace();
  const targets = [
    ...(active ? [active] : []),
    ...workspaces().filter(ws => ws.id !== active?.id),
  ].slice(0, 6);
  const perWorkspace = await Promise.all(
    targets.map(async ws => {
      const answer = await invokeCommand<{ hits?: unknown[] }>("search_session_content", {
        workspaceId: ws.id,
        workspacePath: ws.rootPath,
        query,
        limit: 8,
        includeArchived: false,
      });
      const hits = Array.isArray(answer?.hits) ? answer.hits : [];
      return hits
        .filter((hit): hit is Record<string, unknown> => Boolean(hit) && typeof hit === "object")
        .map(hit => {
          const snippet = String(hit.snippet ?? "").replace(/\s+/g, " ").trim();
          const other = ws.id !== active?.id;
          return {
            id: `message:${ws.id}:${String(hit.sessionId ?? "")}:${String(hit.turnId ?? "")}:${snippet.slice(0, 40)}`,
            kind: "message" as const,
            label: String(hit.sessionTitle ?? hit.sessionId ?? tr("search.sessionFallback")),
            detail: other ? `${workspaceName(ws)} · ${snippet}` : snippet,
            target: String(hit.sessionId ?? ""),
            workspaceId: ws.id,
            turnId: typeof hit.turnId === "string" ? hit.turnId : undefined,
          };
        })
        .filter(item => item.target !== "");
    }),
  );
  return perWorkspace.flat().slice(0, 12);
}

async function fileItems(query: string): Promise<SearchItem[]> {
  const workspaceId = activeWorkspaceId();
  if (!workspaceId || !query.trim()) return [];
  const rows = await searchWorkspaceFiles(workspaceId, query);
  return (Array.isArray(rows) ? rows : [])
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .slice(0, 8)
    .map(row => ({
      id: `file:${String(row.path ?? "")}`,
      kind: "file" as const,
      label: String(row.name ?? row.path ?? ""),
      detail: String(row.path ?? ""),
      target: String(row.path ?? ""),
    }))
    .filter(item => item.target !== "");
}

/**
 * Runs the query against every source this surface has. A source that fails says
 * so once under the list instead of failing the whole search: the other groups
 * are still answers the user can act on.
 */
async function runGlobalSearch(text: string): Promise<void> {
  const ticket = ++runTicket;
  searchBusy.set(true);
  const failures: string[] = [];
  const settle = async <T>(run: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await run();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      return [];
    }
  };
  const remote = isRemoteWorkspace(activeWorkspace());
  const [messages, files] = await Promise.all([
    settle(() => messageItems(text)),
    remote ? Promise.resolve([] as SearchItem[]) : settle(() => fileItems(text)),
  ]);
  if (ticket !== runTicket) return;
  searchItems.set([
    ...sessionNameItems(text),
    ...messages,
    ...files,
  ]);
  const notices: string[] = [];
  if (remote) notices.push(tr("search.remoteFilesUnsupported"));
  if (failures.length) notices.push(tr("search.someSourcesFailed", { error: failures[0] }));
  searchNotice.set(notices.join(" "));
  searchBusy.set(false);
}

export function refreshGlobalSearch(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  // Invalidate on input, including while the next query is still debouncing.
  runTicket += 1;
  const text = searchText();
  const willSearch = effectiveSearchScope() !== "actions" && text.length >= 2;
  searchItems.set([]);
  searchNotice.set("");
  searchBusy.set(willSearch);
  if (!willSearch) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runGlobalSearch(text);
  }, 220);
}

export function setSearchQuery(text: string): void {
  searchQuery.set(text);
  refreshGlobalSearch();
}

export function setSearchScope(scope: SearchScope): void {
  if (searchActionPrefix() || scope === searchScope()) return;
  searchScope.set(scope);
  refreshGlobalSearch();
}

export function openGlobalSearch(seed = ""): void {
  searchScope.set("all");
  setSearchQuery(seed);
  searchOpen.set(true);
}

export function closeGlobalSearch(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  runTicket += 1;
  searchOpen.set(false);
  searchQuery.set("");
  searchItems.set([]);
  searchNotice.set("");
  searchBusy.set(false);
}

/** Runs a hit: the same navigation the sidebar and the scenes already use. */
export async function runSearchItem(item: SearchItem): Promise<void> {
  closeGlobalSearch();
  if (item.kind === "command") {
    navigateScene(item.target as SceneId);
    return;
  }
  if (item.kind === "workspace" || item.kind === "assistant") {
    const recent = recentWorkspaces().find(ws => ws.id === item.target);
    if (recent) await openRecentWorkspace(recent);
    else selectWorkspace(item.target);
    navigateScene(item.kind === "assistant" ? "assistants" : "sessions");
    return;
  }
  if (item.kind === "file") {
    navigateScene("files");
    await openFileAt(item.target);
    return;
  }
  // A hit in another opened workspace switches to it first; its catalogue loads
  // with the switch.
  if (item.workspaceId && item.workspaceId !== activeWorkspaceId()) {
    selectWorkspace(item.workspaceId);
  }
  await runStep(async () => {
    await loadSessions();
  });
  navigateScene("sessions");
  selectSession(item.target);
  if (item.kind === "message" && item.turnId) {
    searchRevealTurn.set({ sessionId: item.target, turnId: item.turnId });
  }
}
