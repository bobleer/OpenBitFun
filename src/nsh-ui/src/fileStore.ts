// File explorer and preview state.
//
// The tree is lazy: the root is read once, and a directory's children are read
// when the user first expands it. Children are cached by directory path and
// dropped after a mutation in that directory, because the host is the only
// authority on what a directory now contains.

import { Clipboard, computed, signal } from "nsh";
import { fleetActive, invokeCommand, listenEvent, windowShellId } from "./bridge";
import { holdGitStatusLive } from "./gitStatusLive";
import { currentDeviceScopeKey, isRemotePeerContext } from "./shared/deviceScope";
import { errorMessageOf } from "./shared/errorUtils";
import { invalidateMarkdownMediaCache } from "./ui/markdownMedia";
import { readFileWithEncoding, type EditorFileByteIdentity, type EditorFileEncoding } from "./editorFileEncoding";
import { tr } from "./i18n";
import { rendererAssets } from "./documentRenderers";
import {
  dirnameOfPath,
  fileUrlToPath,
  isPathAtOrUnder,
  isRemoteWorkspace,
  joinWorkspacePath,
  pathSepFor,
  resolveWorkspaceMarkdownLink,
} from "./shared/workspaceUtils";
import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceDirectory,
  deleteWorkspaceFile,
  getDirectoryChildren,
  getGitDiff,
  getGitStatus,
  pasteWorkspaceFiles,
  readFileContent,
  renameWorkspaceFile,
  sameGitStatus,
  searchWorkspaceFiles,
  type GitStatus,
  type WorkspaceEntry,
} from "./api";
import {
  activeWorkspace,
  activeWorkspaceId,
  activeWorkspaceRoot,
  onWorkspaceChanged,
  reportError,
  runStep,
} from "./state";
import { basename, extensionOf, formatBytes } from "./format";
import type { EditorIndentation } from "./ui/editorIndentation";
import { readFileEditorConfig } from "./ui/editorPreferences";
import type { LatexTabView } from "./latexDocument";
import type { PdfReviewSession } from "./pdfReviewSession";

export type PreviewKind = "markdown" | "code" | "text" | "image" | "video" | "pdf" | "diff" | "binary";

export interface OpenFile {
  path: string;
  name: string;
  kind: PreviewKind;
  language: string;
  content: string;
  byteIdentity?: EditorFileByteIdentity;
  /** A fresh PDF byte snapshot may replace the same path. */
  previewRevision?: number;
  note?: string;
  /** Past `LARGE_FILE_BYTES`: shown without colouring, editable on request. */
  large?: boolean;
}

export interface PendingEdit {
  mode: "file" | "directory" | "rename";
  /** The directory the new entry goes into, or the path being renamed. */
  base: string;
  value: string;
}

/** A search row: a name match, or one content match with its line and preview. */
export interface SearchHit {
  path: string;
  name: string;
  line?: number;
  preview?: string;
  /** The text around the match on its line, when the host reports it (B28). */
  previewBefore?: string;
  previewAfter?: string;
}

export const dirChildren = signal<Record<string, WorkspaceEntry[]>>({});
export const expandedDirs = signal<string[]>([]);
export const selectedPath = signal<string | null>(null);
export const openFile = signal<OpenFile | null>(null);
export const editingContent = signal<string | null>(null);
export const fileSaving = signal(false);
export const pendingEdit = signal<PendingEdit | null>(null);
export const fileNotice = signal<string>("");
export const searchQuery = signal<string>("");
/** `name` matches file names, `content` greps inside files through the same command. */
export const searchMode = signal<"name" | "content">("name");
export const searchResults = signal<SearchHit[]>([]);
export const searchCaseSensitive = signal(false);
export const searchRegex = signal(false);
export const searchWholeWord = signal(false);
/** The host stopped at `SEARCH_MAX_RESULTS`: more matches exist than are listed. */
export const searchTruncated = signal(false);
export const searchRunning = signal(false);
export const SEARCH_MAX_RESULTS = 500;
const SEARCH_DEBOUNCE_MS = 250;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchTicket = 0;

/** Searches as the user types, once typing pauses for 250 ms. */
export function scheduleFileSearch(): void {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void runFileSearch();
  }, SEARCH_DEBOUNCE_MS);
}
/** The repository under the workspace root, or null when there is none. */
export const gitStatus = signal<GitStatus | null>(null);
/** Whether the changed-files list is expanded over the tree. */
export const gitListOpen = signal(false);

/** The open editor tabs, in the order they were opened. */
export const openFilePaths = signal<string[]>([]);

export interface FileEditorOptions {
  language?: string;
  indentation?: EditorIndentation;
  encoding?: EditorFileEncoding;
  latex?: LatexTabView;
  pdfReviews?: Record<string, PdfReviewSession>;
}

const editorOptionsByPath = signal<Record<string, FileEditorOptions>>({});
export const activeFileEditorOptions = computed(() => {
  const path = openFile()?.path;
  return path ? editorOptionsByPath()[path] : undefined;
});

/** These choices belong to the open tab and its controller-side editor. */
export function setActiveFileEditorOptions(patch: Partial<FileEditorOptions>): void {
  const path = openFile()?.path;
  if (!path || !openFilePaths().includes(path)) return;
  editorOptionsByPath.update(current => {
    const next = { ...current, [path]: { ...current[path], ...patch } };
    if (!next[path].language && !next[path].indentation && !next[path].encoding && !next[path].latex && !next[path].pdfReviews) {
      delete next[path];
    }
    return next;
  });
}

const editorConfig = signal<{ device: string; config: ReturnType<typeof readFileEditorConfig> } | null>(null);
let editorConfigRequest = 0;
export const activeFileEditorConfig = computed(() => {
  const policy = editorConfig();
  return policy?.device === currentDeviceScopeKey() ? policy.config : null;
});

export async function refreshFileEditorConfig(): Promise<void> {
  const device = currentDeviceScopeKey();
  const request = ++editorConfigRequest;
  try {
    const editor = await invokeCommand<unknown>("get_config", { path: "editor", skipRetryOnNotFound: true });
    if (request !== editorConfigRequest || device !== currentDeviceScopeKey() || !editor) return;
    editorConfig.set({ device, config: readFileEditorConfig(editor) });
  } catch {
    // An unavailable settings read must not prevent opening or editing a file.
  }
}

/**
 * An unsaved edit of a file that is not the active tab. The active file's draft
 * lives in `editingContent`; switching tabs moves it here and back, so a tab
 * switch, a diff review or a workspace switch never drops typed text.
 */
export interface FileDraft {
  text: string;
  /** The disk text the draft was edited against. */
  base: string;
  byteIdentity?: EditorFileByteIdentity;
  /** The disk identity of `base`, when the host reported one. */
  version: DiskVersion | null;
}

/** Disk identity read through `get_file_metadata` (local and remote alike). */
export interface DiskVersion {
  modified: number;
  size: number;
}

export const drafts = signal<Record<string, FileDraft>>({});
/** Open files whose disk copy changed under an unsaved draft (or went away). */
export const changedOnDisk = signal<Record<string, "modified" | "deleted">>({});
/** The file whose save found a newer copy on disk, waiting for Overwrite or Reload. */
export const saveConflict = signal<string | null>(null);
/** The dirty tab waiting for a Discard / Save confirmation before it closes. */
export const confirmingCloseTab = signal<string | null>(null);
export const confirmingEncodingSave = signal<string | null>(null);

