// MCP servers: what the host reports about each one, and the user-level JSON
// document that configures them. The runtime facts come from `get_mcp_servers`;
// every configuration write goes through `load_mcp_json_config` /
// `save_mcp_json_config` with the fingerprint of the document that was read, so a
// change another surface made in between is refused instead of overwritten.
//
// An entry this form cannot represent faithfully (an argument list that is not
// strings, an environment that is not a string map, a transport alias this surface
// does not draw) is not guessed at: the row points at the JSON editor, which is the
// one place a whole document can be edited without losing fields.

import { Clipboard, computed, lifecycle as appLifecycle, openUrl, Picker, signal } from "nsh";
import { fleetDeviceContext, invokeCommand, invokeRawCommand } from "./bridge";
import { tr, type MessageKey } from "./i18n";
import { mcpConfigSavedWithRuntimeError, readMcpConfig, writeMcpConfig, type McpConfigSnapshot } from "./mcpConfigAccess";
import {
  draftFromEntry, entryFromDraft, isMcpEntry as isEntry, McpFormError, newMcpDraft,
  type McpDraft, type McpEntry,
} from "./mcpServerForm";

/** One server as the host reports it, before its status settles. */
export interface McpServerRow {
  id: string;
  name: string;
  status: string;
  statusMessage?: string;
  serverType?: string;
  transport: string;
  enabled: boolean;
  autoStart: boolean;
  url?: string;
  command?: string;
  commandAvailable?: boolean;
  commandSource?: string;
  commandResolvedPath?: string;
  authConfigured?: boolean;
  authSource?: string;
  oauthEnabled?: boolean;
  xaaEnabled?: boolean;
  importOrigin?: { sourceId?: string };
  startSupported: boolean;
  startDisabledReason?: string;
}

export function isRemoteMcpServer(row: McpServerRow): boolean {
  return Boolean(row.url || row.serverType?.toLowerCase() === "remote");
}

interface McpDocument extends McpConfigSnapshot {
  servers: Record<string, McpEntry>;
}

interface McpDraftSession {
  document: McpDocument;
  initial: McpDraft;
  entryBase?: McpEntry;
  formAvailable: boolean;
  idEdited: boolean;
  editedJson: boolean;
  json?: { text: string; baseline: string };
}

export const mcpAvailable = signal<boolean | null>(null);
export const mcpLoading = signal(false);
export const mcpListError = signal("");
export const mcpDocumentLoaded = signal(false);
export const mcpServerRows = signal<McpServerRow[]>([]);
export const mcpBusy = signal<string | null>(null);
export const mcpNotice = signal("");
export const mcpDocument = signal<McpDocument | null>(null);
const mcpRawDocument = signal<McpConfigSnapshot | null>(null);
const mcpJsonBase = signal<McpConfigSnapshot | null>(null);
export const mcpDraft = signal<McpDraft | null>(null);
const mcpDraftSession = signal<McpDraftSession | null>(null);
const mcpDraftRejected = signal(false);
export const mcpDraftIssue = signal<McpFormError | string | null>(null);
export const mcpDraftJson = computed(() => mcpDraftSession()?.json?.text ?? null);
export const mcpDraftIsLegacySse = computed(() => mcpDraftSession()?.initial.transport === "sse" || mcpDraft()?.transport === "sse");
export const mcpDraftDirty = computed(() => {
  const session = mcpDraftSession();
  return Boolean(session && (session.editedJson || (session.json && session.json.text !== session.json.baseline)
    || JSON.stringify(mcpDraft()) !== JSON.stringify(session.initial)));
});
export const mcpDraftConflict = computed(() => mcpDraftRejected() || fingerprintMoved(mcpDraftSession()?.document));
export const mcpJsonOpen = signal(false);
export const mcpJsonText = signal("");
export const mcpJsonNotice = signal("");
const mcpJsonRejected = signal(false);

export const mcpJsonDirty = computed(() => mcpJsonOpen() && mcpJsonText() !== (mcpJsonBase()?.text ?? ""));
export const mcpJsonWritable = computed(() => Boolean(mcpJsonBase()?.fingerprint));
function fingerprintMoved(base: McpConfigSnapshot | null | undefined): boolean {
  const latest = mcpRawDocument();
  return Boolean(base && latest && base.fingerprint !== latest.fingerprint);
}

export const mcpJsonConflict = computed(() => mcpJsonRejected() || fingerprintMoved(mcpJsonBase()));
export const mcpJsonValidation = computed((): { syntax: string } | { structure: true } | null => {
  let parsed: unknown;
  try { parsed = JSON.parse(mcpJsonText()); }
  catch (error) { return { syntax: error instanceof Error ? error.message : String(error) }; }
  return isEntry(parsed) && isEntry(parsed.mcpServers) ? null : { structure: true };
});

export function canSaveMcpJson(): boolean {
  return mcpJsonDirty() && mcpJsonWritable() && !mcpJsonConflict() && !mcpJsonValidation() && !mcpBusy();
}

let mcpScopeRevision = 0;
let mcpListRequest = 0;
let mcpDocumentRequest = 0;
let mcpAuthPanelRevision = 0;
let loadedMcpDevice: string | null | undefined;

function mcpRequestScope() {
  const target = fleetDeviceContext();
  const revision = mcpScopeRevision;
  return { target, current: () => revision === mcpScopeRevision && target === fleetDeviceContext() };
}

