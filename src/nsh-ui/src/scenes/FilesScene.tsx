import { ToolPaneHeader } from "../ui/toolPane";
import {
  cleanup,
  Clipboard,
  computed,
  effect,
  keymap,
  openUrl,
  Overlay,
  untracked,
  Scroll,
  signal,
  Text,
  Video,
  View,
  WebView,
  type Point,
  type ViewRef,
} from "nsh";
import {
  DiffView,
  Editor,
  Tree,
  type EditorRef,
  type EditorSearchResult,
  type EditorSelection,
  type TreeEntry,
  type TreeItem,
} from "nsh/base";
import { basename, extensionOf, formatCount, formatPlural } from "../format";
import { localizeHostError, tr } from "../i18n";
import { codeSnippetLabel, codeSnippetPromptToken, createCodeSnippetContext } from "../codeSnippetReference";
import { isDesktopLocalShell, isRemotePeerContext } from "../shared/deviceScope";
import {
  basenameOfPath,
  dirnameOfPath,
  isPathAtOrUnder,
  isRemoteWorkspace as isRemoteWorkspaceRecord,
  joinWorkspacePath,
  resolveWorkspaceMarkdownLink,
} from "../shared/workspaceUtils";
import {
  activeFileEditorOptions,
  activeFileEditorConfig,
  beginEditFile,
  cancelCloseTab,
  cancelDelete,
  cancelEdit,
  cancelEditFile,
  cancelEncodingSave,
  cancelSaveConflict,
  canReopenWithEncoding,
  changedOnDisk,
  changedPaths,
  closeOtherTabs,
  closeTab,
  commitEdit,
  confirmingCloseTab,
  confirmingDelete,
  confirmingEncodingSave,
  dirChildren,
  dirnameOf,
  editingContent,
  expandedDirs,
  fileNotice,
  fileSaving,
  fileWatchState,
  gitChanges,
  gitListOpen,
  gitStatus,
  hasUnsavedEdit,
  holdFilesStatusWatch,
  ensureWorkspaceWatch,
  isDirtyPath,
  joinPath,
  keepDraftOverDisk,
  loadDirectory,
  loadRoot,
  openDiffReview,
  openFile,
  openFileAt,
  openFilePaths,
  type OpenFile,
  pasteFromClipboard,
  pdfPreviewSupported,
  pendingEdit,
  refreshDirectory,
  refreshFileEditorConfig,
  reloadFromDisk,
  reopenWithEncoding,
  removeSelected,
  requestCloseTab,
  requestDelete,
  retryFileWatch,
  revealPath,
  runFileSearch,
  saveAndCloseTab,
  scheduleFileSearch,
  searchCaseSensitive,
  searchRegex,
  searchRunning,
  searchTruncated,
  searchWholeWord,
  type SearchHit,
  saveConflict,
  saveEditedFile,
  saveOpenPdfReviews,
  searchMode,
  searchQuery,
  searchResults,
  selectedPath,
  setActiveFileEditorOptions,
  type FileEditorOptions,
  setEditingContent,
  setExpanded,
  startCreate,
  startRename,
} from "../fileStore";
import { editorFileEncodings, type EditorFileEncoding } from "../editorFileEncoding";
import { fleetDeviceById } from "../fleetStore";
import {
  activeSession,
  activeSessionDevice,
  activeWorkspace,
  activeWorkspaceId,
  activeWorkspaceRoot,
  auxSelectedFilePath,
  composerText,
  deviceContext,
  focusedPane,
  navigateScene,
  secondarySessionDevice,
  secondarySessionId,
  secondaryWorkspaceId,
  splitPaneOpen,
} from "../state";
import { secondaryComposerText } from "../splitSessionStore";
import { settingsValues } from "../settingsStore";
import { entryDeviceId, fleetActive, invokeCommand, windowShellId } from "../bridge";
import { mentionToken } from "../mentionStore";
import { openTerminal } from "../terminalStore";
import type { MarkdownImageWorkspace } from "../ui/markdownDocumentImage";
import {
  compactLayout,
  elevationShadow,
  fontMono,
  layout,
  palette,
  radii,
  space,
  textLineHeight,
  textSize,
  textStyle,
  touchSlop,
} from "../theme";
import { deviceException, stateColor } from "../ui/fleet";
import { Icon, type IconName } from "../ui/icons";
import {
  createDiffViewStyles,
  createEditorStyles,
  inferCodeLanguage,
} from "../ui/markdown";
import {
  askAiInDocument,
  copyDocumentMarkdown,
  documentWebViewsAvailable,
  hasRichPreviewBlocks,
  MarkdownDocumentEditor,
  MarkdownPreview,
  type MarkdownDocumentMode,
  visualEditBlock,
  visualEditBlockMessage,
  VisualEditNotice,
} from "../ui/markdownEditor";
import {
  MOTION_DURATION,
  paintTransition,
  pressTransition,
  rotatingChevronStyle,
  Spinner,
  tactileActiveStyle,
} from "../ui/motion";
import { createImageViewState, ImageViewerSurface } from "../ui/ImageLightbox";
import { PdfReviewWorkspace } from "../ui/PdfReviewWorkspace";
import { LatexDocumentLayout } from "../ui/LatexDocumentLayout";
import { LatexSourceTools } from "../ui/LatexSourceTools";
import { rendererAssets } from "../documentRenderers";
import { defaultEditorIndentation, editorLanguages, resolveEditorLanguage } from "../ui/editorLanguages";
import { guessEditorIndentation } from "../ui/editorIndentation";
import { ContextMenuOverlay, DropdownMenu, menuSurfaceStyle, pushToast, type DropdownMenuItem } from "../ui/overlays";
import { TabGroup } from "../ui/TabGroup";
import { buildOpenPlan, currentPlanBuild, planBuildBlocked } from "../planBuildActions";
import { isPlanDocument, readPlanDocument } from "../planDocument";
import { PlanDocument } from "../ui/PlanDocument";
import {
  Button,
  EmptyStateCard,
  focusRingStyle,
  IconButton,
  InlineBanner,
  InlineConfirmBar,
  InputBox,
  SegmentedTabs,
  SplitHandle,
  splitDragging,
  TooltipBubble,
} from "../ui/primitives";
import { RemoteWorkspaceStatusBanner } from "../ui/SshWorkspaceModals";
import {
  createSceneWidth,
  StackBackButton,
  WORKBENCH_TOUCH_MIN,
} from "../ui/workbenchLayout";

/** A directory that has not been read yet needs one row so that it can expand. */
const PLACEHOLDER_SUFFIX = "/\u0000loading";

const EXPLORER_MIN_WIDTH = 204;
const EXPLORER_MAX_WIDTH = 440;
const MAX_GUIDE_DEPTH = 6;
/** The desktop explorer's indent per level. */
const INDENT_STEP = 16;

const editValue = signal("");
const explorerOpen = signal(true);
const explorerWidth = signal(260);
const fileDiffLayout = signal<"unified" | "split">("unified");

// ── Documents (Markdown editable Preview | Split | Source, HTML & PDF previews) ──

type MarkdownTab = "preview" | "split" | "source";
type MarkdownMode = "visual" | "preview" | "split" | "source";

const MARKDOWN_SPLIT_MIN_WIDTH = 680;

/** Per-file Markdown view tab (`"preview"` by default: directly editable visual preview when supported). */
const markdownTabByPath = signal<Record<string, MarkdownTab>>({});
/** Per-file override to edit visually even when a file contains Mermaid/KaTeX rich blocks. */
const markdownForceVisualPaths = signal<Record<string, true>>({});
/** Bumped when returning to Preview from Source/Split so fidelity & rich-block checks see the latest draft. */
const markdownCheckVersion = signal(0);
/** Split-mode ratio (0.28..0.72) between the left source editor and right live preview. */
const markdownSplitRatio = signal(0.5);
/** Measured width of the preview pane (defaults wide so desktop tests see Split before first layout). */
const previewPaneWidth = signal(900);
/** HTML files showing their rendered preview instead of the source. */
const htmlPreviewPaths = signal<Record<string, true>>({});

const openPlan = computed(() => {
  const file = openFile();
  return file?.kind === "markdown" && !file.large && isPlanDocument(file.path)
    ? readPlanDocument(editingContent() ?? file.content)
    : null;
});

function fileVisualBlock(path: string, text: string) {
  const plan = isPlanDocument(path) ? readPlanDocument(text) : null;
  return plan?.kind === "invalid" ? "fidelity" : visualEditBlock(plan?.body ?? text);
}

function canSplitMarkdown(narrow: boolean): boolean {
  return !narrow && previewPaneWidth() >= MARKDOWN_SPLIT_MIN_WIDTH;
}

/** Why the open Markdown file cannot edit visually (raw HTML, reference links, footnotes, alerts, or no kernel). */
const markdownBlock = computed(() => {
  markdownCheckVersion();
  const file = openFile();
  if (!file || file.kind !== "markdown" || file.large) return null;
  return fileVisualBlock(file.path, untracked(() => editingContent()) ?? file.content);
});

function markdownSourceKey(path: string): string {
  return JSON.stringify([deviceContext(), activeWorkspaceId(), path]);
}
/** Whether the open Markdown file contains Mermaid diagrams or display math (`$$...$$`) islands. */
const markdownRichBlocks = computed(() => {
  markdownCheckVersion();
  const file = openFile();
  if (!file || file.kind !== "markdown" || file.large) return false;
  return hasRichPreviewBlocks(untracked(() => editingContent()) ?? file.content);
});

const markdownTab = computed<MarkdownTab>(() => {
  const file = openFile();
  if (!file || file.kind !== "markdown") return "preview";
  return markdownTabByPath()[markdownSourceKey(file.path)] ?? "preview";
});

/**
 * What the Markdown body shows:
 * - `"visual"`: editable WYSIWYG preview (`MarkdownDocumentEditor`, default for standard & frontmatter docs)
 * - `"preview"`: read-only rich preview (`MarkdownPreview`, for Mermaid/KaTeX, raw HTML, lossy syntax, or large files)
 * - `"split"`: side-by-side live Source editor + rendered `MarkdownPreview`
 * - `"source"`: full-pane syntax-highlighted Markdown `Editor`
 */
const markdownMode = computed<MarkdownMode | null>(() => {
  const file = openFile();
  if (!file || file.kind !== "markdown") return null;
  const tab = markdownTab();
  if (tab === "source") return "source";
  if (tab === "split") return previewPaneWidth() >= MARKDOWN_SPLIT_MIN_WIDTH ? "split" : "source";
  if (file.large || editingContent() === null) return "preview";
  if (markdownBlock() !== null || (openPlan()?.kind === "plan" && !markdownForceVisualPaths()[markdownSourceKey(file.path)])) return "preview";
  if (markdownRichBlocks() && !markdownForceVisualPaths()[markdownSourceKey(file.path)]) return "preview";
  return "visual";
});

function setMarkdownForceVisual(path: string, force: boolean): void {
  const key = markdownSourceKey(path);
  markdownForceVisualPaths.update(current => {
    const next = { ...current };
    if (force) next[key] = true;
    else delete next[key];
    return next;
  });
}

function setMarkdownTab(path: string, tab: MarkdownTab): void {
  const key = markdownSourceKey(path);
  if (tab === "preview") setMarkdownForceVisual(path, false);
  markdownCheckVersion.update(v => v + 1);
  markdownTabByPath.update(current => {
    if (tab === "preview") {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    }
    return { ...current, [key]: tab };
  });
}

function enterMarkdownSource(path: string): void {
  if (editingContent() === null) beginEditFile();
  setMarkdownTab(path, "source");
}

function enterMarkdownSplit(path: string): void {
  if (editingContent() === null) beginEditFile();
  setMarkdownTab(path, "split");
}

function enterMarkdownVisual(path: string): void {
  const file = openFile();
  if (!file || file.path !== path) return;
  const block = fileVisualBlock(path, editingContent() ?? file.content);
  if (block) {
    pushToast(visualEditBlockMessage(block));
    return;
  }
  if (editingContent() === null) beginEditFile();
  const key = markdownSourceKey(path);
  setMarkdownForceVisual(path, true);
  markdownCheckVersion.update(v => v + 1);
  markdownTabByPath.update(current => {
    if (!(key in current)) return current;
    const next = { ...current };
    delete next[key];
    return next;
  });
}
function selectMarkdownMode(mode: MarkdownDocumentMode): void {
  const file = openFile();
  if (file?.kind !== "markdown") return;
  if (mode === "source") enterMarkdownSource(file.path);
  else if (mode === "visual") {
    if (markdownBlock() || file.large) enterMarkdownSource(file.path);
    else enterMarkdownVisual(file.path);
  } else setMarkdownTab(file.path, "preview");
}


function isHtmlFile(path: string): boolean {
  const ext = extensionOf(path);
  return ext === "html" || ext === "htm";
}

const htmlPreviewing = computed(() => {
  const file = openFile();
  return Boolean(file && file.kind === "code" && isHtmlFile(file.path) && htmlPreviewPaths()[file.path]);
});

const hasSourceEditor = computed(() => {
  const file = openFile();
  if (!file) return false;
  if (file.kind === "code") return !htmlPreviewing();
  if (file.kind === "text") return editingContent() !== null;
  if (file.kind === "markdown") {
    const mode = markdownMode();
    return mode === "source" || mode === "split";
  }
  return false;
});

function setHtmlPreview(path: string, preview: boolean): void {
  htmlPreviewPaths.update(current => {
    const next = { ...current };
    if (preview) next[path] = true;
    else delete next[path];
    return next;
  });
}

/**
 * "Open in browser" asks the OS of the device that owns the file: offered only
 * in the desktop app, for a local workspace of this same device.
 */
function canOpenInSystemBrowser(): boolean {
  if (windowShellId() !== "nsh-desktop" || isRemoteWorkspace()) return false;
  return !fleetActive() || !deviceContext() || deviceContext() === entryDeviceId();
}

async function openHtmlInSystemBrowser(path: string): Promise<void> {
  try {
    await invokeCommand<unknown>("open_html_file_in_browser", { path });
  } catch (error) {
    pushToast(localizeHostError(error instanceof Error ? error.message : String(error)), "error");
  }
}

function docMenuItems(narrow: boolean): DropdownMenuItem[] {
  const file = openFile();
  if (!file || file.kind !== "markdown") return [];
  const mode = markdownMode();
  const items: DropdownMenuItem[] = [];
  if (mode === "visual") {
    items.push({
      id: "doc-ask-ai",
      label: tr("doc.askAi"),
      icon: "sparkles",
      accessibilityLabel: "doc-ask-ai",
      onSelect: () => askAiInDocument(editorSelectionKey(file.path)),
    });
    if (canSplitMarkdown(narrow)) {
      items.push({
        id: "doc-split-view",
        label: tr("doc.split"),
        icon: "panel-right",
        accessibilityLabel: "doc-split-view",
        onSelect: () => enterMarkdownSplit(file.path),
      });
    }
    items.push({
      id: "doc-edit-source",
      label: tr("doc.editAsSource"),
      icon: "code",
      accessibilityLabel: "doc-edit-source",
      onSelect: () => enterMarkdownSource(file.path),
    });
  } else if (mode === "preview") {
    if (!file.large && canSplitMarkdown(narrow)) {
      items.push({
        id: "doc-split-view",
        label: tr("doc.splitToEdit"),
        icon: "panel-right",
        accessibilityLabel: "doc-split-view",
        onSelect: () => enterMarkdownSplit(file.path),
      });
    }
    items.push({
      id: "doc-edit-source",
      label: tr("doc.editAsSource"),
      icon: "code",
      accessibilityLabel: "doc-edit-source",
      onSelect: () => enterMarkdownSource(file.path),
    });
    if (!file.large && !markdownBlock() && markdownRichBlocks()) {
      items.push({
        id: "doc-edit-visual",
        label: tr("doc.editVisually"),
        icon: "file-text",
        accessibilityLabel: "doc-edit-visual",
        onSelect: () => enterMarkdownVisual(file.path),
      });
    }
  } else if ((mode === "source" || mode === "split") && !file.large && !markdownBlock()) {
    items.push({
      id: "doc-edit-visual",
      label: tr("doc.editVisually"),
      icon: "file-text",
      accessibilityLabel: "doc-edit-visual",
      onSelect: () => enterMarkdownVisual(file.path),
    });
  }
  return items;
}