export interface GitDecoration {
  /** The porcelain letter git reports: M, A, D, R, U (untracked) or C (conflict). */
  letter: string;
  /** Where the change sits, so staged and working-tree edits read differently. */
  staged: boolean;
}

/** One entry per changed path, staged or not, the way a file tree decorates it. */
export const gitChanges = computed<Record<string, GitDecoration>>(() => {
  const status = gitStatus();
  const decorations: Record<string, GitDecoration> = {};
  if (!status) return decorations;
  for (const file of status.staged ?? []) {
    decorations[file.path] = { letter: statusLetter(file.status, file.index_status), staged: true };
  }
  for (const file of status.unstaged ?? []) {
    // A path changed in both places keeps its working-tree letter, unstaged.
    decorations[file.path] = { letter: statusLetter(file.status, file.workdir_status), staged: false };
  }
  for (const path of status.untracked ?? []) decorations[path] = { letter: "U", staged: false };
  for (const path of status.conflicts ?? []) decorations[path] = { letter: "C", staged: false };
  return decorations;
});

/** The changed paths, staged first then the working tree, each once. */
export const changedPaths = computed<string[]>(() => Object.keys(gitChanges()).sort());

function statusLetter(status: string | undefined, detail: string | null | undefined): string {
  const raw = (detail || status || "").trim();
  if (!raw) return "M";
  if (raw.includes("?")) return "U";
  if (raw.includes("U") && raw.includes("A")) return "C";
  if (raw.startsWith("R")) return "R";
  const first = raw[0];
  return "MADRUC".includes(first) ? first : "M";
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "heic"]);

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);

/** Above this, a media file is not read into a base64 string for a preview. */
const MEDIA_PREVIEW_LIMIT_BYTES = 32 * 1024 * 1024;

const MEDIA_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
};

const BINARY_EXTENSIONS = new Set([
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "mp3", "wav", "flac", "m4a", "aac", "ogg",
  "woff", "woff2", "ttf", "otf", "wasm", "so", "dylib", "dll", "exe", "bin",
  "class", "jar", "o", "a", "pyc", "lock",
]);

/** Editor language ids for the extensions an editor is expected to colour. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  tex: "latex",
  svg: "xml",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  lua: "lua",
  dart: "dart",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  proto: "protobuf",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

function activeIsRemote(): boolean {
  return isRemoteWorkspace(activeWorkspace());
}

export function pathSep(path: string): string {
  return pathSepFor(path, activeIsRemote());
}

export function dirnameOf(path: string): string {
  return dirnameOfPath(path, activeIsRemote());
}

export function joinPath(parent: string, name: string): string {
  return joinWorkspacePath(parent, name, activeIsRemote());
}

function previewKindOf(path: string): PreviewKind {
  const extension = extensionOf(path);
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (extension === "pdf") return "pdf";
  if (BINARY_EXTENSIONS.has(extension)) return "binary";
  if (LANGUAGE_BY_EXTENSION[extension]) return "code";
  return "text";
}

function mediaMimeOf(path: string): string {
  return MEDIA_MIME[extensionOf(path)] ?? "application/octet-stream";
}

/** The size a directory listing already reported, when it listed this path. */
function knownSizeOf(path: string): number | undefined {
  const parent = parentOf(path);
  const size = (dirChildren()[parent] ?? []).find(entry => entry.path === path)?.size;
  return typeof size === "number" ? size : undefined;
}

function languageOf(path: string): string {
  const name = basename(path).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? "text";
}

function sortEntries(entries: ReadonlyArray<WorkspaceEntry>): WorkspaceEntry[] {
  return [...entries].filter(entry => entry && entry.path).sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return basename(left.path).localeCompare(basename(right.path));
  });
}

function parentOf(path: string): string {
  return dirnameOf(path) || activeWorkspaceRoot();
}

/** The disk identity of `path`, or null when the host cannot say (older peer, deleted file). */
async function readDiskVersion(workspaceId: string, path: string): Promise<DiskVersion | null> {
  try {
    const raw = await invokeCommand<Record<string, unknown> | null>("get_file_metadata", { workspaceId, path });
    const modified = Number(raw?.modified ?? raw?.lastModified ?? Number.NaN);
    if (!Number.isFinite(modified)) return null;
    const size = Number(raw?.size ?? 0);
    return { modified, size: Number.isFinite(size) ? size : 0 };
  } catch {
    return null;
  }
}

/** BOM and newline style never count as an external change (the desktop's rule). */
function normalizeForDiskCompare(text: string): string {
  let value = text;
  if (value.charCodeAt(0) === 0xfeff) value = value.slice(1);
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sameDiskText(left: string, right: string): boolean {
  return normalizeForDiskCompare(left) === normalizeForDiskCompare(right);
}

/** The version recorded for each file's on-screen disk text (active file or a draft's base). */
const diskVersions = new Map<string, DiskVersion | null>();

/** True when the active draft differs from the disk text it was edited against. */
export const hasUnsavedEdit = computed(() => {
  const draft = editingContent();
  const file = openFile();
  return draft !== null && file !== null && draft !== file.content;
});

/** A tab carries unsaved text: the active draft, or a stashed one. */
export function isDirtyPath(path: string): boolean {
  if (Object.values(editorOptionsByPath()[path]?.pdfReviews ?? {}).some(review => review.hasPending())) return true;
  if (openFile()?.path === path) return hasUnsavedEdit();
  return Boolean(drafts()[path]);
}

/** Every path that holds unsaved text right now. */
export const dirtyPaths = computed<string[]>(() => {
  const paths = Object.keys(drafts());
  const active = openFile()?.path;
  if (active && hasUnsavedEdit() && !paths.includes(active)) paths.push(active);
  for (const path of openFilePaths()) {
    if (!paths.includes(path) && isDirtyPath(path)) paths.push(path);
  }
  return paths;
});

function setDraft(path: string, draft: FileDraft | null): void {
  drafts.update(current => {
    if (!draft) {
      if (!(path in current)) return current;
      const { [path]: _dropped, ...rest } = current;
      return rest;
    }
    return { ...current, [path]: draft };
  });
}

function setChangedOnDisk(path: string, state: "modified" | "deleted" | null): void {
  if (state) invalidateMarkdownMediaCache(path);
  changedOnDisk.update(current => {
    if (!state) {
      if (!(path in current)) return current;
      const { [path]: _dropped, ...rest } = current;
      return rest;
    }
    return current[path] === state ? current : { ...current, [path]: state };
  });
}

/** Moves the active file's unsaved text into `drafts` before another view replaces it. */
function stashActiveDraft(): void {
  const file = openFile();
  const draft = editingContent();
  if (!file || draft === null) return;
  if (draft !== file.content) {
    setDraft(file.path, {
      text: draft, base: file.content, byteIdentity: file.byteIdentity, version: diskVersions.get(file.path) ?? null,
    });
  } else {
    setDraft(file.path, null);
  }
  editingContent.set(null);
}

function ensureTab(path: string): void {
  rememberWorkspaceKey();
  if (!openFilePaths().includes(path)) openFilePaths.update(tabs => [...tabs, path]);
}

/** Reads one directory into the cache; a failure stays with that directory. */
export async function loadDirectory(path: string): Promise<void> {
  await loadDirectories([path]);
}

function sameEntries(left: ReadonlyArray<WorkspaceEntry> | undefined, right: ReadonlyArray<WorkspaceEntry>): boolean {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < right.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.path !== b.path || a.name !== b.name || a.isDirectory !== b.isDirectory || a.size !== b.size) return false;
  }
  return true;
}

