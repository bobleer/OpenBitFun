import {
  cleanup,
  Clipboard,
  computed,
  effect,
  ErrorBoundary,
  keymap,
  lifecycle,
  mount,
  Overlay,
  PanResponder,
  reduceMotion,
  safeArea,
  Scroll,
  signal,
  Text,
  View,
  type JSX,
  type Point,
  type PressEvent,
  type ScrollRef,
  type ViewRef,
  untracked,
} from "nsh";
import {
  backendConnection,
  closeWindow,
  connectionError,
  connectionState,
  entryDeviceId,
  fleetActive,
  fleetHandshakePending,
  hideMainWindowAfterCloseRequest,
  inAppUpdatesAvailable,
  initWindowChrome,
  invokeCommand,
  listenEvent,
  minimizeMainWindowToTray,
  minimizeWindow,
  nativeWindow,
  onMainWindowCloseRequest,
  openHostEventChannel,
  pageDrawsWindowControls,
  pickLocalDirectory,
  quitApplication,
  settleFleetHandshake,
  shellMenuShortcutIds,
  startShellIntegration,
  startWindowDrag,
  toggleWindowFullscreen,
  toggleWindowMaximize,
  trafficLightInsetPx,
  usesNativeDragRegions,
  windowControlsRightInsetPx,
  windowMaximized,
  windowPlatform,
  windowShellId,
} from "./src/bridge";
import { CaptionActionStrip, SceneCaptionInset } from "./src/ui/titleBar";
import { installSystemBack } from "./src/navigationHistory";
import { subscribeAgentEvents } from "./src/agentEvents";
import { installBackendResync } from "./src/backendResync";
import { installControlPresenter, presentControlTarget, resolveControlDestination,
  type ControlDestination, type ControlPresenterActions } from "./src/controlPresenter";
import { capabilitySearchItems } from "./src/capabilitySearch";
import { installServedBackend } from "./src/servedBackend";
import { controllerPort } from "./src/controller/controllerPort";
import { SessionActionDialogs } from "./src/ui/sessionActions";
import { WorkspaceActionDialogs } from "./src/ui/workspaceActions";
import {
  applyControllerUiUpdate,
  controllerUiUpdate,
  controllerUiUpdating,
  dismissControllerUiUpdate,
  signOutController,
} from "./src/controller/controllerStore";
import { ControllerShell } from "./src/controller/ControllerShell";
import { loadLocalDeviceId, localDeviceId } from "./src/devicePrefsStore";
import { basename } from "./src/format";
import {
  isAuthRequiredError,
  localizeHostError,
  tr,
  type MessageKey,
} from "./src/i18n";
import { accountDisplay } from "./src/accountDisplay";
import {
  accountStatus,
  isAccountSignedIn,
  loadAccountState,
  signOutAccount,
} from "./src/homeStore";
import { pendingPermissions, startPermissionPrompts } from "./src/permissionStore";
import { startQuestionPrompts } from "./src/userQuestionStore";
import { loadBtwClosePreference, sideQuestionOpen } from "./src/btwStore";
import {
  activeScene,
  activeSessionId,
  activeWorkspace,
  AUX_DEFAULT_HEIGHT,
  AUX_DEFAULT_WIDTH,
  AUX_MAX_HEIGHT,
  AUX_MAX_WIDTH,
  AUX_MIN_HEIGHT,
  AUX_MIN_WIDTH,
  auxPaneDisplayMode,
  auxPaneHeight,
  auxPaneMaximized,
  auxPaneOpen,
  auxPaneOverlayWidth,
  auxPaneSide,
  auxPaneTab,
  auxPaneWidth,
  canGoBack,
  canGoForward,
  clearError,
  closeSceneTab,
  collapsedWorkspaces,
  deleteSessionRow,
  deviceContext,
  drawerOpen,
  goBackScene,
  goForwardScene,
  initAppLocale,
  lastError,
  forgetRecentWorkspace,
  loadMoreSessions,
  loadShellLayout,
  loadWorkspaces,
  NAV_COLLAPSE_WIDTH,
  NAV_DEFAULT_WIDTH,
  navWidth,
  navigateScene,
  openInAuxPane,
  openPathWorkspace,
  openRecentWorkspace,
  openSceneTabs,
  flushShellLayout,
  persistShellLayout,
  recentWorkspaces,
  renameSession,
  runningTurns,
  selectSession,
  sessionGrouping,
  sessionHasMore,
  sessionTotal,
  splitPaneOpen,
  setAuxPaneHeight,
  setAuxPaneMaximized,
  setAuxPaneOverlayWidth,
  setAuxPaneSide,
  setAuxPaneWidth,
  setNavWidth,
  SESSION_PANE_MIN_WIDTH,
  swapAuxPanes,
  toggleAuxDockBottom,
  toggleAuxPane,
  toggleDrawer,
  workspaces,
  workspacesLoaded,
  type AuxPaneSide,
  type AuxPaneTab,
  type SceneId,
  resolveSceneAlias,
  landingScene,
  navHistory,
  resetNavigation,
} from "./src/state";
import {
  APPEARANCE_PRESETS,
  SurfaceContext,
  appearanceId,
  appearanceMode,
  concentricRadius,
  controlHeight,
  elevationShadow,
  fontMono,
  fontSans,
  inputFontSans,
  isLightAppearance,
  palette,
  radii,
  resolvedScheme,
  selectAppearancePreset,
  syncGlobalNativeTheme,
  textLineHeight,
  textSize,
  textTracking,
  type AppearanceId,
  compactLayout,
  layout,
  space,
  textStyle,
  touchSlop,
} from "./src/theme";
import { applyAppearance, loadAppearance, syncAppearanceFromHost } from "./src/themeStore";
import { loadFontPreference } from "./src/fontPreferenceStore";
import { loadContentWidth, syncContentWidthFromHost } from "./src/contentWidthStore";
import { initAccountSync } from "./src/accountSyncStore";
// wave24-replica: account records (agents, skills, routines, cards, pets, ...).
import { initAccountRecords } from "./src/accountRecordsStore";
import { keybindingOverrides, keystrokeReservedHere, loadKeybindings } from "./src/shortcutsStore"; // wave22-p5
import { closeSpacePage, installSpaceAgentSurface } from "./src/spaceViewStore"; // wave22-p4
import { ensureSendPolicy } from "./src/sendPolicyStore";
import { ensureQuickActions } from "./src/quickActionStore";
import { statusOfSession } from "./src/sessionStatusStore";

import { openFileAt } from "./src/fileStore";
import {
  listSessions,
  type SessionSummary,
  type WorkspaceRecord,
} from "./src/api";
import {
  closeGlobalSearch,
  openGlobalSearch,
  runSearchItem,
  searchOpen,
  type SearchItem,
} from "./src/globalSearchStore";
import {
  activeRemoteWorkspace,
  loadSavedConnections,
  openNewWorkspaceModal,
  quickConnectSavedConnection,
  savedConnections,
} from "./src/sshRemoteStore";
import { Icon, type IconName } from "./src/ui/icons";
import { GlobalSearchPanel } from "./src/ui/GlobalSearchPanel";
import { ImageLightboxHost } from "./src/ui/ImageLightbox";
import {
  MOTION_DURATION,
  SmoothSwap,
  drawerEnterMotion,
  paintTransition,
  pressTransition,
  tactileActiveStyle,
} from "./src/ui/motion";
import {
  ContextMenuOverlay,
  DropdownMenu,
  ModalDialog,
  ToastHost,
  pushToast,
  registerEscapeDismiss,
  type DropdownMenuItem,
} from "./src/ui/overlays";
import {
  Badge,
  Button,
  IconButton,
  InlineBanner,
  KbdHint,
  SplitHandle,
  StatusDot,
  TooltipBubble,
  focusRingStyle,
} from "./src/ui/primitives";
import {
  AccountAuthModal,
  onAccountAuthChanged,
  openAccountAuthModal,
} from "./src/ui/AccountAuthModal";
import { RemoteDisclaimerModal } from "./src/ui/RemoteDisclaimerModal";
import { SshWorkspaceModals } from "./src/ui/SshWorkspaceModals";
import { AboutDialog, installAboutUpdates, openAboutDialog } from "./src/ui/AboutDialog";
import {
  clearNotifications,
  markAllNotificationsRead,
  notifications,
  startNotifications,
  unreadNotificationCount,
} from "./src/notificationStore";
import { OpenBitFunScene } from "./src/scenes/OpenBitFunScene";
import { SessionsScene, SideQuestionCloseDialog } from "./src/scenes/SessionsScene";
import { InboxScene, InboxSheet } from "./src/scenes/InboxScene";
import { SessionListScene } from "./src/scenes/SessionListScene";
import { DeviceActionDialogs } from "./src/deviceActions";
import { LibraryScene, LibraryScopeChip } from "./src/scenes/LibraryScene";
import { ConversationHistory, BitMatrixGlyph } from "./src/ui/jobs";
import {
  activeConversationId,
  newConversation,
  openConversation,
  startSuperagentStore,
  superagentPhase,
  superagentStatus,
} from "./src/superagentStore";
import { inboxSheetOpen, startAttentionStore, toggleInboxSheet } from "./src/attentionStore";
import { inboxBadgeCount } from "./src/localInboxStore";
import { fleetUnavailable } from "./src/fleetStore";
import { InboxCountPill, PhoneTabBar, type PhoneTab } from "./src/ui/fleet";
import { FilesScene } from "./src/scenes/FilesScene";
import { GitScene } from "./src/scenes/GitScene";
import { TerminalScene } from "./src/scenes/TerminalScene";
import { BrowserPageLayer, BrowserScene } from "./src/scenes/BrowserScene";
import {
  canOpenSettingsSearchTarget,
  findSettingsHits,
  requestSettingsPage,
  SettingsScene,
} from "./src/scenes/SettingsScene";
import type { SettingsPageId } from "./src/settingsStore";
// wave23-E: Super Agent gated off; the sidebar is the account's device → workspace → session tree.
import { superAgentUi } from "./src/productGates";
import { DeviceSidebarTree } from "./src/ui/deviceSidebar";
import { SidebarRow } from "./src/ui/SidebarRow";
import { SpaceShortcuts, spaceShortcutActive } from "./src/ui/SpaceShortcuts";
import { newSessionHere } from "./src/deviceTree";

// A page served by a backend connects back to it over OBP (before any command runs).
installServedBackend();
openHostEventChannel();
subscribeAgentEvents();
installBackendResync();

function shortcutLabel(chord: string, fallback: string): string {
  // A key the browser keeps never reaches the page: no hint promises it.
  if (keystrokeReservedHere(chord)) return "";
  try {
    return keymap.label(chord) || fallback;
  } catch {
    return fallback;
  }
}

interface SceneMeta {
  labelKey: MessageKey;
  icon: IconName;
}

const SCENE_META: Record<SceneId, SceneMeta> = {
  openbitfun: { labelKey: "nav.superAgent", icon: "sparkles" },
  inbox: { labelKey: "nav.inbox", icon: "inbox" },
  "all-sessions": { labelKey: "nav.sessions", icon: "layers" },
  device: { labelKey: "nav.sessions", icon: "laptop" },
  library: { labelKey: "nav.library", icon: "package" },
  home: { labelKey: "nav.superAgent", icon: "home" },
  sessions: { labelKey: "nav.sessions", icon: "chat" },
  assistants: { labelKey: "nav.assistants", icon: "bot" },
  agents: { labelKey: "nav.agents", icon: "cpu" },
  skills: { labelKey: "nav.skills", icon: "sparkles" },
  routines: { labelKey: "nav.routines", icon: "calendar" },
  spaces: { labelKey: "nav.spaces", icon: "shapes" },
  files: { labelKey: "nav.files", icon: "folder" },
  git: { labelKey: "nav.git", icon: "git-branch" },
  terminal: { labelKey: "nav.terminal", icon: "terminal-square" },
  browser: { labelKey: "nav.browser", icon: "globe" },
  devices: { labelKey: "nav.devices", icon: "link" },
  settings: { labelKey: "nav.settings", icon: "settings" },
};

const PRESET_LABEL_KEYS: Record<AppearanceId, MessageKey> = {
  "openbitfun-dark": "settings.appearance.presetDark",
  "openbitfun-light": "settings.appearance.presetLight",
  "openbitfun-monochrome": "settings.appearance.presetMonochrome",
  "openbitfun-slate": "settings.appearance.presetSlate",
  "openbitfun-midnight": "settings.appearance.presetMidnight",
  "openbitfun-china-style": "settings.appearance.presetChinaStyle",
  "openbitfun-china-night": "settings.appearance.presetChinaNight",
  "openbitfun-cyber": "settings.appearance.presetCyber",
  "openbitfun-tokyo-night": "settings.appearance.presetTokyoNight",
};

const PRIMARY_NAV_SCENES: ReadonlyArray<SceneId> = ["home", "sessions", "assistants"];
const STUDIO_ONLY_SCENES: ReadonlyArray<SceneId> = ["agents", "skills", "routines", "spaces"];
const WORKBENCH_NAV_SCENES: ReadonlyArray<SceneId> = ["files", "git", "terminal", "browser"];

/** The inspector's text tabs (visual spec §4.10): Changes, Files, Terminal, Browser (wave 22). */
const AUX_TABS: ReadonlyArray<{ id: AuxPaneTab; labelKey: MessageKey; scene: SceneId }> = [
  { id: "git", labelKey: "tools.changes", scene: "git" },
  { id: "files", labelKey: "tools.files", scene: "files" },
  { id: "terminal", labelKey: "tools.terminal", scene: "terminal" },
  { id: "browser", labelKey: "tools.browser", scene: "browser" },
];

interface SearchCommandDef {
  id: string;
  target: SceneId | "";
  aliases: ReadonlyArray<string>;
  labelKey: MessageKey;
  detailKey: MessageKey;
}