function mcpAuthRequestScope() {
  const scope = mcpRequestScope();
  const revision = mcpAuthPanelRevision;
  return { target: scope.target, current: () => scope.current() && revision === mcpAuthPanelRevision };
}

/**
 * The remote OAuth flow for one server. The browser half and the callback
 * listener live in the host, so this surface starts the flow, opens the address
 * it answers with and reads the session until the host says how it ended.
 */
export interface McpOAuthSession {
  serverId: string;
  status: string;
  authorizationUrl?: string;
  redirectUri?: string;
  message?: string;
}

/** The server whose authorization panel is open, `null` when none is. */
export const mcpOAuthServer = signal<string | null>(null);
export const mcpOAuthSession = signal<McpOAuthSession | null>(null);
export const mcpOAuthNotice = signal("");
/** The authorization value being typed into the panel, before it is saved. */
export const mcpAuthValue = signal("");
export const mcpOAuthBusy = signal(false);
/** Set when this host could not open the address itself. */
export const mcpOAuthUrlUnopened = signal(false);

/** The statuses the host no longer changes once it reports them. */
const OAUTH_FINISHED = ["authorized", "failed", "cancelled"];
export const mcpOAuthPending = computed(() => {
  const session = mcpOAuthSession();
  return Boolean(session && !OAUTH_FINISHED.includes(session.status));
});
export const mcpOAuthBrowserAvailable = computed(() => (
  mcpServerRows().find(row => row.id === mcpOAuthServer())?.oauthEnabled === true
));
/** How often the session is re-read while the flow runs, as the desktop polls. */
const OAUTH_POLL_MS = 1000;

const OAUTH_POLL_DEADLINE_MS = 10 * 60_000;
let oauthTimer: ReturnType<typeof setTimeout> | null = null;
let oauthPollGen = 0;

function stopOAuthPolling(): void {
  oauthPollGen += 1;
  if (oauthTimer === null) return;
  clearTimeout(oauthTimer);
  oauthTimer = null;
}

/** What each status means in words, the way the desktop labels it. */
export function mcpOAuthStatusLabel(session: McpOAuthSession | null): string {
  if (!session) return tr("settings.mcp.oauthNotStarted");
  switch (session.status) {
    case "awaitingBrowser": return tr("settings.mcp.oauthAwaitingBrowser");
    case "awaitingCallback": return tr("settings.mcp.oauthAwaitingCallback");
    case "exchangingToken": return tr("settings.mcp.oauthExchangingToken");
    case "authorized": return tr("settings.mcp.oauthAuthorized");
    case "failed": return tr("settings.mcp.oauthFailed");
    case "cancelled": return tr("settings.mcp.oauthCancelled");
    default: return session.status;
  }
}

function readOAuthSession(raw: unknown): McpOAuthSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const serverId = typeof entry.serverId === "string" ? entry.serverId : "";
  const status = typeof entry.status === "string" ? entry.status : "";
  if (!serverId || !status) return null;
  return {
    serverId,
    status,
    authorizationUrl: typeof entry.authorizationUrl === "string" ? entry.authorizationUrl : undefined,
    redirectUri: typeof entry.redirectUri === "string" ? entry.redirectUri : undefined,
    message: typeof entry.message === "string" ? entry.message : undefined,
  };
}

async function readOAuthOnce(serverId: string, observing: boolean): Promise<void> {
  const scope = mcpAuthRequestScope();
  const generation = oauthPollGen;
  const current = () => scope.current() && generation === oauthPollGen && mcpOAuthServer() === serverId;
  let raw: unknown;
  try {
    raw = await invokeCommand<unknown>("get_mcp_remote_oauth_session", { serverId }, scope);
  } catch (error) {
    if (!current()) return;
    stopOAuthPolling();
    mcpOAuthNotice.set(error instanceof Error ? error.message : String(error));
    return;
  }
  if (!current()) return;
  const session = readOAuthSession(raw);
  mcpOAuthSession.set(session);
  if (mcpOAuthPending()) {
    if (!observing) startOAuthPolling(serverId);
    return;
  }
  stopOAuthPolling();
  if (session?.status === "authorized" && observing) {
    closeMcpAuth();
    mcpNotice.set(session.message || tr("settings.mcp.oauthFinishedFor", { server: serverId }));
    await refreshMcpServers();
  } else if (session?.status === "failed") {
    mcpOAuthNotice.set(session.message ? "" : tr("settings.mcp.oauthFailedFor", { server: serverId }));
  }
}

function startOAuthPolling(serverId: string): void {
  stopOAuthPolling();
  const gen = oauthPollGen;
  const deadline = Date.now() + OAUTH_POLL_DEADLINE_MS;
  const step = async (): Promise<void> => {
    oauthTimer = null;
    if (gen !== oauthPollGen || mcpOAuthServer() !== serverId) return;
    if (Date.now() > deadline) {
      stopOAuthPolling();
      mcpOAuthNotice.set(tr("settings.mcp.oauthTimedOutFor", { server: serverId }));
      return;
    }
    if (appLifecycle() !== "background") {
      await readOAuthOnce(serverId, true);
    }
    if (gen !== oauthPollGen || mcpOAuthServer() !== serverId) return;
    oauthTimer = setTimeout(() => void step(), OAUTH_POLL_MS);
  };
  oauthTimer = setTimeout(() => void step(), OAUTH_POLL_MS);
}

