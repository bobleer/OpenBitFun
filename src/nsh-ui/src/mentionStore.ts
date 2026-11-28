// The composer reference picker follows one pane and its owning runtime.
// Files become attachment tags and sessions carry the owner's persisted locator.

import { signal } from "nsh";
import type { ComposerInputHandle } from "./ui/PromptReferenceEditor";
import {
  executeSessionCommand,
  getDirectoryChildren,
  listSessionCommands,
  searchWorkspaceFiles,
  type WorkspaceEntry,
} from "./api";
import { addFileAttachment, addSessionReference, toRelativeWorkspacePath, type FileAttachment } from "./attachmentStore";
import { fleetActive, invokeCommand, invokeRawCommand } from "./bridge";
import { localDeviceId } from "./devicePrefsStore";
import { isRuntimeFleetDevice, isSidebarFleetDevice, remoteWorkspaceHost } from "./deviceTree";
import { fleetDeviceById, fleetDevices } from "./fleetStore";
import { tr, type MessageKey } from "./i18n";
import { fleetModelText, readChatModelsForDevice, readFleetModelsForDevice } from "./modelStore";
import {
  acpPromptToken,
  devicePromptToken,
  mcpPromptToken,
  modelPromptToken,
  skillPromptToken,
  workspacePromptToken,
} from "./promptReferences";
import { errorMessageOf } from "./shared/errorUtils";
import { isRemoteWorkspace } from "./shared/workspaceUtils";
import {
  activeSessionId,
  activeSessionDevice,
  activeSessionKey,
  activeWorkspaceId,
  activeWorkspaceRoot,
  activeWorkspace,
  agentTypeOf,
  chosenAgentType,
  composerText,
  deviceContext,
  sessions,
  workspaces,
} from "./state";
import { isCommandUnavailable as isMissingCommand } from "./hostCommands";
import { readSessionReference, sessionReferenceKey, type SessionReferenceCandidate } from "./sessionReferences";

export type MentionPromptKind = "skills" | "mcp" | "workspaces" | "devices" | "models" | "acp";

/** One row of the picker: a path the host reported, split into what a row shows. */
export interface MentionHit {
  path: string;
  name: string;
  directory: boolean;
  relativePath?: string;
  session?: SessionReferenceCandidate;
  prompt?: { kind: MentionPromptKind; token: string; scope: string };
}

export interface MentionOwner {
  pane: "primary" | "secondary";
  key: () => string | null;
  sessionId: () => string | null;
  deviceId: () => string;
  workspaceId: () => string | null;
  workspaceRoot: () => string;
  remoteWorkspace: () => boolean;
  draft: () => string;
  setDraft: (text: string) => void;
  addFile: (file: Omit<FileAttachment, "id">) => void;
  addSession: (reference: SessionReferenceCandidate) => void;
}

const primaryMentionOwner: MentionOwner = {
  pane: "primary",
  key: () => activeSessionKey() ?? `${deviceContext()}/workspace/${effectiveMentionWorkspaceId() ?? ""}`,
  sessionId: activeSessionId,
  deviceId: () => activeSessionDevice() || deviceContext(),
  workspaceId: effectiveMentionWorkspaceId,
  workspaceRoot: activeWorkspaceRoot,
  remoteWorkspace: () => isRemoteWorkspace(activeWorkspace()),
  draft: composerText,
  setDraft: composerText.set,
  addFile: addFileAttachment,
  addSession: addSessionReference,
};
let owner = primaryMentionOwner;
let ownerKey: string | null = null;

export const mentionOpen = signal(false);
export const mentionPane = signal<"primary" | "secondary">("primary");
export type MentionSource =
  | "sources"
  | "all"
  | "files"
  | "workspaces"
  | "devices"
  | "models"
  | "acp"
  | "sessions"
  | "skills"
  | "mcp";
export const mentionSource = signal<MentionSource>("files");
let explicitSource = false;
export const mentionQuery = signal("");
export const mentionBrowseDir = signal("");
export const mentionHits = signal<MentionHit[]>([]);
export const mentionSearched = signal(false);
export const mentionLoading = signal(false);
export const mentionNotice = signal("");
export const mentionRetryable = signal(false);
/** The host matched more names than the panel draws. */
export const mentionTruncated = signal(false);
/**
 * The panel was opened by typing `@` in the message, so the query lives in the
 * composer itself and the panel draws no field of its own: the desktop keeps the
 * caret where the user is typing too.
 */
export const mentionInline = signal(false);

/** Long enough to type through, short enough that the list follows the query. */
const SEARCH_DEBOUNCE_MS = 140;
/** Max rows drawn inside the scrollable mention popover. */
const RESULT_LIMIT = 24;
const IGNORED_BROWSE_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  "__pycache__",
  ".next",
  ".turbo",
]);

let debounceTimer: number | null = null;
/** Monotonic token for browse/search requests so slower answers never overwrite newer ones. */
let mentionReqSeq = 0;
const mentionCatalogs = new Map<string, Promise<MentionCatalog>>();

function effectiveMentionWorkspaceId(): string | null {
  const direct = activeWorkspaceId();
  if (direct) return direct;
  const sid = activeSessionId();
  if (!sid) return null;
  const row = sessions().find(item => item.sessionId === sid);
  return row?.workspaceId || null;
}

/** The tag for one row, in the shape the desktop composer writes it. */
export function mentionToken(hit: MentionHit): string {
  const ref = hit.relativePath || hit.name;
  return `#${hit.directory ? "dir" : "file"}:${ref} `;
}

export function mentionOwnerRoot(): string {
  return owner.workspaceRoot();
}

function bindMentionOwner(target: MentionOwner): void {
  owner = target;
  ownerKey = target.key();
  mentionPane.set(target.pane);
}

function mentionRoute() {
  const target = owner.deviceId();
  return target ? { target } : undefined;
}

export function mentionOwnerCurrent(): boolean {
  return ownerKey !== null && owner.key() === ownerKey;
}

function mentionMode(): string {
  const session = owner.sessionId();
  return session ? agentTypeOf(session, owner.deviceId()) : chosenAgentType();
}