const SEARCH_COMMANDS: ReadonlyArray<SearchCommandDef> = [
  {
    id: "command:open-project", target: "", aliases: ["open project", "open folder"],
    labelKey: "search.actionOpenProject", detailKey: "search.actionOpenProjectDetail",
  },
  {
    id: "command:new-project", target: "", aliases: ["new project", "create project", "new workspace"],
    labelKey: "search.actionNewProject", detailKey: "search.actionNewProjectDetail",
  },
  {
    id: "command:new-session",
    target: "",
    aliases: ["new session", "new", "create", "thread"],
    labelKey: "search.cmdNewSession",
    detailKey: "search.cmdNewSessionDetail",
  },
  {
    id: "command:home",
    target: "openbitfun",
    aliases: ["openbitfun", "super agent", "home", "conversation", "new conversation"],
    labelKey: "search.cmdOpenBitFun",
    detailKey: "search.cmdOpenBitFunDetail",
  },
  {
    id: "command:sessions",
    target: "all-sessions",
    aliases: ["sessions", "all sessions", "go to sessions", "chat"],
    labelKey: "search.cmdSessions",
    detailKey: "search.cmdSessionsDetail",
  },
  {
    id: "command:assistants",
    target: "assistants",
    aliases: ["assistants", "go to assistants", "persona"],
    labelKey: "search.cmdAssistants",
    detailKey: "search.cmdAssistantsDetail",
  },
  {
    id: "command:agents",
    target: "agents",
    aliases: ["agents", "go to agents", "bots", "subagents"],
    labelKey: "search.cmdAgents",
    detailKey: "search.cmdAgentsDetail",
  },
  {
    id: "command:skills",
    target: "skills",
    aliases: ["skills", "go to skills", "marketplace"],
    labelKey: "search.cmdSkills",
    detailKey: "search.cmdSkillsDetail",
  },
  {
    id: "command:routines",
    target: "routines",
    aliases: ["routines", "go to routines", "cron", "schedule"],
    labelKey: "search.cmdRoutines",
    detailKey: "search.cmdRoutinesDetail",
  },
  {
    id: "command:files",
    target: "files",
    aliases: ["files", "go to files", "explorer"],
    labelKey: "search.cmdFiles",
    detailKey: "search.cmdFilesDetail",
  },
  {
    id: "command:git",
    target: "git",
    aliases: ["git", "go to git", "source control", "diff"],
    labelKey: "search.cmdGit",
    detailKey: "search.cmdGitDetail",
  },
  {
    id: "command:terminal",
    target: "terminal",
    aliases: ["terminal", "go to terminal", "shell"],
    labelKey: "search.cmdTerminal",
    detailKey: "search.cmdTerminalDetail",
  },
  {
    id: "command:browser",
    target: "browser",
    aliases: ["browser", "go to browser", "web", "open browser"],
    labelKey: "search.cmdBrowser",
    detailKey: "search.cmdBrowserDetail",
  },
  {
    id: "command:spaces",
    target: "spaces",
    aliases: ["spaces", "go to spaces", "miniapps"],
    labelKey: "search.cmdSpaces",
    detailKey: "search.cmdSpacesDetail",
  },
  {
    id: "command:devices",
    target: "devices",
    aliases: ["devices", "go to devices", "by device", "remote"],
    labelKey: "search.cmdDevices",
    detailKey: "search.cmdDevicesDetail",
  },
  {
    id: "command:settings",
    target: "settings",
    aliases: ["settings", "go to settings", "preferences"],
    labelKey: "search.cmdSettings",
    detailKey: "search.cmdSettingsDetail",
  },
];

const studioGroupOpen = signal(true);
const appearanceMenuOpen = signal(false);
const appearanceTriggerRef = signal<ViewRef | null>(null);
const remoteMenuOpen = signal(false);
const remoteTriggerRef = signal<ViewRef | null>(null);
const deviceMenuOpen = signal(false);
const deviceTriggerRef = signal<ViewRef | null>(null);
const topbarWorkspaceMenuOpen = signal(false);
const topbarWorkspaceTriggerRef = signal<ViewRef | null>(null);
const workspaceActionMenuId = signal<string | null>(null);
const workspaceActionAnchor = signal<ViewRef | null>(null);
const workspaceContextPoint = signal<Point | null>(null);

const sessionActivityCount = computed(
  () => Object.keys(runningTurns()).length + pendingPermissions().length,
);

/**
 * Saved SSH hosts that are not already mounted in the Workspaces tree, avoiding
 * visually cloning an active remote workspace identically under SSH HOSTS.
 */
const unmountedSshHosts = computed(() => {
  const openConnectionIds = new Set(
    workspaces()
      .map(ws => ws.connectionId)
      .filter((id): id is string => Boolean(id)),
  );
  return savedConnections().filter(conn => !openConnectionIds.has(conn.id));
});

/** The width the sidebar drag has reached, beyond the clamp, while a drag runs. */
let navDragWidth: number | null = null;
const AUX_RESIZE_HANDLE_WIDTH = 9;

/** Re-reads this device's id and the account after a sign-in. */
function refreshAccountFacts(): void {
  void Promise.all([loadLocalDeviceId(), loadAccountState()]);
}

function handleTitlebarPressDown(event: PressEvent): void {
  if (event.clickCount >= 2) {
    toggleWindowMaximize();
    return;
  }
  startWindowDrag();
}

/**
 * How an empty stretch of a title bar moves the window. A native NSH window
 * declares the region (`desktop={{ windowDrag }}`: the system drags it and a
 * double click zooms); the Tauri webview starts the drag on the press.
 */
function titlebarDragRegionProps(): {
  desktop?: { windowDrag: boolean };
  onPressDown?: (event: PressEvent) => void;
} {
  if (!nativeWindow()) return {};
  return usesNativeDragRegions() ? { desktop: { windowDrag: true } } : { onPressDown: handleTitlebarPressDown };
}

/** The bar around those stretches: draggable where the system drags (its buttons stay pressable). */
function titlebarBarProps(): { desktop?: { windowDrag: boolean } } {
  return usesNativeDragRegions() ? { desktop: { windowDrag: true } } : {};
}

function toggleStudioGroup(): void {
  studioGroupOpen.update(open => !open);
}

function toggleWorkspaceCollapsed(workspaceId: string): void {
  collapsedWorkspaces.update(cur => ({
    ...cur,
    [workspaceId]: !cur[workspaceId],
  }));
}

function expandWorkspace(workspaceId: string): void {
  if (!collapsedWorkspaces()[workspaceId]) return;
  collapsedWorkspaces.update(cur => {
    const next = { ...cur };
    delete next[workspaceId];
    return next;
  });
}

function basenameLabel(rootPath: string, name?: string): string {
  if (name && name.trim()) return name.trim();
  // `basename` reads both separators: a Windows workspace is `C:\\work\\app`.
  return basename(rootPath) || rootPath || tr("nav.workspaceFallback");
}

function sessionDisplayTitle(session: { sessionId: string; sessionName?: string }): string {
  const title = session.sessionName?.trim();
  return title && title.length > 0 ? title : session.sessionId;
}