/**
 * Reads several directories at once and writes the cache once: every write of
 * `dirChildren` rebuilds the whole tree, so a burst of disk changes costs one
 * rebuild, and a directory whose listing did not change costs none. Each
 * failure stays with its directory.
 */
export async function loadDirectories(paths: ReadonlyArray<string>): Promise<void> {
  const workspaceId = activeWorkspaceId();
  if (!workspaceId || paths.length === 0) return;
  const unique = [...new Set(paths)];
  const results = await Promise.all(
    unique.map(async path => {
      try {
        const entries = await getDirectoryChildren(workspaceId, path);
        return { path, entries: sortEntries(Array.isArray(entries) ? entries : []), error: null as unknown };
      } catch (error) {
        return { path, entries: null, error };
      }
    }),
  );
  // The workspace changed while reading: its tree is no longer on screen.
  if (activeWorkspaceId() !== workspaceId) return;
  const current = dirChildren();
  let next: Record<string, WorkspaceEntry[]> | null = null;
  for (const result of results) {
    if (result.entries) {
      if (sameEntries(current[result.path], result.entries)) continue;
      next ??= { ...current };
      next[result.path] = result.entries;
    } else {
      reportError(result.error);
      if (current[result.path] === undefined) {
        next ??= { ...current };
        next[result.path] = [];
      }
    }
  }
  if (next) dirChildren.set(next);
}

/** Loads the root and keeps it expanded, which is what an explorer shows first. */
export async function loadRoot(): Promise<void> {
  const root = activeWorkspaceRoot();
  if (!root) return;
  if (!expandedDirs().includes(root)) expandedDirs.set([root, ...expandedDirs()]);
  await runStep(async () => {
    await loadDirectory(root);
    void loadGitStatus();
  });
}

/**
 * Reads the repository state under the workspace root. A workspace that is not a
 * repository, or a host without git, simply leaves the tree undecorated.
 */
export async function loadGitStatus(options: { quiet?: boolean } = {}): Promise<boolean> {
  const workspaceId = activeWorkspaceId();
  const root = activeWorkspaceRoot();
  if (!workspaceId || !root) {
    gitStatus.set(null);
    return true;
  }
  try {
    const next = await getGitStatus(workspaceId, root);
    if (activeWorkspaceId() !== workspaceId) return true;
    // A poll that finds nothing new leaves the tree's decorations untouched.
    if (!sameGitStatus(next ?? null, gitStatus())) gitStatus.set(next ?? null);
    return true;
  } catch {
    // A quiet poll keeps the last answer: one failed read must not blank the tree.
    if (!options.quiet) gitStatus.set(null);
    return false;
  }
}