function mentionCatalogScope(): string {
  return JSON.stringify([owner.deviceId(), owner.workspaceId(), owner.remoteWorkspace(), mentionMode()]);
}

export function openMention(target = primaryMentionOwner): void {
  closeMention();
  bindMentionOwner(target);
  mentionSource.set("sources");
  mentionNotice.set("");
  mentionRetryable.set(false);
  mentionQuery.set("");
  mentionBrowseDir.set("");
  mentionHits.set([]);
  mentionSearched.set(false);
  mentionTruncated.set(false);
  mentionInline.set(false);
  mentionOpen.set(true);
}

export function closeMention(): void {
  ++mentionReqSeq;
  mentionCatalogs.clear();
  mentionOpen.set(false);
  mentionInline.set(false);
  mentionLoading.set(false);
  mentionQuery.set("");
  mentionBrowseDir.set("");
  syncedText = null;
  syncedCaret = -1;
  inlineToken = null;
  explicitSource = false;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/** The `@…` the caret sits in, when the `@` opens a word. */
export interface MentionTrigger {
  /** Where the `@` is, in the composer's text. */
  start: number;
  /** Where the caret is, which is where the token ends: the token is what the caret
   * has just typed, so it never extends past it. */
  end: number;
  query: string;
}

/**
 * The mention being typed at `caret`, or `null`. A mention starts the message or
 * follows whitespace, and runs to the caret without another space or `@` in it —
 * the same shape the desktop's composer reads.
 */
export function mentionTriggerAt(text: string, caret: number): MentionTrigger | null {
  const limit = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, limit);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: before.length - query.length - 1, end: before.length, query };
}

/**
 * Follows the composer's text and caret: a typed `@` opens the panel with workspace
 * root browsing immediately on bare `@` and live file/folder search as the user types.
 */
export function syncInlineMention(text: string, caret: number, fromSelectionOnly = false, target = primaryMentionOwner): void {
  const inOtherPane = owner !== target && mentionOpen();
  if (inOtherPane && fromSelectionOnly) return;
  if (inOtherPane || (mentionOpen() && !mentionOwnerCurrent())) closeMention();
  // Selection reports while clicking a popover row keep the active token intact so the row press succeeds.
  if (fromSelectionOnly && text === syncedText && mentionOpen() && mentionInline()) {
    const triggerAtCaret = mentionTriggerAt(text, caret);
    if (!triggerAtCaret) return;
  }
  if (text === syncedText && caret === syncedCaret) return;
  syncedText = text;
  syncedCaret = caret;
  const trigger = mentionTriggerAt(text, caret);
  if (!trigger) {
    inlineToken = null;
    if (mentionOpen() && mentionInline()) closeMention();
    return;
  }
  const wasOpen = mentionOpen() && mentionInline();
  if (!wasOpen && mentionOpen()) closeMention();
  inlineToken = { start: trigger.start, end: trigger.end };
  if (!wasOpen) {
    bindMentionOwner(target);
    mentionSource.set(trigger.query.trim() ? "all" : "files");
    mentionNotice.set("");
    mentionHits.set([]);
    mentionSearched.set(false);
    mentionTruncated.set(false);
    mentionBrowseDir.set("");
    mentionOpen.set(true);
  }
  mentionInline.set(true);
  if (!wasOpen || mentionQuery() !== trigger.query) {
    if (!explicitSource) mentionSource.set(trigger.query.trim() ? "all" : "files");
    setMentionQuery(trigger.query);
  }
}

export function browseMentionDir(dirPath: string): void {
  if (!mentionOpen()) return;
  mentionBrowseDir.set(dirPath);
  mentionQuery.set("");
  mentionNotice.set("");
  mentionRetryable.set(false);
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  void loadMentionDirectory(dirPath);
}

export function browseMentionParent(): void {
  const current = mentionBrowseDir().replace(/[\\/]+$/, "");
  const root = owner.workspaceRoot().replace(/[\\/]+$/, "");
  if (!current || current === root) return;
  const lastSep = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
  if (lastSep <= 0) {
    browseMentionDir("");
    return;
  }
  const parent = current.slice(0, lastSep);
  if (root && !parent.startsWith(root)) {
    browseMentionDir("");
    return;
  }
  browseMentionDir(parent === root ? "" : parent);
}

async function loadMentionDirectory(dirPath: string): Promise<void> {
  const workspaceId = owner.workspaceId();
  const root = owner.workspaceRoot().replace(/[\\/]+$/, "");
  if (!workspaceId || !mentionOpen()) return;
  const target = dirPath || root;
  if (!target) return;
  const seq = ++mentionReqSeq;
  mentionLoading.set(true);
  mentionNotice.set("");
  mentionRetryable.set(false);
  try {
    const raw = await getDirectoryChildren(workspaceId, target, mentionRoute());
    if (seq !== mentionReqSeq || !mentionOpen() || !mentionOwnerCurrent()) return;
    const entries: WorkspaceEntry[] = Array.isArray(raw) ? raw : [];
    const atRoot = !dirPath || dirPath === root;
    const filtered = entries.filter(entry => {
      const name = (entry.name || entry.path.split(/[\\/]/).filter(Boolean).pop() || "").trim();
      if (!name) return false;
      if (atRoot && entry.isDirectory && IGNORED_BROWSE_DIRS.has(name)) return false;
      return true;
    });
    filtered.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return (a.name || a.path).localeCompare(b.name || b.path, undefined, { sensitivity: "base" });
    });
    const hits: MentionHit[] = filtered.slice(0, RESULT_LIMIT).map(entry => {
      const name = entry.name || entry.path.split(/[\\/]/).filter(Boolean).pop() || entry.path;
      return {
        path: entry.path,
        name,
        directory: Boolean(entry.isDirectory),
        relativePath: toRelativeWorkspacePath(entry.path, root) ?? name,
      };
    });
    mentionHits.set(hits);
    mentionTruncated.set(filtered.length > hits.length);
    mentionSearched.set(false);
  } catch (error) {
    if (seq !== mentionReqSeq) return;
    mentionHits.set([]);
    mentionTruncated.set(false);
    mentionNotice.set(error instanceof Error ? error.message : String(error));
  } finally {
    if (seq === mentionReqSeq) mentionLoading.set(false);
  }
}