function isLocalhostHost(host?: string | null): boolean {
  const normalized = (host ?? "").trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

/**
 * Returns the real remote host label for a workspace, filtering out the
 * `"localhost"` sentinel that Rust `WorkspaceInfoDto` attaches to every local
 * and assistant workspace.
 */
function remoteSshHost(ws: {
  workspaceKind?: string;
  connectionId?: string;
  sshHost?: string;
}): string | undefined {
  const host = (ws.sshHost ?? "").trim();
  if (!host || isLocalhostHost(host)) return undefined;
  const kind = (ws.workspaceKind ?? "").trim().toLowerCase();
  if (kind === "assistant") return undefined;
  return host;
}

function isRemoteWorkspaceRecord(ws: {
  workspaceKind?: string;
  connectionId?: string;
  sshHost?: string;
}): boolean {
  const kind = (ws.workspaceKind ?? "").trim().toLowerCase();
  if (kind === "assistant") return false;
  return Boolean(
    ws.connectionId?.trim() ||
      remoteSshHost(ws) ||
      kind === "remote" ||
      kind.includes("ssh") ||
      kind.includes("remote") ||
      kind.includes("docker") ||
      kind.includes("container") ||
      kind.includes("wsl"),
  );
}

function workspaceKindIcon(ws: {
  workspaceKind?: string;
  connectionId?: string;
  sshHost?: string;
}): IconName {
  const kind = (ws.workspaceKind ?? "").trim().toLowerCase();
  if (kind === "assistant" || kind.includes("assistant")) return "bot";
  if (kind.includes("docker") || kind.includes("container")) return "container";
  if (kind.includes("wsl")) return "terminal";
  if (isRemoteWorkspaceRecord(ws)) return "server";
  return "folder";
}

function sceneGroupKey(): string {
  switch (activeScene()) {
    case "home":
    case "openbitfun":
      return superAgentUi() ? "openbitfun" : "sessions";
    case "inbox":
      return "inbox";
    case "all-sessions":
    case "devices":
    case "device":
      // The phone's session list; a wide window lists sessions in its sidebar.
      return compactShell() ? "all-sessions" : "sessions";
    case "library":
    case "assistants":
    case "agents":
    case "skills":
    case "routines":
    case "spaces":
      return "library";
    case "files":
      return "files";
    case "git":
      return "git";
    case "terminal":
      return "terminal";
    case "settings":
      return "settings";
    case "browser":
      return "browser";
    default:
      return "sessions";
  }
}

function sceneElementForGroup(group: string) {
  switch (group) {
    case "openbitfun":
      return <OpenBitFunScene />;
    case "inbox":
      return <InboxScene />;
    case "all-sessions":
      return <SessionListScene />;
    case "library":
      return <LibraryScene />;
    case "files":
      return <FilesScene />;
    case "git":
      return <GitScene />;
    case "terminal":
      return <TerminalScene />;
    case "settings":
      return <SettingsScene />;
    case "browser":
      return <BrowserScene />;
    default:
      return <SessionsScene overlayInset={sessionPanelOverlayInset} />;
  }
}

function auxElementForTab(tab: string) {
  switch (tab) {
    case "git":
      return <GitScene compact />;
    case "terminal":
      return <TerminalScene compact />;
    case "browser":
      return <BrowserScene compact />;
    default:
      return <FilesScene compact />;
  }
}

// ── Sidebar (visual spec §4.2 and §3 "Sidebar row", ux-redesign §3.5) ────────
// The sidebar holds conversations, not devices: OpenBitFun, Inbox and Search,
// the conversation history (UI-B's `ConversationHistory`), then All sessions,
// Library and the account row. Devices, versions and routes never appear here.

/** The sidebar's 44 title row: the traffic lights' inset, sidebar toggle, back and forward. */
function NavBar() {
  return (
    <View
      {...titlebarBarProps()}
      style={{
        height: layout.topBarHeight,
        flexShrink: 0,
        paddingLeft: trafficLightInsetPx() > 0 ? trafficLightInsetPx() : space.sm,
        paddingRight: space.sm,
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.hair, flexShrink: 0 }}>
        <IconButton
          icon="panel-left-close"
          size="sm"
          surface="chrome"
          accessibilityLabel="toggle-drawer"
          tooltip={<TooltipBubble text={tr("nav.toggleSidebar")} shortcut={shortcutLabel("mod+b", "⌘B")} />}
          onPress={toggleDrawer}
        />
        <IconButton
          icon="arrow-left"
          size="sm"
          surface="chrome"
          disabled={!canGoBack()}
          accessibilityLabel="nav-back"
          tooltip={tr("common.back")}
          onPress={goBackScene}
        />
        <IconButton
          icon="arrow-right"
          size="sm"
          surface="chrome"
          disabled={!canGoForward()}
          accessibilityLabel="nav-forward"
          tooltip={tr("common.forward")}
          onPress={goForwardScene}
        />
      </View>
      <View
        focusable={false}
        {...titlebarDragRegionProps()}
        style={{ flex: 1, minWidth: 0, height: "100%", cursor: "default" }}
      />
    </View>
  );
}

/** The name the account row shows: the backend's identity projection (`accountDisplay`), else "Sign in". */
function accountLabel(): string {
  const display = accountDisplay();
  if (!display.signedIn) return tr("nav.signIn");
  return display.identity?.displayName || tr("signin.signedIn");
}

function AccountAvatar(props: { size: number; testID?: string }) {
  const onChrome = () => SurfaceContext() === "chrome";
  return (
    <View
      testID={props.testID}
      style={{
        width: props.size,
        height: props.size,
        borderRadius: radii.pill,
        backgroundColor: onChrome() ? palette().chromeActive : palette().chip,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <If
        when={accountDisplay().identity?.initial ?? ""}
        else={
          <Icon
            name="user"
            size={Math.round(props.size * 0.6)}
            color={onChrome() ? palette().chromeTextMuted : palette().textMuted}
          />
        }
      >
        <Text
          style={{
            ...textStyle("micro", {
              color: onChrome() ? palette().chromeText : palette().text,
            }),
            fontVariant: undefined,
          }}
        >
          {accountDisplay().identity?.initial ?? ""}
        </Text>
      </If>
      {/* An update that is ready: a 6 px accent dot on the avatar, no banner. */}
      <If when={updatePhase() === "ready"}>
        <View
          accessibilityLabel="account-update-ready"
          style={{
            position: "absolute",
            right: -space.hair,
            top: -space.hair,
            width: space.chip,
            height: space.chip,
            borderRadius: radii.pill,
            backgroundColor: onChrome() ? palette().chromeAccent : palette().accent,
          }}
        />
      </If>
    </View>
  );
}

const accountMenuOpen = signal(false);
const accountMenuAnchor = signal<ViewRef | null>(null);

function accountMenuItems(): DropdownMenuItem[] {
  const items: DropdownMenuItem[] = [
    {
      id: "account-settings",
      label: tr("nav.settings"),
      icon: "settings",
      shortcut: shortcutLabel("mod+,", "⌘,"),
      accessibilityLabel: "account-menu-settings",
      onSelect: () => navigateScene("settings"),
    },
  ];
  if (updatePhase() === "ready") {
    items.push({
      id: "account-restart-update",
      label: tr("shell.restartToUpdate"),
      icon: "refresh",
      accessibilityLabel: "footer-update-install",
      onSelect: () => void installAppUpdate(),
    });
  } else if (inAppUpdatesAvailable()) {
    items.push({ ...updateMenuItem() });
  }
  items.push({
    id: "account-about",
    label: tr("shell.about.title"),
    icon: "info",
    accessibilityLabel: "footer-about",
    onSelect: () => openAboutDialog(),
  });
  items.push(
    controllerPort()
      ? {
          // A browser or phone signs out of the page's account, not the device's.
          id: "account-sign-out",
          label: tr("launcher.signOut"),
          icon: "log-out",
          separator: true,
          accessibilityLabel: "account-menu-sign-out",
          onSelect: () => void signOutController(),
        }
      : isAccountSignedIn()
      ? {
          id: "account-sign-out",
          label: tr("devices.signOut"),
          icon: "log-out",
          separator: true,
          accessibilityLabel: "account-menu-sign-out",
          onSelect: () => void signOutAccount(),
        }
      : {
          id: "account-sign-in",
          label: tr("nav.signIn"),
          icon: "log-in",
          separator: true,
          accessibilityLabel: "sidebar-account-sign-in",
          onSelect: () => openAccountAuthModal(),
        },
  );
  return items;
}

/** "(B) Bob ⚙": the account menu, and Settings one press away. */
function AccountRow() {
  // Align the 20 px avatar center with the 16 px sidebar icon slot above
  // (8 + 8 + 16/2 = 24) and left-align the label with workspace/session titles
  // (8 + 8 + 16 + 8 = 40): each side sheds half the 4 px width difference.
  const avatarInset = space.sm - space.hair;
  return (
    <View
      ref={el => accountMenuAnchor.set(el)}
      style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.sm, paddingBottom: space.sm }}
    >
      <View
        role="button"
        accessibilityLabel="account-row"
        accessibilityState={{ expanded: accountMenuOpen() }}
        onPress={() => accountMenuOpen.update(open => !open)}
        style={{
          flex: 1,
          minWidth: 0,
          height: controlHeight.md,
          paddingLeft: avatarInset,
          paddingRight: space.sm,
          borderRadius: radii.md,
          flexDirection: "row",
          alignItems: "center",
          gap: avatarInset,
          cursor: "pointer",
          userSelect: "none",
          ...pressTransition(MOTION_DURATION.fast),
        }}
        hoverStyle={{ backgroundColor: palette().chromeHover }}
        activeStyle={tactileActiveStyle(0.985, { backgroundColor: palette().chromeActive })}
        focusVisibleStyle={{ ...focusRingStyle("chrome"), outlineOffset: -1 }}
      >
        <AccountAvatar size={space.xl} testID="sidebar-account-avatar" />
        <Text
          testID="sidebar-account-label"
          style={{
            ...textStyle("label", { color: palette().chromeText }),
            flex: 1,
            minWidth: 0,
            numberOfLines: 1,
            textOverflow: "ellipsis",
          }}
        >
          {accountLabel()}
        </Text>
      </View>
      <IconButton
        icon="settings"
        size="sm"
        surface="chrome"
        active={activeScene() === "settings"}
        iconColor={activeScene() === "settings" ? palette().chromeAccent : undefined}
        accessibilityLabel={tr("nav.settings")}
        tooltip={<TooltipBubble text={tr("nav.settings")} shortcut={shortcutLabel("mod+,", "⌘,")} />}
        style={{ borderWidth: 0, borderColor: "transparent" }}
        onPress={() => {
          if (activeScene() === "settings") {
            if (canGoBack()) {
              goBackScene();
            } else {
              navigateScene(landingScene());
            }
            return;
          }
          navigateScene("settings");
        }}
      />
      <DropdownMenu
        open={accountMenuOpen()}
        anchor={accountMenuAnchor()}
        placement="top"
        align="start"
        minWidth={220}
        items={accountMenuItems()}
        onClose={() => accountMenuOpen.set(false)}
      />
    </View>
  );
}

/**
 * ⌘N and the sidebar's New session: a session in the selected workspace on its
 * device (the device context), or the new-workspace sheet when nothing is
 * selected yet.
 */
async function startNewSession(): Promise<void> {
  const workspace = activeWorkspace();
  if (!workspace) {
    await openNewWorkspaceModal();
    return;
  }
  await newSessionHere(workspace.id, deviceContext());
}

function startNewConversation(): void {
  // wave23-E: with Super Agent gated off (`productGates.ts`), ⌘N starts a session.
  if (!superAgentUi()) {
    void startNewSession();
    return;
  }
  newConversation();
  navigateScene("openbitfun");
}

function showCloudHistory(): boolean {
  if (!superAgentUi()) return false;
  if (superagentPhase() === "signed_out") return false;
  if (accountStatus()?.loggedIn === false && !superagentStatus()?.signedIn) return false;
  return true;
}

function NavPanel(props: { onNavigate?: () => void }) {
  return (
    <If when={superAgentUi()} else={<DeviceNavPanel onNavigate={props.onNavigate} />}>
      <SuperAgentNavPanel onNavigate={props.onNavigate} />
    </If>
  );
}

/**
 * The sidebar while Super Agent is gated off: Search and Library at the top;
 * the account's devices → workspaces → sessions tree in the middle; and the
 * account row with Settings anchored at the bottom.
 */
function DeviceNavPanel(props: { onNavigate?: () => void }) {
  return (
    <View style={{ flex: 1, minHeight: 0, flexDirection: "column" }}>
      <View style={{ paddingHorizontal: space.sm, gap: space.hair, flexShrink: 0 }}>
        <SidebarRow
          label={tr("nav.search")}
          icon="search"
          active={false}
          accessibilityLabel="global-search-trigger"
          onPress={() => {
            props.onNavigate?.();
            openGlobalSearch();
          }}
          trailing={<KbdHint keys={shortcutLabel("mod+k", "⌘K")} surface="chrome" />}
        />
        <SidebarRow
          label={tr("nav.library")}
          icon="package"
          active={activeScene() === "library" && !spaceShortcutActive()}
          accessibilityLabel="nav-library"
          onPress={() => {
            if (spaceShortcutActive()) closeSpacePage();
            navigateScene("library");
            props.onNavigate?.();
          }}
        />
      </View>
      <Scroll
        smoothWheel
        scrollbar={true}
        accessibilityLabel="sidebar-tree-scroll"
        style={{ flex: 1, minHeight: 0, marginTop: space.lg }}
        contentStyle={{ paddingHorizontal: space.sm, paddingBottom: space.md }}
      >
        <SpaceShortcuts onNavigate={props.onNavigate} />
        <DeviceSidebarTree onNavigate={props.onNavigate} />
      </Scroll>
      <View
        style={{
          flexShrink: 0,
          borderTopWidth: 1,
          borderColor: palette().chromeBorder,
          paddingTop: space.sm,
        }}
      >
        <AccountRow />
      </View>
    </View>
  );
}

/**
 * The Super Agent sidebar (shown only while that gate is on, `productGates.ts`):
 * the cloud conversations, then the account's device tree.
 */
function SuperAgentNavPanel(props: { onNavigate?: () => void }) {
  return (
    <View style={{ flex: 1, minHeight: 0, flexDirection: "column" }}>
      <View style={{ paddingHorizontal: space.sm, gap: space.hair, flexShrink: 0 }}>
        <SidebarRow
          label={tr("nav.superAgent")}
          leading={<BitMatrixGlyph size={14} color={palette().chromeText} />}
          active={activeScene() === "openbitfun" && !activeConversationId()}
          accessibilityLabel="nav-openbitfun"
          onPress={() => {
            navigateScene("openbitfun");
            props.onNavigate?.();
          }}
          trailing={
            <IconButton
              icon="plus"
              size="xs"
              surface="chrome"
              accessibilityLabel="nav-new-conversation"
              tooltip={<TooltipBubble text={tr("sa.newConversation")} shortcut={shortcutLabel("mod+n", "⌘N")} />}
              onPress={() => {
                startNewConversation();
                props.onNavigate?.();
              }}
            />
          }
        />
        <SidebarRow
          label={tr("nav.inbox")}
          icon="inbox"
          active={activeScene() === "inbox"}
          accessibilityLabel="nav-inbox"
          onPress={() => {
            navigateScene("inbox");
            props.onNavigate?.();
          }}
          trailing={<InboxCountPill count={inboxBadgeCount()} testID="sidebar-inbox-count" />}
        />
        <SidebarRow
          label={tr("nav.search")}
          icon="search"
          active={false}
          accessibilityLabel="global-search-trigger"
          onPress={() => {
            props.onNavigate?.();
            openGlobalSearch();
          }}
          trailing={<KbdHint keys={shortcutLabel("mod+k", "⌘K")} surface="chrome" />}
        />
      </View>
      <Scroll
        smoothWheel
        scrollbar={true}
        accessibilityLabel="sidebar-history"
        style={{ flex: 1, minHeight: 0, marginTop: space.lg }}
        contentStyle={{ paddingHorizontal: space.sm, paddingBottom: space.md }}
      >
        <If when={showCloudHistory()}>
          <ConversationHistory onOpen={props.onNavigate} />
        </If>
        {/* The account's devices → workspaces → sessions, under the cloud conversations. */}
        <View style={{ marginTop: showCloudHistory() ? space.lg : 0 }}>
          <SpaceShortcuts onNavigate={props.onNavigate} />
          <DeviceSidebarTree onNavigate={props.onNavigate} />
        </View>
      </Scroll>
      <View
        style={{
          flexShrink: 0,
          borderTopWidth: 1,
          borderColor: palette().chromeBorder,
          paddingTop: space.sm,
          gap: space.hair,
        }}
      >
        <View style={{ paddingHorizontal: space.sm, gap: space.hair }}>
          <SidebarRow
            label={tr("nav.library")}
            icon="package"
            active={activeScene() === "library" && !spaceShortcutActive()}
            accessibilityLabel="nav-library"
            onPress={() => {
              if (spaceShortcutActive()) closeSpacePage();
              navigateScene("library");
              props.onNavigate?.();
            }}
          />
        </View>
        <AccountRow />
      </View>
    </View>
  );
}
function errorText(error: unknown): string {
  return localizeHostError(error instanceof Error ? error.message : String(error));
}

// ── App updates (the desktop's update menu: check, download, install) ─────────
// Every update command is controller local, so a driven peer never answers them.

type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing";
const updatePhase = signal<UpdatePhase>("idle");
const updateVersion = signal<string>("");
let updateStateRead = false;

async function readPendingUpdate(): Promise<void> {
  if (updateStateRead || !inAppUpdatesAvailable()) return;
  updateStateRead = true;
  try {
    const pending = await invokeCommand<{ version?: string } | null>("get_pending_update", {});
    if (pending?.version) {
      updateVersion.set(pending.version);
      updatePhase.set("ready");
    }
  } catch (error) {
    console.warn("Failed to read pending update", error);
  }
}

async function checkForAppUpdates(): Promise<void> {
  if (updatePhase() === "checking" || updatePhase() === "downloading" || updatePhase() === "installing") {
    return;
  }
  const previous = updatePhase();
  updatePhase.set("checking");
  try {
    const result = await invokeCommand<{
      updateAvailable?: boolean;
      currentVersion?: string;
      latestVersion?: string | null;
    }>("check_for_updates", {});
    if (result?.updateAvailable && result.latestVersion) {
      if (previous === "ready" && updateVersion() === result.latestVersion) {
        updatePhase.set("ready");
        pushToast(tr("shell.updates.readyVersion", { version: result.latestVersion }), "info");
      } else {
        updateVersion.set(result.latestVersion);
        updatePhase.set("available");
        pushToast(tr("shell.updates.available", { version: result.latestVersion }), "info");
      }
    } else {
      updatePhase.set(previous === "ready" ? "ready" : "idle");
      pushToast(tr("shell.updates.upToDate", { version: result?.currentVersion ?? "" }), "success");
    }
  } catch (error) {
    updatePhase.set(previous === "ready" ? "ready" : "idle");
    pushToast(tr("shell.updates.failed", { error: errorText(error) }), "error");
  }
}

async function downloadAppUpdate(): Promise<void> {
  const expected = updateVersion();
  if (!expected || updatePhase() !== "available") return;
  updatePhase.set("downloading");
  try {
    const pending = await invokeCommand<{ version?: string; installError?: string }>("download_update", {
      expectedVersion: expected,
    });
    updateVersion.set(pending?.version || expected);
    updatePhase.set("ready");
    pushToast(tr("shell.updates.readyVersion", { version: updateVersion() }), "success");
  } catch (error) {
    updatePhase.set("available");
    pushToast(tr("shell.updates.failed", { error: errorText(error) }), "error");
  }
}

async function installAppUpdate(): Promise<void> {
  const version = updateVersion();
  if (!version || updatePhase() !== "ready") return;
  updatePhase.set("installing");
  try {
    await invokeCommand<unknown>("install_pending_update", { version });
  } catch (error) {
    updatePhase.set("ready");
    pushToast(tr("shell.updates.failed", { error: errorText(error) }), "error");
  }
}

function updateMenuItem(): DropdownMenuItem {
  // A native NSH window does not run Tauri's updater; the menu says so instead of failing.
  if (!inAppUpdatesAvailable()) {
    return {
      id: "footer-updates",
      label: tr("shell.updates.check"),
      icon: "refresh",
      disabled: true,
      hint: tr("shell.updates.unsupported"),
    };
  }
  switch (updatePhase()) {
    case "checking":
      return { id: "footer-updates", label: tr("shell.updates.checking"), icon: "refresh", disabled: true };
    case "available":
      return {
        id: "footer-updates",
        label: tr("shell.updates.download", { version: updateVersion() }),
        icon: "download",
        accessibilityLabel: "footer-update-download",
        onSelect: () => void downloadAppUpdate(),
      };
    case "downloading":
      return { id: "footer-updates", label: tr("shell.updates.downloading"), icon: "download", disabled: true };
    case "ready":
      return {
        id: "footer-updates",
        label: tr("shell.updates.install", { version: updateVersion() }),
        icon: "refresh",
        accessibilityLabel: "footer-update-install",
        onSelect: () => void installAppUpdate(),
      };
    case "installing":
      return { id: "footer-updates", label: tr("shell.updates.installing"), icon: "refresh", disabled: true };
    default:
      return {
        id: "footer-updates",
        label: tr("shell.updates.check"),
        icon: "refresh",
        accessibilityLabel: "footer-update-check",
        onSelect: () => void checkForAppUpdates(),
      };
  }
}

/**
 * Minimize / maximize / close for the frameless Windows and Linux window
 * (`decorations(false)`); macOS keeps its native traffic lights, so this draws
 * nothing there. Close goes through the native close request, which the desktop
 * turns into `openbitfun_main_window_close_requested`.
 */
function WindowControlButton(props: {
  id: "minimize" | "maximize" | "close";
  label: string;
  onPress: () => void;
  children: (hovered: () => boolean) => JSX.Element;
}) {
  const wide = () => windowPlatform() === "windows";
  const hovered = signal(false);
  return (
    <View
      role="button"
      accessibilityLabel={`window-${props.id}`}
      tooltip={<TooltipBubble text={props.label} />}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      onPress={props.onPress}
      style={{
        width: wide() ? 46 : 28,
        height: wide() ? 44 : 28,
        flexShrink: 0,
        borderRadius: wide() ? 0 : radii.sm,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        userSelect: "none",
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{
        backgroundColor:
          props.id === "close" && wide() ? palette().danger : palette().surfaceSubtle,
      }}
      activeStyle={{ opacity: 0.8 }}
      focusVisibleStyle={{
        outlineWidth: 2,
        outlineColor: props.id === "close" ? palette().danger : palette().borderFocus,
        outlineOffset: -2,
      }}
    >
      {props.children(hovered)}
    </View>
  );
}

function WindowControls() {
  const glyph = () => palette().textSecondary;
  const wide = () => windowPlatform() === "windows";
  return (
    <If when={pageDrawsWindowControls()}>
      <View
        accessibilityLabel="window-controls"
        style={{
          flexDirection: "row",
          alignItems: "center",
          alignSelf: wide() ? "stretch" : "center",
          gap: wide() ? 0 : space.hair,
          marginRight: wide() ? -space.sm : 0,
          marginLeft: space.xs,
          flexShrink: 0,
        }}
      >
        <WindowControlButton id="minimize" label={tr("shell.window.minimize")} onPress={minimizeWindow}>
          {() => <View style={{ width: 10, height: 1, backgroundColor: glyph() }} />}
        </WindowControlButton>
        <WindowControlButton
          id="maximize"
          label={windowMaximized() ? tr("shell.window.restore") : tr("shell.window.maximize")}
          onPress={toggleWindowMaximize}
        >
          {() => (
            <If
              when={windowMaximized()}
              else={
                <View
                  style={{ width: 10, height: 10, borderWidth: 1, borderColor: glyph(), borderRadius: space.hair }}
                />
              }
            >
              <View style={{ width: 11, height: 11 }}>
                <View
                  style={{
                    position: "absolute",
                    right: 0,
                    top: 0,
                    width: 8,
                    height: 8,
                    borderTopWidth: 1,
                    borderRightWidth: 1,
                    borderColor: glyph(),
                    borderTopRightRadius: space.hair,
                  }}
                />
                <View
                  style={{
                    position: "absolute",
                    left: 0,
                    bottom: 0,
                    width: 8,
                    height: 8,
                    borderWidth: 1,
                    borderColor: glyph(),
                    borderRadius: space.hair,
                  }}
                />
              </View>
            </If>
          )}
        </WindowControlButton>
        <WindowControlButton id="close" label={tr("shell.window.close")} onPress={closeWindow}>
          {hovered => (
            <Icon
              name="close"
              size={12}
              color={hovered() && wide() ? palette().canvas : glyph()}
            />
          )}
        </WindowControlButton>
      </View>
    </If>
  );
}

/**
 * Opens a local folder as a workspace through the native picker, refused with
 * its own message where no native picker exists.
 */
async function pickAndOpenWorkspaceFolder(): Promise<void> {
  let selected: string | null = null;
  try {
    selected = await pickLocalDirectory({ title: tr("shell.pickFolderTitle") });
  } catch (error) {
    pushToast(tr("shell.pickFolderUnavailable", { error: errorText(error) }), "warning");
    return;
  }
  if (selected) await openPathWorkspace(selected);
}

type CloseButtonBehavior = "minimize_to_tray" | "quit" | "ask";
const closeAskOpen = signal(false);
let closeRequestHandling = false;

async function minimizeToTray(): Promise<void> {
  await minimizeMainWindowToTray();
}

async function quitApp(): Promise<void> {
  await flushShellLayout();
  await quitApplication();
}

/**
 * The desktop prevents the native close and asks the page what to do, as it
 * asks the React surface (`AppLayout.tsx`): macOS hides the window, Windows and
 * Linux follow `app.close_button_behavior` (minimize to tray by default).
 *
 * backend-owned: the stored preference is the backend's; only the choice of
 * which shell call carries it out belongs here.
 */
async function handleMainWindowCloseRequest(): Promise<void> {
  if (closeRequestHandling) return;
  closeRequestHandling = true;
  try {
    if (windowPlatform() === "macos" || trafficLightInsetPx() > 0) {
      try {
        await hideMainWindowAfterCloseRequest();
      } catch (error) {
        console.error("Failed to hide main window after close request", error);
      }
      return;
    }
    let behavior: CloseButtonBehavior = "minimize_to_tray";
    try {
      const stored = await invokeCommand<unknown>("get_config", {
        path: "app.close_button_behavior",
        skipRetryOnNotFound: true,
      });
      if (stored === "quit" || stored === "ask" || stored === "minimize_to_tray") behavior = stored;
    } catch {
      // A host that stores no preference closes to the tray, as the desktop does.
    }
    if (behavior === "ask") {
      closeAskOpen.set(true);
      return;
    }
    try {
      if (behavior === "quit") await quitApp();
      else await minimizeToTray();
    } catch (error) {
      console.error("Failed to handle close request", error);
      await quitApp().catch(() => undefined);
    }
  } finally {
    closeRequestHandling = false;
  }
}

function CloseAskDialog() {
  const choose = (quit: boolean) => {
    closeAskOpen.set(false);
    void (quit ? quitApp() : minimizeToTray()).catch(error => {
      console.error("Failed to handle close choice", error);
      pushToast(localizeHostError(error instanceof Error ? error.message : String(error)), "error");
    });
  };
  return (
    <ModalDialog
      open={closeAskOpen()}
      title={tr("shell.closeDialog.title")}
      size="sm"
      accessibilityLabel="close-ask-dialog"
      onClose={() => closeAskOpen.set(false)}
      footer={
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
          <Button
            label={tr("shell.closeDialog.minimizeToTray")}
            variant="secondary"
            size="md"
            accessibilityLabel="close-ask-tray"
            onPress={() => choose(false)}
          />
          <Button
            label={tr("shell.closeDialog.quit")}
            variant="danger"
            size="md"
            accessibilityLabel="close-ask-quit"
            onPress={() => choose(true)}
          />
        </View>
      }
    >
      <Text
        style={{
          color: palette().textSecondary,
          fontSize: textSize(13),
          lineHeight: textLineHeight(13, 1.5),
        }}
      >
        {tr("shell.closeDialog.message")}
      </Text>
    </ModalDialog>
  );
}

/** A `file:` URL a file manager drags, as a local path (`/C:/x` becomes `C:/x`). */
function pathFromFileUri(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return null;
    const host = url.hostname && url.hostname.toLowerCase() !== "localhost" ? `//${url.hostname}` : "";
    const path = decodeURIComponent(url.pathname);
    if (host) return `${host}${path}`;
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/**
 * A file dropped on a scene outside the composer (which attaches drops itself)
 * opens in Files when it lives in the active local workspace on this machine.
 * A dropped local file cannot be opened in a remote workspace or on another
 * peer device, which is said rather than forwarded to a remote disk.
 */
async function handleSceneFileDrop(uris: string[]): Promise<void> {
  const paths = uris.map(pathFromFileUri).filter((p): p is string => Boolean(p));
  if (paths.length === 0) return;
  const ws = activeWorkspace();
  if (!ws) {
    pushToast(tr("shell.drop.noWorkspace"), "warning");
    return;
  }
  const onRemotePeer =
    Boolean(controllerPort()) ||
    (fleetActive() && Boolean(deviceContext()) && Boolean(entryDeviceId()) && deviceContext() !== entryDeviceId());
  if (isRemoteWorkspaceRecord(ws) || onRemotePeer) {
    pushToast(tr("shell.drop.remoteUnsupported"), "warning");
    return;
  }
  const isWindowsRoot = /^[A-Za-z]:[\\/]/.test(ws.rootPath) || ws.rootPath.startsWith("\\\\");
  const normalizeForCompare = (value: string) =>
    isWindowsRoot ? value.replace(/\//g, "\\").toLowerCase() : value;
  const rootRaw = ws.rootPath === "/" ? "/" : ws.rootPath.replace(/[\\/]+$/, "");
  const rootCmp = normalizeForCompare(rootRaw);
  const sep = isWindowsRoot ? "\\" : "/";
  const inside = paths.find(path => {
    const cmp = normalizeForCompare(path);
    if (rootCmp === "/") return cmp.startsWith("/");
    return cmp === rootCmp || cmp.startsWith(`${rootCmp}${sep}`);
  });
  if (!inside) {
    pushToast(tr("shell.drop.outsideWorkspace", { name: basenameLabel(ws.rootPath, ws.name) }), "warning");
    return;
  }
  const openPath = isWindowsRoot ? inside.replace(/\//g, "\\") : inside;
  navigateScene("files");
  await openFileAt(openPath);
}

/**
 * What a scene that threw draws instead of a blank pane: the error, a retry that
 * remounts it, and a way back to Sessions. The rest of the shell keeps working.
 */
function SceneErrorCard(props: { error: unknown; reset: () => void; area: "scene" | "aux" }) {
  const message =
    props.error instanceof Error ? props.error.message : String(props.error ?? "");
  console.error(`The ${props.area} view failed to render`, props.error);
  return (
    <View
      accessibilityLabel={`${props.area}-error-card`}
      style={{ flex: 1, minHeight: 0, alignItems: "center", justifyContent: "center", padding: space.xl }}
    >
      <View
        style={{
          width: "100%",
          maxWidth: 420,
          alignItems: "center",
          gap: space.md,
        }}
      >
        <Icon name="alert-circle" size={28} color={palette().danger} />
        <Text
          style={{
            ...textStyle("sectionTitle", { color: palette().text }),
            textAlign: "center",
          }}
        >
          {tr("shell.error.title")}
        </Text>
        <Text
          style={{
            color: palette().textSecondary,
            fontFamily: fontMono(),
            fontSize: textSize(12),
            lineHeight: textLineHeight(12, 1.45),
            textAlign: "center",
            numberOfLines: 6,
            textOverflow: "ellipsis",
            maxWidth: "100%",
          }}
        >
          {message || tr("shell.error.unknown")}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.sm, marginTop: space.xs }}>
          <Button
            label={tr("shell.error.retry")}
            variant="primary"
            size="md"
            leadingIcon="refresh"
            accessibilityLabel={`${props.area}-error-retry`}
            onPress={props.reset}
          />
          <Button
            label={tr("common.copy")}
            variant="secondary"
            size="md"
            leadingIcon="copy"
            accessibilityLabel={`${props.area}-error-copy`}
            onPress={() => {
              void Clipboard.writeText(message || tr("shell.error.unknown")).then(
                () => pushToast(tr("shell.about.copied"), "success"),
                () => undefined,
              );
            }}
          />
          <If when={props.area === "scene"}>
            <Button
              label={tr("shell.error.backToSessions")}
              variant="ghost"
              size="md"
              onPress={() => {
                navigateScene("sessions");
                props.reset();
              }}
            />
          </If>
        </View>
      </View>
    </View>
  );
}

/** Live target edge shown as a drop-zone preview while dragging AuxPane's header. */
const auxDockDropPreview = signal<AuxPaneSide | null>(null);

interface PanPoint {
  x: number;
  y: number;
}

/**
 * Resolve the pointer's surface coordinates from a PanResponder callback.
 * When the last touch/button lifts (`onPanResponderRelease`), NSH runs
 * `onResponderEnd` with zero active touches and resets `state.moveX`/`moveY`
 * to `0`, so release handling reads the lifted event's `pageX`/`pageY` (with
 * fallback to the last move point or `x0 + dx`, `y0 + dy`).
 */
function panPointerPosition(
  e: { pageX?: number; pageY?: number },
  state: { numberActiveTouches: number; moveX: number; moveY: number; x0: number; y0: number; dx: number; dy: number },
  fallback: PanPoint | null = null,
): PanPoint | null {
  if (state.numberActiveTouches > 0 && Number.isFinite(state.moveX) && Number.isFinite(state.moveY)) {
    return { x: state.moveX, y: state.moveY };
  }
  const hasOrigin = Number.isFinite(state.x0) && Number.isFinite(state.y0);
  const derived = hasOrigin ? { x: state.x0 + state.dx, y: state.y0 + state.dy } : null;
  if (Number.isFinite(e.pageX) && Number.isFinite(e.pageY)) {
    const px = e.pageX as number;
    const py = e.pageY as number;
    // Guard against a host reporting (0, 0) on release when the gesture ended elsewhere.
    if (px === 0 && py === 0 && derived && Math.hypot(derived.x, derived.y) > 4) {
      return fallback ?? derived;
    }
    return { x: px, y: py };
  }
  return fallback ?? derived;
}

function resolveAuxDockTarget(dx: number, dy: number, pos: PanPoint | null): AuxPaneSide | null {
  if (Math.hypot(dx, dy) < 32) return null;
  const w = shellWidth();
  const h = shellHeight();
  const current = auxPaneSide();
  if (h > 0 && pos && pos.y >= h * 0.66) {
    return "bottom";
  }
  if (current !== "bottom" && dy > 72 && Math.abs(dy) >= Math.abs(dx) * 0.8) {
    return "bottom";
  }
  if (w > 0 && pos) {
    const navOffset = sidebarDocked() ? dockedNavWidth() : 0;
    const canvasW = Math.max(1, w - navOffset);
    const relX = (pos.x - navOffset) / canvasW;
    if (current === "bottom" && dy < -60) {
      return relX < 0.5 ? "left" : "right";
    }
    if (relX <= 0.3) return "left";
    if (relX >= 0.68) return "right";
  }
  if (current === "bottom" && dy < -60) {
    return dx < 0 ? "left" : "right";
  }
  if (dx < -100 && current === "right") return "left";
  if (dx > 100 && current === "left") return "right";
  return current;
}

function AuxPane(props: { captionInset?: () => number } = {}) {
  const draggingHeader = signal(false);
  let lastDragPos: PanPoint | null = null;
  cleanup(() => {
    if (draggingHeader()) {
      draggingHeader.set(false);
      auxDockDropPreview.set(null);
    }
    lastDragPos = null;
  });
  const expand = () => {
    const tab = AUX_TABS.find(item => item.id === auxPaneTab());
    toggleAuxPane();
    navigateScene(tab?.scene ?? "files");
  };
  const headerDragResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, state) => !compactShell() && Math.hypot(state.dx, state.dy) > 8,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e, state) => {
      draggingHeader.set(true);
      lastDragPos = panPointerPosition(e, state);
    },
    onPanResponderMove: (e, state) => {
      const pos = panPointerPosition(e, state, lastDragPos);
      if (pos) lastDragPos = pos;
      const target = resolveAuxDockTarget(state.dx, state.dy, pos);
      auxDockDropPreview.set(target);
    },
    onPanResponderRelease: (e, state) => {
      const pos = panPointerPosition(e, state, lastDragPos);
      const target = resolveAuxDockTarget(state.dx, state.dy, pos);
      lastDragPos = null;
      draggingHeader.set(false);
      auxDockDropPreview.set(null);
      if (target && target !== auxPaneSide()) {
        setAuxPaneSide(target);
      }
    },
    onPanResponderTerminate: () => {
      lastDragPos = null;
      draggingHeader.set(false);
      auxDockDropPreview.set(null);
    },
  });
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        flexDirection: "column",
        backgroundColor: palette().canvas,
      }}
    >
      <View
        testID="aux-pane-header"
        style={{
          height: compactShell() ? layout.touchTarget : layout.topBarHeight,
          paddingLeft: space.md,
          paddingRight: (props.captionInset?.() ?? 0) + space.md,
          flexDirection: "row",
          alignItems: "stretch",
          gap: space.sm,
          flexShrink: 0,
          backgroundColor: palette().canvas,
          borderBottomWidth: 1,
          borderColor: palette().borderSubtle,
        }}
      >
        <CaptionActionStrip role="tablist" inset={props.captionInset?.() ?? 0} gap={space.md}>
          <Each of={AUX_TABS} key={tab => tab.id}>
            {tab => {
              const active = () => auxPaneTab() === tab().id;
              const hovered = signal(false);
              return (
                <View
                  role="tab"
                  accessibilityLabel={`aux-tab-${tab().id}`}
                  accessibilityState={{ selected: active() }}
                  onMouseEnter={() => hovered.set(true)}
                  onMouseLeave={() => hovered.set(false)}
                  onPress={() => auxPaneTab.set(tab().id)}
                  style={{
                    position: "relative",
                    flexShrink: 1,
                    minWidth: 0,
                    paddingHorizontal: space.xs,
                    justifyContent: "center",
                    cursor: "pointer",
                    userSelect: "none",
                    ...paintTransition(MOTION_DURATION.fast),
                  }}
                  focusVisibleStyle={{ outlineWidth: 2, outlineColor: palette().borderFocus, outlineOffset: -2 }}
                >
                  <Text
                    style={{
                      ...textStyle("label", {
                        color: active() || hovered() ? palette().text : palette().textSecondary,
                      }),
                      fontWeight: active() ? "600" : "500",
                      numberOfLines: 1,
                      textOverflow: "ellipsis",
                    }}
                  >
                    {tr(tab().labelKey)}
                  </Text>
                  <If when={active()}>
                    <View
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: 2,
                        borderRadius: radii.pill,
                        backgroundColor: palette().accent,
                        pointerEvents: "none",
                      }}
                    />
                  </If>
                </View>
              );
            }}
          </Each>
        </CaptionActionStrip>
        {/* Draggable header bar: pull downwards to dock at bottom, or left/right to move sides. */}
        <View
          {...headerDragResponder.panHandlers}
          accessibilityLabel="aux-dock-drag-handle"
          tooltip={<TooltipBubble text={tr("nav.dragToDock")} />}
          style={{
            flex: 1,
            minWidth: 24,
            alignItems: "center",
            justifyContent: "center",
            cursor: draggingHeader() ? "grabbing" : "grab",
            userSelect: "none",
          }}
        >
          <View
            style={{
              width: 28,
              height: 3,
              borderRadius: radii.pill,
              backgroundColor: draggingHeader() ? palette().accent : palette().borderSubtle,
              opacity: draggingHeader() ? 1 : 0.7,
              ...paintTransition(MOTION_DURATION.fast),
            }}
          />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.hair, flexShrink: 0 }}>
          <If when={!compactShell()}>
            <IconButton
              icon={auxPaneSide() === "bottom" ? "panel-right" : "panel-bottom"}
              size="xs"
              accessibilityLabel="aux-dock-toggle"
              tooltip={auxPaneSide() === "bottom" ? tr("nav.dockRight") : tr("nav.dockBottom")}
              onPress={toggleAuxDockBottom}
            />
          </If>
          <IconButton
            icon="maximize"
            size="xs"
            accessibilityLabel="aux-expand"
            tooltip={tr("shell.openFullWidth")}
            onPress={expand}
          />
          <IconButton
            icon="close"
            size="xs"
            accessibilityLabel="aux-close"
            tooltip={tr("nav.closeAuxPane")}
            onPress={toggleAuxPane}
          />
        </View>
      </View>

      <View style={{ flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
        <ErrorBoundary
          fallback={(error, reset) => <SceneErrorCard error={error} reset={reset} area="aux" />}
        >
          <SmoothSwap swapKey={() => auxPaneTab()} skipInitial>
            {tab => auxElementForTab(tab)}
          </SmoothSwap>
        </ErrorBoundary>
      </View>
    </View>
  );
}