/** Opens the authorization panel for one server and reads any session it already has. */
export function openMcpAuth(id: string, options: { start?: boolean } = {}): void {
  mcpAuthPanelRevision += 1;
  stopOAuthPolling();
  mcpOAuthNotice.set("");
  mcpAuthValue.set("");
  mcpOAuthUrlUnopened.set(false);
  mcpOAuthServer.set(id);
  mcpOAuthSession.set(null);
  if (options.start) void startMcpRemoteOAuth();
  else if (mcpOAuthBrowserAvailable()) {
    const scope = mcpAuthRequestScope();
    mcpOAuthBusy.set(true);
    void readOAuthOnce(id, false).finally(() => {
      if (scope.current()) mcpOAuthBusy.set(false);
    });
  }
}

/** Drops local panel state when the surface or its device scope goes away. */
export function closeMcpAuth(): void {
  mcpAuthPanelRevision += 1;
  mcpOAuthServer.set(null);
  mcpOAuthSession.set(null);
  mcpOAuthNotice.set("");
  mcpAuthValue.set("");
  mcpOAuthUrlUnopened.set(false);
  mcpOAuthBusy.set(false);
  stopOAuthPolling();
}

export function setMcpAuthValue(text: string): void {
  mcpAuthValue.set(text);
  mcpOAuthNotice.set("");
}

/**
 * Starts the flow and opens the address the host answers with. A host that
 * cannot open it is not a failure: the address stays on the panel with its own
 * `Copy` action, because authorizing in a browser by hand still works.
 */
export async function startMcpRemoteOAuth(): Promise<void> {
  const serverId = mcpOAuthServer();
  if (!serverId || mcpOAuthBusy() || mcpOAuthPending() || !mcpOAuthBrowserAvailable()) return;
  stopOAuthPolling();
  const scope = mcpAuthRequestScope();
  const generation = oauthPollGen;
  const current = () => scope.current() && generation === oauthPollGen && mcpOAuthServer() === serverId;
  mcpOAuthBusy.set(true);
  mcpOAuthNotice.set("");
  mcpOAuthUrlUnopened.set(false);
  try {
    const raw = await invokeCommand<unknown>("start_mcp_remote_oauth", { serverId }, scope);
    if (!current()) return;
    const session = readOAuthSession(raw);
    mcpOAuthSession.set(session);
    if (session?.authorizationUrl) {
      try {
        await openUrl(session.authorizationUrl);
      } catch {
        // No browser, no grant for the scheme, or a host that routed it nowhere.
        if (current()) mcpOAuthUrlUnopened.set(true);
      }
    } else {
      mcpOAuthUrlUnopened.set(true);
    }
    if (!current()) return;
    if (!session?.message) mcpOAuthNotice.set(tr("settings.mcp.oauthStartedFor", { server: serverId }));
    startOAuthPolling(serverId);
  } catch (error) {
    if (current()) mcpOAuthNotice.set(error instanceof Error ? error.message : String(error));
  } finally {
    if (scope.current()) mcpOAuthBusy.set(false);
  }
}

/** Stops the flow on the selected host, optionally dismissing the panel. */
export async function cancelMcpRemoteOAuth(options: { close?: boolean } = {}): Promise<void> {
  const serverId = mcpOAuthServer();
  if (!serverId || mcpOAuthBusy() || !mcpOAuthPending()) return;
  const scope = mcpAuthRequestScope();
  stopOAuthPolling();
  mcpOAuthBusy.set(true);
  try {
    await invokeCommand("cancel_mcp_remote_oauth", { serverId }, scope);
    if (!scope.current()) return;
    if (options.close) closeMcpAuth();
    else {
      mcpOAuthSession.set({ serverId, status: "cancelled" });
      mcpOAuthUrlUnopened.set(false);
      mcpOAuthNotice.set(tr("settings.mcp.oauthCancelledFor", { server: serverId }));
    }
  } catch (error) {
    if (!scope.current()) return;
    mcpOAuthNotice.set(error instanceof Error ? error.message : String(error));
    startOAuthPolling(serverId);
  } finally {
    if (scope.current()) mcpOAuthBusy.set(false);
  }
}

export function requestCloseMcpAuth(): void {
  if (mcpOAuthBusy()) return;
  if (mcpOAuthPending()) void cancelMcpRemoteOAuth({ close: true });
  else closeMcpAuth();
}

/** Copies the address the panel could not open, so it can be pasted in a browser. */
export function copyMcpOAuthUrl(): void {
  const url = mcpOAuthSession()?.authorizationUrl;
  if (!url) return;
  const scope = mcpAuthRequestScope();
  void Clipboard.writeText(url).then(
    () => { if (scope.current()) mcpOAuthNotice.set(tr("settings.mcp.oauthAddressCopied")); },
    () => { if (scope.current()) mcpOAuthNotice.set(tr("settings.mcp.oauthAddressCopyFailed")); },
  );
}