/** Opens the file's working-tree diff for review, in place of its text. */
export async function openDiffReview(path: string): Promise<void> {
  const workspaceId = activeWorkspaceId();
  const root = activeWorkspaceRoot();
  if (!workspaceId || !root) return;
  stashActiveDraft();
  openTicket += 1;
  selectedPath.set(path);
  ensureTab(path);
  await runStep(async () => {
    try {
      const patch = await getGitDiff(workspaceId, root, { files: [path] });
      openFile.set({
        path,
        name: basename(path),
        kind: "diff",
        language: languageOf(path),
        content: patch ?? "",
        ...(patch ? {} : { note: "No diff for this file: git reports no change against HEAD." }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      openFile.set({ path, name: basename(path), kind: "binary", language: "", content: "", note: message });
    }
  });
}

export async function setExpanded(path: string, expanded: boolean): Promise<void> {
  const current = expandedDirs();
  if (expanded) {
    if (!current.includes(path)) expandedDirs.set([...current, path]);
    if (!dirChildren()[path]) await loadDirectory(path);
  } else {
    const remote = activeIsRemote();
    expandedDirs.set(current.filter(item => !isPathAtOrUnder(item, path, remote)));
  }
}

let openTicket = 0;

/**
 * The shared viewer is bundled on every surface. Standalone previews can
 * still use the native desktop's built-in PDF viewer.
 */
export function pdfPreviewSupported(): boolean {
  return Boolean(rendererAssets()?.pdfScript) || windowShellId() === "nsh-desktop";
}

/** Above this, text opens without colouring and the editor says why. */
export const LARGE_FILE_BYTES = 1024 * 1024;

async function readEditorText(workspaceId: string, path: string, encoding?: EditorFileEncoding) {
  if (encoding) return readFileWithEncoding(workspaceId, path, encoding);
  return { content: (await readFileContent(workspaceId, path)) ?? "", byteIdentity: undefined };
}

export const canReopenWithEncoding = computed(() => {
  const file = openFile();
  return Boolean(file && file.kind !== "diff" && EDITABLE_VIEW_KINDS.has(previewKindOf(file.path)));
});

let encodingReadTicket = 0;

function encodingErrorMessage(error: unknown): string {
  const message = errorMessageOf(error);
  if (message.includes("FILE_ENCODING_UNSUPPORTED")) return tr("files.encodingUnsupported");
  if (message.includes("FILE_ENCODING_INVALID")) return tr("files.encodingInvalid");
  return message;
}

export async function reopenWithEncoding(encoding: EditorFileEncoding): Promise<boolean> {
  const workspaceId = activeWorkspaceId();
  const file = openFile();
  if (!workspaceId || !file || selectedPath() !== file.path || !canReopenWithEncoding() ||
      hasUnsavedEdit() || fileSaving()) return false;
  const ticket = openTicket;
  const request = ++encodingReadTicket;
  const stillCurrent = () => ticket === openTicket && request === encodingReadTicket && openFile() === file &&
    !hasUnsavedEdit() && !fileSaving();
  try {
    const [snapshot, version] = await Promise.all([
      readFileWithEncoding(workspaceId, file.path, encoding),
      readDiskVersion(workspaceId, file.path),
    ]);
    if (!stillCurrent()) return false;
    const kind = previewKindOf(file.path);
    const large = (version?.size ?? knownSizeOf(file.path) ?? snapshot.content.length) > LARGE_FILE_BYTES;
    const wasEditing = editingContent() !== null;
    openFile.set({ path: file.path, name: file.name, kind, language: languageOf(file.path), ...snapshot, large });
    if (wasEditing || (EDIT_ON_OPEN_KINDS.has(kind) && !large)) editingContent.set(snapshot.content);
    setActiveFileEditorOptions({ encoding });
    setChangedOnDisk(file.path, null);
    diskVersions.set(file.path, version);
    fileNotice.set("");
    return true;
  } catch (error) {
    if (stillCurrent()) fileNotice.set(encodingErrorMessage(error));
    return false;
  }
}

export async function openFileAt(path: string): Promise<void> {
  const workspaceId = activeWorkspaceId();
  if (!workspaceId) return;
  stashActiveDraft();
  const ticket = ++openTicket;
  selectedPath.set(path);
  ensureTab(path);
  const kind = previewKindOf(path);
  const name = basename(path);
  if (kind === "image" || kind === "video") {
    // Media travels as base64 inside the command result, so always enforce the
    // byte limit even when the file was opened outside a cached directory listing.
    let size = knownSizeOf(path);
    if (size === undefined) {
      const meta = await readDiskVersion(workspaceId, path);
      if (ticket !== openTicket) return;
      size = meta?.size;
    }
    if (size !== undefined && size > MEDIA_PREVIEW_LIMIT_BYTES) {
      openFile.set({
        path,
        name,
        kind: "binary",
        language: "",
        content: "",
        note: `${formatBytes(size)} is too large to preview here: open it in an external app.`,
      });
      return;
    }
    // Shown from a data URL: the same command the React surface reads bytes with,
    // so it works for a local and a remote workspace alike.
    await runStep(async () => {
      try {
        const encoded = await readFileContent(workspaceId, path, "base64");
        if (ticket !== openTicket) return;
        openFile.set({
          path,
          name,
          kind,
          language: "",
          content: `data:${mediaMimeOf(path)};base64,${encoded ?? ""}`,
        });
      } catch (error) {
        if (ticket !== openTicket) return;
        const message = errorMessageOf(error);
        openFile.set({ path, name, kind: "binary", language: "", content: "", note: message });
      }
    });
    return;
  }
  if (kind === "pdf") {
    if (!pdfPreviewSupported()) {
      openFile.set({ path, name, kind, language: "", content: "" });
      return;
    }
    let size = knownSizeOf(path);
    if (size === undefined) {
      const meta = await readDiskVersion(workspaceId, path);
      if (ticket !== openTicket) return;
      size = meta?.size;
    }
    if (size !== undefined && size > MEDIA_PREVIEW_LIMIT_BYTES) {
      openFile.set({
        path,
        name,
        kind: "binary",
        language: "",
        content: "",
        note: `${formatBytes(size)} is too large to preview here: open it in an external app.`,
      });
      return;
    }
    // Read through the host as base64, so a remote workspace's PDF shows too.
    await runStep(async () => {
      try {
        const encoded = await readFileContent(workspaceId, path, "base64");
        if (ticket !== openTicket) return;
        openFile.set({ path, name, kind, language: "", content: encoded ?? "", previewRevision: ticket });
      } catch (error) {
        if (ticket !== openTicket) return;
        const message = error instanceof Error ? error.message : String(error);
        openFile.set({ path, name, kind: "binary", language: "", content: "", note: message });
      }
    });
    return;
  }
  if (kind === "binary") {
    openFile.set({
      path,
      name,
      kind,
      language: "",
      content: "",
      note: "Binary file: no preview for this format.",
    });
    return;
  }
  await runStep(async () => {
    const stashed = drafts()[path];
    const encoding = editorOptionsByPath()[path]?.encoding;
    let content: string | null = null;
    let byteIdentity: EditorFileByteIdentity | undefined;
    let readError: unknown = null;
    let version: DiskVersion | null = null;
    try {
      const [snapshot, diskVersion] = await Promise.all([
        readEditorText(workspaceId, path, encoding),
        readDiskVersion(workspaceId, path),
      ]);
      ({ content, byteIdentity } = snapshot);
      version = diskVersion;
    } catch (error) {
      readError = error;
    }
    if (ticket !== openTicket) return;
    const size = version?.size ?? knownSizeOf(path) ?? (content ?? "").length;
    const large = size > LARGE_FILE_BYTES;
    if (stashed) {
      // The draft wins: it is reopened over the disk text it was typed against,
      // and a disk copy that moved on meanwhile is flagged, never merged silently.
      setDraft(path, null);
      openFile.set({ path, name, kind, language: languageOf(path), content: stashed.base, byteIdentity: stashed.byteIdentity, large });
      diskVersions.set(path, stashed.version);
      editingContent.set(stashed.text);
      if (readError) setChangedOnDisk(path, version || errorMessageOf(readError).includes("FILE_ENCODING_") ? "modified" : "deleted");
      else if (content !== null && (!sameDiskText(content, stashed.base) ||
        byteIdentity?.sha256 !== stashed.byteIdentity?.sha256)) setChangedOnDisk(path, "modified");
      return;
    }
    if (readError) {
      const message = encodingErrorMessage(readError);
      openFile.set({ path, name, kind: "binary", language: "", content: "", note: message });
      return;
    }
    diskVersions.set(path, version);
    setChangedOnDisk(path, null);
    openFile.set({ path, name, kind, language: languageOf(path), content: content ?? "", byteIdentity, large });
    // Code, text, and Markdown open straight into an editable draft (clean until modified);
    // oversized files (> LARGE_FILE_BYTES) stay read-only until the user opts in.
    if (EDIT_ON_OPEN_KINDS.has(kind) && !large) editingContent.set(content ?? "");
  });
}

const EDIT_ON_OPEN_KINDS = new Set<PreviewKind>(["code", "text", "markdown"]);

/** Re-reads the active file from disk, dropping its draft (Reload from disk). */
export async function reloadFromDisk(path: string): Promise<void> {
  saveConflict.set(null);
  confirmingEncodingSave.set(null);
  setChangedOnDisk(path, null);
  setDraft(path, null);
  invalidateMarkdownMediaCache();
  if (openFile()?.path === path) editingContent.set(null);
  await openFileAt(path);
}

/** Keeps the draft and adopts the current disk copy as its base, so the next save overwrites it. */
export async function keepDraftOverDisk(path: string): Promise<void> {
  const workspaceId = activeWorkspaceId();
  setChangedOnDisk(path, null);
  if (!workspaceId) return;
  const file = openFile();
  if (file?.path !== path) return;
  const ticket = openTicket;
  try {
    const [snapshot, version] = await Promise.all([
      readEditorText(workspaceId, path, file.byteIdentity?.encoding),
      readDiskVersion(workspaceId, path),
    ]);
    if (openFile() !== file || ticket !== openTicket) return;
    const draft = editingContent();
    openFile.set({ ...file, ...snapshot });
    diskVersions.set(path, version);
    // A draft equal to the old base would read as clean against the new one.
    if (draft === null) editingContent.set(file.content);
  } catch {
    // The file is gone: saving recreates it from the draft.
    if (openFile() === file && ticket === openTicket) diskVersions.set(path, null);
  }
}

/**
 * True when `path` is known to be a directory — either already expanded in
 * `dirChildren()`, equal to the workspace root, or listed with
 * `isDirectory: true` inside its parent directory's cached children. Checking
 * only `dirChildren()[path]` misclassifies unexpanded directories as files.
 */
function isKnownDirectory(path: string | null): boolean {
  if (!path) return false;
  if (path === activeWorkspaceRoot()) return true;
  if (dirChildren()[path] !== undefined) return true;
  const parent = parentOf(path);
  const siblings = dirChildren()[parent];
  if (!Array.isArray(siblings)) return false;
  return siblings.some(entry => entry.path === path && entry.isDirectory === true);
}

export function startCreate(mode: "file" | "directory"): void {
  const target = selectedPath();
  const base =
    target && isKnownDirectory(target)
      ? target
      : target
        ? parentOf(target)
        : activeWorkspaceRoot();
  pendingEdit.set({ mode, base, value: "" });
}

export function startRename(): void {
  const target = selectedPath();
  if (!target) return;
  // The field starts empty and shows the current name as its placeholder, so a
  // typed name replaces it instead of being appended to it.
  pendingEdit.set({ mode: "rename", base: target, value: "" });
}

export function cancelEdit(): void {
  pendingEdit.set(null);
}

export async function commitEdit(value: string): Promise<void> {
  const edit = pendingEdit();
  const workspaceId = activeWorkspaceId();
  if (!edit || !workspaceId) return;
  const name = value.trim();
  if (!name) return;
  pendingEdit.set(null);
  await runStep(async () => {
    if (edit.mode === "rename") {
      const next = joinPath(parentOf(edit.base), name);
      await renameWorkspaceFile(workspaceId, edit.base, next);
      movePathState(edit.base, next);
      await refreshDirectory(parentOf(edit.base));
      void loadGitStatus();
      fileNotice.set(`Renamed to ${name}`);
      return;
    }
    const path = joinPath(edit.base, name);
    if (edit.mode === "file") {
      await createWorkspaceFile(workspaceId, path);
    } else {
      await createWorkspaceDirectory(workspaceId, path);
    }
    await setExpanded(edit.base, true);
    await refreshDirectory(edit.base);
    void loadGitStatus();
    selectedPath.set(path);
    fileNotice.set(`Created ${name}`);
  });
}

/**
 * Copies the files the OS clipboard holds into the workspace. The clipboard owns
 * the file list (`Clipboard.readFiles`), the host does the copying
 * (`paste_files`), and a host that cannot copy — a remote workspace has no copy
 * primitive — says so through the notice instead of failing silently.
 */
export async function pasteFromClipboard(target?: string): Promise<void> {
  const workspaceId = activeWorkspaceId();
  const root = activeWorkspaceRoot();
  if (!workspaceId || !root) return;
  if (isRemotePeerContext() || activeIsRemote()) {
    // Never forward controller-local clipboard filesystem paths to a remote peer
    // or remote SSH/Docker workspace: the remote host would read its own disk.
    fileNotice.set("Pasting local clipboard file paths is unsupported on remote workspaces or remote devices.");
    return;
  }
  const targetDirectory = directoryTargetOf(target ?? selectedPath(), root);
  await runStep(async () => {
    let paths: string[] = [];
    try {
      const urls = await Clipboard.readFiles();
      paths = urls.map(fileUrlToPath).filter(path => Boolean(path));
    } catch (error) {
      fileNotice.set(errorMessageOf(error));
      return;
    }
    if (!paths.length) {
      fileNotice.set("The clipboard holds no files to paste");
      return;
    }
    try {
      const result = await pasteWorkspaceFiles(workspaceId, paths, targetDirectory);
      const copied = result?.successCount ?? 0;
      const failed = result?.failedFiles ?? [];
      await refreshDirectory(targetDirectory);
      void loadGitStatus();
      fileNotice.set(
        failed.length
          ? `Pasted ${copied}, ${failed.length} failed: ${failed[0].path}: ${failed[0].error}`
          : `Pasted ${copied} item${copied === 1 ? "" : "s"}`,
      );
    } catch (error) {
      fileNotice.set(errorMessageOf(error));
    }
  });
}

/** A directory to paste into: the target itself, or the directory it sits in. */
function directoryTargetOf(target: string | null, root: string): string {
  if (!target) return root;
  if (isKnownDirectory(target)) return target;
  return parentOf(target) || root;
}

/** `path` itself or anything below it, on a separator boundary. */
function isAtOrUnder(candidate: string, path: string): boolean {
  return isPathAtOrUnder(candidate, path, activeIsRemote());
}

function rebase(candidate: string, from: string, to: string): string {
  return candidate === from ? to : `${to}${candidate.slice(from.length)}`;
}

/**
 * A rename carries everything keyed by the old path — expanded folders, cached
 * listings, open tabs, drafts and the selection — to the new one, so renaming a
 * folder neither collapses the tree nor strands its open files.
 */
function movePathState(from: string, to: string): void {
  expandedDirs.update(list => list.map(item => (isAtOrUnder(item, from) ? rebase(item, from, to) : item)));
  dirChildren.update(current => {
    const next: Record<string, WorkspaceEntry[]> = {};
    for (const [key, entries] of Object.entries(current)) {
      const moved = isAtOrUnder(key, from) ? rebase(key, from, to) : key;
      next[moved] = isAtOrUnder(key, from)
        ? entries.map(entry => ({ ...entry, path: rebase(entry.path, from, to) }))
        : entries;
    }
    return next;
  });
  openFilePaths.update(tabs => tabs.map(tab => (isAtOrUnder(tab, from) ? rebase(tab, from, to) : tab)));
  editorOptionsByPath.update(current => Object.fromEntries(Object.entries(current).map(([path, options]) =>
    [isAtOrUnder(path, from) ? rebase(path, from, to) : path, options])));
  drafts.update(current => {
    const next: Record<string, FileDraft> = {};
    for (const [key, draft] of Object.entries(current)) next[isAtOrUnder(key, from) ? rebase(key, from, to) : key] = draft;
    return next;
  });
  for (const [key, version] of [...diskVersions.entries()]) {
    if (!isAtOrUnder(key, from)) continue;
    diskVersions.delete(key);
    diskVersions.set(rebase(key, from, to), version);
  }
  const selected = selectedPath();
  if (selected && isAtOrUnder(selected, from)) selectedPath.set(rebase(selected, from, to));
  const file = openFile();
  if (file && isAtOrUnder(file.path, from)) {
    const path = rebase(file.path, from, to);
    openFile.set({ ...file, path, name: basename(path) });
  }
}

/** A delete closes the tabs, drafts and listings under the deleted path. */
function dropPathState(path: string): void {
  expandedDirs.update(list => list.filter(item => !isAtOrUnder(item, path)));
  dirChildren.update(current => {
    const next: Record<string, WorkspaceEntry[]> = {};
    for (const [key, entries] of Object.entries(current)) if (!isAtOrUnder(key, path)) next[key] = entries;
    return next;
  });
  openFilePaths.update(tabs => tabs.filter(tab => !isAtOrUnder(tab, path)));
  editorOptionsByPath.update(current => Object.fromEntries(Object.entries(current).filter(([key]) => !isAtOrUnder(key, path))));
  drafts.update(current => {
    const next: Record<string, FileDraft> = {};
    for (const [key, draft] of Object.entries(current)) if (!isAtOrUnder(key, path)) next[key] = draft;
    return next;
  });
  for (const key of [...diskVersions.keys()]) if (isAtOrUnder(key, path)) diskVersions.delete(key);
  const file = openFile();
  if (file && isAtOrUnder(file.path, path)) {
    editingContent.set(null);
    openFile.set(null);
    const next = openFilePaths()[0];
    if (next) void openFileAt(next);
  }
}

/**
 * A delete waits for an in-scene confirmation rather than a native alert: the
 * dialog has to be answerable from whichever surface is driving the session, and
 * an in-scene bar is reachable by a remote controller too.
 */
export const confirmingDelete = signal<string | null>(null);

export function requestDelete(): void {
  const target = selectedPath();
  if (target) confirmingDelete.set(target);
}

export function cancelDelete(): void {
  confirmingDelete.set(null);
}

export async function removeSelected(explicitTarget?: string): Promise<void> {
  const target = explicitTarget ?? confirmingDelete();
  const workspaceId = activeWorkspaceId();
  if (!target || !workspaceId) return;
  const isDirectory = isKnownDirectory(target);
  confirmingDelete.set(null);
  await runStep(async () => {
    if (isDirectory) {
      await deleteWorkspaceDirectory(workspaceId, target, true);
    } else {
      await deleteWorkspaceFile(workspaceId, target);
    }
    dropPathState(target);
    selectedPath.set(null);
    await refreshDirectory(parentOf(target));
    void loadGitStatus();
    fileNotice.set(`Deleted ${basename(target)}`);
  });
}

export async function refreshDirectory(path: string): Promise<void> {
  const cached = dirChildren()[path];
  if (!cached) return;
  await loadDirectory(path);
}

/** Workspace search: file names, or file contents with the matching line. */
export async function runFileSearch(): Promise<void> {
  const workspaceId = activeWorkspaceId();
  const query = searchQuery().trim();
  const mode = searchMode();
  if (!workspaceId) return;
  const ticket = ++searchTicket;
  if (!query) {
    searchResults.set([]);
    searchTruncated.set(false);
    return;
  }
  searchRunning.set(true);
  await runStep(async () => {
    let rows: unknown[];
    try {
      rows = await searchWorkspaceFiles(workspaceId, query, {
        searchContent: mode === "content",
        caseSensitive: searchCaseSensitive(),
        useRegex: searchRegex(),
        wholeWord: searchWholeWord(),
        maxResults: SEARCH_MAX_RESULTS,
      });
    } finally {
      if (ticket === searchTicket) searchRunning.set(false);
    }
    // A newer query (typing went on) owns the list.
    if (ticket !== searchTicket) return;
    const root = activeWorkspaceRoot();
    const hits: SearchHit[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const record = (row ?? {}) as Record<string, unknown>;
      const raw = record.path ?? record.filePath ?? record.file ?? record.name;
      if (typeof raw !== "string" || !raw) continue;
      const path = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) ? raw : joinPath(root, raw);
      const line = typeof record.line_number === "number" ? record.line_number : undefined;
      const previewSource = record.preview_inside ?? record.matched_content;
      const preview = typeof previewSource === "string" ? previewSource : undefined;
      const before = typeof record.preview_before === "string" ? record.preview_before : undefined;
      const after = typeof record.preview_after === "string" ? record.preview_after : undefined;
      // One row per match: a file can match on several lines.
      const id = line === undefined ? path : `${path}:${line}`;
      if (hits.some(hit => (hit.line === undefined ? hit.path : `${hit.path}:${hit.line}`) === id)) continue;
      hits.push({
        path,
        name: basename(path),
        ...(line === undefined ? {} : { line }),
        ...(preview ? { preview: before === undefined ? preview.trim() : preview } : {}),
        ...(before !== undefined ? { previewBefore: before.trimStart() } : {}),
        ...(after !== undefined ? { previewAfter: after.trimEnd() } : {}),
      });
    }
    searchTruncated.set(Array.isArray(rows) && rows.length >= SEARCH_MAX_RESULTS);
    searchResults.set(hits);
    if (hits.length === 0) {
      fileNotice.set(
        mode === "content" ? `No file contents match “${query}”` : `No file names match “${query}”`,
      );
    }
  });
}

let revealTicket = 0;

/** Expands every ancestor, then returns the path if it is still the current open file. */
export async function revealPath(path: string): Promise<string | undefined> {
  const root = activeWorkspaceRoot();
  if (!root) return;
  const workspace = currentWorkspaceKey();
  const reveal = ++revealTicket;
  const opening = openTicket;
  const isCurrent = (ticket: number) =>
    reveal === revealTicket && ticket === openTicket && workspace === currentWorkspaceKey();
  const remote = activeIsRemote();
  const resolvedLink = resolveWorkspaceMarkdownLink(path, root, remote);
  const target = resolvedLink.kind === "workspace" ? resolvedLink.target : path;
  if (!target) return;
  const expanded = new Set(expandedDirs());
  expanded.add(root);
  let current = target;
  while (current.length > root.length) {
    const parent = dirnameOf(current);
    if (!parent || parent === current) break;
    expanded.add(parent);
    current = parent;
  }
  expandedDirs.set([...expanded]);
  for (const directory of expanded) {
    if (!dirChildren()[directory]) await loadDirectory(directory);
    if (!isCurrent(opening)) return;
  }
  await openFileAt(target);
  if (isCurrent(opening + 1) && selectedPath() === target && openFile()?.path === target) return target;
}

/** Starts live editing for text, code, or markdown files currently open in preview. */
export function beginEditFile(): void {
  const file = openFile();
  if (!file) return;
  if (file.kind !== "code" && file.kind !== "markdown" && file.kind !== "text") return;
  if (editingContent() === null) editingContent.set(file.content);
  fileNotice.set("");
}

/**
 * Discards the unsaved text. Editable files stay open with the disk copy;
 * oversized files return to read-only.
 */
export function cancelEditFile(): void {
  const file = openFile();
  confirmingEncodingSave.set(null);
  if (file && EDIT_ON_OPEN_KINDS.has(file.kind) && !file.large) {
    editingContent.set(file.content);
  } else {
    editingContent.set(null);
  }
  if (file) setChangedOnDisk(file.path, null);
}

/** Updates the live draft content while editing an open file. */
export function setEditingContent(text: string): void {
  editingContent.set(text);
}

/**
 * SHA-256 (lowercase hex) of the UTF-8 text, which for a text file read through
 * `read_file_content` is the hash of its bytes on disk — the identity
 * `write_file_content` checks `expectedHash` against. `null` when this runtime
 * has no digest at all.
 */
export async function contentHash(text: string): Promise<string | null> {
  try {
    if (typeof crypto?.createHash === "function") {
      return crypto.createHash("sha256").update(text).digest("hex");
    }
  } catch {
    // Fall through to the subtle digest.
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** The host's typed refusal of a write whose disk copy moved since it was read. */
function isFileConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("FILE_CONFLICT");
}

let fileSaveRequest = 0;

/**
 * Persists the edited content through `write_file_content` with `expectedHash`,
 * the hash of the disk text the edit was made against. The host compares it with
 * the file under its write lock (local and remote alike) and refuses with
 * `FILE_CONFLICT` when an agent or another editor changed or removed the file
 * meanwhile; that refusal becomes the Overwrite / Reload choice instead of a
 * blind overwrite. Overwrite (`force`) sends no hash.
 */
export async function saveEditedFile(options: { force?: boolean; convertEncoding?: boolean } = {}): Promise<void> {
  const file = openFile();
  const content = editingContent();
  const workspaceId = activeWorkspaceId();
  if (!file || content === null || !workspaceId || fileSaving()) return;
  const encoding = file.byteIdentity?.encoding;
  const needsConversion = encoding && encoding !== "utf8" && encoding !== "utf8-bom";
  if (needsConversion && !options.convertEncoding && !(options.force && saveConflict() === file.path)) {
    confirmingEncodingSave.set(file.path);
    return;
  }
  confirmingEncodingSave.set(null);
  const ticket = openTicket;
  const workspaceKey = currentWorkspaceKey();
  const workspacePath = activeWorkspaceRoot();
  const diskContent = !needsConversion && file.byteIdentity?.hasBom ? `\ufeff${content}` : content;
  const request = ++fileSaveRequest;
  fileSaving.set(true);
  try {
    await runStep(async () => {
      let expectedHash: string | null = null;
      if (!options.force) {
        expectedHash = file.byteIdentity?.sha256 ?? await contentHash(file.content);
        if (ticket !== openTicket || workspaceKey !== currentWorkspaceKey()) return;
        if (expectedHash === null) {
          // Without a digest the host cannot check the disk copy; ask rather than overwrite.
          saveConflict.set(file.path);
          return;
        }
      }
      try {
        await invokeCommand<unknown>("write_file_content", {
          workspaceId,
          workspacePath,
          filePath: file.path,
          content: diskContent,
          ...(expectedHash !== null ? { expectedHash } : {}),
        });
      } catch (error) {
        if (isFileConflict(error)) {
          if (ticket === openTicket && workspaceKey === currentWorkspaceKey()) saveConflict.set(file.path);
          return;
        }
        throw error;
      }
      if (workspaceKey !== currentWorkspaceKey() || request !== fileSaveRequest) return;
      const version = await readDiskVersion(workspaceId, file.path);
      const savedHash = !needsConversion && file.byteIdentity ? await contentHash(diskContent) : null;
      if (workspaceKey !== currentWorkspaceKey() || request !== fileSaveRequest) return;
      const byteIdentity = savedHash && file.byteIdentity ? { ...file.byteIdentity, sha256: savedHash } : undefined;
      saveConflict.set(null);
      setChangedOnDisk(file.path, null);
      diskVersions.set(file.path, version);
      const current = openFile();
      if (current?.path === file.path && current.kind === file.kind) {
        if (needsConversion || (file.byteIdentity && !byteIdentity)) setActiveFileEditorOptions({ encoding: undefined });
        openFile.set({ ...current, content: byteIdentity ? content : diskContent, byteIdentity });
        // Keep edits typed while the checked write was in flight.
        if (editingContent() === content) editingContent.set(byteIdentity ? content : diskContent);
      } else if (openFilePaths().includes(file.path)) {
        if (needsConversion || (file.byteIdentity && !byteIdentity)) {
          editorOptionsByPath.update(current => ({ ...current, [file.path]: { ...current[file.path], encoding: undefined } }));
        }
        const parked = drafts()[file.path];
        if (parked) setDraft(file.path, parked.text === content ? null : {
          ...parked, base: byteIdentity ? content : diskContent, byteIdentity, version,
        });
      }
      fileNotice.set(`Saved ${file.name}`);
      void loadGitStatus();
    });
  } finally {
    if (request === fileSaveRequest) fileSaving.set(false);
  }
}

export function cancelSaveConflict(): void {
  saveConflict.set(null);
}

export function cancelEncodingSave(): void {
  confirmingEncodingSave.set(null);
}

/** Closes a tab, asking first when it holds unsaved text. */
export function requestCloseTab(path: string): void {
  if (isDirtyPath(path)) {
    confirmingCloseTab.set(path);
    return;
  }
  closeTab(path);
}

export function cancelCloseTab(): void {
  confirmingCloseTab.set(null);
}

/** Saves the active dirty tab, then closes it once the save went through. */
export async function saveAndCloseTab(path: string, options?: { convertEncoding?: boolean }): Promise<void> {
  if (openFile()?.path !== path) return;
  const scope = currentWorkspaceKey();
  await saveOpenPdfReviews(path);
  if (currentWorkspaceKey() !== scope || openFile()?.path !== path) return;
  await saveEditedFile(options);
  if (currentWorkspaceKey() === scope && openFile()?.path === path && !isDirtyPath(path) && saveConflict() !== path) closeTab(path);
}

export async function saveOpenPdfReviews(path = openFile()?.path): Promise<void> {
  if (!path) return;
  await Promise.all(Object.values(editorOptionsByPath()[path]?.pdfReviews ?? {}).map(async review => {
    review.commitDraft();
    await review.save();
  }));
}

/** Closes a tab and drops whatever unsaved text it held. */
export function closeTab(path: string): void {
  if (confirmingCloseTab() === path) confirmingCloseTab.set(null);
  const tabs = openFilePaths();
  const index = tabs.indexOf(path);
  const remaining = tabs.filter(item => item !== path);
  openFilePaths.set(remaining);
  editorOptionsByPath.update(current => {
    if (!current[path]) return current;
    const next = { ...current };
    delete next[path];
    return next;
  });
  setDraft(path, null);
  setChangedOnDisk(path, null);
  if (saveConflict() === path) saveConflict.set(null);
  if (confirmingEncodingSave() === path) confirmingEncodingSave.set(null);
  diskVersions.delete(path);
  if (openFile()?.path === path) {
    editingContent.set(null);
    const nextPath = remaining[Math.max(0, index - 1)] ?? remaining[0] ?? null;
    if (nextPath) {
      void openFileAt(nextPath);
    } else {
      openFileTicketBump();
      if (selectedPath() === path) selectedPath.set(null);
      openFile.set(null);
    }
  }
}

/** Closes every other tab, keeping the ones with unsaved text. */
export function closeOtherTabs(path: string): void {
  for (const tab of openFilePaths()) {
    if (tab !== path && !isDirtyPath(tab)) closeTab(tab);
  }
}

function openFileTicketBump(): void {
  openTicket += 1;
}

// ── Per-workspace tabs ──────────────────────────────────────────────────────

interface WorkspaceFilesSnapshot {
  tabs: string[];
  drafts: Record<string, FileDraft>;
  active: string | null;
  versions: Array<[string, DiskVersion | null]>;
  editorOptions: Record<string, FileEditorOptions>;
}

/** Tabs and drafts of the workspaces that are not active, restored on return. */
const workspaceSnapshots = new Map<string, WorkspaceFilesSnapshot>();
let snapshotKey: string | null = null;

function currentWorkspaceKey(): string | null {
  const id = activeWorkspaceId();
  return id ? `${currentDeviceScopeKey()}::${id}` : null;
}

function rememberWorkspaceKey(): void {
  if (snapshotKey === null) snapshotKey = currentWorkspaceKey();
}

// ── Live updates: file watching and status polling ───────────────────────────

export type FileWatchState =
  | { kind: "idle" }
  | { kind: "live" }
  | { kind: "unsupported" }
  | { kind: "failed"; message: string; hint?: string | null };

/** Whether disk changes reach this surface, and why not. */
export const fileWatchState = signal<FileWatchState>({ kind: "idle" });

interface WatchedRoot {
  key: string;
  deviceId: string;
  workspaceId: string;
  root: string;
}

let watchedRoot: WatchedRoot | null = null;
let watchListenersInstalled = false;
const pendingDirectories = new Set<string>();
const pendingFiles = new Map<string, "modify" | "remove">();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const workspaceChangeSubscribers = new Set<() => void>();

/** Hears a coalesced batch of disk changes under the active workspace (Git status, …). */
export function subscribeWorkspaceFileChanges(handler: () => void): () => void {
  workspaceChangeSubscribers.add(handler);
  return () => {
    workspaceChangeSubscribers.delete(handler);
  };
}

interface FsEventRecord {
  path?: unknown;
  kind?: unknown;
  from?: unknown;
}

function isUnderRoot(path: string, root: string): boolean {
  return isPathAtOrUnder(path, root, activeIsRemote());
}

function handleFileSystemEvents(payload: unknown): void {
  const root = activeWorkspaceRoot();
  if (!root) return;
  const events = (Array.isArray(payload) ? payload : [payload]) as FsEventRecord[];
  let relevant = false;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const kind = String(event.kind ?? "");
    const paths = [event.path, kind === "rename" ? event.from : undefined].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    for (const path of paths) {
      if (!isUnderRoot(path, root)) continue;
      relevant = true;
      pendingDirectories.add(parentOf(path));
      if (kind !== "create") {
        pendingFiles.set(path, kind === "remove" || (kind === "rename" && path === event.from) ? "remove" : "modify");
      }
    }
  }
  if (!relevant) return;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushFileSystemChanges();
  }, 150);
}