/**
 * The backend connection, said out loud when it is not answering: a backend
 * that failed to start or an event stream that is reconnecting must not look
 * like an empty app.
 */
function BackendConnectionBanner() {
  const message = () => {
    const state = connectionState();
    if (state === "failed") return tr("shell.backend.failed", { error: connectionError() || "-" });
    if (state === "reconnecting") return tr("shell.backend.reconnecting");
    return "";
  };
  return (
    <If when={message()}>
      <CanvasNotice
        icon="wifi"
        text={message()}
        accessibilityLabel="backend-connection-banner"
        action={
          <Button
            label={tr("common.retry")}
            variant="ghost"
            size="xs"
            accessibilityLabel="backend-connection-retry"
            onPress={() => {
              backendConnection().retry?.();
              openHostEventChannel();
              void loadWorkspaces();
            }}
          />
        }
      />
    </If>
  );
}

function ErrorBanner() {
  return (
    <If when={lastError()}>
      {message => (
        <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
          <InlineBanner
            tone="danger"
            message={localizeHostError(message())}
            action={
              isAuthRequiredError(message()) ? (
                <Button
                  label={tr("devices.signInCta")}
                  variant="secondary"
                  size="xs"
                  leadingIcon="log-in"
                  accessibilityLabel="error-banner-sign-in"
                  onPress={() =>
                    openAccountAuthModal({
                      onSuccess: () => {
                        clearError();
                        refreshAccountFacts();
                      },
                    })
                  }
                />
              ) : undefined
            }
            onDismiss={clearError}
          />
        </View>
      )}
    </If>
  );
}