/** Writes the authorization value the desktop's dialog also accepts. */
export async function saveMcpRemoteAuth(): Promise<void> {
  const serverId = mcpOAuthServer();
  const value = mcpAuthValue().trim();
  if (!serverId || mcpOAuthBusy()) return;
  if (!value) {
    mcpOAuthNotice.set(tr("settings.mcp.authValueRequired"));
    return;
  }
  const scope = mcpAuthRequestScope();
  stopOAuthPolling();
  mcpOAuthBusy.set(true);
  try {
    await invokeCommand("update_mcp_remote_auth", { serverId, authorizationValue: value }, scope);
    if (!scope.current()) return;
    closeMcpAuth();
    mcpNotice.set(tr("settings.mcp.authValueSavedFor", { server: serverId }));
    await refreshMcpServers();
  } catch (error) {
    if (!scope.current()) return;
    mcpOAuthNotice.set(error instanceof Error ? error.message : String(error));
    if (mcpOAuthPending()) startOAuthPolling(serverId);
  } finally {
    if (scope.current()) mcpOAuthBusy.set(false);
  }
}

/** Forgets this server's stored authorization. */
export async function clearMcpRemoteAuth(): Promise<void> {
  const serverId = mcpOAuthServer();
  if (!serverId || mcpOAuthBusy()) return;
  const scope = mcpAuthRequestScope();
  stopOAuthPolling();
  mcpOAuthBusy.set(true);
  try {
    await invokeCommand("clear_mcp_remote_auth", { serverId }, scope);
    if (!scope.current()) return;
    mcpOAuthSession.set(null);
    mcpOAuthUrlUnopened.set(false);
    mcpOAuthNotice.set(tr("settings.mcp.authClearedFor", { server: serverId }));
    await refreshMcpServers();
  } catch (error) {
    if (!scope.current()) return;
    mcpOAuthNotice.set(error instanceof Error ? error.message : String(error));
    if (mcpOAuthPending()) startOAuthPolling(serverId);
  } finally {
    if (scope.current()) mcpOAuthBusy.set(false);
  }
}

/** The ids an import or another surface may already have created. */
function documentServers(document: McpDocument | null): Record<string, McpEntry> {
  return document?.servers ?? {};
}

export function mcpEntryOf(id: string): McpEntry | undefined {
  const entry = documentServers(mcpDocument())[id];
  return isEntry(entry) ? entry : undefined;
}

export function ensureMcp(): void {
  if (loadedMcpDevice !== fleetDeviceContext()) reloadMcpForDevice();
}

/** Resets MCP state and re-reads servers and config document for the newly selected device scope. */
export function reloadMcpForDevice(): void {
  mcpScopeRevision += 1;
  loadedMcpDevice = fleetDeviceContext();
  mcpAvailable.set(null);
  mcpLoading.set(true);
  mcpListError.set("");
  mcpDocumentLoaded.set(false);
  mcpServerRows.set([]);
  mcpDocument.set(null);
  mcpRawDocument.set(null);
  mcpBusy.set(null);
  mcpNotice.set("");
  closeMcpDraft();
  closeMcpJson();
  closeMcpImport();
  closeMcpAuth();
  void refreshMcpServers();
  void loadMcpDocument();
}

/**
 * Asks the host for its server list. A host that does not answer has no MCP
 * surface at all, and the section stays hidden rather than showing an error.
 */
export async function refreshMcpServers(): Promise<void> {
  const scope = mcpRequestScope();
  const request = ++mcpListRequest;
  const current = () => request === mcpListRequest && scope.current();
  mcpLoading.set(true);
  try {
    const rows = await invokeCommand<McpServerRow[]>("get_mcp_servers", undefined, scope);
    if (!current()) return;
    mcpServerRows.set(Array.isArray(rows) ? rows : []);
    mcpAvailable.set(true);
    mcpListError.set("");
  } catch (error) {
    if (!current()) return;
    const detail = error instanceof Error ? error.message : String(error);
    const unsupported = /unknown command|not registered|not available on this host|not supported on cli peer host|(?:command|method) .*not found/i;
    if (mcpAvailable() !== true && unsupported.test(detail)) {
      mcpAvailable.set(false);
      return;
    }
    mcpAvailable.set(true);
    mcpListError.set(detail);
  } finally {
    if (current()) mcpLoading.set(false);
  }
}