async function flushFileSystemChanges(): Promise<void> {
  const directories = [...pendingDirectories];
  const files = [...pendingFiles.entries()];
  pendingDirectories.clear();
  pendingFiles.clear();
  // Only directories the tree already shows; all of them in one cache write.
  const loaded = dirChildren();
  void loadDirectories(directories.filter(directory => loaded[directory] !== undefined));
  void loadGitStatus({ quiet: true });
  for (const handler of [...workspaceChangeSubscribers]) {
    try {
      handler();
    } catch (error) {
      console.error("file change subscriber failed", error);
    }
  }
  const workspaceId = activeWorkspaceId();
  if (!workspaceId) return;
  for (const [path, change] of files) {
    if (!openFilePaths().includes(path)) continue;
    await syncOpenFileFromDisk(workspaceId, path, change);
  }
}

/**
 * Brings one open file in line with its disk copy: a clean active file reloads
 * in place, a file with unsaved text is flagged so the user chooses.
 */
async function syncOpenFileFromDisk(workspaceId: string, path: string, change: "modify" | "remove"): Promise<void> {
  const active = openFile()?.path === path ? openFile() : null;
  if (!active) {
    if (drafts()[path]) setChangedOnDisk(path, change === "remove" ? "deleted" : "modified");
    return;
  }
  if (!EDITABLE_VIEW_KINDS.has(active.kind)) return;
  const ticket = openTicket;
  let snapshot: Awaited<ReturnType<typeof readEditorText>> | null = null;
  try {
    snapshot = await readEditorText(workspaceId, path, active.byteIdentity?.encoding);
  } catch {
    // An edited file may no longer decode with the selected encoding.
  }
  const current = openFile();
  if (!current || current !== active || ticket !== openTicket) return;
  if (!snapshot) {
    setChangedOnDisk(path, active.byteIdentity && change === "modify" ? "modified" : "deleted");
    return;
  }
  if (sameDiskText(snapshot.content, current.content) && snapshot.byteIdentity?.sha256 === current.byteIdentity?.sha256) return;
  if (hasUnsavedEdit()) {
    setChangedOnDisk(path, "modified");
    return;
  }
  const version = await readDiskVersion(workspaceId, path);
  if (openFile() !== current || ticket !== openTicket || hasUnsavedEdit()) return;
  diskVersions.set(path, version);
  openFile.set({ ...current, ...snapshot });
  if (editingContent() !== null) editingContent.set(snapshot.content);
}