/**
 * A query entered in the popup searches every source. Clearing it returns
 * to the source list or the source and directory being browsed.
 */
export function setMentionQuery(query: string): void {
  ++mentionReqSeq;
  mentionQuery.set(query);
  mentionNotice.set("");
  mentionRetryable.set(false);
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  const trimmed = query.trim();
  if (!trimmed && mentionSource() === "all") {
    mentionSource.set("files");
    explicitSource = false;
  }
  const source = mentionResultSource();
  if (source === "sources") {
    mentionHits.set([]);
    mentionSearched.set(false);
    mentionTruncated.set(false);
    mentionLoading.set(false);
    return;
  }
  if (source === "sessions" || isPromptSource(source)) {
    const search = source === "sessions"
      ? () => searchSessionMentions(trimmed)
      : () => searchCatalogMentions(source, trimmed);
    mentionHits.set([]);
    mentionTruncated.set(false);
    mentionLoading.set(true);
    if (!trimmed) {
      void search();
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void search();
    }, SEARCH_DEBOUNCE_MS);
    return;
  }
  if (!trimmed) {
    mentionSearched.set(false);
    mentionTruncated.set(false);
    void loadMentionDirectory(mentionBrowseDir());
    return;
  }
  // Drop unfiltered root-browse rows immediately when transitioning into search
  // so stale non-matching files never linger while the search debounce settles.
  mentionHits.set([]);
  mentionTruncated.set(false);
  mentionLoading.set(true);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void searchMentions(trimmed);
  }, SEARCH_DEBOUNCE_MS);
}

async function searchMentions(query: string): Promise<void> {
  const workspaceId = owner.workspaceId();
  if (!mentionOpen() || !mentionOwnerCurrent()) return;
  const all = mentionResultSource() === "all";
  const scope = mentionCatalogScope();
  const includeSessions = all && canSearchSessionReferences();
  const seq = ++mentionReqSeq;
  mentionLoading.set(true);
  const [files, sessionMatches, workspaceMatches, deviceMatches, modelMatches, acpMatches, skills, mcp] = await Promise.allSettled([
    workspaceId ? searchWorkspaceFiles(workspaceId, query, {
      searchContent: false,
      maxResults: RESULT_LIMIT + 6,
    }, mentionRoute()) : Promise.resolve([]),
    includeSessions ? fetchSessionMentions(query) : Promise.resolve([]),
    all ? readMentionCatalog("workspaces").then(catalog => matchCatalog(catalog, query)) : Promise.resolve([]),
    all ? readMentionCatalog("devices").then(catalog => matchCatalog(catalog, query)) : Promise.resolve([]),
    all ? readMentionCatalog("models").then(catalog => matchCatalog(catalog, query)) : Promise.resolve([]),
    all ? readMentionCatalog("acp").then(catalog => matchCatalog(catalog, query)) : Promise.resolve([]),
    all ? readMentionCatalog("skills").then(catalog => matchCatalog(catalog, query)) : Promise.resolve([]),
    all && !owner.remoteWorkspace()
      ? readMentionCatalog("mcp").then(catalog => matchCatalog(catalog, query)) : Promise.resolve([]),
  ]);
  if (seq !== mentionReqSeq || !mentionOpen() || !mentionOwnerCurrent() || owner.workspaceId() !== workspaceId) return;
  const rows = files.status === "fulfilled" ? rowsOf(files.value) : [];
  const fileHits = hitsOf(rows, query);
  const sessionHits = sessionMatches.status === "fulfilled" ? sessionMatches.value : [];
  const currentScope = mentionCatalogScope() === scope;
  const workspaceHits = currentScope && workspaceMatches.status === "fulfilled" ? workspaceMatches.value : [];
  const deviceHits = currentScope && deviceMatches.status === "fulfilled" ? deviceMatches.value : [];
  const modelHits = currentScope && modelMatches.status === "fulfilled" ? modelMatches.value : [];
  const acpHits = currentScope && acpMatches.status === "fulfilled" ? acpMatches.value : [];
  const skillHits = currentScope && skills.status === "fulfilled" ? skills.value : [];
  const mcpHits = currentScope && mcp.status === "fulfilled" ? mcp.value : [];
  const sources = [fileHits, workspaceHits, deviceHits, modelHits, acpHits, sessionHits, skillHits, mcpHits];
  const counts = sources.map(() => 0);
  let remaining = RESULT_LIMIT;
  for (let row = 0; row < RESULT_LIMIT && remaining > 0; row++) {
    for (const [index, hits] of sources.entries()) {
      if (row >= hits.length || remaining === 0) continue;
      counts[index]++;
      remaining--;
    }
  }
  const combined = sources.flatMap((hits, index) => hits.slice(0, counts[index]));
  mentionHits.set(combined);
  const totalMatches = rows.length + workspaceHits.length + deviceHits.length + modelHits.length + acpHits.length
    + sessionHits.length + skillHits.length + mcpHits.length;
  mentionTruncated.set(totalMatches > combined.length);
  mentionSearched.set(true);
  if (files.status === "rejected") {
    const error = files.reason;
    mentionNotice.set(
      `This host cannot search its files: ${error instanceof Error ? error.message : String(error)}`,
    );
  } else if (sessionMatches.status === "rejected" && !isMissingCommand(sessionMatches.reason, "search_referenceable_sessions")) {
    mentionNotice.set(tr("sessions.mentionSessionSearchFailed"));
  }
  mentionLoading.set(false);
}

export function mentionResultSource(): MentionSource {
  return !mentionInline() && mentionQuery().trim() ? "all" : mentionSource();
}

/** The host's rows: `search_files` answers a list, and a host that wraps it says `results`. */
function rowsOf(reply: unknown): unknown[] {
  if (Array.isArray(reply)) return reply;
  const record = (reply ?? {}) as Record<string, unknown>;
  return Array.isArray(record.results) ? record.results : [];
}