function settingsSearchItems(query: string): SearchItem[] {
  return findSettingsHits(query, 8).map(hit => ({
    id: "setting:" + (hit.anchor ? hit.key : hit.pageId),
    kind: "setting", label: hit.label, detail: hit.anchor ? hit.context : hit.detail,
    target: hit.pageId, settingsAnchor: hit.anchor,
  }));
}

const shellControlActions: ControlPresenterActions = {
  openSettingsPage: requestSettingsPage,
  openFolder: () => void pickAndOpenWorkspaceFolder(),
  newWorkspace: () => void openNewWorkspaceModal({ step: "project" }),
  newSession: () => runShellShortcut("chat.newSession"),
};

function canPickSearchWorkspace(): boolean {
  const shell = windowShellId();
  return shell !== "browser" && shell !== "mobile" &&
    (!fleetActive() || deviceContext() === entryDeviceId());
}

function resolveSearchCapability(destination: ControlDestination) {
  const target = resolveControlDestination(destination, true);
  if (target?.kind === "settings") {
    if (!canOpenSettingsSearchTarget(target.page, target.anchor)) return null;
  }
  if (target?.kind === "action" && target.action === "project.open" && !canPickSearchWorkspace()) return null;
  return target;
}

function searchCapabilities(query: string): SearchItem[] {
  return capabilitySearchItems(query, resolveSearchCapability);
}

function runShellSearchItem(item: SearchItem): void {
  if (item.controlDestination) {
    const target = resolveSearchCapability(item.controlDestination);
    if (!target) {
      pushToast(tr("search.destinationUnavailable"), "warning");
      return;
    }
    closeGlobalSearch();
    presentControlTarget(target, shellControlActions);
    return;
  }
  if (item.id === "command:new-session") {
    closeGlobalSearch();
    void startNewSession();
    return;
  }
  if (item.id === "command:open-project") {
    if (!canPickSearchWorkspace()) {
      pushToast(tr("search.destinationUnavailable"), "warning");
      return;
    }
    closeGlobalSearch();
    void pickAndOpenWorkspaceFolder();
    return;
  }
  if (item.id === "command:new-project") {
    closeGlobalSearch();
    void openNewWorkspaceModal({ step: "project" });
    return;
  }
  if (item.kind === "setting") {
    closeGlobalSearch();
    navigateScene("settings");
    requestSettingsPage(item.target as SettingsPageId, item.settingsAnchor);
    return;
  }
  void runSearchItem(item);
}

function localizedCommandItems(rawNeedle: string): SearchItem[] {
  const needle = rawNeedle.trim().toLowerCase();
  return SEARCH_COMMANDS.filter(cmd => {
    // wave23-E: "Go to Super Agent" only while that gate is on (`productGates.ts`).
    if (cmd.target === "openbitfun" && !superAgentUi()) return false;
    if (cmd.id === "command:open-project" && !canPickSearchWorkspace()) return false;
    if (!needle) return true;
    const label = tr(cmd.labelKey).toLowerCase();
    const detail = tr(cmd.detailKey).toLowerCase();
    return (
      label.includes(needle) ||
      detail.includes(needle) ||
      cmd.aliases.some(alias => alias.includes(needle))
    );
  }).map(cmd => ({
    id: cmd.id,
    kind: "command" as const,
    label: tr(cmd.labelKey),
    detail: tr(cmd.detailKey),
    target: cmd.target,
  }));
}

const COMMAND_ICONS: Readonly<Record<string, IconName>> = {
  "": "edit",
  openbitfun: "sparkles",
  "all-sessions": "layers",
  assistants: "bot",
  agents: "shapes",
  skills: "bolt",
  routines: "clock",
  files: "folder",
  git: "git-branch",
  terminal: "terminal",
  browser: "globe",
  spaces: "layout-grid",
  devices: "laptop",
  settings: "settings",
};

function searchItemIcon(item: SearchItem, fallback: IconName): IconName {
  if (item.kind !== "command") return fallback;
  if (item.id === "command:open-project") return "folder";
  if (item.id === "command:new-project") return "plus";
  if (item.id === "command:new-session") return "chat";
  return COMMAND_ICONS[item.target] ?? fallback;
}

/**
 * The shell's shortcuts. Ids follow the desktop's shortcut registry so a user
 * override stored in `app.keybindings` (`{ __version__: 1, overrides: { id: { key,
 * ctrl, shift, alt, meta } } }`, or the legacy flat map) rebinds the same action
 * here. OS-window fullscreen (F11, Control+Command+F) is a platform-reserved key
 * NSH does not let an app bind, so it is offered as a command instead.
 */
const SHELL_SHORTCUTS: ReadonlyArray<{ id: string; keystroke: string; run: () => void }> = [
  { id: "search.global", keystroke: "mod+k", run: () => openGlobalSearch() },
  { id: "panel.toggleLeft", keystroke: "mod+b", run: () => toggleDrawer() },
  { id: "panel.toggleRight", keystroke: "mod+j", run: () => toggleAuxPane() },
  { id: "scene.openSettings", keystroke: "mod+,", run: () => navigateScene("settings") },
  // A new conversation with OpenBitFun; a direct session starts from All sessions (New session here).
  { id: "chat.newSession", keystroke: "mod+n", run: () => startNewConversation() },
  {
    id: "inbox.toggle",
    keystroke: "mod+i",
    run: () => (compactShell() ? navigateScene("inbox") : toggleInboxSheet()),
  },
];

function bindShortcut(keystroke: string, run: () => void): (() => void) | null {
  if (keystrokeReservedHere(keystroke)) return null;
  try {
    return keymap.bind(keystroke, () => run());
  } catch (error) {
    console.warn(`Shortcut ${keystroke} cannot be bound here`, error);
    return null;
  }
}

function runShellShortcut(id: string): void {
  SHELL_SHORTCUTS.find(shortcut => shortcut.id === id)?.run();
}

function bindShellShortcuts(): void {
  const unbinders = new Map<string, () => void>();
  // A native application menu carries some of these keys itself; binding them
  // again would run the action twice.
  const menuOwned = shellMenuShortcutIds();
  for (const shortcut of SHELL_SHORTCUTS) {
    if (menuOwned.has(shortcut.id)) continue;
    const stop = bindShortcut(shortcut.keystroke, shortcut.run);
    if (stop) unbinders.set(shortcut.id, stop);
  }
  cleanup(() => unbinders.forEach(stop => stop()));
  // wave22-p5 shortcut remapping: the overrides live in `shortcutsStore.ts`, and
  // a change Settings › Shortcuts writes rebinds here without a restart.
  const bound = new Map<string, string>(SHELL_SHORTCUTS.map(shortcut => [shortcut.id, shortcut.keystroke]));
  effect(() => {
    const overrides = keybindingOverrides();
    for (const shortcut of SHELL_SHORTCUTS) {
      if (menuOwned.has(shortcut.id)) continue;
      const keystroke = overrides[shortcut.id] ?? shortcut.keystroke;
      if (bound.get(shortcut.id) === keystroke) continue;
      const stop = bindShortcut(keystroke, shortcut.run);
      if (!stop) continue;
      unbinders.get(shortcut.id)?.();
      unbinders.set(shortcut.id, stop);
      bound.set(shortcut.id, keystroke);
    }
  });
  void loadKeybindings();
}