const EDITABLE_VIEW_KINDS = new Set<PreviewKind>(["code", "markdown", "text"]);

function installWatchListeners(): void {
  if (watchListenersInstalled) return;
  watchListenersInstalled = true;
  listenEvent<unknown>("file-system-changed", (payload, meta) => {
    if (fleetActive() && meta.origin && meta.origin !== currentDeviceScopeKey()) return;
    handleFileSystemEvents(payload);
  });
  listenEvent<unknown>("file-watch-status-changed", (payload, meta) => {
    if (fleetActive() && meta.origin && meta.origin !== currentDeviceScopeKey()) return;
    const status = (payload ?? {}) as { healthy?: unknown; failure?: { detail?: unknown; hint?: unknown } | null };
    if (status.healthy === false) {
      fileWatchState.set({
        kind: "failed",
        message: typeof status.failure?.detail === "string" ? status.failure.detail : "",
        hint: typeof status.failure?.hint === "string" ? status.failure.hint : null,
      });
    } else if (status.healthy === true && watchedRoot && fileWatchState().kind === "failed") {
      fileWatchState.set({ kind: "live" });
    }
  });
}

/**
 * Registers the host watcher on the active workspace root, the way the desktop
 * explorer does. A remote workspace has no watcher on the host, so the state
 * says so (the explorer shows it); the backend keeps its Git status live
 * (`git://status-changed`) with one poll for all clients.
 */