/** The host's rows, one per path, with workspace root applied and exact/prefix matches ranked first. */
function hitsOf(rows: unknown[], query = ""): MentionHit[] {
  const root = owner.workspaceRoot().replace(/[\\/]+$/, "");
  const hits: MentionHit[] = [];
  const seen = new Set<string>();
  const q = query.trim().toLowerCase();
  for (const row of rows) {
    const record = (row ?? {}) as Record<string, unknown>;
    const raw = record.path ?? record.filePath ?? record.file ?? record.name;
    if (typeof raw !== "string" || !raw) continue;
    const directory = record.is_directory === true || record.isDirectory === true;
    const path = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || !root ? raw : `${root}/${raw}`;
    if (seen.has(path)) continue;
    seen.add(path);
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? raw;
    const relativePath = toRelativeWorkspacePath(path, root) ?? name;
    hits.push({ path, name, directory, relativePath });
  }
  if (q) {
    const score = (hit: MentionHit) => {
      const lowerName = hit.name.toLowerCase();
      if (lowerName === q) return 0;
      if (lowerName.startsWith(q)) return 1;
      if (lowerName.includes(q)) return 2;
      return 3;
    };
    hits.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }
  return hits.slice(0, RESULT_LIMIT);
}

let inlineToken: { start: number; end: number } | null = null;
let syncedText: string | null = null;
let syncedCaret = -1;

/**
 * Attaches the chosen file/folder as a styled `FileAttachment` chip in the composer
 * and strips the inline `@query` token (if triggered inline) instead of dumping raw `#file:` text.
 */
export function insertMention(hit: MentionHit, composer: ComposerInputHandle | undefined): void {
  if (!mentionOwnerCurrent()) {
    closeMention();
    return;
  }
  const target = owner;
  const replacing = mentionInline() ? inlineToken : null;
  const selection = composer?.selection();
  inlineToken = null;
  closeMention();
  if (hit.prompt) {
    if (hit.prompt.scope !== mentionCatalogScope()) return;
    const text = target.draft();
    const current = selection?.text === text ? selection : undefined;
    const start = replacing?.start ?? current?.start ?? text.length;
    const end = replacing?.end ?? current?.end ?? start;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = /^\s/.test(after) ? "" : " ";
    const inserted = `${before}${prefix}${hit.prompt.token}${suffix}`;
    target.setDraft(inserted + after);
    queueMicrotask(() => {
      composer?.focus();
      composer?.setSelection(inserted.length);
    });
    return;
  }
  if (hit.session) {
    target.addSession(hit.session);
  } else {
    target.addFile({
      name: hit.name,
      path: hit.path,
      relativePath: hit.relativePath || toRelativeWorkspacePath(hit.path, target.workspaceRoot()) || hit.name,
      isDirectory: hit.directory,
      source: hit.directory ? "folder" : "file",
    });
  }
  if (replacing) {
    const text = target.draft();
    const before = text.slice(0, replacing.start);
    const after = text.slice(replacing.end);
    const next = before && after && !/\s$/.test(before) && !/^\s/.test(after) ? `${before} ${after}` : `${before}${after}`;
    target.setDraft(next);
  }
  composer?.focus();
}

export function selectMentionSource(source: MentionSource): void {
  if (source === mentionSource() || !mentionOwnerCurrent()) return;
  explicitSource = true;
  if (source === "sources") mentionBrowseDir.set("");
  mentionSource.set(source);
  mentionHits.set([]);
  mentionSearched.set(false);
  mentionTruncated.set(false);
  setMentionQuery(mentionQuery());
}

function canSearchSessionReferences(): boolean {
  const device = fleetDeviceById(owner.deviceId());
  if (!device || device.hostKind !== "cli") return true;
  return device.hostCapabilities.includes("session_reference_browse_v1");
}

async function fetchSessionMentions(query: string): Promise<MentionHit[]> {
  const sessionId = owner.sessionId();
  const candidates = await invokeCommand<unknown>("search_referenceable_sessions", {
    ...(query ? { query } : {}), limit: RESULT_LIMIT + 1,
  }, mentionRoute());
  if (!Array.isArray(candidates)) throw new Error("Invalid session reference search response");
  return candidates.flatMap(candidate => {
    const session = readSessionReference(candidate);
    return session && session.sessionId !== sessionId ? [{
      path: sessionReferenceKey(session),
      name: session.sessionName,
      directory: false,
      relativePath: session.workspaceLabel,
      session,
    }] : [];
  });
}

async function searchSessionMentions(query: string): Promise<void> {
  if (!mentionOpen() || !mentionOwnerCurrent()) return;
  const seq = ++mentionReqSeq;
  const command = "search_referenceable_sessions";
  try {
    if (!canSearchSessionReferences()) {
      mentionNotice.set(tr("sessions.mentionSessionUnavailable"));
      return;
    }
    const hits = await fetchSessionMentions(query);
    if (seq !== mentionReqSeq || !mentionOwnerCurrent()) return;
    mentionHits.set(hits.slice(0, RESULT_LIMIT));
    mentionTruncated.set(hits.length > RESULT_LIMIT);
    mentionSearched.set(true);
  } catch (failure) {
    if (seq !== mentionReqSeq || !mentionOwnerCurrent()) return;
    mentionNotice.set(isMissingCommand(failure, command)
      ? tr("sessions.mentionSessionUnavailable")
      : tr("sessions.mentionSessionSearchFailed"));
  } finally {
    if (seq === mentionReqSeq) mentionLoading.set(false);
  }
}

type PromptSource = MentionPromptKind;
type MentionCatalog = {
  entries: { hit: MentionHit; keywords: string[] }[];
  notice?: MessageKey;
};

function isPromptSource(source: MentionSource): source is PromptSource {
  return (
    source === "skills" ||
    source === "mcp" ||
    source === "workspaces" ||
    source === "devices" ||
    source === "models" ||
    source === "acp"
  );
}