async function toggleMainWindowFullscreen(): Promise<void> {
  try {
    await toggleWindowFullscreen();
  } catch (error) {
    pushToast(errorText(error), "error");
  }
}

// ── Responsive shell: one UI from phone to desktop ───────────────────────────

/** Width and height of the whole window, measured on the root view. */
const shellWidth = signal(0);
const shellHeight = signal(0);
/** Phone-sized layouts: the sidebar becomes an overlay drawer and side panes fill the scene. */
const compactShell = computed(() => shellWidth() > 0 && shellWidth() <= layout.phoneMaxWidth);
/** 720–959: the sidebar is an overlay drawer instead of docking. */
const overlayNav = computed(() => !compactShell() && shellWidth() > 0 && shellWidth() < layout.mediumDockMinWidth);
/** The sidebar's docked width: 264 on wide windows, 240 on medium ones. */
const dockedNavWidth = computed(() =>
  shellWidth() > 0 && shellWidth() < layout.wideMinWidth ? Math.min(navWidth(), layout.navMediumWidth) : navWidth(),
);
const sidebarDocked = computed(() => drawerOpen() && !compactShell() && !overlayNav());

const nativeWindowsCanvas = computed(() => nativeWindow() && windowPlatform() === "windows");
const floatingCanvas = computed(() => !compactShell() && !nativeWindowsCanvas());
const canvasEdgeInset = computed(() => floatingCanvas() ? layout.canvasInset : 0);
const canvasLeftInset = computed(() => compactShell() || sidebarDocked() ? 0 : layout.canvasInset);
// Keep the floating canvas's existing docking threshold. On Windows only the left gutter can remain.
const canvasWidthAllowance = computed(() => nativeWindowsCanvas() ? canvasLeftInset() : 2 * layout.canvasInset);

function auxFillsScene(): boolean {
  return auxPaneMaximized() || compactShell();
}

const auxCanvasWidth = computed(() => {
  const navAllowance = sidebarDocked() ? dockedNavWidth() + AUX_RESIZE_HANDLE_WIDTH : 0;
  return Math.max(0, shellWidth() - navAllowance - canvasWidthAllowance());
});
const twoSessionPanes = computed(() => splitPaneOpen() || sideQuestionOpen());
const auxMinimumOverlayCanvas = computed(() =>
  twoSessionPanes() ? SESSION_PANE_MIN_WIDTH * 2 + AUX_RESIZE_HANDLE_WIDTH
    : Math.min(layout.canvasMinWidth, Math.floor(auxCanvasWidth() / 2)),
);
const auxAsOverlay = computed(() =>
  activeScene() === "sessions" && auxPaneDisplayMode() === "overlay"
  && !auxFillsScene() && auxPaneSide() !== "bottom"
  && auxCanvasWidth() >= auxMinimumOverlayCanvas() + AUX_MIN_WIDTH + AUX_RESIZE_HANDLE_WIDTH,
);
const overlayAuxMaxWidth = computed(() =>
  Math.max(AUX_MIN_WIDTH, Math.min(AUX_MAX_WIDTH, auxCanvasWidth() - auxMinimumOverlayCanvas() - AUX_RESIZE_HANDLE_WIDTH)),
);
const overlayAuxWidth = computed(() => Math.min(overlayAuxMaxWidth(), auxPaneOverlayWidth()));
const sessionPanelOverlayInset = computed(() =>
  auxPaneOpen() && auxAsOverlay()
    ? { side: auxPaneSide() === "left" ? "left" as const : "right" as const,
        width: overlayAuxWidth() + AUX_RESIZE_HANDLE_WIDTH }
    : null,
);

/**
 * When docking the aux inspector at its minimum width beside the canvas would
 * push the primary canvas below `layout.canvasMinWidth` (560 px, typical on
 * 960–1133 px medium windows with a docked sidebar), present the inspector as
 * a resizable overlay sheet instead. Never depends on the user's live
 * `auxPaneWidth()` so dragging the split handle wider or narrower never flips
 * between docked and sheet modes mid-drag.
 */
const auxAsSheet = computed(() => {
  if (auxFillsScene() || auxPaneSide() === "bottom" || auxAsOverlay()) return false;
  const width = shellWidth();
  if (width <= 0) return false;
  const canvasAllowance = auxCanvasWidth() - AUX_MIN_WIDTH - AUX_RESIZE_HANDLE_WIDTH;
  return canvasAllowance < layout.canvasMinWidth;
});

const auxAtCanvasRight = computed(() =>
  auxPaneOpen() && (auxFillsScene() || (auxPaneSide() === "right" && !auxAsSheet())),
);

function showSceneTopBar(): boolean {
  if (!sidebarDocked() || pageDrawsWindowControls()) return true;
  if (!windowControlsRightInsetPx()) return false;
  // Notices and scrolling pages have no fixed first row to share with the caption.
  if (lastError() || connectionState() === "failed" || connectionState() === "reconnecting") return true;
  return !auxAtCanvasRight() && sceneGroupKey() !== "sessions" && !WORKSPACE_TOOL_SCENES.includes(activeScene());
}

function canvasCaptionInset(): number {
  if (compactShell() || showSceneTopBar()) return 0;
  const rightFrame = floatingCanvas() ? canvasEdgeInset() + 1 : 0;
  return Math.max(0, windowControlsRightInsetPx() - rightFrame);
}

function sceneCaptionInset(): number {
  if (auxPaneOpen() && (auxFillsScene() || auxPaneSide() === "right")) return 0;
  return canvasCaptionInset();
}

/** Maximum docked aux pane height when positioned at the bottom (68% of the canvas height). */
const dockedAuxMaxHeight = computed(() => {
  const height = shellHeight();
  if (height <= 0) return AUX_MAX_HEIGHT;
  const canvasHeight = Math.max(0, height - (nativeWindowsCanvas() ? 0 : layout.canvasInset * 2) - layout.topBarHeight);
  const maxByCol = Math.floor(canvasHeight * 0.68) - 9;
  return Math.max(AUX_MIN_HEIGHT, Math.min(AUX_MAX_HEIGHT, maxByCol));
});

/** Effective bottom-docked aux pane height clamped to the current window. */
const dockedAuxHeight = computed(() => Math.max(AUX_MIN_HEIGHT, Math.min(dockedAuxMaxHeight(), auxPaneHeight())));

/** Maximum docked aux pane width for the current window (leaves room for 1 or 2 session panes). */
const dockedAuxMaxWidth = computed(() => {
  const width = shellWidth();
  if (width <= 0) return AUX_MAX_WIDTH;
  const sceneRowWidth = auxCanvasWidth();
  const maxShare = splitPaneOpen() ? 0.45 : 0.68;
  const maxByRow = Math.floor(sceneRowWidth * maxShare) - 9;
  return Math.max(AUX_MIN_WIDTH, Math.min(AUX_MAX_WIDTH, maxByRow));
});

/** Effective docked aux pane width clamped to the current window so reversing drag has no dead zone. */
const dockedAuxWidth = computed(() => Math.max(AUX_MIN_WIDTH, Math.min(dockedAuxMaxWidth(), auxPaneWidth())));

/** Maximum overlay sheet width (leaves a clickable scrim strip on the opposite edge). */
const sheetAuxMaxWidth = computed(() => {
  const width = shellWidth();
  if (width <= 0) return AUX_MAX_WIDTH;
  return Math.max(AUX_MIN_WIDTH, Math.min(AUX_MAX_WIDTH, Math.round(width - space.xxl * 2)));
});

/** Effective overlay sheet width backed by `auxPaneWidth()` and clamped to the viewport. */
const sheetAuxWidth = computed(() => Math.max(AUX_MIN_WIDTH, Math.min(sheetAuxMaxWidth(), auxPaneWidth())));

/**
 * The canvas's 44 top bar on desktop: the sidebar toggle and back/forward when
 * the sidebar is hidden (76 kept for the traffic lights), a drag region, and
 * the window controls the frameless window needs. Scenes draw their own
 * headers under it; it carries nothing scene-specific except the workspace
 * tools while a session is open.
 */
function SceneTopBar() {
  return (
    <View
      {...titlebarBarProps()}
      style={{
        height: layout.topBarHeight,
        flexShrink: 0,
        minWidth: 0,
        overflow: "hidden",
        paddingLeft: !drawerOpen() && trafficLightInsetPx() > 0 ? layout.trafficLightInset : space.sm,
        paddingRight: windowControlsRightInsetPx() > 0 ? windowControlsRightInsetPx() : space.sm,
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        backgroundColor: palette().canvas,
      }}
    >
      <If when={!drawerOpen()}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.hair, flexShrink: 0 }}>
          <IconButton
            icon="panel-left"
            size="sm"
            accessibilityLabel="toggle-drawer"
            tooltip={<TooltipBubble text={tr("nav.toggleSidebar")} shortcut={shortcutLabel("mod+b", "⌘B")} />}
            onPress={toggleDrawer}
          />
          <IconButton
            icon="arrow-left"
            size="sm"
            disabled={!canGoBack()}
            accessibilityLabel="topbar-nav-back"
            tooltip={tr("common.back")}
            onPress={goBackScene}
          />
          <IconButton
            icon="arrow-right"
            size="sm"
            disabled={!canGoForward()}
            accessibilityLabel="topbar-nav-forward"
            tooltip={tr("common.forward")}
            onPress={goForwardScene}
          />
        </View>
      </If>
      <View
        focusable={false}
        {...titlebarDragRegionProps()}
        style={{ flex: 1, minWidth: 0, height: "100%", cursor: "default" }}
      />
      <WindowControls />
    </View>
  );
}

const WORKSPACE_TOOL_SCENES: ReadonlyArray<SceneId> = ["files", "git", "terminal", "browser"];
/** The phone's four tabs (visual spec §3 PhoneTabBar). */
const SUPER_AGENT_PHONE_TAB_SCENES: ReadonlyArray<SceneId> = ["openbitfun", "inbox", "all-sessions", "library"];
/** wave23-E: with Super Agent gated off, Sessions (the device tree) is the first tab. */
const DEVICE_PHONE_TAB_SCENES: ReadonlyArray<SceneId> = ["all-sessions", "inbox", "library"];

function phoneTabScenes(): ReadonlyArray<SceneId> {
  return superAgentUi() ? SUPER_AGENT_PHONE_TAB_SCENES : DEVICE_PHONE_TAB_SCENES;
}

/** The phone's first tab: where a pushed page goes back to when there is no history. */
function phoneHomeScene(): SceneId {
  return phoneTabScenes()[0]!;
}

function phoneTitle(scene: SceneId): string {
  switch (scene) {
    case "openbitfun":
      return tr("nav.superAgent");
    case "inbox":
      return tr("nav.inbox");
    case "all-sessions":
      return tr("nav.sessions");
    case "library":
      return tr("nav.library");
    case "settings":
      return tr("nav.settings");
    case "files":
      return tr("nav.files");
    case "git":
      return tr("nav.git");
    case "terminal":
      return tr("nav.terminal");
    case "browser":
      return tr("nav.browser");
    default:
      return tr("product.name");
  }
}

/**
 * The phone top bar, 56: ☰ conversations | title | avatar on OpenBitFun; the
 * page title on the other tabs (Library adds its scope chip on the right); ‹
 * and the title on pushed pages. A session draws its own header, so there is
 * none here.
 */
function PhoneTopBar() {
  const isTab = () => phoneTabScenes().includes(activeScene());
  const isHome = () => activeScene() === phoneHomeScene();
  const isLibrary = () => activeScene() === "library";
  return (
    <View
      accessibilityLabel="phone-top-bar"
      style={{
        height: layout.phoneTopBarHeight,
        flexShrink: 0,
        paddingHorizontal: space.sm,
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        backgroundColor: palette().canvas,
        borderBottomWidth: 1,
        borderColor: palette().borderSubtle,
      }}
    >
      <View style={{ minWidth: isLibrary() ? space.xs : layout.touchTarget, alignItems: "flex-start", flexShrink: 0 }}>
        <If
          when={isTab()}
          else={
            <IconButton
              icon="chevron-left"
              size="md"
              accessibilityLabel="phone-back"
              onPress={() => (canGoBack() ? goBackScene() : navigateScene(phoneHomeScene()))}
              style={{ width: layout.touchTarget, height: layout.touchTarget }}
            />
          }
        >
          <If when={superAgentUi() && activeScene() === "openbitfun"}>
            <IconButton
              icon="menu"
              size="md"
              accessibilityLabel="phone-history"
              tooltip={tr("nav.openHistory")}
              onPress={() => drawerOpen.set(true)}
              style={{ width: layout.touchTarget, height: layout.touchTarget }}
            />
          </If>
        </If>
      </View>
      <Text
        role="header"
        style={{
          ...textStyle("prose"),
          fontWeight: "600",
          flex: 1,
          minWidth: 0,
          textAlign: isLibrary() ? "left" : "center",
          numberOfLines: 1,
          textOverflow: "ellipsis",
        }}
      >
        {phoneTitle(activeScene())}
      </Text>
      <View
        style={{
          minWidth: layout.touchTarget,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          flexShrink: 0,
        }}
      >
        <If when={isLibrary()}>
          <LibraryScopeChip />
        </If>
        <If when={!isLibrary() && activeScene() !== "all-sessions"}>
          <IconButton
            icon="search"
            size="md"
            accessibilityLabel="phone-search"
            tooltip={tr("nav.search")}
            onPress={() => openGlobalSearch()}
            style={{ width: layout.touchTarget, height: layout.touchTarget }}
          />
        </If>
        <If when={isHome()}>
          <View
            role="button"
            accessibilityLabel="phone-account"
            onPress={() => navigateScene("settings")}
            activeStyle={tactileActiveStyle(0.96)}
            focusVisibleStyle={focusRingStyle()}
            style={{
              width: layout.touchTarget,
              height: layout.touchTarget,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radii.md,
              cursor: "pointer",
              userSelect: "none",
              ...pressTransition(MOTION_DURATION.fast),
            }}
          >
            <AccountAvatar size={28} />
          </View>
        </If>
      </View>
    </View>
  );
}