export function ensureWorkspaceWatch(): void {
  installWatchListeners();
  const ws = activeWorkspace();
  if (!ws) return;
  const deviceKey = currentDeviceScopeKey();
  const deviceId = fleetActive() && deviceKey !== "local" ? deviceKey : "";
  const key = `${deviceKey}::${ws.id}::${ws.rootPath}`;
  if (watchedRoot?.key === key) return;
  const previous = watchedRoot;
  watchedRoot = { key, deviceId, workspaceId: ws.id, root: ws.rootPath };
  if (previous) {
    // Route `stop_file_watch` explicitly to the device that owns the previous
    // watched root so switching devices never tears down a watch on the new device.
    const stopTarget = fleetActive() && previous.deviceId ? { target: previous.deviceId } : undefined;
    void invokeCommand<unknown>(
      "stop_file_watch",
      { workspaceId: previous.workspaceId, path: previous.root },
      stopTarget,
    ).catch(() => undefined);
  }
  if (isRemoteWorkspace(ws)) {
    fileWatchState.set({ kind: "unsupported" });
    return;
  }
  fileWatchState.set({ kind: "idle" });
  void invokeCommand<unknown>("start_file_watch", { workspaceId: ws.id, path: ws.rootPath, recursive: true })
    .then(() => {
      if (watchedRoot?.key === key) fileWatchState.set({ kind: "live" });
    })
    .catch(error => {
      if (watchedRoot?.key !== key) return;
      fileWatchState.set({ kind: "failed", message: errorMessageOf(error) });
    });
}