/** A PDF in the desktop's web view: its own viewer draws it, from the bytes the host read. */
function pdfDocumentHtml(base64: string, background: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:${background}}` +
    `embed{width:100%;height:100%;border:0}</style></head><body>` +
    `<embed src="data:application/pdf;base64,${base64}" type="application/pdf"></body></html>`
  );
}

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "rs", "py", "pyi",
  "go", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "cxx", "hpp",
  "hh", "cs", "rb", "php", "sh", "bash", "zsh", "fish", "ps1", "sql",
  "json", "jsonc", "jsonl", "toml", "yaml", "yml", "xml", "html", "htm",
  "css", "scss", "sass", "less", "graphql", "gql", "proto", "lua", "zig",
  "dart", "vue", "svelte", "nix", "tf", "hcl", "ex", "exs", "erl", "hs",
  "scala", "groovy", "gradle", "ini", "conf", "cfg", "tex",
]);

const TEXT_EXTENSIONS = new Set(["md", "mdx", "markdown", "txt", "log", "csv", "rst"]);

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "heic",
]);

const CODE_BASENAMES = new Set([
  "dockerfile", "makefile", "gnumakefile", "justfile", "gemfile", "rakefile",
  "podfile", "cmakelists.txt", ".gitignore", ".gitattributes", ".dockerignore",
  ".env", ".zshrc", ".bashrc",
]);

function fileIconForPath(path: string, isDir: boolean, isExpanded: boolean): IconName {
  if (isDir) return isExpanded ? "folder-open" : "folder";
  const base = basename(path).toLowerCase();
  if (CODE_BASENAMES.has(base) || base.startsWith("dockerfile.")) return "file-code";
  const ext = extensionOf(path);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "file-text";
  if (CODE_EXTENSIONS.has(ext)) return "file-code";
  return "file";
}

function fileIconColor(_path: string, isDir: boolean, selected: boolean): string {
  if (selected) return palette().accent;
  return isDir ? palette().textSecondary : palette().textMuted;
}

const changedAncestors = computed(() => {
  const ancestors = new Set<string>();
  for (const path of changedPaths()) {
    let dir = dirnameOf(path);
    while (dir && !ancestors.has(dir)) {
      ancestors.add(dir);
      const parent = dirnameOf(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return ancestors;
});

function hasChangedDescendant(dirPath: string): boolean {
  const normalized = dirPath.replace(/[\\/]+$/, "");
  return changedAncestors().has(dirPath) || changedAncestors().has(normalized);
}

const treeItems = computed<TreeItem[]>(() => {
  const children = dirChildren();
  const build = (directory: string): TreeItem[] =>
    (children[directory] ?? []).map(entry => {
      const item: TreeItem = { id: entry.path, label: basename(entry.path) || entry.path };
      if (entry.isDirectory) {
        const loaded = children[entry.path];
        item.children = loaded
          ? build(entry.path)
          : [{ id: `${entry.path}${PLACEHOLDER_SUFFIX}`, label: tr("common.loading"), disabled: true }];
      }
      return item;
    });
  return build(activeWorkspaceRoot());
});

/** The expanded directories as a set: tree rows ask once each, per render. */
const expandedDirSet = computed(() => new Set(expandedDirs()));

/** Every directory the tree knows about, so selecting one never reads it as a file. */
const knownDirectoryPaths = computed(() => {
  const directories = new Set<string>();
  const visit = (entries: ReadonlyArray<{ path: string; isDirectory: boolean }>) => {
    for (const entry of entries) {
      if (entry.isDirectory) directories.add(entry.path);
    }
  };
  for (const entries of Object.values(dirChildren())) visit(entries);
  return directories;
});

interface BreadcrumbSegment {
  label: string;
  path: string;
  isLast: boolean;
}

function buildBreadcrumbs(filePath: string, rootPath: string): BreadcrumbSegment[] {
  const remote = isRemoteWorkspace();
  const normalizedRoot = remote
    ? rootPath === "/"
      ? "/"
      : rootPath.replace(/\/+$/, "")
    : /^[A-Za-z]:[\\/]+$/.test(rootPath)
      ? rootPath.slice(0, 3)
      : rootPath === "/"
        ? "/"
        : rootPath.replace(/[\\/]+$/, "");
  if (normalizedRoot && isPathAtOrUnder(filePath, normalizedRoot, remote)) {
    const restRaw =
      normalizedRoot === "/" || /^[A-Za-z]:[\\/]$/.test(normalizedRoot)
        ? filePath.slice(normalizedRoot.length)
        : filePath.slice(normalizedRoot.length);
    const rest = remote ? restRaw.replace(/^\/+/, "") : restRaw.replace(/^[\\/]+/, "");
    const parts = rest ? rest.split(remote ? /\/+/ : /[\\/]+/).filter(Boolean) : [];
    const segments: BreadcrumbSegment[] = [
      {
        label: basenameOfPath(normalizedRoot, remote) || normalizedRoot,
        path: normalizedRoot,
        isLast: parts.length === 0,
      },
    ];
    let current = normalizedRoot;
    parts.forEach((part, index) => {
      current = joinWorkspacePath(current, part, remote);
      segments.push({
        label: part,
        path: current,
        isLast: index === parts.length - 1,
      });
    });
    return segments;
  }
  const parts = filePath.split(remote ? /\/+/ : /[\\/]+/).filter(Boolean);
  if (parts.length === 0) return [{ label: filePath, path: filePath, isLast: true }];
  const prefix = filePath.startsWith("/") ? "/" : "";
  let current = "";
  return parts.map((part, index) => {
    current = current ? joinWorkspacePath(current, part, remote) : `${prefix}${part}`;
    return {
      label: part,
      path: current,
      isLast: index === parts.length - 1,
    };
  });
}

async function copyText(text: string): Promise<void> {
  try {
    await Clipboard.writeText(text);
    pushToast(tr("files.copied"), "success");
  } catch (error) {
    pushToast(localizeHostError(error), "error");
  }
}

function isEditableKind(kind: string): boolean {
  return kind === "code" || kind === "markdown" || kind === "text";
}

function isDirectoryPath(path: string): boolean {
  return path === activeWorkspaceRoot() || knownDirectoryPaths().has(path);
}

function isRemoteWorkspace(): boolean {
  return isRemoteWorkspaceRecord(activeWorkspace());
}

function revealInExplorerDisabled(): boolean {
  return isRemoteWorkspace() || isRemotePeerContext() || !isDesktopLocalShell();
}

function revealInExplorerDisabledLabel(): string {
  return isRemoteWorkspace() ? tr("files.revealLocalOnly") : tr("files.revealDesktopOnly");
}

async function revealInSystemExplorer(path: string): Promise<void> {
  if (revealInExplorerDisabled()) {
    pushToast(revealInExplorerDisabledLabel(), "error");
    return;
  }
  const workspaceId = activeWorkspaceId();
  try {
    await invokeCommand<unknown>("reveal_in_explorer", { path, ...(workspaceId ? { workspaceId } : {}) });
  } catch (error) {
    pushToast(localizeHostError(error instanceof Error ? error.message : String(error)), "error");
  }
}

function addPathToChat(path: string, directory: boolean): void {
  const name = basename(path) || path;
  composerText.update(text => `${text}${text && !text.endsWith(" ") ? " " : ""}${mentionToken({ path, name, directory })}`);
  pushToast(tr("files.addedToChat", { name }), "success");
}

function openTerminalAt(path: string): void {
  const directory = isDirectoryPath(path) ? path : dirnameOf(path) || activeWorkspaceRoot();
  void openTerminal(activeWorkspaceId(), directory);
  navigateScene("terminal");
}

/**
 * The explorer's menu, for one path (the row under the cursor) or the root.
 * Items the workspace cannot honour (revealing a remote file in this machine's
 * file manager) stay visible and disabled, with the reason in their label.
 */
function fileMenuItems(target: string | null = selectedPath()): DropdownMenuItem[] {
  const hasSelection = Boolean(target);
  const selected = target ?? "";
  const directory = hasSelection ? isDirectoryPath(selected) : true;
  const createIn = (mode: "file" | "directory") => {
    if (target) selectedPath.set(target);
    else selectedPath.set(null);
    startCreate(mode);
  };
  const items: DropdownMenuItem[] = [];
  if (hasSelection && !directory) {
    items.push({
      id: "open",
      label: tr("files.open"),
      icon: "file-code",
      onSelect: () => void openFileAt(selected),
    });
  }
  items.push(
    {
      id: "new-file",
      label: tr("files.newFile"),
      icon: "plus",
      accessibilityLabel: "New file",
      onSelect: () => createIn("file"),
    },
    {
      id: "new-folder",
      label: tr("files.newFolder"),
      icon: "folder-plus",
      accessibilityLabel: "New folder",
      onSelect: () => createIn("directory"),
    },
    {
      id: "paste",
      label: tr("common.paste"),
      icon: "copy",
      accessibilityLabel: "Paste",
      onSelect: () => void pasteFromClipboard(target ?? undefined),
    },
    { id: "sep-1", label: "", separator: true },
  );
  if (hasSelection) {
    items.push(
      {
        id: "add-to-chat",
        label: tr("files.addToChat"),
        icon: "at",
        onSelect: () => addPathToChat(selected, directory),
      },
      {
        id: "copy-path",
        label: tr("files.copyPath"),
        icon: "copy",
        onSelect: () => void copyText(selected),
      },
      {
        id: "copy-relative-path",
        label: tr("files.copyRelativePath"),
        icon: "copy",
        onSelect: () => void copyText(relativeDisplayPath(selected, activeWorkspaceRoot())),
      },
      {
        id: "reveal",
        label: revealInExplorerDisabled() ? revealInExplorerDisabledLabel() : tr("files.revealInFinder"),
        icon: "external-link",
        disabled: revealInExplorerDisabled(),
        onSelect: () => void revealInSystemExplorer(selected),
      },
      {
        id: "terminal-here",
        label: tr("files.openTerminalHere"),
        icon: "terminal",
        onSelect: () => openTerminalAt(selected),
      },
      { id: "sep-2", label: "", separator: true },
    );
  }
  items.push(
    {
      id: "rename",
      label: tr("common.rename"),
      icon: "edit",
      disabled: !hasSelection,
      accessibilityLabel: "Rename",
      onSelect: () => {
        if (target) selectedPath.set(target);
        startRename();
      },
    },
    {
      id: "review-diff",
      label: tr("files.reviewDiff"),
      icon: "git-branch",
      disabled: !hasSelection || !gitChanges()[selected],
      accessibilityLabel: "Review diff",
      onSelect: () => {
        if (selected) void openDiffReview(selected);
      },
    },
    {
      id: "delete",
      label: tr("common.delete"),
      icon: "trash",
      danger: true,
      confirmDelete: true,
      confirmAccessibilityLabel: "file-delete-confirm",
      disabled: !hasSelection,
      accessibilityLabel: "Delete",
      onSelect: () => {
        if (target) selectedPath.set(target);
        void removeSelected(target ?? selectedPath() ?? undefined);
      },
    },
  );
  return items;
}

function diffPatchStats(patch: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  if (!patch) return { added, deleted };
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deleted += 1;
  }
  return { added, deleted };
}

const openFileDiffStats = computed(() => {
  const file = openFile();
  return file?.kind === "diff" ? diffPatchStats(file.content) : { added: 0, deleted: 0 };
});

function relativeDisplayPath(filePath: string, rootPath: string): string {
  const cleanRoot = rootPath.replace(/[\\/]+$/, "");
  if (cleanRoot) {
    if (filePath === cleanRoot) return basename(cleanRoot) || cleanRoot;
    if (filePath.startsWith(`${cleanRoot}/`) || filePath.startsWith(`${cleanRoot}\\`)) {
      return filePath.slice(cleanRoot.length + 1);
    }
  }
  return filePath;
}

function parentHintOf(filePath: string, rootPath: string): string {
  const rel = relativeDisplayPath(filePath, rootPath);
  const dir = dirnameOf(rel);
  return dir && dir !== "." ? dir : "";
}

/** Progressively clamps deep folder indentation so filenames stay readable at depth 10+. */
function explorerIndentLeft(depth: number): number {
  const safe = Math.max(0, depth);
  if (safe <= MAX_GUIDE_DEPTH) return 6 + safe * INDENT_STEP;
  return Math.min(160, 6 + MAX_GUIDE_DEPTH * INDENT_STEP + (safe - MAX_GUIDE_DEPTH) * 8);
}

function guideLevelsFor(depth: number): number[] {
  const count = Math.min(Math.max(0, depth), MAX_GUIDE_DEPTH);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(i);
  return out;
}

function decorationColor(letter: string | undefined): string {
  if (letter === "C") return stateColor("failed");
  if (letter === "U") return palette().textMuted;
  return palette().textSecondary;
}

/** Calm centered borderless empty prompt (never a lonely boxed wireframe card). */
function QuietEmptyPrompt(props: { icon: IconName; title: string; subtitle?: string }) {
  return (
    <View
      style={{
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        maxWidth: 340,
      }}
    >
      <View style={{ marginBottom: space.xs }}>
        <Icon name={props.icon} size={28} color={palette().textMuted} />
      </View>
      <Text
        style={{
          ...textStyle("sectionTitle", { color: palette().text }),
          textAlign: "center",
        }}
      >
        {props.title}
      </Text>
      <If when={props.subtitle ?? ""}>
        {sub => (
          <Text
            style={{
              ...textStyle("caption", { color: palette().textSecondary }),
              textAlign: "center",
            }}
          >
            {sub()}
          </Text>
        )}
      </If>
    </View>
  );
}

function PendingEditBar() {
  return (
    <If when={pendingEdit()}>
      {edit => (
        <View
          style={{
            flexDirection: "column",
            gap: space.sm,
            paddingHorizontal: space.md,
            paddingVertical: space.md,
            borderBottomWidth: 1,
            borderColor: palette().borderSubtle,
            backgroundColor: palette().panelRaised,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minWidth: 0 }}>
            <Icon
              name={
                edit().mode === "directory"
                  ? "folder-plus"
                  : edit().mode === "rename"
                    ? "edit"
                    : "file-code"
              }
              size={12}
              color={palette().textSecondary}
            />
            <Text
              style={{
                ...textStyle("caption", { color: palette().text }),
                fontWeight: "600",
                flexShrink: 0,
              }}
            >
              {edit().mode === "rename"
                ? tr("files.renameTo")
                : edit().mode === "file"
                  ? tr("files.newFile")
                  : tr("files.newFolder")}
            </Text>
            <Text
              style={{
                flex: 1,
                minWidth: 0,
                ...textStyle("mono", { color: palette().textMuted }),
                numberOfLines: 1,
                textOverflow: "ellipsis-middle",
              }}
            >
              {tr("files.inDirectory", {
                path:
                  relativeDisplayPath(
                    edit().mode === "rename"
                      ? dirnameOf(edit().base) || activeWorkspaceRoot()
                      : edit().base,
                    activeWorkspaceRoot(),
                  ) || tr("files.rootDir"),
              })}
            </Text>
          </View>
          <InputBox
            size="sm"
            value={editValue()}
            placeholder={edit().mode === "rename" ? basename(edit().base) : tr("common.name")}
            accessibilityLabel="entry-name"
            autoFocus={true}
            onChange={value => editValue.set(value)}
            onSubmit={() => {
              if (editValue().trim()) void commitEdit(editValue());
            }}
            onKeyPress={event => {
              if (event.key === "Escape") cancelEdit();
            }}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            <Button
              label={tr("common.save")}
              variant="primary"
              size="xs"
              disabled={!editValue().trim()}
              onPress={() => void commitEdit(editValue())}
            />
            <Button
              label={tr("common.cancel")}
              variant="ghost"
              size="xs"
              onPress={cancelEdit}
            />
          </View>
        </View>
      )}
    </If>
  );
}

function InlineSearchModeToggle() {
  return <TabGroup size="sm" value={searchMode()}
    items={[
      { value: "name", label: tr("files.searchNames"), testID: "search-mode-name" },
      { value: "content", label: tr("files.searchContents"), testID: "search-mode-content" },
    ]} onChange={mode => { searchMode.set(mode); void runFileSearch(); }} />;
}

/**
 * Calm collapsible changed-files banner above the tree: subtle branch label,
 * tabular count, and expandable diff-review list.
 */
function ChangedFiles(props: { compact?: boolean }) {
  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderColor: palette().borderSubtle,
        backgroundColor: palette().canvasSubtle,
      }}
    >
      <View
        role="button"
        accessibilityState={{ expanded: gitListOpen() }}
        onPress={() => gitListOpen.set(!gitListOpen())}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          minHeight: compactLayout() ? WORKBENCH_TOUCH_MIN : 28,
          paddingHorizontal: props.compact ? space.sm : space.md,
          paddingVertical: space.xs,
          minWidth: 0,
          cursor: "pointer",
          userSelect: "none",
          ...paintTransition(MOTION_DURATION.fast),
        }}
        hoverStyle={{ backgroundColor: palette().panelHover }}
        activeStyle={{ opacity: 0.88 }}
        focusVisibleStyle={focusRingStyle()}
      >
        <View style={rotatingChevronStyle(gitListOpen())}>
          <Icon name="chevron-right" size={12} color={palette().textMuted} />
        </View>
        <Text
          style={{
            ...textStyle("caption", { color: palette().textSecondary, tabular: true }),
            fontWeight: "600",
            flexShrink: 0,
          }}
        >
          {`${tr("git.tabChanges")} ${formatCount(changedPaths().length)}`}
        </Text>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" }}>
          <If when={gitStatus()?.current_branch ?? ""}>
            {branch => (
              <View
                tooltip={<TooltipBubble text={branch()} />}
                style={{
                  flexShrink: 1,
                  minWidth: 0,
                  maxWidth: "100%",
                  paddingHorizontal: space.xs,
                  overflow: "hidden",
                }}
              >
                <Text
                  style={{
                    minWidth: 0,
                    flexShrink: 1,
                    ...textStyle("mono", { color: palette().textMuted }),
                    numberOfLines: 1,
                    textOverflow: "ellipsis-middle",
                  }}
                >
                  {branch()}
                </Text>
              </View>
            )}
          </If>
        </View>
        <Text
          style={{
            ...textStyle("caption", { color: palette().textMuted }),
            fontWeight: "500",
            flexShrink: 0,
          }}
        >
          {gitListOpen() ? tr("common.hide") : tr("common.show")}
        </Text>
      </View>
      <If when={gitListOpen()}>
        <Scroll smoothWheel style={{ maxHeight: props.compact ? 120 : 176, minHeight: 0 }}>
          <View style={{ paddingHorizontal: space.xs, paddingBottom: space.xs, gap: 2 }}>
            <Each of={changedPaths()} key={path => path}>
              {path => <ChangedFileRow path={path()} />}
            </Each>
          </View>
        </Scroll>
      </If>
    </View>
  );
}

function ChangedFileRow(props: { path: string }) {
  const decoration = computed(() => gitChanges()[props.path]);
  const relPath = computed(() => relativeDisplayPath(props.path, activeWorkspaceRoot()));
  const parentHint = computed(() => parentHintOf(props.path, activeWorkspaceRoot()));
  return (
    <View
      role="button"
      tooltip={<TooltipBubble text={relPath()} />}
      accessibilityLabel={`changed-${basename(props.path)}`}
      accessibilityState={{ selected: openFile()?.path === props.path }}
      onPress={() => void openDiffReview(props.path)}
      style={{
        minHeight: compactLayout() ? WORKBENCH_TOUCH_MIN : 28,
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
        borderRadius: radii.xs,
        borderCurve: "continuous",
        backgroundColor: openFile()?.path === props.path ? palette().accentSoft : "transparent",
        cursor: "pointer",
        userSelect: "none",
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{
        backgroundColor:
          openFile()?.path === props.path ? palette().accentSoft : palette().panelHover,
      }}
      activeStyle={{ opacity: 0.88 }}
      focusVisibleStyle={focusRingStyle()}
    >
      <Icon
        name={fileIconForPath(props.path, false, false)}
        size={14}
        color={fileIconColor(props.path, false, openFile()?.path === props.path)}
      />
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <Text
          style={{
            ...textStyle("caption", { color: palette().text }),
            fontWeight: openFile()?.path === props.path ? "600" : "500",
            flexShrink: 1,
            minWidth: 0,
            numberOfLines: 1,
            textOverflow: "ellipsis-middle",
          }}
        >
          {basename(props.path)}
        </Text>
        <If when={parentHint()}>
          {dir => (
            <Text
              style={{
                flex: 1,
                minWidth: 0,
                ...textStyle("caption", { color: palette().textMuted }),
                numberOfLines: 1,
                textOverflow: "ellipsis-start",
              }}
            >
              {dir()}
            </Text>
          )}
        </If>
      </View>
      <View
        style={{
          minWidth: space.lg,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Text
          style={{
            ...textStyle("mono", { color: decorationColor(decoration()?.letter) }),
            fontWeight: "600",
          }}
        >
          {decoration()?.letter ?? "M"}
        </Text>
      </View>
    </View>
  );
}

interface SearchGroup {
  path: string;
  hits: SearchHit[];
}

/** Hits grouped by file, in the order the host ranked their first match. */
const searchGroups = computed<SearchGroup[]>(() => {
  const groups = new Map<string, SearchHit[]>();
  for (const hit of searchResults()) {
    const list = groups.get(hit.path);
    if (list) list.push(hit);
    else groups.set(hit.path, [hit]);
  }
  return [...groups.entries()].map(([path, hits]) => ({ path, hits }));
});

/** One match line: the text before it, the match highlighted, the text after it. */
function SearchMatchRow(props: { hit: SearchHit; onOpen: () => void }) {
  const style = () => ({
    ...textStyle("mono"),
  });
  return (
    <View
      role="button"
      accessibilityLabel={`search-hit-${props.hit.name}:${props.hit.line ?? 0}`}
      onPress={props.onOpen}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: compactLayout() ? WORKBENCH_TOUCH_MIN : 24,
        paddingLeft: space.xxl,
        paddingRight: space.sm,
        borderRadius: radii.xs,
        cursor: "pointer",
        userSelect: "none",
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{ backgroundColor: palette().panelHover }}
      focusVisibleStyle={focusRingStyle()}
    >
      <Text
        style={{
          minWidth: 28,
          ...textStyle("mono", { color: palette().textMuted, tabular: true }),
          textAlign: "right",
          flexShrink: 0,
        }}
      >
        {String(props.hit.line ?? "")}
      </Text>
      <Text style={{ flex: 1, minWidth: 0, numberOfLines: 1, textOverflow: "ellipsis", ...style(), color: palette().textSecondary }}>
        {props.hit.previewBefore ?? ""}
        <Text
          style={{
            ...style(),
            color: palette().text,
            fontWeight: "600",
            backgroundColor: palette().accentSoft,
          }}
        >
          {props.hit.preview ?? ""}
        </Text>
        {props.hit.previewAfter ?? ""}
      </Text>
    </View>
  );
}

function SearchResults(props: { compact?: boolean; onOpenDetail: () => void }) {
  async function openHit(hit: SearchHit): Promise<void> {
    pendingRevealLine.set(null);
    const scope = editorSelectionKey("");
    const path = await revealPath(hit.path);
    if (!path || scope !== editorSelectionKey("")) return;
    props.onOpenDetail();
    if (hit.line !== undefined) pendingRevealLine.set({ key: editorSelectionKey(path), line: hit.line });
  }

  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderColor: palette().borderSubtle,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.xs,
          paddingHorizontal: space.md,
          paddingTop: space.xs,
          paddingBottom: space.xs,
        }}
      >
        <Text
          style={{
            flex: 1,
            minWidth: 0,
            ...textStyle("caption", { color: palette().textMuted, tabular: true }),
            fontWeight: "600",
            numberOfLines: 1,
          }}
        >
          {searchTruncated()
            ? tr("files.searchTruncated", { count: formatCount(searchResults().length) })
            : searchMode() === "content"
              ? tr("files.searchSummary", {
                  matches: formatPlural(searchResults().length, "format.matchOne", "format.matchOther"),
                  files: formatCount(searchGroups().length),
                })
              : formatPlural(searchResults().length, "format.matchOne", "format.matchOther")}
        </Text>
        <If when={searchRunning()}>
          <Spinner size={12} />
        </If>
        <IconButton
          icon="close"
          size="xs"
          iconSize={12}
          tooltip={tr("files.clearResults")}
          accessibilityLabel="clear-file-search-results"
          onPress={() => {
            searchResults.set([]);
            fileNotice.set("");
          }}
        />
      </View>
      <Scroll smoothWheel style={{ maxHeight: props.compact ? 160 : 280, minHeight: 0 }}>
        <View style={{ paddingHorizontal: space.xs, paddingBottom: space.xs, paddingTop: 2, gap: 2 }}>
          <Each of={searchGroups()} key={group => group.path}>
            {group => (
              <View style={{ gap: 2 }}>
                <View
                  role="button"
                  tooltip={<TooltipBubble text={relativeDisplayPath(group().path, activeWorkspaceRoot())} />}
                  onPress={() => void openHit(group().hits[0])}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.xs,
                    minHeight: compactLayout() ? WORKBENCH_TOUCH_MIN : 28,
                    paddingHorizontal: space.sm,
                    borderRadius: radii.xs,
                    cursor: "pointer",
                    userSelect: "none",
                    ...paintTransition(MOTION_DURATION.fast),
                  }}
                  hoverStyle={{ backgroundColor: palette().panelHover }}
                  focusVisibleStyle={focusRingStyle()}
                >
                  <Icon
                    name={fileIconForPath(group().path, false, false)}
                    size={14}
                    color={fileIconColor(group().path, false, false)}
                  />
                  <Text
                    style={{
                      ...textStyle("label", { color: palette().text }),
                      fontWeight: "500",
                      flexShrink: 0,
                      maxWidth: "60%",
                      numberOfLines: 1,
                      textOverflow: "ellipsis-middle",
                    }}
                  >
                    {basename(group().path)}
                  </Text>
                  <Text
                    style={{
                      flex: 1,
                      minWidth: 0,
                      ...textStyle("caption", { color: palette().textMuted }),
                      numberOfLines: 1,
                      textOverflow: "ellipsis-start",
                    }}
                  >
                    {parentHintOf(group().path, activeWorkspaceRoot())}
                  </Text>
                  <If when={group().hits.some(hit => hit.line !== undefined)}>
                    <Text
                      style={{
                        ...textStyle("caption", { color: palette().textMuted, tabular: true }),
                        flexShrink: 0,
                      }}
                    >
                      {formatCount(group().hits.length)}
                    </Text>
                  </If>
                </View>
                <Each
                  of={group()
                    .hits.filter(hit => hit.line !== undefined)
                    .map((hit, idx) => ({ hit, key: `${hit.path}:${hit.line}:${idx}` }))}
                  key={entry => entry.key}
                >
                  {entry => <SearchMatchRow hit={entry().hit} onOpen={() => void openHit(entry().hit)} />}
                </Each>
              </View>
            )}
          </Each>
        </View>
      </Scroll>
    </View>
  );
}

function renderExplorerRow(
  entry: TreeEntry,
  touch: boolean,
  onContext: (path: string, pos: Point) => void,
) {
  if (entry.disabled && entry.id.endsWith(PLACEHOLDER_SUFFIX)) {
    return (
      <View
        style={{
          minHeight: 24,
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          paddingLeft: explorerIndentLeft(entry.depth) + 18,
          paddingRight: space.sm,
          paddingVertical: 0,
        }}
      >
        <Spinner size={12} />
        <Text style={{ ...textStyle("caption", { color: palette().textMuted }) }}>
          {tr("common.loading")}
        </Text>
      </View>
    );
  }

  const guideLevels = guideLevelsFor(entry.depth);

  return (
    <View
      accessibilityLabel={`explorer-row-${entry.label}`}
      onContextMenu={event => onContext(entry.id, event.pagePosition)}
      style={{
        position: "relative",
        height: touch ? WORKBENCH_TOUCH_MIN : 26,
        minHeight: touch ? WORKBENCH_TOUCH_MIN : 26,
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        paddingLeft: explorerIndentLeft(entry.depth),
        paddingRight: space.sm,
        paddingVertical: 0,
        borderRadius: radii.xs,
        borderCurve: "continuous",
        backgroundColor: selectedPath() === entry.id ? palette().accentSoft : "transparent",
        cursor: entry.disabled ? "default" : "pointer",
        userSelect: "none",
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{
        backgroundColor:
          selectedPath() === entry.id ? palette().accentSoft : palette().panelHover,
      }}
    >
      <If when={guideLevels.length > 0}>
        <Each of={guideLevels} key={level => level}>
          {level => (
            <View
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 13 + level() * INDENT_STEP,
                width: 1,
                backgroundColor: palette().borderSubtle,
                pointerEvents: "none",
              }}
            />
          )}
        </Each>
      </If>
      <View
        style={{
          width: 14,
          height: 14,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <If when={entry.folder || knownDirectoryPaths().has(entry.id)}>
          <View style={rotatingChevronStyle(expandedDirSet().has(entry.id))}>
            <Icon
              name="chevron-right"
              size={12}
              color={selectedPath() === entry.id ? palette().accent : palette().textMuted}
            />
          </View>
        </If>
      </View>
      <Icon
        name={fileIconForPath(
          entry.id,
          entry.folder || knownDirectoryPaths().has(entry.id),
          expandedDirSet().has(entry.id),
        )}
        size={14}
        color={fileIconColor(
          entry.id,
          entry.folder || knownDirectoryPaths().has(entry.id),
          selectedPath() === entry.id,
        )}
      />
      <Text
        style={{
          flex: 1,
          minWidth: 0,
          ...textStyle("label", {
            color:
              selectedPath() === entry.id
                ? palette().text
                : entry.disabled
                  ? palette().textMuted
                  : entry.folder || knownDirectoryPaths().has(entry.id)
                    ? palette().text
                    : palette().textSecondary,
          }),
          fontWeight:
            selectedPath() === entry.id
              ? "600"
              : entry.folder || knownDirectoryPaths().has(entry.id)
                ? "500"
                : "400",
          numberOfLines: 1,
          textOverflow: "ellipsis-middle",
        }}
      >
        {entry.label}
      </Text>
      <If when={gitChanges()[entry.id]?.letter ?? ""}>
        {letter => (
          <View
            style={{
              minWidth: space.lg,
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Text
              style={{
                ...textStyle("mono", { color: decorationColor(letter()) }),
                fontWeight: "600",
              }}
            >
              {letter()}
            </Text>
          </View>
        )}
      </If>
      <If
        when={
          (entry.folder || knownDirectoryPaths().has(entry.id)) &&
          !gitChanges()[entry.id] &&
          hasChangedDescendant(entry.id)
        }
      >
        <View
          style={{
            width: 4,
            height: 4,
            borderRadius: radii.pill,
            backgroundColor: palette().textMuted,
            flexShrink: 0,
          }}
        />
      </If>
    </View>
  );
}

function FileTree(props: {
  compact?: boolean;
  width: number;
  stacked?: boolean;
  onOpenDetail: () => void;
}) {
  const fileActionsMenuOpen = signal(false);
  const fileActionsAnchor = signal<ViewRef | null>(null);
  const treeContextPos = signal<Point | null>(null);
  const treeContextOpen = signal(false);
  const treeContextTarget = signal<string | null>(null);
  let rowContextHandled = false;

  const rootLoaded = () => {
    const root = activeWorkspaceRoot();
    return Boolean(root && root in dirChildren());
  };

  return (
    <View
      style={{
        width: props.stacked ? "100%" : props.width,
        minWidth: 0,
        minHeight: 0,
        flex: props.stacked ? 1 : undefined,
        flexShrink: props.stacked ? 1 : 0,
        overflow: "hidden",
        flexDirection: "column",
        borderRightWidth: 0,
        borderBottomWidth: 0,
        borderColor: palette().borderSubtle,
        backgroundColor: props.stacked ? palette().canvas : palette().canvasSubtle,
      }}
    >
      {/* Explorer header: compact 2-row rhythm (title + actions, then search + mode toggle) */}
      <View
        style={{
          paddingHorizontal: props.stacked ? space.md : space.sm + 2,
          paddingVertical: space.xs + 2,
          gap: space.xs + 2,
          borderBottomWidth: 1,
          borderColor: palette().borderSubtle,
          backgroundColor: props.stacked ? palette().canvas : palette().canvasSubtle,
        }}
      >
        {/* Row 1: Explorer label + quiet tabular item count + New / Refresh / More */}
        <View
          style={{
            minHeight: compactLayout() ? WORKBENCH_TOUCH_MIN : 24,
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            minWidth: 0,
          }}
        >
          <Text
            style={{
              ...textStyle("caption", {
                color: props.compact ? palette().textSecondary : palette().text,
              }),
              fontWeight: "600",
              flexShrink: 0,
            }}
          >
            {tr("files.explorer")}
          </Text>
          <Text
            style={{
              ...textStyle("caption", { color: palette().textMuted, tabular: true }),
              flexShrink: 0,
            }}
          >
            {formatCount(treeItems().length)}
          </Text>
          <View style={{ flex: 1, minWidth: 0 }} />
          <If when={fileWatchState().kind === "unsupported"}>
            <View
              accessibilityLabel="file-watch-unsupported"
              tooltip={<TooltipBubble text={tr("files.watchUnsupportedHint")} />}
              style={{ flexShrink: 1, minWidth: 0 }}
            >
              <Text
                style={{
                  ...textStyle("caption", { color: palette().warning }),
                  numberOfLines: 1,
                  textOverflow: "ellipsis",
                }}
              >
                {tr("files.watchUnsupported")}
              </Text>
            </View>
          </If>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <IconButton
              icon="plus"
              size={compactLayout() ? "md" : "xs"}
              iconSize={compactLayout() ? undefined : 12}
              tooltip={tr("files.newFile")}
              accessibilityLabel="file-quick-new"
              onPress={() => startCreate("file")}
            />
            <IconButton
              icon="refresh"
              size={compactLayout() ? "md" : "xs"}
              iconSize={compactLayout() ? undefined : 12}
              tooltip={tr("files.refreshExplorer")}
              accessibilityLabel="Refresh"
              onPress={() => void refreshDirectory(activeWorkspaceRoot())}
            />
            <View ref={el => fileActionsAnchor.set(el)} style={{ flexShrink: 0 }}>
              <IconButton
                icon="more"
                size={compactLayout() ? "md" : "xs"}
                iconSize={compactLayout() ? undefined : 12}
                active={fileActionsMenuOpen()}
                tooltip={tr("files.fileActions")}
                accessibilityLabel="file-actions-menu"
                onPress={() => fileActionsMenuOpen.set(!fileActionsMenuOpen())}
              />
            </View>
          </View>
        </View>

        {/* Row 2: Compact search field + inline Names/Contents mode switcher */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
          <InputBox
            size="sm"
            leadingIcon="search"
            clearable={true}
            clearLabel={tr("common.clearSearch")}
            value={searchQuery()}
            placeholder={
              searchMode() === "content"
                ? tr("files.searchContentPlaceholder")
                : tr("files.searchPlaceholder")
            }
            accessibilityLabel="file-search"
            style={{ flex: 1, minWidth: 120 }}
            onChange={val => {
              searchQuery.set(val);
              if (!val.trim()) {
                searchResults.set([]);
                fileNotice.set("");
              }
              scheduleFileSearch();
            }}
            onSubmit={() => void runFileSearch()}
          />
          <InlineSearchModeToggle />
        </View>

        {/* Optional content match toggles (only shown when searching or in content mode) */}
        <If when={searchMode() === "content" || searchQuery().trim()}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            <FindToggle
              label="Aa"
              a11y="file-search-case"
              tooltip={tr("files.matchCase")}
              active={searchCaseSensitive()}
              onPress={() => {
                searchCaseSensitive.set(!searchCaseSensitive());
                scheduleFileSearch();
              }}
            />
            <FindToggle
              label="ab"
              a11y="file-search-word"
              tooltip={tr("files.matchWholeWord")}
              active={searchWholeWord()}
              onPress={() => {
                searchWholeWord.set(!searchWholeWord());
                scheduleFileSearch();
              }}
            />
            <FindToggle
              label=".*"
              a11y="file-search-regex"
              tooltip={tr("files.useRegex")}
              active={searchRegex()}
              onPress={() => {
                searchRegex.set(!searchRegex());
                scheduleFileSearch();
              }}
            />
          </View>
        </If>

        <If when={fileWatchState().kind === "failed"}>
          <View
            role="alert"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              paddingHorizontal: space.xs,
              paddingVertical: space.xs,
            }}
          >
            <Icon name="warning" size={14} color={palette().warning} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={{ ...textStyle("caption", { color: palette().text }) }}>
                {tr("files.watchFailed")}
              </Text>
              <If when={(() => { const state = fileWatchState(); return state.kind === "failed" ? state.hint ?? "" : ""; })()}>
                {hint => (
                  <Text
                    style={{
                      userSelect: "text",
                      ...textStyle("mono", { color: palette().textSecondary }),
                    }}
                  >
                    {hint()}
                  </Text>
                )}
              </If>
            </View>
            <Button
              label={tr("files.watchRetry")}
              accessibilityLabel="file-watch-retry"
              variant="ghost"
              size="xs"
              onPress={() => void retryFileWatch()}
            />
          </View>
        </If>

        <If when={confirmingDelete()}>
          {target => (
            <InlineConfirmBar
              message={tr("files.deleteConfirm", { name: basename(target()) })}
              confirmLabel={tr("common.confirmDelete")}
              cancelLabel={tr("common.cancel")}
              danger={true}
              onConfirm={() => void removeSelected()}
              onCancel={cancelDelete}
            />
          )}
        </If>
      </View>

      <DropdownMenu
        open={fileActionsMenuOpen()}
        anchor={fileActionsAnchor()}
        align="end"
        minWidth={176}
        items={fileMenuItems()}
        onClose={() => fileActionsMenuOpen.set(false)}
      />

      <PendingEditBar />
      <If when={changedPaths().length > 0}>
        <ChangedFiles compact={props.compact} />
      </If>
      <If when={searchResults().length > 0}>
        <SearchResults compact={props.compact} onOpenDetail={props.onOpenDetail} />
      </If>
      <If when={Boolean(searchQuery().trim()) && !searchRunning() && searchResults().length === 0}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderBottomWidth: 1,
            borderColor: palette().borderSubtle,
          }}
        >
          <Text style={{ flex: 1, minWidth: 0, ...textStyle("caption", { color: palette().textMuted }) }}>
            {tr("files.findNoResults")}
          </Text>
          <Button
            label={tr("common.clearSearch")}
            size="xs"
            variant="ghost"
            accessibilityLabel="clear-empty-file-search"
            onPress={() => {
              searchQuery.set("");
              searchResults.set([]);
              fileNotice.set("");
            }}
          />
        </View>
      </If>
      <View
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        onContextMenu={event => {
          // A row already claimed this press; the empty space below the rows is the root.
          if (rowContextHandled) {
            rowContextHandled = false;
            return;
          }
          treeContextTarget.set(null);
          treeContextPos.set(event.pagePosition);
          treeContextOpen.set(true);
        }}
      >
        <If
          when={Boolean(activeWorkspace())}
          else={
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg }}>
              <EmptyStateCard
                icon="folder"
                title={tr("git.noWorkspaceTitle")}
                subtitle={tr("git.noWorkspaceSubtitle")}
              />
            </View>
          }
        >
          <If
            when={rootLoaded()}
            else={
              <View
                style={{
                  flex: 1,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  gap: space.sm,
                  padding: space.lg,
                }}
              >
                <Spinner size={14} />
                <Text style={{ ...textStyle("caption", { color: palette().textMuted }) }}>
                  {tr("common.loading")}
                </Text>
              </View>
            }
          >
            <Tree
              items={treeItems()}
              expanded={expandedDirs()}
              selected={selectedPath()}
              reveal={false}
              renderItem={entry =>
                renderExplorerRow(entry, compactLayout(), (path, pos) => {
                  rowContextHandled = true;
                  treeContextTarget.set(path);
                  treeContextPos.set(pos);
                  treeContextOpen.set(true);
                })
              }
              itemClass="group rounded-md focus-visible:outline-2 focus-visible:outline-ring"
              itemStyle={{
                color: palette().text,
                fontSize: textSize(13),
                paddingVertical: 0,
                paddingHorizontal: 0,
                minHeight: 0,
              }}
              listStyle={{ padding: space.xs, gap: 1 }}
              style={{ flex: 1, minHeight: 0 }}
              onExpandedChange={event => {
                const next = new Set(event.expanded);
                for (const directory of expandedDirs()) {
                  if (!next.has(directory)) void setExpanded(directory, false);
                }
                const current = expandedDirSet();
                for (const directory of next) {
                  if (!current.has(directory)) void setExpanded(directory, true);
                }
              }}
              onExpand={event => {
                if (event.id.endsWith(PLACEHOLDER_SUFFIX)) return;
                void loadDirectory(event.id);
              }}
              onSelectedChange={event => {
                selectedPath.set(event.selected);
                if (!knownDirectoryPaths().has(event.selected)) {
                  props.onOpenDetail();
                  void openFileAt(event.selected);
                }
              }}
              onAction={event => {
                if (!knownDirectoryPaths().has(event.id)) {
                  props.onOpenDetail();
                  void openFileAt(event.id);
                }
              }}
            />
          </If>
        </If>
      </View>
      <ContextMenuOverlay
        open={treeContextOpen()}
        position={treeContextPos()}
        items={fileMenuItems(treeContextTarget())}
        onClose={() => treeContextOpen.set(false)}
      />
    </View>
  );
}

function tabMenuItems(path: string): DropdownMenuItem[] {
  return [
    {
      id: "tab-close",
      label: tr("files.closeTab"),
      icon: "close",
      onSelect: () => requestCloseTab(path),
    },
    {
      id: "tab-close-others",
      label: tr("files.closeOtherTabs"),
      disabled: openFilePaths().length < 2,
      onSelect: () => closeOtherTabs(path),
    },
    { id: "tab-sep", label: "", separator: true },
    {
      id: "tab-copy-path",
      label: tr("files.copyPath"),
      icon: "copy",
      onSelect: () => void copyText(path),
    },
    {
      id: "tab-copy-relative",
      label: tr("files.copyRelativePath"),
      icon: "copy",
      onSelect: () => void copyText(relativeDisplayPath(path, activeWorkspaceRoot())),
    },
    {
      id: "tab-reveal",
      label: tr("files.revealInExplorer"),
      icon: "folder-open",
      onSelect: () => void revealPath(path),
    },
  ];
}

/**
 * One flat editor tab: no box, a 2 px accent under the active one, the file's
 * icon, a persistent dirty indicator alongside an always-reachable close button
 * on touch/phone and active/hovered tabs, middle-click to close, and context menu.
 */
function OpenFileTabChip(props: {
  path: string;
  compact?: boolean;
  onContext: (path: string, pos: Point) => void;
}) {
  const hovered = signal(false);
  const chipRef = signal<ViewRef | null>(null);
  const active = () => openFile()?.path === props.path;
  const dirty = () => isDirtyPath(props.path);
  const showClose = () => compactLayout() || Boolean(props.compact) || hovered() || active();

  effect(() => {
    if (!active()) return;
    const node = chipRef();
    if (!node) return;
    try {
      node.reveal({ horizontal: "nearest", animated: false });
    } catch {
      // Tab layout may not be measured yet on initial mount.
    }
  });

  return (
    <View
      ref={el => chipRef.set(el)}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      onMouseUp={event => {
        if (event.button === "middle") requestCloseTab(props.path);
      }}
      onContextMenu={event => props.onContext(props.path, event.pagePosition)}
      style={{
        boxSizing: "border-box",
        position: "relative",
        flexDirection: "row",
        alignItems: "center",
        flexShrink: 0,
        gap: space.xs,
        paddingLeft: space.md,
        paddingRight: space.xs,
        height: compactLayout() ? WORKBENCH_TOUCH_MIN : 36,
        borderRightWidth: 1,
        borderColor: palette().borderSubtle,
        backgroundColor: active() ? palette().canvas : "transparent",
        userSelect: "none",
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{
        backgroundColor: active() ? palette().canvas : palette().panelHover,
      }}
    >
      <View
        role="tab"
        tooltip={<TooltipBubble text={relativeDisplayPath(props.path, activeWorkspaceRoot())} />}
        accessibilityLabel={`file-tab-${basename(props.path)}`}
        accessibilityState={{ selected: active() }}
        onPress={() => {
          if (!active()) void openFileAt(props.path);
        }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          height: "100%",
          paddingRight: 2,
          cursor: "pointer",
          userSelect: "none",
        }}
        focusVisibleStyle={focusRingStyle()}
      >
        <Icon
          name={fileIconForPath(props.path, false, false)}
          size={14}
          color={fileIconColor(props.path, false, active())}
        />
        <Text
          style={{
            maxWidth: props.compact ? 120 : 180,
            ...textStyle("label", {
              color: active() ? palette().text : palette().textSecondary,
            }),
            fontWeight: active() ? "500" : "400",
            textDecorationLine: changedOnDisk()[props.path] === "deleted" ? "line-through" : "none",
            numberOfLines: 1,
            textOverflow: "ellipsis-middle",
          }}
        >
          {basename(props.path) || props.path}
        </Text>
        <If when={dirty()}>
          <View
            accessibilityLabel={`file-tab-dirty-${basename(props.path)}`}
            style={{
              width: 6,
              height: 6,
              borderRadius: radii.pill,
              backgroundColor: palette().textSecondary,
              flexShrink: 0,
            }}
          />
        </If>
      </View>
      <View
        style={{
          width: 24,
          height: 24,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          opacity: showClose() ? 1 : 0.45,
          ...paintTransition(MOTION_DURATION.fast),
        }}
      >
        <IconButton
          icon="close"
          size="xs"
          iconSize={12}
          tooltip={tr("files.closeTab")}
          accessibilityLabel={`close-file-tab-${basename(props.path)}`}
          onPress={() => requestCloseTab(props.path)}
        />
      </View>
      <If when={active()}>
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 2,
            backgroundColor: palette().accent,
            pointerEvents: "none",
          }}
        />
      </If>
    </View>
  );
}

function OpenFileTabStrip(props: { compact?: boolean }) {
  const tabContextPath = signal<string | null>(null);
  const tabContextPos = signal<Point | null>(null);
  return (
    <If
      when={openFilePaths().length > 0}
      else={
        <Text
          accessibilityLabel={tr("files.selectToPreview")}
          style={{
            flex: 1,
            minWidth: 0,
            alignSelf: "center",
            paddingHorizontal: space.xs,
            ...textStyle("caption", { color: palette().textMuted }),
            numberOfLines: 1,
            textOverflow: "ellipsis",
          }}
        >
          {tr("pane.files.choose")}
        </Text>
      }
    >
      <Scroll
        smoothWheel
        horizontal
        style={{ flex: 1, minWidth: 0, alignSelf: "stretch", overflow: "hidden" }}
        scrollbar={false}
      >
        <View style={{ flexDirection: "row", alignItems: "stretch", height: "100%" }}>
          <Each of={openFilePaths()} key={path => path}>
            {path => (
              <OpenFileTabChip
                path={path()}
                compact={props.compact}
                onContext={(target, pos) => {
                  tabContextPath.set(target);
                  tabContextPos.set(pos);
                }}
              />
            )}
          </Each>
        </View>
      </Scroll>
      <ContextMenuOverlay
        open={tabContextPath() !== null}
        position={tabContextPos()}
        items={tabMenuItems(tabContextPath() ?? "")}
        onClose={() => tabContextPath.set(null)}
      />
    </If>
  );
}

const editorRef = signal<EditorRef | null>(null);
const editorFocused = signal(false);
const editorCursor = signal<{ line: number; column: number; selectedLines: number } | null>(null);
const editorSelection = signal<{ key: string; range: EditorSelection } | null>(null);

function editorSelectionKey(path: string): string {
  return JSON.stringify([deviceContext(), activeWorkspaceId(), path]);
}

const editorDocumentKey = computed(() => editorSelectionKey(openFile()?.path ?? ""));

const detectedEditorLanguage = computed(() => {
  const file = openFile();
  if (file?.kind === "code") return inferCodeLanguage(file.path) ?? file.language;
  return file?.kind === "markdown" ? "markdown" : "text";
});

const sourceEditorLanguage = computed(() => activeFileEditorOptions()?.language ?? detectedEditorLanguage());
const latexPreviewOnly = () => activeFileEditorOptions()?.latex?.mode === "preview";

const sourceEditorIndentation = computed(() => {
  const override = activeFileEditorOptions()?.indentation;
  if (override) return override;
  const policy = activeFileEditorConfig()?.indentation;
  if (!policy) return null;
  // Draft keystrokes must not change the mode under the caret. Reloading the
  // file replaces the disk snapshot and recomputes the detected indentation.
  const file = openFile();
  return policy.detect && file ? guessEditorIndentation(file.content, policy.fallback) : policy.fallback;
});

const savedEditorSettings = computed(() =>
  JSON.stringify(Object.entries(settingsValues()).filter(([path]) => path.startsWith("editor."))),
);
const sourceFontSize = () => activeFileEditorConfig()?.fontSize ?? textSize(13);

function editorLanguageLabel(id: string): string {
  const language = resolveEditorLanguage(id) ?? id;
  return language === "Plain Text" ? tr("files.plainTextLanguage") : language;
}

function afterEditorOverlayCloses(action: (editor: EditorRef) => void): void {
  const editor = editorRef();
  const key = editorDocumentKey();
  if (!editor) return;
  // The overlay must leave the native window before focus moves to the
  // editor's own text input.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (editor === editorRef() && key === editorDocumentKey()) action(editor);
  }));
}

function addSelectedCodeToChat(): void {
  const file = openFile();
  const selection = editorSelection();
  const workspaceId = activeWorkspaceId();
  if (!file || !selection || selection.key !== editorSelectionKey(file.path) || !workspaceId) return;
  const targetIsSplit = splitPaneOpen() && focusedPane() === 1;
  const targetWorkspace = targetIsSplit ? secondaryWorkspaceId() : activeSession()?.workspaceId ?? workspaceId;
  const targetDevice = targetIsSplit ? secondarySessionDevice() : activeSessionDevice();
  if ((targetIsSplit && !secondarySessionId()) || targetWorkspace !== workspaceId ||
    (fleetActive() && targetDevice && targetDevice !== deviceContext())) {
    pushToast(tr("files.snippetDifferentWorkspace"), "warning");
    return;
  }
  const snippet = createCodeSnippetContext(file.path, basenameOfPath(file.path, isRemoteWorkspace()) || file.name,
    inferCodeLanguage(file.path) ?? file.language,
    editingContent() ?? file.content, selection.range);
  if (!snippet) return;
  const target = targetIsSplit ? secondaryComposerText : composerText;
  target.update(text => `${text}${text && !/\s$/.test(text) ? " " : ""}${codeSnippetPromptToken(snippet)} `);
  navigateScene("sessions");
  pushToast(tr("files.addedToChat", { name: codeSnippetLabel(snippet) }), "success");
}

function hasCodeSelection(): boolean {
  const selection = editorSelection();
  const path = openFile()?.path;
  return Boolean(editorRef() && path && selection?.key === editorSelectionKey(path));
}
const findOpen = signal(false);
const findQuery = signal("");
const findCase = signal(false);
const findWord = signal(false);
const findRegex = signal(false);
const findResult = signal<EditorSearchResult | null>(null);
/** A line the editor should reveal once the file it belongs to is on screen. */
const pendingRevealLine = signal<{ key: string; line: number } | null>(null);
const activeRevealLine = computed(() => {
  const target = pendingRevealLine();
  const path = openFile()?.path;
  return target && path && selectedPath() === path && target.key === editorDocumentKey() ? target : null;
});

function openFind(): void {
  if (!editorRef() || latexPreviewOnly()) return;
  findOpen.set(true);
}

function closeFind(): void {
  findOpen.set(false);
  findResult.set(null);
  editorRef()?.focus();
}

function FindToggle(props: { label: string; a11y: string; active: boolean; tooltip: string; onPress: () => void }) {
  return (
    <View
      role="checkbox"
      accessibilityLabel={props.a11y}
      accessibilityState={{ checked: props.active }}
      tooltip={<TooltipBubble text={props.tooltip} />}
      hitSlop={touchSlop(24)}
      onPress={props.onPress}
      style={{
        minWidth: 24,
        height: compactLayout() ? 32 : 24,
        paddingHorizontal: space.xs,
        borderRadius: radii.xs,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: props.active ? palette().accentBorder : "transparent",
        backgroundColor: props.active ? palette().accentSoft : "transparent",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        userSelect: "none",
        ...pressTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{ backgroundColor: props.active ? palette().accentSoft : palette().panelHover }}
      activeStyle={tactileActiveStyle(0.96)}
      focusVisibleStyle={focusRingStyle()}
    >
      <Text
        style={{
          ...textStyle("mono", {
            color: props.active ? palette().accent : palette().textSecondary,
          }),
          fontWeight: "600",
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}

/** The editor's find bar: the Editor's own `search`, with case / word / regex and match count. */
function EditorFindBar() {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: space.xs,
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        borderBottomWidth: 1,
        borderColor: palette().borderSubtle,
        backgroundColor: palette().canvasSubtle,
      }}
    >
      <View style={{ flex: 1, minWidth: 140, maxWidth: 360 }}>
        <InputBox
          size="sm"
          leadingIcon="search"
          value={findQuery()}
          placeholder={tr("files.findPlaceholder")}
          accessibilityLabel="file-find-input"
          autoFocus={true}
          onChange={value => findQuery.set(value)}
          onSubmit={() => editorRef()?.run("findNext")}
          onKeyPress={event => {
            if (event.key === "Escape") closeFind();
          }}
        />
      </View>
      <FindToggle label="Aa" a11y="file-find-case" tooltip={tr("files.matchCase")} active={findCase()} onPress={() => findCase.set(!findCase())} />
      <FindToggle label="ab" a11y="file-find-word" tooltip={tr("files.matchWholeWord")} active={findWord()} onPress={() => findWord.set(!findWord())} />
      <FindToggle label=".*" a11y="file-find-regex" tooltip={tr("files.useRegex")} active={findRegex()} onPress={() => findRegex.set(!findRegex())} />
      <Text
        style={{
          minWidth: 64,
          ...textStyle("caption", {
            color: findResult()?.error ? palette().danger : palette().textMuted,
            tabular: true,
          }),
          numberOfLines: 1,
        }}
      >
        {findResult()?.error
          ? tr("files.findInvalidRegex")
          : !findQuery()
            ? ""
            : (findResult()?.count ?? 0) === 0
              ? tr("files.findNoResults")
              : (findResult()?.current ?? -1) < 0
                ? formatPlural(findResult()?.count ?? 0, "format.matchOne", "format.matchOther")
                : tr("files.findCount", {
                    current: (findResult()?.current ?? 0) + 1,
                    total: formatCount(findResult()?.count ?? 0),
                  })}
      </Text>
      <IconButton icon="chevron-up" size="xs" iconSize={12} tooltip={tr("files.findPrevious")} accessibilityLabel="file-find-previous" onPress={() => editorRef()?.run("findPrevious")} />
      <IconButton icon="chevron-down" size="xs" iconSize={12} tooltip={tr("files.findNext")} accessibilityLabel="file-find-next" onPress={() => editorRef()?.run("findNext")} />
      <IconButton icon="close" size="xs" iconSize={12} tooltip={tr("common.close")} accessibilityLabel="file-find-close" onPress={closeFind} />
    </View>
  );
}

function lineEndingOf(text: string): "LF" | "CRLF" {
  return text.includes("\r\n") ? "CRLF" : "LF";
}

function EditorLocationControl(props: { compact?: boolean }) {
  const anchor = signal<ViewRef | null>(null);
  const opened = signal(false);
  const query = signal("");
  const invalid = signal(false);
  const cursor = () => editorCursor() ?? { line: 1, column: 1, selectedLines: 0 };
  const close = () => opened.set(false);

  function open() {
    if (!editorRef()) return;
    const { line, column } = cursor();
    query.set(`${line}:${column}`);
    invalid.set(false);
    opened.set(true);
  }

  function returnToEditor(afterDismiss?: (editor: EditorRef) => void) {
    close();
    afterEditorOverlayCloses(editor => {
      if (opened()) return;
      afterDismiss?.(editor);
      editor.focus();
    });
  }

  function jump() {
    const editor = editorRef();
    const file = openFile();
    if (!editor || !file) return;
    const match = /^(\d+)(?:\s*:\s*(\d+))?$/.exec(query().trim());
    const lineNumber = Number(match?.[1]);
    const columnNumber = Number(match?.[2] ?? 1);
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 ||
        !Number.isSafeInteger(columnNumber) || columnNumber < 1) {
      invalid.set(true);
      return;
    }
    const lines = (editingContent() ?? file.content).split(/\r?\n/);
    const line = Math.min(lineNumber, lines.length) - 1;
    const column = Math.min(columnNumber - 1, lines[line].length);
    const position = { line, column };
    returnToEditor(target => {
      target.setSelections([{ anchor: position, head: position }]);
      target.revealPosition(position, true);
    });
  }

  effect(() => {
    editorDocumentKey();
    editorRef();
    close();
  });
  effect(() => {
    if (editorFocused()) cleanup(keymap.bind("mod+g", open, { when: "always", overFocused: true }));
  });

  return <>
    <View ref={node => anchor.set(node)} style={{ flexShrink: 0 }}>
      <Button label={cursor().selectedLines > 1
        ? tr("files.cursorWithLines", { line: cursor().line, column: cursor().column, lines: cursor().selectedLines })
        : tr("files.cursor", { line: cursor().line, column: cursor().column })}
        size={props.compact ? "sm" : "xs"} variant="ghost" tooltip={tr("files.goToLine")}
        accessibilityLabel="file-go-to-line" onPress={open} />
    </View>
    <If when={opened()}>
      <Overlay anchor={anchor()} placement="top" align="end" offset={space.xs} margin={space.sm}
        onPressOutside={close} onCancel={() => returnToEditor()}>
        <View style={{ ...menuSurfaceStyle(), width: 248, maxWidth: "90%", padding: space.sm, gap: space.sm }}>
          <InputBox label={tr("files.goToLine")} hint={tr("files.goToLineHint")}
            accessibilityLabel="file-go-to-line-input" size="sm" autoFocus={true}
            inputRef={input => queueMicrotask(() => input.setSelection(0, query().length))}
            value={query()} error={invalid() ? tr("files.goToLineInvalid") : undefined}
            onChange={value => { query.set(value); invalid.set(false); }} onSubmit={jump} />
          <View style={{ alignItems: "flex-end" }}>
            <Button label={tr("common.go")} size="sm" variant="primary"
              accessibilityLabel="file-go-to-line-confirm" onPress={jump} />
          </View>
        </View>
      </Overlay>
    </If>
  </>;
}

function EditorStatusMenu(props: {
  label: string; title: string; id: string; compact?: boolean; items: DropdownMenuItem[]; disabled?: boolean;
}) {
  const anchor = signal<ViewRef | null>(null);
  const open = signal(false);
  return <View ref={node => anchor.set(node)} style={{ flexShrink: 0 }}>
    <Button label={props.label} tooltip={props.title} accessibilityLabel={props.id} disabled={props.disabled}
      size={props.compact ? "sm" : "xs"} variant="ghost" onPress={() => open.set(!open())} />
    <DropdownMenu open={open()} anchor={anchor()} placement="top" align="end" minWidth={196}
      maxHeight={320} items={props.items} onClose={() => open.set(false)} />
  </View>;
}

function EditorEncodingMenu(props: { compact?: boolean }) {
  const current = (): EditorFileEncoding => openFile()?.byteIdentity?.encoding ??
    (openFile()?.content.startsWith("\ufeff") ? "utf8-bom" : "utf8");
  return <EditorStatusMenu compact={props.compact} id="file-encoding-menu" label={editorFileEncodings[current()]}
    title={tr(hasUnsavedEdit() ? "files.encodingPendingEdit" : "files.reopenWithEncoding")}
    disabled={hasUnsavedEdit() || fileSaving()}
    items={(Object.keys(editorFileEncodings) as EditorFileEncoding[]).map(encoding => ({
      id: encoding, label: editorFileEncodings[encoding], accessibilityLabel: `file-encoding-${encoding}`,
      active: encoding === current(),
      onSelect: () => void reopenWithEncoding(encoding).then(reopened => {
        if (reopened) afterEditorOverlayCloses(editor => editor.focus());
      }),
    }))} />;
}

function EditorStatusModes(props: { compact?: boolean }) {
  const language = () => resolveEditorLanguage(sourceEditorLanguage()) ?? sourceEditorLanguage();
  const indentation = () => sourceEditorIndentation() ?? defaultEditorIndentation(language());
  const indentLabel = (size: number, tabs: boolean) =>
    tr(tabs ? "files.indentTabs" : "files.indentSpaces", { count: formatCount(size) });
  const setIndentation = (indentation?: FileEditorOptions["indentation"]) => {
    setActiveFileEditorOptions({ indentation });
    afterEditorOverlayCloses(editor => editor.focus());
  };
  const indentationItems = (): DropdownMenuItem[] => [
    {
      id: "automatic", label: tr("files.useEditorIndentationSettings"),
      hint: activeFileEditorConfig()?.indentation.detect ? tr("settings.field.editorDetectIndentation") : undefined,
      accessibilityLabel: "file-indent-automatic", active: !activeFileEditorOptions()?.indentation,
      onSelect: () => setIndentation(),
    },
    ...[false, true].flatMap(hardTabs => Array.from({ length: 8 }, (_, index) => {
      const tabSize = index + 1;
      const current = activeFileEditorOptions()?.indentation;
      const id = `${hardTabs ? "tabs" : "spaces"}-${tabSize}`;
      return {
        id, label: indentLabel(tabSize, hardTabs), accessibilityLabel: `file-indent-${id}`,
        separator: tabSize === 1, active: current?.tabSize === tabSize && current?.hardTabs === hardTabs,
        onSelect: () => setIndentation({ tabSize, hardTabs }),
      };
    })),
  ];
  const languageItems = (): DropdownMenuItem[] => [
    {
      id: "automatic", label: tr("files.detectEditorLanguage"), hint: editorLanguageLabel(detectedEditorLanguage()),
      accessibilityLabel: "file-language-automatic", active: !activeFileEditorOptions()?.language,
      onSelect: () => setActiveFileEditorOptions({ language: undefined }),
    },
    ...editorLanguages.map(name => ({
      id: name, label: editorLanguageLabel(name), icon: name === "Plain Text" ? "file-text" as const : "file-code" as const,
      accessibilityLabel: `file-language-${name}`, separator: name === "Plain Text",
      active: activeFileEditorOptions()?.language === name,
      onSelect: () => setActiveFileEditorOptions({ language: name }),
    })),
  ];
  return <>
    <EditorStatusMenu compact={props.compact} id="file-indent-menu" title={tr("files.editorIndentation")}
      label={indentLabel(indentation().tabSize, indentation().hardTabs)} items={indentationItems()} />
    <EditorStatusMenu compact={props.compact} id="file-language-menu" title={tr("files.editorLanguageMode")}
      label={editorLanguageLabel(language())} items={languageItems()} />
  </>;
}

/** Line and column, selection, language, line ending and encoding, as an editor's status bar shows them. */
function EditorStatusBar(props: { compact?: boolean }) {
  const item = (text: string) => (
    <Text
      style={{
        ...textStyle("caption", { color: palette().textMuted, tabular: true }),
        numberOfLines: 1,
        flexShrink: 0,
      }}
    >
      {text}
    </Text>
  );
  return (
    <View
      style={{
        minHeight: props.compact ? WORKBENCH_TOUCH_MIN : 24,
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: space.xs,
        paddingHorizontal: space.md,
        borderTopWidth: 1,
        borderColor: palette().borderSubtle,
        backgroundColor: palette().canvasSubtle,
      }}
    >
      <If when={openFile()?.large}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 1, minWidth: 0 }}>
          <Icon name="warning" size={12} color={palette().warning} />
          <Text
            style={{
              ...textStyle("caption", { color: palette().warning }),
              numberOfLines: 1,
              flexShrink: 1,
            }}
          >
            {tr("files.largeFileMode")}
          </Text>
        </View>
      </If>
      <View style={{ flex: 1 }} />
      <If when={hasCodeSelection()}>
        <Button label={tr("files.addToChat")} variant="ghost" size="xs" leadingIcon="chat"
          accessibilityLabel="file-add-selection-to-chat" onPress={addSelectedCodeToChat} />
      </If>
      <If when={editorRef()}><EditorLocationControl compact={props.compact} /></If>
      <If when={editorRef()}>
        <Each of={[editorDocumentKey()]} key={key => key}>{() => <EditorStatusModes compact={props.compact} />}</Each>
      </If>
      <If when={canReopenWithEncoding()}>
        <Each of={[editorDocumentKey()]} key={key => key}>{() => <EditorEncodingMenu compact={props.compact} />}</Each>
      </If>
      <If when={!props.compact}>
        <If when={openFile() && isEditableKind(openFile()!.kind)}>
          {item(lineEndingOf(openFile()?.content ?? ""))}
        </If>
        <If when={!editorRef()}>
          {item(openFile()?.kind === "diff" ? tr("files.diffTab")
            : inferCodeLanguage(openFile()?.path ?? "") || openFile()?.language || openFile()?.kind || "")}
        </If>
      </If>
    </View>
  );
}

function fileImageWorkspace(): MarkdownImageWorkspace | undefined {
  const workspaceId = activeWorkspaceId();
  return workspaceId ? { workspaceId, deviceId: deviceContext(), remote: isRemoteWorkspace() } : undefined;
}

/** A link in a Markdown preview: web/mailto links open outside, workspace/file:// links open here. */
function openMarkdownLink(url: string, documentPath: string): void {
  const remote = isRemoteWorkspace();
  const baseDir = dirnameOfPath(documentPath, remote) || activeWorkspaceRoot();
  const resolved = resolveWorkspaceMarkdownLink(url, baseDir, remote);
  if (resolved.kind === "external") {
    void openUrl(resolved.target).catch(() => undefined);
    return;
  }
  if (resolved.kind === "workspace") {
    void revealPath(resolved.target);
  }
}

/**
 * The bars above the editor that need an answer: a dirty tab waiting to close,
 * a save stopped by a newer disk copy, an open file that changed or went away
 * on disk. Each is in-scene, so a remote controller can answer it too.
 */
function FileAttentionBars(props: { compact?: boolean }) {
  return (
    <View style={{ flexDirection: "column" }}>
      <If when={confirmingCloseTab()}>
        {path => (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: space.sm,
              paddingHorizontal: props.compact ? space.sm : space.md,
              paddingVertical: space.xs,
              borderBottomWidth: 1,
              borderColor: palette().borderSubtle,
              backgroundColor: palette().canvasSubtle,
            }}
          >
            <View style={{ flex: 1, minWidth: 220 }}>
              <InlineConfirmBar
                message={tr("files.closeDirtyConfirm", { name: basename(path()) })}
                confirmLabel={tr("files.discardAndClose")}
                cancelLabel={tr("common.cancel")}
                danger={true}
                onConfirm={() => closeTab(path())}
                onCancel={cancelCloseTab}
              />
            </View>
            <If when={openFile()?.path === path()}>
              <Button
                label={tr("files.saveAndClose")}
                accessibilityLabel="file-save-and-close"
                variant="primary"
                size="xs"
                loading={fileSaving()}
                onPress={() => void saveAndCloseTab(path())}
              />
            </If>
          </View>
        )}
      </If>
      <If when={confirmingEncodingSave() === openFile()?.path ? confirmingEncodingSave() : null}>
        {path => <AttentionBar tone="warning" icon="warning" message={tr("files.encodingConvertConfirm")}
          actions={[
            { label: tr("files.saveAsUtf8"), a11y: "file-encoding-save-utf8", variant: "primary",
              onPress: () => confirmingCloseTab() === path()
                ? void saveAndCloseTab(path(), { convertEncoding: true })
                : void saveEditedFile({ convertEncoding: true }) },
            { label: tr("common.cancel"), a11y: "file-encoding-save-cancel", variant: "ghost", onPress: cancelEncodingSave },
          ]} />}
      </If>
      <If when={saveConflict() === openFile()?.path ? saveConflict() : null}>
        {path => (
          <AttentionBar
            tone="danger"
            icon="warning"
            message={tr("files.saveConflict", { name: basename(path()) })}
            actions={[
              {
                label: tr("files.overwrite"),
                a11y: "file-conflict-overwrite",
                variant: "danger",
                onPress: () => void saveEditedFile({ force: true }),
              },
              {
                label: tr("files.reloadFromDisk"),
                a11y: "file-conflict-reload",
                variant: "secondary",
                onPress: () => void reloadFromDisk(path()),
              },
              { label: tr("common.cancel"), a11y: "file-conflict-cancel", variant: "ghost", onPress: cancelSaveConflict },
            ]}
          />
        )}
      </If>
      <If when={openFile() && !saveConflict() ? changedOnDisk()[openFile()!.path] : undefined}>
        {state => (
          <AttentionBar
            tone="warning"
            icon="warning"
            message={
              state() === "deleted"
                ? tr("files.deletedOnDisk", { name: openFile()?.name ?? "" })
                : tr("files.changedOnDisk", { name: openFile()?.name ?? "" })
            }
            actions={[
              {
                label: state() === "deleted" ? tr("files.closeTab") : tr("files.reloadFromDisk"),
                a11y: "file-disk-reload",
                variant: "secondary",
                onPress: () => {
                  const path = openFile()?.path;
                  if (!path) return;
                  if (state() === "deleted") closeTab(path);
                  else void reloadFromDisk(path);
                },
              },
              {
                label: tr("files.keepMine"),
                a11y: "file-disk-keep",
                variant: "ghost",
                onPress: () => {
                  const path = openFile()?.path;
                  if (path) void keepDraftOverDisk(path);
                },
              },
            ]}
          />
        )}
      </If>
    </View>
  );
}

interface AttentionAction {
  label: string;
  a11y: string;
  variant: "primary" | "secondary" | "ghost" | "danger";
  onPress: () => void;
}

function AttentionBar(props: {
  tone: "warning" | "danger";
  icon: IconName;
  message: string;
  actions: AttentionAction[];
}) {
  return (
    <View
      role="alert"
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: space.sm,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderBottomWidth: 1,
        borderLeftWidth: 2,
        borderColor: palette().borderSubtle,
        borderLeftColor: props.tone === "danger" ? palette().danger : palette().warning,
        backgroundColor: palette().canvasSubtle,
      }}
    >
      <Icon
        name={props.icon}
        size={14}
        color={props.tone === "danger" ? palette().danger : palette().warning}
      />
      <Text
        style={{
          flex: 1,
          minWidth: 160,
          ...textStyle("caption", { color: palette().text }),
        }}
      >
        {props.message}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        <Each of={props.actions} key={action => action.a11y}>
          {action => (
            <Button
              label={action().label}
              accessibilityLabel={action().a11y}
              variant={action().variant}
              size="xs"
              onPress={action().onPress}
            />
          )}
        </Each>
      </View>
    </View>
  );
}

function ReadOnlyPreviewBar(props: { file: OpenFile; compact?: boolean }) {
  const splitAvailable = () => !props.file.large && canSplitMarkdown(Boolean(props.compact));
  const reason = () => {
    if (props.file.large) return tr("files.largeFileMode");
    if (openPlan()?.kind === "plan") return "";
    const block = markdownBlock();
    if (block === "unavailable") return tr("doc.visualUnavailable");
    if (block === "fidelity") return tr("doc.readOnlyHtmlHint");
    return tr("doc.readOnlyRichHint");
  };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space.sm,
        paddingHorizontal: props.compact ? space.md : space.lg,
        paddingVertical: space.xs,
        borderBottomWidth: 1,
        borderColor: palette().borderSubtle,
        backgroundColor: palette().canvasSubtle,
      }}
    >
      <Text
        accessibilityLabel={markdownBlock() ? "doc-readonly-hint" : "doc-rich-preview-hint"}
        style={{
          flex: 1,
          minWidth: 0,
          ...textStyle("caption", { color: palette().textMuted }),
          numberOfLines: 1,
          textOverflow: "ellipsis",
        }}
      >
        {reason()}
      </Text>
      <If when={openPlan()?.kind === "plan"} else={
      <If
        when={splitAvailable()}
        else={
          <Button
            label={props.file.large ? tr("files.editAnyway") : tr("doc.editAsSource")}
            accessibilityLabel="file-preview-edit"
            variant="ghost"
            size="xs"
            leadingIcon="edit"
            onPress={() => enterMarkdownSource(props.file.path)}
          />
        }
      >
        <Button
          label={tr("doc.splitToEdit")}
          accessibilityLabel="file-preview-edit"
          variant="ghost"
          size="xs"
          leadingIcon="panel-right"
          onPress={() => enterMarkdownSplit(props.file.path)}
        />
      </If>}>
        <Button label={tr("doc.editVisually")} accessibilityLabel="file-edit" variant="ghost" size="xs"
          leadingIcon="edit" onPress={() => enterMarkdownVisual(props.file.path)} />
      </If>
    </View>
  );
}

function PreviewBody(props: { compact?: boolean }) {
  const contextPosition = signal<Point | null>(null);
  const editorMenuItems = (): DropdownMenuItem[] => [
    { id: "copy", label: tr("common.copy"), icon: "copy", disabled: !hasCodeSelection(),
      onSelect: () => editorRef()?.run("copy") },
    ...(editingContent() !== null ? [
      { id: "cut", label: tr("files.cutSelection"), disabled: !hasCodeSelection(), onSelect: () => editorRef()?.run("cut") },
      { id: "paste", label: tr("common.paste"), onSelect: () => editorRef()?.run("paste") },
    ] : []),
    { id: "select-all", label: tr("files.selectAll"), accessibilityLabel: "file-editor-select-all",
      onSelect: () => editorRef()?.run("selectAll") },
    ...(hasCodeSelection() ? [{ id: "add-to-chat", label: tr("files.addToChat"), icon: "chat" as const,
      accessibilityLabel: "file-menu-add-selection-to-chat", onSelect: addSelectedCodeToChat }] : []),
  ];
  effect(() => {
    editorDocumentKey();
    editorSelection.set(null);
    editorCursor.set(null);
    contextPosition.set(null);
  });
  cleanup(() => editorSelection.set(null));
  function SourceEditorPane(props: { file: OpenFile; compact?: boolean; showNotice?: boolean }) {
    const renderSource = () =>   <View style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
    <If when={props.file.kind === "code" && extensionOf(props.file.path) === "tex"}>
      <LatexSourceTools source={editingContent() ?? props.file.content} editor={editorRef()}
        focused={editorFocused() && !latexPreviewOnly()} editable={editingContent() !== null && !latexPreviewOnly()}
        afterMenu={afterEditorOverlayCloses} />
    </If>
    <If when={props.showNotice ? markdownBlock() : null}>
      {block => <VisualEditNotice block={block()} />}
    </If>
    <If when={findOpen() && !props.compact}>
      <EditorFindBar />
    </If>
    <Editor
      ref={ref => {
        editorSelection.set(null);
        editorRef.set(ref);
        if (!ref) editorFocused.set(false);
      }}
      onFocus={() => editorFocused.set(true)}
      onBlur={() => editorFocused.set(false)}
      value={editingContent() ?? props.file.content}
      language={sourceEditorLanguage()}
      tabSize={sourceEditorIndentation()?.tabSize ?? null}
      hardTabs={sourceEditorIndentation()?.hardTabs ?? null}
      readOnly={editingContent() === null}
      lineNumbers={activeFileEditorConfig()?.lineNumbers ?? true}
      folding={true}
      indentGuides={true}
      activeLine={editingContent() !== null && (activeFileEditorConfig()?.activeLine ?? true)}
      highlighting={!props.file.large}
      fontFamily={activeFileEditorConfig()?.fontFamily ?? fontMono()}
      fontSize={sourceFontSize()}
      lineHeight={Math.round(sourceFontSize() * (activeFileEditorConfig()?.lineHeightRatio ?? 1.55))}
      softWrap={activeFileEditorConfig()?.softWrap ?? (props.file.kind !== "code")}
      showWhitespaces={activeFileEditorConfig()?.showWhitespaces ?? false}
      scrollBeyondLastLine={activeFileEditorConfig()?.scrollBeyondLastLine ?? false}
      styles={createEditorStyles()}
      search={
        findOpen() && findQuery()
          ? {
              query: findQuery(),
              caseSensitive: findCase(),
              wholeWord: findWord(),
              regex: findRegex(),
            }
          : null
      }
      accessibilityLabel="file-editor"
      style={{ flex: 1, minHeight: 0, minWidth: 0 }}
      onChange={event => {
        if (editingContent() !== null) setEditingContent(event.value);
      }}
      onSelectionChange={event => {
        const primary = event.selections[event.selections.length - 1];
        const selected = primary && (primary.anchor.line !== primary.head.line || primary.anchor.column !== primary.head.column);
        editorSelection.set(selected ? { key: editorSelectionKey(props.file.path), range: primary } : null);
        if (!primary) return;
        const sameLine = primary.anchor.line === primary.head.line;
        editorCursor.set({
          line: primary.head.line + 1,
          column: primary.head.column + 1,
          selectedLines: sameLine ? 0 : Math.abs(primary.head.line - primary.anchor.line) + 1,
        });
      }}
      onContextMenu={event => contextPosition.set({ x: event.x, y: event.y })}
      onSearchChange={event => findResult.set(event.result)}
    />
    <ContextMenuOverlay open={contextPosition() !== null}
      position={contextPosition() ?? { x: 0, y: 0 }} items={editorMenuItems()}
      onClose={() => contextPosition.set(null)} />
  </View>;
    return <If when={props.file.kind === "code" && extensionOf(props.file.path) === "tex"} else={renderSource()}>
      <Each of={[editorDocumentKey()]} key={key => key}>{() =>
        <LatexDocumentLayout path={props.file.path} renderSource={renderSource} />
      }</Each>
    </If>;
  }

  const renderMarkdown = (markdown: string, path: string, overview = false) => (
    <MarkdownPreview accessibilityLabel={overview ? "plan-overview" : "file-markdown-preview"}
      markdown={markdown} compact={props.compact}
      documentPath={path}
      onOpenWorkspacePath={target => void revealPath(target)}
      onLinkPress={event => openMarkdownLink(event.url, path)} />
  );
  return (
    <If
      when={openFile()}
      else={
        <View
          style={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            padding: props.compact ? 16 : 32,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          <QuietEmptyPrompt
            icon="file-code"
            title={tr("pane.files.choose")}
            subtitle={undefined}
          />
        </View>
      }
    >
      {file => (
        <View
          style={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            overflow: "hidden",
            flexDirection: "column",
            backgroundColor: palette().canvas,
          }}
        >
          <If when={file().kind === "diff"}>
            <If
              when={Boolean(file().content.trim())}
              else={
                <View
                  style={{
                    flex: 1,
                    minHeight: 0,
                    minWidth: 0,
                    padding: props.compact ? space.lg : space.xxl,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <QuietEmptyPrompt
                    icon="git-branch"
                    title={tr("files.noDiffOutput")}
                    subtitle={
                      file().note ? localizeHostError(file().note!) : tr("files.noDiffAgainstHead")
                    }
                  />
                </View>
              }
            >
              <View style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
                <If when={file().note ?? ""}>
                  {note => (
                    <Text
                      style={{
                        ...textStyle("caption", { color: palette().textMuted }),
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                        borderBottomWidth: 1,
                        borderColor: palette().borderSubtle,
                      }}
                    >
                      {localizeHostError(note())}
                    </Text>
                  )}
                </If>
                <DiffView
                  patch={file().content}
                  language="text"
                  layout={props.compact ? "unified" : fileDiffLayout()}
                  indicators="bars"
                  inline="wordAlt"
                  lineNumbers={true}
                  fontFamily={fontMono()}
                  fontSize={textSize(12)}
                  lineHeight={textLineHeight(12, 1.55)}
                  styles={createDiffViewStyles()}
                  style={{ flex: 1, minHeight: 0, minWidth: 0 }}
                />
              </View>
            </If>
          </If>
          <If when={markdownMode() === "preview"}>
            <ReadOnlyPreviewBar file={file()} compact={props.compact} />
            <Scroll smoothWheel style={{ flex: 1, minHeight: 0 }}>
              <View style={{ padding: props.compact ? space.lg : space.x3l, alignItems: "center" }}>
                <View style={{ width: "100%", maxWidth: layout.conversationWidth }}>
                  <If when={openPlan()} else={renderMarkdown(editingContent() ?? file().content, file().path)}>
                    {plan => <Each of={[file().path]} key={path => path}>
                      {path => <PlanDocument plan={plan()} fileName={file().name}
                        disabled={fileSaving() || Boolean(changedOnDisk()[path()])}
                        buildStatus={currentPlanBuild(path())} buildBlocked={planBuildBlocked(path())}
                        onBuild={() => void buildOpenPlan(path())}
                        onChange={markdown => {
                          if (openFile()?.path !== path()) return;
                          beginEditFile();
                          setEditingContent(markdown);
                        }}
                        renderMarkdown={(markdown, overview) => renderMarkdown(markdown, path(), overview)} />}
                    </Each>}
                  </If>
                </View>
              </View>
            </Scroll>
          </If>
          <If when={markdownMode() === "visual"}>
            <MarkdownDocumentEditor
              documentKey={file().path}
              documentPath={file().path}
              documentName={file().name}
              text={openPlan()?.body ?? editingContent() ?? file().content}
              revealLine={activeRevealLine()}
              onRevealLine={(target, revealed) => {
                if (activeRevealLine() !== target) return;
                if (revealed) pendingRevealLine.set(null);
                else selectMarkdownMode("source");
              }}
              onChange={markdown => {
                const plan = openPlan();
                setEditingContent(plan?.kind === "plan" ? plan.withBody(markdown) : markdown);
              }}
              accessibilityLabel="file-editor"
              placeholder={tr("doc.placeholder")}
              compact={props.compact}
              maxWidth={layout.conversationWidth}
              imageWorkspace={fileImageWorkspace()}
              ai={{ documentKey: editorDocumentKey(), target: deviceContext() || null }}
              onLinkPress={url => openMarkdownLink(url, file().path)}
            />
          </If>
          <If when={markdownMode() === "split"}>
            <View style={{ flex: 1, minHeight: 0, minWidth: 0, flexDirection: "row", overflow: "hidden" }}>
              <View style={{ flex: markdownSplitRatio(), minWidth: 240, minHeight: 0, overflow: "hidden", flexDirection: "column" }}>
                <SourceEditorPane file={file()} compact={props.compact} />
              </View>
              <SplitHandle
                accessibilityLabel="Resize markdown split"
                onReset={() => markdownSplitRatio.set(0.5)}
                onDelta={dx => {
                  const width = Math.max(480, previewPaneWidth());
                  markdownSplitRatio.update(r => Math.max(0.28, Math.min(0.72, r + dx / width)));
                }}
              />
              <View style={{ flex: 1 - markdownSplitRatio(), minWidth: 240, minHeight: 0, overflow: "hidden", flexDirection: "column" }}>
                <Scroll smoothWheel style={{ flex: 1, minHeight: 0 }}>
                  <View style={{ padding: space.xl, alignItems: "center" }}>
                    <View style={{ width: "100%", maxWidth: layout.conversationWidth }}>
                      <MarkdownPreview
                        accessibilityLabel="file-markdown-preview"
                        markdown={editingContent() ?? file().content}
                        documentPath={file().path}
                        compact={true}
                        onOpenWorkspacePath={target => void revealPath(target)}
                        onLinkPress={event => openMarkdownLink(event.url, file().path)}
                      />
                    </View>
                  </View>
                </Scroll>
              </View>
            </View>
          </If>
          <If when={htmlPreviewing()}>
            <WebView
              accessibilityLabel="file-html-view"
              html={editingContent() ?? file().content}
              javaScriptEnabled={false}
              incognito={true}
              style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                backgroundColor: palette().canvas,
                pointerEvents: splitDragging() ? "none" : "auto",
              }}
              onError={() => setHtmlPreview(file().path, false)}
            />
          </If>
          <If when={file().kind === "pdf"}>
            <If
              when={file().content}
              else={
                <View
                  style={{
                    flex: 1,
                    minHeight: 0,
                    minWidth: 0,
                    padding: props.compact ? space.lg : space.x3l,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <QuietEmptyPrompt
                    icon="file-text"
                    title={file().name}
                    subtitle={pdfPreviewSupported() ? tr("doc.pdfUnavailable") : tr("doc.pdfElsewhere")}
                  />
                </View>
              }
            >
              {encoded => rendererAssets()?.pdfScript
                ? <Each of={[`${editorDocumentKey()}::${file().previewRevision ?? 0}`]} key={key => key}>{() =>
                  <PdfReviewWorkspace path={file().path} name={file().name} base64={encoded()} blockInput={splitDragging()} />
                }</Each>
                : <WebView
                  accessibilityLabel="file-pdf-view"
                  html={pdfDocumentHtml(encoded(), palette().canvas)}
                  javaScriptEnabled={false}
                  incognito={true}
                  style={{ flex: 1, minHeight: 0, minWidth: 0, pointerEvents: splitDragging() ? "none" : "auto" }}
                  onError={() =>
                    openFile.update(current =>
                      current && current.path === file().path ? { ...current, content: "" } : current,
                    )
                  }
                />}
            </If>
          </If>
          <If
            when={
              (file().kind === "code" && !htmlPreviewing()) ||
              markdownMode() === "source" ||
              file().kind === "text"
            }
          >
            <SourceEditorPane file={file()} compact={props.compact} showNotice={markdownMode() === "source"} />
          </If>
          <If when={file().kind === "image"}>
            <View
              style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
              }}
            >
              <Each of={[editorDocumentKey()]} key={key => key}>
                {() => {
                  const view = createImageViewState();
                  return <ImageViewerSurface
                  src={() => file().content}
                  imageAccessibilityLabel={() => file().name}
                  fileName={file().name}
                  view={view}
                  padding={props.compact ? space.md : space.xl}
                  onError={message =>
                    fileNotice.set(
                      tr("files.cannotShowImage", {
                        name: file().name,
                        error: localizeHostError(message),
                      }),
                    )
                  }
                  />;
                }}
              </Each>
            </View>
          </If>
          <If when={file().kind === "video"}>
            <View style={{ flex: 1, minHeight: 0, minWidth: 0, padding: props.compact ? space.md : space.xxl }}>
              <Video src={file().content} controls={true} muted={true} style={{ flex: 1 }} />
            </View>
          </If>
          <If when={file().kind === "binary"}>
            <View
              style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                padding: props.compact ? space.lg : space.xxl,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <QuietEmptyPrompt
                icon="file"
                title={file().name}
                subtitle={file().note ? localizeHostError(file().note!) : tr("files.binaryNoPreview")}
              />
            </View>
          </If>
        </View>
      )}
    </If>
  );
}

/**
 * Preview | (Split) | Source for Markdown, Preview | Source for HTML.
 * In the header on a wide pane; in the path strip under it on a narrow one, so Save keeps its room.
 */
function DocumentModeTabs(props: { narrow?: boolean }) {
  return (
    <If when={openFile()}>
      {file => (
        <>
          <If when={file().kind === "markdown"}>
            <View style={{ flexDirection: "row", gap: space.xs, alignItems: "center" }}>
              <SegmentedTabs
                size="sm"
                options={[
                  { value: "preview", label: tr("files.preview"), accessibilityLabel: "file-preview" },
                  ...(canSplitMarkdown(Boolean(props.narrow))
                    ? [{ value: "split", label: tr("doc.split"), accessibilityLabel: "file-split" }]
                    : []),
                  {
                    value: "source",
                    label: file().large && editingContent() === null ? tr("files.editAnyway") : tr("doc.source"),
                    accessibilityLabel: "file-source",
                  },
                ]}
                value={markdownMode() === "split" ? "split" : markdownMode() === "source" ? "source" : "preview"}
                onChange={value => {
                  if (value === "split") enterMarkdownSplit(file().path);
                  else if (value === "source") enterMarkdownSource(file().path);
                  else setMarkdownTab(file().path, "preview");
                }}
              />
              <IconButton icon="copy" size="sm" tooltip={tr("doc.copyMarkdown")}
                accessibilityLabel="file-copy-markdown"
                onPress={() => void copyDocumentMarkdown(editingContent() ?? file().content)} />
            </View>
          </If>
          <If when={file().kind === "code" && isHtmlFile(file().path) && documentWebViewsAvailable() === true}>
            <SegmentedTabs
              size="sm"
              options={[
                { value: "preview", label: tr("files.preview"), accessibilityLabel: "file-html-preview" },
                { value: "source", label: tr("doc.source"), accessibilityLabel: "file-html-source" },
              ]}
              value={htmlPreviewing() ? "preview" : "source"}
              onChange={value => setHtmlPreview(file().path, value === "preview")}
            />
          </If>
        </>
      )}
    </If>
  );
}

function Preview(props: { compact?: boolean; stacked?: boolean; onBack?: () => void }) {
  const docMenuOpen = signal(false);
  const docMenuAnchor = signal<ViewRef | null>(null);
  let lastDocMenuPath: string | null = null;
  effect(() => {
    const path = openFile()?.path ?? null;
    untracked(() => {
      if (path === lastDocMenuPath) return;
      lastDocMenuPath = path;
      docMenuOpen.set(false);
    });
  });

  // Width-driven: stacked (< 600px) uses single-pane back+tabs; wide uses side-by-side explorer | preview.
  const narrow = () => Boolean(props.stacked);
  return (
    <View
      onLayout={event => {
        const nextW = Math.round(event.bounds.size.width);
        if (nextW > 0 && nextW !== untracked(() => previewPaneWidth())) previewPaneWidth.set(nextW);
      }}
      style={{
        flex: 1,
        flexShrink: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        flexDirection: "column",
        backgroundColor: palette().canvas,
      }}
    >
      <View
        style={{
          height: compactLayout() ? WORKBENCH_TOUCH_MIN : 36,
          paddingLeft: props.stacked ? 0 : space.xs,
          paddingRight: space.sm,
          flexDirection: "row",
          alignItems: "stretch",
          gap: 0,
          flexShrink: 0,
          borderBottomWidth: 1,
          borderColor: palette().borderSubtle,
          backgroundColor: palette().canvas,
        }}
      >
        <If
          when={Boolean(props.stacked)}
          else={
            <View
              style={{
                paddingRight: space.xs,
                justifyContent: "center",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              <IconButton
                icon="panel-left"
                size="xs"
                active={explorerOpen()}
                tooltip={tr("files.toggleExplorer")}
                accessibilityLabel="explorer-toggle"
                onPress={() => explorerOpen.set(!explorerOpen())}
              />
            </View>
          }
        >
          <StackBackButton
            label={tr("files.explorer")}
            accessibilityLabel="files-stack-back"
            flush={true}
            onPress={() => props.onBack?.()}
          />
        </If>
        <OpenFileTabStrip compact={narrow()} />
        <If when={openFile()}>
          {file => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingLeft: space.xs, flexShrink: 0 }}>
                <If when={!narrow() && hasSourceEditor() && !latexPreviewOnly()}>
                  <IconButton
                    icon="search"
                    size="sm"
                    active={findOpen()}
                    tooltip={tr("files.findPlaceholder")}
                    accessibilityLabel="file-find-open"
                    onPress={openFind}
                  />
                </If>
                <If when={!narrow() && file().kind === "diff"}>
                  <IconButton
                    icon={fileDiffLayout() === "split" ? "list" : "panel-right"}
                    size="sm"
                    active={fileDiffLayout() === "split"}
                    tooltip={
                      fileDiffLayout() === "split" ? tr("files.diffUnified") : tr("files.diffSplit")
                    }
                    accessibilityLabel="file-diff-layout"
                    onPress={() =>
                      fileDiffLayout.set(fileDiffLayout() === "split" ? "unified" : "split")
                    }
                  />
                </If>
                <If when={file().kind === "diff"}>
                  <Button
                    label={tr("files.openFile")}
                    accessibilityLabel="file-view-source"
                    variant="ghost"
                    size="xs"
                    onPress={() => void openFileAt(file().path)}
                  />
                </If>
                <If when={isEditableKind(file().kind) && !hasUnsavedEdit()}>
                  <If when={Boolean(gitChanges()[file().path])}>
                    <Button
                      label={tr("files.viewDiff")}
                      accessibilityLabel="file-view-diff"
                      variant="ghost"
                      size="xs"
                      onPress={() => void openDiffReview(file().path)}
                    />
                  </If>
                  <If when={editingContent() === null && file().kind !== "markdown"}>
                    <Button
                      label={file().large ? tr("files.editAnyway") : tr("files.editFile")}
                      accessibilityLabel="file-edit"
                      variant="ghost"
                      size="xs"
                      leadingIcon="edit"
                      onPress={() => beginEditFile()}
                    />
                  </If>
                </If>
                <If when={!narrow()}>
                  <DocumentModeTabs narrow={false} />
                </If>
                <If when={file().kind === "markdown"}>
                  <If when={docMenuItems(narrow()).length > 0}>
                    <View ref={el => docMenuAnchor.set(el)} style={{ flexShrink: 0 }}>
                      <IconButton
                        icon="more"
                        size="sm"
                        active={docMenuOpen()}
                        tooltip={tr("doc.moreActions")}
                        accessibilityLabel="file-doc-menu"
                        onPress={() => docMenuOpen.set(!docMenuOpen())}
                      />
                    </View>
                    <DropdownMenu
                      open={docMenuOpen()}
                      anchor={docMenuAnchor()}
                      align="end"
                      minWidth={200}
                      items={docMenuItems(narrow())}
                      onClose={() => docMenuOpen.set(false)}
                    />
                  </If>
                </If>
                <If when={file().kind === "code" && isHtmlFile(file().path) && canOpenInSystemBrowser()}>
                  <Button
                    label={tr("doc.openInBrowser")}
                    accessibilityLabel="file-open-in-browser"
                    variant="ghost"
                    size="xs"
                    leadingIcon="external-link"
                    onPress={() => void openHtmlInSystemBrowser(file().path)}
                  />
                </If>
                <If when={isEditableKind(file().kind) && hasUnsavedEdit()}>
                  <If
                    when={narrow()}
                    else={
                      <Button
                        label={tr("files.discardEdit")}
                        accessibilityLabel="file-discard"
                        variant="ghost"
                        size="xs"
                        disabled={fileSaving()}
                        onPress={() => cancelEditFile()}
                      />
                    }
                  >
                    <IconButton
                      icon="undo"
                      size="sm"
                      tooltip={tr("files.discardEdit")}
                      accessibilityLabel="file-discard"
                      disabled={fileSaving()}
                      onPress={() => cancelEditFile()}
                    />
                  </If>
                  <Button
                    label={fileSaving() ? tr("common.saving") : tr("files.saveFile")}
                    accessibilityLabel="file-save"
                    variant="primary"
                    size="xs"
                    loading={fileSaving()}
                    tooltip={tr("files.saveShortcut", { keys: keymap.label("mod+s") })}
                    onPress={() => void saveEditedFile()}
                  />
                </If>
              </View>
            )}
          </If>
      </View>

      {/* Slim breadcrumb + edit-state + language strip (shown only when a file is open) */}
      <If when={openFile()}>
        {file => (
          <View
            style={{
              minHeight: 28,
              paddingHorizontal: narrow() ? space.md : space.lg,
              paddingVertical: space.xs,
              flexDirection: "row",
              flexWrap: narrow() ? "wrap" : "nowrap",
              alignItems: "center",
              gap: space.sm,
              borderBottomWidth: 1,
              borderColor: palette().borderSubtle,
              backgroundColor: palette().canvas,
              ...paintTransition(MOTION_DURATION.fast),
            }}
          >
            <Scroll smoothWheel horizontal style={{ flex: 1, minWidth: 120 }} scrollbar={false}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                <Each of={buildBreadcrumbs(file().path, activeWorkspaceRoot())} key={seg => seg.path}>
                  {(seg, index) => (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
                      <If when={index() > 0}>
                        <Icon name="chevron-right" size={12} color={palette().textMuted} />
                      </If>
                      <View
                        role={seg().isLast ? undefined : "button"}
                        tooltip={
                          relativeDisplayPath(seg().path, activeWorkspaceRoot()) !== seg().label ? (
                            <TooltipBubble
                              text={relativeDisplayPath(seg().path, activeWorkspaceRoot())}
                            />
                          ) : undefined
                        }
                        hitSlop={seg().isLast ? undefined : touchSlop(24)}
                        onPress={
                          seg().isLast
                            ? undefined
                            : () => {
                                selectedPath.set(seg().path);
                                void setExpanded(seg().path, true);
                              }
                        }
                        style={{
                          paddingHorizontal: space.xs,
                          paddingVertical: 2,
                          borderRadius: radii.xs,
                          borderCurve: "continuous",
                          backgroundColor: seg().isLast ? palette().surfaceSubtle : "transparent",
                          cursor: seg().isLast ? "default" : "pointer",
                          userSelect: "none",
                          ...pressTransition(MOTION_DURATION.fast),
                        }}
                        hoverStyle={
                          seg().isLast ? undefined : { backgroundColor: palette().panelHover }
                        }
                        activeStyle={seg().isLast ? undefined : tactileActiveStyle(0.97)}
                        focusVisibleStyle={seg().isLast ? undefined : focusRingStyle()}
                      >
                        <Text
                          style={{
                            maxWidth: props.compact ? 110 : 180,
                            ...textStyle("caption", {
                              color: seg().isLast ? palette().text : palette().textMuted,
                            }),
                            fontWeight: seg().isLast ? "600" : "400",
                            numberOfLines: 1,
                            textOverflow: "ellipsis-middle",
                          }}
                        >
                          {seg().label}
                        </Text>
                      </View>
                    </View>
                  )}
                </Each>
              </View>
            </Scroll>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 0 }}>
              <If when={hasUnsavedEdit()}>
                <Text
                  style={{
                    ...textStyle("caption", { color: palette().warning }),
                    fontWeight: "600",
                    flexShrink: 0,
                  }}
                >
                  {tr("files.unsavedChanges")}
                </Text>
              </If>
              <If when={file().kind === "diff" && Boolean(file().content.trim())}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
                  <Text style={{ ...textStyle("mono", { color: palette().textMuted, tabular: true }) }}>
                    {`+${formatCount(openFileDiffStats().added)}`}
                  </Text>
                  <Text style={{ ...textStyle("mono", { color: palette().textMuted, tabular: true }) }}>
                    {`-${formatCount(openFileDiffStats().deleted)}`}
                  </Text>
                </View>
              </If>
              <If when={gitChanges()[file().path]?.letter ?? ""}>
                {letter => (
                  <Text
                    style={{
                      ...textStyle("mono", { color: decorationColor(letter()) }),
                      fontWeight: "600",
                    }}
                  >
                    {letter()}
                  </Text>
                )}
              </If>
              <IconButton
                icon="copy"
                size="xs"
                iconSize={12}
                tooltip={tr("pane.files.copyPath")}
                accessibilityLabel="file-copy-path"
                onPress={() => void copyText(file().path)}
              />
              <If
                when={narrow() && (file().kind === "markdown" || (file().kind === "code" && isHtmlFile(file().path)))}
                else={
                  <Text
                    style={{
                      ...textStyle("caption", { color: palette().textMuted }),
                      flexShrink: 0,
                    }}
                  >
                    {file().kind === "diff"
                      ? tr("files.diffTab")
                      : editorRef() ? editorLanguageLabel(sourceEditorLanguage())
                        : inferCodeLanguage(file().path) || file().language || file().kind}
                  </Text>
                }
              >
                <DocumentModeTabs narrow={true} />
              </If>
            </View>
          </View>
        )}
      </If>

      <FileAttentionBars compact={narrow()} />
      <PreviewBody compact={narrow()} />
      <If when={openFile() && openFile()?.kind !== "image" && openFile()?.kind !== "pdf" && !latexPreviewOnly() &&
        (!narrow() || editorRef() || canReopenWithEncoding())}>
        <EditorStatusBar compact={narrow()} />
      </If>
    </View>
  );
}

export function FilesScene(props: { compact?: boolean } = {}) {
  const sceneWidth = createSceneWidth();
  /** Stacked (narrow) layout: the preview is pushed over the explorer. */
  const filesStackDetail = signal(false);
  let lastStackedPath: string | null = null;
  const scopeDevice = () => fleetDeviceById(deviceContext());
  const deviceOffline = () => deviceException(scopeDevice()?.state) === "offline";
  const deviceLabel = () => scopeDevice()?.name || tr("device.thisDevice");

  effect(() => {
    deviceContext();
    savedEditorSettings();
    void refreshFileEditorConfig();
  });

  // Drop per-file Markdown tab/override entries once their tabs close.
  effect(() => {
    const open = new Set(openFilePaths().map(markdownSourceKey));
    untracked(() => {
      markdownTabByPath.update(current => {
        const keys = Object.keys(current);
        if (keys.every(k => open.has(k))) return current;
        const next: Record<string, MarkdownTab> = {};
        for (const k of keys) if (open.has(k)) next[k] = current[k];
        return next;
      });
      markdownForceVisualPaths.update(current => {
        const keys = Object.keys(current);
        if (keys.every(k => open.has(k))) return current;
        const next: Record<string, true> = {};
        for (const k of keys) if (open.has(k)) next[k] = true;
        return next;
      });
    });
  });
  // Opening another file (a tree row, a tab, a search hit, a changed file, the
  // aux pane request) pushes the preview in the stacked layout.
  effect(() => {
    const path = openFile()?.path ?? null;
    untracked(() => {
      if (path && path !== lastStackedPath) filesStackDetail.set(true);
      lastStackedPath = path;
    });
  });
  effect(() => {
    const root = activeWorkspaceRoot();
    if (!root || dirChildren()[root]) return;
    void loadRoot();
  });

  effect(() => {
    const edit = pendingEdit();
    editValue.set(edit?.value ?? "");
  });

  // Live updates: the host watcher for this root, and the Git decorations the
  // host pushes while this scene is on screen.
  effect(() => {
    if (!activeWorkspace()) return;
    untracked(() => ensureWorkspaceWatch());
  });
  cleanup(holdFilesStatusWatch());

  const unbindSave = keymap.bind("mod+s", () => {
    if (hasUnsavedEdit()) void saveEditedFile();
    void saveOpenPdfReviews();
  });
  const unbindFind = !props.compact ? keymap.bind("mod+f", () => openFind()) : null;
  cleanup(() => {
    unbindSave();
    unbindFind?.();
  });

  // Search starts at the rendered document, then reveals in the editor that
  // can address the hit (Markdown plan metadata lives in the original source).
  effect(() => {
    const target = pendingRevealLine();
    if (!target) return;
    const file = openFile();
    if (!activeRevealLine() || !file ||
        (file.kind !== "markdown" && file.kind !== "code" && file.kind !== "text")) {
      pendingRevealLine.set(null);
      return;
    }
    const mode = markdownMode();
    if (file.kind === "markdown") {
      if (mode !== "source" && isPlanDocument(file.path)) {
        untracked(() => selectMarkdownMode("source"));
        return;
      }
      if (mode === "preview") {
        untracked(() => selectMarkdownMode(
          file.large ? "source" : "visual",
        ));
        return;
      }
      if (mode === "visual") return;
    }
    if (htmlPreviewing()) {
      untracked(() => setHtmlPreview(file.path, false));
      return;
    }
    const latex = activeFileEditorOptions()?.latex;
    if (latex?.mode === "preview") {
      untracked(() => setActiveFileEditorOptions({ latex: { ...latex, mode: "split" } }));
      return;
    }
    const ref = editorRef();
    if (!ref) return;
    // The source widget may reuse a ref while its value changes between tabs.
    const frame = requestAnimationFrame(() => {
      if (activeRevealLine() !== target || editorRef() !== ref) return;
      const position = { line: Math.max(0, target.line - 1), column: 0 };
      ref.setSelections([{ anchor: position, head: position }]);
      ref.revealPosition(position, true);
      pendingRevealLine.set(null);
    });
    cleanup(() => cancelAnimationFrame(frame));
  });

  effect(() => {
    const requested = auxSelectedFilePath();
    if (!requested) return;
    if (openFile()?.path !== requested) {
      void openFileAt(requested);
    }
    auxSelectedFilePath.set(null);
  });

  return (
    <View
      onLayout={sceneWidth.onLayout}
      style={{ flex: 1, minHeight: 0, minWidth: 0, flexDirection: "column", backgroundColor: palette().canvas }}
    >
      <If when={!props.compact}>
        <ToolPaneHeader />
      </If>
      <RemoteWorkspaceStatusBanner compact={props.compact} />
      <If when={deviceOffline()}>
        <View style={{ paddingHorizontal: props.compact ? space.sm : space.md, paddingTop: space.sm }}>
          <InlineBanner
            tone="warning"
            message={tr("pane.terminal.offline", { device: deviceLabel() })}
          />
        </View>
      </If>
      <If when={fileNotice()}>
        {notice => (
          <View
            accessibilityLabel="file-notice-banner"
            style={{
              paddingHorizontal: props.compact ? space.sm : space.md,
              paddingTop: space.sm,
            }}
          >
            <InlineBanner
              tone="info"
              message={localizeHostError(notice())}
              onDismiss={() => fileNotice.set("")}
            />
          </View>
        )}
      </If>
      {/* Width-driven: narrow (< 600px) stacks list -> detail; wide (>= 600px, incl. bottom dock) renders side-by-side. */}
      <If
        when={sceneWidth.stacked()}
        else={
          <View
            style={{
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              flexDirection: "row",
              backgroundColor: palette().canvas,
            }}
          >
            <If when={explorerOpen()}>
              <FileTree
                compact={props.compact}
                width={props.compact ? Math.min(explorerWidth(), 240) : explorerWidth()}
                onOpenDetail={() => filesStackDetail.set(true)}
              />
            </If>
            <If when={explorerOpen()}>
              <SplitHandle
                accessibilityLabel="Resize explorer pane"
                onReset={() => explorerWidth.set(props.compact ? 236 : 260)}
                onDelta={dx =>
                  explorerWidth.update(w =>
                    Math.max(EXPLORER_MIN_WIDTH, Math.min(EXPLORER_MAX_WIDTH, w + dx)),
                  )
                }
              />
            </If>
            <Preview compact={props.compact} />
          </View>
        }
      >
        <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: palette().canvas }}>
          <If
            when={filesStackDetail() && Boolean(openFile())}
            else={
              <FileTree
                compact={props.compact}
                width={explorerWidth()}
                stacked={true}
                onOpenDetail={() => filesStackDetail.set(true)}
              />
            }
          >
            <Preview
              compact={props.compact}
              stacked={true}
              onBack={() => filesStackDetail.set(false)}
            />
          </If>
        </View>
      </If>
    </View>
  );
}