function PhoneTabs() {
  const tabs = (): PhoneTab[] => (superAgentUi() ? superAgentTabs() : deviceTabs());
  // wave23-E: Sessions (the account's device → workspace → session tree), Inbox, Library.
  const deviceTabs = (): PhoneTab[] => [
    {
      id: "all-sessions",
      label: tr("nav.sessions"),
      icon: "layers",
      active: activeScene() === "all-sessions",
      onPress: () => navigateScene("all-sessions"),
    },
    {
      id: "inbox",
      label: tr("nav.inbox"),
      icon: "inbox",
      active: activeScene() === "inbox",
      badge: inboxBadgeCount(),
      onPress: () => navigateScene("inbox"),
    },
    {
      id: "library",
      label: tr("nav.library"),
      icon: "package",
      active: activeScene() === "library",
      onPress: () => navigateScene("library"),
    },
  ];
  const superAgentTabs = (): PhoneTab[] => [
    {
      id: "openbitfun",
      label: tr("nav.superAgent"),
      icon: "matrix",
      active: activeScene() === "openbitfun",
      onPress: () => navigateScene("openbitfun"),
    },
    {
      id: "inbox",
      label: tr("nav.inbox"),
      icon: "inbox",
      active: activeScene() === "inbox",
      badge: inboxBadgeCount(),
      onPress: () => navigateScene("inbox"),
    },
    {
      id: "all-sessions",
      label: tr("nav.sessions"),
      icon: "layers",
      active: activeScene() === "all-sessions",
      onPress: () => navigateScene("all-sessions"),
    },
    {
      id: "library",
      label: tr("nav.library"),
      icon: "package",
      active: activeScene() === "library",
      onPress: () => navigateScene("library"),
    },
  ];
  return <PhoneTabBar tabs={tabs()} bottomInset={safeArea().bottom} />;
}

/** The phone's conversation history: a drawer from the left over a scrim with Escape dismiss. */
function CompactDrawer() {
  const motion = drawerEnterMotion("left");
  cleanup(registerEscapeDismiss(() => drawerOpen.set(false)));
  return (
    <Overlay
      onCancel={() => drawerOpen.set(false)}
      style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, flexDirection: "row" }}
    >
      <SurfaceContext.Provider value="chrome">
        <View
          role="dialog"
          accessibilityLabel="phone-history-drawer"
          style={[
            {
              width: Math.min(
                layout.navDrawerWidth + layout.phoneGutter * 3,
                Math.max(layout.navMediumWidth, shellWidth() * 0.86),
              ),
              height: "100%",
              minHeight: 0,
              flexDirection: "column",
              paddingTop: safeArea().top,
              paddingBottom: safeArea().bottom,
              backgroundColor: palette().chromeBg,
              boxShadow: elevationShadow(3),
            },
            motion.style,
          ]}
        >
          <View
            style={{
              height: layout.phoneTopBarHeight,
              flexShrink: 0,
              paddingHorizontal: space.lg,
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs,
            }}
          >
            <Text style={{ ...textStyle("prose", { color: palette().chromeText }), fontWeight: "600", flex: 1 }}>
              {tr("nav.history")}
            </Text>
            <IconButton
              icon="search"
              size="md"
              surface="chrome"
              accessibilityLabel="phone-drawer-search"
              tooltip={tr("nav.search")}
              onPress={() => {
                drawerOpen.set(false);
                openGlobalSearch();
              }}
              style={{ width: layout.touchTarget, height: layout.touchTarget }}
            />
            <IconButton
              icon="plus"
              size="md"
              surface="chrome"
              accessibilityLabel="phone-new-conversation"
              tooltip={tr("sa.newConversation")}
              onPress={() => {
                drawerOpen.set(false);
                startNewConversation();
              }}
              style={{ width: layout.touchTarget, height: layout.touchTarget }}
            />
          </View>
          <Scroll smoothWheel style={{ flex: 1, minHeight: 0 }} contentStyle={{ paddingHorizontal: space.sm, paddingBottom: space.lg }}>
            <If when={showCloudHistory()}>
              <ConversationHistory onOpen={() => drawerOpen.set(false)} />
            </If>
          </Scroll>
        </View>
      </SurfaceContext.Provider>
      <View
        role="button"
        accessibilityLabel="compact-drawer-scrim"
        onPress={() => drawerOpen.set(false)}
        style={{ flex: 1, height: "100%", backgroundColor: palette().scrimBg }}
      />
    </Overlay>
  );
}

/** 720–959 overlay navigation drawer with Escape dismiss, safeArea insets, and 220ms slide motion. */
function OverlaySidebarDrawer() {
  const motion = drawerEnterMotion("left");
  cleanup(registerEscapeDismiss(() => drawerOpen.set(false)));
  return (
    <Overlay
      onCancel={() => drawerOpen.set(false)}
      style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, flexDirection: "row" }}
    >
      <SurfaceContext.Provider value="chrome">
        <View
          role="dialog"
          accessibilityLabel="overlay-sidebar"
          style={[
            {
              width: layout.navDrawerWidth,
              height: "100%",
              minHeight: 0,
              flexDirection: "column",
              paddingTop: safeArea().top,
              paddingBottom: safeArea().bottom,
              backgroundColor: palette().chromeBg,
              boxShadow: elevationShadow(3),
            },
            motion.style,
          ]}
        >
          <NavBar />
          <NavPanel onNavigate={() => drawerOpen.set(false)} />
        </View>
      </SurfaceContext.Provider>
      <View
        role="button"
        accessibilityLabel="overlay-sidebar-scrim"
        onPress={() => drawerOpen.set(false)}
        style={{ flex: 1, height: "100%", backgroundColor: palette().scrimBg }}
      />
    </Overlay>
  );
}

/** Medium-width resizable inspector sheet (keeps the primary canvas >= 560 px wide). */
function AuxPaneSheet() {
  const onLeft = () => auxPaneSide() === "left";
  const motion = drawerEnterMotion(onLeft() ? "left" : "right");
  let dragWidth: number | null = null;
  cleanup(registerEscapeDismiss(() => toggleAuxPane()));
  const handleDragState = (dragging: boolean) => {
    dragWidth = dragging ? sheetAuxWidth() : null;
  };
  const handleDelta = (delta: number) => {
    const signed = onLeft() ? delta : -delta;
    const next = (dragWidth ?? sheetAuxWidth()) + signed;
    const clamped = Math.max(AUX_MIN_WIDTH, Math.min(sheetAuxMaxWidth(), Math.round(next)));
    dragWidth = clamped;
    setAuxPaneWidth(clamped);
  };
  const handleReset = () => {
    setAuxPaneWidth(Math.min(AUX_DEFAULT_WIDTH, sheetAuxMaxWidth()));
  };
  return (
    // Mounted in-tree (not inside `<Overlay>`) so `<BrowserPageLayer />` can
    // sit directly above it and display native WebViews inside the sheet's
    // Browser tab, while global overlays (⌘K, Inbox, modals, dropdowns) stay on top.
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        flexDirection: onLeft() ? "row" : "row-reverse",
      }}
    >
      <View
        role="button"
        accessibilityLabel="aux-pane-sheet-scrim"
        onPress={() => toggleAuxPane()}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          backgroundColor: palette().scrimBg,
        }}
      />
      <View
        role="dialog"
        accessibilityLabel="aux-pane-sheet"
        style={[
          {
            width: sheetAuxWidth(),
            height: "100%",
            minHeight: 0,
            flexDirection: "column",
            backgroundColor: palette().canvas,
            borderLeftWidth: onLeft() ? 0 : 1,
            borderRightWidth: onLeft() ? 1 : 0,
            borderColor: palette().border,
            boxShadow: elevationShadow(3),
          },
          motion.style,
        ]}
      >
        <AuxPane captionInset={() => onLeft() ? 0 : windowControlsRightInsetPx()} />
      </View>
      <SplitHandle
        surface="canvas"
        seam={false}
        accessibilityLabel={onLeft() ? "aux-sheet-split-handle-left" : "aux-sheet-split-handle-right"}
        onDragStateChange={handleDragState}
        onDelta={handleDelta}
        onReset={handleReset}
      />
    </View>
  );
}

/** The same side panel stays mounted when the workspace changes its presentation. */
function SideAuxPane() {
  const left = () => auxPaneSide() === "left";
  const width = () => auxAsOverlay() ? overlayAuxWidth() : dockedAuxWidth();
  const limit = () => auxAsOverlay() ? overlayAuxMaxWidth() : dockedAuxMaxWidth();
  const resize = (next: number) => {
    const clamped = Math.max(AUX_MIN_WIDTH, Math.min(limit(), Math.round(next)));
    if (auxAsOverlay()) setAuxPaneOverlayWidth(clamped);
    else setAuxPaneWidth(clamped);
    return clamped;
  };
  let dragWidth: number | null = null;
  return (
    <View
      testID={auxAsOverlay() ? "session-panel-overlay-pane" : "session-panel-docked-pane"}
      style={{
        position: auxAsOverlay() ? "absolute" : "relative",
        top: auxAsOverlay() ? 0 : undefined,
        bottom: auxAsOverlay() ? 0 : undefined,
        left: auxAsOverlay() && left() ? 0 : undefined,
        right: auxAsOverlay() && !left() ? 0 : undefined,
        zIndex: auxAsOverlay() ? 3 : undefined,
        boxShadow: auxAsOverlay() ? elevationShadow(3) : undefined,
        flexDirection: left() ? "row-reverse" : "row",
        minHeight: 0,
        width: width() + AUX_RESIZE_HANDLE_WIDTH,
        flexShrink: 0,
      }}
    >
      <SplitHandle
        surface="canvas"
        seam={!auxAsOverlay()}
        accessibilityLabel={auxAsOverlay()
          ? left() ? "aux-overlay-split-handle-left" : "aux-overlay-split-handle-right"
          : left() ? "aux-split-handle-left" : "aux-split-handle-right"}
        onDragStateChange={dragging => { dragWidth = dragging ? width() : null; }}
        onDelta={delta => {
          dragWidth = resize((dragWidth ?? width()) + (left() ? delta : -delta));
        }}
        onReset={() => resize(AUX_DEFAULT_WIDTH)}
      />
      <AuxPane captionInset={() => left() ? 0 : canvasCaptionInset()} />
    </View>
  );
}

/**
 * One quiet line at the top of the canvas (visual spec §4.12): the entry is
 * not a fleet entry (an older device), or every connection failed.
 */
function CanvasNotice(props: { icon: IconName; text: string; accessibilityLabel: string; action?: JSX.Element }) {
  return (
    <View
      accessibilityLabel={props.accessibilityLabel}
      style={{
        minHeight: controlHeight.md,
        flexShrink: 0,
        paddingHorizontal: space.lg,
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        backgroundColor: palette().canvasSubtle,
      }}
    >
      <Icon name={props.icon} size={14} color={palette().textSecondary} />
      <Text style={{ ...textStyle("label", { color: palette().textSecondary }), fontWeight: "400", flex: 1, minWidth: 0 }}>
        {props.text}
      </Text>
      {props.action}
    </View>
  );
}

/** The device answered without the fleet layer: its other devices need it updated. */
function FleetUpdateNotice() {
  return (
    <If when={Boolean(controllerPort()) && fleetUnavailable() === "entry_without_fleet"}>
      <CanvasNotice icon="info" text={tr("shell.fleetUpdate")} accessibilityLabel="fleet-update-notice" />
    </If>
  );
}