/** Re-registers every watched root after the user fixed what stopped the watcher. */
export async function retryFileWatch(): Promise<void> {
  const key = watchedRoot?.key;
  try {
    await invokeCommand<unknown>("retry_file_watch", {});
    if (key && watchedRoot?.key === key) fileWatchState.set({ kind: "live" });
  } catch (error) {
    if (key && watchedRoot?.key === key) {
      fileWatchState.set({ kind: "failed", message: errorMessageOf(error) });
    }
  }
}

/**
 * The Files scene's lease on live Git decorations. The host publishes every
 * status change (`git://status-changed`), so the tree never polls; a host
 * without it keeps the status read when the workspace opens.
 */
export function holdFilesStatusWatch(): () => void {
  let lastAppliedRevision = -1;
  let lastAppliedScope = "";
  return holdGitStatusLive(change => {
    const scope = currentWorkspaceKey() ?? "";
    if (change.workspaceId !== activeWorkspaceId()) return;
    if (change.deviceId && change.deviceId !== currentDeviceScopeKey()) return;
    if (scope === lastAppliedScope && change.revision <= lastAppliedRevision) return;
    lastAppliedScope = scope;
    lastAppliedRevision = change.revision;
    gitStatus.set(change.status ?? null);
  });
}

onWorkspaceChanged(() => {
  // Park the leaving workspace's tabs and drafts; they come back with it.
  stashActiveDraft();
  if (snapshotKey && (openFilePaths().length > 0 || Object.keys(drafts()).length > 0)) {
    workspaceSnapshots.set(snapshotKey, {
      tabs: openFilePaths(),
      drafts: drafts(),
      active: openFile()?.path ?? null,
      versions: [...diskVersions.entries()],
      editorOptions: editorOptionsByPath(),
    });
  }
  openTicket += 1;
  diskVersions.clear();
  openFilePaths.set([]);
  editorOptionsByPath.set({});
  drafts.set({});
  changedOnDisk.set({});
  saveConflict.set(null);
  confirmingCloseTab.set(null);
  confirmingEncodingSave.set(null);
  dirChildren.set({});
  expandedDirs.set([]);
  selectedPath.set(null);
  openFile.set(null);
  editingContent.set(null);
  fileSaving.set(false);
  pendingEdit.set(null);
  confirmingDelete.set(null);
  gitStatus.set(null);
  gitListOpen.set(false);
  fileNotice.set("");
  searchQuery.set("");
  searchResults.set([]);
  searchMode.set("name");
  snapshotKey = currentWorkspaceKey();
  const restored = snapshotKey ? workspaceSnapshots.get(snapshotKey) : undefined;
  if (snapshotKey && restored) {
    workspaceSnapshots.delete(snapshotKey);
    openFilePaths.set(restored.tabs);
    editorOptionsByPath.set(restored.editorOptions);
    drafts.set(restored.drafts);
    for (const [path, version] of restored.versions) diskVersions.set(path, version);
    if (restored.active) void openFileAt(restored.active);
  }
  if (watchedRoot) ensureWorkspaceWatch();
});