export async function loadMcpDocument(): Promise<void> {
  const scope = mcpRequestScope();
  const request = ++mcpDocumentRequest;
  const current = () => request === mcpDocumentRequest && scope.current();
  try {
    const raw = await readMcpConfig(scope);
    if (!current()) return;
    if (!raw) {
      mcpDocument.set(null);
      mcpRawDocument.set(null);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.text);
    } catch {
      parsed = null;
    }
    const servers = isEntry(parsed) && isEntry((parsed as McpEntry).mcpServers)
      ? ((parsed as McpEntry).mcpServers as Record<string, McpEntry>)
      : null;
    mcpDocument.set(servers ? { ...raw, servers } : null);
    mcpRawDocument.set(raw);
    if (mcpJsonOpen() && !mcpJsonDirty() && mcpBusy() !== "mcp-json") {
      loadMcpJsonSnapshot(raw);
    }
  } catch (error) {
    if (!current()) return;
    mcpDocument.set(null);
    mcpRawDocument.set(null);
    if (mcpAvailable() !== false) {
      mcpNotice.set(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (current()) mcpDocumentLoaded.set(true);
  }
}

/** Keeps an already loaded MCP settings page in sync with a write from External import. */
export function refreshLoadedMcpConfig(): void {
  if (loadedMcpDevice !== fleetDeviceContext()) return;
  void loadMcpDocument();
  void refreshMcpServers();
}

async function saveDocument(document: McpDocument, nextServers: Record<string, McpEntry>): Promise<boolean> {
  const parsed = JSON.parse(document.text) as McpEntry;
  parsed.mcpServers = nextServers;
  return saveMcpText(JSON.stringify(parsed, null, 2), document.fingerprint);
}

/** Writes the document back, refusing a stale fingerprint. Reports where it failed. */
async function saveMcpText(text: string, fingerprint: string): Promise<boolean> {
  const scope = mcpRequestScope();
  if (!fingerprint) {
    mcpNotice.set("The stored configuration is unavailable; reload before saving");
    return false;
  }
  try {
    // Rust `save_mcp_json_config(state, json_config, expected_fingerprint)` takes
    // positional camelCase args, NOT a `{ request }` wrapper.
    await writeMcpConfig({ text, fingerprint }, scope);
  } catch (error) {
    if (!scope.current()) return false;
    const message = error instanceof Error ? error.message : String(error);
    // A refused fingerprint means the file moved under us: re-read, so the next
    // save starts from what is actually stored instead of overwriting it.
    mcpNotice.set(
      message.includes("MCP configuration changed")
        ? "The MCP configuration changed elsewhere; reloaded it"
        : message,
    );
    await loadMcpDocument();
    return false;
  }
  if (!scope.current()) return false;
  await loadMcpDocument();
  if (!scope.current()) return false;
  await refreshMcpServers();
  return scope.current();
}

function serverIdFrom(name: string, taken: readonly string[]): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "mcp-server";
  let id = base;
  for (let suffix = 2; taken.includes(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

export function openMcpDraft(id?: string): void {
  const document = mcpDocument();
  if (!document || !document.fingerprint || mcpBusy() || mcpDraft()) return;
  const entry = id !== undefined && Object.hasOwn(document.servers, id) ? document.servers[id] : undefined;
  if (id !== undefined && !isEntry(entry)) {
    mcpNotice.set("This server has no stored entry; reload the page");
    return;
  }
  let draft = newMcpDraft();
  let json: McpDraftSession["json"];
  if (id !== undefined && entry) {
    try { draft = draftFromEntry(id, entry); }
    catch {
      draft = { ...draft, id, originalId: id };
      const text = JSON.stringify(entry, null, 2);
      json = { text, baseline: text };
    }
  }
  mcpNotice.set("");
  mcpDraftIssue.set(null);
  mcpDraftRejected.set(false);
  mcpDraftSession.set({ document, initial: draft, entryBase: entry, formAvailable: !json, idEdited: false, editedJson: false, json });
  mcpDraft.set(draft);
}

export function closeMcpDraft(): void {
  mcpDraft.set(null);
  mcpDraftSession.set(null);
  mcpDraftIssue.set(null);
  mcpDraftRejected.set(false);
}

export function updateMcpDraft(patch: Partial<McpDraft>): void {
  const draft = mcpDraft();
  const session = mcpDraftSession();
  if (!draft || !session || mcpBusy()) return;
  const next = { ...draft, ...patch };
  if (patch.id !== undefined) mcpDraftSession.set({ ...session, idEdited: true });
  if (!draft.originalId && !session.idEdited && patch.id === undefined && patch.name !== undefined) {
    next.id = patch.name.trim() ? serverIdFrom(patch.name, Object.keys(session.document.servers)) : "";
  }
  mcpDraft.set(next);
  mcpDraftIssue.set(null);
}

export function updateMcpDraftJson(text: string): void {
  const session = mcpDraftSession();
  if (!session?.json || mcpBusy()) return;
  mcpDraftSession.set({ ...session, json: { ...session.json, text } });
  mcpDraftIssue.set(null);
}

function parseMcpDraftEntry(text: string): McpEntry {
  let entry: unknown;
  try { entry = JSON.parse(text); }
  catch { throw new McpFormError("settings.mcp.formInvalidJson"); }
  if (!isEntry(entry)) throw new McpFormError("settings.mcp.formInvalidJson");
  return entry;
}

export function switchMcpDraftEditor(): void {
  const draft = mcpDraft();
  const session = mcpDraftSession();
  if (!draft || !session || mcpBusy()) return;
  mcpDraftIssue.set(null);
  try {
    if (!session.json) {
      const text = JSON.stringify(entryFromDraft(session.entryBase, draft, false), null, 2);
      mcpDraftSession.set({ ...session, json: { text, baseline: text } });
      return;
    }
    const editedJson = session.json.text !== session.json.baseline;
    if (!editedJson && session.formAvailable) {
      mcpDraftSession.set({ ...session, json: undefined });
      return;
    }
    const entry = parseMcpDraftEntry(session.json.text);
    const next = draftFromEntry(draft.id, entry);
    mcpDraft.set({ ...next, originalId: draft.originalId, enabled: draft.originalId === undefined ? false : next.enabled });
    mcpDraftSession.set({ ...session, entryBase: entry, formAvailable: true, editedJson: session.editedJson || editedJson, json: undefined });
  } catch (error) {
    mcpDraftIssue.set(error instanceof McpFormError ? error : new McpFormError("settings.mcp.formNeedsJson"));
  }
}

export function canSaveMcpDraft(): boolean {
  const draft = mcpDraft();
  return Boolean(draft && (draft.originalId === undefined || mcpDraftDirty()) && !mcpDraftConflict() && !mcpBusy());
}

export async function saveMcpDraft(): Promise<boolean> {
  const draft = mcpDraft();
  const session = mcpDraftSession();
  if (!draft || !session || !canSaveMcpDraft()) return false;
  const { document } = session;
  const id = draft.originalId ?? (draft.id.trim() || serverIdFrom(draft.name, Object.keys(document.servers)));
  let entry: McpEntry;
  try {
    if (draft.originalId === undefined && !MCP_ID_PATTERN.test(id)) throw new McpFormError("settings.mcp.formInvalidId", "id");
    if (draft.originalId === undefined && Object.hasOwn(document.servers, id)) throw new McpFormError("settings.mcp.formDuplicateId", "id");
    entry = session.json ? parseMcpDraftEntry(session.json.text) : entryFromDraft(session.entryBase, draft);
  } catch (error) {
    mcpDraftIssue.set(error instanceof McpFormError ? error : new McpFormError("settings.mcp.formNeedsJson"));
    return false;
  }
  const parsed = JSON.parse(document.text) as McpEntry;
  parsed.mcpServers = { ...document.servers, [id]: draft.originalId === undefined ? { ...entry, enabled: false } : entry };
  return savePinnedMcpEditor({ text: JSON.stringify(parsed, null, 2), fingerprint: document.fingerprint, busy: "mcp-save",
    notice: mcpDraftIssue.set, reject: () => mcpDraftRejected.set(true), close: closeMcpDraft });
}

/** Removes a server from the runtime and from the stored configuration. */
export async function deleteMcpServer(id: string): Promise<void> {
  if (mcpBusy()) return;
  const scope = mcpRequestScope();
  mcpBusy.set(id);
  try {
    // `delete_mcp_server` is one of the few MCP commands that takes a request
    // struct; `invokeCommand` already wraps the body in `{ request }`.
    await invokeCommand("delete_mcp_server", { serverId: id }, scope);
    if (!scope.current()) return;
    mcpNotice.set(`Deleted ${id}`);
    await refreshMcpServers();
    if (scope.current()) await loadMcpDocument();
  } catch (error) {
    if (scope.current()) mcpNotice.set(error instanceof Error ? error.message : String(error));
  } finally {
    if (scope.current()) mcpBusy.set(null);
  }
}

async function lifecycle(id: string, action: "start" | "stop" | "restart"): Promise<void> {
  if (mcpBusy()) return;
  const scope = mcpRequestScope();
  const authScope = mcpAuthRequestScope();
  mcpBusy.set(id);
  try {
    // The lifecycle commands take the server id as a positional argument, so
    // they go through the raw path instead of the `request` envelope.
    await invokeRawCommand(`${action}_mcp_server`, { serverId: id }, scope);
    if (!scope.current()) return;
    const verb = action === "start" ? "Started" : action === "stop" ? "Stopped" : "Restarted";
    mcpNotice.set(`${verb} ${id}`);
    await refreshMcpServers();
  } catch (error) {
    if (!scope.current()) return;
    const message = error instanceof Error ? error.message : String(error);
    const row = mcpServerRows().find(server => server.id === id);
    if (action !== "stop" && authScope.current() && row && isRemoteMcpServer(row) && isRemoteAuthError(message)) {
      mcpNotice.set("");
      openMcpAuth(id, { start: row.oauthEnabled === true });
      if (!row.oauthEnabled) mcpOAuthNotice.set(tr("settings.mcp.remoteAuthRequired"));
      await refreshMcpServers();
    } else {
      mcpNotice.set(message);
    }
  } finally {
    if (scope.current()) mcpBusy.set(null);
  }
}

// Lifecycle failures from older and current hosts carry an error string.
function isRemoteAuthError(message: string): boolean {
  return /\b(?:unauthorized|forbidden|(?:auth|authorization|authentication) required|authentication failed|www-authenticate|(?:invalid|expired) token|(?:token|session) expired|token refresh failed)\b/i.test(message)
    || /\b(?:https?(?: status)?|status(?: code)?)[\s:]+(?:401|403)\b/i.test(message);
}

export function startMcpServer(id: string): Promise<void> {
  return lifecycle(id, "start");
}

/**
 * Turns a stored-disabled server on, the way the desktop's `MCPAPI.enableServer`
 * does: re-read the document for a fresh fingerprint, flip that one entry's
 * `enabled`, and write it back. The host refuses to start a disabled server, so
 * "Enable and start" must run this first; `start` then launches it.
 */
export async function enableMcpServer(id: string, options: { start?: boolean } = {}): Promise<boolean> {
  if (mcpBusy()) return false;
  const scope = mcpRequestScope();
  mcpBusy.set(id);
  try {
    await loadMcpDocument();
    if (!scope.current()) return false;
    const document = mcpDocument();
    const entry = document ? document.servers[id] : undefined;
    if (!document || !isEntry(entry)) {
      mcpNotice.set("The stored configuration is unavailable; reload before enabling");
      return false;
    }
    if (entry.enabled === false) {
      const servers = { ...document.servers, [id]: { ...entry, enabled: true } };
      if (!(await saveDocument(document, servers))) return false;
    }
    mcpNotice.set(`Enabled ${id}`);
  } catch (error) {
    if (scope.current()) mcpNotice.set(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    if (scope.current()) mcpBusy.set(null);
  }
  if (options.start && scope.current()) await lifecycle(id, "start");
  return true;
}

export function stopMcpServer(id: string): Promise<void> {
  return lifecycle(id, "stop");
}

export function restartMcpServer(id: string): Promise<void> {
  return lifecycle(id, "restart");
}

/** The whole document as text, for the fields no form draws. */
export function openMcpJson(): void {
  if (mcpJsonOpen()) return;
  loadMcpJsonSnapshot(mcpRawDocument());
  mcpJsonOpen.set(true);
}

export function closeMcpJson(): void {
  mcpJsonOpen.set(false);
  loadMcpJsonSnapshot(null);
}

function loadMcpJsonSnapshot(snapshot: McpConfigSnapshot | null): void {
  mcpJsonBase.set(snapshot);
  mcpJsonText.set(snapshot?.text ?? "");
  mcpJsonNotice.set("");
  mcpJsonRejected.set(false);
}

export function updateMcpJson(text: string): void {
  mcpJsonText.set(text);
  mcpJsonNotice.set("");
}

export async function saveMcpJson(): Promise<boolean> {
  const base = mcpJsonBase();
  if (!base || !canSaveMcpJson()) return false;
  return savePinnedMcpEditor({ text: mcpJsonText(), fingerprint: base.fingerprint, busy: "mcp-json",
    notice: mcpJsonNotice.set, reject: () => mcpJsonRejected.set(true), close: closeMcpJson });
}

/** Configuration editors and import write against the document their draft was reviewed with. */
async function savePinnedMcpEditor(options: {
  text: string; fingerprint: string; busy: "mcp-json" | "mcp-save" | "mcp-import";
  notice: (message: string) => void; reject: () => void; close: () => void;
}): Promise<boolean> {
  if (loadedMcpDevice !== fleetDeviceContext() || mcpBusy()) return false;
  const scope = mcpRequestScope();
  mcpBusy.set(options.busy);
  options.notice("");
  try {
    let savedWarning = "";
    try {
      await writeMcpConfig({ text: options.text, fingerprint: options.fingerprint }, scope);
    } catch (error) {
      if (!scope.current()) return false;
      const message = error instanceof Error ? error.message : String(error);
      if (mcpConfigSavedWithRuntimeError(message)) {
        savedWarning = message;
      } else {
        if (message.includes("MCP configuration changed")) {
          options.reject();
          await loadMcpDocument();
        } else {
          options.notice(message);
        }
        return false;
      }
    }
    if (!scope.current()) return false;
    options.close();
    mcpNotice.set("");
    await loadMcpDocument();
    if (scope.current()) await refreshMcpServers();
    if (scope.current() && savedWarning) mcpNotice.set(savedWarning);
    return scope.current();
  } finally {
    if (scope.current()) mcpBusy.set(null);
  }
}

/**
 * One server read out of a picked or pasted configuration, before it is written.
 * `unsupported` names why this surface's form cannot express the entry; such a
 * row is shown and stays out of the write instead of being silently dropped.
 */
export interface McpImportCandidate {
  sourceId: string;
  targetId: string;
  selected: boolean;
  entry: McpEntry;
  unsupported: MessageKey | null;
}

export const mcpImportOpen = signal(false);
export const mcpImportText = signal("");
export const mcpImportCandidates = signal<McpImportCandidate[] | null>(null);
export const mcpImportNotice = signal("");
export const mcpImportIssue = signal<MessageKey | null>(null);
export const mcpImportFileName = signal("");
export const mcpImportReading = signal(false);
const mcpImportBase = signal<McpDocument | null>(null);
const mcpImportRejected = signal(false);
let mcpImportTicket = 0;

const MCP_ID_PATTERN = /^[a-z0-9_.-]{1,128}$/i;

export const mcpImportDirty = computed(() => mcpImportOpen() && mcpImportText().length > 0);
export const mcpImportConflict = computed(() => mcpImportRejected() || fingerprintMoved(mcpImportBase()));
export const mcpImportTargetIssues = computed(() => {
  const stored = documentServers(mcpImportBase());
  const rows = mcpImportCandidates() ?? [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.selected) continue;
    const id = row.targetId.trim();
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const issues = new Map<string, MessageKey>();
  for (const row of rows) {
    if (row.unsupported) continue;
    const id = row.targetId.trim();
    if (!MCP_ID_PATTERN.test(id)) issues.set(row.sourceId, "settings.mcp.formInvalidId");
    else if (Object.hasOwn(stored, id) || (row.selected && (counts.get(id) ?? 0) > 1)) {
      issues.set(row.sourceId, "settings.mcp.formDuplicateId");
    }
  }
  return issues;
});

export function canImportMcpServers(): boolean {
  const selected = mcpImportCandidates()?.filter(row => row.selected) ?? [];
  return mcpImportOpen() && Boolean(mcpImportBase()?.fingerprint) && !mcpImportConflict() && !mcpImportReading() && !mcpBusy()
    && selected.length > 0 && selected.every(row => !row.unsupported && !mcpImportTargetIssues().has(row.sourceId));
}

export function openMcpImport(): void {
  const document = mcpDocument();
  if (!document?.fingerprint || mcpImportOpen()) return;
  mcpImportBase.set(document);
  mcpImportOpen.set(true);
}

export function closeMcpImport(): void {
  mcpImportTicket += 1;
  mcpImportOpen.set(false);
  mcpImportReading.set(false);
  mcpImportBase.set(null);
  mcpImportRejected.set(false);
  replaceMcpImportText("");
}

/** Editing the text invalidates the parsed list, because it described other text. */
export function setMcpImportText(text: string): void {
  if (!mcpImportReading() && !mcpBusy()) replaceMcpImportText(text);
}

function replaceMcpImportText(text: string, fileName = ""): void {
  mcpImportText.set(text);
  mcpImportFileName.set(fileName);
  mcpImportCandidates.set(null);
  mcpImportNotice.set("");
  mcpImportIssue.set(null);
}

function startMcpImportRead(): (() => boolean) | null {
  if (!mcpImportOpen() || mcpImportReading() || mcpBusy()) return null;
  const scope = mcpRequestScope();
  const ticket = ++mcpImportTicket;
  mcpImportReading.set(true);
  return () => scope.current() && ticket === mcpImportTicket && mcpImportOpen();
}

/** The file belongs to the controller. Only the reviewed document goes to the selected device. */
export async function pickMcpImportFile(): Promise<void> {
  const current = startMcpImportRead();
  if (!current) return;
  try {
    const [picked] = await Picker.pickFiles({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }], maxSize: 8 * 1024 * 1024 });
    if (!current() || !picked) return;
    if (picked.status === "tooLarge") {
      mcpImportIssue.set("settings.mcp.importFileTooLarge");
      return;
    }
    if (!picked.file) throw new Error("MCP import file was not readable");
    const text = await picked.file.text();
    if (current()) replaceMcpImportText(text, picked.name);
  } catch {
    if (current()) mcpImportIssue.set("settings.mcp.importFileFailed");
  } finally {
    if (current()) mcpImportReading.set(false);
  }
}

/** Refreshes the target and rechecks IDs without throwing away the user's selections or renames. */
export async function reloadMcpImportTarget(): Promise<void> {
  const current = startMcpImportRead();
  if (!current) return;
  try {
    await loadMcpDocument();
    if (!current()) return;
    const document = mcpDocument();
    if (!document?.fingerprint) {
      mcpImportIssue.set("settings.mcp.jsonUnavailable");
      return;
    }
    mcpImportBase.set(document);
    mcpImportRejected.set(false);
    mcpImportIssue.set(null);
    mcpImportNotice.set("");
  } finally {
    if (current()) mcpImportReading.set(false);
  }
}

export function updateMcpImportCandidate(
  sourceId: string,
  patch: Partial<Pick<McpImportCandidate, "targetId" | "selected">>,
): void {
  if (mcpImportReading() || mcpBusy()) return;
  mcpImportNotice.set("");
  mcpImportCandidates.update(list =>
    list
      ? list.map(candidate => (candidate.sourceId === sourceId ? { ...candidate, ...patch } : candidate))
      : list,
  );
}

/**
 * Checks the Cursor-format document and the connection fields covered by the server editor.
 */
export function previewMcpImport(): void {
  if (mcpImportReading() || mcpBusy()) return;
  mcpImportNotice.set("");
  mcpImportIssue.set(null);
  mcpImportCandidates.set(null);
  const text = mcpImportText().trim();
  if (!text) {
    mcpImportIssue.set("settings.mcp.importNeedsText");
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    mcpImportIssue.set("settings.mcp.importInvalidJson");
    return;
  }
  const servers =
    isEntry(parsed) && isEntry((parsed as McpEntry).mcpServers)
      ? ((parsed as McpEntry).mcpServers as Record<string, McpEntry>)
      : null;
  if (!servers) {
    mcpImportIssue.set("settings.mcp.jsonMissingServers");
    return;
  }
  const entries = Object.entries(servers);
  if (!entries.length) {
    mcpImportIssue.set("settings.mcp.importEmpty");
    return;
  }
  const taken = documentServers(mcpImportBase());
  const candidates: McpImportCandidate[] = entries.map(([sourceId, entry]) => {
    let unsupported: MessageKey | null = null;
    try {
      entryFromDraft(entry, draftFromEntry(sourceId, entry));
    } catch (error) {
      unsupported = error instanceof McpFormError ? error.label : "settings.mcp.formNeedsJson";
    }
    return {
      sourceId,
      targetId: sourceId,
      // A name already in the document starts unchecked: the id is taken, and an
      // import that renamed it without being asked would be a different server.
      selected: !unsupported && !Object.hasOwn(taken, sourceId),
      entry,
      unsupported,
    };
  });
  mcpImportCandidates.set(candidates);
}

/**
 * Writes the selected entries into the stored document as one save. Every entry
 * lands `enabled: false`: importing a configuration is not permission to launch
 * what it names, and `_openbitfunImport` (the origin marker an external import
 * carries) is not part of a server entry.
 */
export async function importMcpServers(): Promise<boolean> {
  const document = mcpImportBase();
  if (!document || !canImportMcpServers()) return false;
  const selected = (mcpImportCandidates() ?? []).filter(candidate => candidate.selected);
  const entries = selected.map(candidate => {
    const entry: McpEntry = { ...candidate.entry };
    delete entry._openbitfunImport;
    return [candidate.targetId.trim(), { ...entry, enabled: false }] as const;
  });
  const parsed = JSON.parse(document.text) as McpEntry;
  parsed.mcpServers = { ...document.servers, ...Object.fromEntries(entries) };
  return savePinnedMcpEditor({ text: JSON.stringify(parsed, null, 2), fingerprint: document.fingerprint, busy: "mcp-import",
    notice: mcpImportNotice.set, reject: () => mcpImportRejected.set(true), close: closeMcpImport });
}