function readWorkspacesMentionCatalog(scope: string): MentionCatalog {
  if (fleetActive()) {
    const devices = fleetDevices().filter(isSidebarFleetDevice);
    const multiDevice = devices.length > 1;
    const entries: MentionCatalog["entries"] = [];
    for (const device of devices) {
      for (const workspace of device.workspaces) {
        const wsName =
          workspace.name?.trim() ||
          workspace.rootPath.split(/[\\/]/).filter(Boolean).pop() ||
          workspace.workspaceId;
        const remoteAlias = remoteWorkspaceHost(workspace);
        const subtitle =
          [multiDevice ? device.name : "", remoteAlias ?? "", workspace.rootPath]
            .filter(Boolean)
            .join(" · ") || workspace.workspaceId;
        entries.push({
          hit: {
            path: `workspace:${device.deviceId}:${workspace.workspaceId}`,
            name: wsName,
            directory: false,
            relativePath: subtitle,
            prompt: {
              kind: "workspaces",
              token: workspacePromptToken(workspace.workspaceId, wsName, {
                rootPath: workspace.rootPath,
                deviceId: device.deviceId,
              }),
              scope,
            },
          },
          keywords: [
            "workspace",
            workspace.workspaceId,
            wsName,
            workspace.rootPath,
            workspace.kind,
            device.name,
            device.deviceId,
            remoteAlias ?? "",
            workspace.sshHost ?? "",
            workspace.connectionName ?? "",
          ].filter(Boolean),
        });
      }
    }
    return { entries };
  }
  const entries: MentionCatalog["entries"] = workspaces().map(ws => {
    const wsName = ws.name?.trim() || ws.rootPath.split(/[\\/]/).filter(Boolean).pop() || ws.id;
    const remoteAlias = remoteWorkspaceHost(ws);
    const subtitle = [remoteAlias ?? "", ws.rootPath].filter(Boolean).join(" · ") || ws.id;
    return {
      hit: {
        path: `workspace:local:${ws.id}`,
        name: wsName,
        directory: false,
        relativePath: subtitle,
        prompt: {
          kind: "workspaces",
          token: workspacePromptToken(ws.id, wsName, { rootPath: ws.rootPath }),
          scope,
        },
      },
      keywords: [
        "workspace",
        ws.id,
        wsName,
        ws.rootPath,
        ws.workspaceKind ?? "",
        remoteAlias ?? "",
        ws.sshHost ?? "",
        ws.connectionName ?? "",
      ].filter(Boolean),
    };
  });
  return { entries };
}

function readDevicesMentionCatalog(scope: string): MentionCatalog {
  if (fleetActive()) {
    const entries: MentionCatalog["entries"] = fleetDevices()
      .filter(isRuntimeFleetDevice)
      .map(device => {
        const name = device.name?.trim() || device.deviceId;
        const subtitle =
          [
            device.isClientDevice ? tr("device.thisDevice") : "",
            device.hostKind && device.hostKind !== "unknown" ? device.hostKind : "",
            device.state && device.state !== "online" ? device.state : "",
            device.deviceId,
          ]
            .filter(Boolean)
            .join(" · ") || device.deviceId;
        return {
          hit: {
            path: `device:${device.deviceId}`,
            name,
            directory: false,
            relativePath: subtitle,
            prompt: {
              kind: "devices",
              token: devicePromptToken(device.deviceId, name),
              scope,
            },
          },
          keywords: [
            "device",
            device.deviceId,
            name,
            device.hostKind,
            device.state,
            ...(device.isClientDevice ? ["self", "local", tr("device.thisDevice")] : []),
          ].filter(Boolean),
        };
      });
    return { entries };
  }
  const id = localDeviceId() || "self";
  const name = tr("device.thisDevice");
  const subtitle = localDeviceId() ? `${tr("common.local")} · ${localDeviceId()}` : tr("common.local");
  return {
    entries: [
      {
        hit: {
          path: `device:${id}`,
          name,
          directory: false,
          relativePath: subtitle,
          prompt: {
            kind: "devices",
            token: devicePromptToken(id, name),
            scope,
          },
        },
        keywords: ["device", "self", "local", id, name],
      },
    ],
  };
}

async function readModelsMentionCatalog(scope: string, deviceId: string): Promise<MentionCatalog> {
  if (fleetActive()) {
    try {
      const groups = await readFleetModelsForDevice(deviceId || undefined);
      if (groups && groups.length > 0) {
        const entries: MentionCatalog["entries"] = [];
        for (const device of groups) {
          if (!device.online || device.unavailableReason) continue;
          const sameDevice = device.isThisDevice || (Boolean(deviceId) && device.deviceId === deviceId);
          for (const choice of device.models) {
            if (!choice.selectable) continue;
            const text = fleetModelText(choice);
            const label = sameDevice ? text.label : `${text.label} · ${device.name}`;
            const subtitle =
              [
                text.detail || choice.provider,
                choice.modelName && choice.modelName !== text.label ? choice.modelName : "",
                sameDevice ? "" : device.name,
              ]
                .filter(Boolean)
                .join(" · ") || choice.modelRef;
            entries.push({
              hit: {
                path: `model:${choice.modelRef}`,
                name: label,
                directory: false,
                relativePath: subtitle,
                prompt: {
                  kind: "models",
                  token: modelPromptToken(choice.modelRef, label, { modelName: choice.modelName }),
                  scope,
                },
              },
              keywords: [
                "model",
                choice.modelRef,
                choice.modelId,
                choice.displayName,
                choice.modelName ?? "",
                choice.provider,
                text.label,
                text.detail,
                device.name,
                device.deviceId,
              ].filter(Boolean),
            });
          }
        }
        return { entries };
      }
    } catch {
      // Older fleet entries without `fleet_models` fall back to the owning device's model catalog.
    }
  }
  const options = await readChatModelsForDevice(deviceId);
  return {
    entries: options.map(option => {
      const subtitle =
        [
          option.detail || option.provider,
          option.modelName && option.modelName !== option.label ? option.modelName : "",
        ]
          .filter(Boolean)
          .join(" · ") || option.id;
      return {
        hit: {
          path: `model:${option.id}`,
          name: option.label,
          directory: false,
          relativePath: subtitle,
          prompt: {
            kind: "models",
            token: modelPromptToken(option.id, option.label, { modelName: option.modelName }),
            scope,
          },
        },
        keywords: [
          "model",
          option.id,
          option.configId,
          option.configName,
          option.modelName,
          option.provider,
          option.detail,
        ].filter(Boolean),
      };
    }),
  };
}