/** The connected device or fleet now ships a newer web UI bundle; reload on the user's cue. */
function WebUiUpdateNotice() {
  const label = () => {
    const update = controllerUiUpdate();
    if (!update) return "";
    return update.version
      ? tr("shell.webUiUpdateVersion", { version: update.version })
      : tr("shell.webUiUpdate");
  };
  return (
    <If when={Boolean(controllerPort()) && Boolean(controllerUiUpdate())}>
      <CanvasNotice
        icon="refresh"
        text={label()}
        accessibilityLabel="web-ui-update-notice"
        action={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            <Button
              label={tr("common.reload")}
              variant="secondary"
              size="xs"
              disabled={controllerUiUpdating()}
              accessibilityLabel="web-ui-update-reload"
              onPress={() => void applyControllerUiUpdate()}
            />
            <IconButton
              icon="close"
              size="xs"
              accessibilityLabel="web-ui-update-dismiss"
              onPress={() => dismissControllerUiUpdate()}
            />
          </View>
        }
      />
    </If>
  );
}
function StudioApp() {
  effect(() => {
    const family = fontSans();
    untracked(() => syncGlobalNativeTheme(family));
  });
  void initAppLocale();
  // Probe window chrome once before `startShellIntegration` so deferred tray init waits for it.
  void initWindowChrome().then(() => {
    if (nativeWindow()) void readPendingUpdate();
  });
  // The page's remembered appearance first (no flash), then the host's, which
  // account settings sync may have changed on another device.
  void loadAppearance().then(() => syncAppearanceFromHost({ initial: true }));
  // The host's font baseline decides every text size in every scene, so it is
  // read before anything is drawn rather than when the settings page opens.
  void loadFontPreference();
  void loadBtwClosePreference();
  // The stored conversation width shapes how every transcript is laid out, so it
  // is read once here instead of when the settings page is opened.
  void loadContentWidth().then(() => syncContentWidthFromHost());
  initAccountSync();
  initAccountRecords();
  ensureSendPolicy();
  ensureQuickActions();
  void loadAccountState();
  void loadShellLayout();
  // In fleet mode `state.ts`'s `fleetActive` effect loads workspaces from the
  // fleet navigator once; only load workspaces here on non-fleet connections
  // (or after a pending handshake settles as non-fleet) to avoid duplicate navigator reads.
  if (!fleetActive()) {
    if (fleetHandshakePending()) {
      void settleFleetHandshake().then(() => {
        if (!fleetActive()) void loadWorkspaces({ autoOpenRecent: true });
      });
    } else {
      void loadWorkspaces({ autoOpenRecent: true });
    }
  }
  void loadSavedConnections();
  void startPermissionPrompts();
  void startQuestionPrompts();
  startNotifications();
  startAttentionStore();
  startSuperagentStore();
  const stopSpaceAgentSurface = installSpaceAgentSurface(); // wave22-p4: the agent opens Spaces inside the app
  cleanup(() => stopSpaceAgentSurface());
  installAboutUpdates({
    supported: () => inAppUpdatesAvailable(),
    phase: () => updatePhase(),
    version: () => updateVersion(),
    check: () => void checkForAppUpdates(),
    download: () => void downloadAppUpdate(),
    restart: () => void installAppUpdate(),
  });
  // A scene id older code still sets directly (`activeScene.set("assistants")`) opens its route.
  effect(() => {
    const scene = activeScene();
    if (resolveSceneAlias(scene) !== scene) untracked(() => navigateScene(scene));
  });

  const unsubAccountAuth = onAccountAuthChanged(signedIn => {
    if (signedIn) refreshAccountFacts();
  });
  cleanup(() => unsubAccountAuth());

  // The layout is the user's: written back once a change (a drag runs one per frame)
  // holds still, and at once when the app leaves the foreground, the window is asked
  // to close, or the shell goes away, so the last change is never lost.
  effect(() => persistShellLayout());
  effect(() => {
    if (lifecycle() !== "active") untracked(() => void flushShellLayout());
  });
  cleanup(() => void flushShellLayout());

  // Android's back button and the browser's back move through scenes.
  installSystemBack();

  const unsubCloseRequest = onMainWindowCloseRequest(() => {
    void flushShellLayout();
    void handleMainWindowCloseRequest();
  });
  cleanup(() => unsubCloseRequest());

  // The application menu and the tray are the shell's: the Tauri window builds
  // them natively and asks the page through events, a native NSH window builds
  // them from `nsh/desktop`. Both run the same actions.
  const stopShellIntegration = startShellIntegration({
    newSession: () => runShellShortcut("chat.newSession"),
    openFolder: () => void pickAndOpenWorkspaceFolder(),
    newWorkspace: () => void openNewWorkspaceModal({ step: "project" }),
    openSettings: () => runShellShortcut("scene.openSettings"),
    toggleSidebar: () => runShellShortcut("panel.toggleLeft"),
    about: () => openAboutDialog(),
    markAllRead: () => markAllNotificationsRead(),
    openInbox: () => navigateScene("inbox"), // wave22-p3
    openSession: target => {
      if (target.conversationId && superAgentUi()) {
        openConversation(target.conversationId);
        navigateScene("openbitfun");
        return;
      }
      if (target.sessionId) {
        selectSession(target.sessionId, target.deviceId || undefined, target.workspaceId || undefined);
        navigateScene("sessions");
      }
    },
    openPetSettings: () => {
      navigateScene("settings");
      requestSettingsPage("pet", undefined, true);
    },
  });
  cleanup(() => stopShellIntegration());

  // Agent requests to open a product surface ("open the MCP settings") land here.
  const stopControlPresenter = installControlPresenter(shellControlActions);
  cleanup(() => stopControlPresenter());

  bindShellShortcuts();

  effect(() => {
    if (!inboxSheetOpen()) return;
    const stop = registerEscapeDismiss(() => inboxSheetOpen.set(false));
    cleanup(stop);
  });

  // Set first: routing to the session list reads it (a phone page, else the sidebar).
  effect(() => compactLayout.set(compactShell()));

  // wave23-E: a phone opens on its first screen, the session list (the
  // account's device tree), instead of the desktop's session view; only at
  // start (a desktop window narrowed later keeps what it shows).
  let landingDecided = false;
  effect(() => {
    const compact = compactShell();
    // Decided once, when the window first has a width.
    if (landingDecided || shellWidth() <= 0) return;
    landingDecided = true;
    if (!compact || superAgentUi()) return;
    untracked(() => {
      const history = navHistory();
      if (history.length !== 1 || history[0] !== landingScene() || activeScene() !== landingScene()) return;
      resetNavigation("all-sessions");
    });
  });

  // Entering a compact layout folds the sidebar away; picking a scene there closes it again.
  let wasOverlay = false;
  effect(() => {
    const overlay = compactShell() || overlayNav();
    if (overlay && !wasOverlay) untracked(() => drawerOpen.set(false));
    wasOverlay = overlay;
  });
  effect(() => {
    activeScene();
    activeSessionId();
    activeConversationId();
    if (untracked(() => compactShell() || overlayNav())) untracked(() => drawerOpen.set(false));
  });

  let auxDragHeight: number | null = null;
  const resizeDockedAuxHeight = (signedDelta: number) => {
    const next = (auxDragHeight ?? dockedAuxHeight()) + signedDelta;
    const clamped = Math.max(AUX_MIN_HEIGHT, Math.min(dockedAuxMaxHeight(), Math.round(next)));
    auxDragHeight = clamped;
    setAuxPaneHeight(clamped);
  };

  return (
    <View
      onLayout={event => {
        const width = event.bounds.size.width;
        const height = event.bounds.size.height;
        if (width > 0 && Math.abs(width - shellWidth()) > 1) shellWidth.set(width);
        if (height > 0 && Math.abs(height - shellHeight()) > 1) shellHeight.set(height);
      }}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        flexDirection: "row",
        backgroundColor: palette().chromeBg,
      }}
    >
      {/* Left Recessed Navigation Chrome */}
      <If when={sidebarDocked()}>
        <SurfaceContext.Provider value="chrome">
          <View
            style={{
              flexDirection: "row",
              height: "100%",
              minHeight: 0,
              maxWidth: "58%",
              flexShrink: 0,
            }}
          >
            <View
              style={{
                width: dockedNavWidth(),
                flexShrink: 1,
                minWidth: layout.navMinWidth,
                maxWidth: layout.navMaxWidth,
                minHeight: 0,
                flexDirection: "column",
                backgroundColor: palette().chromeBg,
              }}
            >
              <NavBar />
              <NavPanel />
            </View>
            <SplitHandle
              surface="chrome"
              seam={false}
              accessibilityLabel="nav-split-handle"
              onDragStateChange={dragging => {
                navDragWidth = dragging ? navWidth() : null;
              }}
              onDelta={delta => {
                // The drag follows the pointer past the minimum; far enough left, it folds.
                navDragWidth = (navDragWidth ?? navWidth()) + delta;
                if (navDragWidth < NAV_COLLAPSE_WIDTH) {
                  navDragWidth = null;
                  drawerOpen.set(false);
                  return;
                }
                setNavWidth(navDragWidth);
              }}
              onReset={() => setNavWidth(NAV_DEFAULT_WIDTH)}
            />
          </View>
        </SurfaceContext.Provider>
      </If>

      {/* The Windows canvas meets the native frame; the other desktop shells use a floating canvas. */}
      <View
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          marginTop: windowControlsRightInsetPx() > 0 ? 0 : canvasEdgeInset(),
          marginRight: canvasEdgeInset(),
          marginBottom: canvasEdgeInset(),
          marginLeft: canvasLeftInset(),
          paddingLeft: compactShell() ? safeArea().left : 0,
          paddingRight: compactShell() ? safeArea().right : 0,
          borderRadius: compactShell() ? 0 : layout.canvasRadius,
          borderTopRightRadius: floatingCanvas() ? layout.canvasRadius : 0,
          borderBottomRightRadius: floatingCanvas() ? layout.canvasRadius : 0,
          borderCurve: "continuous",
          borderWidth: floatingCanvas() ? 1 : 0,
          borderLeftWidth: compactShell() ? 0 : 1,
          borderColor: palette().borderSubtle,
          backgroundColor: palette().canvas,
          boxShadow: floatingCanvas() ? palette().shadowSceneEdge : undefined,
          overflow: "hidden",
          flexDirection: "column",
        }}
      >
        <If
          when={!compactShell()}
          else={
            <View style={{ flexShrink: 0, paddingTop: safeArea().top, backgroundColor: palette().canvas }}>
              <If when={activeScene() !== "sessions"}>
                <PhoneTopBar />
              </If>
            </View>
          }
        >
          <If when={showSceneTopBar()}>
            <SceneTopBar />
          </If>
        </If>
        <If when={!(compactShell() && activeScene() === "sessions")}>
          <BackendConnectionBanner />
          <FleetUpdateNotice />
          <WebUiUpdateNotice />
        </If>
        <ErrorBanner />

        <View style={{ flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column", position: "relative" }}>
          {/* Keep the pane's z-order local. BrowserPageLayer is drawn above the canvas. */}
          <View style={{
            flex: 1, minWidth: 0, minHeight: 0, position: "relative",
            zIndex: auxAsOverlay() ? 0 : undefined,
            flexDirection: auxPaneSide() === "left" ? "row-reverse" : "row",
          }}>
            <If when={!(auxPaneOpen() && auxFillsScene())}>
              <View
                onFileDrop={event => void handleSceneFileDrop(event.uris)}
                style={{ flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}
              >
                <ErrorBoundary
                  fallback={(error, reset) => <SceneErrorCard error={error} reset={reset} area="scene" />}
                >
                  {/* Keyed by canonical scene group so switching primary routes gets a crisp 110ms GPU settle without remounting Library sub-tabs. */}
                  <SceneCaptionInset.Provider value={sceneCaptionInset}>
                    <SmoothSwap swapKey={sceneGroupKey} skipInitial>
                      {group => sceneElementForGroup(group)}
                    </SmoothSwap>
                  </SceneCaptionInset.Provider>
                </ErrorBoundary>
              </View>
            </If>

            <If when={auxPaneOpen() && auxPaneSide() !== "bottom" && !auxFillsScene() && !auxAsSheet()}>
              <SideAuxPane />
            </If>

            <If when={auxPaneOpen() && auxFillsScene()}>
              <AuxPane captionInset={canvasCaptionInset} />
            </If>
          </View>

          <If when={auxPaneOpen() && auxPaneSide() === "bottom" && !auxFillsScene()}>
            <View
              accessibilityLabel="aux-pane-bottom"
              style={{
                flexDirection: "column",
                minWidth: 0,
                height: dockedAuxHeight() + 9,
                flexShrink: 0,
              }}
            >
              <SplitHandle
                orientation="horizontal"
                surface="canvas"
                accessibilityLabel="aux-split-handle-bottom"
                onDragStateChange={dragging => {
                  auxDragHeight = dragging ? dockedAuxHeight() : null;
                }}
                onDelta={delta => resizeDockedAuxHeight(-delta)}
                onReset={() => setAuxPaneHeight(Math.min(AUX_DEFAULT_HEIGHT, dockedAuxMaxHeight()))}
              />
              <AuxPane />
            </View>
          </If>

          {/* Translucent dock target preview while dragging the AuxPane header */}
          <If when={auxDockDropPreview()}>
            {target => (
              <View
                accessibilityLabel={`aux-drop-preview-${target()}`}
                style={{
                  position: "absolute",
                  zIndex: 4,
                  pointerEvents: "none",
                  ...(target() === "bottom"
                    ? { left: space.sm, right: space.sm, bottom: space.sm, height: "34%" }
                    : target() === "left"
                      ? { top: space.sm, bottom: space.sm, left: space.sm, width: "32%" }
                      : { top: space.sm, bottom: space.sm, right: space.sm, width: "32%" }),
                  borderRadius: radii.lg,
                  borderCurve: "continuous",
                  borderWidth: 2,
                  borderColor: palette().accent,
                  backgroundColor: palette().accentSoft,
                }}
              />
            )}
          </If>
        </View>
        {/* A phone session keeps its own header on top; the connection lines sit under the scene. */}
        <If when={compactShell() && activeScene() === "sessions"}>
          <BackendConnectionBanner />
          <FleetUpdateNotice />
          <WebUiUpdateNotice />
        </If>
        <If when={compactShell() && phoneTabScenes().includes(activeScene())}>
          <PhoneTabs />
        </If>
      </View>

      <If when={auxPaneOpen() && auxAsSheet()}>
        <AuxPaneSheet />
      </If>
      {/* Embedded browser pages sit at shell root above both the canvas and AuxPaneSheet,
          so native WebViews stay visible in docked, full-width, and sheet inspectors alike. */}
      <BrowserPageLayer
        overlayOccluded={Boolean((overlayNav() && drawerOpen()) || (compactShell() && drawerOpen() && superAgentUi()))}
      />
      <If when={compactShell() && drawerOpen() && superAgentUi()}>
        <CompactDrawer />
      </If>
      <If when={overlayNav() && drawerOpen()}>
        <OverlaySidebarDrawer />
      </If>
      <If when={windowControlsRightInsetPx() > 0}>
        <View
          focusable={false}
          style={{
            position: "absolute",
            right: windowControlsRightInsetPx(),
            top: space.md,
            width: 1,
            height: layout.topBarHeight - 2 * space.md,
            backgroundColor: palette().border,
            pointerEvents: "none",
          }}
        />
      </If>
      <InboxSheet />
      <If when={searchOpen()}>
        <GlobalSearchPanel commands={localizedCommandItems} settings={settingsSearchItems} capabilities={searchCapabilities}
          activate={runShellSearchItem} icon={searchItemIcon} shortcut={shortcutLabel("mod+k", "⌘K")} />
      </If>
      <SshWorkspaceModals />
      <AccountAuthModal />
      <RemoteDisclaimerModal />
      <SessionActionDialogs />
      <SideQuestionCloseDialog />
      <DeviceActionDialogs />
      <WorkspaceActionDialogs />
      <AboutDialog />
      <CloseAskDialog />
      <ImageLightboxHost />
      <ToastHost />
    </View>
  );
}

/**
 * A controller without a backend of its own (a browser on the OpenBitFun
 * domain, the phone app) signs in and picks a device first; the studio mounts
 * once a device is connected.
 */
function App() {
  return controllerPort() ? <ControllerShell>{() => <StudioApp />}</ControllerShell> : <StudioApp />;
}

mount(App);