function readAcpString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function readAcpMentionCatalog(
  scope: string,
  deviceId: string,
  route: ReturnType<typeof mentionRoute>,
): Promise<MentionCatalog> {
  const device = fleetDeviceById(deviceId);
  if (device?.hostKind === "cli" && !device.hostCapabilities.includes("acp_client_host_v1")) {
    return { entries: [], notice: "sessions.mentionAcpUnavailable" };
  }
  const raw = await invokeCommand<unknown>("get_acp_clients", {}, route);
  if (!Array.isArray(raw)) {
    return { entries: [], notice: "sessions.mentionAcpUnavailable" };
  }
  const entries: MentionCatalog["entries"] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (record.enabled !== true) continue;
    const id = readAcpString(record, ["id", "clientId", "client_id"]);
    if (!id) continue;
    const name = readAcpString(record, ["name", "displayName", "display_name"]) || id;
    const toolName = readAcpString(record, ["toolName", "tool_name"]);
    const status = readAcpString(record, ["status"]);
    const command = readAcpString(record, ["command"]);
    const subtitle = [toolName || id, status === "running" ? tr("common.running") : ""].filter(Boolean).join(" · ");
    entries.push({
      hit: {
        path: `acp:${id}`,
        name,
        directory: false,
        relativePath: subtitle,
        prompt: {
          kind: "acp",
          token: acpPromptToken(id, name, toolName || undefined),
          scope,
        },
      },
      keywords: ["acp", id, name, toolName, command, status].filter(Boolean),
    });
  }
  return { entries };
}

function readMentionCatalog(source: PromptSource): Promise<MentionCatalog> {
  const scope = mentionCatalogScope();
  if (source === "workspaces") return Promise.resolve(readWorkspacesMentionCatalog(scope));
  if (source === "devices") return Promise.resolve(readDevicesMentionCatalog(scope));
  const key = JSON.stringify([source, scope]);
  const existing = mentionCatalogs.get(key);
  if (existing) return existing;
  const deviceId = owner.deviceId();
  const workspaceId = owner.workspaceId();
  const mode = mentionMode();
  const route = mentionRoute();
  const current = () => mentionOpen() && mentionOwnerCurrent() && scope === mentionCatalogScope();
  const remote = owner.remoteWorkspace();
  let promise: Promise<MentionCatalog>;
  if (source === "mcp") {
    promise = remote
      ? Promise.resolve<MentionCatalog>({ entries: [], notice: "sessions.mentionMcpRemote" })
      : readMcpMentionCatalog(scope, mode, workspaceId, route);
  } else if (source === "models") {
    promise = readModelsMentionCatalog(scope, deviceId);
  } else if (source === "acp") {
    promise = readAcpMentionCatalog(scope, deviceId, route);
  } else {
    promise = readSlashSkills(current, mode, workspaceId, owner.workspaceRoot(), false, route, true)
      .then(skills => ({
        entries: skills.map(skill => ({
          hit: {
            path: `skill:${skill.key ?? skill.name}`, name: skill.name, directory: false,
            relativePath: skill.description || skill.argumentHint,
            prompt: { kind: "skills" as const, token: skillPromptToken(skill.name), scope },
          },
          keywords: [skill.description, skill.argumentHint ?? ""],
        })),
      }));
  }
  mentionCatalogs.set(key, promise);
  return promise;
}

async function readMcpMentionCatalog(
  scope: string, modeId: string, workspaceId: string | null, route: ReturnType<typeof mentionRoute>,
): Promise<MentionCatalog> {
  const raw = await invokeCommand<unknown>("get_chat_mcp_catalog", {
    modeId, ...(workspaceId ? { workspaceId } : {}),
  }, route);
  const catalog = raw as { tools?: unknown; modeRestricted?: unknown } | null;
  if (!Array.isArray(catalog?.tools) || typeof catalog.modeRestricted !== "boolean") {
    return { entries: [], notice: "sessions.mentionMcpUnavailable" };
  }
  const servers = new Map<string, MentionCatalog["entries"][number]>();
  for (const tool of catalog.tools) {
    const row = tool as Record<string, unknown> | null;
    const id = row?.serverId;
    const name = row?.serverName;
    if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim()) continue;
    let entry = servers.get(id);
    if (!entry) {
      entry = {
        hit: {
          path: `mcp:${id}`, name, directory: false, relativePath: id,
          prompt: { kind: "mcp", token: mcpPromptToken(id, name), scope },
        },
        keywords: ["mcp", id],
      };
      servers.set(id, entry);
    }
    for (const value of [row?.name, row?.toolName, row?.description]) {
      if (typeof value === "string") entry.keywords.push(value);
    }
  }
  return {
    entries: [...servers.values()],
    notice: catalog.modeRestricted ? "sessions.mentionMcpRestricted" : undefined,
  };
}

function matchCatalog(catalog: MentionCatalog, query: string): MentionHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return catalog.entries.map(entry => entry.hit);
  const rank = ({ hit }: MentionCatalog["entries"][number]) => {
    const name = hit.name.toLowerCase();
    return name === needle ? 0 : name.startsWith(needle) ? 1 : 2;
  };
  return catalog.entries
    .filter(({ hit, keywords }) => [hit.name, ...keywords].some(value => value.toLowerCase().includes(needle)))
    .sort((a, b) => rank(a) - rank(b))
    .map(entry => entry.hit);
}

async function searchCatalogMentions(source: PromptSource, query: string): Promise<void> {
  if (!mentionOpen() || !mentionOwnerCurrent()) return;
  const scope = mentionCatalogScope();
  const seq = ++mentionReqSeq;
  const current = () => seq === mentionReqSeq && mentionOwnerCurrent() && scope === mentionCatalogScope();
  try {
    const catalog = await readMentionCatalog(source);
    if (!current()) return;
    const hits = matchCatalog(catalog, query);
    mentionHits.set(hits.slice(0, RESULT_LIMIT));
    mentionTruncated.set(hits.length > RESULT_LIMIT);
    mentionSearched.set(true);
    if (catalog.notice) mentionNotice.set(tr(catalog.notice));
  } catch (failure) {
    if (!current()) return;
    if (source === "mcp") {
      const unavailable = isMissingCommand(failure, "get_chat_mcp_catalog");
      mentionNotice.set(tr(unavailable ? "sessions.mentionMcpUnavailable" : "sessions.mentionMcpFailed"));
      mentionRetryable.set(!unavailable);
    } else if (source === "models") {
      const unavailable = isMissingCommand(failure, "get_ai_model_catalog");
      mentionNotice.set(tr(unavailable ? "sessions.mentionModelsUnavailable" : "sessions.mentionModelsFailed"));
      mentionRetryable.set(!unavailable);
    } else if (source === "acp") {
      const unavailable =
        isMissingCommand(failure, "get_acp_clients") ||
        /acp client service not initialized/i.test(errorMessageOf(failure));
      mentionNotice.set(tr(unavailable ? "sessions.mentionAcpUnavailable" : "sessions.mentionAcpFailed"));
      mentionRetryable.set(!unavailable);
    } else {
      const unavailable = isMissingCommand(failure, "get_mode_skill_configs");
      mentionNotice.set(tr(unavailable ? "sessions.mentionSkillsUnavailable" : "sessions.mentionSkillsFailed"));
      mentionRetryable.set(!unavailable);
    }
  } finally {
    if (seq === mentionReqSeq) mentionLoading.set(false);
  }
}

export function retryMentionCatalog(): void {
  mentionCatalogs.delete(JSON.stringify([mentionSource(), mentionCatalogScope()]));
  setMentionQuery(mentionQuery());
}

// Slash commands & Skills. A composer that holds `/name` (no space yet) opens the
// command + skills list; pressing a row or sending the exact command runs it instead
// of starting a plain turn.

export interface SlashCommand {
  id: string;
  command: string;
  /** The catalog key the host names; `description` is its English fallback. */
  labelKey: string;
  description: string;
  /** Commands that start or rewrite a turn wait until the running one ends. */
  idleOnly: boolean;
  /** Whether the host would run it right now. */
  available: boolean;
  args: string[];
  /** True for client-local / 2.0-wired composer commands that execute directly in nsh-ui. */
  local?: boolean;
  /** Optional usage hint displayed right beside the command (e.g. `[question]`). */
  argHint?: string;
}

export interface SlashSkillItem {
  name: string;
  description: string;
  argumentHint?: string;
  key?: string;
}

/** Client-local and 2.0-wired slash commands always discoverable in the `/` menu (1.0.12 parity). */
export const LOCAL_SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  {
    id: "model",
    command: "/model",
    labelKey: "sessions.model",
    description: "Switch model",
    idleOnly: false,
    available: true,
    args: [],
    local: true,
    argHint: "[name]",
  },
  {
    id: "goal",
    command: "/goal",
    labelKey: "sessions.slashGoalDesc",
    description: "Set, pause, resume, or clear the session goal",
    idleOnly: false,
    available: true,
    args: ["clear", "pause", "resume", "edit"],
    local: true,
    argHint: "[objective | clear | pause | resume]",
  },
  {
    id: "btw",
    command: "/btw",
    labelKey: "sessions.slashBtwDesc",
    description: "Ask a side question without interrupting the turn",
    idleOnly: false,
    available: true,
    args: [],
    local: true,
    argHint: "[question]",
  },
  {
    id: "review",
    command: "/review",
    labelKey: "sessions.slashReviewDesc",
    description: "Launch a code review on current changes",
    idleOnly: false,
    available: true,
    args: [],
    local: true,
    argHint: "[strict] [focus]",
  },
  {
    id: "usage",
    command: "/usage",
    labelKey: "sessions.slashUsageDesc",
    description: "Show token usage for this session",
    idleOnly: false,
    available: true,
    args: [],
    local: true,
  },
];

const SLASH_SKILL_NAME_RE = /^[A-Za-z][\w:-]*$/;

/** One catalog for each mounted composer, with independent session and device reads. */
export function createSlashCommandCatalog() {
  const sessionCommands = signal<SlashCommand[]>([]);
  const unsupported = signal(false);
  const skills = signal<SlashSkillItem[]>([]);
  let commandsRequest: { key: string; promise: Promise<void> } | undefined;
  let skillsRequest: { key: string; promise: Promise<void> } | undefined;

  function commands(): SlashCommand[] {
    const host = sessionCommands();
    const seen = new Set(host.map(entry => entry.id));
    return [...host, ...LOCAL_SLASH_COMMANDS.filter(entry => !seen.has(entry.id))];
  }

  function loadCommands(sessionId: string | null, device: string): Promise<void> {
    const key = JSON.stringify([device, sessionId]);
    if (commandsRequest?.key === key) return commandsRequest.promise;
    sessionCommands.set([]);
    unsupported.set(false);
    const route = fleetActive() && device ? { target: device } : undefined;
    const promise = listSessionCommands(sessionId, route).then(rows => {
      if (commandsRequest?.promise !== promise) return;
      sessionCommands.set((rows ?? []).map(row => ({
        id: String(row.id), command: row.command || `/${row.id}`, labelKey: row.labelKey ?? "",
        description: row.description ?? "", idleOnly: row.idleOnly === true,
        available: row.available !== false, args: Array.isArray(row.args) ? row.args : [],
      })));
    }).catch(error => {
      if (commandsRequest?.promise === promise) unsupported.set(isMissingCommand(error, "list_session_commands"));
    });
    commandsRequest = { key, promise };
    return promise;
  }

  function loadSkills(device: string, modeId: string, workspaceId: string | null, workspacePath: string, force = false): Promise<void> {
    const key = JSON.stringify([device, modeId, workspaceId, workspacePath]);
    if (!force && skillsRequest?.key === key) return skillsRequest.promise;
    if (skillsRequest?.key !== key) skills.set([]);
    const route = fleetActive() && device ? { target: device } : undefined;
    const current = () => skillsRequest?.promise === promise;
    const promise = readSlashSkills(current, modeId, workspaceId, workspacePath, force, route).then(rows => {
      if (current()) skills.set(rows);
    });
    skillsRequest = { key, promise };
    return promise;
  }

  function reset() {
    commandsRequest = undefined;
    skillsRequest = undefined;
    sessionCommands.set([]);
    unsupported.set(false);
    skills.set([]);
  }

  return { commands, unsupported, skills, loadCommands, loadSkills, reset };
}

async function readSlashSkills(
  current: () => boolean,
  modeId: string,
  workspaceId: string | null,
  workspacePath: string,
  force: boolean,
  route?: { target: string },
  strictMode = false,
): Promise<SlashSkillItem[]> {
  try {
    let raw: unknown;
    try {
      raw = await invokeRawCommand<unknown>("get_mode_skill_configs", {
        modeId: modeId || "Standard",
        forceRefresh: force,
        includeDiagnostics: false,
        workspaceId: workspaceId || undefined,
        workspacePath: workspacePath || undefined,
      }, route);
    } catch (error) {
      if (!current()) return [];
      if (strictMode) throw error;
      raw = await invokeRawCommand<unknown>("get_skill_configs", {
        forceRefresh: force,
        includeDiagnostics: false,
        workspaceId: workspaceId ?? null,
        workspacePath: workspacePath || null,
      }, route);
    }
    if (!current()) return [];
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { skills?: unknown[] } | null)?.skills)
        ? (raw as { skills: unknown[] }).skills
        : undefined;
    if (!rows) {
      if (strictMode) throw new Error("Invalid mode skill catalog");
      return [];
    }
    const seen = new Set<string>();
    const items: SlashSkillItem[] = [];
    for (const row of rows) {
      const rec = (row ?? {}) as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name.trim() : "";
      if (!name || !SLASH_SKILL_NAME_RE.test(name)) continue;
      if (rec.enabled === false || rec.disabled === true) continue;
      if (rec.selectedForRuntime === false || rec.selected_for_runtime === false) continue;
      if (rec.effectiveEnabled === false || rec.effective_enabled === false) continue;
      if (rec.globallyEnabled === false || rec.globally_enabled === false) continue;
      if (rec.allowUserInvocation === false || rec.allow_user_invocation === false) continue;
      const lower = name.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      items.push({
        name,
        description: typeof rec.description === "string" ? rec.description.trim() : "",
        argumentHint:
          typeof rec.argumentHint === "string"
            ? rec.argumentHint.trim() || undefined
            : typeof rec.argument_hint === "string"
              ? rec.argument_hint.trim() || undefined
              : undefined,
        key: typeof rec.key === "string" ? rec.key : undefined,
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return items;
  } catch (error) {
    if (strictMode) throw error;
    return [];
  }
}

/** The label a row shows: the client catalog's text when it has the key. */
export function slashCommandLabel(command: SlashCommand): string {
  const key = command.labelKey as MessageKey;
  const text = command.labelKey ? tr(key) : "";
  return text && text !== command.labelKey ? text : command.description;
}

/** The command list the composer's text asks for, or `null` when it is not a slash token. */
export function slashCommandsFor(text: string, running: boolean, commands: readonly SlashCommand[]): SlashCommand[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  return commands.filter(entry => {
    if (running && entry.idleOnly) return false;
    const cmd = entry.command.slice(1).toLowerCase();
    if (cmd.startsWith(query) || cmd.includes(query)) return true;
    if (entry.id === "reload" && "reload-skills".startsWith(query)) return true;
    return false;
  });
}

/** Matching enabled skills for a leading `/query` token, ranked exact > prefix > substring. */
export function slashSkillsFor(text: string, list: readonly SlashSkillItem[]): SlashSkillItem[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  if (!query) return list.slice(0, 12);
  const scored: Array<{ item: SlashSkillItem; rank: number }> = [];
  for (const item of list) {
    const lowerName = item.name.toLowerCase();
    const lowerDesc = item.description.toLowerCase();
    let rank = -1;
    if (lowerName === query) rank = 0;
    else if (lowerName.startsWith(query)) rank = 1;
    else if (lowerName.includes(query)) rank = 2;
    else if (lowerDesc.includes(query)) rank = 3;
    if (rank >= 0) scored.push({ item, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name, undefined, { sensitivity: "base" }));
  return scored.slice(0, 12).map(s => s.item);
}

/** The command a whole message names (`/reload skills`, `/reload-skills`, `/model claude`, `/goal ...`), if offered. */
export function parseSlashCommand(text: string, commands: readonly SlashCommand[]): { command: SlashCommand; arg: string } | null {
  const trimmed = text.trim();
  const match = /^\/([a-z_-]+)(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (!match) return null;
  let id = match[1]!.toLowerCase();
  let rawArg = (match[2] ?? "").trim();
  if (id === "reload-skills") {
    id = "reload";
    rawArg = "skills";
  }
  const command = commands.find(entry => entry.id === id);
  if (!command) return null;
  if (command.local) {
    return { command, arg: rawArg };
  }
  if (/\s/.test(rawArg)) return null;
  const arg = rawArg.toLowerCase();
  if (arg && !command.args.includes(arg)) return null;
  return { command, arg };
}

const STARTED_MESSAGES: Record<string, MessageKey> = {
  compaction_started: "chat.slash.compactStarted",
  init_started: "chat.slash.initStarted",
  reloaded: "chat.slash.reloaded",
};

/** Runs a slash command for a session through the host and returns what to tell the user. */
export async function runSlashCommand(
  sessionId: string,
  command: SlashCommand,
  arg: string,
  workspaceId: string | null,
  device: string,
): Promise<{ ok: boolean; message: string; outcome?: string }> {
  try {
    const result = await executeSessionCommand({
      sessionId,
      id: command.id,
      ...(arg ? { arg } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    }, fleetActive() && device ? { target: device } : undefined);
    const key = STARTED_MESSAGES[result?.outcome ?? ""];
    return { ok: true, message: key ? tr(key) : command.command, outcome: result?.outcome };
  } catch (error) {
    if (isMissingCommand(error, "execute_session_command")) {
      return { ok: false, message: tr("chat.slash.hostUpdateRequired") };
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
