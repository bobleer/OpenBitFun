import {
  batch,
  cleanup,
  Clipboard,
  computed,
  effect,
  horizontalSizeClass,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  type InputRef,
  type JSX,
  type ScrollRef,
  type ViewRef,
} from "nsh";
import { Input, TextView } from "nsh/base";
// wave22-p3: Settings › Pet (desktop pet and desktop cards)
import { Picker } from "nsh";
import { Buffer } from "buffer";
import {
  companionAvailableHere,
  companionBusy,
  companionEnabled,
  companionNotice,
  desktopCardsEnabled,
  importCompanionPetArchive,
  loadCompanionPets,
  loadCompanionSettings,
  setCompanionEnabled,
  setDesktopCardsEnabled,
} from "../companionStore";
import { PetCharacterGrid } from "../ui/companion";
import { STATIC_MARKDOWN_OPTIONS, createMarkdownCodeActions, createMarkdownStyles } from "../ui/markdown";
import { backendConnection, entryDeviceId, fleetActive, invokeCommand, windowShellId } from "../bridge";
import { fleetDeviceById, fleetDevices, refreshFleetNavigator } from "../fleetStore";
import { confirmBtwClose, setConfirmBtwClose } from "../btwStore";
import { isCommandUnavailable } from "../hostCommands";
import { isRemotePeerContext } from "../shared/deviceScope";
import { isRemoteWorkspace } from "../shared/workspaceUtils";
import { errorMessageOf } from "../shared/errorUtils";
import {
  fetchUsageActivity,
  UsageActivityUnavailable,
  type UsageActivityCell,
  type UsageActivityView,
} from "../usageActivity";
import { StateMark, deviceGlyphIcon, stateColor } from "../ui/fleet";
import { CaptionDragStrip, SceneCaptionInset } from "../ui/titleBar";
import { AccountDevicesPage } from "./AccountDevicesPage";
import { ExternalAppHooks, ExternalAppSkills, type ExternalAppHookBatchState } from "./ExternalAppAssets";
import { ExternalAppBatchHeader } from "./ExternalAppBatch";
import { ExternalAppInstructions } from "./ExternalAppInstructions";
import { ExternalAppAccount } from "./ExternalAppAccount";
import { ExternalAppPets } from "./ExternalAppPets";
import { ExternalRuntimeReviewSections } from "./ExternalRuntimeReview";
import { ExternalRuntimePolicySection } from "./ExternalRuntimePolicy";
import { ExternalRuntimeInventory } from "./ExternalRuntimeInventory";
import { McpServerList } from "./McpServerList";
import { McpJsonEditor } from "./McpJsonEditor";
import { McpServerEditor } from "./McpServerEditor";
import { McpImportDialog } from "./McpImportDialog";
import { ExternalMcpImportGroup } from "./ExternalMcpImports";
import { Bar, Cell, Grid, Plot, PlotAxis } from "nsh/base/plot";
import {
  EXTERNAL_SESSION_NAMES,
  canRevealExternalSource,
  canSetSessionDiscovery,
  changeExternalSourceControl,
  externalBlock,
  externalDiscoveryError,
  externalDiscoverySaving,
  externalError,
  externalLoadState,
  externalSnapshot,
  externalSourceControl,
  externalSourceControlBusy,
  externalSourceControlError,
  loadExternalImport,
  loadRemovedSessions,
  mcpImportBusy,
  externalMcpNotice,
  mcpImportPlan,
  readExternalSourceControl,
  removedRestoreBusy,
  removedRestoreFailed,
  removedSessionKey,
  removedSessions,
  removedSessionsState,
  restoreRemovedSession,
  revealExternalSource,
  sessionDiscoveryBusy,
  sessionDiscoveryConfig,
  sessionDiscoveryError,
  sessionDiscoveryLoad,
  setAutomaticDiscovery,
  setSessionDiscovery,
  syncExternalImportScope,
  type ExternalSourceRow,
} from "../externalImportStore";
import { TabGroup } from "../ui/TabGroup";
import { ProductBrandIcon } from "../ui/ProductBrandIcon";
import {
  INSIGHTS_DAY_OPTIONS,
  accountStatus,
  activeInsightsReport,
  cancelInsights,
  closeInsightsModal,
  generateInsightsReport,
  insightsDays,
  insightsError,
  insightsGenerating,
  insightsLoading,
  insightsMetas,
  insightsModalOpen,
  insightsModel,
  insightsNotice,
  insightsProgress,
  isAccountSignedIn,
  loadAccountState,
  loadLatestInsights,
  openInsightsReport,
  revealInsightsHtml,
  selectedInsightsPath,
} from "../homeStore";
import { accountDisplay } from "../accountDisplay";
import {
  ACP_PERMISSION_MODES,
  acpBusy,
  acpClients,
  acpJsonDirty,
  acpJsonNotice,
  acpJsonOpen,
  acpJsonText,
  acpNotice,
  acpProbing,
  acpProbes,
  acpRowStatus,
  acpSupported,
  closeAcpJson,
  editAcpJson,
  ensureAcp,
  installAcpClient,
  loadAcpClients,
  openAcpJson,
  probeAcpClients,
  saveAcpJson,
  setAcpPermissionMode,
  stopAcpClient,
} from "../acpStore";
import {
  CONTENT_WIDTH_STEP,
  DEFAULT_CONTENT_WIDTH,
  MIN_CONTENT_WIDTH,
  contentWidth,
  contentWidthNotice,
  resetContentWidth,
  setContentWidth,
} from "../contentWidthStore";
import {
  ensureRuntimeLogging,
  exportDiagnosticsBundle,
  loadRuntimeLogging,
  loggingBusy,
  loggingNotice,
  revealLogFolder,
  runtimeLogging,
} from "../diagnosticsStore";
import {
  FONT_LEVELS,
  MAX_FONT_PX,
  MIN_FONT_PX,
  chooseFontLevel,
  fontLevel,
  fontNotice,
  fontPx,
  resetFontPreference,
  setCustomFontPx,
  type FontLevel,
} from "../fontPreferenceStore";
import {
  formatBytes,
  formatDate,
  formatBucket,
  formatCount,
  formatDuration,
  formatPercent,
  formatPlural,
  formatTokens,
  weekdayShortLabels,
} from "../format";
import {
  SUPPORTED_LOCALES,
  appLocaleSaving,
  currentLocale,
  localeMeta,
  localizeHostError,
  localizeQuotaWindowLabel,
  tr,
  type AppLocale,
  type MessageKey,
} from "../i18n";
import {
  closeMcpResources,
  loadMcpResources,
  mcpResourceContent,
  mcpResourceContentBusy,
  mcpResourceQuery,
  mcpResourceSelected,
  mcpResourceVisibleRows,
  mcpResourcesBusy,
  mcpResourcesLoaded,
  mcpResourcesNotice,
  mcpResourcesRows,
  mcpResourcesServer,
  openMcpResource,
  setMcpResourceQuery,
} from "../mcpResourcesStore";
import {
  cancelMcpRemoteOAuth,
  clearMcpRemoteAuth,
  closeMcpAuth,
  closeMcpDraft,
  closeMcpImport,
  canSaveMcpDraft,
  canSaveMcpJson,
  canImportMcpServers,
  closeMcpJson,
  copyMcpOAuthUrl,
  ensureMcp,
  importMcpServers,
  loadMcpDocument,
  mcpAuthValue,
  mcpAvailable,
  mcpBusy,
  mcpDocument,
  mcpDocumentLoaded,
  mcpDraft,
  mcpDraftDirty,
  mcpImportCandidates,
  mcpImportDirty,
  mcpImportOpen,
  mcpImportReading,
  mcpJsonDirty,
  mcpJsonOpen,
  mcpListError,
  mcpLoading,
  mcpNotice,
  mcpOAuthBrowserAvailable,
  mcpOAuthBusy,
  mcpOAuthNotice,
  mcpOAuthPending,
  mcpOAuthServer,
  mcpOAuthSession,
  mcpOAuthStatusLabel,
  mcpOAuthUrlUnopened,
  mcpServerRows,
  openMcpDraft,
  openMcpImport,
  openMcpJson,
  refreshMcpServers,
  reloadMcpForDevice,
  requestCloseMcpAuth,
  saveMcpDraft,
  saveMcpJson,
  saveMcpRemoteAuth,
  setMcpAuthValue,
  startMcpRemoteOAuth,
} from "../mcpStore";
import {
  addAllSelectedDiscoveredModels,
  closeDiscoveryPicker,
  detectModelsForConfig,
  discoveryPickerOpen,
  discoverySearchQuery,
  draftTestOutcome,
  loadSubscriptions,
  mergedDiscoveredOptions,
  modelTestOutcomes,
  openDiscoveryPicker,
  previewRequestUrl,
  quotaMeters,
  remoteDiscoveredModels,
  remoteDiscoveryError,
  remoteDiscoveryLoading,
  resetRemoteDiscovery,
  selectedDiscoveredIds,
  subscriptionAccounts,
  subscriptionQuotas,
  subscriptionsLoading,
  testDraftConnection,
  testSavedModelConnection,
  toggleDiscoveredModel,
  cancelSubscriptionSignIn,
  copySubscriptionLoginUrl,
  signOutSubscriptionAccount,
  startSubscriptionSignIn,
  subscriptionLogin,
  subscriptionSigningOut,
  type QuotaMeterRow,
  type SubscriptionQuotaSummary,
} from "../modelDiscoveryStore";
import {
  catalogProviders,
  chooseCatalogProvider,
  closeModelForm,
  closeModelLimits,
  chooseDefaultModel,
  defaultModelReferences,
  defaultModelSaving,
  defaultModels,
  defaultModelsNotice,
  deleteModel,
  isSelectableForCapability,
  loadDefaultModels,
  modelOptionDetail,
  modelOptionLabel,
  modelOptionText,
  selectableChatModels,
  type DefaultModelSlot,
  loadModels,
  MODEL_CATEGORIES,
  MODEL_FORMATS,
  modelDeletePending,
  openModelEditor,
  requestModelDelete,
  modelCatalog,
  modelCatalogLoaded,
  modelCatalogNotice,
  modelCatalogProvider,
  modelCatalogQuery,
  modelDraft,
  modelFormOpen,
  modelLimitsDraft,
  modelSettingsLoaded,
  modelSettingsNotice,
  normalizeModelFormat,
  openModelForm,
  openModelLimits,
  saveModelDraft,
  saveModelLimits,
  setCatalogQuery,
  setModelEnabled,
  storedModels,
  updateDraft,
  updateModelLimitsDraft,
} from "../modelSettingsStore";
import {
  PERMISSION_ACTIONS,
  PERMISSION_EFFECTS,
  PERMISSION_MODES,
  addPermissionRule,
  approvalModels,
  approvalNotice,
  approvalSettings,
  beginRulesDraft,
  cancelFullAccess,
  choosePermissionMode,
  clearDecisionCredential,
  decisionCredential,
  decisionModel,
  discardRuleDraft,
  ensurePermissions,
  loadDecisionModel,
  loadPermissions,
  movePermissionRule,
  patchPermissionRule,
  pendingFullAccess,
  permissionMode,
  permissionModeControl,
  permissionRuleCount,
  permissionsNotice,
  permissionsSupported,
  removePermissionRule,
  ruleDraft,
  rulesNotice,
  saveApproval,
  saveDecisionCredential,
  saveDecisionModel,
  saveRuleDraft,
  setPermissionModeControl,
  type PermissionEffect,
  type PermissionMode,
} from "../permissionPolicyStore";
import {
  canSavePoolDraft,
  closePoolDraft,
  deletePool,
  ensurePools,
  loadPools,
  openPoolDraft,
  poolBusy,
  poolDraft,
  poolDraftDirty,
  pools,
  poolsLoading,
  poolsNotice,
  poolsSupported,
  savePoolDraft,
  type ModelPool,
} from "../poolStore";
import { ModelPoolEditor, poolStrategyLabel } from "./ModelPoolEditor";
import {
  closeQuickActionDraft,
  deleteQuickAction,
  ensureQuickActions,
  loadQuickActions,
  moveQuickAction,
  openQuickActionDraft,
  quickActionDraft,
  quickActions,
  quickActionsNotice,
  saveQuickActionDraft,
  toggleQuickAction,
  updateQuickActionDraft,
} from "../quickActionStore";
import {
  MID_TURN_POLICIES,
  chooseMidTurnSendPolicy,
  ensureSendPolicy,
  loadSendPolicy,
  midTurnSendPolicy,
  sendPolicyNotice,
  type MidTurnSendPolicy,
} from "../sendPolicyStore";
import {
  SETTINGS_SECTIONS,
  defaultForField,
  fieldDisplay,
  fieldEmptyLabel,
  fieldHint,
  fieldLabel,
  fieldMissing,
  fieldPlaceholder,
  fieldSaving,
  fieldJustSaved,
  fieldUnit,
  generalControlSaving,
  generalControlValue,
  generalControlValues,
  loadGeneralControl,
  memoryActionBusy,
  memoryConfigLoaded,
  memoryEnabledValue,
  memorySettingsBusy,
  openMemoryFolder,
  resetMemory,
  resetMemorySettings,
  setMemoryEnabled,
  setGeneralControl,
  type GeneralControlOption,
  loadSettingsValues,
  maxForField,
  minForField,
  modelTargetForField,
  optionLabel,
  sectionNotice,
  sectionOfField,
  sectionTitle,
  setSectionNotice,
  settingsLoaded,
  settingsNotice,
  settingsValues,
  settingsValuesCurrent,
  supportsExecutionCapability,
  writeAppLanguage,
  writeField,
  type AgentModelTarget,
  type FieldSpec,
  type SettingsPageId,
} from "../settingsStore";
import { findConfiguredTerminalShell, loadTerminalPreferences, loadTerminalShells, terminalPreferences, terminalShells } from "../terminalStore";
import {
  cleanSnapshotStorage, inspectSnapshotStorage, setConfig,
  type SessionSummary, type SnapshotPeriod, type SnapshotStorageOverview,
} from "../api";
import {
  TASK_MODEL_ROWS,
  chooseTaskModel,
  ensureTaskModels,
  loadTaskModels,
  taskModels,
  taskModelsAbsent,
  taskModelsNotice,
  taskModelsSupported,
  type TaskModelChoice,
} from "../taskModelStore";
import {
  APPEARANCE_PRESETS,
  appearanceId,
  appearanceMode,
  compactLayout,
  concentricRadius,
  controlHeight,
  designControlColors,
  fontMono,
  isLightAppearance,
  layout,
  palette,
  radii,
  resolvedAppearanceId,
  resolvedScheme,
  space,
  textLineHeight,
  textSize,
  textStyle,
  textTracking,
  touchSlop,
  inputFontSans,
  type AppearanceId,
} from "../theme";
import { chooseAppearancePreset, setFollowSystemAppearance } from "../themeStore";
import { designTokens } from "../generated/designTokens";
// wave24-replica: MCP servers from the account that still need a secret here.
import { loadAccountRecords } from "../accountRecordsStore";
import {
  accountSync,
  accountSyncBusy,
  accountSyncCaptionShown,
  accountSyncLoad,
  accountSyncNote,
  accountSyncWriteError,
  clearAccountSyncWriteError,
  loadAccountSync,
  setAccountSyncEnabled,
} from "../accountSyncStore";
import { openAccountAuthModal } from "../ui/AccountAuthModal";
import { Icon, type IconName } from "../ui/icons";
import {
  MOTION_DURATION,
  paintTransition,
  pressTransition,
  rotatingChevronStyle,
  Spinner,
  subtleCrossfadeMotion,
  tactileActiveStyle,
} from "../ui/motion";
import {
  DropdownMenu,
  ListRowContent,
  ModalDialog,
  SelectDropdown,
  listRowHoverBg,
  pushToast,
  type SelectDropdownOption,
} from "../ui/overlays";
// wave22-p2: the external Chrome or Edge connect status.
import { ExternalBrowserSection } from "../ui/externalBrowser";
// wave22-p5 settings parity: shortcut remapping, desktop control permissions, settings export/import.
import { keymap } from "nsh";
import { EmptyStateCard, TextField } from "../ui/primitives";
import {
  effectiveKeystroke,
  keystrokeReservedHere,
  keybindingOverrides,
  keystrokeFromKeyEvent,
  loadKeybindings,
  resetAllShortcuts,
  resetShortcut,
  setShortcut,
  SHORTCUT_DEFINITIONS,
  shortcutNotice,
  shortcutRecording,
  shortcutUsing,
  type ShortcutDefinition,
} from "../shortcutsStore";
import {
  computerUseBusy,
  computerUseNotice,
  computerUseState,
  computerUseStatus,
  loadComputerUseStatus,
  openComputerUseSettings,
  requestComputerPermission,
  type ComputerPermissionRow,
} from "../computerUseStore";
import {
  closeConfigImport,
  configImportError,
  configImportName,
  configImportOpen,
  configImportText,
  configTransferBusy,
  copyConfigExport,
  importConfigText,
  openConfigImport,
  pickConfigFile,
} from "../configTransferStore";
import { deleteSessionTarget } from "../ui/sessionActions";
import {
  ActionButton,
  Badge,
  Button,
  IconButton,
  InlineBanner,
  InlineConfirmBar,
  InlineDeleteConfirm,
  ConfigFormCompactContext,
  ConfigRow,
  ConfigSection,
  ConfigSectionHeader,
  InlineFieldSaveGroup,
  InputBox,
  SearchInput,
  SegmentedTabs,
  StatusDot,
  ToggleSwitch,
  focusRingStyle,
} from "../ui/primitives";
import {
  activeWorkspace,
  archiveSessionRow,
  auxPaneDisplayMode,
  deviceContext,
  isSessionArchived,
  loadSessions,
  navigateScene,
  openLibrary,
  selectDeviceContext,
  registerSettingsExitGuard,
  sessionTotal,
  sessions,
  type AuxPaneDisplayMode,
} from "../state";
import {
  USAGE_DISTRIBUTIONS,
  USAGE_RANGES,
  chooseUsageDistribution,
  chooseUsageRange,
  loadUsage,
  setUsageEntryFilter,
  toggleUsageExpanded,
  usageActivity,
  usageActivityLoading,
  usageActivityNotice,
  usageBuckets,
  usageCacheHitRate,
  usageDistribution,
  usageEndpoints,
  usageEntryFilter,
  usageExpanded,
  usageGranularity,
  usageGroups,
  usageLoading,
  usageModels,
  usageNotice,
  usageRange,
  usageTotals,
  usageUnsupported,
  usageVisibleRows,
} from "../usageStore";
import {
  WEB_SEARCH_AUTH_MODES,
  WEB_SEARCH_PROVIDERS,
  chooseSearchProvider,
  clearSearchCredential,
  credentialIdFor,
  ensureWebSearch,
  httpProvider,
  loadWebSearch,
  providerOf,
  saveSearchCredential,
  selectedProvider,
  setHttpAuth,
  setHttpEndpoint,
  setProviderCredentialId,
  webSearchCredential,
  webSearchNotice,
  type WebSearchProviderId,
} from "../webSearchStore";
import { superAgentUi } from "../productGates"; // wave23-E

/** One settings page, as the desktop's settings registry lists it. */
export interface SettingsPageEntry {
  id: SettingsPageId;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  icon: IconName;
  /** Extra words the search matches; field labels on the page are matched too. */
  keywords: readonly string[];
  /** The sections the page draws, in order, for the navigation's anchors. */
  anchors: ReadonlyArray<{ id: string; labelKey: MessageKey }>;
  /** Drawn only in the native desktop window (the desktop pet). */
  nativeOnly?: boolean;
}

/**
 * The three scopes of Settings (visual spec §4.9): Preferences sync with the
 * account, Account is the signed-in identity, Device is the device the scope
 * chip names.
 */
export type SettingsScope = "preferences" | "account" | "device";

export interface SettingsPageGroup {
  id: SettingsScope;
  labelKey: MessageKey;
  pages: readonly SettingsPageEntry[];
}

/** The scopes and their pages, in the spec's order. */
export const SETTINGS_PAGE_GROUPS: readonly SettingsPageGroup[] = [
  {
    id: "preferences",
    labelKey: "settings.scope.preferences",
    pages: [
      {
        id: "general",
        labelKey: "settings.page.general",
        descriptionKey: "settings.page.generalDesc",
        icon: "settings",
        keywords: ["startup", "launch", "update", "sleep", "window", "notification", "language", "locale"],
        anchors: [
          { id: "general-language", labelKey: "settings.section.language" },
          { id: "general", labelKey: "settings.section.startup" },
        ],
      },
      {
        id: "appearance",
        labelKey: "settings.page.appearance",
        descriptionKey: "settings.page.appearanceDesc",
        icon: "palette",
        keywords: ["theme", "font", "size", "dark", "light", "content", "width"],
        anchors: [],
      },
      {
        id: "input",
        labelKey: "settings.page.input",
        descriptionKey: "settings.page.inputDesc",
        icon: "command",
        keywords: ["selection", "send", "queue", "btw"],
        anchors: [
          { id: "input", labelKey: "settings.section.input" },
          { id: "send-policy", labelKey: "settings.sendPolicy.title" },
          { id: "btw-close-confirmation", labelKey: "btw.closeSettingsTitle" },
        ],
      },
      {
        id: "shortcuts",
        labelKey: "settings.page.shortcuts",
        descriptionKey: "settings.page.shortcutsDesc",
        icon: "command",
        keywords: ["keyboard", "shortcut", "keybinding", "hotkey"],
        anchors: [{ id: "shortcuts", labelKey: "settings.shortcuts.title" }],
      },
      {
        id: "pet",
        labelKey: "settings.page.pet",
        descriptionKey: "settings.page.petDesc",
        icon: "bot",
        keywords: ["pet", "companion", "desktop", "cards"],
        // Listed everywhere; phones and browsers say "Desktop only" (wave22-p3).
        anchors: [],
      },
    ],
  },
  {
    id: "account",
    labelKey: "settings.scope.account",
    pages: [
      {
        id: "profile",
        labelKey: "settings.page.profile",
        descriptionKey: "settings.page.profileDesc",
        icon: "user",
        keywords: ["account", "sign in", "email", "profile"],
        anchors: [],
      },
      {
        id: "devices",
        labelKey: "settings.page.devices",
        descriptionKey: "settings.page.devicesDesc",
        icon: "smartphone",
        keywords: ["devices", "phone", "browser", "telegram", "feishu", "wechat", "bot", "chat"],
        anchors: [],
      },
      {
        id: "openbitfun",
        labelKey: "settings.page.openbitfun",
        descriptionKey: "settings.page.openbitfunDesc",
        icon: "sparkles",
        keywords: ["openbitfun", "super agent", "cloud", "agent", "conversation"],
        anchors: [],
      },
      {
        id: "activity",
        labelKey: "settings.page.activity",
        descriptionKey: "settings.page.activityDesc",
        icon: "activity",
        keywords: ["activity", "heatmap", "tokens", "insights"],
        anchors: [],
      },
    ],
  },
  {
    id: "device",
    labelKey: "settings.scope.device",
    pages: [
      {
        id: "models",
        labelKey: "settings.page.models",
        descriptionKey: "settings.page.modelsDesc",
        icon: "cpu",
        keywords: ["model", "provider", "api key", "base url", "proxy", "subscription", "pool", "default", "primary", "fast"],
        anchors: [
          { id: "default-models", labelKey: "settings.defaultModels.title" },
          { id: "models", labelKey: "settings.models.title" },
          { id: "subscriptions", labelKey: "settings.subscriptions.title" },
          { id: "pools", labelKey: "settings.pools.title" },
          { id: "network", labelKey: "settings.section.network" },
        ],
      },
      {
        id: "permissions",
        labelKey: "settings.page.permissions",
        descriptionKey: "settings.page.permissionsDesc",
        icon: "shield",
        keywords: ["permission", "approval", "rules", "allow", "deny", "full access", "openbitfun"],
        anchors: [],
      },
      {
        id: "execution",
        labelKey: "settings.page.execution",
        descriptionKey: "settings.page.executionDesc",
        icon: "play",
        keywords: ["tool", "presentation", "ptc", "timeout", "parallel", "subagent", "swarm", "quick actions", "hooks", "automation"],
        anchors: [
          { id: "quick-actions", labelKey: "settings.quickActions.title" },
          { id: "agent-hooks", labelKey: "settings.section.agentHooks" },
        ],
      },
      {
        id: "session-memory",
        labelKey: "settings.page.sessionMemory",
        descriptionKey: "settings.page.sessionMemoryDesc",
        icon: "sparkles",
        keywords: ["session", "memory", "title", "remember", "recall", "task model", "commit message"],
        anchors: [
          { id: "session", labelKey: "settings.section.session" },
          { id: "task-models", labelKey: "settings.taskModels.title" },
          { id: "memory", labelKey: "settings.section.memory" },
          { id: "memory-models", labelKey: "settings.section.memoryModels" },
          { id: "memory-processing", labelKey: "settings.section.memoryProcessing" },
          { id: "memory-enabled", labelKey: "settings.memory.enabled" },
        ],
      },
      {
        id: "editor",
        labelKey: "settings.page.editor",
        descriptionKey: "settings.page.editorDesc",
        icon: "code",
        keywords: ["editor", "font", "indent", "minimap", "word wrap"],
        anchors: [
          { id: "editor", labelKey: "settings.editor.appearance" },
          { id: "editor-behavior", labelKey: "settings.editor.behavior" },
          { id: "editor-display", labelKey: "settings.editor.display" },
        ],
      },
      {
        id: "terminal",
        labelKey: "settings.page.terminal",
        descriptionKey: "settings.page.terminalDesc",
        icon: "terminal-square",
        keywords: ["terminal", "shell", "pwsh", "powershell", "zsh", "bash", "cursor"],
        anchors: [],
      },
      {
        id: "workspace",
        labelKey: "settings.page.workspace",
        descriptionKey: "settings.page.workspaceDesc",
        icon: "git-branch",
        keywords: ["workspace", "git", "worktree", "isolation", "branch", "search", "commit"],
        anchors: [
          { id: "workspace", labelKey: "settings.section.workspace" },
          { id: "workspace-search", labelKey: "settings.section.workspaceSearch" },
          { id: "git", labelKey: "settings.section.git" },
        ],
      },
      {
        id: "mcp",
        labelKey: "settings.page.mcp",
        descriptionKey: "settings.page.mcpDesc",
        icon: "plug",
        keywords: ["mcp", "server", "tools", "oauth", "acp", "external agent", "claude code", "codex", "gemini"],
        anchors: [
          { id: "mcp", labelKey: "settings.page.mcp" },
          { id: "acp", labelKey: "settings.page.externalAgents" },
        ],
      },
      {
        id: "web-search",
        labelKey: "settings.page.webSearch",
        descriptionKey: "settings.page.webSearchDesc",
        icon: "globe",
        keywords: ["web search", "exa", "tavily", "deepseek", "keenable", "provider", "api key"],
        anchors: [],
      },
      {
        id: "desktop-control",
        labelKey: "settings.page.desktopControl",
        descriptionKey: "settings.page.desktopControlDesc",
        icon: "monitor",
        keywords: ["computer use", "browser", "desktop", "chrome", "HTTP", "token"],
        anchors: [{ id: "external-control", labelKey: "externalControl.title" }],
      },
      {
        id: "external-import",
        labelKey: "settings.page.externalImport",
        descriptionKey: "settings.page.externalImportDesc",
        icon: "download",
        keywords: ["external import", "opencode", "claude code", "codex"],
        anchors: [],
      },
      {
        id: "usage",
        labelKey: "settings.page.usage",
        descriptionKey: "settings.page.usageDesc",
        icon: "bar-chart",
        keywords: ["usage", "tokens", "cost", "statistics"],
        anchors: [],
      },
      {
        id: "storage",
        labelKey: "settings.page.storage",
        descriptionKey: "settings.page.storageDesc",
        icon: "hard-drive",
        keywords: ["storage", "disk", "snapshot", "cleanup", "space"],
        anchors: [
          { id: "snapshot-cleanup", labelKey: "storage.cleanup" },
        ],
      },
      {
        id: "archived",
        labelKey: "settings.page.archived",
        descriptionKey: "settings.page.archivedDesc",
        icon: "folder",
        keywords: ["archived", "archive", "restore", "session"],
        anchors: [],
      },
      {
        id: "diagnostics",
        labelKey: "settings.page.diagnostics",
        descriptionKey: "settings.page.diagnosticsDesc",
        icon: "activity",
        keywords: ["log", "diagnostics", "debug", "export"],
        anchors: [],
      },
    ],
  },
];

/**
 * Page ids older callers (the agent's "open this screen", the search) still
 * name: automation lives on Execution and external agents on MCP servers now.
 */
const SETTINGS_PAGE_ALIASES: Partial<Record<SettingsPageId, { pageId: SettingsPageId; anchor: string }>> = {
  automation: { pageId: "execution", anchor: "quick-actions" },
  "external-agents": { pageId: "mcp", anchor: "acp" },
};

/** The page an id draws on (an alias resolves to the page that hosts it). */
export function resolveSettingsPage(id: SettingsPageId): SettingsPageId {
  // wave23-E: Account › Super Agent is gated off (`productGates.ts`); a request for it opens Profile.
  if (id === "openbitfun" && !superAgentUi()) return "profile";
  return SETTINGS_PAGE_ALIASES[id]?.pageId ?? id;
}

const ALL_SETTINGS_PAGES: readonly SettingsPageEntry[] = SETTINGS_PAGE_GROUPS.flatMap(group => group.pages);

/** The scope a page belongs to. */
export function settingsScopeOf(id: SettingsPageId): SettingsScope {
  const resolved = resolveSettingsPage(id);
  return SETTINGS_PAGE_GROUPS.find(group => group.pages.some(page => page.id === resolved))?.id ?? "preferences";
}

function settingsPageVisible(page: SettingsPageEntry): boolean {
  if (page.id === "openbitfun" && !superAgentUi()) return false; // wave23-E: Super Agent gated off
  if (page.nativeOnly && windowShellId() !== "nsh-desktop") return false;
  if (page.id === "pet" && compactLayout() && !companionAvailableHere()) return false;
  return true;
}

/** The pages a scope lists on this window (hiding desktop-only pet on compact phones). */
export function visibleSettingsPages(group: SettingsPageGroup): readonly SettingsPageEntry[] {
  return group.pages.filter(settingsPageVisible);
}

export function settingsPageEntry(id: SettingsPageId): SettingsPageEntry {
  const resolved = resolveSettingsPage(id);
  return ALL_SETTINGS_PAGES.find(page => page.id === resolved) ?? ALL_SETTINGS_PAGES[0];
}

/** Whether a search destination is visible and its section can be revealed on this surface. */
export function canOpenSettingsSearchTarget(id: SettingsPageId, anchor?: string): boolean {
  const pageId = resolveSettingsPage(id);
  const page = ALL_SETTINGS_PAGES.find(entry => entry.id === pageId);
  if (!page || !settingsPageVisible(page)) return false;
  if (pageId === "storage" && !localSnapshotStorageAvailable()) return false;
  const section = anchor ?? SETTINGS_PAGE_ALIASES[id]?.anchor;
  return !section || page.anchors.some(entry => entry.id === section) ||
    SETTINGS_SECTIONS.some(entry => resolveSettingsPage(entry.page) === pageId && entry.id === section);
}

/** The page Settings shows; General when it opens, as on the desktop. */
export const selectedSettingsPage = signal<SettingsPageId>("general");
/** What the settings navigation's search field holds. */
export const settingsSearchQuery = signal("");

export interface SettingsSearchHit {
  key: string;
  pageId: SettingsPageId;
  icon: IconName;
  label: string;
  context: string;
  detail: string;
  anchor?: string;
}

interface SettingsSearchRecord extends SettingsSearchHit {
  terms: readonly string[];
}

// Both search surfaces use the same localized index and visibility gates.
const settingsSearchIndex = computed<SettingsSearchRecord[]>(() => {
  const records: SettingsSearchRecord[] = [];
  const sectionsByPage = new Map<SettingsPageId, (typeof SETTINGS_SECTIONS)[number][]>();
  for (const section of SETTINGS_SECTIONS) {
    const page = SETTINGS_PAGE_ALIASES[section.page]?.pageId ?? section.page;
    const entries = sectionsByPage.get(page) ?? [];
    entries.push(section);
    sectionsByPage.set(page, entries);
  }
  for (const group of SETTINGS_PAGE_GROUPS) {
    for (const page of visibleSettingsPages(group)) {
      const pageLabel = tr(page.labelKey);
      const detail = tr(page.descriptionKey);
      const context = [tr(group.labelKey), pageLabel].join(" › ");
      const common = { pageId: page.id, icon: page.icon };
      records.push({ ...common, key: "page:" + page.id, label: pageLabel, context, detail,
        terms: [pageLabel, detail, page.id, ...page.keywords] });
      for (const anchor of page.anchors) {
        const label = tr(anchor.labelKey);
        records.push({ ...common, key: "anchor:" + page.id + ":" + anchor.id, label, context, detail,
          anchor: anchor.id, terms: [label, anchor.id] });
      }
      for (const section of sectionsByPage.get(page.id) ?? []) {
        for (const field of section.fields) {
          const label = fieldLabel(field);
          const hint = fieldHint(field) ?? detail;
          const sectionLabel = sectionTitle(section);
          records.push({ ...common, key: "field:" + field.id, label, detail: hint,
            context: sectionLabel === pageLabel ? context : context + " › " + sectionLabel,
            anchor: section.id === "memory" && field.kind === "model" ? "memory-models" : section.id,
            terms: [label, hint, field.id, ...(field.keywords ?? [])] });
        }
      }
    }
  }
  return records;
});

export function findSettingsHits(query: string, limit = 30): SettingsSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches = settingsSearchIndex().filter(record =>
    record.terms.some(text => text.toLowerCase().includes(needle)));
  const matchedDetails = new Set(matches.filter(record => record.anchor).map(record => record.pageId));
  return matches.filter(record => record.anchor || !matchedDetails.has(record.pageId) ||
    record.label.toLowerCase() === needle).slice(0, limit);
}

const settingsSearchResults = computed(() => findSettingsHits(settingsSearchQuery()));
const activeSettingsAnchor = signal<string | null>(null);

/** Views of the sections on the open page, so the navigation can reveal one. */
const sectionAnchorRefs: Record<string, ViewRef | null> = {};
/** The section to reveal once the page that holds it has rendered. */
let pendingAnchor: { pageId: SettingsPageId; id: string } | null = null;
const memoryProcessingOpen = signal(false);

function registerSectionAnchor(id: string, ref: ViewRef | null): void {
  sectionAnchorRefs[id] = ref;
  if (ref && pendingAnchor?.id === id && pendingAnchor.pageId === selectedSettingsPage()) {
    pendingAnchor = null;
    ref.reveal({ vertical: "start" });
  }
}

/** Sub-tab active inside `Settings › Models` so providers, subscriptions, pools and network stay compact. */
type ModelsPageTab = "models" | "subscriptions" | "pools" | "network";
const modelsPageTab = signal<ModelsPageTab>("models");

function syncModelsTabForAnchor(id: string): void {
  if (id === "models" || id === "default-models") modelsPageTab.set("models");
  else if (id === "subscriptions") modelsPageTab.set("subscriptions");
  else if (id === "pools") modelsPageTab.set("pools");
  else if (id === "network") modelsPageTab.set("network");
}

/** Scrolls the open page to one of its sections. */
export function revealSettingsSection(id: string): void {
  activeSettingsAnchor.set(id);
  syncModelsTabForAnchor(id);
  if (id === "memory-processing") memoryProcessingOpen.set(true);
  const ref = sectionAnchorRefs[id];
  if (ref) {
    ref.reveal({ vertical: "start" });
  } else {
    pendingAnchor = { pageId: selectedSettingsPage(), id };
  }
}

/** A settings transition held by the unsaved-changes dialog. */
type PendingSettingsNavigation =
  | { kind: "page"; pageId: SettingsPageId; anchor?: string; clearSearch?: boolean }
  | { kind: "models-tab"; tab: ModelsPageTab }
  | { kind: "device"; deviceId: string }
  | { kind: "device-page"; deviceId: string; pageId: SettingsPageId; anchor?: string }
  | { kind: "mcp-list" }
  | { kind: "mcp-reload" }
  | { kind: "mcp-form-close" }
  | { kind: "mcp-form-reload"; id?: string }
  | { kind: "mcp-import-close" }
  | { kind: "compact-list" }
  | { kind: "scene"; proceed: () => void };

const pendingNavigation = signal<PendingSettingsNavigation | null>(null);

/** Tracks which device each device-scoped section last loaded for, and whether scope switched. */
const loadedDeviceForSection = new Map<string, string>();
let deviceScopeSwitchedInSettings = false;

function useDeviceScopedLoad(sectionKey: string, ensureInitial: () => void, reloadForDevice: () => void): void {
  effect(() => {
    const ctx = deviceContext();
    untracked(() => {
      const prev = loadedDeviceForSection.get(sectionKey);
      if (prev === undefined) {
        loadedDeviceForSection.set(sectionKey, ctx);
        if (deviceScopeSwitchedInSettings) {
          reloadForDevice();
        } else {
          ensureInitial();
        }
      } else if (prev !== ctx) {
        loadedDeviceForSection.set(sectionKey, ctx);
        reloadForDevice();
      }
    });
  });
}

/**
 * Opens a settings page. Text typed into a field and not saved yet would be lost
 * by the page change, so the change waits for Save / Discard / Keep editing.
 */
export function requestSettingsPage(requested: SettingsPageId, requestedAnchor?: string, clearSearch = false): void {
  const alias = SETTINGS_PAGE_ALIASES[requested];
  const pageId = resolveSettingsPage(requested);
  const anchor = requestedAnchor ?? alias?.anchor;
  if (pageId === selectedSettingsPage()) {
    if (anchor && poolDraftDirty()) {
      requestSettingsTransition({ kind: "page", pageId, anchor, clearSearch });
      return;
    }
    if (clearSearch) settingsSearchQuery.set("");
    compactPageOpen.set(true);
    if (anchor) revealSettingsSection(anchor);
    else { pendingAnchor = null; activeSettingsAnchor.set(null); }
    return;
  }
  requestSettingsTransition({ kind: "page", pageId, anchor, clearSearch });
}

function goToSettingsPage(pageId: SettingsPageId, anchor?: string, clearSearch?: boolean): void {
  pendingNavigation.set(null);
  pendingAnchor = null;
  activeSettingsAnchor.set(anchor ?? null);
  if (clearSearch) settingsSearchQuery.set("");
  compactPageOpen.set(true);
  selectedSettingsPage.set(pageId);
  if (anchor) revealSettingsSection(anchor);
}

/** Switches the active device scope, guarding any unsaved text drafts first. */
function requestDeviceScope(deviceId: string): void {
  if (!deviceId || deviceId === deviceContext()) return;
  requestSettingsTransition({ kind: "device", deviceId });
}

/** Opens a Device page with its owning scope, through the unsaved-changes guard. */
export function openDeviceSettings(pageId: SettingsPageId, deviceId?: string, anchor?: string): void {
  const target = fleetActive() ? deviceId || deviceContext() : "";
  if (target && target !== deviceContext()) {
    const owner = fleetDeviceById(target);
    if (!owner || owner.state === "offline" || owner.state === "unreachable") {
      pushToast(tr("settings.offline"), "warning");
      return;
    }
  }
  requestSettingsTransition({ kind: "device-page", deviceId: target, pageId, anchor });
}

function applyDeviceScope(deviceId: string): void {
  pendingNavigation.set(null);
  drafts.set({});
  approvalDrafts.set({});
  deviceScopeSwitchedInSettings = true;
  void selectDeviceContext(deviceId);
}

function transitionFields(pending: PendingSettingsNavigation): FieldSpec[] {
  return pending.kind.startsWith("mcp-") ? [] : dirtyFields();
}

function requestSettingsTransition(next: PendingSettingsNavigation): boolean {
  if (poolBusy() || mcpBusy() === "mcp-json" || mcpBusy() === "mcp-save" || mcpBusy() === "mcp-import" || mcpImportReading()) return false;
  if (poolDraftDirty() || mcpJsonDirty() || mcpDraftDirty() || mcpImportDirty() || transitionFields(next).length > 0) {
    pendingNavigation.set(next);
    return false;
  }
  applyPendingNavigation(next);
  return true;
}

function applyPendingNavigation(pending: PendingSettingsNavigation): void {
  pendingNavigation.set(null);
  if (mcpJsonOpen()) closeMcpJson();
  if (mcpDraft()) closeMcpDraft();
  if (mcpImportOpen()) closeMcpImport();
  if (poolDraft()) closePoolDraft();
  switch (pending.kind) {
    case "mcp-list":
    case "mcp-form-close":
    case "mcp-import-close":
      break;
    case "mcp-form-reload":
      openMcpDraft(pending.id);
      break;
    case "device":
      applyDeviceScope(pending.deviceId);
      break;
    case "device-page":
      batch(() => {
        if (pending.deviceId && pending.deviceId !== deviceContext()) applyDeviceScope(pending.deviceId);
        goToSettingsPage(resolveSettingsPage(pending.pageId), pending.anchor, true);
        navigateScene("settings");
      });
      break;
    case "page":
      goToSettingsPage(pending.pageId, pending.anchor, pending.clearSearch);
      break;
    case "models-tab":
      modelsPageTab.set(pending.tab);
      break;
    case "mcp-reload":
      openMcpJson();
      void loadMcpDocument();
      break;
    case "compact-list":
      compactPageOpen.set(false);
      break;
    case "scene":
      pending.proceed();
      break;
  }
}

/** Opens what a search row names and clears the query. */
export function openSettingsSearchHit(hit: SettingsSearchHit): void {
  requestSettingsPage(hit.pageId, hit.anchor, true);
}

const APPEARANCE_PRESET_KEYS: Record<AppearanceId, MessageKey> = {
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

const FONT_LEVEL_KEYS: Record<FontLevel, MessageKey> = {
  compact: "settings.appearance.fontCompact",
  small: "settings.appearance.fontSmall",
  default: "settings.appearance.fontDefault",
  medium: "settings.appearance.fontMedium",
  large: "settings.appearance.fontLarge",
  custom: "settings.appearance.fontCustom",
};

const PERMISSION_MODE_META: Record<
  PermissionMode,
  { labelKey: MessageKey; hintKey: MessageKey; icon: IconName }
> = {
  ask: {
    labelKey: "perm.ask",
    hintKey: "perm.askBody",
    icon: "shield",
  },
  auto: {
    labelKey: "settings.permissions.modeAuto",
    hintKey: "settings.permissions.modeAutoHint",
    icon: "sparkles",
  },
  full_access: {
    labelKey: "perm.full",
    hintKey: "perm.fullBody",
    icon: "zap",
  },
};

const PERMISSION_EFFECT_KEYS: Record<PermissionEffect, MessageKey> = {
  allow: "settings.permissions.effectAllow",
  ask: "settings.permissions.effectAsk",
  deny: "settings.permissions.effectDeny",
};

const MID_TURN_KEYS: Record<MidTurnSendPolicy, { labelKey: MessageKey; hintKey: MessageKey }> = {
  immediate: { labelKey: "settings.sendPolicy.steerNow", hintKey: "settings.sendPolicy.steerNowHint" },
  queue: { labelKey: "settings.sendPolicy.queue", hintKey: "settings.sendPolicy.queueHint" },
};

const WEB_SEARCH_PROVIDER_KEYS: Record<
  WebSearchProviderId,
  { labelKey: MessageKey; hintKey: MessageKey }
> = {
  exa_mcp_free: {
    labelKey: "settings.webSearch.providerExaFree",
    hintKey: "settings.webSearch.providerExaFreeHint",
  },
  exa_search_api: {
    labelKey: "settings.webSearch.providerExaApi",
    hintKey: "settings.webSearch.providerExaApiHint",
  },
  tavily: {
    labelKey: "settings.webSearch.providerTavily",
    hintKey: "settings.webSearch.providerTavilyHint",
  },
  deepseek: {
    labelKey: "settings.webSearch.providerDeepseek",
    hintKey: "settings.webSearch.providerDeepseekHint",
  },
  keenable: {
    labelKey: "settings.webSearch.providerKeenable",
    hintKey: "settings.webSearch.providerKeenableHint",
  },
  openbitfun_search_http: {
    labelKey: "settings.webSearch.providerHttp",
    hintKey: "settings.webSearch.providerHttpHint",
  },
};

const WEB_SEARCH_AUTH_KEYS: Record<string, MessageKey> = {
  none: "settings.webSearch.authNone",
  bearer: "settings.webSearch.authBearer",
  header: "settings.webSearch.authHeader",
};

const TASK_MODEL_KEYS: Record<string, MessageKey> = {
  session_title: "settings.taskModels.sessionTitle",
  git_commit: "settings.taskModels.commitMessage",
};

const MODEL_CATEGORY_KEYS: Record<string, MessageKey> = {
  general_chat: "settings.models.categoryChat",
  multimodal: "settings.models.categoryMultimodal",
  speech_recognition: "settings.models.categorySpeech",
};

const TASK_MODEL_HINT_KEYS: Record<string, MessageKey> = {
  session_title: "settings.taskModels.sessionTitleHint",
  git_commit: "settings.taskModels.commitMessageHint",
};

const USAGE_RANGE_KEYS: Record<string, MessageKey> = {
  last24Hours: "settings.usage.range24h",
  today: "settings.usage.rangeToday",
  thisWeek: "settings.usage.rangeWeek",
  thisMonth: "settings.usage.rangeMonth",
  all: "settings.usage.rangeAll",
};

const USAGE_DISTRIBUTION_KEYS: Record<string, MessageKey> = {
  model: "settings.usage.byModel",
  group: "settings.usage.byGroup",
};


/** Text being typed into the automatic-approval fields, before it is saved. */
const approvalDrafts = signal<Record<string, string>>({});

const PROVIDER_FORMATS = MODEL_FORMATS;
const rowMenuId = signal<string | null>(null);
/** Whether the diagnostics bundle export is waiting for the privacy confirmation. */
const diagnosticsExportPending = signal(false);
/** The MCP server a delete is waiting to be confirmed for. */
const rowMenuAnchors = signal<Record<string, ViewRef | null>>({});

function setRowAnchor(key: string, el: ViewRef | null): void {
  rowMenuAnchors.update(current => (current[key] === el ? current : { ...current, [key]: el }));
}

function usePresenceFlag(predicate: () => boolean): () => boolean {
  const flag = signal(predicate());
  effect(() => {
    const next = predicate();
    if (flag() !== next) flag.set(next);
  });
  return flag;
}

/** Text typed into a field and not saved yet, by field id. */
const drafts = signal<Record<string, string>>({});

/** What a field's input shows when nothing is being typed: the stored value. */
function storedInputText(spec: FieldSpec): string {
  const value = fieldDisplay(spec);
  if (value === undefined || value === null) return "";
  return String(value);
}

function draftOf(spec: FieldSpec): string {
  const typed = drafts()[spec.id];
  return typed === undefined ? storedInputText(spec) : typed;
}

/** A field whose typed text differs from what is stored. */
function fieldDirty(spec: FieldSpec): boolean {
  const typed = drafts()[spec.id];
  return typed !== undefined && typed.trim() !== storedInputText(spec).trim();
}

function setDraft(spec: FieldSpec, value: string): void {
  drafts.update(current => ({ ...current, [spec.id]: value }));
}

function clearDraft(spec: FieldSpec): void {
  drafts.update(current => {
    if (!(spec.id in current)) return current;
    const next = { ...current };
    delete next[spec.id];
    return next;
  });
}

const ALL_FIELDS: readonly FieldSpec[] = SETTINGS_SECTIONS.flatMap(section => section.fields);

/**
 * Fields with typed, unsaved text: what the unsaved-changes prompt is about. A
 * number saves itself when its field loses focus, so only text fields can hold
 * typed text a page change would drop.
 */
function dirtyFields(): FieldSpec[] {
  return ALL_FIELDS.filter(spec => spec.kind !== "number" && fieldDirty(spec));
}

function clampNumber(spec: FieldSpec, value: number): number {
  const min = minForField(spec) ?? Number.NEGATIVE_INFINITY;
  const max = maxForField(spec) ?? Number.POSITIVE_INFINITY;
  const rounded = spec.precision ? Number(value.toFixed(spec.precision)) : Math.trunc(value);
  return Math.min(max, Math.max(min, rounded));
}

/** A step that moves a wide range in useful increments. */
function stepFor(spec: FieldSpec): number {
  if (spec.precision) return 10 ** -spec.precision;
  const span = (maxForField(spec) ?? 0) - (minForField(spec) ?? 0);
  if (span >= 10000) return 100;
  if (span >= 1000) return 10;
  return 1;
}

/**
 * Saves what is typed in a field. A number is clamped to what the host accepts;
 * an empty or zero value of a field the host keeps as `Option` stores `null`.
 */
async function commitDraft(spec: FieldSpec): Promise<boolean> {
  if (!fieldDirty(spec)) {
    clearDraft(spec);
    return true;
  }
  const raw = draftOf(spec).trim();
  if (spec.kind === "number") {
    if (!raw || (spec.clearable && Number(raw) === 0)) {
      if (!spec.clearable) {
        clearDraft(spec);
        return true;
      }
      const ok = await writeField(spec, null);
      if (ok) clearDraft(spec);
      return ok;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      const section = sectionOfField(spec);
      const message = tr("settings.notice.needsNumber", { label: fieldLabel(spec) });
      if (section) setSectionNotice(section.id, message);
      return false;
    }
    const ok = await writeField(spec, clampNumber(spec, parsed));
    if (ok) clearDraft(spec);
    return ok;
  }
  const ok = await writeField(spec, raw);
  if (ok) clearDraft(spec);
  return ok;
}

/**
 * Steps a number field and saves at once, as the desktop's steppers do. A typed
 * number is the base the step starts from, so `+` after typing never throws the
 * typed value away.
 */
function stepNumber(spec: FieldSpec, direction: 1 | -1): void {
  const typed = drafts()[spec.id]?.trim() ?? "";
  const typedNumber = typed ? Number(typed) : Number.NaN;
  const current = Number(fieldDisplay(spec));
  const base = Number.isFinite(typedNumber)
    ? typedNumber
    : Number.isFinite(current) && fieldDisplay(spec) !== null
      ? current
      : Number(defaultForField(spec) ?? minForField(spec) ?? 0);
  clearDraft(spec);
  void writeField(spec, clampNumber(spec, base + direction * stepFor(spec)));
}

/** The account's name from the backend's identity projection (`accountDisplay`). */
function signedInAccountDisplay(): string {
  return accountDisplay().identity?.displayName || tr("home.signedIn");
}

// --- Settings layout ---

const SETTINGS_CONTENT_MAX = layout.settingsWidth;
const SETTINGS_ROW_MIN = 48;
const SETTINGS_ROW_INSET = space.lg;
const SETTINGS_LIST_WIDTH = layout.navMediumWidth;
// ConfigPageLayout uses the content panel, not the application window, as its container.
const SETTINGS_FORM_STACK_WIDTH = 520;
const SETTINGS_FIELD_WIDTH = designTokens.metrics.menu.width;
const SETTINGS_SAVE_BUTTON_WIDTH = 64;
const settingsNavigationMetrics = designTokens.metrics.navigationPanel;

/** The scene's own laid-out width (used to tune list width and gutters at narrow desktop sizes). */
const settingsSceneWidth = signal(0);
/** Compact layout: the page list is shown until a page is pushed over it. */
const compactPageOpen = signal(false);

function trackSettingsWidth(event: { bounds: { size: { width: number } } }): void {
  const width = Math.round(event.bounds.size.width);
  if (width > 0 && width !== untracked(() => settingsSceneWidth())) settingsSceneWidth.set(width);
}

/** True when the window uses the compact phone list->push layout (<720px). */
export function settingsCompact(): boolean {
  return compactLayout() || horizontalSizeClass() === "compact";
}

function settingsListWidth(): number {
  const width = settingsSceneWidth();
  if (width > 0 && width < 800) return 216;
  return SETTINGS_LIST_WIDTH;
}

function settingsGutter(): number {
  const width = settingsSceneWidth();
  return width > 0 ? Math.min(space.xl, Math.max(space.md, Math.round(width * 0.03))) : space.xl;
}

/** A hairline separator inset 16 from the left, drawn over the top or bottom edge of a row. */
function RowSeparator(props: { edge: "top" | "bottom"; inset?: number }) {
  return (
    <View
      style={{
        position: "absolute",
        top: props.edge === "top" ? 0 : undefined,
        bottom: props.edge === "bottom" ? 0 : undefined,
        left: props.inset ?? SETTINGS_ROW_INSET,
        right: 0,
        height: 1,
        backgroundColor: palette().borderSubtle,
        pointerEvents: "none",
      }}
    />
  );
}

function SettingsRow(props: {
  testID?: string;
  wrap?: boolean;
  label: string;
  description?: string;
  first?: boolean;
  stacked?: boolean;
  controlWidth?: number;
  /** Action aligned to the right of the label/description header when `stacked` is true. */
  headerExtra?: JSX.Element;
  children?: JSX.Element;
}) {
  return (
    <ConfigRow testID={props.testID} label={props.label} description={props.description}
      wrap={props.wrap} stacked={props.stacked} controlWidth={props.controlWidth}
      headerExtra={props.headerExtra} divider={false} topDivider={!props.first}>
      {props.children}
    </ConfigRow>
  );
}

function noticeTone(notice: string): "danger" | "warning" | "success" | "info" {
  return settingsNoticeTone(notice);
}

/** True when a section title only repeats the open page's large title. */
function repeatsPageTitle(title: string): boolean {
  return title === tr(settingsPageEntry(selectedSettingsPage()).labelKey);
}

function SectionHeader(props: { title: string; description?: string; extra?: JSX.Element }) {
  return (
    <View style={{ marginBottom: space.md }}>
      <ConfigSectionHeader title={props.title} description={props.description} extra={props.extra} />
    </View>
  );
}

/** An empty list inside a section: a quiet glyph tile over one line, with room around it. */
function SettingsEmptyState(props: { icon: IconName; message: string }) {
  return (
    <View
      style={{
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        paddingHorizontal: SETTINGS_ROW_INSET,
        paddingVertical: space.xl,
      }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: radii.md,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: palette().buttonSecondaryBg,
        }}
      >
        <Icon name={props.icon} size={16} color={palette().textMuted} />
      </View>
      <Text style={{ ...textStyle("label", { color: palette().textSecondary }), textAlign: "center", maxWidth: 420 }}>
        {props.message}
      </Text>
    </View>
  );
}

/** A 12 muted line inside a page (an empty search, a filter with no rows). */
function SectionFootnote(props: { text: string }) {
  return (
    <Text
      style={{
        ...textStyle("caption"),
        marginTop: space.sm,
        paddingHorizontal: space.xs,
        maxWidth: 600,
      }}
    >
      {props.text}
    </Text>
  );
}

/**
 * The one place a settings section reports the outcome of its own load or
 * write. A success is a toast (it never inserts a banner that pushes the page
 * up and down while the user is still editing); a warning or a failure stays
 * inline between the header and the list, localized, until it is dismissed.
 */
function SectionNoticeBanner(props: { notice: string; onDismiss?: () => void }) {
  effect(() => {
    const notice = props.notice;
    if (!notice || noticeTone(notice) !== "success" || !props.onDismiss) return;
    const dismiss = props.onDismiss;
    untracked(() => {
      pushToast(localizeHostError(notice), "success");
      dismiss();
    });
  });
  const inlineNotice = (): string => {
    const notice = props.notice;
    if (!notice) return "";
    return noticeTone(notice) === "success" && props.onDismiss ? "" : notice;
  };
  return (
    <If when={inlineNotice()}>
      {notice => (
        <View style={{ marginBottom: space.sm }}>
          <InlineBanner tone={noticeTone(notice())} message={localizeHostError(notice())} onDismiss={props.onDismiss} />
        </View>
      )}
    </If>
  );
}

/** A row's trailing value: 13 secondary, tabular. */
function RowValue(props: { text: string }) {
  return (
    <Text
      style={{
        ...textStyle("label", { color: palette().textSecondary, tabular: true }),
        fontWeight: "400",
        numberOfLines: 1,
        textOverflow: "ellipsis",
      }}
    >
      {props.text}
    </Text>
  );
}

/** The inset grouped list surface: radius 12, panelRaised, one hairline, no shadow. */
function insetGroupStyle(padding = 0) {
  return {
    borderRadius: radii.lg,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: palette().borderSubtle,
    backgroundColor: palette().panelRaised,
    padding,
    overflow: "hidden" as const,
    minWidth: 0,
  };
}

/**
 * A titled settings list. Its own notice is drawn under the title, so the
 * outcome of a write shows beside the section that made it; a success clears
 * itself after a few seconds, a failure stays until it is dismissed.
 */
function SettingsGroup(props: {
  id: string;
  title: string;
  hideTitle?: boolean;
  description?: string;
  notice?: string;
  onDismissNotice?: () => void;
  extra?: JSX.Element;
  expanded?: boolean;
  children?: JSX.Element;
}) {
  return (
    <ConfigSection title={props.hideTitle ? "" : props.title}
      subtitle={props.description} extra={props.extra} flush
      anchorRef={node => registerSectionAnchor(props.id, node)}
      notice={<SectionNoticeBanner notice={props.notice ?? ""} onDismiss={props.onDismissNotice} />}>
      {props.children}
    </ConfigSection>
  );
}

function SettingsSection(props: {
  title: string;
  subtitle?: string;
  extra?: JSX.Element;
  notice?: string;
  onDismissNotice?: () => void;
  bodyPadding?: number;
  flush?: boolean;
  children?: JSX.Element;
}) {
  return (
    <ConfigSection title={repeatsPageTitle(props.title) ? "" : props.title}
      subtitle={props.subtitle} extra={props.extra} bodyPadding={props.bodyPadding ?? space.lg}
      flush={props.flush}
      notice={<SectionNoticeBanner notice={props.notice ?? ""} onDismiss={props.onDismissNotice} />}>
      {props.children}
    </ConfigSection>
  );
}

/**
 * The Save button beside a text field. It is always drawn (quiet and disabled
 * until the typed text differs from what is stored), so the row never shifts
 * when typing starts or a save lands. It answers to `Save <label>` and to
 * `<field id>-save`.
 */
function RowSaveButton(props: { spec: FieldSpec; dirty: boolean; onPress: () => void }) {
  const spec = props.spec;
  const active = (): boolean => props.dirty && !fieldSaving(spec);
  return (
    <View
      role="button"
      testID={`${spec.id}-save`}
      accessibilityLabel={tr("settings.field.saveField", { label: fieldLabel(spec) })}
      accessibilityState={{ disabled: !active(), busy: fieldSaving(spec) }}
      disabled={!active()}
      hitSlop={touchSlop(controlHeight.sm)}
      onPress={() => {
        if (active()) props.onPress();
      }}
      style={{
        boxSizing: "border-box",
        minHeight: compactLayout() ? layout.touchTarget : controlHeight.sm,
        minWidth: SETTINGS_SAVE_BUTTON_WIDTH,
        paddingHorizontal: space.md,
        flexShrink: 0,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space.xs,
        borderRadius: radii.md,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: props.dirty ? "transparent" : palette().borderSubtle,
        backgroundColor: props.dirty ? palette().actionPrimaryBg : palette().buttonSecondaryBg,
        cursor: active() ? "pointer" : "default",
        userSelect: "none",
        ...pressTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={props.dirty ? { backgroundColor: palette().actionPrimaryHover } : undefined}
      activeStyle={tactileActiveStyle()}
      focusVisibleStyle={focusRingStyle()}
    >
      <If when={fieldSaving(spec)}>
        <Spinner size={11} color={props.dirty ? palette().actionPrimaryFg : palette().textMuted} />
      </If>
      <Text
        style={{
          ...textStyle("caption", { color: props.dirty ? palette().actionPrimaryFg : palette().textMuted }),
          fontWeight: "600",
        }}
      >
        {tr("settings.field.saveShort")}
      </Text>
    </View>
  );
}

function fieldOptions(spec: FieldSpec) {
  return spec.dynamicOptions ? spec.dynamicOptions() : (spec.options ?? []);
}

/** Rough character columns for segmented-control fitting (CJK glyphs take ~2 Latin columns). */
function segmentedLabelColumns(text: string): number {
  let cols = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    cols += code >= 0x2e80 ? 2 : 1;
  }
  return cols;
}

/** Explicit presentation wins; otherwise use label fitting to choose a segmented control. */
function segmentedFits(spec: FieldSpec): boolean {
  if (spec.selectPresentation) return spec.selectPresentation === "segmented";
  if (spec.dynamicOptions) return false;
  const options = fieldOptions(spec);
  if (options.length > 3 || options.some(option => option.disabledReason)) return false;
  let totalCols = 0;
  for (const option of options) {
    const cols = segmentedLabelColumns(optionLabel(option));
    if (cols > 12) return false;
    totalCols += cols;
  }
  return totalCols <= 28;
}

function ChoiceControl(props: { spec: FieldSpec; disabled?: boolean }) {
  const spec = props.spec;
  const current = () => String(fieldDisplay(spec) ?? "") || (spec.emptyMeans ?? "");
  const options = () =>
    fieldOptions(spec).map(option => ({
      value: option.value,
      label: optionLabel(option),
      accessibilityLabel: `${spec.id}-${option.value}`,
      disabled: props.disabled || Boolean(option.disabledReason),
      description: option.disabledReason ? tr(option.disabledReason) : undefined,
    }));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm,
      width: segmentedFits(spec) ? undefined : "100%", minWidth: 0, maxWidth: "100%" }}>
      <FieldStatus saving={fieldSaving(spec)} saved={fieldJustSaved(spec.id)} />
      <If when={segmentedFits(spec)}>
        <SegmentedTabs size="sm" value={current()} options={options()} onChange={value => void writeField(spec, value)} />
      </If>
      <If when={!segmentedFits(spec)}>
        <SelectDropdown
          size="sm"
          value={current()}
          options={options()}
          testID={spec.id}
          accessibilityLabel={fieldLabel(spec)}
          accessibilityDescription={fieldDescription(spec)}
          disabled={props.disabled || fieldSaving(spec)}
          fullWidth
          align="end"
          onChange={value => void writeField(spec, value)}
        />
      </If>
    </View>
  );
}

/**
 * A configured-model field: follow (null), the two roles, or one of the
 * enabled chat models by `name · model`. An id the host no longer configures is
 * kept visible as such instead of reading as "follow".
 */
function ModelChoiceControl(props: { spec: FieldSpec; disabled?: boolean }) {
  const spec = props.spec;
  const current = (): string => {
    const value = fieldDisplay(spec);
    return value === undefined || value === null ? "" : String(value);
  };
  const options = () => {
    const rows: Array<{ value: string; label: string; description?: string; accessibilityLabel: string }> = [
      {
        value: "",
        label: fieldEmptyLabel(spec) ?? tr("settings.field.followSessionModel"),
        accessibilityLabel: `${spec.id}-inherit`,
      },
      { value: "primary", label: tr("settings.field.primaryRole"), accessibilityLabel: `${spec.id}-primary` },
      { value: "fast", label: tr("settings.field.fastRole"), accessibilityLabel: `${spec.id}-fast` },
      ...selectableChatModels().map(model => ({
        value: model.id,
        label: modelOptionText(model),
        accessibilityLabel: `${spec.id}-${model.id}`,
      })),
    ];
    const selected = current();
    if (selected && !rows.some(row => row.value === selected)) {
      rows.push({
        value: selected,
        label: tr("settings.field.notConfiguredSuffix", { name: selected }),
        accessibilityLabel: `${spec.id}-${selected}`,
      });
    }
    return rows;
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, width: "100%", minWidth: 0 }}>
      <FieldStatus saving={fieldSaving(spec)} saved={fieldJustSaved(spec.id)} />
      <SelectDropdown
        size="sm"
        value={current()}
        options={options()}
        searchable={options().length > 8}
        testID={spec.id}
        accessibilityLabel={fieldLabel(spec)}
        accessibilityDescription={fieldHint(spec)}
        disabled={props.disabled || fieldSaving(spec)}
        fullWidth
        align="end"
        onChange={value => void writeField(spec, value || null)}
      />
    </View>
  );
}

function executionModelPoolsSupported(): boolean {
  return supportsExecutionCapability("model_routing_v1") && supportsExecutionCapability("model_pool_selection_v1");
}

function ModelTargetChoiceControl(props: { spec: FieldSpec; disabled?: boolean }) {
  const spec = props.spec;
  const selected = () => modelTargetForField(spec);
  const value = () => selected() ? JSON.stringify(selected()) : "";
  const choices = () => {
    const rows: Array<{ selection: AgentModelTarget; label: string; description?: string; accessibilityLabel: string }> = [
      { selection: { kind: "inherit" }, label: tr("settings.execution.inheritModel"), accessibilityLabel: `${spec.id}-inherit` },
      { selection: { kind: "model", model_ref: "fast" }, label: tr("settings.field.fastRole"), accessibilityLabel: `${spec.id}-fast` },
      { selection: { kind: "model", model_ref: "primary" }, label: tr("settings.field.primaryRole"), accessibilityLabel: `${spec.id}-primary` },
      ...selectableChatModels().filter(model => model.id !== "fast" && model.id !== "primary").map(model => ({
        selection: { kind: "model" as const, model_ref: model.id },
        label: modelOptionText(model), accessibilityLabel: `${spec.id}-model-${model.id}`,
      })),
    ];
    if (executionModelPoolsSupported() && poolsSupported()) {
      for (const pool of pools()) rows.push({
        selection: { kind: "pool", pool_id: pool.id }, label: pool.name, description: tr("settings.pools.title"),
        accessibilityLabel: `${spec.id}-pool-${pool.id}`,
      });
    }
    return rows;
  };
  const options = () => {
    const options = choices().map(({ selection, ...row }) => ({ ...row, value: JSON.stringify(selection), disabled: false }));
    const stored = selected();
    if (stored && stored.kind !== "inherit" && !options.some(option => option.value === value())) {
      const name = stored.kind === "pool" ? stored.pool_id : stored.model_ref;
      options.push({ value: value(), label: tr("settings.field.notConfiguredSuffix", { name }),
        accessibilityLabel: `${spec.id}-unavailable`, disabled: true });
    }
    return options;
  };
  const select = (key: string) => {
    if (props.disabled || fieldSaving(spec) || !selected()) return;
    const choice = choices().find(row => JSON.stringify(row.selection) === key);
    if (choice && key !== value()) void writeField(spec, choice.selection);
  };
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, width: "100%", minWidth: 0 }}>
    <FieldStatus saving={fieldSaving(spec)} saved={fieldJustSaved(spec.id)} />
    <SelectDropdown size="sm" value={value()} options={options()} searchable={options().length > 8}
      testID={spec.id} accessibilityLabel={fieldLabel(spec)} disabled={props.disabled || fieldSaving(spec) || !selected()}
      fullWidth align="end" onChange={select} />
  </View>;
}

/**
 * Every number row's stepper has this width, so the boxes of all number rows
 * share one right-aligned column and their values line up.
 */
/** Same width as a settings select, so steppers and selects share one right rail. */
const NUMBER_STEPPER_WIDTH = SETTINGS_FIELD_WIDTH;

/**
 * A rough advance width of `text` at `fontSize`: tabular digits ~0.62em, other
 * Latin ~0.56em, CJK 1em. It sizes the typed value so the value and its unit
 * stay centered as one group inside the stepper.
 */
function approxTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    em += code >= 0x2e80 ? 1 : ch >= "0" && ch <= "9" ? 0.62 : 0.56;
  }
  return Math.ceil(em * fontSize);
}

/**
 * The one number control of the settings pages: `−` [value unit] `+` in a box
 * of fixed width flush with the row's right edge, the value and its unit
 * centered as one group. Editable when `onChangeText` is given: Return or
 * leaving the field saves what was typed (`onSubmit`), so no Save button ever
 * appears and moves the row. The empty value shows `placeholder`: the backend's
 * default, or what an empty value means ("No limit"). `leading` (a status slot,
 * Reset, No limit) sits left of the box, so it never moves the column.
 */
function SettingsNumberStepper(props: {
  /** Stable selectors for the input and its step buttons. */
  id: string;
  label?: string;
  description?: string;
  text: string;
  placeholder?: string;
  unit?: string;
  dirty?: boolean;
  readonly?: boolean;
  decreaseDisabled?: boolean;
  increaseDisabled?: boolean;
  onDecrease: () => void;
  onIncrease: () => void;
  onChangeText?: (value: string) => void;
  onSubmit?: () => void;
  onCancelEdit?: () => void;
  decimal?: boolean;
  leading?: JSX.Element;
  fill?: boolean;
}) {
  const editable = (): boolean => Boolean(props.onChangeText) && !props.readonly;
  const stepButton = () => ({
    width: compactLayout() ? 36 : controlHeight.xs,
    minHeight: compactLayout() ? 36 : controlHeight.xs,
    paddingHorizontal: 0,
    flexShrink: 0,
  });
  const fontSize = (): number => (compactLayout() ? Math.max(16, textSize(14)) : textSize(13));
  const valueStyle = () => ({
    ...textStyle("label", { color: palette().text, tabular: true }),
    fontWeight: "600" as const,
  });
  const unit = (): string => props.unit ?? "";
  /** The typed value's own width (at least three digits, so it stays easy to click). */
  const inputWidth = (): number => {
    const shown = props.text || props.placeholder || "";
    return Math.max(approxTextWidth(shown, fontSize()), approxTextWidth("000", fontSize())) + space.xs;
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.sm,
      width: props.fill ? "100%" : undefined, minWidth: 0, maxWidth: "100%" }}>
      {props.leading}
      <View
        style={{
          boxSizing: "border-box",
          width: props.fill ? undefined : NUMBER_STEPPER_WIDTH,
          flex: props.fill ? 1 : undefined,
          minWidth: 0,
          maxWidth: "100%",
          height: compactLayout() ? layout.touchTarget : controlHeight.sm,
          flexDirection: "row",
          alignItems: "center",
          padding: space.hair,
          gap: space.hair,
          borderRadius: radii.md,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: props.dirty ? palette().accent : palette().borderSubtle,
          backgroundColor: palette().inputBg,
          flexShrink: props.fill ? 1 : 0,
          ...paintTransition(MOTION_DURATION.fast),
        }}
        focusWithinStyle={{ borderColor: palette().fieldFocusBorder }}
      >
        <ActionButton
          label="−"
          variant="ghost"
          size="xs"
          accessibilityLabel={`${props.id}-decrease`}
          disabled={props.decreaseDisabled}
          style={stepButton()}
          onPress={props.onDecrease}
        />
        <View
          style={{
            flex: 1,
            minWidth: 0,
            height: "100%",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: space.xs,
          }}
        >
          <If when={editable()}>
            <Input
              value={props.text}
              testID={props.id}
              accessibilityLabel={props.label ?? props.id}
              accessibilityDescription={props.description}
              placeholder={props.placeholder ?? ""}
              keyboardType={props.decimal ? "decimal-pad" : "number-pad"}
              onChange={event => props.onChangeText?.(event.value)}
              onSubmit={() => props.onSubmit?.()}
              onKeyPress={event => {
                if (event.key === "Escape") props.onCancelEdit?.();
              }}
              onBlur={() => {
                if (props.dirty) props.onSubmit?.();
              }}
              style={{
                ...valueStyle(),
                // With a unit the field is as wide as its value, so value and unit center together;
                // without one it takes the whole middle and centers its text.
                flex: unit() ? undefined : 1,
                width: unit() ? inputWidth() : undefined,
                flexShrink: 1,
                minWidth: 0,
                height: "100%",
                paddingHorizontal: 0,
                textAlign: "center",
                placeholderColor: palette().textMuted,
                caretColor: palette().accent,
                fontFamily: inputFontSans(),
                fontSize: fontSize(),
                backgroundColor: "transparent",
                borderWidth: 0,
              }}
            />
          </If>
          <If when={!editable()}>
            <Text
              testID={props.id}
              accessibilityLabel={props.label ?? props.id}
              accessibilityDescription={props.description}
              style={{
                ...valueStyle(),
                color: props.text ? palette().text : palette().textMuted,
                flexShrink: 1,
                minWidth: 0,
                textAlign: "center",
                numberOfLines: 1,
              }}
            >
              {props.text || props.placeholder || ""}
            </Text>
          </If>
          <If when={unit()}>
            {value => (
              <Text style={{ ...textStyle("caption", { tabular: true }), flexShrink: 0, numberOfLines: 1 }}>
                {value()}
              </Text>
            )}
          </If>
        </View>
        <ActionButton
          label="+"
          variant="ghost"
          size="xs"
          accessibilityLabel={`${props.id}-increase`}
          disabled={props.increaseDisabled}
          style={stepButton()}
          onPress={props.onIncrease}
        />
      </View>
    </View>
  );
}

/** A quiet icon button left of a number box (reset to the default); the tooltip names it. */
function StepperAccessory(props: { icon: IconName; tooltip: string; accessibilityLabel: string; onPress: () => void }) {
  return (
    <IconButton
      icon={props.icon}
      size="sm"
      tooltip={props.tooltip}
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
    />
  );
}

/**
 * A slot of fixed size left of a number box, so what appears in it (a saving
 * spinner, Reset) never moves the box or the row's text.
 */
function StepperSlot(props: { width: number; children?: JSX.Element }) {
  return (
    <View
      style={{
        width: props.width,
        height: controlHeight.sm,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {props.children}
    </View>
  );
}

/**
 * The reserved status slot left of a settings control: a spinner while its
 * write is in flight, a quiet check for a moment after it landed, empty
 * otherwise. Its width never changes, so the control and the row never move.
 */
function FieldStatus(props: { saving: boolean; saved: boolean }) {
  return (
    <StepperSlot width={space.lg}>
      <If when={props.saving}>
        <Spinner size={12} color={palette().accent} />
      </If>
      <If when={!props.saving && props.saved}>
        <View accessibilityLabel="settings-field-saved">
          <Icon name="check" size={13} color={palette().textMuted} />
        </View>
      </If>
    </StepperSlot>
  );
}

/**
 * A number field: `−` / `+` step and save at once (clamped, from the typed
 * value when there is one), and the value can also be typed — Return or
 * leaving the field saves it. Empty shows the backend's default
 * (`get_settings_schema`), or "No limit" for a value the host keeps as
 * `Option` and holds unset; such a value has a "No limit" action, any other a
 * Reset to the backend's default.
 */
function NumberControl(props: { spec: FieldSpec; disabled?: boolean }) {
  const spec = props.spec;
  const unavailable = () => props.disabled || (fieldMissing(spec) && defaultForField(spec) === undefined && !spec.clearable);
  const value = (): number | null => {
    const raw = fieldDisplay(spec);
    if (raw === undefined || raw === null || raw === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const backendDefault = (): number | null => {
    const fallback = defaultForField(spec);
    return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : null;
  };
  /** An `Option` value held unset: the host applies no limit. */
  const noLimit = (): boolean => spec.clearable === true && value() === null;
  const placeholder = (): string => {
    if (noLimit()) return tr("settings.placeholder.noLimit");
    const fallback = backendDefault();
    return fallback !== null ? String(fallback) : fieldPlaceholder(spec);
  };
  const showsUnit = (): boolean => !(noLimit() && draftOf(spec).trim() === "");
  const min = () => minForField(spec);
  const max = () => maxForField(spec);
  /** The value the steppers start from: what is typed, else what is stored. */
  const stepBase = (): number | null => {
    const typed = drafts()[spec.id]?.trim() ?? "";
    const typedNumber = typed ? Number(typed) : Number.NaN;
    return Number.isFinite(typedNumber) ? typedNumber : value();
  };
  const resettable = (): boolean => {
    const fallback = backendDefault();
    return !spec.clearable && fallback !== null && value() !== null && value() !== fallback;
  };
  return (
    <SettingsNumberStepper
      id={spec.id}
      label={fieldLabel(spec)}
      description={fieldHint(spec)}
      fill
      text={draftOf(spec)}
      placeholder={placeholder()}
      unit={showsUnit() ? fieldUnit(spec) : undefined}
      decimal={Boolean(spec.precision)}
      dirty={fieldDirty(spec)}
      readonly={unavailable()}
      decreaseDisabled={unavailable() || fieldSaving(spec) || (stepBase() !== null && stepBase()! <= (min() ?? Number.NEGATIVE_INFINITY))}
      increaseDisabled={unavailable() || fieldSaving(spec) || (stepBase() !== null && max() !== undefined && stepBase()! >= max()!)}
      onDecrease={() => stepNumber(spec, -1)}
      onIncrease={() => stepNumber(spec, 1)}
      onChangeText={text => setDraft(spec, text)}
      onSubmit={() => { if (!unavailable()) void commitDraft(spec); }}
      leading={
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <FieldStatus saving={fieldSaving(spec)} saved={fieldJustSaved(spec.id)} />
          <If when={!unavailable() && spec.clearable === true && !noLimit()}>
            <Button
              label={tr("settings.placeholder.noLimit")}
              tooltip={tr("settings.field.clearLimit")}
              variant="ghost"
              size="sm"
              disabled={fieldSaving(spec)}
              accessibilityLabel={`${spec.id}-clear`}
              onPress={() => {
                clearDraft(spec);
                void writeField(spec, null);
              }}
            />
          </If>
          <If when={!spec.clearable && backendDefault() !== null}>
            <StepperSlot width={controlHeight.sm}>
              <If when={!unavailable() && resettable() && !fieldDirty(spec)}>
                <StepperAccessory
                  icon="undo"
                  tooltip={tr("settings.field.resetToDefault", { value: String(backendDefault() ?? "") })}
                  accessibilityLabel={`${spec.id}-reset`}
                  onPress={() => void writeField(spec, backendDefault())}
                />
              </If>
            </StepperSlot>
          </If>
        </View>
      }
    />
  );
}

/**
 * A text field prefilled with what is stored. Return or Save writes it; Save is
 * always there (quiet until the text differs), so the row never shifts.
 */
function TextControl(props: { spec: FieldSpec }) {
  const spec = props.spec;
  const unavailable = () => fieldMissing(spec) && defaultForField(spec) === undefined;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        width: "100%",
        minWidth: 0,
        flexShrink: 1,
        maxWidth: "100%",
      }}
    >
      <InputBox
        size="sm"
        value={draftOf(spec)}
        placeholder={unavailable() ? tr("common.unavailable").toLowerCase() : fieldPlaceholder(spec)}
        masked={spec.masked === true}
        readonly={unavailable()}
        disabled={unavailable()}
        testID={spec.id}
        accessibilityLabel={fieldLabel(spec)}
        accessibilityDescription={fieldHint(spec)}
        style={{ flex: 1, minWidth: 0 }}
        onChange={value => setDraft(spec, value)}
        onSubmit={() => void commitDraft(spec)}
      />
      <If when={!unavailable()}>
        <RowSaveButton spec={spec} dirty={fieldDirty(spec)} onPress={() => void commitDraft(spec)} />
      </If>
    </View>
  );
}

function fieldDescription(spec: FieldSpec): string {
  const hint = fieldHint(spec) ?? "";
  const value = fieldDisplay(spec);
  const reason = spec.options?.find(option => option.value === value)?.disabledReason;
  return reason ? [hint, tr(reason)].filter(Boolean).join(" ") : hint;
}

/** Fields the desktop sets through product control, which also applies them on the host. */
const GENERAL_CONTROL_FOR: Record<string, GeneralControlOption> = {
  "auto-update": "auto-update",
  "prevent-sleep": "prevent-sleep",
};

function FieldRow(props: { spec: FieldSpec; first?: boolean; disabled?: boolean; unsupported?: boolean }) {
  const spec = props.spec;
  const control = GENERAL_CONTROL_FOR[spec.id];
  const controlled = (): boolean => Boolean(control) && generalControlValue(control) !== undefined;
  const checked = (): boolean => (controlled() ? generalControlValue(control) === true : fieldDisplay(spec) === true);
  const saving = (): boolean => fieldSaving(spec) || (Boolean(control) && generalControlSaving() === control);
  const description = (): string => props.unsupported ? unsupportedOnDevice()
    : controlled() ? (fieldHint(spec) ?? "") : fieldDescription(spec);
  const disabled = () => props.disabled || props.unsupported;
  const controlWidth = () => {
    if (spec.kind === "boolean" || (spec.kind === "select" && segmentedFits(spec))) return undefined;
    if (spec.kind === "text") return SETTINGS_FIELD_WIDTH + SETTINGS_SAVE_BUTTON_WIDTH + space.sm;
    return SETTINGS_FIELD_WIDTH;
  };
  return (
    <SettingsRow testID={`settings-row-${spec.id}`} label={fieldLabel(spec)} description={description()}
      first={props.first} controlWidth={controlWidth()}>
      <If when={spec.kind === "boolean"}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <FieldStatus saving={saving()} saved={fieldJustSaved(spec.id)} />
          <ToggleSwitch
            value={checked()}
            testID={spec.id}
            accessibilityLabel={fieldLabel(spec)}
            accessibilityDescription={description() || undefined}
            disabled={disabled() || saving()}
            onChange={next => void (controlled() ? setGeneralControl(control, next) : writeField(spec, next))}
          />
        </View>
      </If>
      <If when={spec.kind === "select"}>
        <ChoiceControl spec={spec} disabled={disabled()} />
      </If>
      <If when={spec.kind === "model"}>
        <ModelChoiceControl spec={spec} disabled={disabled()} />
      </If>
      <If when={spec.kind === "model-target"}>
        <ModelTargetChoiceControl spec={spec} disabled={disabled()} />
      </If>
      <If when={spec.kind === "number"}>
        <NumberControl spec={spec} disabled={disabled()} />
      </If>
      <If when={spec.kind === "text"}>
        <TextControl spec={spec} />
      </If>
    </SettingsRow>
  );
}

/** A field section from the table, drawn as one card with its own notice. */
function FieldSection(props: {
  sectionId: string;
  children?: JSX.Element;
  leading?: JSX.Element;
  expanded?: boolean;
  onToggle?: () => void;
  extra?: JSX.Element;
  unavailable?: (spec: FieldSpec) => boolean;
}) {
  const section = SETTINGS_SECTIONS.find(entry => entry.id === props.sectionId);
  if (!section) return null;
  const hasLeading = Boolean(props.leading);
  return (
    <SettingsGroup
      id={section.id}
      title={sectionTitle(section)}
      hideTitle={sectionTitle(section) === tr(settingsPageEntry(section.page).labelKey)}
      notice={sectionNotice(section.id)}
      onDismissNotice={() => setSectionNotice(section.id, "")}
      expanded={props.expanded}
      extra={props.onToggle ? (
        <View
          role="button"
          accessibilityLabel={`${section.id}-toggle`}
          accessibilityState={{ expanded: props.expanded }}
          tooltip={sectionTitle(section)}
          onPress={props.onToggle}
          style={{
            width: layout.touchTarget,
            height: layout.touchTarget,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: radii.md,
            cursor: "pointer",
          }}
          hoverStyle={{ backgroundColor: palette().surfaceSubtle }}
          activeStyle={tactileActiveStyle(0.99)}
          focusVisibleStyle={focusRingStyle()}
        >
          <View style={rotatingChevronStyle(props.expanded === true)}>
            <Icon name="chevron-right" size={14} color={palette().textMuted} />
          </View>
        </View>
      ) : props.extra}
    >
      {props.leading}
      <Each of={section.fields} key={field => field.id}>
        {(field, index) => <FieldRow spec={field()} first={!hasLeading && index() === 0}
          unsupported={props.unavailable?.(field())} />}
      </Each>
      {props.children}
    </SettingsGroup>
  );
}

function matchesNoticeTemplate(text: string, templateKey: MessageKey, placeholder: string): boolean {
  const sentinel = "\u0000";
  const rendered = tr(templateKey, { [placeholder]: sentinel });
  const idx = rendered.indexOf(sentinel);
  if (idx < 0) return text === rendered;
  const prefix = rendered.slice(0, idx);
  const suffix = rendered.slice(idx + sentinel.length);
  return text.length >= prefix.length + suffix.length && text.startsWith(prefix) && text.endsWith(suffix);
}

function settingsNoticeTone(notice: string): "danger" | "warning" | "success" | "info" {
  if (
    notice === tr("settings.memory.resetDone") ||
    notice === tr("settings.memory.settingsResetDone") ||
    matchesNoticeTemplate(notice, "settings.notice.savedField", "label") ||
    matchesNoticeTemplate(notice, "settings.notice.languageSaved", "label")
  ) {
    return "success";
  }
  if (
    notice === tr("settings.notice.memoryWindowRefusal") ||
    notice === tr("settings.appearance.fontSaveFailed") ||
    notice === tr("settings.notice.hostUpdateRequired") ||
    notice === tr("settings.permissions.timeoutValidation") ||
    matchesNoticeTemplate(notice, "settings.notice.needsNumber", "label")
  ) {
    return "danger";
  }
  if (notice === tr("settings.notice.languageNotPersisted")) {
    return "warning";
  }
  const lower = notice.toLowerCase();
  if (
    lower.includes("needs a number") ||
    lower.includes("cannot") ||
    lower.includes("failed") ||
    lower.includes("error") ||
    lower.includes("invalid") ||
    lower.includes("refused") ||
    lower.includes("at most") ||
    lower.includes("must be")
  ) {
    return "danger";
  }
  if (lower.includes("warning") || lower.includes("unavailable")) {
    return "warning";
  }
  if (lower.includes("stores no value yet") || lower.includes("these are its defaults")) {
    return "info";
  }
  return "success";
}

/** Calm bordered toggle button used for inline option selectors in Settings editors. */
function SelectableChip(props: {
  label: string;
  active: boolean;
  tone?: "accent" | "warning" | "danger";
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const activeBg = (): string => {
    if (!props.active) return "transparent";
    if (props.tone === "danger") return palette().dangerSoft;
    if (props.tone === "warning") return palette().warningSoft;
    return palette().accentSoft;
  };
  const activeBorder = (): string => {
    if (!props.active) return palette().borderSubtle;
    if (props.tone === "danger") return palette().dangerBorder;
    if (props.tone === "warning") return palette().warningBorder;
    return palette().accentBorder;
  };
  const activeColor = (): string => {
    if (!props.active) return palette().textSecondary;
    if (props.tone === "danger") return stateColor("failed");
    if (props.tone === "warning") return stateColor("needs_you");
    return palette().text;
  };
  return (
    <View
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ selected: props.active }}
      hitSlop={touchSlop(controlHeight.sm)}
      onPress={props.onPress}
      style={{
        minHeight: compactLayout() ? layout.touchTarget : controlHeight.sm,
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radii.md,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: activeBorder(),
        backgroundColor: activeBg(),
        cursor: "pointer",
        userSelect: "none",
        ...pressTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{ backgroundColor: props.active ? activeBg() : palette().surfaceSubtle }}
      activeStyle={tactileActiveStyle(0.98)}
      focusVisibleStyle={focusRingStyle()}
    >
      <Text
        style={{
          ...textStyle("caption"),
          color: activeColor(),
          fontWeight: props.active ? "600" : "500",
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}

function formatResetAt(raw: string | number): string {
  const text = String(raw).trim();
  if (!text) return "";
  const isIso = /^\d{4}-\d{2}-\d{2}T/.test(text);
  const numeric = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
  const isEpoch = Number.isFinite(numeric) && numeric >= 1_000_000_000;
  if (!isIso && !isEpoch) {
    return tr("settings.subscriptions.resetsAt", { time: text });
  }
  const ms = isEpoch ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : Date.parse(text);
  if (!Number.isFinite(ms)) {
    return tr("settings.subscriptions.resetsAt", { time: text });
  }
  const diffMs = ms - Date.now();
  if (diffMs > 0 && diffMs < 48 * 3_600_000) {
    if (diffMs < 60_000) return tr("settings.subscriptions.resetsSoon");
    // Strict carry policy via `formatDuration`: rounds seconds/minutes cleanly so `1h 60m` never renders.
    const formatted = formatDuration(Math.round(diffMs / 60_000) * 60_000);
    return tr("settings.subscriptions.resetsIn", { time: formatted });
  }
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return tr("settings.subscriptions.resetsAt", { time: stamp });
}

/** A choice drawn as a list row with a trailing check when it is the current one. */
function ChoiceRow(props: {
  label: string;
  detail?: string;
  icon?: IconName;
  selected: boolean;
  /** The check and label take the warning color (a risky choice). */
  warning?: boolean;
  first: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: props.selected, disabled: Boolean(props.disabled) }}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      style={{
        position: "relative",
        minHeight: SETTINGS_ROW_MIN,
        paddingHorizontal: SETTINGS_ROW_INSET,
        paddingVertical: space.md,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        cursor: props.disabled ? undefined : "pointer",
        userSelect: "none",
        opacity: props.disabled ? 0.5 : 1,
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={props.disabled ? undefined : { backgroundColor: palette().panelHover }}
      activeStyle={props.disabled ? undefined : tactileActiveStyle(0.985)}
      focusVisibleStyle={focusRingStyle()}
    >
      <If when={!props.first}>
        <RowSeparator edge="top" inset={props.icon ? 44 : SETTINGS_ROW_INSET} />
      </If>
      {/* Glyph and check sit on the label line; the detail hangs under the label. */}
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
        <If when={props.icon ?? ""}>
          {icon => (
            <View style={{ height: settingsRowLabelLineHeight(), flexShrink: 0, justifyContent: "center" }}>
              <Icon
                name={icon() as IconName}
                size={16}
                color={props.selected && props.warning ? stateColor("needs_you") : palette().textMuted}
              />
            </View>
          )}
        </If>
        <View style={{ flex: 1, minWidth: 0, gap: space.hair }}>
          <Text
            style={{
              ...textStyle("body", {
                color: props.selected && props.warning ? stateColor("needs_you") : palette().text,
              }),
              fontWeight: props.selected ? "500" : "400",
            }}
          >
            {props.label}
          </Text>
          <If when={props.detail ?? ""}>
            {detail => (
              <Text style={textStyle("caption")}>
                {detail()}
              </Text>
            )}
          </If>
        </View>
        <View style={{ width: 16, height: settingsRowLabelLineHeight(), alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <If when={props.selected}>
            <Icon name="check" size={14} color={props.warning ? stateColor("needs_you") : palette().accent} />
          </If>
        </View>
      </View>
    </View>
  );
}

/** Line height of a settings row's label (`body`); glyphs and the check centre on it. */
function settingsRowLabelLineHeight(): number {
  return textStyle("body").lineHeight as number;
}

function PermissionsSection() {
  useDeviceScopedLoad("permissions", ensurePermissions, () => {
    void loadPermissions();
    void loadDecisionModel();
  });
  const rulesModalOpen = usePresenceFlag(() => ruleDraft() !== null);
  const modeLabel = (mode: PermissionMode): string => tr(PERMISSION_MODE_META[mode].labelKey);
  const modeHint = (mode: PermissionMode): string => tr(PERMISSION_MODE_META[mode].hintKey);

  return (
    <If when={permissionsSupported() !== false}>
      <View style={{ gap: layout.sectionGap }}>
        <SettingsSection
          title={tr("settings.permissions.title")}
          flush={true}
          subtitle={
            permissionMode() === null ? tr("settings.permissions.reading") : tr("settings.permissions.modeIntro")
          }
          notice={permissionsNotice()}
          onDismissNotice={() => permissionsNotice.set("")}
        >
          <Each of={PERMISSION_MODES} key={entry => entry.value}>
            {(entry, index) => (
              <ChoiceRow
                label={modeLabel(entry().value)}
                detail={modeHint(entry().value)}
                icon={PERMISSION_MODE_META[entry().value].icon}
                selected={permissionMode() === entry().value}
                first={index() === 0}
                accessibilityLabel={`permission-mode-${entry().value}`}
                onPress={() => void choosePermissionMode(entry().value)}
              />
            )}
          </Each>
          <If when={pendingFullAccess()}>
            <View
              style={{
                position: "relative",
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: space.md,
                paddingHorizontal: SETTINGS_ROW_INSET,
                paddingVertical: space.md,
                minHeight: SETTINGS_ROW_MIN,
              }}
            >
              <RowSeparator edge="top" />
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, flex: 1, minWidth: 200 }}>
                <View style={{ flexShrink: 0, marginTop: space.hair }}>
                  <Icon name="info" size={14} color={palette().textSecondary} />
                </View>
                <Text
                  style={{
                    ...textStyle("caption", { color: palette().textSecondary }),
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {tr("settings.permissions.fullAccessWarning")}
                </Text>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", flexShrink: 0, gap: space.sm, marginLeft: "auto" }}>
                <Button
                  label={tr("common.cancel")}
                  variant="ghost"
                  size="sm"
                  accessibilityLabel="cancel-full-access"
                  onPress={() => cancelFullAccess()}
                />
                <Button
                  label={tr("settings.permissions.allowEverything")}
                  variant="primary"
                  size="sm"
                  accessibilityLabel="confirm-full-access"
                  onPress={() => void choosePermissionMode("full_access")}
                />
              </View>
            </View>
          </If>
        </SettingsSection>

        <SettingsSection title={tr("settings.polish.globalRules")} flush={true}>
          <ConfigRow
            label={tr("settings.permissions.globalRulesTitle")}
            description={formatPlural(
              permissionRuleCount(),
              "settings.permissions.rulesInForceOne",
              "settings.permissions.rulesInForceOther",
            )}
            divider={permissionModeControl() !== null}
            descriptionTabular={true}
          >
            <Button
              label={tr("settings.permissions.editRules")}
              variant="secondary"
              size="sm"
              accessibilityLabel="edit-permission-rules"
              onPress={() => beginRulesDraft()}
            />
          </ConfigRow>
          <If when={permissionModeControl() !== null}>
            <ConfigRow
              label={
                permissionModeControl() === true
                  ? tr("settings.permissions.composerSwitchOn")
                  : tr("settings.permissions.composerSwitchOff")
              }
              description={tr("settings.permissions.composerSwitchHint")}
              divider={false}
            >
              <ToggleSwitch
                value={permissionModeControl() === true}
                accessibilityLabel="permission-mode-control"
                onChange={next => void setPermissionModeControl(next)}
              />
            </ConfigRow>
          </If>
        </SettingsSection>

        <ModalDialog
          open={rulesModalOpen()}
          title={tr("settings.permissions.globalRulesTitle")}
          subtitle={tr("settings.permissions.globalRulesHint")}
          size="lg"
          accessibilityLabel="permission-rules-modal"
          onClose={() => discardRuleDraft()}
          footer={
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, flex: 1 }}>
              <Button
                label={tr("settings.permissions.addRule")}
                variant="secondary"
                size="md"
                leadingIcon="plus"
                accessibilityLabel="add-permission-rule"
                onPress={() => addPermissionRule()}
              />
              <Text
                style={{
                  ...textStyle("caption"),
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {localizeHostError(rulesNotice())}
              </Text>
              <Button
                label={tr("common.discardChanges")}
                variant="ghost"
                size="md"
                accessibilityLabel="discard-permission-rules"
                onPress={() => discardRuleDraft()}
              />
              <Button
                label={tr("settings.permissions.saveRules")}
                variant="primary"
                size="md"
                accessibilityLabel="save-permission-rules"
                onPress={() => void saveRuleDraft()}
              />
            </View>
          }
        >
          <If when={ruleDraft() !== null}>
            <View style={{ gap: space.md }}>
              <View
                style={{
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  borderRadius: radii.md,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: palette().borderSubtle,
                  backgroundColor: palette().surfaceTertiary,
                }}
              >
                <Text style={textStyle("mono", { color: palette().textMuted })}>
                  {tr("settings.permissions.validActions", {
                    actions: PERMISSION_ACTIONS.join(" · "),
                  })}
                </Text>
              </View>
              <If when={(ruleDraft() ?? []).length === 0}>
                <Text style={textStyle("caption")}>
                  {tr("settings.permissions.noCustomRules")}
                </Text>
              </If>
              <Each of={ruleDraft() ?? []} key={rule => rule.localId}>
                {(rule, index) => (
                  <View
                    style={{
                      gap: space.md,
                      paddingTop: index() === 0 ? space.xs : space.md,
                      paddingBottom: space.hair,
                      borderTopWidth: index() === 0 ? 0 : 1,
                      borderColor: palette().borderSubtle,
                    }}
                  >
                    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
                      <Badge label={`#${index() + 1}`} tone="neutral" />
                      <SegmentedTabs
                        size={compactLayout() ? "md" : "sm"}
                        value={rule().effect}
                        options={PERMISSION_EFFECTS.map(effect => ({
                          value: effect.value,
                          label: tr(PERMISSION_EFFECT_KEYS[effect.value]),
                          tone: effect.value === "deny" ? "danger" : effect.value === "allow" ? "accent" : "warning",
                          accessibilityLabel: `permission-rule-${rule().localId}-effect-${effect.value}`,
                        }))}
                        onChange={value => patchPermissionRule(rule().localId, { effect: value })}
                      />
                      <View style={{ flex: 1 }} />
                      <IconButton
                        icon="arrow-up"
                        size="xs"
                        tooltip={tr("common.up")}
                        disabled={index() === 0}
                        accessibilityLabel={`permission-rule-${rule().localId}-up`}
                        onPress={() => movePermissionRule(rule().localId, -1)}
                      />
                      <IconButton
                        icon="chevron-down"
                        size="xs"
                        tooltip={tr("common.down")}
                        disabled={index() >= (ruleDraft()?.length ?? 1) - 1}
                        accessibilityLabel={`permission-rule-${rule().localId}-down`}
                        onPress={() => movePermissionRule(rule().localId, 1)}
                      />
                      <IconButton
                        icon="trash"
                        size="xs"
                        tone="danger"
                        tooltip={tr("common.remove")}
                        accessibilityLabel={`permission-rule-${rule().localId}-remove`}
                        onPress={() => removePermissionRule(rule().localId)}
                      />
                    </View>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                      <View style={{ flex: 1, minWidth: 140, gap: 5 }}>
                        <Text style={textStyle("label", { color: palette().textSecondary })}>
                          {tr("settings.permissions.action")}
                        </Text>
                        <SelectDropdown
                          size="md"
                          fullWidth={true}
                          searchable={true}
                          value={rule().action}
                          placeholder={tr("settings.permissions.actionPlaceholder")}
                          options={[
                            ...PERMISSION_ACTIONS.map(action => ({
                              value: action,
                              label: action === "*" ? tr("settings.permissions.anyAction") : action,
                              accessibilityLabel: `permission-rule-${rule().localId}-action-${action}`,
                            })),
                            // An action a tool reported that the list does not name stays selectable.
                            ...(rule().action && !PERMISSION_ACTIONS.includes(rule().action)
                              ? [
                                  {
                                    value: rule().action,
                                    label: rule().action,
                                    accessibilityLabel: `permission-rule-${rule().localId}-action-${rule().action}`,
                                  },
                                ]
                              : []),
                          ]}
                          accessibilityLabel={`permission-rule-${rule().localId}-action`}
                          onChange={val => patchPermissionRule(rule().localId, { action: val })}
                        />
                      </View>
                      <InputBox
                        label={tr("settings.permissions.resourcePattern")}
                        size="md"
                        monospace
                        value={rule().resource}
                        placeholder={tr("settings.permissions.resourcePlaceholder")}
                        accessibilityLabel={`permission-rule-${rule().localId}-resource`}
                        style={{ flex: 2, minWidth: 200 }}
                        onChange={val => patchPermissionRule(rule().localId, { resource: val })}
                      />
                    </View>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </ModalDialog>

        <ApprovalSection />
      </View>
    </If>
  );
}

function ApprovalSection() {
  const kind = (): "chat" | "decision" => approvalSettings()?.modelKind ?? "chat";
  const pick = (field: string, fallback = ""): string => approvalDrafts()[field] ?? fallback;
  const approvalTimeoutDirty = (): boolean => {
    const typed = approvalDrafts().timeout;
    return typed !== undefined && typed.trim() !== String(approvalSettings()?.timeoutSeconds ?? "");
  };
  const clearTimeoutDraft = (): void =>
    approvalDrafts.update(current => {
      if (!("timeout" in current)) return current;
      const next = { ...current };
      delete next.timeout;
      return next;
    });
  // The host bounds the timeout and answers with what it stored.
  const saveApprovalTimeout = (): void => {
    const typed = pick("timeout").trim();
    if (!typed) {
      clearTimeoutDraft();
      return;
    }
    const seconds = Number.parseInt(typed, 10);
    if (!Number.isFinite(seconds)) {
      approvalNotice.set(tr("settings.permissions.timeoutValidation"));
      return;
    }
    clearTimeoutDraft();
    void saveApproval({ timeoutSeconds: seconds });
  };
  const stepApprovalTimeout = (direction: 1 | -1): void => {
    // A typed number is the base, so a step after typing keeps what was typed.
    const typed = Number.parseInt(pick("timeout").trim(), 10);
    const current = Number.isFinite(typed) ? typed : approvalSettings()?.timeoutSeconds;
    if (current === undefined) return;
    clearTimeoutDraft();
    void saveApproval({ timeoutSeconds: Math.max(1, current + direction) });
  };
  return (
    // Until Auto is chosen there is nothing to set here: the title and the line
    // that says so, without an empty card under them.
    <If
      when={permissionMode() === "auto"}
      else={
        <View style={{ minWidth: 0 }}>
          <SectionHeader title={tr("settings.permissions.autoTitle")} description={tr("settings.permissions.autoHint")} />
          <SectionNoticeBanner notice={approvalNotice()} onDismiss={() => approvalNotice.set("")} />
        </View>
      }
    >
      <SettingsSection
        title={tr("settings.permissions.autoTitle")}
        flush={true}
        notice={approvalNotice()}
        onDismissNotice={() => approvalNotice.set("")}
      >
        <ConfigRow label={tr("settings.polish.assessedBy")}>
          <SegmentedTabs
            size="sm"
            value={kind()}
            options={[
              {
                value: "chat",
                label: tr("settings.permissions.chatModel"),
                accessibilityLabel: "approval-kind-chat",
              },
              {
                value: "decision",
                label: tr("settings.permissions.decisionModel"),
                accessibilityLabel: "approval-kind-decision",
              },
            ]}
            onChange={value => void saveApproval({ modelKind: value as "chat" | "decision" })}
          />
        </ConfigRow>
        <If when={kind() === "chat"}>
          <View style={{ position: "relative" }}>
            <View style={{ paddingHorizontal: SETTINGS_ROW_INSET, paddingTop: 10, paddingBottom: 6 }}>
              <Text style={textStyle("caption")}>
                {approvalModels().length === 0
                  ? tr("settings.permissions.noApprovalModels")
                  : tr("settings.permissions.chatApprovalHint")}
              </Text>
            </View>
            <Each of={approvalModels()} key={option => option.value}>
              {(option, index) => (
                <ChoiceRow
                  label={option().label}
                  detail={option().hint}
                  selected={approvalSettings()?.chatModelId === option().value}
                  first={index() === 0}
                  disabled={Boolean(option().disabled)}
                  accessibilityLabel={`approval-model-${option().value}`}
                  onPress={() => void saveApproval({ chatModelId: option().value })}
                />
              )}
            </Each>
            <RowSeparator edge="bottom" />
          </View>
        </If>
        <If when={kind() === "decision"}>
          <ConfigRow
            label={tr("settings.permissions.decisionModel")}
            description={tr("settings.permissions.decisionModelHint")}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
              <InputBox
                size="sm"
                value={pick("decision-name")}
                placeholder={decisionModel()?.modelName || tr("settings.permissions.decisionModelNamePlaceholder")}
                accessibilityLabel="approval-decision-name"
                style={{ flex: 1, minWidth: 120 }}
                onChange={val => approvalDrafts.update(current => ({ ...current, "decision-name": val }))}
              />
              <InputBox
                size="sm"
                monospace
                value={pick("decision-endpoint")}
                placeholder={decisionModel()?.endpoint || tr("settings.permissions.decisionEndpointPlaceholder")}
                accessibilityLabel="approval-decision-endpoint"
                style={{ flex: 2, minWidth: 160 }}
                onChange={val => approvalDrafts.update(current => ({ ...current, "decision-endpoint": val }))}
              />
              <Button
                label={tr("settings.field.saveShort")}
                variant="secondary"
                size="sm"
                disabled={pick("decision-name").trim().length === 0 && pick("decision-endpoint").trim().length === 0}
                accessibilityLabel="save-approval-decision"
                onPress={() =>
                  void saveDecisionModel(
                    pick("decision-name") || (decisionModel()?.modelName ?? ""),
                    pick("decision-endpoint") || (decisionModel()?.endpoint ?? ""),
                  )
                }
              />
            </View>
          </ConfigRow>
          <If when={decisionCredential() !== null}>
            <ConfigRow label={tr("settings.polish.decisionKey")}>
              <InputBox
                size="sm"
                leadingIcon="key"
                masked
                value={pick("decision-secret")}
                placeholder={
                  decisionCredential()
                    ? tr("settings.permissions.keyConfiguredReplace")
                    : tr("settings.permissions.decisionKeyPlaceholder")
                }
                accessibilityLabel="approval-decision-secret"
                style={{ flex: 1, minWidth: 140, maxWidth: settingsCompact() ? "100%" : 220 }}
                onChange={val => approvalDrafts.update(current => ({ ...current, "decision-secret": val }))}
              />
              <Button
                label={tr("settings.field.saveShort")}
                variant="secondary"
                size="sm"
                disabled={pick("decision-secret").trim().length === 0}
                accessibilityLabel="save-approval-decision-key"
                onPress={() => void saveDecisionCredential(pick("decision-secret"))}
              />
              <If when={decisionCredential() === true}>
                <IconButton
                  icon="trash"
                  size="sm"
                  tone="danger"
                  tooltip={tr("settings.permissions.removeKey")}
                  accessibilityLabel="clear-approval-decision-key"
                  onPress={() => void clearDecisionCredential()}
                />
              </If>
            </ConfigRow>
          </If>
        </If>
        <ConfigRow label={tr("settings.permissions.timeout")}>
          <SettingsNumberStepper
            id="approval-timeout"
            text={pick("timeout", approvalSettings() ? String(approvalSettings()!.timeoutSeconds) : "")}
            unit={tr("settings.unit.seconds")}
            dirty={approvalTimeoutDirty()}
            readonly={!approvalSettings()}
            decreaseDisabled={!approvalSettings() || (approvalSettings()?.timeoutSeconds ?? 0) <= 1}
            increaseDisabled={!approvalSettings()}
            onDecrease={() => stepApprovalTimeout(-1)}
            onIncrease={() => stepApprovalTimeout(1)}
            onChangeText={val => approvalDrafts.update(current => ({ ...current, timeout: val }))}
            onSubmit={() => saveApprovalTimeout()}
          />
        </ConfigRow>
        <ConfigRow label={tr("settings.permissions.whenUnsure")}>
          <SegmentedTabs
            size="sm"
            value={approvalSettings()?.onAsk ?? "user"}
            options={[
              { value: "user", label: tr("settings.permissions.askMe"), accessibilityLabel: "approval-on-ask-user" },
              { value: "reject", label: tr("sessions.reject"), accessibilityLabel: "approval-on-ask-reject" },
            ]}
            onChange={val => void saveApproval({ onAsk: val === "reject" ? "reject" : "user" })}
          />
        </ConfigRow>
        <ConfigRow label={tr("settings.permissions.whenFails")} divider={false}>
          <SegmentedTabs
            size="sm"
            value={approvalSettings()?.onError ?? "ask"}
            options={[
              { value: "ask", label: tr("settings.permissions.askMe"), accessibilityLabel: "approval-on-error-ask" },
              { value: "reject", label: tr("sessions.reject"), accessibilityLabel: "approval-on-error-reject" },
            ]}
            onChange={val => void saveApproval({ onError: val === "reject" ? "reject" : "ask" })}
          />
        </ConfigRow>
      </SettingsSection>
    </If>
  );
}

function SendPolicySection() {
  useDeviceScopedLoad("send-policy", ensureSendPolicy, () => void loadSendPolicy());
  const currentHint = (): string => {
    const entry = MID_TURN_KEYS[midTurnSendPolicy()];
    return entry ? tr(entry.hintKey) : tr("settings.sendPolicy.queueHint");
  };
  return (
    <SettingsSection
      flush={true}
      title={tr("settings.sendPolicy.title")}
      subtitle={tr("settings.sendPolicy.subtitle")}
      notice={sendPolicyNotice()}
      onDismissNotice={() => sendPolicyNotice.set("")}
    >
      <ConfigRow
        label={tr("settings.sendPolicy.duringTurn")}
        description={currentHint()}
        divider={false}
      >
        <SegmentedTabs
          size="sm"
          value={midTurnSendPolicy()}
          options={MID_TURN_POLICIES.map(entry => ({
            value: entry.value,
            label: tr(MID_TURN_KEYS[entry.value].labelKey),
            accessibilityLabel: `mid-turn-policy-${entry.value}`,
          }))}
          onChange={value => void chooseMidTurnSendPolicy(value)}
        />
      </ConfigRow>
    </SettingsSection>
  );
}

function BtwCloseSettingsSection() {
  return (
    <SettingsSection title={tr("btw.closeSettingsTitle")} flush>
      <SettingsRow label={tr("btw.confirmCloseSetting")} description={tr("btw.confirmCloseDescription")} first>
        <ToggleSwitch
          value={confirmBtwClose()}
          testID="btw-confirm-close-setting"
          accessibilityLabel={tr("btw.confirmCloseSetting")}
          onChange={setConfirmBtwClose}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

function DraftRow(props: {
  id: string;
  label: string;
  hint: string;
  action: string;
  placeholder?: string;
  monospace?: boolean;
  onSave: (value: string) => void;
}) {
  const value = (): string => drafts()[props.id] ?? "";
  return (
    <ConfigRow
      label={props.label}
      description={props.hint}
      topDivider={true}
      divider={false}
      controlWidth={settingsCompact() ? undefined : 300}
      controlAlign="stretch"
    >
      <InlineFieldSaveGroup
        value={value()}
        onChange={val => drafts.update(current => ({ ...current, [props.id]: val }))}
        onSave={() => props.onSave(value())}
        placeholder={props.placeholder ?? tr("settings.field.newValuePlaceholder")}
        saveLabel={tr("settings.field.saveShort")}
        size="sm"
        monospace={props.monospace}
        dirty={value().trim().length > 0}
        inputAccessibilityLabel={props.id}
        saveAccessibilityLabel={`${props.id}-save`}
      />
    </ConfigRow>
  );
}

function WebSearchSection() {
  useDeviceScopedLoad("web-search", ensureWebSearch, () => void loadWebSearch());
  const providerId = (): string => selectedProvider();
  const providerEntry = () => providerOf(providerId());
  const providerMeta = (id: string) =>
    WEB_SEARCH_PROVIDER_KEYS[id as WebSearchProviderId] ?? null;
  const keyedProvider = (): boolean =>
    ["exa_search_api", "tavily", "deepseek", "keenable"].includes(providerId());
  const isHttp = (): boolean => providerId() === "openbitfun_search_http";
  const http = () => httpProvider();
  const credentialLine = (): string => {
    const status = webSearchCredential();
    if (!status || status.provider !== providerId()) return "";
    return status.configured
      ? tr("settings.webSearch.keyStored")
      : tr("settings.webSearch.noKeyStored");
  };
  return (
    <SettingsSection
      flush={true}
      title={tr("settings.webSearch.title")}
      subtitle={tr("settings.webSearch.subtitle")}
      notice={webSearchNotice()}
      onDismissNotice={() => webSearchNotice.set("")}
    >
      <View>
        <ConfigRow
          label={tr("settings.webSearch.provider")}
          description={
            providerMeta(providerId())
              ? tr(providerMeta(providerId())!.hintKey)
              : tr("settings.webSearch.defaultDesc")
          }
          divider={false}
          controlWidth={300}
          controlAlign="stretch"
        >
          <SelectDropdown
            options={WEB_SEARCH_PROVIDERS.map(entry => ({
              value: entry.value,
              label: tr(WEB_SEARCH_PROVIDER_KEYS[entry.value].labelKey),
              description: tr(WEB_SEARCH_PROVIDER_KEYS[entry.value].hintKey),
              icon: "globe" as const,
              accessibilityLabel: `search-provider-${entry.value}`,
            }))}
            value={providerId()}
            placeholder={tr("settings.webSearch.selectProvider")}
            fullWidth={true}
            accessibilityLabel="search-provider-select"
            onChange={value =>
              void chooseSearchProvider(value as (typeof WEB_SEARCH_PROVIDERS)[number]["value"])
            }
          />
        </ConfigRow>
        <If when={keyedProvider()}>
          <DraftRow
            id="search-credential-id"
            label={tr("settings.webSearch.credentialId")}
            hint={tr("settings.webSearch.credentialIdHint", { id: credentialIdFor(providerId()) })}
            action={tr("settings.webSearch.saveCredentialId")}
            placeholder={credentialIdFor(providerId()) || providerId()}
            monospace
            onSave={value => void setProviderCredentialId(providerId(), value.trim())}
          />
        </If>
        <If when={isHttp()}>
          <View>
            <DraftRow
              id="search-http-endpoint"
              label={tr("settings.webSearch.endpoint")}
              hint={tr("settings.webSearch.endpointHint")}
              action={tr("settings.webSearch.saveEndpoint")}
              placeholder={http().endpoint || "https://search.example/v1/query"}
              monospace
              onSave={value => void setHttpEndpoint(value.trim())}
            />
            <ConfigRow
              label={tr("settings.webSearch.auth")}
              topDivider={true}
              divider={false}
            >
              <SegmentedTabs
                size="sm"
                value={http().auth.mode}
                options={WEB_SEARCH_AUTH_MODES.map(mode => ({
                  value: mode.value,
                  label: WEB_SEARCH_AUTH_KEYS[mode.value]
                    ? tr(WEB_SEARCH_AUTH_KEYS[mode.value])
                    : mode.label,
                  accessibilityLabel: `search-auth-${mode.value}`,
                }))}
                onChange={mode =>
                  void setHttpAuth({
                    mode: mode as (typeof WEB_SEARCH_AUTH_MODES)[number]["value"],
                  })
                }
              />
            </ConfigRow>
            <If when={http().auth.mode === "header"}>
              <DraftRow
                id="search-http-header"
                label={tr("settings.webSearch.headerName")}
                hint={tr("settings.webSearch.headerNameHint")}
                action={tr("settings.webSearch.saveHeader")}
                placeholder={http().auth.headerName || "X-API-Key"}
                monospace
                onSave={value => void setHttpAuth({ headerName: value.trim() })}
              />
            </If>
            <If when={http().auth.mode !== "none"}>
              <DraftRow
                id="search-http-credential-id"
                label={tr("settings.webSearch.credentialId")}
                hint={tr("settings.webSearch.credentialIdHint", { id: credentialIdFor(providerId()) })}
                action={tr("settings.webSearch.saveCredentialId")}
                placeholder={credentialIdFor(providerId()) || "openbitfun_search_http"}
                monospace
                onSave={value => void setHttpAuth({ credentialId: value.trim() })}
              />
            </If>
          </View>
        </If>
        <If when={providerEntry()?.needsCredential === true || providerEntry()?.credentialOptional === true}>
          <View
            style={{
              position: "relative",
              minHeight: SETTINGS_ROW_MIN,
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              columnGap: space.lg,
              rowGap: space.sm,
              paddingHorizontal: SETTINGS_ROW_INSET,
              paddingVertical: space.md,
            }}
          >
            <RowSeparator edge="top" />
            <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 180, minWidth: 0, gap: space.hair }}>
              <Text style={{ ...textStyle("body"), fontWeight: "500" }}>
                {tr("settings.models.apiKey")}
              </Text>
              <If when={credentialLine()}>
                {line => (
                  <Text style={textStyle("caption", { color: palette().textSecondary })}>
                    {line()}
                  </Text>
                )}
              </If>
              <Text style={textStyle("caption")}>
                {tr("settings.webSearch.vaultHint")}
              </Text>
            </View>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.sm,
                flexShrink: 1,
                marginLeft: "auto",
                width: settingsCompact() ? "100%" : 300,
                maxWidth: "100%",
              }}
            >
              <InputBox
                size="sm"
                leadingIcon="key"
                masked
                value={drafts()["search-secret"] ?? ""}
                placeholder={tr("settings.webSearch.pasteKey")}
                accessibilityLabel="search-secret"
                style={{ flex: 1, minWidth: 0 }}
                onChange={val => drafts.update(current => ({ ...current, "search-secret": val }))}
                onSubmit={() => void saveSearchCredential(drafts()["search-secret"] ?? "")}
              />
              <Button
                label={tr("settings.field.saveShort")}
                variant={(drafts()["search-secret"] ?? "").trim().length > 0 ? "primary" : "secondary"}
                size="sm"
                accessibilityLabel="search-save-key"
                onPress={() => void saveSearchCredential(drafts()["search-secret"] ?? "")}
              />
              <IconButton
                icon="trash"
                size="sm"
                tone="danger"
                tooltip={tr("common.remove")}
                accessibilityLabel="search-clear-key"
                onPress={() => void clearSearchCredential()}
              />
            </View>
          </View>
        </If>
      </View>
    </SettingsSection>
  );
}

function QuickActionsSection() {
  useDeviceScopedLoad("quick-actions", ensureQuickActions, () => void loadQuickActions());
  const draft = () => quickActionDraft();
  const quickActionModalOpen = usePresenceFlag(() => Boolean(quickActionDraft()));
  return (
    <SettingsSection
      flush={true}
      title={tr("settings.quickActions.title")}
      subtitle={tr("settings.quickActions.subtitle")}
      notice={quickActionsNotice()}
      onDismissNotice={() => quickActionsNotice.set("")}
      extra={
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Button
            label={tr("common.add")}
            variant="primary"
            size="sm"
            leadingIcon="plus"
            accessibilityLabel="quick-action-add"
            onPress={() => openQuickActionDraft()}
          />
        </View>
      }
    >
      <View>
        <Each of={quickActions()} key={action => action.id}>
          {(action, index) => (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                paddingHorizontal: SETTINGS_ROW_INSET,
                paddingVertical: space.md,
                position: "relative",
                opacity: action().enabled ? 1 : 0.65,
                ...paintTransition(MOTION_DURATION.fast),
              }}
              hoverStyle={{ backgroundColor: palette().surfaceSubtle }}
            >
              <If when={index() !== 0}>
                <RowSeparator edge="top" />
              </If>
              <View style={{ flex: 1, minWidth: 0, gap: space.hair }}>
                <Text
                  style={{
                    ...textStyle("body"),
                    fontWeight: "500",
                    numberOfLines: 1,
                    textOverflow: "ellipsis",
                  }}
                >
                  {action().label}
                </Text>
                <Text
                  style={{
                    ...textStyle("caption"),
                    numberOfLines: 2,
                    textOverflow: "ellipsis",
                  }}
                >
                  {action().prompt}
                </Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 0, gap: space.sm }}>
                <ToggleSwitch
                  value={action().enabled}
                  accessibilityLabel={`quick-action-toggle-${action().id}`}
                  onChange={() => void toggleQuickAction(action().id)}
                />
                <View ref={el => setRowAnchor(`qa:${action().id}`, el)} style={{ flexShrink: 0 }}>
                  <IconButton
                    icon="more"
                    size="sm"
                    tooltip={tr("settings.quickActions.options")}
                    active={rowMenuId() === `qa:${action().id}`}
                    accessibilityLabel={`quick-action-actions-${action().id}`}
                    onPress={() =>
                      rowMenuId.set(
                        rowMenuId() === `qa:${action().id}` ? null : `qa:${action().id}`,
                      )
                    }
                  />
                </View>
              </View>
              <DropdownMenu
                open={rowMenuId() === `qa:${action().id}`}
                anchor={rowMenuAnchors()[`qa:${action().id}`] ?? null}
                align="end"
                minWidth={150}
                items={[
                  {
                    id: "up",
                    label: tr("common.up"),
                    icon: "arrow-up",
                    accessibilityLabel: `quick-action-up-${action().id}`,
                    onSelect: () => void moveQuickAction(action().id, -1),
                  },
                  {
                    id: "down",
                    label: tr("common.down"),
                    icon: "arrow-down",
                    accessibilityLabel: `quick-action-down-${action().id}`,
                    onSelect: () => void moveQuickAction(action().id, 1),
                  },
                  {
                    id: "edit",
                    label: tr("common.edit"),
                    icon: "edit",
                    accessibilityLabel: `quick-action-edit-${action().id}`,
                    onSelect: () => openQuickActionDraft(action()),
                  },
                  {
                    id: "delete",
                    label: tr("common.delete"),
                    icon: "trash",
                    danger: true,
                    accessibilityLabel: `quick-action-delete-${action().id}`,
                    onSelect: () => void deleteQuickAction(action().id),
                  },
                ]}
                onClose={() => rowMenuId.set(null)}
              />
            </View>
          )}
        </Each>
        <ModalDialog
          open={quickActionModalOpen()}
          title={
            draft()?.id
              ? tr("settings.quickActions.editTitle", { name: draft()?.label || draft()?.id || "" })
              : tr("settings.quickActions.newTitle")
          }
          subtitle={tr("settings.quickActions.modalSubtitle")}
          size="md"
          accessibilityLabel="quick-action-modal"
          onClose={() => closeQuickActionDraft()}
          footer={
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
              <Button
                label={tr("common.cancel")}
                variant="secondary"
                size="md"
                accessibilityLabel="quick-action-cancel"
                onPress={() => closeQuickActionDraft()}
              />
              <Button
                label={tr("common.save")}
                variant="primary"
                size="md"
                accessibilityLabel="quick-action-save"
                onPress={() => void saveQuickActionDraft()}
              />
            </View>
          }
        >
          <If when={Boolean(draft())}>
            <View style={{ gap: space.md }}>
              <InputBox
                label={tr("common.label")}
                value={draft()?.label ?? ""}
                placeholder={tr("common.label")}
                accessibilityLabel="quick-action-label"
                onChange={val => updateQuickActionDraft({ label: val })}
              />
              <InputBox
                label={tr("devices.prompt")}
                multiline
                minHeight={88}
                value={draft()?.prompt ?? ""}
                placeholder={tr("settings.quickActions.promptPlaceholder")}
                accessibilityLabel="quick-action-prompt"
                onChange={val => updateQuickActionDraft({ prompt: val })}
                onSubmit={() => void saveQuickActionDraft()}
              />
            </View>
          </If>
        </ModalDialog>
      </View>
    </SettingsSection>
  );
}

async function commitMcpJson(): Promise<boolean> {
  const saved = await saveMcpJson();
  if (saved && !mcpNotice()) pushToast(tr("common.saved"), "success");
  return saved;
}

async function commitMcpDraft(): Promise<boolean> {
  const saved = await saveMcpDraft();
  if (saved && !mcpNotice()) pushToast(tr("common.saved"), "success");
  return saved;
}

async function commitMcpImport(): Promise<boolean> {
  const count = mcpImportCandidates()?.filter(row => row.selected).length ?? 0;
  const imported = await importMcpServers();
  if (imported && !mcpNotice()) pushToast(tr("settings.mcp.importSaved", { count: formatCount(count) }), "success");
  return imported;
}

function McpSection() {
  useDeviceScopedLoad("mcp", ensureMcp, () => {
    closeMcpResources();
    reloadMcpForDevice();
  });
  void loadAccountRecords();
  const mcpDocumentUsable = (): boolean => mcpDocument() !== null;
  const mcpIsInitialLoading = (): boolean =>
    mcpAvailable() === null || (mcpLoading() && mcpServerRows().length === 0 && !mcpDocumentLoaded());
  return (
    <SettingsSection
      flush={true}
      title={tr("settings.mcp.title")}
      subtitle={tr("settings.mcp.subtitle")}
      extra={
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
          <If when={!mcpJsonOpen() && mcpDocumentUsable()}>
            <Button
              label={tr("settings.mcp.addServer")}
              variant="primary"
              size="sm"
              leadingIcon="plus"
              accessibilityLabel="mcp-add"
              onPress={() => openMcpDraft()}
            />
          </If>
          <If when={!mcpJsonOpen() && mcpDocumentUsable()}>
            <Button
              label={tr("common.import")}
              variant="secondary"
              size="sm"
              accessibilityLabel="mcp-import"
              onPress={openMcpImport}
            />
          </If>
          <Button
            label={tr(mcpJsonOpen() ? "settings.mcp.jsonBackToList" : "settings.mcp.json")}
            variant="secondary"
            size="sm"
            leadingIcon={mcpJsonOpen() ? "arrow-left" : undefined}
            accessibilityLabel="mcp-json-toggle"
            disabled={mcpBusy() === "mcp-json"}
            onPress={() => (mcpJsonOpen() ? requestSettingsTransition({ kind: "mcp-list" }) : openMcpJson())}
          />
          <If when={!mcpJsonOpen()}>
            <IconButton
              icon="refresh"
              size="sm"
              tooltip={tr("settings.mcp.reload")}
              accessibilityLabel="mcp-reload"
              onPress={() => {
                void refreshMcpServers();
                void loadMcpDocument();
              }}
            />
          </If>
        </View>
      }
    >
      <If when={mcpJsonOpen()} else={<View>
        <If when={mcpNotice()}>
          {notice => (
            <View
              style={{
                position: "relative",
                paddingHorizontal: SETTINGS_ROW_INSET,
                paddingVertical: space.md,
              }}
            >
              <RowSeparator edge="bottom" />
              <Text style={textStyle("caption")}>{localizeHostError(notice())}</Text>
            </View>
          )}
        </If>

        <If when={mcpIsInitialLoading()}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              paddingHorizontal: SETTINGS_ROW_INSET,
              paddingVertical: space.lg,
              minHeight: SETTINGS_ROW_MIN,
            }}
          >
            <Spinner size={14} color={palette().textMuted} />
            <Text style={textStyle("caption")}>{tr("common.loading")}</Text>
          </View>
        </If>

        <If when={mcpAvailable() === false}>
          <View style={{ paddingHorizontal: SETTINGS_ROW_INSET, paddingVertical: space.lg }}>
            <Text style={textStyle("caption")}>{tr("settings.mcp.unavailable")}</Text>
          </View>
        </If>

        <If when={mcpAvailable() === true && mcpDocumentLoaded() && !mcpDocumentUsable()}>
          <View style={{ paddingHorizontal: SETTINGS_ROW_INSET, paddingVertical: space.lg }}>
            <Text style={textStyle("caption")}>{tr("settings.mcp.configReadError")}</Text>
          </View>
        </If>

        <McpServerList />
        <If when={mcpServerRows().length === 0 && mcpAvailable() === true && !mcpLoading() && !mcpListError()}>
          <SettingsEmptyState icon="plug" message={tr("settings.mcp.noServers")} />
        </If>
        <If when={mcpBusy()}>
          {busy => (
            <View style={{ paddingHorizontal: SETTINGS_ROW_INSET, paddingBottom: space.md }}>
              <Text style={textStyle("caption")}>
                {tr("settings.mcp.working", { task: busy() })}
              </Text>
            </View>
          )}
        </If>
      </View>}>
        <McpJsonEditor onClose={() => requestSettingsTransition({ kind: "mcp-list" })}
          onReload={() => requestSettingsTransition({ kind: "mcp-reload" })} onSave={() => void commitMcpJson()} />
      </If>

      {/* MCP OAuth Modal */}
      <ModalDialog
        open={Boolean(mcpOAuthServer())}
        title={tr("settings.mcp.authorizeTitle", { server: mcpOAuthServer() ?? "" })}
        subtitle={mcpOAuthBrowserAvailable() ? tr("settings.mcp.oauthStatus", { status: mcpOAuthStatusLabel(mcpOAuthSession()) }) : undefined}
        size="md"
        accessibilityLabel="mcp-auth-modal"
        // Authorization finishes in the browser: the click that returns to this window must not end it.
        keepOpenOnBackdrop={mcpOAuthPending() || mcpOAuthBusy()}
        onClose={requestCloseMcpAuth}
        footer={
          <Button
            label={tr("common.close")}
            variant="secondary"
            size="md"
            accessibilityLabel="mcp-auth-close"
            disabled={mcpOAuthBusy()}
            onPress={requestCloseMcpAuth}
          />
        }
      >
        <View style={{ gap: space.md }}>
          <If when={mcpOAuthBrowserAvailable()}>
            <View style={{ gap: space.sm }}>
              <Text style={textStyle("label", { color: palette().textSecondary })}>
                {tr("settings.mcp.browserOAuth")}
              </Text>
              <If when={mcpOAuthSession()?.redirectUri ?? ""}>
                {uri => (
                  <Text style={textStyle("mono", { color: palette().textMuted })}>
                    {tr("settings.mcp.oauthRedirect", { uri: uri() })}
                  </Text>
                )}
              </If>
              <If when={mcpOAuthSession()?.message ?? ""}>
                {message => <Text style={textStyle("caption")}>{message()}</Text>}
              </If>
              <If when={mcpOAuthPending() && mcpOAuthUrlUnopened() ? (mcpOAuthSession()?.authorizationUrl ?? "") : ""}>
                {url => (
                  <View style={{ gap: space.sm }}>
                    <Text style={textStyle("caption", { color: stateColor("needs_you") })}>
                      {tr("settings.mcp.oauthOpenFailed")}
                    </Text>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: space.md,
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                        borderRadius: radii.md,
                        borderCurve: "continuous",
                        borderWidth: 1,
                        borderColor: palette().borderSubtle,
                        backgroundColor: palette().surfaceTertiary,
                      }}
                    >
                      <Text
                        style={{
                          ...textStyle("mono", { color: palette().text }),
                          flex: 1,
                          minWidth: 0,
                          numberOfLines: 2,
                          textOverflow: "ellipsis-middle",
                        }}
                      >
                        {url()}
                      </Text>
                      <Button
                        label={tr("settings.mcp.copyAddress")}
                        variant="secondary"
                        size="sm"
                        leadingIcon="copy"
                        accessibilityLabel="mcp-auth-copy-url"
                        onPress={() => copyMcpOAuthUrl()}
                      />
                    </View>
                  </View>
                )}
              </If>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                <Button
                  label={
                    mcpOAuthSession()?.status === "authorized"
                      ? tr("settings.mcp.authorizeAgain")
                      : tr("settings.mcp.authorizeInBrowser")
                  }
                  variant="primary"
                  size="sm"
                  loading={mcpOAuthBusy()}
                  disabled={mcpOAuthPending()}
                  accessibilityLabel="mcp-auth-start"
                  onPress={() => void startMcpRemoteOAuth()}
                />
                <Button
                  label={tr("settings.mcp.cancelAuth")}
                  variant="ghost"
                  size="sm"
                  accessibilityLabel="mcp-auth-cancel"
                  disabled={mcpOAuthBusy() || !mcpOAuthPending()}
                  onPress={() => void cancelMcpRemoteOAuth()}
                />
              </View>
            </View>
          </If>
          <View
            style={{
              gap: space.md,
              paddingTop: mcpOAuthBrowserAvailable() ? space.md : 0,
              borderTopWidth: mcpOAuthBrowserAvailable() ? 1 : 0,
              borderColor: palette().borderSubtle,
            }}
          >
            <Text style={textStyle("label", { color: palette().textSecondary })}>
              {tr("settings.mcp.manualAuth")}
            </Text>
            <Text style={textStyle("caption")}>{tr("settings.mcp.manualAuthHint")}</Text>
            <InputBox
              size="md"
              leadingIcon="key"
              masked
              value={mcpAuthValue()}
              placeholder={tr("settings.mcp.tokenPlaceholder")}
              accessibilityLabel="mcp-auth-value"
              onChange={val => setMcpAuthValue(val)}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
              <Button
                label={tr("settings.mcp.saveValue")}
                variant="secondary"
                size="sm"
                accessibilityLabel="mcp-auth-save-value"
                disabled={mcpOAuthBusy()}
                onPress={() => void saveMcpRemoteAuth()}
              />
              <Button
                label={tr("settings.mcp.clearAuth")}
                variant="danger"
                size="sm"
                accessibilityLabel="mcp-auth-clear"
                disabled={mcpOAuthBusy()}
                onPress={() => void clearMcpRemoteAuth()}
              />
              <View style={{ flex: 1 }} />
              <If when={mcpOAuthNotice()}>
                {notice => <Text style={textStyle("caption")}>{localizeHostError(notice())}</Text>}
              </If>
            </View>
          </View>
        </View>
      </ModalDialog>

      <McpImportDialog onClose={() => requestSettingsTransition({ kind: "mcp-import-close" })} onSave={() => void commitMcpImport()} />

      {/* MCP Resources Modal */}
      <ModalDialog
        open={Boolean(mcpResourcesServer())}
        title={tr("settings.mcp.resourcesOf", { server: mcpResourcesServer() ?? "" })}
        size="lg"
        accessibilityLabel="mcp-resources-modal"
        onClose={() => closeMcpResources()}
        footer={
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
            <Button
              label={tr("common.refresh")}
              variant="secondary"
              size="md"
              accessibilityLabel="mcp-resources-refresh"
              onPress={() => void loadMcpResources()}
            />
            <Button
              label={tr("common.close")}
              variant="secondary"
              size="md"
              accessibilityLabel="mcp-resources-close"
              onPress={() => closeMcpResources()}
            />
          </View>
        }
      >
        <View style={{ gap: space.md }}>
          <SearchInput
            value={mcpResourceQuery()}
            onChange={value => setMcpResourceQuery(value)}
            placeholder={tr("settings.mcp.filterResources")}
            accessibilityLabel="mcp-resources-filter"
          />
          <If when={mcpResourcesBusy()}>
            <Text style={textStyle("caption")}>{tr("settings.mcp.readingResources")}</Text>
          </If>
          <If when={mcpResourcesNotice()}>
            {notice => <InlineBanner tone="danger" message={localizeHostError(notice())} />}
          </If>
          <If
            when={
              mcpResourcesLoaded() &&
              !mcpResourcesBusy() &&
              mcpResourcesRows().length === 0 &&
              !mcpResourcesNotice()
            }
          >
            <Text style={textStyle("caption")}>{tr("settings.mcp.noResources")}</Text>
          </If>
          <If when={mcpResourcesLoaded() && mcpResourcesRows().length > 0 && mcpResourceVisibleRows().length === 0}>
            <Text style={textStyle("caption", { tabular: true })}>
              {tr("settings.mcp.noMatchingResources", { count: mcpResourcesRows().length })}
            </Text>
          </If>
          <Each of={mcpResourceVisibleRows()} key={row => row.uri}>
            {row => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <SelectableChip
                  label={row().title ?? row().name}
                  active={mcpResourceSelected()?.uri === row().uri}
                  accessibilityLabel={`mcp-resource-${row().slot}`}
                  onPress={() => void openMcpResource(row())}
                />
                <Text
                  style={{
                    ...textStyle("mono", { color: palette().textMuted }),
                    flex: 1,
                    minWidth: 0,
                    numberOfLines: 1,
                    textOverflow: "ellipsis-middle",
                  }}
                >
                  {`${row().uri}${row().mimeType ? ` · ${row().mimeType}` : ""}`}
                </Text>
              </View>
            )}
          </Each>
          <If when={mcpResourceSelected()}>
            {selected => (
              <View
                style={{
                  gap: space.sm,
                  padding: space.md,
                  borderRadius: radii.md,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: palette().borderSubtle,
                  backgroundColor: palette().surfaceTertiary,
                }}
              >
                <Text
                  style={{
                    ...textStyle("caption", { color: palette().text }),
                    fontWeight: "600",
                  }}
                >
                  {`${selected().name}${selected().mimeType ? ` · ${selected().mimeType}` : ""}`}
                </Text>
                <If when={mcpResourceContentBusy()}>
                  <Text style={textStyle("caption")}>{tr("common.reading")}</Text>
                </If>
                <If when={!mcpResourceContentBusy() && mcpResourceContent() ? mcpResourceContent() : ""}>
                  {content => (
                    <Scroll smoothWheel style={{ maxHeight: 240, minHeight: 0, flexShrink: 1 }}>
                      <Text style={textStyle("mono", { color: palette().textSecondary })}>
                        {content()}
                      </Text>
                    </Scroll>
                  )}
                </If>
              </View>
            )}
          </If>
        </View>
      </ModalDialog>

      <McpServerEditor onClose={() => requestSettingsTransition({ kind: "mcp-form-close" })}
        onReload={() => requestSettingsTransition({ kind: "mcp-form-reload", id: mcpDraft()?.originalId })}
        onSave={() => void commitMcpDraft()} />
    </SettingsSection>
  );
}

function AcpSection() {
  useDeviceScopedLoad(
    "acp",
    () => {
      ensureAcp();
      void probeAcpClients();
    },
    () => {
      void loadAcpClients();
      void probeAcpClients(true);
    },
  );
  return (
    <If when={acpSupported() !== false}>
      <SettingsSection
        flush={true}
        title={tr("settings.acp.title")}
        subtitle={tr("settings.acp.subtitle")}
        extra={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <If when={acpProbing()}>
              <Spinner size={13} color={palette().accent} />
            </If>
            <Button
              label={tr("settings.mcp.json")}
              variant="ghost"
              size="sm"
              accessibilityLabel="acp-json-toggle"
              onPress={() => void openAcpJson()}
            />
            <IconButton
              icon="refresh"
              size="sm"
              tooltip={acpProbing() ? tr("settings.acp.probing") : tr("settings.acp.reload")}
              accessibilityLabel="acp-reload"
              onPress={() => {
                void loadAcpClients();
                void probeAcpClients(true);
              }}
            />
          </View>
        }
      >
        <View>
          <If when={acpNotice()}>
            {notice => (
              <View
                style={{
                  position: "relative",
                  paddingHorizontal: SETTINGS_ROW_INSET,
                  paddingVertical: space.md,
                }}
              >
                <RowSeparator edge="bottom" />
                <Text style={textStyle("caption")}>{localizeHostError(notice())}</Text>
              </View>
            )}
          </If>

          <If when={acpClients().length === 0}>
            <SettingsEmptyState icon="bot" message={tr("settings.acp.empty")} />
          </If>
          <Each of={acpClients()} key={client => client.id}>
            {(client, index) => (
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: space.md,
                  paddingHorizontal: SETTINGS_ROW_INSET,
                  paddingVertical: space.md,
                  minHeight: SETTINGS_ROW_MIN,
                  position: "relative",
                  ...paintTransition(MOTION_DURATION.fast),
                }}
                hoverStyle={{ backgroundColor: palette().surfaceSubtle }}
              >
                <If when={index() !== 0}>
                  <RowSeparator edge="top" />
                </If>
                <If when={client().status === "running" || client().status === "starting"}>
                  <View style={{ alignSelf: "flex-start", height: settingsRowLabelLineHeight(), justifyContent: "center" }}>
                    <StateMark state="working" size={12} />
                  </View>
                </If>
                <View style={{ flex: 1, minWidth: 180, gap: space.hair }}>
                  <Text
                    style={{
                      ...textStyle("body"),
                      fontWeight: "500",
                      numberOfLines: 1,
                      textOverflow: "ellipsis",
                    }}
                  >
                    {`${client().name} · ${client().id}`}
                  </Text>
                  <Text
                    style={{
                      ...textStyle("mono", { color: palette().textMuted }),
                      numberOfLines: 1,
                      textOverflow: "ellipsis-middle",
                    }}
                  >
                    {`${[client().command, ...client().args].filter(Boolean).join(" ") || tr("settings.acp.noCommand")} · ${acpRowStatus(client())}`}
                  </Text>
                  <If when={acpProbes()[client().id] && !acpProbes()[client().id].runnable}>
                    <Text style={textStyle("caption", { color: stateColor("needs_you") })}>
                      {acpProbes()[client().id].notes.join(" · ")}
                    </Text>
                  </If>
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", flexShrink: 1, minWidth: 0, gap: space.sm }}>
                  <Text style={textStyle("caption", { color: palette().textSecondary })}>
                    {client().enabled ? tr("common.enabled").toLowerCase() : tr("common.disabled").toLowerCase()}
                  </Text>
                  <SelectDropdown
                    size="sm"
                    value={client().permissionMode === "allow_once" ? "allow_once" : "ask"}
                    options={ACP_PERMISSION_MODES.map(mode => ({
                      value: mode,
                      label: mode === "allow_once" ? tr("settings.acp.permissionAllowOnce") : tr("settings.acp.permissionAsk"),
                      accessibilityLabel: `acp-permission-${client().id}-${mode}`,
                    }))}
                    accessibilityLabel={`acp-permission-${client().id}`}
                    disabled={acpBusy() === client().id}
                    minWidth={settingsCompact() ? 140 : 180}
                    align="end"
                    onChange={mode => void setAcpPermissionMode(client().id, mode)}
                  />
                  <If when={client().status === "running" || client().status === "starting"}>
                    <Button
                      label={tr("common.stop")}
                      variant="secondary"
                      size="sm"
                      accessibilityLabel={`acp-stop-${client().id}`}
                      onPress={() => void stopAcpClient(client().id)}
                    />
                  </If>
                  <If when={acpProbes()[client().id] && !acpProbes()[client().id].runnable}>
                    <Button
                      label={
                        acpBusy() === client().id
                          ? tr("common.installing")
                          : tr("settings.acp.installCli")
                      }
                      variant="secondary"
                      size="sm"
                      accessibilityLabel={`acp-install-${client().id}`}
                      onPress={() => void installAcpClient(client().id)}
                    />
                  </If>
                </View>
              </View>
            )}
          </Each>
        </View>

        <ModalDialog
          open={acpJsonOpen()}
          title={tr("settings.acp.jsonTitle")}
          subtitle={tr("settings.acp.jsonSubtitle")}
          size="lg"
          accessibilityLabel="acp-json-modal"
          onClose={() => closeAcpJson()}
          footer={
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, flex: 1 }}>
              <Text style={[textStyle("caption"), { flex: 1, minWidth: 0 }]}>
                {acpJsonDirty()
                  ? tr("settings.acp.unsavedChanges")
                  : acpJsonText()
                    ? tr("settings.acp.loaded")
                    : tr("common.loading")}
              </Text>
              <Button
                label={tr("common.discard")}
                variant="secondary"
                size="md"
                accessibilityLabel="acp-json-discard"
                onPress={() => closeAcpJson()}
              />
              <Button
                label={tr("settings.mcp.saveJson")}
                variant="primary"
                size="md"
                accessibilityLabel="acp-json-save"
                onPress={() => void saveAcpJson()}
              />
            </View>
          }
        >
          <View style={{ gap: 10 }}>
            <If when={acpJsonNotice()}>
              {notice => <InlineBanner tone="danger" message={localizeHostError(notice())} />}
            </If>
            <InputBox
              multiline
              monospace
              minHeight={220}
              value={acpJsonText()}
              accessibilityLabel="acp-json"
              onChange={val => editAcpJson(val)}
            />
          </View>
        </ModalDialog>
      </SettingsSection>
    </If>
  );
}

const TREND_BUCKETS = 90;
const USAGE_DAY_ROWS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const HEATMAP_HEIGHT = 96;
const HEATMAP_PADDING_INNER = 0.22;

function heatmapPlotWidth(weekCount: number): number {
  const pitch = HEATMAP_HEIGHT / (USAGE_DAY_ROWS.length - HEATMAP_PADDING_INNER);
  return Math.max(120, Math.round((Math.max(1, weekCount) - HEATMAP_PADDING_INNER) * pitch));
}

/** Shared 5-step heatmap color ramp used 1:1 by `<Plot><Cell />` and legend swatches. */
function usageHeatmapStepColors(): string[] {
  const p = palette();
  return [
    p.heatmapZero,
    p.accentSoft,
    p.accentBorder,
    p.accentHover,
    p.accent,
  ];
}

interface UsageTrendPlotRow {
  bucket: string;
  shortLabel: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

const trendBars = computed<UsageTrendPlotRow[]>(() => {
  const hourly = usageGranularity() === "hour";
  return usageBuckets()
    .slice(-TREND_BUCKETS)
    .map(bucket => {
      const formatted = formatBucket(bucket.bucket, hourly);
      const shortLabel = hourly
        ? formatted.split(" ").pop() || formatted
        : formatted.replace(/^\d{4}-/, "");
      return {
        bucket: bucket.bucket,
        shortLabel,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cachedTokens: bucket.cachedTokens,
        totalTokens: bucket.inputTokens + bucket.outputTokens,
      };
    });
});

interface UsageHeatmapPlotRow {
  weekKey: string;
  dow: string;
  levelKey: string;
  dateKey: string;
  tokens: number;
}

const usageHeatmapPlotData = computed<{ weeks: string[]; rows: UsageHeatmapPlotRow[] }>(() => {
  const activity = usageActivity();
  if (!activity) return { weeks: [], rows: [] };
  const weekCount = Math.max(1, activity.weekCount);
  const weeks = Array.from({ length: weekCount }, (_, idx) => `w${idx}`);
  const rows: UsageHeatmapPlotRow[] = [];
  activity.days.forEach((day, idx) => {
    if (!day.inRange) return;
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    rows.push({
      weekKey: `w${col}`,
      dow: USAGE_DAY_ROWS[row] ?? "Mon",
      levelKey: String(day.level),
      dateKey: day.key,
      tokens: day.tokens,
    });
  });
  return { weeks, rows };
});

function activitySpan(): string {
  const activity = usageActivity();
  if (!activity) return "";
  const days = activity.days.filter(day => day.inRange);
  if (days.length === 0) return "";
  return `${days[0].key} – ${days[days.length - 1].key}`;
}

function activityTotal(): string {
  const activity = usageActivity();
  if (!activity) return "";
  return formatTokens(activity.totalTokens);
}

function UsageMetricRow(props: { testID: string; label: string; value: string; description?: string; first?: boolean }) {
  return (
    <SettingsRow testID={props.testID} label={props.label} description={props.description} first={props.first}>
      <Text style={{ ...textStyle("body", { tabular: true }), fontWeight: "600" }}>{props.value}</Text>
    </SettingsRow>
  );
}

function UsageLoadingLine() {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: SETTINGS_ROW_INSET }}>
      <Spinner size={12} color={palette().textMuted} />
      <Text style={textStyle("caption")}>{tr("common.loading")}</Text>
    </View>
  );
}

function UsageSection() {
  effect(() => {
    deviceContext();
    backendConnection();
    untracked(() => void loadUsage());
  });
  const hoveredUsageActivityIdx = signal<number | null>(null);
  const hoveredUsageTrendIdx = signal<number | null>(null);
  effect(() => {
    usageActivity();
    hoveredUsageActivityIdx.set(null);
  });
  effect(() => {
    usageBuckets();
    hoveredUsageTrendIdx.set(null);
  });
  const hourly = (): boolean => usageGranularity() === "hour";
  const hasUsage = () => (usageTotals()?.requests ?? 0) > 0;
  const hoveredActivityDay = (): UsageHeatmapPlotRow | null => {
    const idx = hoveredUsageActivityIdx();
    if (idx === null) return null;
    const { rows } = usageHeatmapPlotData();
    return rows[idx] ?? null;
  };
  const hoveredTrendRow = (): UsageTrendPlotRow | null => {
    const idx = hoveredUsageTrendIdx();
    if (idx === null) return null;
    return trendBars()[idx] ?? null;
  };
  const distributionPeak = (): number =>
    usageVisibleRows().rows.reduce((max, row) => Math.max(max, row.tokens), 0);
  const localizedDayAxis = (): string[] => {
    const labels = weekdayShortLabels(true);
    return [labels[0] ?? "Mon", "", labels[2] ?? "Wed", "", labels[4] ?? "Fri", "", ""];
  };

  return (
    <View style={{ gap: layout.sectionGap }}>
      <If when={usageActivityLoading() || usageActivity() || (!usageUnsupported() && usageActivityNotice())}>
        <View style={{ minWidth: 0 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: space.sm,
              minHeight: space.xl,
              marginBottom: space.sm,
              paddingHorizontal: space.xs,
            }}
          >
            <Text role="header" style={textStyle("label", { tabular: true, color: palette().textSecondary })}>
              {tr("settings.usage.activityHeading", {
                span: activitySpan() || tr("settings.usage.lastSixMonths"),
              })}
            </Text>
            <If when={Boolean(usageActivity())}>
              <Text
                style={{
                  ...textStyle("caption", {
                    color: hoveredActivityDay() ? palette().text : palette().textMuted,
                    tabular: true,
                  }),
                  fontWeight: hoveredActivityDay() ? "600" : "400",
                }}
              >
                {hoveredActivityDay()
                  ? tr("settings.usage.dayTokens", {
                      date: hoveredActivityDay()!.dateKey,
                      tokens: formatTokens(hoveredActivityDay()!.tokens) || "0",
                    })
                  : tr("settings.usage.hoverToInspect")}
              </Text>
            </If>
          </View>
          <View style={[insetGroupStyle(space.lg), { gap: space.md }]}>
            <If when={usageActivityLoading() && !usageActivity()}><UsageLoadingLine /></If>
            <If when={usageActivity()}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                <View style={{ width: 28, height: HEATMAP_HEIGHT, flexShrink: 0, justifyContent: "space-between" }}>
                  <Each of={localizedDayAxis()} key="index">
                    {label => (
                      <View style={{ flex: 1, justifyContent: "center" }}>
                        <Text style={textStyle("micro")}>
                          {label()}
                        </Text>
                      </View>
                    )}
                  </Each>
                </View>
                <Scroll smoothWheel horizontal style={{ flex: 1, minWidth: 0 }}>
                  <Plot<UsageHeatmapPlotRow>
                    data={usageHeatmapPlotData().rows}
                    xScale={{
                      type: "band",
                      domain: usageHeatmapPlotData().weeks,
                      paddingInner: HEATMAP_PADDING_INNER,
                      paddingOuter: 0,
                    }}
                    yScale={{
                      type: "band",
                      domain: [...USAGE_DAY_ROWS],
                      paddingInner: HEATMAP_PADDING_INNER,
                      paddingOuter: 0,
                    }}
                    colorScale={{
                      type: "ordinal",
                      domain: ["0", "1", "2", "3", "4"],
                      range: usageHeatmapStepColors(),
                    }}
                    accessibilityLabel="usage-activity-heatmap"
                    onHoverChange={event => hoveredUsageActivityIdx.set(event.index)}
                    style={{
                      width: heatmapPlotWidth(usageHeatmapPlotData().weeks.length),
                      height: HEATMAP_HEIGHT,
                    }}
                  >
                    <Cell
                      x="weekKey"
                      y="dow"
                      color="levelKey"
                      cornerRadii={radii.xs}
                      hoverCellStyle={{
                        borderWidth: 1.5,
                        borderColor: palette().text,
                        borderRadius: radii.xs,
                      }}
                    />
                  </Plot>
                </Scroll>
              </View>
            </If>
            <If when={usageActivity()}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: space.sm,
                }}
              >
                <Text style={textStyle("caption")}>
                  {activityTotal()
                    ? isLightAppearance()
                      ? tr("settings.usage.heatmapCaptionLightWithTotal", { total: activityTotal() })
                      : tr("settings.usage.heatmapCaptionDarkWithTotal", { total: activityTotal() })
                    : isLightAppearance()
                      ? tr("settings.usage.heatmapCaptionLight")
                      : tr("settings.usage.heatmapCaptionDark")}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 0, gap: space.xs }}>
                  <Text style={textStyle("micro")}>{tr("common.less")}</Text>
                  <Each of={[0, 1, 2, 3, 4]} key={lvl => String(lvl)}>
                    {lvl => (
                      <View
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: radii.xs,
                          backgroundColor: usageHeatmapStepColors()[lvl()],
                        }}
                      />
                    )}
                  </Each>
                  <Text style={textStyle("micro")}>{tr("common.more")}</Text>
                </View>
              </View>
            </If>
            <If when={usageActivityNotice()}>
              {notice => (
                <Text style={textStyle("caption", { color: stateColor("needs_you") })}>
                  {localizeHostError(notice())}
                </Text>
              )}
            </If>
          </View>
        </View>
      </If>

      <SettingsSection title={tr("settings.usage.overview")} flush
        notice={usageNotice()} onDismissNotice={() => usageNotice.set("")}>
        <SettingsRow label={tr("settings.usage.rangeLabel")} first>
          <SelectDropdown
            size="sm"
            fullWidth
            align="end"
            testID="usage-range-select"
            accessibilityLabel={tr("settings.usage.rangeLabel")}
            value={usageRange()}
            disabled={usageLoading() || usageUnsupported()}
            options={USAGE_RANGES.map(range => ({
              value: range.value,
              label: USAGE_RANGE_KEYS[range.value] ? tr(USAGE_RANGE_KEYS[range.value]) : range.label,
              accessibilityLabel: `usage-range-${range.value}`,
            }))}
            onChange={value => void chooseUsageRange(value)}
          />
        </SettingsRow>
        <If when={usageUnsupported()}>
          <SectionFootnote text={tr("settings.usage.unsupported")} />
        </If>
        <If when={usageLoading() && !usageTotals()}><UsageLoadingLine /></If>
        <If when={usageTotals()}>
          {totals => (
            <If when={totals().requests > 0} else={
              <EmptyStateCard
                icon="bar-chart"
                title={tr(usageRange() === "all" ? "settings.usage.emptyTitle" : "settings.usage.periodEmptyTitle")}
                subtitle={tr(usageRange() === "all" ? "settings.usage.emptyHint" : "settings.usage.periodEmptyHint")}
              />
            }>
              <UsageMetricRow testID="usage-total-tokens" label={tr("settings.usage.total")} value={formatTokens(totals().tokens)} />
              <UsageMetricRow testID="usage-input-tokens" label={tr("settings.usage.inputTokens")} value={formatTokens(totals().inputTokens)} />
              <UsageMetricRow testID="usage-output-tokens" label={tr("settings.usage.outputTokens")} value={formatTokens(totals().outputTokens)} />
              <UsageMetricRow testID="usage-requests" label={tr("settings.usage.requests")} value={formatCount(totals().requests)}
                description={totals().failedRequests > 0 || totals().unknownRequests > 0
                  ? tr("settings.usage.failedUnknown", {
                    failed: formatCount(totals().failedRequests),
                    unknown: formatCount(totals().unknownRequests),
                  })
                  : undefined} />
            </If>
          )}
        </If>
      </SettingsSection>

      <If when={hasUsage() && (usageModels().length > 0 || usageGroups().length > 0)}>
        <SettingsSection title={tr("settings.usage.distribution")} flush extra={
            <SegmentedTabs
              size="sm"
              value={usageDistribution()}
              options={USAGE_DISTRIBUTIONS.map(kind => ({
                value: kind.value,
                label: USAGE_DISTRIBUTION_KEYS[kind.value]
                  ? tr(USAGE_DISTRIBUTION_KEYS[kind.value])
                  : kind.label,
                accessibilityLabel: `usage-distribution-${kind.value}`,
              }))}
              onChange={value => chooseUsageDistribution(value)}
            />
        }>
          <SettingsRow label={tr("common.filter")} first>
            <SearchInput
              size="sm"
              value={usageEntryFilter()}
              onChange={setUsageEntryFilter}
              placeholder={tr("settings.usage.filterRows")}
              accessibilityLabel="usage-entry-filter"
            />
          </SettingsRow>
          <If when={usageVisibleRows().total === 0}>
            <SectionFootnote text={tr("settings.usage.noMatchingRows")} />
          </If>
          <If when={usageVisibleRows().rows.length > 0}>
            <View>
              <Each of={usageVisibleRows().rows} key="index">
                {entry => (
                  <View
                    style={{
                      gap: 6,
                      paddingHorizontal: SETTINGS_ROW_INSET,
                      paddingVertical: 10,
                      minHeight: SETTINGS_ROW_MIN,
                      justifyContent: "center",
                      position: "relative",
                      ...paintTransition(MOTION_DURATION.fast),
                    }}
                    hoverStyle={{ backgroundColor: palette().surfaceSubtle }}
                  >
                    <RowSeparator edge="top" />
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text
                        style={{
                          color: palette().text,
                          fontSize: textSize(14),
                          lineHeight: textLineHeight(14, 1.38),
                          flex: 1,
                          minWidth: 0,
                          numberOfLines: 1,
                          textOverflow: "ellipsis",
                        }}
                      >
                        {`${entry().name}${entry().providerName ? ` · ${entry().providerName}` : ""}`}
                      </Text>
                      <Text
                        style={{
                          flexShrink: 0,
                          color: palette().textSecondary,
                          fontSize: textSize(12),
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        {tr("settings.usage.rowMetrics", {
                          requests: formatCount(entry().requests),
                          tokens: formatTokens(entry().tokens),
                        })}
                      </Text>
                      <If when={entry().cacheHitRate !== null}>
                        <Text
                          style={{
                            flexShrink: 0,
                            color: palette().textMuted,
                            fontSize: textSize(12),
                            fontVariant: ["tabular-nums"],
                          }}
                        >
                          {tr("settings.usage.cacheBadge", {
                            rate: formatPercent(entry().cacheHitRate, 0),
                          })}
                        </Text>
                      </If>
                    </View>
                    <View
                      style={{
                        height: 3,
                        borderRadius: radii.pill,
                        backgroundColor: palette().segmentedTrackBg,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        style={{
                          height: "100%",
                          width: `${distributionPeak() > 0 ? Math.max(2, Math.round((entry().tokens / distributionPeak()) * 100)) : 0}%`,
                          borderRadius: radii.pill,
                          backgroundColor: palette().accent,
                          opacity: 0.82,
                        }}
                      />
                    </View>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <If when={usageVisibleRows().hidden}>
            <SettingsRow label={tr("common.more")}>
              <Button
                label={
                  usageExpanded()
                    ? tr("common.showLess")
                    : tr("settings.usage.showAllCount", { count: usageVisibleRows().total })
                }
                variant="secondary"
                size="sm"
                accessibilityLabel="usage-distribution-expand"
                onPress={toggleUsageExpanded}
              />
            </SettingsRow>
          </If>
        </SettingsSection>
      </If>

      <If when={hasUsage()}>
        <View style={{ minWidth: 0, gap: space.lg }}>
          <ConfigSectionHeader title={tr("settings.usage.details")} />
          <If when={trendBars().length > 0}>
            <View style={{ minWidth: 0 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: space.sm,
                  minHeight: space.xl,
                  marginBottom: space.sm,
                  paddingHorizontal: space.xs,
                }}
              >
                <Text role="header" style={textStyle("label", { tabular: true, color: palette().textSecondary })}>
                  {hourly()
                    ? tr("settings.usage.trendHours", { count: trendBars().length })
                    : tr("settings.usage.trendDays", { count: trendBars().length })}
                </Text>
                <If
                  when={hoveredTrendRow()}
                  else={
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                        <View
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: radii.xs,
                            backgroundColor: palette().accent,
                          }}
                        />
                        <Text style={textStyle("micro")}>{tr("settings.usage.output")}</Text>
                      </View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                        <View
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: radii.xs,
                            backgroundColor: palette().accentBorder,
                          }}
                        />
                        <Text style={textStyle("micro")}>{tr("settings.usage.input")}</Text>
                      </View>
                    </View>
                  }
                >
                  {row => (
                    <Text
                      style={{
                        ...textStyle("caption", { color: palette().text, tabular: true }),
                        fontWeight: "600",
                      }}
                    >
                      {tr("settings.usage.trendHover", {
                        bucket: formatBucket(row().bucket, hourly()),
                        input: formatTokens(row().inputTokens) || "0",
                        output: formatTokens(row().outputTokens) || "0",
                        total: formatTokens(row().totalTokens) || "0",
                      })}
                    </Text>
                  )}
                </If>
              </View>
              <View style={insetGroupStyle(space.md)}>
                <View style={{ paddingLeft: 48, paddingRight: space.sm, paddingTop: space.sm, paddingBottom: space.xl }}>
                  <Plot<UsageTrendPlotRow>
                    data={trendBars()}
                    xScale={{
                      type: "band",
                      paddingInner: 0.38,
                      paddingOuter: 0.14,
                      maxBandWidth: 40,
                    }}
                    yScale={{
                      type: "linear",
                      domain: trendBars().some(b => b.totalTokens > 0) ? undefined : [0, 1],
                    }}
                    crossLineStyle={{
                      backgroundColor: palette().surfaceSubtle,
                      borderRadius: radii.xs,
                    }}
                    accessibilityLabel="usage-trend-chart"
                    onHoverChange={event => hoveredUsageTrendIdx.set(event.index)}
                    style={{ width: "100%", height: 140 }}
                  >
                    <Grid
                      ticks={4}
                      style={{
                        stroke: palette().borderSubtle,
                        strokeWidth: 1,
                        strokeDasharray: "3 3",
                      }}
                    />
                    <PlotAxis
                      placement="left"
                      ticks={4}
                      format={value => (value <= 0 ? "0" : formatTokens(value))}
                      labelStyle={{
                        ...textStyle("micro", { tabular: true }),
                        paddingRight: space.sm,
                      }}
                    />
                    <PlotAxis
                      placement="bottom"
                      ticks={Math.min(6, Math.max(1, trendBars().length))}
                      format={value => {
                        const row = trendBars()[Math.round(value)];
                        return row ? row.shortLabel : "";
                      }}
                      labelStyle={{
                        ...textStyle("micro", { tabular: true }),
                        paddingTop: space.sm,
                      }}
                    />
                    <Bar
                      stack="tokens"
                      value="inputTokens"
                      cornerRadii={{ bottomLeft: radii.xs, bottomRight: radii.xs }}
                      inactiveOpacity={0.42}
                      style={{ fill: palette().accentBorder }}
                    />
                    <Bar
                      stack="tokens"
                      value="outputTokens"
                      cornerRadii={{ topLeft: radii.xs, topRight: radii.xs }}
                      inactiveOpacity={0.42}
                      style={{ fill: palette().accent }}
                    />
                  </Plot>
                </View>
              </View>
            </View>
          </If>

          <If when={usageTotals()}>
            {totals => (
              <SettingsSection title={tr("settings.usage.cache")} flush>
                <UsageMetricRow first testID="usage-cache-rate" label={tr("settings.usage.cacheHitRateLabel")}
                  description={tr("settings.usage.cacheHint")}
                  value={formatPercent(usageCacheHitRate(totals()), 1) || tr("settings.usage.cacheUnavailable")} />
                <UsageMetricRow testID="usage-cache-tokens" label={tr("settings.usage.cachedTokens")} value={formatTokens(totals().cachedTokens)} />
                <UsageMetricRow testID="usage-cache-writes" label={tr("settings.usage.cacheWrites")} value={formatTokens(totals().cacheWriteTokens)} />
              </SettingsSection>
            )}
          </If>

          <If when={usageEndpoints().length > 0}>
            <View style={{ minWidth: 0 }}>
              <SectionHeader title={tr("settings.usage.byEndpoint")} />
              <View style={insetGroupStyle()}>
                <Each of={usageEndpoints()} key="index">
                  {(endpoint, index) => (
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        paddingHorizontal: SETTINGS_ROW_INSET,
                        paddingVertical: 10,
                        minHeight: SETTINGS_ROW_MIN,
                        position: "relative",
                      }}
                    >
                      <If when={index() !== 0}>
                        <RowSeparator edge="top" />
                      </If>
                      <Text
                        style={{
                          color: palette().text,
                          fontSize: textSize(14),
                          lineHeight: textLineHeight(14, 1.38),
                          flex: 1,
                          minWidth: 0,
                          numberOfLines: 1,
                          textOverflow: "ellipsis-middle",
                        }}
                      >
                        {`${endpoint().name}${endpoint().providerName ? ` · ${endpoint().providerName}` : ""}`}
                      </Text>
                      <Text style={textStyle("caption", { tabular: true })}>
                        {tr("settings.usage.rowMetrics", {
                          requests: formatCount(endpoint().requests),
                          tokens: formatTokens(endpoint().tokens),
                        })}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>

          <If when={usageBuckets().length > 0}>
            <View style={{ minWidth: 0 }}>
              <SectionHeader title={hourly() ? tr("settings.usage.byHour") : tr("settings.usage.byDay")} />
              <View style={insetGroupStyle()}>
                <Each of={usageBuckets().slice(-12)} key={bucket => bucket.bucket}>
                  {(bucket, index) => (
                    <View
                      style={{
                        flexDirection: "row",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: space.md,
                        paddingHorizontal: SETTINGS_ROW_INSET,
                        paddingVertical: space.md,
                        minHeight: SETTINGS_ROW_MIN,
                        position: "relative",
                      }}
                    >
                      <If when={index() !== 0}>
                        <RowSeparator edge="top" />
                      </If>
                      <Text
                        style={{
                          ...textStyle("mono", { color: palette().textMuted, tabular: true }),
                          minWidth: 112,
                          flexShrink: 0,
                        }}
                      >
                        {formatBucket(bucket().bucket, hourly())}
                      </Text>
                      <Text
                        style={{
                          ...textStyle("caption", { color: palette().text, tabular: true }),
                          flex: 1,
                          minWidth: 160,
                        }}
                      >
                        {tr("settings.usage.bucketBreakdown", {
                          input: formatTokens(bucket().inputTokens),
                          output: formatTokens(bucket().outputTokens),
                          cached: formatTokens(bucket().cachedTokens),
                        })}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}

function TaskModelsSection() {
  useDeviceScopedLoad("task-models", ensureTaskModels, () => void loadTaskModels());
  const valueOf = (task: string): string => {
    const choice: TaskModelChoice = taskModels()[task] ?? { kind: "inherit", modelId: "" };
    return choice.kind === "inherit" ? "inherit" : choice.modelId;
  };
  const optionsFor = (task: string) => {
    const rows: Array<{ value: string; label: string; description?: string; accessibilityLabel: string }> = [
      {
        value: "inherit",
        label: tr("settings.taskModels.inheritsSession"),
        accessibilityLabel: `task-model-inherit-${task}`,
      },
      { value: "primary", label: tr("settings.field.primaryRole"), accessibilityLabel: `task-model-choice-${task}-primary` },
      { value: "fast", label: tr("settings.field.fastRole"), accessibilityLabel: `task-model-choice-${task}-fast` },
      ...selectableChatModels().map(model => ({
        value: model.id,
        label: modelOptionText(model),
        accessibilityLabel: `task-model-choice-${task}-${model.id}`,
      })),
    ];
    const current = valueOf(task);
    if (current && !rows.some(row => row.value === current)) {
      rows.push({
        value: current,
        label: tr("settings.field.notConfiguredSuffix", { name: current }),
        accessibilityLabel: `task-model-choice-${task}-${current}`,
      });
    }
    return rows;
  };
  // The section's notice already says the host stores none yet; rows keep their own line.
  const descriptionOf = (task: string, fallback: string): string =>
    TASK_MODEL_HINT_KEYS[task] ? tr(TASK_MODEL_HINT_KEYS[task]) : fallback;
  return (
    <If when={taskModelsSupported() !== false}>
      <SettingsGroup
        id="task-models"
        title={tr("settings.taskModels.title")}
        description={tr("settings.taskModels.subtitle")}
        notice={taskModelsNotice()}
        onDismissNotice={() => taskModelsNotice.set("")}
      >
        <If when={taskModelsSupported() === null}>
          <View style={{ padding: space.lg }}>
            <Text style={textStyle("caption")}>{tr("settings.taskModels.reading")}</Text>
          </View>
        </If>
        <If when={taskModelsSupported() === true}>
          <Each of={TASK_MODEL_ROWS} key={row => row.id}>
            {(row, index) => (
              <SettingsRow
                label={TASK_MODEL_KEYS[row().id] ? tr(TASK_MODEL_KEYS[row().id]) : row().label}
                description={descriptionOf(row().id, row().hint)}
                first={index() === 0}
              >
                <SelectDropdown
                  size="sm"
                  value={valueOf(row().id)}
                  options={optionsFor(row().id)}
                  searchable={optionsFor(row().id).length > 8}
                  accessibilityLabel={`task-model-${row().id}`}
                  minWidth={settingsCompact() ? NUMBER_STEPPER_WIDTH : 220}
                  maxWidth={settingsCompact() ? undefined : 300}
                  align="end"
                  onChange={value =>
                    void chooseTaskModel(
                      row().id,
                      value === "inherit" ? { kind: "inherit", modelId: "" } : { kind: "fixed", modelId: value },
                    )
                  }
                />
              </SettingsRow>
            )}
          </Each>
        </If>
      </SettingsGroup>
    </If>
  );
}

function ModelRow(props: { model: () => ReturnType<typeof storedModels>[number]; index: () => number }) {
  const compactMeta = (): string => {
    const m = props.model();
    // The model leads the row already; the meta line names it only when it differs.
    const parts: string[] = m.model_name === modelOptionLabel(m) ? [] : [m.model_name];
    if (m.context_window) {
      parts.push(
        tr("settings.models.ctxCompact", { value: formatTokens(m.context_window) }),
      );
    }
    if (m.max_tokens) {
      parts.push(
        tr("settings.models.outCompact", { value: formatTokens(m.max_tokens) }),
      );
    }
    return parts.filter(Boolean).join(" · ");
  };
  const outcome = () => modelTestOutcomes()[props.model().id] ?? { status: "idle" as const };
  const testing = (): boolean => outcome().status === "testing";
  const disabled = () => props.model().enabled === false;
  const menuKey = () => `model-${props.model().id}`;
  return (
    <View
      style={{
        gap: space.sm,
        paddingHorizontal: SETTINGS_ROW_INSET,
        paddingVertical: space.md,
        minHeight: SETTINGS_ROW_MIN,
        justifyContent: "center",
        position: "relative",
        opacity: disabled() ? 0.62 : 1,
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{ backgroundColor: palette().surfaceSubtle }}
    >
      <If when={props.index() !== 0}>
        <RowSeparator edge="top" />
      </If>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: space.md,
        }}
      >
        <View style={{ flex: 1, minWidth: 180, gap: space.hair }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, minWidth: 0 }}>
            <Text
              style={{
                ...textStyle("body"),
                flexShrink: 1,
                minWidth: 0,
                numberOfLines: 1,
                textOverflow: "ellipsis",
              }}
            >
              {modelOptionLabel(props.model())}
            </Text>
            <If when={modelOptionDetail(props.model())}>
              <Text style={textStyle("caption")}>
                {modelOptionDetail(props.model())}
              </Text>
            </If>
            <If when={outcome().status === "testing"}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                <Spinner size={11} color={palette().accent} />
                <Text style={textStyle("micro")}>{tr("common.testing")}</Text>
              </View>
            </If>
            <If when={outcome().status === "success"}>
              <Text style={textStyle("caption", { color: palette().textSecondary })}>
                {outcome().message || tr("common.connected")}
              </Text>
            </If>
            <If when={outcome().status === "error"}>
              <Text style={textStyle("caption", { color: stateColor("failed") })}>
                {tr("common.failed")}
              </Text>
            </If>
          </View>
          <Text
            style={{
              ...textStyle("caption", { color: palette().textMuted, tabular: true }),
              numberOfLines: 1,
              textOverflow: "ellipsis",
            }}
          >
            {compactMeta()}
          </Text>
          <If when={outcome().status === "error" && outcome().errorDetails ? outcome().errorDetails! : ""}>
            {detail => (
              <Text style={textStyle("caption", { color: stateColor("failed") })}>
                {localizeHostError(detail())}
              </Text>
            )}
          </If>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 0, gap: space.sm, marginLeft: "auto" }}>
          <Button
            label={testing() ? tr("common.testing") : tr("common.test")}
            variant="secondary"
            size="sm"
            disabled={testing()}
            accessibilityLabel={`model-test-${props.model().id}`}
            onPress={() => void testSavedModelConnection(props.model())}
          />
          <ToggleSwitch
            checked={!disabled()}
            accessibilityLabel={`model-enabled-${props.model().id}`}
            onChange={next => void setModelEnabled(props.model().id, next)}
          />
          <View ref={el => setRowAnchor(menuKey(), el)} style={{ flexShrink: 0 }}>
            <IconButton
              icon="more"
              size="sm"
              tooltip={tr("settings.models.options")}
              accessibilityLabel={`model-actions-${props.model().id}`}
              onPress={() => rowMenuId.set(rowMenuId() === menuKey() ? null : menuKey())}
            />
          </View>
        </View>
        <DropdownMenu
          open={rowMenuId() === menuKey()}
          anchor={rowMenuAnchors()[menuKey()] ?? null}
          onClose={() => rowMenuId.set(null)}
          items={[
            {
              id: "edit",
              label: tr("common.edit"),
              icon: "edit",
              accessibilityLabel: `model-edit-${props.model().id}`,
              onSelect: () => {
                rowMenuId.set(null);
                resetRemoteDiscovery();
                openModelEditor(props.model().id);
              },
            },
            {
              id: "limits",
              label: tr("settings.models.editLimits"),
              icon: "sliders",
              accessibilityLabel: `model-limits-${props.model().id}`,
              onSelect: () => {
                rowMenuId.set(null);
                openModelLimits(props.model().id);
              },
            },
            {
              id: "remove",
              label: tr("settings.models.removeModel"),
              icon: "trash",
              danger: true,
              confirmDelete: true,
              confirmAccessibilityLabel: `model-delete-confirm-${props.model().id}`,
              accessibilityLabel: `remove-model-${props.model().id}`,
              onSelect: () => {
                rowMenuId.set(null);
                requestModelDelete(null);
                void deleteModel(props.model().id);
              },
            },
          ]}
        />
      </View>
    </View>
  );
}

/** The model form's folded "Advanced" part; opened when an entry already uses it. */
const modelAdvancedOpen = signal(false);

/** A preset or the edited entry already chose the protocol, so the form folds it. */
function modelProtocolDecided(): boolean {
  return Boolean(modelDraft().editingId) || modelCatalogProvider() !== null;
}

const PROTOCOL_TAB_LABELS: Record<(typeof PROVIDER_FORMATS)[number], string> = {
  openai: "OpenAI",
  responses: "Responses",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

/** The wire protocol of the model form, with the hint that `#` sends the base URL verbatim. */
function ModelProtocolField() {
  return (
    <View style={{ gap: space.chip }}>
      <Text style={textStyle("label", { color: palette().textSecondary })}>
        {tr("settings.models.providerFormat")}
      </Text>
      <SegmentedTabs
        size="sm"
        value={modelDraft().provider}
        options={PROVIDER_FORMATS.map(format => ({
          value: format,
          label: PROTOCOL_TAB_LABELS[format] ?? format,
          accessibilityLabel: `model-format-${format}`,
        }))}
        onChange={format => {
          resetRemoteDiscovery();
          updateDraft({ provider: format as (typeof PROVIDER_FORMATS)[number] });
        }}
      />
      <Text style={textStyle("caption", { color: palette().textMuted })}>{tr("settings.models.baseUrlHint")}</Text>
    </View>
  );
}

function ModelFormField(props: {
  label: string;
  value: string;
  placeholder: string;
  secret?: boolean;
  monospace?: boolean;
  accessibilityLabel: string;
  onChange: (value: string) => void;
}) {
  return (
    <InputBox
      label={props.label}
      size="md"
      value={props.value}
      placeholder={props.placeholder}
      masked={props.secret === true}
      monospace={props.monospace}
      accessibilityLabel={props.accessibilityLabel}
      onChange={props.onChange}
    />
  );
}

function LogFilesSection() {
  useDeviceScopedLoad("logging", ensureRuntimeLogging, () => void loadRuntimeLogging());
  return (
    <SettingsSection
      title={tr("settings.logs.title")}
      flush={true}
      subtitle={tr("settings.logs.subtitle")}
      notice={loggingNotice()}
      onDismissNotice={() => loggingNotice.set("")}
      extra={
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <IconButton
            icon="refresh"
            size="sm"
            tooltip={tr("settings.logs.reload")}
            accessibilityLabel="logging-reload"
            onPress={() => void loadRuntimeLogging()}
          />
          <If when={Boolean(runtimeLogging())}>
            <Button
              label={
                loggingBusy() === "export"
                  ? tr("settings.logs.exporting")
                  : tr("settings.logs.exportBundle")
              }
              variant="secondary"
              size="sm"
              leadingIcon="download"
              disabled={loggingBusy() === "export"}
              accessibilityLabel="logging-export"
              onPress={() => diagnosticsExportPending.set(true)}
            />
          </If>
        </View>
      }
    >
      <View>
        <If when={runtimeLogging()}>
          {info => (
            <View>
              {/* The folder of this run: one selectable path and the action that opens it. */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.md,
                  minHeight: SETTINGS_ROW_MIN,
                  paddingHorizontal: SETTINGS_ROW_INSET,
                  paddingVertical: space.sm,
                }}
              >
                <Icon name="folder" size={16} color={palette().textMuted} />
                <Text
                  style={{
                    ...textStyle("mono", {
                      color: info().sessionLogDir ? palette().textSecondary : palette().textMuted,
                    }),
                    flex: 1,
                    minWidth: 0,
                    numberOfLines: 1,
                    textOverflow: "ellipsis-middle",
                    userSelect: "text",
                  }}
                >
                  {info().sessionLogDir || tr("settings.logs.noFolder")}
                </Text>
                <Button
                  label={loggingBusy() === "reveal" ? tr("settings.logs.opening") : tr("common.open")}
                  tooltip={tr("settings.logs.openFolder")}
                  variant="secondary"
                  size="sm"
                  leadingIcon="folder-open"
                  disabled={!info().sessionLogDir || loggingBusy() === "reveal"}
                  accessibilityLabel="logging-open-folder"
                  onPress={() => void revealLogFolder()}
                />
              </View>
              <If when={info().previousCrash}>
                {crash => (
                  <View style={{ paddingHorizontal: SETTINGS_ROW_INSET, paddingBottom: space.md }}>
                    <InlineBanner
                      tone="warning"
                      message={tr("settings.logs.previousCrash", {
                        category: crash().category || tr("common.unknown").toLowerCase(),
                        dir: crash().sessionLogDir || tr("settings.logs.thatFolder"),
                      })}
                    />
                  </View>
                )}
              </If>
            </View>
          )}
        </If>
        <If when={diagnosticsExportPending()}>
          <View
            testID="logging-export-confirm"
            style={{ position: "relative", paddingHorizontal: SETTINGS_ROW_INSET, paddingVertical: space.md, gap: space.sm }}
          >
            <RowSeparator edge="top" />
            <Text style={textStyle("label")}>{tr("settings.logs.exportConfirmTitle")}</Text>
            <InlineConfirmBar
              message={
                settingsValues()["app.logging.include_sensitive_diagnostics"] === true
                  ? tr("settings.logs.exportConfirmSensitive")
                  : tr("settings.logs.exportConfirmStandard")
              }
              confirmLabel={tr("settings.logs.exportConfirmAction")}
              danger={settingsValues()["app.logging.include_sensitive_diagnostics"] === true}
              onConfirm={() => {
                diagnosticsExportPending.set(false);
                void exportDiagnosticsBundle();
              }}
              onCancel={() => diagnosticsExportPending.set(false)}
            />
          </View>
        </If>
        <If when={!runtimeLogging()}>
          <View style={{ paddingHorizontal: SETTINGS_ROW_INSET, paddingVertical: space.md, minHeight: SETTINGS_ROW_MIN, justifyContent: "center" }}>
            <Text style={textStyle("caption")}>{tr("settings.logs.noLocation")}</Text>
          </View>
        </If>
      </View>
    </SettingsSection>
  );
}

function quotaPeriodLabel(seconds: number | undefined): string {
  if (!seconds) return "";
  if (seconds === 7 * 86400) return tr("settings.subscriptions.windowWeekly");
  if (seconds === 30 * 86400) return tr("settings.subscriptions.windowMonthly");
  if (seconds === 86400) return tr("settings.subscriptions.windowDaily");
  if (seconds === 5 * 3600) return tr("settings.subscriptions.window5h");
  if (seconds < 3600) return tr("settings.subscriptions.periodMinutes", { count: Math.round(seconds / 60) });
  if (seconds < 86400) return tr("settings.subscriptions.periodHours", { count: Math.round(seconds / 3600) });
  return tr("settings.subscriptions.periodDays", { count: Math.round(seconds / 86400) });
}

/** One meter as the desktop's quota panel names it: vendor name, period, percent left, reset. */
function formatQuotaMeter(meter: QuotaMeterRow): string {
  const period = quotaPeriodLabel(meter.durationSeconds);
  const vendorName =
    meter.id === "on-demand"
      ? tr("settings.subscriptions.onDemand")
      : currentLocale() === "en-US" || !meter.name
        ? meter.name
        : localizeQuotaWindowLabel(meter.name, "settings.subscriptions.primaryWindow");
  const name =
    vendorName ||
    (meter.secondary ? tr("settings.subscriptions.mcp") : period ? "" : tr("settings.subscriptions.allowance"));
  const parts: string[] = [[name, period].filter(Boolean).join(" · ")];
  if (meter.unlimited) {
    parts.push(tr("settings.subscriptions.unlimited"));
  } else if (meter.remainingPercent !== null) {
    parts.push(tr("settings.subscriptions.percentLeft", { percent: meter.remainingPercent }));
  }
  if (meter.resetsAt !== null && String(meter.resetsAt).trim()) {
    parts.push(formatResetAt(meter.resetsAt));
  }
  return parts.filter(Boolean).join(" · ");
}

/** Why a connected account shows no meter: the host's own state, never a zero. */
function quotaUnknownText(quota: SubscriptionQuotaSummary | null): string {
  if (!quota) return "";
  if (quota.state === "unsupported") return tr("settings.subscriptions.quotaUnsupported");
  if (quota.state === "query_failed") return tr("settings.subscriptions.quotaFailed");
  return tr("settings.subscriptions.quotaUnknown");
}

function quotaBarColor(percent: number): string {
  if (percent < 15) return stateColor("failed");
  if (percent < 40) return stateColor("needs_you");
  return palette().accent;
}

/**
 * The sign-in in progress for one provider: what to do in the browser, the
 * device code when the provider uses one, the address when it could not be
 * opened here, and a way to stop it.
 */
function SubscriptionLoginPanel() {
  const login = () => subscriptionLogin();
  const statusText = (): string => {
    const current = login();
    if (!current) return "";
    if (current.status === "starting") return tr("settings.subscriptions.loginStarting");
    if (current.status === "pending") return current.instructions || tr("settings.subscriptions.loginPending");
    if (current.status === "authorized") return tr("settings.subscriptions.loginAuthorized");
    if (current.status === "cancelled") return tr("settings.subscriptions.loginCancelled");
    return current.error ? localizeHostError(current.error) : tr("settings.subscriptions.loginFailed");
  };
  return (
    <View
      style={{
        gap: space.sm,
        paddingLeft: space.lg,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <If when={login()?.status === "pending" || login()?.status === "starting"}>
          <Spinner size={12} color={palette().accent} />
        </If>
        <Text style={[textStyle("caption"), { flex: 1, minWidth: 0 }]}>{statusText()}</Text>
        <If when={login()?.status === "pending" || login()?.status === "starting"}>
          <Button
            label={tr("common.cancel")}
            variant="ghost"
            size="sm"
            accessibilityLabel="subscription-login-cancel"
            onPress={() => void cancelSubscriptionSignIn()}
          />
        </If>
        <If when={login()?.status !== "pending" && login()?.status !== "starting"}>
          <IconButton
            icon="close"
            size="sm"
            tooltip={tr("common.close")}
            accessibilityLabel="subscription-login-dismiss"
            onPress={() => void cancelSubscriptionSignIn()}
          />
        </If>
      </View>
      <If when={login()?.userCode ?? ""}>
        {code => (
          <Text style={[textStyle("mono"), { fontSize: textSize(15), letterSpacing: 2 }]}>
            {tr("settings.subscriptions.loginCode", { code: code() })}
          </Text>
        )}
      </If>
      <If when={login()?.urlUnopened && login()?.authorizationUrl ? login()!.authorizationUrl! : ""}>
        {url => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Text
              style={[textStyle("mono"), { flex: 1, minWidth: 0, numberOfLines: 1, textOverflow: "ellipsis-middle" }]}
            >
              {url()}
            </Text>
            <Button
              label={tr("settings.subscriptions.copyAddress")}
              variant="secondary"
              size="sm"
              accessibilityLabel="subscription-login-copy"
              onPress={() => copySubscriptionLoginUrl()}
            />
          </View>
        )}
      </If>
    </View>
  );
}

const subscriptionSearchQuery = signal("");
const expandedSubscriptionMeters = signal<Record<string, boolean>>({});

function SubscriptionsSection() {
  useDeviceScopedLoad("subscriptions", () => void loadSubscriptions(), () => void loadSubscriptions(true));
  const filteredAccounts = () => {
    const query = subscriptionSearchQuery().trim().toLowerCase();
    const list = subscriptionAccounts();
    if (!query) return list;
    return list.filter(
      item =>
        (item.display_label || "").toLowerCase().includes(query) ||
        (item.provider || "").toLowerCase().includes(query) ||
        (item.account || "").toLowerCase().includes(query),
    );
  };
  const connectedAccounts = () => filteredAccounts().filter(item => item.connected);
  const availableAccounts = () => filteredAccounts().filter(item => !item.connected);
  const totalConnected = () => subscriptionAccounts().filter(item => item.connected).length;

  return (
    <If when={true}>
      <SettingsSection
        flush={true}
        title={tr("settings.subscriptions.title")}
        subtitle={tr("settings.subscriptions.subtitle")}
        extra={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <If when={subscriptionAccounts().length > 0}>
              <Text style={textStyle("caption", { color: palette().textMuted, tabular: true })}>
                {`${totalConnected()} / ${subscriptionAccounts().length}`}
              </Text>
            </If>
            <If when={subscriptionsLoading()}>
              <Spinner size={13} color={palette().accent} />
            </If>
            <IconButton
              icon="refresh"
              size="sm"
              tooltip={tr("settings.subscriptions.refresh")}
              accessibilityLabel="subscriptions-refresh"
              onPress={() => void loadSubscriptions(true)}
            />
          </View>
        }
      >
        <View style={{ padding: SETTINGS_ROW_INSET, gap: space.md }}>
          <If when={subscriptionAccounts().length > 4}>
            <SearchInput
              value={subscriptionSearchQuery()}
              placeholder={tr("settings.subscriptions.searchPlaceholder")}
              accessibilityLabel="subscriptions-filter-search"
              onChange={value => subscriptionSearchQuery.set(value)}
            />
          </If>

          <If when={Boolean(subscriptionLogin())}>
            <SubscriptionLoginPanel />
          </If>

          <If when={!subscriptionsLoading() && subscriptionAccounts().length === 0}>
            <View style={{ paddingVertical: space.sm, minHeight: SETTINGS_ROW_MIN, justifyContent: "center" }}>
              <Text style={textStyle("caption")}>{tr("settings.subscriptions.none")}</Text>
            </View>
          </If>

          <If when={subscriptionAccounts().length > 0 && filteredAccounts().length === 0}>
            <View style={{ paddingVertical: space.md }}>
              <Text style={textStyle("caption")}>{tr("settings.subscriptions.noFilterMatches")}</Text>
            </View>
          </If>

          {/* Connected subscriptions: compact cards with 2-column quota meters */}
          <If when={connectedAccounts().length > 0}>
            <View style={{ gap: space.sm }}>
              <Text style={{ ...textStyle("micro", { color: palette().textMuted }), fontWeight: "600" }}>
                {tr("settings.subscriptions.connectedGroup", { count: connectedAccounts().length })}
              </Text>
              <View style={{ gap: space.sm }}>
                <Each of={connectedAccounts()} key={item => item.account_id}>
                  {item => {
                    const quota = () => subscriptionQuotas()[item().account_id] ?? null;
                    const meters = () => quotaMeters(quota());
                    const showAllMeters = () => expandedSubscriptionMeters()[item().account_id] === true;
                    const visibleMeters = () => (showAllMeters() ? meters() : meters().slice(0, 2));
                    const hiddenMeterCount = () => Math.max(0, meters().length - 2);
                    return (
                      <View
                        style={{
                          gap: space.sm,
                          paddingHorizontal: space.md,
                          paddingVertical: space.md,
                          borderRadius: radii.md,
                          borderCurve: "continuous",
                          borderWidth: 1,
                          borderColor: item().reauthentication_required
                            ? palette().borderStrong
                            : palette().borderSubtle,
                          backgroundColor: palette().surfaceTertiary,
                          ...paintTransition(MOTION_DURATION.fast),
                        }}
                      >
                        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                          <If
                            when={Boolean(item().reauthentication_required)}
                            else={<StatusDot kind="success" />}
                          >
                            <StateMark state="needs_you" size={12} />
                          </If>
                          <View style={{ flex: 1, minWidth: 140, gap: space.hair }}>
                            <Text
                              style={{
                                ...textStyle("body"),
                                fontWeight: "500",
                                numberOfLines: 1,
                                textOverflow: "ellipsis",
                              }}
                            >
                              {item().display_label || item().provider}
                            </Text>
                            <If when={item().account || quota()?.plan}>
                              <Text
                                style={{
                                  ...textStyle("caption"),
                                  numberOfLines: 1,
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {[item().account, quota()?.plan].filter(Boolean).join(" · ")}
                              </Text>
                            </If>
                          </View>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
                            <If when={Boolean(item().reauthentication_required)}>
                              <Text style={textStyle("caption", { color: stateColor("needs_you") })}>
                                {tr("settings.subscriptions.reauthNeeded")}
                              </Text>
                              <Button
                                label={tr("settings.subscriptions.signInAgain")}
                                variant="secondary"
                                size="xs"
                                leadingIcon="log-in"
                                disabled={
                                  (subscriptionLogin()?.accountId === (item().account_id || item().provider)) &&
                                  (subscriptionLogin()?.status === "pending" || subscriptionLogin()?.status === "starting")
                                }
                                accessibilityLabel={`subscription-connect-${item().account_id || item().provider}`}
                                onPress={() =>
                                  void startSubscriptionSignIn(
                                    item().provider,
                                    isRemotePeerContext(),
                                    item().login_methods ?? [],
                                    item().account_id || item().provider,
                                  )
                                }
                              />
                            </If>
                            <Button
                              label={tr("devices.signOut")}
                              variant="ghost"
                              size="xs"
                              loading={subscriptionSigningOut() === (item().account_id || item().provider)}
                              disabled={subscriptionSigningOut() === (item().account_id || item().provider)}
                              accessibilityLabel={`subscription-signout-${item().account_id || item().provider}`}
                              onPress={() =>
                                void signOutSubscriptionAccount(item().provider, item().account_id || undefined)
                              }
                            />
                          </View>
                        </View>

                        <If when={visibleMeters().length > 0}>
                          <View
                            style={{
                              display: "grid",
                              gridTemplateColumns:
                                settingsCompact() || visibleMeters().length === 1
                                  ? "minmax(0, 1fr)"
                                  : "repeat(2, minmax(0, 1fr))",
                              gap: space.md,
                              paddingTop: space.xs,
                            }}
                          >
                            <Each of={visibleMeters()} key={meter => meter.id}>
                              {meter => (
                                <View style={{ gap: space.xs, minWidth: 0 }}>
                                  <Text
                                    style={{
                                      ...textStyle("caption", { color: palette().textSecondary, tabular: true }),
                                      fontWeight: "500",
                                      numberOfLines: 1,
                                      textOverflow: "ellipsis",
                                    }}
                                  >
                                    {formatQuotaMeter(meter())}
                                  </Text>
                                  <If when={meter().remainingPercent !== null}>
                                    <View
                                      style={{
                                        height: 4,
                                        borderRadius: radii.pill,
                                        backgroundColor: palette().segmentedTrackBg,
                                        overflow: "hidden",
                                      }}
                                    >
                                      <View
                                        style={{
                                          height: "100%",
                                          width: `${meter().remainingPercent ?? 0}%`,
                                          borderRadius: radii.pill,
                                          backgroundColor: quotaBarColor(meter().remainingPercent ?? 0),
                                        }}
                                      />
                                    </View>
                                  </If>
                                </View>
                              )}
                            </Each>
                          </View>
                        </If>

                        <If when={hiddenMeterCount() > 0}>
                          <View style={{ flexDirection: "row" }}>
                            <Button
                              label={
                                showAllMeters()
                                  ? tr("settings.subscriptions.fewerMeters")
                                  : tr("settings.subscriptions.moreMeters", { count: hiddenMeterCount() })
                              }
                              variant="ghost"
                              size="xs"
                              onPress={() =>
                                expandedSubscriptionMeters.update(curr => ({
                                  ...curr,
                                  [item().account_id]: !showAllMeters(),
                                }))
                              }
                            />
                          </View>
                        </If>

                        <If when={quota() && meters().length === 0 ? quotaUnknownText(quota()) : ""}>
                          {text => <Text style={textStyle("caption")}>{text()}</Text>}
                        </If>
                      </View>
                    );
                  }}
                </Each>
              </View>
            </View>
          </If>

          {/* Disconnected / available providers: compact 2-column card grid so 10+ providers stay scannable */}
          <If when={availableAccounts().length > 0}>
            <View style={{ gap: space.sm }}>
              <Text style={{ ...textStyle("micro", { color: palette().textMuted }), fontWeight: "600" }}>
                {tr("settings.subscriptions.availableGroup", { count: availableAccounts().length })}
              </Text>
              <View
                style={{
                  display: "grid",
                  gridTemplateColumns: settingsCompact() ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))",
                  gap: space.sm,
                }}
              >
                <Each of={availableAccounts()} key={item => item.account_id}>
                  {item => (
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: space.sm,
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                        minHeight: 54,
                        borderRadius: radii.md,
                        borderCurve: "continuous",
                        borderWidth: 1,
                        borderColor: palette().borderSubtle,
                        backgroundColor: palette().surfaceTertiary,
                        ...paintTransition(MOTION_DURATION.fast),
                      }}
                      hoverStyle={{
                        backgroundColor: palette().surfaceSubtle,
                        borderColor: palette().borderStrong,
                      }}
                    >
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text
                          style={{
                            ...textStyle("body"),
                            fontWeight: "500",
                            numberOfLines: 1,
                            textOverflow: "ellipsis",
                          }}
                        >
                          {item().display_label || item().provider}
                        </Text>
                        <Text
                          style={{
                            ...textStyle("caption"),
                            numberOfLines: 1,
                            textOverflow: "ellipsis",
                          }}
                        >
                          {tr("common.disconnected")}
                        </Text>
                      </View>
                      <Button
                        label={tr("settings.subscriptions.signIn")}
                        variant="secondary"
                        size="xs"
                        leadingIcon="log-in"
                        disabled={
                          (subscriptionLogin()?.accountId === (item().account_id || item().provider)) &&
                          (subscriptionLogin()?.status === "pending" || subscriptionLogin()?.status === "starting")
                        }
                        accessibilityLabel={`subscription-connect-${item().account_id || item().provider}`}
                        onPress={() =>
                          void startSubscriptionSignIn(
                            item().provider,
                            isRemotePeerContext(),
                            item().login_methods ?? [],
                            item().account_id || item().provider,
                          )
                        }
                      />
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>
        </View>
      </SettingsSection>
    </If>
  );
}

interface ModelProviderGroup {
  key: string;
  label: string;
  host: string;
  format: string;
  baseUrl: string;
  models: ReturnType<typeof storedModels>;
  enabledCount: number;
  hasPrimary: boolean;
}

const KNOWN_PROVIDER_HOST_LABELS: Record<string, string> = {
  "api.openai.com": "OpenAI",
  "api.anthropic.com": "Anthropic",
  "generativelanguage.googleapis.com": "Google Gemini",
  "api.deepseek.com": "DeepSeek",
  "openrouter.ai": "OpenRouter",
  "api.groq.com": "Groq",
  "api.mistral.ai": "Mistral",
  "api.x.ai": "xAI",
  "dashscope.aliyuncs.com": "Alibaba Qwen",
  "ark.cn-beijing.volces.com": "Volcengine Ark",
  "open.bigmodel.cn": "Zhipu GLM",
  "api.moonshot.cn": "Moonshot Kimi",
  "api.minimax.chat": "MiniMax",
  "api.siliconflow.cn": "SiliconFlow",
};

const FORMAT_DISPLAY_LABELS: Record<string, string> = {
  openai: "OpenAI",
  responses: "OpenAI Responses",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};

function endpointHostOf(rawUrl: string | undefined): string {
  const trimmed = (rawUrl ?? "").trim().replace(/#$/, "");
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return parsed.host.toLowerCase();
  } catch {
    return trimmed.replace(/^https?:\/\//i, "").split("/")[0]?.toLowerCase() ?? "";
  }
}

function providerLabelFor(format: string, host: string): string {
  if (host) {
    const known = KNOWN_PROVIDER_HOST_LABELS[host];
    if (known) return known;
    if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) return `Local (${host})`;
    const catalogMatch = catalogProviders().find(provider =>
      provider.endpoints.some(ep => endpointHostOf(ep.baseUrl) === host),
    );
    if (catalogMatch?.name) return catalogMatch.name;
    return host;
  }
  return FORMAT_DISPLAY_LABELS[format] ?? (format || tr("settings.models.customProvider"));
}

const modelSearchQuery = signal("");
const modelStatusFilter = signal<"all" | "enabled">("all");
const providerGroupExpanded = signal<Record<string, boolean>>({});

function groupModelsByProvider(
  models: ReturnType<typeof storedModels>,
  primaryId: string | null | undefined,
): ModelProviderGroup[] {
  const byKey = new Map<string, ModelProviderGroup>();
  const order: string[] = [];
  for (const model of models) {
    const format = normalizeModelFormat(model.provider);
    const host = endpointHostOf(model.base_url);
    const key = `${format}-${host || "default"}`.replace(/[^a-z0-9.-]+/g, "-");
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: providerLabelFor(format, host),
        host,
        format,
        baseUrl: (model.base_url ?? "").trim(),
        models: [],
        enabledCount: 0,
        hasPrimary: false,
      };
      byKey.set(key, group);
      order.push(key);
    }
    group.models.push(model);
    if (model.enabled !== false) group.enabledCount += 1;
    if (primaryId && model.id === primaryId) group.hasPrimary = true;
  }
  return order
    .map(key => byKey.get(key)!)
    .sort((a, b) => {
      if (a.hasPrimary !== b.hasPrimary) return a.hasPrimary ? -1 : 1;
      if ((a.enabledCount > 0) !== (b.enabledCount > 0)) return a.enabledCount > 0 ? -1 : 1;
      return 0;
    });
}

function ModelSection() {
  void loadModels();
  // Each time the form opens, the folded part starts open only when the entry uses it.
  effect(() => {
    if (!modelFormOpen()) return;
    untracked(() => {
      const draft = modelDraft();
      modelAdvancedOpen.set(draft.customHeaders.trim() !== "" || draft.skipSslVerify);
    });
  });
  const limitsModalOpen = usePresenceFlag(() => modelLimitsDraft() !== null);
  const limitsTargetModel = () =>
    storedModels().find(model => model.id === modelLimitsDraft()?.id) ?? null;
  const discoveredMatches = () => {
    const query = discoverySearchQuery().trim().toLowerCase();
    const all = mergedDiscoveredOptions(modelDraft());
    if (!query) return all;
    return all.filter(
      opt =>
        opt.id.toLowerCase().includes(query) ||
        opt.label.toLowerCase().includes(query) ||
        (opt.description ?? "").toLowerCase().includes(query),
    );
  };
  const isDiscoveredSelected = (id: string): boolean => {
    const key = id.trim().toLowerCase();
    return selectedDiscoveredIds().some(item => item.trim().toLowerCase() === key);
  };
  const urlPreview = (): string =>
    previewRequestUrl(modelDraft().baseUrl, modelDraft().provider, modelDraft().modelName);
  const testStatus = () => draftTestOutcome();

  const filteredModels = () => {
    const query = modelSearchQuery().trim().toLowerCase();
    const status = modelStatusFilter();
    return storedModels().filter(model => {
      if (status === "enabled" && model.enabled === false) return false;
      if (!query) return true;
      const host = endpointHostOf(model.base_url);
      const format = normalizeModelFormat(model.provider);
      const label = modelOptionLabel(model).toLowerCase();
      return (
        label.includes(query) ||
        (model.name ?? "").toLowerCase().includes(query) ||
        (model.model_name ?? "").toLowerCase().includes(query) ||
        format.includes(query) ||
        host.includes(query) ||
        providerLabelFor(format, host).toLowerCase().includes(query)
      );
    });
  };

  const groups = () => groupModelsByProvider(filteredModels(), defaultModels().primary);
  const hasActiveSearch = () => modelSearchQuery().trim().length > 0;

  const isGroupExpanded = (key: string): boolean => hasActiveSearch() || providerGroupExpanded()[key] === true;

  const allGroupsExpanded = () => {
    const list = groups();
    return list.length > 0 && list.every(group => isGroupExpanded(group.key));
  };

  const toggleAllGroups = () => {
    const next = !allGroupsExpanded();
    const patch: Record<string, boolean> = { ...providerGroupExpanded() };
    for (const group of groups()) patch[group.key] = next;
    providerGroupExpanded.set(patch);
  };

  const totalEnabled = () => storedModels().filter(m => m.enabled !== false).length;

  return (
    <SettingsSection
      flush={true}
      title={tr("settings.models.title")}
      subtitle={tr("settings.models.subtitle")}
      notice={modelSettingsNotice()}
      onDismissNotice={() => modelSettingsNotice.set("")}
      extra={
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <If when={storedModels().length > 0}>
            <Text style={textStyle("caption", { color: palette().textMuted, tabular: true })}>
              {tr("settings.models.providerSummary", {
                enabled: totalEnabled(),
                total: storedModels().length,
              })}
            </Text>
          </If>
          <Button
            label={tr("settings.models.addModel")}
            leadingIcon="plus"
            variant="primary"
            size="sm"
            accessibilityLabel="add-model"
            onPress={() => {
              resetRemoteDiscovery();
              openModelForm();
            }}
          />
        </View>
      }
    >
      <View>
        <If when={!modelSettingsLoaded()}>
          <View style={{ padding: space.lg }}>
            <Text style={textStyle("caption")}>{tr("settings.models.reading")}</Text>
          </View>
        </If>
        <If when={modelSettingsLoaded() && storedModels().length === 0}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              paddingHorizontal: SETTINGS_ROW_INSET,
              paddingVertical: space.lg,
            }}
          >
            <Icon name="cpu" size={16} color={palette().textMuted} />
            <Text style={textStyle("caption")}>{tr("settings.models.empty")}</Text>
          </View>
        </If>

        <If when={storedModels().length > 0}>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: space.sm,
              paddingHorizontal: SETTINGS_ROW_INSET,
              paddingVertical: space.sm,
              position: "relative",
            }}
          >
            <SearchInput
              value={modelSearchQuery()}
              placeholder={tr("settings.models.searchPlaceholder")}
              accessibilityLabel="models-filter-search"
              style={{ flex: 1, minWidth: 160 }}
              onChange={value => modelSearchQuery.set(value)}
            />
            <SegmentedTabs
              size="sm"
              value={modelStatusFilter()}
              options={[
                { value: "all", label: tr("settings.models.filterAll"), accessibilityLabel: "models-filter-all" },
                { value: "enabled", label: tr("settings.models.filterEnabled"), accessibilityLabel: "models-filter-enabled" },
              ]}
              onChange={value => modelStatusFilter.set(value)}
            />
            <If when={groups().length > 1 && !hasActiveSearch()}>
              <Button
                label={allGroupsExpanded() ? tr("settings.models.collapseAll") : tr("settings.models.expandAll")}
                variant="ghost"
                size="xs"
                accessibilityLabel="models-toggle-all-groups"
                onPress={toggleAllGroups}
              />
            </If>
            <RowSeparator edge="bottom" />
          </View>
        </If>

        <If when={storedModels().length > 0 && groups().length === 0}>
          <View style={{ paddingHorizontal: SETTINGS_ROW_INSET, paddingVertical: space.lg }}>
            <Text style={textStyle("caption")}>{tr("settings.models.noFilterMatches")}</Text>
          </View>
        </If>

        <Each of={groups()} key={group => group.key}>
          {(group, groupIndex) => {
            const expanded = () => isGroupExpanded(group().key);
            return (
              <View style={{ position: "relative" }}>
                <If when={groupIndex() !== 0}>
                  <RowSeparator edge="top" />
                </If>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.sm,
                    paddingHorizontal: SETTINGS_ROW_INSET,
                    paddingVertical: space.sm,
                    minHeight: 42,
                    backgroundColor: palette().surfaceTertiary,
                  }}
                >
                  <View
                    role="button"
                    accessibilityLabel={`provider-group-toggle-${group().key}`}
                    accessibilityState={{ expanded: expanded() }}
                    onPress={() => {
                      const current = expanded();
                      providerGroupExpanded.update(prev => ({ ...prev, [group().key]: !current }));
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.sm,
                      paddingVertical: 2,
                      cursor: "pointer",
                      userSelect: "none",
                      ...pressTransition(MOTION_DURATION.fast),
                    }}
                    activeStyle={tactileActiveStyle(0.99)}
                    focusVisibleStyle={focusRingStyle()}
                  >
                    <View style={{ flexShrink: 0, ...rotatingChevronStyle(expanded()) }}>
                      <Icon name="chevron-right" size={13} color={palette().textMuted} />
                    </View>
                    <Text
                      style={{
                        ...textStyle("label"),
                        fontWeight: "600",
                        flexShrink: 1,
                        minWidth: 0,
                        numberOfLines: 1,
                        textOverflow: "ellipsis",
                      }}
                    >
                      {group().label}
                    </Text>
                    <If when={Boolean(group().host) && group().host !== group().label}>
                      <Text
                        style={{
                          ...textStyle("caption", { color: palette().textMuted }),
                          flexShrink: 2,
                          minWidth: 0,
                          numberOfLines: 1,
                          textOverflow: "ellipsis",
                        }}
                      >
                        {group().host}
                      </Text>
                    </If>
                  </View>
                  <Text style={textStyle("caption", { color: palette().textMuted, tabular: true })}>
                    {`${group().enabledCount}/${group().models.length}`}
                  </Text>
                  <IconButton
                    icon="plus"
                    size="xs"
                    tooltip={tr("settings.models.addInProvider", { provider: group().label })}
                    accessibilityLabel={`provider-add-model-${group().key}`}
                    onPress={() => {
                      resetRemoteDiscovery();
                      openModelForm({
                        provider: group().format,
                        baseUrl: group().baseUrl,
                      });
                    }}
                  />
                </View>
                <If when={expanded()}>
                  <View style={{ position: "relative" }}>
                    <RowSeparator edge="top" />
                    <Each of={group().models} key={model => model.id}>
                      {(model, index) => <ModelRow model={model} index={index} />}
                    </Each>
                  </View>
                </If>
              </View>
            );
          }}
        </Each>

        {/* Add Model Modal */}
        <ModalDialog
          open={modelFormOpen()}
          title={
            modelDraft().editingId
              ? tr("settings.models.editModalTitle", { name: modelDraft().name || modelDraft().modelName })
              : tr("settings.models.addModalTitle")
          }
          subtitle={
            modelDraft().editingId ? tr("settings.models.editModalSubtitle") : tr("settings.models.addModalSubtitle")
          }
          size="lg"
          accessibilityLabel="model-editor-modal"
          onClose={() => {
            resetRemoteDiscovery();
            closeModelForm();
          }}
          footer={
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: space.sm,
                flex: 1,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flex: 1, minWidth: 140 }}>
                <Button
                  label={testStatus().status === "testing" ? tr("common.testing") : tr("common.test")}
                  variant="secondary"
                  size="md"
                  disabled={testStatus().status === "testing"}
                  accessibilityLabel="model-draft-test"
                  onPress={() => void testDraftConnection(modelDraft())}
                />
                <If when={testStatus().status === "testing"}>
                  <Spinner size={14} color={palette().accent} />
                </If>
                <If when={testStatus().status === "success"}>
                  <Text style={textStyle("caption", { color: palette().textSecondary })}>
                    {testStatus().message || tr("common.connected")}
                  </Text>
                </If>
                <If when={testStatus().status === "error"}>
                  <Text style={textStyle("caption", { color: stateColor("failed") })}>
                    {tr("common.failed")}
                  </Text>
                </If>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", flexShrink: 0, gap: space.sm }}>
                <Button
                  label={tr("common.cancel")}
                  variant="ghost"
                  size="md"
                  accessibilityLabel="model-editor-cancel"
                  onPress={() => {
                    resetRemoteDiscovery();
                    closeModelForm();
                  }}
                />
                <Button
                  label={modelDraft().editingId ? tr("common.save") : tr("settings.models.addModel")}
                  variant="primary"
                  size="md"
                  accessibilityLabel="save-model"
                  onPress={() => void saveModelDraft()}
                />
              </View>
            </View>
          }
        >
          <View style={{ gap: space.lg }}>
            <If when={testStatus().status === "error" && testStatus().errorDetails ? testStatus().errorDetails! : ""}>
              {err => <InlineBanner tone="danger" message={localizeHostError(err())} />}
            </If>
            {/* Presets: a provider fills the endpoint and protocol; models are typed or discovered remotely. */}
            <If when={!modelDraft().editingId && modelCatalogLoaded() && modelCatalog().length > 0}>
              <View style={{ gap: space.sm }}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                  <Text style={{ ...textStyle("caption"), flex: 1, minWidth: 200 }}>{tr("settings.models.discoverHint")}</Text>
                  <SearchInput
                    size="sm"
                    value={modelCatalogQuery()}
                    placeholder={tr("common.filter")}
                    accessibilityLabel="model-filter"
                    style={{ width: settingsCompact() ? "100%" : 180 }}
                    onChange={value => setCatalogQuery(value)}
                  />
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                  <Each of={catalogProviders()} key={provider => provider.id}>
                    {provider => (
                      <SelectableChip
                        label={provider().name}
                        active={modelCatalogProvider() === provider().id}
                        accessibilityLabel={`model-catalog-provider-${provider().id}`}
                        onPress={() => {
                          resetRemoteDiscovery();
                          chooseCatalogProvider(provider().id);
                        }}
                      />
                    )}
                  </Each>
                </View>
                <If when={modelCatalogNotice() !== ""}>
                  <Text style={textStyle("caption")}>{localizeHostError(modelCatalogNotice())}</Text>
                </If>
              </View>
            </If>
            {/* Protocol stays in view only while nothing chose it yet (no preset, not an edit). */}
            <If when={!modelProtocolDecided()}>
              <ModelProtocolField />
            </If>
            <View style={{ gap: space.xs }}>
              <ModelFormField
                label={tr("settings.models.baseUrl")}
                value={modelDraft().baseUrl}
                placeholder="https://api.openai.com/v1"
                monospace
                accessibilityLabel="model-base-url"
                onChange={value => {
                  resetRemoteDiscovery();
                  updateDraft({ baseUrl: value });
                }}
              />
              <If when={urlPreview()}>
                {preview => (
                  <Text
                    accessibilityLabel="model-request-url-preview"
                    style={{
                      ...textStyle("caption", { color: palette().textMuted }),
                      fontFamily: fontMono(),
                      minWidth: 0,
                      numberOfLines: 2,
                      textOverflow: "ellipsis-middle",
                      userSelect: "text",
                    }}
                  >
                    {tr("settings.models.requestUrl", { url: preview() })}
                  </Text>
                )}
              </If>
            </View>
            <ModelFormField
              label={tr("settings.models.apiKey")}
              value={modelDraft().apiKey}
              placeholder={tr("settings.models.apiKeyPlaceholder")}
              secret
              accessibilityLabel="model-api-key"
              onChange={value => {
                resetRemoteDiscovery();
                updateDraft({ apiKey: value });
              }}
            />
            <View style={{ gap: space.xs }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: space.sm }}>
                <View style={{ flex: 1, minWidth: 200 }}>
                  <ModelFormField
                    label={tr("settings.models.modelName")}
                    value={modelDraft().modelName}
                    placeholder="gpt-4.1-mini"
                    monospace
                    accessibilityLabel="model-model-name"
                    onChange={value => updateDraft({ modelName: value })}
                  />
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 0, gap: space.sm }}>
                  <Button
                    label={
                      remoteDiscoveryLoading()
                        ? tr("settings.models.detecting")
                        : tr("settings.models.detectModels")
                    }
                    variant="secondary"
                    size="md"
                    loading={remoteDiscoveryLoading()}
                    disabled={remoteDiscoveryLoading()}
                    accessibilityLabel="model-detect-btn"
                    onPress={() => void detectModelsForConfig(modelDraft(), true)}
                  />
                  <Button
                    label={`${tr("settings.models.quickAddModels")}${remoteDiscoveredModels().length > 0 ? ` (${remoteDiscoveredModels().length})` : ""}`}
                    variant="secondary"
                    size="md"
                    accessibilityLabel="settings-model-select"
                    onPress={() => openDiscoveryPicker(modelDraft())}
                  />
                </View>
              </View>
              <If when={remoteDiscoveryLoading()}>
                <Text style={textStyle("caption")}>{tr("settings.models.queryingRemote")}</Text>
              </If>
              <If when={!remoteDiscoveryLoading() && remoteDiscoveredModels().length > 0}>
                <Text style={textStyle("caption", { color: palette().textSecondary, tabular: true })}>
                  {tr("settings.models.detectedSummary", { count: remoteDiscoveredModels().length })}
                </Text>
              </If>
              <If when={remoteDiscoveryError()}>
                {err => (
                  <Text style={textStyle("caption", { color: stateColor("needs_you") })}>
                    {localizeHostError(err())}
                  </Text>
                )}
              </If>
            </View>
            {/* Everything set once or rarely: folded, open when the entry already uses it. */}
            <View style={{ position: "relative", gap: space.md }}>
              <RowSeparator edge="top" />
              <View
                role="button"
                accessibilityLabel="model-more-options"
                accessibilityState={{ expanded: modelAdvancedOpen() }}
                hitSlop={touchSlop(controlHeight.sm)}
                onPress={() => modelAdvancedOpen.update(open => !open)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  minHeight: compactLayout() ? layout.touchTarget : controlHeight.sm,
                  marginTop: space.sm,
                  cursor: "pointer",
                  userSelect: "none",
                  ...pressTransition(MOTION_DURATION.fast),
                }}
                activeStyle={tactileActiveStyle(0.99)}
                focusVisibleStyle={focusRingStyle()}
              >
                <View style={{ flexShrink: 0, ...rotatingChevronStyle(modelAdvancedOpen()) }}>
                  <Icon name="chevron-right" size={13} color={palette().textMuted} />
                </View>
                <Text style={{ ...textStyle("label", { color: palette().textSecondary }), fontWeight: "600" }}>
                  {tr("settings.models.advanced")}
                </Text>
              </View>
              <If when={modelAdvancedOpen()}>
                <View style={{ gap: space.md }}>
                  <ModelFormField
                    label={tr("common.name")}
                    value={modelDraft().name}
                    placeholder={modelDraft().modelName.trim() || tr("settings.models.namePlaceholder")}
                    accessibilityLabel="model-name"
                    onChange={value => updateDraft({ name: value })}
                  />
                  <If when={modelProtocolDecided()}>
                    <ModelProtocolField />
                  </If>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
                    <View style={{ flex: 1, minWidth: 160 }}>
                      <ModelFormField
                        label={tr("settings.models.contextWindow")}
                        value={modelDraft().contextWindow}
                        placeholder="200000"
                        accessibilityLabel="model-context-window"
                        onChange={value => updateDraft({ contextWindow: value })}
                      />
                    </View>
                    <View style={{ flex: 1, minWidth: 160 }}>
                      <ModelFormField
                        label={tr("settings.models.maxOutput")}
                        value={modelDraft().maxTokens}
                        placeholder="8000"
                        accessibilityLabel="model-max-output"
                        onChange={value => updateDraft({ maxTokens: value })}
                      />
                    </View>
                  </View>
                  <View style={{ gap: space.chip }}>
                    <Text style={textStyle("label", { color: palette().textSecondary })}>
                      {tr("settings.models.category")}
                    </Text>
                    <Scroll smoothWheel horizontal style={{ maxWidth: "100%" }}>
                      <SegmentedTabs
                        size="sm"
                        value={modelDraft().category}
                        options={MODEL_CATEGORIES.map(category => ({
                          value: category,
                          label: tr(MODEL_CATEGORY_KEYS[category]),
                          accessibilityLabel: `model-category-${category}`,
                        }))}
                        onChange={category => updateDraft({ category })}
                      />
                    </Scroll>
                  </View>
                  <InputBox
                    label={tr("settings.models.customHeaders")}
                    hint={tr("settings.models.customHeadersHint")}
                    size="md"
                    multiline={true}
                    minHeight={64}
                    monospace={true}
                    value={modelDraft().customHeaders}
                    placeholder="X-Team: research"
                    accessibilityLabel="model-custom-headers"
                    onChange={value => updateDraft({ customHeaders: value })}
                  />
                  <If when={modelDraft().customHeaders.trim() !== ""}>
                    <SegmentedTabs
                      size="sm"
                      value={modelDraft().customHeadersMode}
                      options={[
                        { value: "merge", label: tr("settings.models.headersMerge"), accessibilityLabel: "model-headers-merge" },
                        { value: "replace", label: tr("settings.models.headersReplace"), accessibilityLabel: "model-headers-replace" },
                      ]}
                      onChange={mode => updateDraft({ customHeadersMode: mode as "merge" | "replace" })}
                    />
                  </If>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                    <View style={{ flex: 1, minWidth: 0, gap: space.hair }}>
                      <Text style={textStyle("label")}>{tr("settings.models.skipSsl")}</Text>
                      <Text style={textStyle("caption")}>{tr("settings.models.skipSslHint")}</Text>
                    </View>
                    <ToggleSwitch
                      value={modelDraft().skipSslVerify}
                      accessibilityLabel="model-skip-ssl"
                      onChange={next => updateDraft({ skipSslVerify: next })}
                    />
                  </View>
                </View>
              </If>
            </View>
          </View>
        </ModalDialog>

        {/* Model Discovery & Multi-Add Modal */}
        <ModalDialog
          open={discoveryPickerOpen()}
          title={tr("settings.models.discoverTitle")}
          subtitle={tr("settings.models.discoverSubtitle")}
          size="md"
          accessibilityLabel="model-discovery-modal"
          onClose={() => closeDiscoveryPicker()}
          footer={
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: space.sm,
                flex: 1,
              }}
            >
              <Text style={textStyle("caption")}>
                {tr("settings.models.selectedCount", { count: selectedDiscoveredIds().length })}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                <Button
                  label={tr("common.cancel")}
                  variant="ghost"
                  size="md"
                  accessibilityLabel="model-discovery-cancel"
                  onPress={() => closeDiscoveryPicker()}
                />
                <Button
                  label={
                    selectedDiscoveredIds().length > 1
                      ? tr("settings.models.addCountModels", { count: selectedDiscoveredIds().length })
                      : tr("settings.models.useSelectedModel")
                  }
                  variant="primary"
                  size="md"
                  disabled={selectedDiscoveredIds().length === 0}
                  accessibilityLabel="model-discovery-confirm"
                  onPress={() =>
                    void addAllSelectedDiscoveredModels(modelDraft()).then(savedBatch => {
                      if (savedBatch) closeModelForm();
                    })
                  }
                />
              </View>
            </View>
          }
        >
          <View style={{ gap: space.md }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <SearchInput
                  size="md"
                  value={discoverySearchQuery()}
                  onChange={value => discoverySearchQuery.set(value)}
                  placeholder={tr("settings.models.discoverSearch")}
                  accessibilityLabel="model-discovery-search"
                />
              </View>
              <Button
                label={
                  remoteDiscoveryLoading()
                    ? tr("settings.models.refreshing")
                    : tr("common.refresh")
                }
                variant="secondary"
                size="md"
                disabled={remoteDiscoveryLoading()}
                accessibilityLabel="model-discovery-refresh"
                onPress={() => void detectModelsForConfig(modelDraft(), true)}
              />
            </View>
            <If when={remoteDiscoveryError()}>
              {err => (
                <Text style={textStyle("caption", { color: stateColor("needs_you") })}>
                  {localizeHostError(err())}
                </Text>
              )}
            </If>
            <If when={discoveredMatches().length === 0}>
              <Text style={textStyle("caption")}>{tr("settings.models.noMatches")}</Text>
            </If>
            <Scroll smoothWheel style={{ maxHeight: 260, minHeight: 0, flexShrink: 1 }}>
              <View style={{ gap: space.sm }}>
                <Each of={discoveredMatches()} key={item => item.id}>
                  {item => {
                    const selected = () => isDiscoveredSelected(item().id);
                    return (
                      <View
                        role="button"
                        accessibilityLabel={`model-discovery-option-${item().id}`}
                        accessibilityState={{ selected: selected() }}
                        onPress={() => toggleDiscoveredModel(item().id)}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: space.md,
                          paddingHorizontal: space.md,
                          paddingVertical: space.sm,
                          minHeight: compactLayout() ? layout.touchTarget : controlHeight.md,
                          borderRadius: radii.md,
                          borderCurve: "continuous",
                          borderWidth: 1,
                          borderColor: selected() ? palette().borderStrong : palette().borderSubtle,
                          backgroundColor: palette().surfaceTertiary,
                          cursor: "pointer",
                          userSelect: "none",
                          ...pressTransition(MOTION_DURATION.fast),
                        }}
                        hoverStyle={{ backgroundColor: listRowHoverBg() }}
                        activeStyle={tactileActiveStyle(0.99)}
                        focusVisibleStyle={focusRingStyle()}
                      >
                        <ListRowContent
                          icon={selected() ? "check" : "plus"}
                          iconColor={selected() ? palette().textSecondary : palette().textMuted}
                          title={item().label}
                          titleWeight={selected() ? "500" : "400"}
                          subtitle={item().description}
                          trailing={
                            <Badge
                              label={
                                item().source === "remote"
                                  ? tr("common.remote")
                                  : tr("settings.models.catalog")
                              }
                              tone={item().source === "remote" ? "accent" : "neutral"}
                            />
                          }
                        />
                      </View>
                    );
                  }}
                </Each>
              </View>
            </Scroll>
          </View>
        </ModalDialog>

        {/* Model Token Limits & Endpoint Details Modal */}
        <ModalDialog
          open={limitsModalOpen()}
          title={tr("settings.models.limitsTitle")}
          subtitle={
            limitsTargetModel()?.name ?? tr("settings.models.limitsModalDefaultSub")
          }
          size="sm"
          accessibilityLabel="model-limits-modal"
          onClose={() => closeModelLimits()}
          onSubmit={() => void saveModelLimits()}
          footer={
            <If when={modelLimitsDraft() !== null}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                <Button
                  label={tr("common.cancel")}
                  variant="secondary"
                  size="md"
                  accessibilityLabel={`model-limits-cancel-${modelLimitsDraft()?.id ?? ""}`}
                  onPress={() => closeModelLimits()}
                />
                <Button
                  label={tr("common.save")}
                  variant="primary"
                  size="md"
                  accessibilityLabel={`model-limits-save-${modelLimitsDraft()?.id ?? ""}`}
                  onPress={() => void saveModelLimits()}
                />
              </View>
            </If>
          }
        >
          <If when={modelLimitsDraft() !== null}>
            <View style={{ gap: space.md }}>
              <If when={limitsTargetModel()?.request_url || limitsTargetModel()?.base_url || ""}>
                {endpoint => (
                  <View style={{ gap: space.xs }}>
                    <Text style={textStyle("label", { color: palette().textSecondary })}>
                      {tr("settings.models.endpointLabel")}
                    </Text>
                    <View
                      style={{
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                        borderRadius: radii.md,
                        borderCurve: "continuous",
                        borderWidth: 1,
                        borderColor: palette().borderSubtle,
                        backgroundColor: palette().surfaceTertiary,
                      }}
                    >
                      <Text
                        style={{
                          ...textStyle("mono", { color: palette().textSecondary }),
                          numberOfLines: 2,
                          textOverflow: "ellipsis-middle",
                        }}
                      >
                        {endpoint()}
                      </Text>
                    </View>
                  </View>
                )}
              </If>
              <InputBox
                label={tr("settings.models.contextWindow")}
                size="md"
                value={modelLimitsDraft()?.contextWindow ?? ""}
                placeholder={tr("settings.models.tokensUnit")}
                accessibilityLabel={`model-context-${modelLimitsDraft()?.id ?? ""}`}
                onChange={val => updateModelLimitsDraft({ contextWindow: val })}
              />
              <InputBox
                label={tr("settings.models.maxOutput")}
                size="md"
                value={modelLimitsDraft()?.maxTokens ?? ""}
                placeholder={tr("settings.models.tokensUnit")}
                accessibilityLabel={`model-max-tokens-${modelLimitsDraft()?.id ?? ""}`}
                onChange={val => updateModelLimitsDraft({ maxTokens: val })}
              />
              <Text style={textStyle("caption")}>{tr("settings.models.limitsHint")}</Text>
            </View>
          </If>
        </ModalDialog>
      </View>
    </SettingsSection>
  );
}

function AppearanceSwatchGallery() {
  const outerR = radii.md;
  const pad = space.sm;
  const previewR = concentricRadius(outerR, pad);
  const canvasR = concentricRadius(previewR, space.hair);
  return (
    <View
      style={{
        padding: space.lg,
      }}
    >
      <View
        style={{
          display: "grid",
          gridTemplateColumns: settingsCompact() ? "repeat(2, minmax(0, 1fr))" : "repeat(3, minmax(0, 1fr))",
          gap: space.md,
        }}
      >
        <Each of={APPEARANCE_PRESETS} key={preset => preset.id}>
          {preset => {
            const active = () => resolvedAppearanceId() === preset().id;
            const sw = () => preset().palette;
            return (
              <View
                role="button"
                accessibilityLabel={`appearance-swatch-${preset().id}`}
                accessibilityState={{ selected: active() }}
                onPress={() => chooseAppearancePreset(preset().id)}
                style={{
                  gap: space.sm,
                  padding: pad,
                  borderRadius: outerR,
                  borderCurve: "continuous",
                  borderWidth: 2,
                  borderColor: active() ? palette().accent : palette().borderSubtle,
                  backgroundColor: active() ? palette().accentSoft : "transparent",
                  cursor: "pointer",
                  userSelect: "none",
                  ...pressTransition(MOTION_DURATION.fast),
                }}
                hoverStyle={{
                  borderColor: active() ? palette().accent : palette().borderStrong,
                  backgroundColor: active() ? palette().accentSoft : palette().panelHover,
                }}
                activeStyle={tactileActiveStyle(0.98)}
                focusVisibleStyle={focusRingStyle()}
              >
                {/* Sleek Micro-Window Preview */}
                <View
                  style={{
                    position: "relative",
                    height: 54,
                    borderRadius: previewR,
                    borderCurve: "continuous",
                    borderWidth: 1,
                    borderColor: sw().borderStrong,
                    backgroundColor: sw().chromeBg,
                    flexDirection: "row",
                    overflow: "hidden",
                    padding: space.hair,
                    gap: space.hair,
                  }}
                >
                  {/* Sidebar Rail */}
                  <View
                    style={{
                      width: "27%",
                      paddingHorizontal: space.xs,
                      paddingVertical: space.xs,
                      justifyContent: "space-between",
                    }}
                  >
                    <View style={{ gap: space.xs }}>
                      <View
                        style={{
                          height: 3,
                          width: "82%",
                          borderRadius: radii.pill,
                          backgroundColor: sw().chromeAccent,
                        }}
                      />
                      <View
                        style={{
                          height: 2,
                          width: "66%",
                          borderRadius: radii.pill,
                          backgroundColor: sw().chromeTextMuted,
                          opacity: 0.55,
                        }}
                      />
                      <View
                        style={{
                          height: 2,
                          width: "54%",
                          borderRadius: radii.pill,
                          backgroundColor: sw().chromeTextMuted,
                          opacity: 0.36,
                        }}
                      />
                    </View>
                    <View
                      style={{
                        height: 3,
                        width: "46%",
                        borderRadius: radii.pill,
                        backgroundColor: sw().chromeTextMuted,
                        opacity: 0.42,
                      }}
                    />
                  </View>

                  {/* Inset Scene Canvas */}
                  <View
                    style={{
                      flex: 1,
                      borderRadius: canvasR,
                      borderCurve: "continuous",
                      backgroundColor: sw().canvas,
                      padding: space.sm,
                      justifyContent: "space-between",
                    }}
                  >
                    <View style={{ gap: space.xs }}>
                      <View
                        style={{
                          height: 4,
                          width: "58%",
                          borderRadius: radii.pill,
                          backgroundColor: sw().text,
                          opacity: 0.85,
                        }}
                      />
                      <View
                        style={{
                          height: 3,
                          width: "84%",
                          borderRadius: radii.pill,
                          backgroundColor: sw().textMuted,
                          opacity: 0.44,
                        }}
                      />
                    </View>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: space.xs,
                      }}
                    >
                      <View
                        style={{
                          height: 11,
                          flex: 1,
                          borderRadius: radii.xs,
                          backgroundColor: sw().panelRaised,
                          borderWidth: 1,
                          borderColor: sw().border,
                        }}
                      />
                      <View
                        style={{
                          height: 11,
                          width: 22,
                          borderRadius: radii.pill,
                          backgroundColor: sw().actionPrimaryBg,
                        }}
                      />
                    </View>
                  </View>

                  {/* Check mark on the active preset */}
                  <If when={active()}>
                    <View
                      style={{
                        position: "absolute",
                        top: space.xs,
                        right: space.xs,
                        width: 18,
                        height: 18,
                        borderRadius: radii.pill,
                        backgroundColor: palette().actionSolid,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon name="check" size={10} color={palette().actionSolidFg} />
                    </View>
                  </If>
                </View>

                <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.xs }}>
                  <Text
                    style={{
                      ...textStyle("caption", { color: palette().text }),
                      flex: 1,
                      minWidth: 0,
                      fontWeight: active() ? "600" : "500",
                      numberOfLines: 1,
                      textOverflow: "ellipsis",
                    }}
                  >
                    {tr(APPEARANCE_PRESET_KEYS[preset().id])}
                  </Text>
                  <Text style={{ ...textStyle("caption", { color: palette().textSecondary }), flexShrink: 0 }}>
                    {preset().isLight
                      ? tr("settings.appearance.schemeLight")
                      : tr("settings.appearance.schemeDark")}
                  </Text>
                </View>
              </View>
            );
          }}
        </Each>
      </View>
    </View>
  );
}

function AppearanceSection() {
  const followSystem = () => appearanceMode() === "system" && appearanceId() === null;
  return (
    <View style={{ gap: layout.sectionGap }}>
      <SettingsSection flush title={tr("settings.appearance.themeSection")}>
        <ConfigRow
          label={tr("settings.appearance.followSystem")}
          description={
            resolvedScheme() === "light"
              ? tr("settings.appearance.showingLight")
              : tr("settings.appearance.showingDark")
          }
          divider={false}
        >
          <ToggleSwitch
            value={followSystem()}
            accessibilityLabel="appearance-follow-system"
            onChange={next => setFollowSystemAppearance(next)}
          />
        </ConfigRow>
        <If when={!followSystem()}>
          <View style={{ position: "relative" }}>
            <RowSeparator edge="top" />
            <AppearanceSwatchGallery />
          </View>
        </If>
      </SettingsSection>
      <FontPreferencesSection />
      <ContentWidthSection />
      <SessionPanelLayoutSection />
    </View>
  );
}

function SessionPanelLayoutSection() {
  return (
    <SettingsSection title={tr("settings.appearance.sessionPanel")} flush>
      <SettingsRow label={tr("settings.appearance.sessionPanelLayout")} first>
        <SelectDropdown<AuxPaneDisplayMode>
          size="sm"
          align="end"
          fullWidth
          testID="session-panel-layout"
          accessibilityLabel={tr("settings.appearance.sessionPanelLayout")}
          value={auxPaneDisplayMode()}
          options={[
            { value: "split", label: tr("settings.appearance.sessionPanelSplit"), accessibilityLabel: "session-panel-split" },
            { value: "overlay", label: tr("settings.appearance.sessionPanelOverlay"), accessibilityLabel: "session-panel-overlay" },
          ]}
          onChange={auxPaneDisplayMode.set}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

/** Pixel preferences have a draft while typing and update the surface on commit. */
function AppearancePixelStepper(props: {
  id: string;
  label: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  onCommit: (value: number) => void;
}) {
  const draft = signal<string | null>(null);
  const text = () => draft() ?? String(props.value);
  const clamp = (value: number) => Math.max(props.min, Math.min(props.max ?? Infinity, Math.round(value)));
  const parsed = () => text().trim() ? Number(text()) : NaN;
  const base = () => Number.isFinite(parsed()) ? clamp(parsed()) : props.value;
  const commit = (delta = 0) => {
    const next = clamp(base() + delta);
    draft.set(null);
    props.onCommit(next);
  };
  return (
    <SettingsNumberStepper
      id={props.id}
      label={props.label}
      text={text()}
      unit={tr("settings.unit.px")}
      dirty={draft() !== null && draft() !== String(props.value)}
      decreaseDisabled={base() <= props.min}
      increaseDisabled={props.max !== undefined && base() >= props.max}
      onDecrease={() => commit(-props.step)}
      onIncrease={() => commit(props.step)}
      onChangeText={draft.set}
      onSubmit={() => commit()}
      onCancelEdit={() => draft.set(null)}
    />
  );
}

function ContentWidthSection() {
  return (
    <SettingsSection title={tr("settings.appearance.conversationWidth")} flush
      notice={contentWidthNotice()} onDismissNotice={() => contentWidthNotice.set("")}
      extra={
        <Button label={tr("common.reset")} variant="ghost" size="sm"
          accessibilityLabel="content-width-reset" disabled={contentWidth() === DEFAULT_CONTENT_WIDTH}
          onPress={() => resetContentWidth()} />
      }>
      <SettingsRow label={tr("settings.appearance.contentWidth")}
        description={tr("settings.appearance.contentWidthMinimum", { min: MIN_CONTENT_WIDTH })} first>
        <AppearancePixelStepper
          id="content-width"
          label={tr("settings.appearance.contentWidth")}
          value={contentWidth()}
          min={MIN_CONTENT_WIDTH}
          step={CONTENT_WIDTH_STEP}
          onCommit={setContentWidth}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

function FontPreferencesSection() {
  const preview = signal("");
  return (
    <SettingsSection title={tr("settings.appearance.textSize")} flush
      notice={fontNotice()} onDismissNotice={() => fontNotice.set("")}
      extra={
        <Button label={tr("common.reset")} variant="ghost" size="sm"
          accessibilityLabel="font-size-reset" disabled={fontLevel() === "default" && !fontNotice()}
          onPress={() => void resetFontPreference()} />
      }>
      <SettingsRow label={tr("settings.appearance.interfaceSize")}
        description={tr("settings.appearance.fontBaseline", { px: fontPx() })} first>
        <SelectDropdown<FontLevel>
          size="sm"
          align="end"
          fullWidth
          value={fontLevel()}
          testID="font-level-select"
          accessibilityLabel={tr("settings.appearance.interfaceSize")}
          options={[
            ...FONT_LEVELS.map(entry => ({
              value: entry.level,
              label: tr(FONT_LEVEL_KEYS[entry.level]),
              accessibilityLabel: `font-level-${entry.level}`,
            })),
            { value: "custom", label: tr(FONT_LEVEL_KEYS.custom), accessibilityLabel: "font-level-custom" },
          ]}
          onChange={level => void chooseFontLevel(level)}
        />
      </SettingsRow>
      <If when={fontLevel() === "custom"}>
        <SettingsRow label={tr("settings.appearance.customFontSize")}>
          <AppearancePixelStepper
            id="font-size"
            label={tr("settings.appearance.customFontSize")}
            value={fontPx()}
            min={MIN_FONT_PX}
            max={MAX_FONT_PX}
            step={1}
            onCommit={px => void setCustomFontPx(px)}
          />
        </SettingsRow>
      </If>
      <SettingsRow label={tr("settings.appearance.fontPreview")} stacked>
        <TextField
          size="sm"
          testID="font-size-preview"
          accessibilityLabel={tr("settings.appearance.fontPreview")}
          placeholder={tr("settings.appearance.textSizePreview")}
          fontSize={fontPx()}
          value={preview()}
          onChange={preview.set}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

function PoolsSection() {
  const poolModalOpen = usePresenceFlag(() => poolDraft() !== null);
  const busy = () => poolBusy() || poolsLoading();
  const close = () => { if (!poolBusy()) closePoolDraft(); };
  return (
    <If when={poolsSupported() !== false}>
      <SettingsSection flush title={tr("settings.pools.title")} subtitle={tr("settings.pools.subtitle")}
        notice={poolDraft() ? "" : poolsNotice()} onDismissNotice={() => poolsNotice.set("")}
        extra={
          <If when={poolsSupported() === true && pools().length > 0}>
            <Button label={tr("settings.pools.addPool")} leadingIcon="plus" variant="secondary" size="sm"
              accessibilityLabel="add-pool" disabled={busy()} onPress={() => openPoolDraft()} />
          </If>
        }>
        <View>
          <If when={poolsLoading()}>
            <View style={{ padding: space.lg }}>
              <Text style={textStyle("caption")}>{tr("settings.pools.reading")}</Text>
            </View>
          </If>
          <If when={poolsSupported() === null && !poolsLoading()}>
            <ConfigRow label={tr("settings.pools.loadingFailed")} divider={false}>
              <Button label={tr("common.retry")} variant="secondary" size="sm" onPress={() => void loadPools()} />
            </ConfigRow>
          </If>
          <If when={poolsSupported() === true && pools().length === 0 && !poolDraft()}>
            <ConfigRow label={tr("settings.pools.emptyLegacy")} description={tr("settings.pools.emptyHint")} divider={false}>
              <Button label={tr("settings.pools.createPool")} leadingIcon="plus" variant="secondary" size="sm"
                accessibilityLabel="add-pool" disabled={busy()} onPress={() => openPoolDraft()} />
            </ConfigRow>
          </If>
          <Each of={pools()} key={pool => pool.id}>
            {(pool, index) => <PoolRow pool={pool} first={index() === 0} />}
          </Each>
          <ModalDialog open={poolModalOpen()}
            title={tr(poolDraft()?.id ? "settings.pools.editModalTitle" : "settings.pools.createModalTitle")}
            size="md" accessibilityLabel="pool-editor-modal" closeOnBackdropPress={false} onClose={close}
            footer={
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Button label={tr("common.cancel")} variant="secondary" size="md" accessibilityLabel="pool-cancel"
                  disabled={poolBusy()} onPress={close} />
                <Button label={tr(poolDraft()?.id ? "settings.pools.savePool" : "settings.pools.createPool")} variant="primary" size="md"
                  accessibilityLabel="save-pool" loading={poolBusy()} disabled={!canSavePoolDraft()}
                  onPress={() => void savePoolDraft()} />
              </View>
            }>
            <If when={poolDraft() !== null}><ModelPoolEditor /></If>
          </ModalDialog>
        </View>
      </SettingsSection>
    </If>
  );
}

function PoolRow(props: { pool: () => ModelPool; first: boolean }) {
  const confirmOpen = signal(false);
  const pool = props.pool;
  const busy = () => poolBusy() || poolsLoading();
  const close = () => { if (!poolBusy()) confirmOpen.set(false); };
  const remove = async () => {
    if (await deletePool(pool().id)) confirmOpen.set(false);
  };
  return <>
    <ConfigRow label={pool().name} topDivider={!props.first} divider={false}
      style={{ paddingHorizontal: space.lg }} controlStyle={{ gap: space.xs }}>
      <Badge label={tr("settings.pools.membersSummary", { strategy: poolStrategyLabel(pool().strategy),
        count: formatCount(pool().memberModelIds.length) })} pill size="xs" />
      <IconButton icon="edit" size="sm" tooltip={tr("settings.pools.editPool")} disabled={busy()}
        accessibilityLabel={"edit-pool-" + pool().id} onPress={() => openPoolDraft(pool())} />
      <IconButton icon="trash" size="sm" tone="danger" tooltip={tr("settings.pools.deletePool")} disabled={busy()}
        accessibilityLabel={"delete-pool-" + pool().id} onPress={() => {
          poolsNotice.set("");
          confirmOpen.set(true);
        }} />
    </ConfigRow>
    <ModalDialog open={confirmOpen()} title={tr("settings.pools.deleteTitle", { name: pool().name })}
      size="sm" accessibilityLabel="pool-delete-dialog" onClose={close} closeOnBackdropPress={false}
      footer={<View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Button label={tr("common.cancel")} variant="secondary" size="md" accessibilityLabel="pool-delete-cancel"
          disabled={poolBusy()} onPress={close} />
        <Button label={tr("common.delete")} variant="danger" size="md" accessibilityLabel="pool-delete-confirm"
          loading={poolBusy()} disabled={busy()} onPress={() => void remove()} />
      </View>}>
      <View style={{ gap: space.sm }}>
        <Text style={textStyle("body")}>{tr("settings.pools.deleteHint")}</Text>
        <If when={poolsNotice()}>{notice => <InlineBanner tone="danger" message={localizeHostError(notice())} />}</If>
      </View>
    </ModalDialog>
  </>;
}

function LanguageRow() {
  return (
    <SettingsRow label={tr("settings.language.title")} first={true}>
      <SelectDropdown
        size="sm"
        testID="app-language-select"
        accessibilityLabel={tr("settings.language.title")}
        accessibilityDescription={tr("settings.language.hint")}
        value={currentLocale()}
        disabled={appLocaleSaving()}
        fullWidth
        align="end"
        options={SUPPORTED_LOCALES.map(entry => ({
          value: entry.id,
          label: entry.nativeName,
          accessibilityLabel: `app-language-${entry.id}`,
        }))}
        onChange={locale => void writeAppLanguage(locale)}
      />
    </SettingsRow>
  );
}

function AccountRow() {
  return (
    <SettingsRow
      label={tr("settings.account.title")}
      description={
        isAccountSignedIn()
          ? tr("devices.accountSignedInAs", { account: signedInAccountDisplay() })
          : tr("settings.account.subtitle")
      }
      first={true}
    >
      <If when={isAccountSignedIn()}>
        <Button
          label={tr("settings.account.manage")}
          variant="secondary"
          size="sm"
          accessibilityLabel="settings-account-manage"
          onPress={() => openAccountAuthModal()}
        />
      </If>
      <If when={!isAccountSignedIn()}>
        <Button
          label={tr("devices.signInCta")}
          variant="primary"
          size="sm"
          leadingIcon="log-in"
          accessibilityLabel="settings-account-sign-in"
          onPress={() => openAccountAuthModal({ autoStart: true })}
        />
      </If>
    </SettingsRow>
  );
}

/**
 * `terminal.default_shell` over the shells this host detects: empty means the
 * host picks (auto-detect), as the desktop's terminal page offers it.
 */
function DefaultShellRow() {
  useDeviceScopedLoad("terminal-shells", () => void loadTerminalShells(), () => void loadTerminalShells(true));
  useDeviceScopedLoad("terminal-preferences", () => void loadTerminalPreferences(), () => void loadTerminalPreferences(true));
  const selected = (): string => {
    const value = terminalPreferences()?.defaultShell ?? "";
    return findConfiguredTerminalShell(value)?.path || value;
  };
  const options = () => {
    const rows = [
      { value: "", label: tr("settings.terminal.autoDetect"), accessibilityLabel: "terminal-default-shell-auto" },
      ...terminalShells().map(shell => ({
        value: shell.path,
        label: shell.name,
        description: shell.path,
        accessibilityLabel: `terminal-default-shell-${shell.id || shell.path}`,
      })),
    ];
    const current = selected();
    if (current && !rows.some(row => row.value === current)) {
      rows.push({
        value: current,
        label: tr("settings.field.notConfiguredSuffix", { name: current }),
        description: current,
        accessibilityLabel: "terminal-default-shell-stored",
      });
    }
    return rows;
  };
  const saving = signal(false);
  const choose = async (value: string): Promise<void> => {
    const device = deviceContext();
    saving.set(true);
    try {
      await setConfig("terminal.default_shell", value, device ? { target: device } : undefined);
      if (device !== deviceContext()) return;
      await loadTerminalPreferences(true);
      if (device !== deviceContext()) return;
      setSectionNotice("terminal", tr("settings.notice.savedField", { label: tr("settings.terminal.defaultShell") }));
    } catch (error) {
      if (device === deviceContext()) setSectionNotice("terminal", error instanceof Error ? error.message : String(error));
    } finally {
      saving.set(false);
    }
  };
  return (
    <SettingsRow
      label={tr("settings.terminal.defaultShell")}
      description={
        terminalShells().length === 0 ? tr("settings.terminal.noShells") : tr("settings.terminal.defaultShellDesc")
      }
      first={true}
    >
      <If when={saving()}>
        <Spinner size={12} color={palette().accent} />
      </If>
      <SelectDropdown
        size="sm"
        value={selected()}
        options={options()}
        accessibilityLabel="terminal-default-shell"
        disabled={saving() || terminalShells().length === 0}
        minWidth={settingsCompact() ? NUMBER_STEPPER_WIDTH : 220}
        maxWidth={settingsCompact() ? undefined : 300}
        align="end"
        onChange={value => void choose(value)}
      />
    </SettingsRow>
  );
}

const DEFAULT_MODEL_SLOT_KEYS: Record<DefaultModelSlot, { labelKey: MessageKey; descriptionKey: MessageKey; emptyKey: MessageKey; capability: string }> = {
  primary: {
    labelKey: "settings.defaultModels.primary",
    descriptionKey: "settings.defaultModels.primaryDesc",
    emptyKey: "common.none",
    capability: "text_chat",
  },
  fast: {
    labelKey: "settings.defaultModels.fast",
    descriptionKey: "settings.defaultModels.fastDesc",
    emptyKey: "settings.defaultModels.followPrimary",
    capability: "text_chat",
  },
  economy: {
    labelKey: "settings.defaultModels.economy",
    descriptionKey: "settings.defaultModels.economyDesc",
    emptyKey: "common.none",
    capability: "text_chat",
  },
  image_understanding: {
    labelKey: "settings.defaultModels.imageUnderstanding",
    descriptionKey: "settings.defaultModels.imageUnderstandingDesc",
    emptyKey: "common.none",
    capability: "image_understanding",
  },
  speech_recognition: {
    labelKey: "settings.defaultModels.speechRecognition",
    descriptionKey: "settings.defaultModels.speechRecognitionDesc",
    emptyKey: "common.none",
    capability: "speech_recognition",
  },
};

const PRIMARY_DEFAULT_SLOTS: ReadonlyArray<DefaultModelSlot> = ["primary", "fast"];
const SECONDARY_DEFAULT_SLOTS: ReadonlyArray<DefaultModelSlot> = [
  "economy",
  "image_understanding",
  "speech_recognition",
];
const defaultModelMoreSlotsOpen = signal(false);

/**
 * `ai.default_models`: compact 2-column routing card showing Primary & Fast
 * directly, with specialized capability slots tucked cleanly below a disclosure
 * toggle so the Models page stays scannable at any scale.
 */
function DefaultModelsSection() {
  useDeviceScopedLoad("default-models", () => void loadDefaultModels(), () => void loadDefaultModels());
  const optionsFor = (slot: DefaultModelSlot) => {
    const meta = DEFAULT_MODEL_SLOT_KEYS[slot];
    const models = storedModels().filter(model => isSelectableForCapability(model, meta.capability));
    const rows: Array<{ value: string; label: string; description?: string; accessibilityLabel: string }> = [];
    if (slot !== "primary") {
      rows.push({ value: "", label: tr(meta.emptyKey), accessibilityLabel: `default-model-${slot}-none` });
    }
    for (const model of models) {
      rows.push({
        value: model.id,
        label: modelOptionText(model),
        accessibilityLabel: `default-model-${slot}-${model.id}`,
      });
    }
    const current = defaultModels()[slot];
    if (current && !rows.some(row => row.value === current)) {
      rows.push({
        value: current,
        label: tr("settings.field.notConfiguredSuffix", { name: current }),
        accessibilityLabel: `default-model-${slot}-stored`,
      });
    }
    return rows;
  };
  const configuredSecondaryCount = () =>
    SECONDARY_DEFAULT_SLOTS.filter(slot => Boolean(defaultModels()[slot])).length;

  const renderSlotCell = (slot: () => DefaultModelSlot) => (
    <View style={{ gap: space.xs, minWidth: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <Text style={textStyle("label")}>{tr(DEFAULT_MODEL_SLOT_KEYS[slot()].labelKey)}</Text>
        <If when={defaultModelSaving() === slot()}>
          <Spinner size={11} color={palette().accent} />
        </If>
      </View>
      <Text
        style={{
          ...textStyle("caption"),
          numberOfLines: 1,
          textOverflow: "ellipsis",
        }}
      >
        {tr(DEFAULT_MODEL_SLOT_KEYS[slot()].descriptionKey)}
      </Text>
      <SelectDropdown
        size="sm"
        value={defaultModels()[slot()] || (slot() === "fast" ? "" : null)}
        options={optionsFor(slot())}
        placeholder={tr("settings.defaultModels.choose")}
        searchable={optionsFor(slot()).length > 8}
        accessibilityLabel={`default-model-${slot()}`}
        disabled={defaultModelSaving() !== null || (slot() === "primary" && optionsFor(slot()).length === 0)}
        minWidth={140}
        onChange={value => void chooseDefaultModel(slot(), value || null)}
      />
    </View>
  );

  return (
    <SettingsGroup
      id="default-models"
      title={tr("settings.defaultModels.title")}
      description={tr("settings.defaultModels.subtitle")}
      notice={defaultModelsNotice()}
      onDismissNotice={() => defaultModelsNotice.set("")}
    >
      <View style={{ paddingHorizontal: SETTINGS_ROW_INSET, paddingVertical: space.md }}>
        <View
          style={{
            display: "grid",
            gridTemplateColumns: settingsCompact() ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))",
            gap: space.md,
          }}
        >
          <Each of={[...PRIMARY_DEFAULT_SLOTS]} key={slot => slot}>
            {slot => renderSlotCell(slot)}
          </Each>
        </View>
      </View>
      <View style={{ position: "relative" }}>
        <RowSeparator edge="top" />
        <View
          role="button"
          accessibilityLabel="default-models-more-slots"
          accessibilityState={{ expanded: defaultModelMoreSlotsOpen() }}
          onPress={() => defaultModelMoreSlotsOpen.update(v => !v)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
            paddingHorizontal: SETTINGS_ROW_INSET,
            paddingVertical: space.sm,
            minHeight: 38,
            cursor: "pointer",
            userSelect: "none",
            ...pressTransition(MOTION_DURATION.fast),
          }}
          hoverStyle={{ backgroundColor: palette().surfaceSubtle }}
          activeStyle={tactileActiveStyle(0.99)}
          focusVisibleStyle={focusRingStyle()}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            <View style={{ flexShrink: 0, ...rotatingChevronStyle(defaultModelMoreSlotsOpen()) }}>
              <Icon name="chevron-right" size={12} color={palette().textMuted} />
            </View>
            <Text style={textStyle("caption", { color: palette().textSecondary })}>
              {tr("settings.defaultModels.moreSlots", { count: SECONDARY_DEFAULT_SLOTS.length })}
            </Text>
          </View>
          <If when={configuredSecondaryCount() > 0}>
            <Text style={textStyle("caption", { color: palette().textMuted, tabular: true })}>
              {tr("settings.defaultModels.moreSlotsConfigured", { count: configuredSecondaryCount() })}
            </Text>
          </If>
        </View>
        <If when={defaultModelMoreSlotsOpen()}>
          <View
            style={{
              position: "relative",
              paddingHorizontal: SETTINGS_ROW_INSET,
              paddingBottom: space.md,
              paddingTop: space.sm,
            }}
          >
            <RowSeparator edge="top" />
            <View
              style={{
                display: "grid",
                gridTemplateColumns: settingsCompact() ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))",
                gap: space.md,
                paddingTop: space.sm,
              }}
            >
              <Each of={[...SECONDARY_DEFAULT_SLOTS]} key={slot => slot}>
                {slot => renderSlotCell(slot)}
              </Each>
            </View>
          </View>
        </If>
      </View>
    </SettingsGroup>
  );
}

/**
 * Launch at login is a login item on the host, set through product control as
 * the desktop's General page does. A host that does not answer says so.
 */
function LaunchAtLoginRow() {
  useDeviceScopedLoad("general-control", () => void loadGeneralControl(), () => void loadGeneralControl(true));
  const value = () => generalControlValue("launch-at-login");
  return (
    <SettingsRow
      label={tr("settings.field.launchAtLogin")}
      description={
        generalControlValues() === null
          ? tr("settings.field.launchAtLoginReading")
          : value() === undefined
            ? tr("settings.field.launchAtLoginUnavailable")
            : tr("settings.field.launchAtLoginDesc")
      }
      first={true}
    >
      <FieldStatus saving={generalControlSaving() === "launch-at-login"} saved={fieldJustSaved("launch-at-login")} />
      <If when={value() !== undefined}>
        <ToggleSwitch
          value={value() === true}
          accessibilityLabel="launch-at-login"
          disabled={generalControlSaving() !== null}
          onChange={next => void setGeneralControl("launch-at-login", next)}
        />
      </If>
    </SettingsRow>
  );
}

/** Picks a `.zip` pet pack and imports it on this device. */
async function pickCompanionPack(): Promise<void> {
  const files = await Picker.pickFiles({
    multiple: false,
    filters: [{ name: "Petdex", extensions: ["zip"] }],
    maxSize: 64 * 1024 * 1024,
  });
  const picked = files[0];
  if (!picked?.file || picked.status !== "read") return;
  const bytes = new Uint8Array(await picked.file.arrayBuffer());
  await importCompanionPetArchive(picked.name, Buffer.from(bytes).toString("base64"));
}

/** Imports a pet pack; drawn in the Pet page's header, where other pages keep their actions. */
function PetImportButton() {
  return (
    <Button
      label={tr("pet.import")}
      variant="secondary"
      size="sm"
      leadingIcon="upload"
      loading={companionBusy() === "import"}
      accessibilityLabel="pet-import"
      onPress={() => void pickCompanionPack()}
    />
  );
}

/**
 * Settings › Pet (wave22-p3): the desktop pet (on/off, character, import) and
 * desktop cards (on/off). Both are floating windows of the desktop app, so a
 * phone or a browser shows one "Desktop only" row instead of switches that
 * would do nothing there.
 */
function DesktopCompanionRow() {
  effect(() => {
    if (!companionAvailableHere()) return;
    untracked(() => {
      void loadCompanionSettings();
      void loadCompanionPets();
    });
  });
  return (
    <If
      when={companionAvailableHere()}
      else={
        <SettingsRow label={tr("settings.field.desktopCompanion")} description={tr("pet.desktopOnlyBody")} first={true}>
          <Text accessibilityLabel="desktop-companion-desktop-only" style={textStyle("caption")}>
            {tr("pet.desktopOnly")}
          </Text>
        </SettingsRow>
      }
    >
      <View>
        <If when={companionNotice()}>
          {notice => <InlineBanner tone="danger" message={notice()} onDismiss={() => companionNotice.set("")} />}
        </If>
        <SettingsRow label={tr("pet.enabled")} description={tr("pet.enabledBody")} first={true}>
          <If when={companionEnabled() !== null}>
            <ToggleSwitch
              value={companionEnabled() === true}
              accessibilityLabel="pet-enabled"
              disabled={companionBusy() !== null}
              onChange={next => void setCompanionEnabled(next)}
            />
          </If>
        </SettingsRow>
        <SettingsRow
          label={tr("pet.character")}
          description={tr("pet.characterBody")}
          stacked={true}
          headerExtra={<PetImportButton />}
        >
          <PetCharacterGrid />
        </SettingsRow>
        <SettingsRow label={tr("cards.settingsEnabled")} description={tr("cards.settingsEnabledBody")}>
          <If when={desktopCardsEnabled() !== null}>
            <ToggleSwitch
              value={desktopCardsEnabled() === true}
              accessibilityLabel="desktop-cards-enabled"
              disabled={companionBusy() !== null}
              onChange={next => void setDesktopCardsEnabled(next)}
            />
          </If>
        </SettingsRow>
      </View>
    </If>
  );
}

const memoryFields = SETTINGS_SECTIONS.find(section => section.id === "memory")!.fields;
const memoryBasicFields = memoryFields.filter(field => field.kind === "boolean" || field.kind === "select");
const memoryModelFields = memoryFields.filter(field => field.kind === "model");
const memoryAdvancedFields = SETTINGS_SECTIONS.find(section => section.id === "memory-processing")!.fields;

function MemorySettingsSection() {
  const advanced = memoryProcessingOpen;
  const menuOpen = signal(false);
  const confirm = signal<"settings" | "memories" | null>(null);
  let menuAnchor: ViewRef | null = null;
  effect(() => {
    deviceContext();
    untracked(() => { menuOpen.set(false); confirm.set(null); setSectionNotice("memory", ""); });
  });
  const disabled = () => memoryEnabledValue() !== true || memoryActionBusy() !== null;
  const actionsDisabled = () => !memoryConfigLoaded() || memorySettingsBusy();
  const isResetSettings = () => confirm() === "settings";
  const resetLabel = () => tr(isResetSettings() ? "settings.memory.resetSettings" : "settings.memory.reset");
  const advancedLabel = () => tr(advanced() ? "settings.memory.collapseAdvanced" : "settings.memory.expandAdvanced");
  const toggleAdvanced = () => {
    if (advanced() && activeSettingsAnchor() === "memory-processing") activeSettingsAnchor.set(null);
    advanced.set(!advanced());
  };
  async function confirmReset() {
    if (actionsDisabled() || !confirm()) return;
    const settings = isResetSettings();
    confirm.set(null);
    if (!settings) {
      await resetMemory();
      return;
    }
    if (await resetMemorySettings()) [...memoryFields, ...memoryAdvancedFields].forEach(clearDraft);
  }
  return <View style={{ gap: layout.sectionGap }}>
    <SettingsGroup id="memory" title={tr("settings.section.memory")} notice={sectionNotice("memory")}
      onDismissNotice={() => setSectionNotice("memory", "")}>
      <Anchor id="memory-enabled">
        <SettingsRow first label={tr("settings.memory.enabled")} description={tr("settings.memory.enabledDesc")}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            <FieldStatus saving={memoryActionBusy() === "enabled"} saved={fieldJustSaved("memory-enabled")} />
            <ToggleSwitch value={memoryEnabledValue() === true} testID="memory-enabled"
              accessibilityLabel={tr("settings.memory.enabled")}
              disabled={memoryEnabledValue() === undefined || memorySettingsBusy()}
              onChange={value => void setMemoryEnabled(value)} />
          </View>
        </SettingsRow>
      </Anchor>
      <If when={!memoryConfigLoaded()}>
        <SettingsRow label={tr("settings.loading")}><Spinner size={13} color={palette().accent} /></SettingsRow>
      </If>
      <If when={memoryConfigLoaded() && memoryEnabledValue() === undefined}>
        <SettingsRow label={tr("settings.memory.configUnavailable")}>
          <Button size="sm" variant="outline" label={tr("common.retry")} onPress={() => void loadSettingsValues()} />
        </SettingsRow>
      </If>
      <Each of={memoryBasicFields} key={field => field.id}>
        {field => <FieldRow spec={field()} disabled={disabled()} />}
      </Each>
      <SettingsRow label={tr("settings.memory.actions")} description={tr("settings.memory.actionsDesc")}>
        <View ref={node => { menuAnchor = node; }}>
          <Button label={tr("common.manage")} variant="outline" size="sm" trailingIcon="chevron-down"
            accessibilityLabel="memory-manage" loading={memoryActionBusy() !== null && memoryActionBusy() !== "enabled"}
            disabled={actionsDisabled()} onPress={() => menuOpen.set(!menuOpen())} />
        </View>
        <DropdownMenu open={menuOpen()} anchor={menuAnchor} align="end" onClose={() => menuOpen.set(false)} items={[
          { id: "memory-open-folder", label: tr("settings.memory.openFolder"), icon: "folder-open",
            accessibilityLabel: "memory-open-folder", disabled: isRemotePeerContext(),
            hint: isRemotePeerContext() ? tr("settings.memory.folderLocalOnly") : undefined, onSelect: () => void openMemoryFolder() },
          { id: "memory-reset-settings", label: tr("settings.memory.resetSettings"), icon: "undo",
            accessibilityLabel: "memory-reset-settings", onSelect: () => confirm.set("settings") },
          { id: "memory-reset", label: tr("settings.memory.reset"), icon: "trash", danger: true,
            separator: true, accessibilityLabel: "memory-reset", onSelect: () => confirm.set("memories") },
        ]} />
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup id="memory-models" title={tr("settings.memory.models")}>
      <Each of={memoryModelFields} key={field => field.id}>
        {(field, index) => <FieldRow spec={field()} first={index() === 0} disabled={disabled()} />}
      </Each>
    </SettingsGroup>
    <Anchor id="memory-processing">
      <View style={{ minWidth: 0, gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text role="header" style={{ ...textStyle("sectionTitle"), flex: 1, minWidth: 0 }}>
            {tr("settings.memory.advanced")}
          </Text>
          <IconButton size="sm" icon={advanced() ? "chevron-down" : "chevron-right"}
            tooltip={advancedLabel()} accessibilityLabel={advancedLabel()}
            testID="memory-advanced-toggle" expanded={advanced()} onPress={toggleAdvanced} />
        </View>
        <If when={advanced()}>
          <SettingsSection title="" flush notice={sectionNotice("memory-processing")}
            onDismissNotice={() => setSectionNotice("memory-processing", "")}>
            <Each of={memoryAdvancedFields} key={field => field.id}>
              {(field, index) => <FieldRow spec={field()} first={index() === 0} disabled={disabled()} />}
            </Each>
          </SettingsSection>
        </If>
      </View>
    </Anchor>
    <ModalDialog open={confirm() !== null} size="sm" title={resetLabel()}
      subtitle={tr(isResetSettings() ? "settings.memory.resetSettingsConfirm" : "settings.memory.resetConfirm")}
      onClose={() => confirm.set(null)} footer={<>
        <Button label={tr("common.cancel")} variant="ghost" onPress={() => confirm.set(null)} />
        <Button label={resetLabel()} variant={isResetSettings() ? "primary" : "danger"}
          accessibilityLabel={isResetSettings() ? "memory-reset-settings-confirm" : "memory-reset-confirm"}
          disabled={actionsDisabled()} onPress={() => void confirmReset()} />
      </>} />
  </View>;
}

function ExecutionSettingsPage() {
  effect(() => { if (executionModelPoolsSupported()) untracked(ensurePools); });
  const unavailable = (spec: FieldSpec) => spec.kind === "model-target" ? !modelTargetForField(spec)
    : Boolean(spec.capability && !supportsExecutionCapability(spec.capability)) || typeof fieldDisplay(spec) !== "boolean";
  const subagentFieldUnavailable = (spec: FieldSpec) =>
    spec.kind === "model-target" || spec.capability ? unavailable(spec) : false;
  return <If when={settingsValuesCurrent()} else={<Text style={textStyle("caption")}>{tr("settings.loading")}</Text>}>
    <View style={{ gap: layout.sectionGap }}>
      <FieldSection sectionId="ai-execution" />
      <FieldSection sectionId="tool-presentation" />
      <FieldSection sectionId="tool-execution" />
      <FieldSection sectionId="subagent-execution" unavailable={subagentFieldUnavailable}
        extra={<Button size="sm" variant="outline" leadingIcon="settings" label={tr("settings.execution.manageSubagents")}
          accessibilityLabel="execution-manage-subagents" onPress={() => openLibrary("agents")} />} />
      <FieldSection sectionId="tool-json-repair" unavailable={unavailable} />
      <Anchor id="quick-actions"><QuickActionsSection /></Anchor>
      <FieldSection sectionId="agent-hooks" />
    </View>
  </If>;
}

/** States why a section is missing, instead of leaving a page silently empty. */
/** How much an unsupported row fades (visual spec §3 Settings row). */
const UNSUPPORTED_OPACITY = 0.4;

/** The device Settings' Device scope reads (the scope chip's device). */
function scopeDeviceName(): string {
  const id = deviceContext();
  return id ? (fleetDeviceById(id)?.name ?? "") : "";
}

/** "Not available on {device}" for the device the scope chip names. */
function unsupportedOnDevice(): string {
  const name = scopeDeviceName();
  return name ? tr("settings.unsupported", { device: name }) : tr("settings.unsupportedHere");
}

/**
 * A row the device cannot offer: the title at 40 % with the reason under it;
 * an action that still applies (open another page) stays at full strength.
 */
function UnsupportedNote(props: { title: string; message: string; children?: JSX.Element }) {
  return (
    <SettingsGroup id={`unsupported-${props.title}`} title={props.title} hideTitle={true}>
      <View style={{ opacity: UNSUPPORTED_OPACITY }} accessibilityLabel="settings-unsupported-row">
        <SettingsRow label={props.title} description={props.message} first={true} />
      </View>
      <If when={Boolean(props.children)}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            paddingHorizontal: SETTINGS_ROW_INSET,
            paddingBottom: space.md,
          }}
        >
          {props.children}
        </View>
      </If>
    </SettingsGroup>
  );
}

// ── Account › OpenBitFun (the cloud agent's switch, model, usage and data) ──

interface SuperagentStatusView {
  enabled: boolean;
  model?: string;
  usage?: string;
}

const obfStatus = signal<SuperagentStatusView | null>(null);
const obfState = signal<"loading" | "ready" | "unsupported" | "failed">("loading");
const obfNote = signal("");
const obfWriteError = signal("");
const obfBusy = signal(false);
const obfDeleteOpen = signal(false);

/** The cloud agent's device on a fleet connection (the navigator lists it). */
function cloudTarget(): string {
  return fleetDevices().find(device => device.hostKind === "cloud")?.deviceId ?? "cloud";
}

function readSuperagentStatus(raw: unknown): SuperagentStatusView {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value : undefined;
  return {
    enabled: record.enabled === true,
    model: text(record.model) ?? text(record.modelName),
    usage: text(record.usageThisMonth) ?? text(record.usageLabel),
  };
}

async function superagentCall(command: string, request: Record<string, unknown>): Promise<unknown> {
  return invokeCommand<unknown>(command, request, { target: cloudTarget() });
}

function failSuperagent(error: unknown, command: string, writeOnly = false): void {
  if (isCommandUnavailable(error, command)) {
    obfState.set("unsupported");
    obfNote.set("");
    obfWriteError.set("");
    return;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (writeOnly && obfState() === "ready" && obfStatus() !== null) {
    obfWriteError.set(message);
    return;
  }
  obfState.set("failed");
  obfNote.set(message);
}

async function loadSuperagentStatus(): Promise<void> {
  if (obfStatus() === null) obfState.set("loading");
  try {
    obfStatus.set(readSuperagentStatus(await superagentCall("superagent_status", {})));
    obfState.set("ready");
    obfNote.set("");
    obfWriteError.set("");
  } catch (error) {
    failSuperagent(error, "superagent_status");
  }
}

async function setSuperagentEnabled(next: boolean): Promise<void> {
  const command = next ? "superagent_enable" : "superagent_disable";
  obfBusy.set(true);
  obfWriteError.set("");
  try {
    const answer = (await superagentCall(command, {})) as Record<string, unknown> | null;
    const current = obfStatus();
    // The node answers the state it stored; the switch shows that, not the press.
    const enabled = typeof answer?.enabled === "boolean" ? answer.enabled : next;
    if (current) obfStatus.set({ ...current, enabled });
    await loadSuperagentStatus();
  } catch (error) {
    failSuperagent(error, command, true);
  } finally {
    obfBusy.set(false);
  }
}

async function deleteSuperagentData(): Promise<void> {
  obfBusy.set(true);
  obfWriteError.set("");
  try {
    await superagentCall("superagent_delete_data", { cancelJobs: true });
    obfDeleteOpen.set(false);
    await loadSuperagentStatus();
  } catch (error) {
    obfDeleteOpen.set(false);
    failSuperagent(error, "superagent_delete_data", true);
  } finally {
    obfBusy.set(false);
  }
}

// ── Account › Profile: account settings sync (the backend reports the state) ──

/**
 * The one sync state worth a line: one the user can act on or that means sync
 * is not working. Healthy states (synced, syncing, waiting for another device,
 * off by the switch) say nothing; the switch already shows on or off.
 */
function accountSyncProblemText(): string {
  const status = accountSync();
  if (status?.enabled === false) return "";
  switch (status?.phase) {
    case "synced":
    case "syncing":
    case "offline":
    case "off":
      return "";
    case "signed_out":
      return tr("settings.sync.state.signedOut");
    default:
      return tr("settings.sync.state.unavailable");
  }
}

function AccountSyncSection() {
  void loadAccountSync();
  const writeErrorText = (): string => {
    const raw = accountSyncWriteError();
    if (!raw) return "";
    return raw === "save_failed" ? tr("settings.sync.saveFailed") : localizeHostError(raw);
  };
  return (
    <View style={{ gap: space.sm }} accessibilityLabel="settings-account-sync">
      <If when={accountSyncLoad() === "idle" || accountSyncLoad() === "loading"}>
        <View
          accessibilityLabel="account-sync-loading"
          style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs }}
        >
          <Spinner size={12} color={palette().textMuted} />
          <Text style={textStyle("caption")}>{tr("settings.sync.loading")}</Text>
        </View>
      </If>
      <If when={accountSyncLoad() === "unsupported"}>
        <UnsupportedNote title={tr("settings.sync.title")} message={tr("settings.sync.hostUnsupported")} />
      </If>
      <If when={accountSyncLoad() === "failed"}>
        <InlineBanner
          tone="danger"
          accessibilityLabel="account-sync-load-failed"
          message={localizeHostError(accountSyncNote())}
          actionLabel={tr("common.retry")}
          onAction={() => void loadAccountSync()}
        />
      </If>
      <If when={accountSyncLoad() === "ready" && accountSync() !== null}>
        <If when={writeErrorText()}>
          {message => (
            <InlineBanner
              tone="danger"
              accessibilityLabel="account-sync-write-failed"
              message={message()}
              onDismiss={() => clearAccountSyncWriteError()}
            />
          )}
        </If>
        <SettingsGroup id="account-sync" title={tr("settings.sync.title")} hideTitle={true}>
          <SettingsRow label={tr("settings.sync.title")} description={tr("settings.sync.body")} first={true}>
            <ToggleSwitch
              value={accountSync()?.enabled !== false}
              disabled={accountSyncBusy()}
              accessibilityLabel="account-sync-toggle"
              onChange={next => void setAccountSyncEnabled(next)}
            />
          </SettingsRow>
        </SettingsGroup>
        <If when={accountSyncProblemText()}>
          {message => (
            <Text
              accessibilityLabel="account-sync-state"
              style={{ ...textStyle("caption"), paddingHorizontal: space.xs, maxWidth: 600 }}
            >
              {message()}
            </Text>
          )}
        </If>
      </If>
    </View>
  );
}

function OpenBitFunSection() {
  void loadSuperagentStatus();
  return (
    <View style={{ gap: layout.sectionGap }} accessibilityLabel="settings-openbitfun">
      <If when={obfState() === "loading"}>
        <Text style={textStyle("caption", { color: palette().textMuted })}>{tr("settings.loading")}</Text>
      </If>
      <If when={obfState() === "unsupported"}>
        <UnsupportedNote title={tr("obf.toggle")} message={tr("obf.unsupported")} />
      </If>
      <If when={obfState() === "failed"}>
        <InlineBanner
          tone="danger"
          accessibilityLabel="obf-load-failed"
          message={localizeHostError(obfNote())}
          actionLabel={tr("common.retry")}
          onAction={() => void loadSuperagentStatus()}
        />
      </If>
      <If when={obfState() === "ready" && obfStatus() !== null}>
        <View style={{ gap: layout.sectionGap }}>
          <If when={obfWriteError()}>
            {err => (
              <InlineBanner
                tone="danger"
                accessibilityLabel="obf-write-failed"
                message={localizeHostError(err())}
                onDismiss={() => obfWriteError.set("")}
              />
            )}
          </If>
          <SettingsGroup id="openbitfun" title={tr("obf.toggle")} hideTitle={true}>
            <SettingsRow label={tr("obf.toggle")} description={tr("obf.toggleBody")} first={true}>
              <ToggleSwitch
                value={obfStatus()?.enabled === true}
                disabled={obfBusy()}
                accessibilityLabel="obf-toggle"
                onChange={next => void setSuperagentEnabled(next)}
              />
            </SettingsRow>
            <If when={obfStatus()?.model ?? ""}>
              {model => (
                <SettingsRow label={tr("obf.model")}>
                  <RowValue text={model()} />
                </SettingsRow>
              )}
            </If>
            <If when={obfStatus()?.usage ?? ""}>
              {usage => (
                <SettingsRow label={tr("obf.usage")}>
                  <RowValue text={usage()} />
                </SettingsRow>
              )}
            </If>
          </SettingsGroup>
          <SettingsGroup id="openbitfun-data" title={tr("obf.deleteData")} hideTitle={true}>
            <SettingsRow label={tr("obf.deleteData")} description={tr("obf.deleteBody")} first={true}>
              <InlineDeleteConfirm
                confirming={obfDeleteOpen()}
                onConfirmingChange={next => obfDeleteOpen.set(next)}
                label={tr("common.delete")}
                variant="secondary"
                size="sm"
                loading={obfBusy()}
                disabled={obfBusy()}
                accessibilityLabel="obf-delete-data"
                confirmAccessibilityLabel="obf-delete-confirm"
                cancelAccessibilityLabel="obf-delete-cancel"
                onConfirm={() => void deleteSuperagentData()}
              />
            </SettingsRow>
          </SettingsGroup>
        </View>
      </If>
    </View>
  );
}

// ── Account › Activity (the six-month heatmap the host computes) ──

/** Cell and gap of the activity heatmap (visual spec §4.9: 10 px cells, 2 px gap). */
const ACTIVITY_CELL = space.sm + space.hair;
const ACTIVITY_GAP = space.hair;
const ACTIVITY_CELL_RADIUS = radii.xs;
/** Accent opacity per level; a day without tokens is `heatmapZero`. */
const ACTIVITY_STEPS = [0.12, 0.3, 0.5, 0.75, 1] as const;

const activityView = signal<UsageActivityView | null>(null);
const activityState = signal<"loading" | "ready" | "unsupported" | "failed">("loading");
const activityNote = signal("");

async function loadActivity(): Promise<void> {
  if (activityView() === null) activityState.set("loading");
  try {
    activityView.set(await fetchUsageActivity());
    activityState.set("ready");
    activityNote.set("");
  } catch (error) {
    if (error instanceof UsageActivityUnavailable && error.reason === "host_outdated") {
      activityState.set("unsupported");
      activityNote.set("");
    } else {
      activityState.set("failed");
      activityNote.set(error instanceof Error ? error.message : String(error ?? ""));
    }
  }
}

/** The week columns of the host's Monday-first grid, as the host sent them. */
function activityWeeks(): UsageActivityCell[][] {
  const view = activityView();
  if (!view) return [];
  const weeks: UsageActivityCell[][] = [];
  for (let index = 0; index < view.days.length; index += 7) weeks.push(view.days.slice(index, index + 7));
  return weeks;
}

function ActivityCellView(props: { cell: UsageActivityCell }) {
  const empty = () => !props.cell.inRange;
  const zero = () => props.cell.inRange && props.cell.tokens <= 0;
  const stepIndex = () => Math.max(0, Math.min(ACTIVITY_STEPS.length - 1, props.cell.level));
  return (
    <View
      style={{
        width: ACTIVITY_CELL,
        height: ACTIVITY_CELL,
        borderRadius: ACTIVITY_CELL_RADIUS,
        backgroundColor: empty() ? "transparent" : zero() ? palette().heatmapZero : palette().accent,
        opacity: empty() || zero() ? 1 : ACTIVITY_STEPS[stepIndex()],
      }}
    />
  );
}

// ── Account › Activity › Insights (the reports the device's model writes from recent sessions) ──

/** The report's HTML file lives on the device that wrote it; only that device's file manager can show it. */
function insightsOnThisDevice(): boolean {
  if (!fleetActive()) return true;
  const id = deviceContext();
  return !id || fleetDeviceById(id)?.isClientDevice === true;
}

function InsightsStatusLine() {
  return (
    <>
      <If when={insightsGenerating()}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Spinner size={12} color={palette().accent} />
          <Text style={{ ...textStyle("caption", { color: palette().textSecondary }), flex: 1, minWidth: 0 }}>
            {insightsProgress() || tr("settings.insights.generating")}
          </Text>
        </View>
      </If>
      <If when={!insightsGenerating() && insightsNotice() ? insightsNotice() : ""}>
        {notice => <Text style={textStyle("caption", { color: palette().textSecondary })}>{notice()}</Text>}
      </If>
      <If when={insightsError()}>
        {error => (
          <Text accessibilityLabel="activity-insights-error" style={textStyle("caption", { color: stateColor("failed") })}>
            {localizeHostError(error())}
          </Text>
        )}
      </If>
      <If when={!insightsGenerating() && !insightsError() && !insightsNotice() && insightsMetas().length === 0}>
        <Text style={textStyle("caption", { color: palette().textMuted })}>
          {insightsLoading() ? tr("settings.insights.loading") : tr("settings.insights.empty")}
        </Text>
      </If>
    </>
  );
}

function InsightsReportRow(props: { index: number; path: string; title: string; detail: string }) {
  return (
    <View
      role="button"
      accessibilityLabel={`activity-insight-report-${props.index}`}
      onPress={() => void openInsightsReport(props.path, true)}
      style={{
        position: "relative",
        minHeight: SETTINGS_ROW_MIN,
        paddingHorizontal: SETTINGS_ROW_INSET,
        paddingVertical: space.sm,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        cursor: "pointer",
        userSelect: "none",
        backgroundColor: selectedInsightsPath() === props.path ? palette().panelHover : undefined,
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{ backgroundColor: palette().panelHover }}
      activeStyle={tactileActiveStyle(0.985)}
      focusVisibleStyle={focusRingStyle()}
    >
      <RowSeparator edge="top" />
      <View style={{ flex: 1, minWidth: 0, gap: space.hair }}>
        <Text style={{ ...textStyle("body"), numberOfLines: 1, textOverflow: "ellipsis" }}>{props.title}</Text>
        <If when={props.detail}>
          {detail => (
            <Text style={{ ...textStyle("caption", { color: palette().textMuted }), numberOfLines: 1, textOverflow: "ellipsis" }}>
              {detail()}
            </Text>
          )}
        </If>
      </View>
      <Text style={textStyle("label", { color: palette().textSecondary })}>{tr("settings.insights.read")}</Text>
      <Icon name="chevron-right" size={12} color={palette().textMuted} />
    </View>
  );
}

function InsightsSection() {
  return (
    <SettingsSection
      title={tr("settings.insights.title")}
      subtitle={tr("settings.insights.body")}
      flush={true}
      extra={
        <IconButton
          icon="refresh"
          size="xs"
          disabled={insightsLoading()}
          tooltip={tr("settings.insights.reload")}
          accessibilityLabel="activity-reload-insights"
          onPress={() => void loadLatestInsights()}
        />
      }
    >
      <View accessibilityLabel="activity-insights" style={{ minWidth: 0 }}>
        <View
          style={{
            minHeight: SETTINGS_ROW_MIN,
            paddingHorizontal: SETTINGS_ROW_INSET,
            paddingVertical: space.sm,
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: space.sm,
          }}
        >
          <SelectDropdown
            size="sm"
            options={INSIGHTS_DAY_OPTIONS.map(days => ({
              value: String(days),
              label: tr("settings.insights.days", { count: days }),
              accessibilityLabel: `activity-insights-days-${days}`,
            }))}
            value={String(insightsDays())}
            disabled={insightsGenerating()}
            accessibilityLabel="activity-insights-days"
            onChange={value => insightsDays.set(Number(value))}
          />
          <SelectDropdown
            size="sm"
            options={[
              { value: "primary", label: tr("settings.insights.modelPrimary"), accessibilityLabel: "activity-insights-model-primary" },
              { value: "fast", label: tr("settings.insights.modelFast"), accessibilityLabel: "activity-insights-model-fast" },
            ]}
            value={insightsModel()}
            disabled={insightsGenerating()}
            accessibilityLabel="activity-insights-model"
            onChange={value => insightsModel.set(value === "fast" ? "fast" : "primary")}
          />
          <View style={{ flex: 1 }} />
          <If
            when={insightsGenerating()}
            else={
              <Button
                label={tr("settings.insights.generate")}
                variant="secondary"
                size="sm"
                accessibilityLabel="activity-generate-insights"
                onPress={() => void generateInsightsReport()}
              />
            }
          >
            <Button
              label={tr("common.cancel")}
              variant="ghost"
              size="sm"
              accessibilityLabel="activity-cancel-insights"
              onPress={() => void cancelInsights()}
            />
          </If>
        </View>
        <View style={{ paddingHorizontal: SETTINGS_ROW_INSET, paddingBottom: space.md, gap: space.xs }}>
          <InsightsStatusLine />
        </View>
        <Each of={insightsMetas().slice(0, 4)} key={item => item.path}>
          {(item, index) => (
            <InsightsReportRow
              index={index()}
              path={item().path}
              title={item().title}
              detail={[
                item().dateRangeLabel,
                item().totalSessions > 0
                  ? formatPlural(item().totalSessions, "format.sessionOne", "format.sessionOther")
                  : "",
                item().generatedAtText,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          )}
        </Each>
      </View>
    </SettingsSection>
  );
}

/** The report reader: the report's Markdown, generate again, and its HTML file on the device that wrote it. */
function InsightsReader() {
  return (
    <If when={insightsModalOpen() ? activeInsightsReport() : null}>
      {report => (
        <ModalDialog
          open={true}
          size="lg"
          title={report().title}
          subtitle={report().subtitle || undefined}
          accessibilityLabel="insights-reader-modal"
          onClose={closeInsightsModal}
          footer={
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: space.sm, flex: 1 }}>
              <Button
                label={tr("settings.insights.regenerate")}
                variant="secondary"
                size="md"
                disabled={insightsGenerating()}
                accessibilityLabel="insights-regenerate"
                onPress={() => void generateInsightsReport()}
              />
              <If when={report().htmlPath}>
                <Button
                  label={tr("settings.insights.showHtml")}
                  variant="secondary"
                  size="md"
                  disabled={!insightsOnThisDevice()}
                  tooltip={insightsOnThisDevice() ? undefined : tr("settings.insights.htmlElsewhere")}
                  accessibilityLabel="insights-show-html"
                  onPress={() => void revealInsightsHtml(report().htmlPath)}
                />
              </If>
              <Button label={tr("common.close")} variant="primary" size="md" onPress={closeInsightsModal} />
            </View>
          }
        >
          <View style={{ width: "100%", maxWidth: layout.conversationWidth, alignSelf: "center" }}>
            <TextView
              markdown={report().markdown}
              selectable={true}
              links="open"
              options={STATIC_MARKDOWN_OPTIONS}
              codeBlockActions={createMarkdownCodeActions()}
              styles={createMarkdownStyles({ baseFontSize: 14 })}
            />
          </View>
        </ModalDialog>
      )}
    </If>
  );
}

function ActivityPage() {
  void loadActivity();
  void loadLatestInsights();
  return (
    <View style={{ gap: layout.sectionGap }} accessibilityLabel="settings-activity">
      <If when={activityState() === "loading"}>
        <Text style={textStyle("caption", { color: palette().textMuted })}>{tr("settings.loading")}</Text>
      </If>
      <If when={activityState() === "unsupported"}>
        <UnsupportedNote title={tr("settings.page.activity")} message={tr("settings.activity.updateNeeded")} />
      </If>
      <If when={activityState() === "failed"}>
        <InlineBanner
          tone="danger"
          message={localizeHostError(activityNote())}
          actionLabel={tr("common.retry")}
          onAction={() => void loadActivity()}
        />
      </If>
      <If when={activityState() === "ready"}>
        <View style={{ gap: space.lg }}>
          <Text accessibilityLabel="settings-activity-summary" style={textStyle("body", { color: palette().textSecondary })}>
            {tr("settings.activity.summary", {
              tokens: formatTokens(activityView()?.totalTokens ?? 0) || "0",
              days: activityView()?.activeDays ?? 0,
            })}
          </Text>
          <Scroll smoothWheel horizontal={true} style={{ width: "100%", minWidth: 0 }}>
            <View
              accessibilityLabel="settings-activity-heatmap"
              style={{ flexDirection: "row", gap: ACTIVITY_GAP }}
            >
              <Each of={activityWeeks()} key="index">
                {week => (
                  <View style={{ flexDirection: "column", gap: ACTIVITY_GAP }}>
                    <Each of={week()} key="index">
                      {cell => <ActivityCellView cell={cell()} />}
                    </Each>
                  </View>
                )}
              </Each>
            </View>
          </Scroll>
        </View>
      </If>
      <InsightsSection />
      <InsightsReader />
    </View>
  );
}

// ── Device › Archived sessions ──

const archivedRestoring = signal<string | null>(null);
const archivedDeleteAllOpen = signal(false);
const archivedDeletingAll = signal(false);
const archivedSessionsFromHost = signal<SessionSummary[]>([]);
const archivedSessionsLoading = signal(false);
const archivedSessionsError = signal("");
let archivedLoadTicket = 0;

function normalizeArchivedSession(raw: unknown): SessionSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const sessionId = String(record.sessionId ?? record.session_id ?? "").trim();
  if (!sessionId) return null;
  const sessionName = String(record.sessionName ?? record.session_name ?? record.title ?? "");
  const workspaceId =
    typeof record.workspaceId === "string"
      ? record.workspaceId
      : typeof record.workspace_id === "string"
        ? record.workspace_id
        : undefined;
  return {
    sessionId,
    sessionName,
    workspaceId,
    status: "archived",
    persistedStatus: "archived",
    lastUpdated:
      typeof record.lastActiveAt === "number"
        ? record.lastActiveAt
        : typeof record.lastUpdated === "number"
          ? record.lastUpdated
          : undefined,
    messageCount:
      typeof record.turnCount === "number"
        ? record.turnCount
        : typeof record.messageCount === "number"
          ? record.messageCount
          : undefined,
  };
}

function archivedTargetOptions(): { target: string } | undefined {
  const ctx = deviceContext();
  return fleetActive() && ctx ? { target: ctx } : undefined;
}

async function loadArchivedSessions(): Promise<void> {
  const workspace = activeWorkspace();
  if (!workspace) {
    archivedSessionsFromHost.set([]);
    archivedSessionsError.set("");
    return;
  }
  const ticket = ++archivedLoadTicket;
  archivedSessionsLoading.set(true);
  archivedSessionsError.set("");
  try {
    const remote = isRemoteWorkspace(workspace);
    const raw = await invokeCommand<unknown[]>(
      "list_archived_sessions",
      {
        workspace_id: workspace.id,
        workspace_path: workspace.rootPath,
        ...(remote && workspace.connectionId ? { remote_connection_id: workspace.connectionId } : {}),
        ...(remote && workspace.sshHost ? { remote_ssh_host: workspace.sshHost } : {}),
      },
      archivedTargetOptions(),
    );
    if (ticket !== archivedLoadTicket) return;
    const list = (Array.isArray(raw) ? raw : [])
      .map(normalizeArchivedSession)
      .filter((item): item is SessionSummary => item !== null);
    archivedSessionsFromHost.set(list);
  } catch (error) {
    if (ticket !== archivedLoadTicket) return;
    archivedSessionsFromHost.set([]);
    archivedSessionsError.set(localizeHostError(errorMessageOf(error)));
  } finally {
    if (ticket === archivedLoadTicket) {
      archivedSessionsLoading.set(false);
    }
  }
}

async function restoreArchivedSession(row: SessionSummary): Promise<void> {
  const workspace = activeWorkspace();
  if (!workspace || archivedRestoring() === row.sessionId) return;
  archivedRestoring.set(row.sessionId);
  try {
    await invokeCommand<unknown>(
      "unarchive_session",
      {
        sessionId: row.sessionId,
        workspaceId: row.workspaceId || workspace.id,
      },
      archivedTargetOptions(),
    );
    archivedSessionsFromHost.update(list => list.filter(item => item.sessionId !== row.sessionId));
    if (fleetActive()) {
      void refreshFleetNavigator();
    } else {
      await loadSessions();
    }
  } catch (error) {
    pushToast(localizeHostError(errorMessageOf(error)), "error");
  } finally {
    if (archivedRestoring() === row.sessionId) {
      archivedRestoring.set(null);
    }
  }
}

/** `delete_all_archived_sessions` for the open workspace; the catalogue is read again after. */
async function deleteAllArchived(): Promise<void> {
  const workspace = activeWorkspace();
  if (!workspace || archivedDeletingAll()) return;
  archivedDeletingAll.set(true);
  try {
    const remote = isRemoteWorkspace(workspace);
    const deleted = await invokeCommand<number>(
      "delete_all_archived_sessions",
      {
        workspace_id: workspace.id,
        workspace_path: workspace.rootPath,
        ...(remote && workspace.connectionId ? { remote_connection_id: workspace.connectionId } : {}),
        ...(remote && workspace.sshHost ? { remote_ssh_host: workspace.sshHost } : {}),
      },
      archivedTargetOptions(),
    );
    archivedDeleteAllOpen.set(false);
    pushToast(tr("settings.archived.deletedAll", { count: typeof deleted === "number" ? deleted : 0 }), "success");
    archivedSessionsFromHost.set([]);
    await loadArchivedSessions();
    await loadSessions();
  } catch (error) {
    pushToast(localizeHostError(errorMessageOf(error)), "error");
  } finally {
    archivedDeletingAll.set(false);
  }
}

/** These commands operate on the desktop's snapshot store, including its local SSH mirrors. */
function localSnapshotStorageAvailable(): boolean {
  return windowShellId() === "nsh-desktop" && !isRemotePeerContext()
    && (!fleetActive() || !deviceContext() || deviceContext() === entryDeviceId());
}

function SnapshotStorageSection() {
  const period = signal<SnapshotPeriod>("thirtyDays");
  const workspace = signal("");
  const data = signal<SnapshotStorageOverview | null>(null);
  const scanning = signal(false);
  const cleaning = signal(false);
  const confirming = signal(false);
  const error = signal("");
  const outcome = signal<{ message: string; warning: boolean } | null>(null);
  const expanded = signal<string[]>([]);
  let mounted = true;
  cleanup(() => { mounted = false; });

  const busy = () => scanning() || cleaning() || confirming();
  const rows = () => (data()?.workspaces ?? []).filter(row => !workspace() || row.workspaceId === workspace());
  const count = () => rows().reduce((sum, row) => sum + row.candidates.length, 0);
  const excluded = () => rows().reduce((sum, row) => sum + row.skippedSessions, 0);
  const preview = () => tr("storage.preview", {
    sessions: formatCount(count()),
    size: formatBytes(rows().reduce((sum, row) => sum + row.estimatedBytes, 0)),
  });
  const describeError = (cause: unknown, command: string) => isCommandUnavailable(cause, command)
    ? tr("storage.hostUnsupported") : localizeHostError(errorMessageOf(cause));

  async function scan() {
    if (!mounted || scanning() || !localSnapshotStorageAvailable()) return;
    scanning.set(true);
    error.set("");
    try {
      const result = await inspectSnapshotStorage(period());
      if (!mounted) return;
      data.set(result);
      if (!result.workspaces.some(row => row.workspaceId === workspace())) workspace.set("");
    } catch (cause) {
      if (mounted) {
        data.set(null);
        error.set(describeError(cause, "inspect_snapshot_storage"));
      }
    } finally {
      if (mounted) scanning.set(false);
    }
  }
  untracked(() => void scan());

  async function clean() {
    if (!confirming() || cleaning() || scanning() || !localSnapshotStorageAvailable()) return;
    const selected = rows().filter(row => row.candidates.length);
    const reviewedPeriod = period();
    cleaning.set(true);
    confirming.set(false);
    outcome.set(null);
    let removed = 0;
    let skipped = 0;
    let freed = 0;
    const errors: string[] = [];
    for (const row of selected) {
      try {
        const result = await cleanSnapshotStorage(row.workspaceId, reviewedPeriod, row.candidates);
        removed += result.removedSessions;
        skipped += result.skippedSessions;
        freed += result.freedBytes;
        errors.push(...result.errors);
      } catch (cause) {
        skipped += row.candidates.length;
        errors.push(row.name + " · " + describeError(cause, "clean_snapshot_storage"));
      }
    }
    if (!mounted) return;
    const summary = tr("storage.result", { sessions: formatCount(removed), skipped: formatCount(skipped), size: formatBytes(freed) });
    outcome.set({ message: [summary, ...errors].join("\n"), warning: skipped > 0 || errors.length > 0 });
    await scan();
    if (mounted) cleaning.set(false);
  }

  return (
    <View style={{ gap: layout.sectionGap }}>
      <SettingsGroup id="snapshot-usage" title={tr("storage.snapshots")} description={tr("storage.device")}
        extra={<IconButton icon="refresh" size="xs" tooltip={tr("storage.refresh")} disabled={busy()}
          accessibilityLabel="snapshot-storage-refresh" onPress={() => void scan()} />}>
        <If when={scanning()}><SettingsRow first label={tr("storage.scanning")} /></If>
        <If when={error()}>{msg => <InlineBanner tone="danger" message={msg()} />}</If>
        <If when={data()}>{overview => <>
          <SettingsRow first label={tr("storage.total")}>
            <Text style={textStyle("sectionTitle")}>{formatBytes(overview().totalBytes)}</Text>
          </SettingsRow>
          <If when={overview().scanErrors.length > 0}>
            <InlineBanner tone="warning" message={[tr("storage.incomplete"), ...overview().scanErrors].join("\n")} />
          </If>
          <Each of={overview().workspaces} key={row => row.workspaceId}>{row =>
            <SettingsRow label={row().name} description={row().location}>
              <View style={{ alignItems: "flex-end", gap: space.xs }}>
                <Text style={textStyle("label")}>{formatBytes(row().bytes)}</Text>
                <Text style={textStyle("caption")}>{tr("storage.sharedColumn")} · {row().warning ? "—" : formatBytes(row().sharedBytes)}</Text>
              </View>
            </SettingsRow>
          }</Each>
          <If when={overview().unidentifiedBytes > 0}>
            <SettingsRow label={tr("storage.unidentified")} description={tr("storage.unidentifiedHint")}>
              <Text style={textStyle("label")}>{formatBytes(overview().unidentifiedBytes)}</Text>
            </SettingsRow>
          </If>
        </>}</If>
      </SettingsGroup>
      <If when={data()}>{overview =>
        <SettingsGroup id="snapshot-cleanup" title={tr("storage.cleanup")}>
          <SettingsRow first label={tr("storage.scope")}>
            <SelectDropdown value={workspace()} size="sm" disabled={busy()} accessibilityLabel="snapshot-storage-workspace"
              options={[{ value: "", label: tr("storage.allWorkspaces") }, ...overview().workspaces.map(row => ({
                value: row.workspaceId, label: row.name, description: row.location, accessibilityLabel: "snapshot-scope-" + row.workspaceId,
              }))]} onChange={value => { workspace.set(value); outcome.set(null); }} />
          </SettingsRow>
          <SettingsRow label={tr("storage.period")}>
            <SelectDropdown<SnapshotPeriod> value={period()} size="sm" disabled={busy()} accessibilityLabel="snapshot-storage-period"
              options={[
                { value: "thirtyDays", label: tr("storage.thirtyDays") },
                { value: "sevenDays", label: tr("storage.sevenDays") },
                { value: "all", label: tr("storage.all") },
              ]} onChange={value => {
                if (value === period()) return;
                period.set(value);
                outcome.set(null);
                void scan();
              }} />
          </SettingsRow>
          <If when={!scanning()}>
            <Each of={rows()} key={row => row.workspaceId}>{row => <>
              <If when={row().warning || row().unverifiedReferences}>
                <InlineBanner tone="warning" message={row().name + " · " + (row().warning ?? tr("storage.unverified"))} />
              </If>
              <If when={row().candidates.length > 0}>
                <SettingsRow label={row().name} description={row().location}>
                  <Button variant="ghost" size="sm" label={tr("storage.sessionCount", { sessions: formatCount(row().candidates.length) })}
                    trailingIcon={expanded().includes(row().workspaceId) ? "chevron-up" : "chevron-down"}
                    accessibilityLabel={"snapshot-candidates-" + row().workspaceId}
                    onPress={() => expanded.update(ids => ids.includes(row().workspaceId)
                      ? ids.filter(id => id !== row().workspaceId) : [...ids, row().workspaceId])} />
                </SettingsRow>
                <If when={expanded().includes(row().workspaceId)}>
                  <Each of={row().candidates} key={item => item.sessionId}>{item =>
                    <SettingsRow label={item().name || item().sessionId}>
                      <Text style={textStyle("caption")}>{item().removed ? tr("storage.removedSession") :
                        tr("storage.lastActive") + " · " + formatDate(item().activeAt)}</Text>
                    </SettingsRow>
                  }</Each>
                </If>
              </If>
            </>}</Each>
            <SettingsRow label={count() ? preview() : tr("storage.noCandidates")}
              description={tr("storage.skipped", { sessions: formatCount(excluded()) })}>
              <Button label={tr("storage.cleanup")} variant="secondary" size="sm" disabled={busy() || !count()}
                accessibilityLabel="snapshot-storage-clean" onPress={() => confirming.set(true)} />
            </SettingsRow>
          </If>
        </SettingsGroup>
      }</If>
      <If when={outcome()}>{result => <InlineBanner tone={result().warning ? "warning" : "success"} message={result().message} />}</If>
      <ModalDialog open={confirming()} title={tr("storage.confirmTitle")} size="sm"
        subtitle={tr("storage.confirm", { preview: preview() })} onClose={() => confirming.set(false)}
        footer={<View style={{ flex: 1, flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button label={tr("common.cancel")} variant="secondary" onPress={() => confirming.set(false)} />
          <Button label={tr("storage.cleanup")} variant="danger" accessibilityLabel="snapshot-storage-confirm"
            onPress={() => void clean()} />
        </View>} />
    </View>
  );
}

function ArchivedSessionsSection() {
  effect(() => {
    const _device = deviceContext();
    const _wsId = activeWorkspace()?.id ?? "";
    const _wsPath = activeWorkspace()?.rootPath ?? "";
    const _total = sessionTotal();
    void _device;
    void _wsId;
    void _wsPath;
    void _total;
    untracked(() => {
      void loadArchivedSessions();
    });
  });
  const rows = () => archivedSessionsFromHost();
  return (
    <View accessibilityLabel="settings-archived" style={{ gap: space.md }}>
      <If when={archivedSessionsError()}>
        {error => <Text style={textStyle("caption", { color: palette().danger })}>{error()}</Text>}
      </If>
      <If when={rows().length > 1}>
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <InlineDeleteConfirm
            confirming={archivedDeleteAllOpen()}
            onConfirmingChange={next => archivedDeleteAllOpen.set(next)}
            label={tr("settings.archived.deleteAll")}
            variant="ghost"
            size="sm"
            loading={archivedDeletingAll()}
            accessibilityLabel="settings-archived-delete-all"
            confirmAccessibilityLabel="settings-archived-delete-all-confirm"
            onConfirm={() => void deleteAllArchived()}
          />
        </View>
      </If>
      <If
        when={rows().length > 0}
        else={
          <If when={!archivedSessionsLoading()} else={<Spinner size={14} color={palette().accent} />}>
            <Text accessibilityLabel="settings-archived-empty" style={textStyle("body", { color: palette().textMuted })}>
              {tr("settings.archived.empty")}
            </Text>
          </If>
        }
      >
        <SettingsGroup id="archived" title={tr("settings.page.archived")} hideTitle={true}>
          <Each of={rows()} key={row => row.sessionId}>
            {(row, index) => (
              <SettingsRow label={row().sessionName || row().sessionId} first={index() === 0}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <InlineDeleteConfirm
                    label={tr("session.delete")}
                    variant="ghost"
                    size="sm"
                    accessibilityLabel={`settings-archived-delete-${row().sessionId}`}
                    confirmAccessibilityLabel="session-delete-confirm"
                    cancelAccessibilityLabel="session-delete-cancel"
                    onConfirm={() =>
                      void deleteSessionTarget({
                        sessionId: row().sessionId,
                        deviceId: deviceContext(),
                        workspaceId: row().workspaceId || activeWorkspace()?.id || "",
                        title: row().sessionName || row().sessionId,
                        archived: true,
                      }).then(() => void loadArchivedSessions())
                    }
                  />
                  <Button
                    label={tr("settings.archived.restore")}
                    variant="secondary"
                    size="sm"
                    loading={archivedRestoring() === row().sessionId}
                    accessibilityLabel={`settings-archived-restore-${row().sessionId}`}
                    onPress={() => void restoreArchivedSession(row())}
                  />
                </View>
              </SettingsRow>
            )}
          </Each>
        </SettingsGroup>
      </If>
    </View>
  );
}

/** The scope label of one external source (`user_global`, `project`, ...). */
function externalScopeLabel(scope: string): string {
  switch (scope) {
    case "user_global":
      return tr("settings.externalImports.scope.user");
    case "project":
      return tr("settings.externalImports.scope.project");
    case "workspace_local":
      return tr("settings.externalImports.scope.workspace");
    case "remote_user":
    case "remote_project":
      return tr("settings.externalImports.scope.remote");
    default:
      return scope;
  }
}

function externalHealthColor(health: string, lifecycle: string): string {
  if (lifecycle === "removed" || lifecycle === "unavailable" || health === "unavailable") return stateColor("failed");
  if (health === "degraded" || health === "partial" || lifecycle === "degraded") return stateColor("needs_you");
  return palette().textMuted;
}

function externalHealthLabel(health: string, lifecycle: string): string {
  if (lifecycle === "removed") return tr("settings.externalImports.health.removed");
  if (health === "unavailable" || lifecycle === "unavailable") return tr("settings.externalImports.health.unavailable");
  if (health === "degraded" || lifecycle === "degraded") return tr("settings.externalImports.health.degraded");
  if (health === "partial") return tr("settings.externalImports.health.partial");
  return tr("settings.externalImports.health.available");
}

/** The switch that lets the host scan other applications, with its scope. */
function ExternalDiscoveryRow() {
  const discovery = () => externalSnapshot()?.discovery ?? null;
  const description = () => {
    const state = discovery();
    if (!state) return tr("settings.externalImports.discoveryReadOnly");
    const lead = state.enabled
      ? tr("settings.externalImports.discoveryOn")
      : tr("settings.externalImports.discoveryOff");
    const scope = activeWorkspace()
      ? tr("settings.externalImports.workspaceScope")
      : tr("settings.externalImports.userScope");
    return state.canChange ? `${lead} ${scope}` : `${lead} ${tr("settings.externalImports.discoveryReadOnly")}`;
  };
  return (
    <SettingsRow label={tr("settings.externalImports.discovery")} description={description()} first={true}>
      <If when={externalDiscoverySaving()}>
        <Spinner size={13} color={palette().accent} />
      </If>
      <ToggleSwitch
        value={discovery()?.enabled ?? false}
        disabled={!discovery()?.canChange || externalDiscoverySaving() || Boolean(externalSourceControlBusy())}
        accessibilityLabel="external-discovery-toggle"
        onChange={next => void setAutomaticDiscovery(next)}
      />
    </SettingsRow>
  );
}

/** One source another application exposes, with its scope and health. */
function ExternalSourceRowView(props: { row: () => ExternalSourceRow; first: () => boolean }) {
  const control = () => externalSourceControl()?.sources.get(props.row().stableKey);
  const locked = () => externalLoadState() !== "ready" || externalDiscoverySaving() || Boolean(externalSourceControlBusy());
  return (
    <View
      accessibilityLabel={`external-source-${props.row().stableKey}`}
      style={{
        position: "relative",
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: space.md,
        minHeight: SETTINGS_ROW_MIN,
        paddingHorizontal: SETTINGS_ROW_INSET,
        paddingVertical: space.md,
      }}
    >
      <If when={!props.first()}>
        <RowSeparator edge="top" />
      </If>
      <View style={{ flex: 1, minWidth: 0, gap: space.hair }}>
        <Text
          style={{
            ...textStyle("body"),
            fontWeight: "500",
            numberOfLines: 1,
            textOverflow: "ellipsis",
          }}
        >
          {props.row().displayName || props.row().ecosystemId}
        </Text>
        <Text
          style={{
            ...textStyle("caption"),
            numberOfLines: 1,
            textOverflow: "ellipsis-middle",
          }}
        >
          {[externalScopeLabel(props.row().scope), props.row().location].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: space.sm }}>
        <Text style={{
          ...textStyle("caption", { color: externalHealthColor(props.row().health, props.row().lifecycle) }),
          flexShrink: 0,
        }}>
          {control()?.effectiveStatus === "disabled" ? tr("common.disabled") : externalHealthLabel(props.row().health, props.row().lifecycle)}
        </Text>
        <If when={canRevealExternalSource() && props.row().location && Boolean(control())}>
          <Button label={tr("settings.externalImports.sourceControls.reveal")} variant="ghost" size="sm"
            disabled={locked()} accessibilityLabel={`external-source-reveal-${props.row().stableKey}`}
            onPress={() => void revealExternalSource(props.row().stableKey)} />
        </If>
        <If when={externalSourceControl()?.canManageSources && control()?.effectiveStatus !== "removed" ? control() : undefined}>
          {state => <ToggleSwitch value={state().enabled} disabled={locked()}
            accessibilityLabel={`external-source-enabled-${props.row().stableKey}`}
            onChange={enabled => void changeExternalSourceControl({ type: "set_source_enabled", sourceKey: props.row().stableKey, enabled })} />}
        </If>
      </View>
    </View>
  );
}

function ExternalSourceControlNotice() {
  const messages = { changed: "settings.externalImports.sourceControls.changed", saveFailed: "settings.externalImports.sourceControls.saveFailed",
    revealFailed: "settings.externalImports.sourceControls.revealFailed" } as const;
  return <If when={externalSourceControlError()}>{error => <InlineBanner tone={error().key === "changed" ? "warning" : "danger"}
    message={[tr(messages[error().key]),
      error().key === "changed" || !error().detail ? "" : localizeHostError(error().detail)].filter(Boolean).join(" ")}
    onDismiss={() => externalSourceControlError.set(null)} />}</If>;
}

/** The sources and what they expose, or why the host could not be read. */
function ExternalSourcesGroup(props: { ecosystemId: string; onSelect: (id: string) => void; onRefresh: () => void }) {
  const snapshot = () => externalSnapshot();
  const summary = () => {
    const counts = snapshot()?.counts;
    if (!counts) return "";
    return tr("settings.externalImports.summary", {
      commands: formatCount(counts.commands),
      tools: formatCount(counts.tools),
      subagents: formatCount(counts.subagents),
      mcp: formatCount(counts.mcpServers),
    });
  };
  const emptyText = () => {
    const state = snapshot();
    if (state?.discoveryPending) return tr("settings.externalImports.scanning");
    if (state?.discovery && !state.discovery.hasScanned) {
      return state.discovery.enabled
        ? tr("settings.externalImports.scanning")
        : tr("settings.externalImports.notScanned");
    }
    return tr("settings.externalImports.notDetected");
  };
  return (
    <SettingsGroup
      id="external-import-sources"
      title={tr("settings.externalImports.applications")}
      description={summary()}
      extra={
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <If when={externalLoadState() === "loading"}>
            <Spinner size={13} color={palette().accent} />
          </If>
          <If when={!props.ecosystemId}><Button
            label={tr("settings.externalImports.refresh")}
            variant="ghost"
            size="sm"
            leadingIcon="refresh"
            disabled={externalLoadState() === "loading" || snapshot()?.canRefresh === false || mcpImportBusy() !== null}
            accessibilityLabel="external-import-refresh"
            onPress={props.onRefresh}
          /></If>
        </View>
      }
    >
      <ExternalDiscoveryRow />
      <If when={externalSourceControl()}>{control => (
        <SettingsRow label={tr("settings.externalImports.sourceControls.safeMode")}
          description={tr(control().safeMode ? "settings.externalImports.sourceControls.safeModeOn" : "settings.externalImports.sourceControls.safeModeOff")}>
          <ToggleSwitch value={control().safeMode} accessibilityLabel="external-source-safe-mode"
            disabled={!control().canSetSafeMode || externalLoadState() !== "ready" || externalDiscoverySaving() || Boolean(externalSourceControlBusy())}
            onChange={enabled => void changeExternalSourceControl({ type: "set_safe_mode", enabled })} />
        </SettingsRow>
      )}</If>
      <ExternalSourceControlNotice />
      <If when={externalDiscoveryError()}>
        {err => (
          <View style={{ paddingHorizontal: SETTINGS_ROW_INSET, paddingBottom: space.md }}>
            <InlineBanner
              tone="danger"
              accessibilityLabel="external-discovery-error"
              message={`${tr("settings.externalImports.discoverySaveFailed")} ${localizeHostError(err())}`}
            />
          </View>
        )}
      </If>
      <If
        when={(snapshot()?.ecosystems.length ?? 0) > 0}
        else={
          <SettingsRow
            label={tr("settings.externalImports.sourcesTitle")}
            description={externalLoadState() === "loading" ? tr("common.loading") : emptyText()}
          />
        }
      >
        <Scroll horizontal smoothWheel scrollbar={false} style={{ minWidth: 0, maxWidth: "100%" }}
          contentStyle={{ paddingHorizontal: space.xs, paddingVertical: space.sm }}>
          <TabGroup accessibilityLabel={tr("settings.externalImports.applications")} size="sm"
            items={(snapshot()?.ecosystems ?? []).map(app => ({
              value: app.id, label: app.displayName, testID: `external-app-${app.id}`, icon: <ProductBrandIcon productId={app.id} />,
            }))} value={props.ecosystemId} onChange={props.onSelect} />
        </Scroll>
      </If>
    </SettingsGroup>
  );
}

function ExternalApplicationSources(props: { ecosystemId: string }) {
  const sources = computed(() => {
    const rows = new Map<string, ExternalSourceRow>();
    for (const row of [...(externalSnapshot()?.sources ?? []), ...(externalSourceControl()?.catalogSources ?? [])]) {
      if (row.stableKey && row.ecosystemId === props.ecosystemId) rows.set(row.stableKey, row);
    }
    return [...rows.values()];
  });
  const detected = () => externalSnapshot()?.discoveryPending ? tr("settings.externalImports.scanning")
    : externalSnapshot()?.discovery?.hasScanned === false ? tr("settings.externalImports.notScanned")
    : tr("settings.externalImports.notDetected");
  return (
    <SettingsGroup id="external-import-application" title={tr("settings.externalImports.sourceLocations")} extra={
      <Button label={tr("settings.externalImports.openAgents")} variant="secondary" size="sm"
        accessibilityLabel="external-import-open-agents" onPress={() => requestSettingsPage("external-agents")} />
    }>
      <If when={sources().length > 0} else={<SettingsRow label={detected()} first />}>
        <Each of={sources()} key={row => row.stableKey}>
          {(row, index) => <ExternalSourceRowView row={row} first={() => index() === 0} />}
        </Each>
      </If>
    </SettingsGroup>
  );
}

function ExternalApplicationCommands(props: { ecosystemId: string }) {
  const commands = computed(() => externalSnapshot()?.items.filter(item =>
    item.kind === "command" && item.ecosystemIds.includes(props.ecosystemId)) ?? []);
  return <If when={commands().length > 0}>
    <SettingsGroup id="external-import-command" title={tr("settings.externalImports.catalog.commands")}>
      <Each of={commands()} key={item => item.id}>
        {(item, index) => <SettingsRow label={item().name} first={index() === 0}
          description={[item().description, ...item().sources.filter(row => row.ecosystemId === props.ecosystemId)
            .map(row => row.location || row.displayName)].filter(Boolean).join(" · ")} />}
      </Each>
    </SettingsGroup>
  </If>;
}

function ExternalApplicationSessions(props: { ecosystemId: string; name: string }) {
  const available = () => canSetSessionDiscovery(props.ecosystemId);
  const description = () => {
    if (sessionDiscoveryLoad() === "loading" || removedSessionsState() === "loading") return tr("common.loading");
    return available() ? tr("settings.externalImports.sessionDiscoveryDescription", { name: props.name })
      : tr("settings.externalImports.sessionDiscoveryUnavailable");
  };
  return <SettingsGroup id="external-import-sessions" title={tr("settings.externalImports.sessionsTitle")}>
    <SettingsRow label={tr("settings.externalImports.sessionDiscovery", { name: props.name })} description={description()} first>
      <ToggleSwitch value={sessionDiscoveryConfig()?.[props.ecosystemId] === true}
        disabled={!available() || Boolean(sessionDiscoveryBusy())}
        accessibilityLabel={`external-session-discovery-${props.ecosystemId}`}
        onChange={next => void setSessionDiscovery(props.ecosystemId, next)} />
    </SettingsRow>
    <If when={sessionDiscoveryError()}>
      {error => <InlineBanner tone="danger" message={localizeHostError(error())} />}
    </If>
  </SettingsGroup>;
}

/** Source sessions the user removed from the list, which can be added again. */
function RemovedExternalSessionsGroup(props: { ecosystemId?: string }) {
  const rows = () => removedSessions().filter(row => !props.ecosystemId || row.ecosystemId === props.ecosystemId);
  const stateText = () => {
    switch (removedSessionsState()) {
      case "idle":
      case "loading":
        return tr("common.loading");
      case "unsupportedHost":
        return tr("settings.externalImports.removedUnsupportedHost");
      case "error":
        return tr("settings.externalImports.removedLoadFailed");
      default:
        return tr("settings.externalImports.removedEmpty");
    }
  };
  return (
    <SettingsGroup
      id="external-import-removed"
      title={tr("settings.externalImports.removedTitle")}
      description={tr("settings.externalImports.removedDescription")}
      extra={
        <If when={removedSessionsState() === "error"}>
          <Button
            label={tr("common.retry")}
            variant="ghost"
            size="sm"
            accessibilityLabel="external-removed-retry"
            onPress={() => void loadRemovedSessions()}
          />
        </If>
      }
    >
      <If
        when={removedSessionsState() === "ready" && rows().length > 0}
        else={<SettingsRow label={tr("settings.externalImports.removedTitle")} description={stateText()} first={true} />}
      >
        <Each of={rows()} key={row => removedSessionKey(row)}>
          {(row, index) => (
            <View
              accessibilityLabel={`external-removed-${row().sessionId}`}
              style={{
                position: "relative",
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                minHeight: SETTINGS_ROW_MIN,
                paddingHorizontal: SETTINGS_ROW_INSET,
                paddingVertical: space.md,
              }}
            >
              <If when={index() !== 0}>
                <RowSeparator edge="top" />
              </If>
              <View style={{ flex: 1, minWidth: 0, gap: space.hair }}>
                <Text
                  style={{
                    ...textStyle("body"),
                    fontWeight: "500",
                    numberOfLines: 1,
                    textOverflow: "ellipsis",
                  }}
                >
                  {row().sessionName}
                </Text>
                <Text
                  style={{
                    ...textStyle("caption", {
                      color:
                        removedRestoreFailed() === removedSessionKey(row())
                          ? stateColor("failed")
                          : palette().textMuted,
                    }),
                    numberOfLines: 2,
                  }}
                >
                  {removedRestoreFailed() === removedSessionKey(row())
                    ? tr("settings.externalImports.restoreFailed")
                    : [EXTERNAL_SESSION_NAMES[row().ecosystemId] ?? row().ecosystemId, row().workspaceName]
                        .filter(Boolean)
                        .join(" · ")}
                </Text>
              </View>
              <Button
                label={tr("settings.externalImports.restore")}
                variant="secondary"
                size="sm"
                loading={removedRestoreBusy() === removedSessionKey(row())}
                disabled={Boolean(removedRestoreBusy())}
                accessibilityLabel={`external-removed-restore-${row().sessionId}`}
                onPress={() => void restoreRemovedSession(row())}
              />
            </View>
          )}
        </Each>
      </If>
    </SettingsGroup>
  );
}

/**
 * External import: the sources other AI applications expose on the host, the
 * host's automatic discovery, MCP servers that can be copied into OpenBitFun and
 * removed source sessions. The page reads the host this surface drives; a remote
 * workspace and an older host each get their own sentence instead of an empty
 * page, and the External agents page stays one press away.
 */
function ExternalImportSection() {
  const selectedAppId = signal("");
  const assetsRefreshVersion = signal(0);
  const appBatchBusy = signal(false);
  const hookBatchState = signal<ExternalAppHookBatchState | null>(null);
  const refresh = () => {
    assetsRefreshVersion.update(version => version + 1);
    void loadExternalImport(true);
  };
  effect(() => {
    void deviceContext();
    void activeWorkspace()?.id;
    untracked(() => { selectedAppId.set(""); syncExternalImportScope(); });
  });
  effect(() => {
    if (!externalSourceControl()?.discoveryPending || externalLoadState() !== "ready"
      || externalSourceControlBusy() || externalDiscoverySaving()) return;
    const timer = setTimeout(() => void readExternalSourceControl(), 1000);
    cleanup(() => clearTimeout(timer));
  });
  const app = computed(() => {
    const choices = externalSnapshot()?.ecosystems ?? [];
    return choices.find(choice => choice.id === selectedAppId()) ?? choices[0] ?? null;
  });
  const mcpOwners = computed(() => new Map((externalSnapshot()?.items ?? [])
    .filter(item => item.kind === "mcp" && item.ecosystemIds.length > 0).map(item => [item.id, item.ecosystemIds])));
  const appMcpIds = () => [...mcpOwners()].filter(([, ids]) => ids.includes(app()?.id ?? "")).map(([id]) => id);
  const unassignedMcpIds = () => mcpImportPlan()?.items.filter(item => !mcpOwners().has(item.candidateId))
    .map(item => item.candidateId) ?? [];
  const notice = () => {
    const value = externalMcpNotice();
    if (!value) return "";
    return value.name !== undefined ? tr(value.key, { name: value.name }) : tr(value.key);
  };
  const manageMcp = () => requestSettingsPage("mcp");
  const openAgents = () => (
    <Button
      label={tr("settings.externalImports.openAgents")}
      variant="secondary"
      size="sm"
      accessibilityLabel="external-import-open-agents"
      onPress={() => requestSettingsPage("external-agents")}
    />
  );
  return (
    <View style={{ gap: layout.sectionGap }}>
      <If when={externalBlock() === "remoteWorkspace"}>
        <UnsupportedNote
          title={tr("settings.externalImports.title")}
          message={tr("settings.externalImports.remoteWorkspace")}
        >
          {openAgents()}
        </UnsupportedNote>
      </If>
      <If when={externalBlock() === "incompatible"}>
        <UnsupportedNote
          title={tr("settings.externalImports.title")}
          message={unsupportedOnDevice()}
        >
          {openAgents()}
        </UnsupportedNote>
      </If>
      <If when={externalLoadState() === "error"}>
        <InlineBanner
          tone="danger"
          accessibilityLabel="external-import-error"
          message={`${tr("settings.externalImports.loadFailed")} ${localizeHostError(externalError())}`}
          actionLabel={tr("common.retry")}
          onAction={() => void loadExternalImport(false)}
        />
      </If>
      <If when={externalBlock() === "" && externalLoadState() !== "error"}>
        <ExternalSourcesGroup ecosystemId={app()?.id ?? ""} onSelect={id => {
          if (appBatchBusy()) return;
          externalMcpNotice.set(null);
          selectedAppId.set(id);
        }} onRefresh={refresh} />
        <If when={app()}>{selected => <ExternalAppBatchHeader appId={selected().id} name={selected().displayName}
          mcpIds={appMcpIds()} hooks={hookBatchState()} onBusyChange={appBatchBusy.set} onRefresh={refresh} />}</If>
        <ExternalRuntimePolicySection ecosystemId={app()?.id ?? ""} />
        <If when={app()}>
          {selected => <>
            <ExternalApplicationSources ecosystemId={selected().id} />
            <If when={selected().id === "codex" || selected().id === "opencode" ? selected().id as "codex" | "opencode" : undefined}>
              {provider => <ExternalAppAccount provider={provider()} refreshVersion={assetsRefreshVersion()}
                onManage={() => requestSettingsPage("models", "subscriptions")} />}
            </If>
            <If when={Object.hasOwn(EXTERNAL_SESSION_NAMES, selected().id)}>
              <ExternalApplicationSessions ecosystemId={selected().id} name={selected().displayName} />
            </If>
            <ExternalApplicationCommands ecosystemId={selected().id} />
            <ExternalRuntimeReviewSections ecosystemId={selected().id} />
            <ExternalRuntimeInventory ecosystemId={selected().id} />
            <ExternalAppInstructions ecosystemId={selected().id} refreshVersion={assetsRefreshVersion()} />
            <ExternalAppSkills ecosystemId={selected().id} refreshVersion={assetsRefreshVersion()} />
            <ExternalAppHooks ecosystemId={selected().id} refreshVersion={assetsRefreshVersion()}
              automaticDiscovery={externalSnapshot()?.discovery?.enabled !== false}
              externalBatchBusy={appBatchBusy()} onBatchStateChange={hookBatchState.set} />
            <If when={selected().id === "codex"}>
              <ExternalAppPets refreshVersion={assetsRefreshVersion()} onManage={() => requestSettingsPage("pet")} />
            </If>
          </>}
        </If>
        <If when={notice()}>
          {message => <InlineBanner tone={externalMcpNotice()?.tone ?? "info"}
            accessibilityLabel="external-mcp-notice" message={message()} onDismiss={() => externalMcpNotice.set(null)} />}
        </If>
        <If when={mcpOwners().size > 0} else={<ExternalMcpImportGroup ownerId="" externalBatchBusy={appBatchBusy()} onManage={manageMcp} />}>
          <ExternalMcpImportGroup ownerId={app()?.id ?? ""} candidateIds={appMcpIds()} externalBatchBusy={appBatchBusy()} onManage={manageMcp} />
          <If when={unassignedMcpIds().length > 0}>
            <ExternalMcpImportGroup ownerId={app()?.id ?? ""} candidateIds={unassignedMcpIds()} unassigned externalBatchBusy={appBatchBusy()} onManage={manageMcp} />
          </If>
        </If>
      </If>
      <RemovedExternalSessionsGroup ecosystemId={app()?.id} />
    </View>
  );
}

/** Wraps a section drawn by its own component so the navigation can reveal it. */
function Anchor(props: { id: string; children?: JSX.Element }) {
  return <View ref={el => registerSectionAnchor(props.id, el)}>{props.children}</View>;
}

function ModelsPage() {
  useDeviceScopedLoad("models-subscriptions-preload", () => void loadSubscriptions(), () => void loadSubscriptions(true));
  useDeviceScopedLoad("models-pools-preload", ensurePools, ensurePools);

  let tabMounts = 0;
  const activeTab = (): ModelsPageTab => {
    const current = modelsPageTab();
    if (current === "pools" && poolsSupported() === false) return "models";
    return current;
  };

  const tabOptions = () => {
    const connectedSubs = subscriptionAccounts().filter(item => item.connected).length;
    const totalSubs = subscriptionAccounts().length;
    const subBadge =
      totalSubs > 0 ? (connectedSubs > 0 ? `${connectedSubs}/${totalSubs}` : totalSubs) : undefined;
    const showIcons = !settingsCompact();
    const options: Array<{
      value: ModelsPageTab;
      label: string;
      icon?: IconName;
      badge?: string | number;
      accessibilityLabel: string;
    }> = [
      {
        value: "models",
        label: tr("settings.models.tabModels"),
        icon: showIcons ? "cpu" : undefined,
        badge: storedModels().length > 0 ? storedModels().length : undefined,
        accessibilityLabel: "models-tab-models",
      },
      {
        value: "subscriptions",
        label: tr("settings.subscriptions.tabLabel"),
        icon: showIcons ? "key" : undefined,
        badge: subBadge,
        accessibilityLabel: "models-tab-subscriptions",
      },
    ];
    if (poolsSupported() !== false) {
      options.push({
        value: "pools",
        label: tr("settings.pools.title"),
        icon: showIcons ? "layers" : undefined,
        badge: pools().length > 0 ? pools().length : undefined,
        accessibilityLabel: "models-tab-pools",
      });
    }
    options.push({
      value: "network",
      label: tr("settings.models.tabNetwork"),
      icon: showIcons ? "globe" : undefined,
      accessibilityLabel: "models-tab-network",
    });
    return options;
  };

  // Below this width the four tabs no longer fit with their labels: scroll them instead of truncating.
  const scrollTabs = (): boolean =>
    settingsCompact() || (settingsSceneWidth() > 0 && settingsSceneWidth() < 1040);
  const tabBar = () => (
    <SegmentedTabs
      size={settingsCompact() ? "sm" : "md"}
      value={activeTab()}
      scrollable={scrollTabs()}
      options={tabOptions()}
      onChange={tab => requestSettingsTransition({ kind: "models-tab", tab })}
    />
  );

  return (
    <View style={{ gap: layout.sectionGap, minWidth: 0 }}>
      <If when={scrollTabs()} else={tabBar()}>
        <Scroll
          smoothWheel
          horizontal={true}
          scrollbar={false}
          accessibilityLabel="models-tabs-scroll"
          style={{ width: "100%", minWidth: 0, flexShrink: 0, overflow: "hidden" }}
          contentStyle={{ flexDirection: "row" }}
        >
          {tabBar()}
        </Scroll>
      </If>

      <Each of={[activeTab()]} key={tab => tab}>
        {tab => {
          const shouldAnimate = tabMounts > 0;
          tabMounts += 1;
          const motion = shouldAnimate ? subtleCrossfadeMotion() : null;
          return (
            <View style={[{ gap: layout.sectionGap }, motion?.style]}>
              <If when={tab() === "models"}>
                <DefaultModelsSection />
                <Anchor id="models">
                  <ModelSection />
                </Anchor>
              </If>
              <If when={tab() === "subscriptions"}>
                <Anchor id="subscriptions">
                  <SubscriptionsSection />
                </Anchor>
              </If>
              <If when={tab() === "pools"}>
                <Anchor id="pools">
                  <PoolsSection />
                </Anchor>
              </If>
              <If when={tab() === "network"}>
                <FieldSection sectionId="network" />
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

/** The sections of one page, in the desktop's order. */
function SettingsPageBody(props: { pageId: SettingsPageId }) {
  const page = props.pageId;
  if (page === "general") {
    return (
      <View style={{ gap: layout.sectionGap }}>
        <SettingsGroup id="general-language" title={tr("settings.section.language")}>
          <LanguageRow />
        </SettingsGroup>
        <FieldSection sectionId="general" leading={<LaunchAtLoginRow />} />
      </View>
    );
  }
  if (page === "appearance") return <AppearanceSection />;
  if (page === "input") {
    return (
      <View style={{ gap: layout.sectionGap }}>
        <FieldSection sectionId="input" />
        <Anchor id="send-policy">
          <SendPolicySection />
        </Anchor>
        <Anchor id="btw-close-confirmation">
          <BtwCloseSettingsSection />
        </Anchor>
      </View>
    );
  }
  if (page === "shortcuts") return <ShortcutsSection />; // wave22-p5
  if (page === "pet") {
    return (
      <SettingsGroup
        id="pet"
        title={tr("settings.page.pet")}
        hideTitle={true}
      >
        <DesktopCompanionRow />
      </SettingsGroup>
    );
  }
  if (page === "profile") {
    return (
      <View style={{ gap: layout.sectionGap }}>
        <SettingsGroup id="profile" title={tr("settings.page.profile")} hideTitle={true}>
          <AccountRow />
        </SettingsGroup>
        <AccountSyncSection />
      </View>
    );
  }
  if (page === "devices") return <AccountDevicesPage />;
  if (page === "openbitfun") return <OpenBitFunSection />;
  if (page === "activity") return <ActivityPage />;
  if (page === "storage") return (
    <If when={localSnapshotStorageAvailable()} else={
      <UnsupportedNote title={tr("settings.page.storage")} message={tr("storage.desktopOnly")} />
    }>
      <SnapshotStorageSection />
    </If>
  );
  if (page === "archived") return <ArchivedSessionsSection />;
  if (page === "models") return <ModelsPage />;
  if (page === "session-memory") {
    return (
      <View style={{ gap: layout.sectionGap }}>
        <FieldSection sectionId="session" />
        <Anchor id="task-models">
          <TaskModelsSection />
        </Anchor>
        <MemorySettingsSection />
      </View>
    );
  }
  if (page === "execution") return <ExecutionSettingsPage />;
  if (page === "permissions") {
    return (
      <View style={{ gap: layout.sectionGap }}>
        <PermissionsSection />
        <If when={permissionsSupported() === false}>
          <UnsupportedNote title={tr("settings.page.permissions")} message={unsupportedOnDevice()} />
        </If>
        <FieldSection sectionId="superagent-device" />
      </View>
    );
  }
  if (page === "editor") return (
    <View style={{ gap: layout.sectionGap }}>
      <FieldSection sectionId="editor" />
      <FieldSection sectionId="editor-behavior" />
      <FieldSection sectionId="editor-display">
        <SettingsRow label={tr("settings.field.editorMinimap")} description={tr("settings.editor.nativeUnavailable")}>
          <Text style={{ ...textStyle("label"), color: palette().textMuted }}>{tr("common.unavailable")}</Text>
        </SettingsRow>
      </FieldSection>
    </View>
  );
  if (page === "terminal") return <FieldSection sectionId="terminal" leading={<DefaultShellRow />} />;
  if (page === "workspace") {
    return (
      <View style={{ gap: layout.sectionGap }}>
        <FieldSection sectionId="workspace" />
        <FieldSection sectionId="workspace-search" />
        <FieldSection sectionId="git" />
      </View>
    );
  }
  if (page === "external-import") return <ExternalImportSection />;
  if (page === "web-search") return <WebSearchSection />;
  if (page === "desktop-control") {
    // wave22-p5: the device's own desktop-control permissions under its switches.
    return (
      <View style={{ gap: layout.sectionGap }}>
        <FieldSection sectionId="tools" />
        <ComputerUseSection />
        {/* wave22-p2: the user's own Chrome or Edge. */}
        <ExternalBrowserSection />
        <If when={windowShellId() === "nsh-desktop" && !isRemotePeerContext()}>
          <ExternalControlSection />
        </If>
      </View>
    );
  }
  if (page === "mcp") {
    return (
      <View style={{ gap: layout.sectionGap }}>
        <Anchor id="mcp">
          <McpSection />
        </Anchor>
        <Anchor id="acp">
          <View style={{ gap: layout.sectionGap }}>
            <AcpSection />
            <If when={acpSupported() === false}>
              <UnsupportedNote title={tr("settings.page.externalAgents")} message={unsupportedOnDevice()} />
            </If>
          </View>
        </Anchor>
      </View>
    );
  }
  if (page === "usage") return <UsageSection />;
  return (
    <View style={{ gap: layout.sectionGap }}>
      <FieldSection sectionId="diagnostics" />
      <LogFilesSection />
      <ConfigTransferSection />
    </View>
  );
}

/** Save / Discard / Keep editing, shared by Settings text fields and the MCP JSON editor. */
function UnsavedChangesDialog() {
  const saving = signal(false);
  const fields = () => {
    const target = pendingNavigation();
    return target ? transitionFields(target) : [];
  };
  const canSave = () => !saving() && (!mcpJsonDirty() || canSaveMcpJson()) && (!mcpDraftDirty() || canSaveMcpDraft())
    && (!mcpImportDirty() || canImportMcpServers()) && (!poolDraftDirty() || canSavePoolDraft());
  const keepEditing = () => { if (!saving()) pendingNavigation.set(null); };
  const saveAll = async (): Promise<void> => {
    const target = pendingNavigation();
    if (!target || !canSave()) return;
    saving.set(true);
    try {
      let ok = true;
      for (const spec of fields()) {
        if (!(await commitDraft(spec))) ok = false;
      }
      if (ok && mcpJsonDirty()) ok = await commitMcpJson();
      if (ok && mcpDraftDirty()) ok = await commitMcpDraft();
      if (ok && mcpImportDirty()) ok = await commitMcpImport();
      if (ok && poolDraftDirty()) ok = await savePoolDraft();
      if (pendingNavigation() === target) {
        if (ok) applyPendingNavigation(target);
        else pendingNavigation.set(null);
      }
    } finally {
      saving.set(false);
    }
  };
  return (
    <ModalDialog
      open={pendingNavigation() !== null}
      title={tr("settings.unsaved.title")}
      subtitle={tr("settings.unsaved.subtitle")}
      size="sm"
      accessibilityLabel="settings-unsaved-dialog"
      onClose={keepEditing}
      closeOnEscape={!saving()}
      closeOnBackdropPress={!saving()}
      footer={
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: space.sm, flex: 1 }}>
          <Button
            label={tr("settings.unsaved.keepEditing")}
            variant="ghost"
            size="md"
            accessibilityLabel="settings-unsaved-keep"
            disabled={saving()}
            onPress={keepEditing}
          />
          <Button
            label={tr("settings.unsaved.discard")}
            variant="secondary"
            size="md"
            accessibilityLabel="settings-unsaved-discard"
            disabled={saving()}
            onPress={() => {
              const target = pendingNavigation();
              if (!target || saving()) return;
              for (const spec of fields()) clearDraft(spec);
              applyPendingNavigation(target);
            }}
          />
          <Button
            label={tr("common.save")}
            variant="primary"
            size="md"
            loading={saving()}
            disabled={!canSave()}
            accessibilityLabel="settings-unsaved-save"
            onPress={() => void saveAll()}
          />
        </View>
      }
    >
      <View style={{ gap: space.sm }}>
        <Each of={fields()} key={spec => spec.id}>
          {spec => (
            <Text style={textStyle("caption")}>
              {`${fieldLabel(spec())}: ${spec().masked ? tr("settings.account.maskedValue") : draftOf(spec())}`}
            </Text>
          )}
        </Each>
        <If when={mcpJsonDirty()}>
          <Text style={textStyle("caption")}>{tr("settings.mcp.jsonEditorTitle")}</Text>
        </If>
        <If when={mcpDraftDirty()}>
          <Text style={textStyle("caption")}>{mcpDraft()?.originalId
            ? tr("settings.mcp.editServerTitle", { id: mcpDraft()!.originalId! }) : tr("settings.mcp.newServerTitle")}</Text>
        </If>
        <If when={mcpImportDirty()}>
          <Text style={textStyle("caption")}>{tr("settings.mcp.importTitle")}</Text>
        </If>
        <If when={poolDraftDirty()}>
          <Text style={textStyle("caption")}>{tr("settings.pools.title")}</Text>
        </If>
      </View>
    </ModalDialog>
  );
}

const settingsPageOffsets = new Map<SettingsPageId, number>();
let settingsScrollDevice: string | null = null;
let lastSettingsLocale: AppLocale | null = null;

function SettingsPageViewport(props: { pageId: SettingsPageId; deviceId: string }) {
  // The parent keys this viewport by page and device. Save offsets only in the
  // active device context, and let an explicit section request win over an offset.
  const { pageId, deviceId } = props;
  const captionInset = SceneCaptionInset();
  if (settingsScrollDevice !== deviceId) {
    settingsScrollDevice = deviceId;
    settingsPageOffsets.clear();
  }
  const saved = activeSettingsAnchor() ? 0 : settingsPageOffsets.get(pageId) ?? 0;
  let restoring = saved > 0;
  let viewport: ScrollRef | null = null;
  let viewportHeight = 0;
  let contentHeight = 0;
  const formViewportWidth = signal(0);
  const compactForm = () => formViewportWidth() > 0
    ? formViewportWidth() <= SETTINGS_FORM_STACK_WIDTH
    : settingsCompact();
  let lastRestoration = 0;
  const page = () => settingsPageEntry(pageId);
  const stopRestoring = () => { restoring = false; };
  const restore = () => {
    if (activeSettingsAnchor()) stopRestoring();
    if (!restoring || !settingsLoaded() || !viewport || viewportHeight <= 0) return;
    const y = Math.min(saved, Math.max(0, contentHeight - viewportHeight));
    if (y <= 0 || y === lastRestoration) return;
    lastRestoration = y;
    viewport.scrollTo({ y, animated: false });
  };
  return (
    <Scroll smoothWheel ref={node => { viewport = node; }} testID="settings-page-scroll"
      style={{ flex: 1, minHeight: 0 }} contentStyle={{ alignItems: "center" }}
      onLayout={event => {
        viewportHeight = event.bounds.size.height;
        formViewportWidth.set(event.bounds.size.width);
        queueMicrotask(restore);
      }}
      onWheel={stopRestoring} onTouchStart={stopRestoring} onKeyDown={stopRestoring}
      onScrollDragStart={stopRestoring}
      onScroll={event => {
        if (activeSettingsAnchor() || Math.abs(event.offset.y - saved) < 1) stopRestoring();
        if (!restoring && settingsLoaded() && settingsScrollDevice === deviceId) {
          settingsPageOffsets.set(pageId, Math.max(0, event.offset.y));
        }
      }}>
      <View onLayout={event => { contentHeight = event.bounds.size.height; queueMicrotask(restore); }} style={{
        width: "100%", maxWidth: SETTINGS_CONTENT_MAX + settingsGutter() * 2, minWidth: 0,
        paddingHorizontal: settingsGutter(),
        paddingTop: captionInset() > 0 ? space.sm : settingsCompact() ? space.lg : space.xl,
        paddingBottom: space.x5l, gap: settingsCompact() ? space.x3l : space.x3l + space.xs,
      }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
            <Text role="header" testID="settings-page-title" style={textStyle("pageTitle")}>{tr(page().labelKey)}</Text>
            <If when={settingsScopeOf(pageId) === "preferences" && accountSyncCaptionShown()}>
              <Text accessibilityLabel="settings-synced" style={textStyle("caption", { color: palette().textMuted })}>
                {tr("settings.synced")}
              </Text>
            </If>
          </View>
          <If when={pageId === "usage"}>
            <IconButton
              icon="refresh"
              size="sm"
              tooltip={tr("settings.usage.reload")}
              accessibilityLabel="usage-reload"
              disabled={usageLoading() || usageActivityLoading()}
              onPress={() => void loadUsage(true)}
            />
          </If>
          <If when={settingsCompact()}>
            <Button label={tr("common.all")} variant="secondary" size="md" leadingIcon="list"
              accessibilityLabel="settings-compact-pages" style={{ minHeight: layout.touchTarget, flexShrink: 0 }}
              onPress={() => requestSettingsTransition({ kind: "compact-list" })} />
          </If>
        </View>
        <If when={settingsNotice()}>
          {notice => <InlineBanner tone={settingsNoticeTone(notice())} message={localizeHostError(notice())}
            onDismiss={() => settingsNotice.set("")} />}
        </If>
        <If when={settingsLoaded()} else={<Text style={textStyle("caption")}>{tr("settings.loading")}</Text>}>
          <View style={subtleCrossfadeMotion().style}>
            <ConfigFormCompactContext.Provider value={compactForm}>
              <SettingsPageBody pageId={pageId} />
            </ConfigFormCompactContext.Provider>
          </View>
        </If>
      </View>
    </Scroll>
  );
}

export function SettingsScene() {
  cleanup(registerSettingsExitGuard(proceed => requestSettingsTransition({ kind: "scene", proceed })));
  void loadAccountState();
  // Whether Preferences say "Synced with your account" is the backend's answer.
  void loadAccountSync();
  void loadSettingsValues();
  void loadModels();
  let lastSettingsDevice: string | null = null;
  effect(() => {
    const ctx = deviceContext();
    if (lastSettingsDevice !== null && ctx !== lastSettingsDevice) {
      untracked(() => {
        void loadSettingsValues();
        void loadModels();
      });
    }
    lastSettingsDevice = ctx;
  });
  // A page-level success (the interface language) is a toast, so the page never jumps.
  effect(() => {
    const notice = settingsNotice();
    if (!notice || settingsNoticeTone(notice) !== "success") return;
    untracked(() => {
      pushToast(localizeHostError(notice), "success");
      settingsNotice.set("");
    });
  });
  effect(() => {
    const activeLocale = currentLocale();
    if (lastSettingsLocale !== null && activeLocale !== lastSettingsLocale) {
      const notice = settingsNotice();
      if (notice) {
        const expectedForActive = tr("settings.notice.languageSaved", {
          label: localeMeta(activeLocale).nativeName,
        });
        if (notice !== expectedForActive) {
          settingsNotice.set("");
        }
      }
    }
    lastSettingsLocale = activeLocale;
  });
  // Leaving Settings resets compact state, search filter, OAuth pollers, and per-device load markers.
  cleanup(() => {
    closeMcpAuth();
    closePoolDraft();
    pendingNavigation.set(null);
    compactPageOpen.set(false);
    settingsSearchQuery.set("");
    memoryProcessingOpen.set(false);
    loadedDeviceForSection.clear();
    deviceScopeSwitchedInSettings = false;
  });
  const currentPage = () => ({ pageId: selectedSettingsPage(), deviceId: deviceContext() });
  const showList = (): boolean => settingsCompact() && !compactPageOpen();
  return (
    <View
      onLayout={trackSettingsWidth}
      style={{ flex: 1, minHeight: 0, flexDirection: "row", backgroundColor: palette().canvas }}
    >
      <If when={!settingsCompact()}>
        <View
          accessibilityLabel="settings-scope-list"
          style={{
            width: settingsListWidth(),
            flexShrink: 0,
            minHeight: 0,
            backgroundColor: palette().canvasSubtle,
          }}
        >
          <SettingsNavigationPanel />
        </View>
      </If>
      {/* The page clips to its own column so a long unbroken value never draws over the list. */}
      <View style={{ flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column", overflow: "hidden" }}>
        <CaptionDragStrip testID="settings-caption-drag-strip" />
        <If when={showList()} else={
          <Each of={[currentPage()]} key={entry => JSON.stringify([entry.deviceId, entry.pageId])}>
            {entry => <SettingsPageViewport pageId={entry().pageId} deviceId={entry().deviceId} />}
          </Each>
        }>
          <SettingsNavigationPanel compact />
        </If>
      </View>
      <UnsavedChangesDialog />
    </View>
  );
}

function SettingsNavText(props: { text: string; query?: string; primary: boolean }) {
  const match = computed(() => {
    const query = props.query?.trim() ?? "";
    const at = query ? props.text.toLowerCase().indexOf(query.toLowerCase()) : -1;
    return at < 0 ? null : { before: props.text.slice(0, at),
      word: props.text.slice(at, at + query.length), after: props.text.slice(at + query.length) };
  });
  return (
    <Text style={{ ...textStyle(props.primary ? "label" : "caption",
      { color: props.primary ? palette().text : palette().textMuted }),
      numberOfLines: 1, textOverflow: "ellipsis" }}>
      <If when={match()} else={props.text}>
        {parts => <>{parts().before}<Text style={{
          backgroundColor: designControlColors()?.settingsSearchMatch ?? palette().accentSoft,
        }}>{parts().word}</Text>{parts().after}</>}
      </If>
    </Text>
  );
}

function SettingsNavRow(props: {
  label: string;
  icon: IconName;
  active: boolean;
  highlighted?: boolean;
  dirty?: boolean;
  compact?: boolean;
  first?: boolean;
  secondary?: string;
  query?: string;
  accessibilityLabel: string;
  onPress: () => void;
  onHighlight?: () => void;
  rowRef?: (ref: ViewRef | null) => void;
}) {
  const colors = designControlColors;
  const metrics = settingsNavigationMetrics;
  return (
    <View role="button" ref={node => props.rowRef?.(node)}
      accessibilityLabel={props.accessibilityLabel} accessibilityState={{ selected: props.active }}
      onPress={props.onPress} onMouseEnter={props.onHighlight}
      style={{ position: "relative", flexDirection: "row", alignItems: "center",
        minHeight: props.compact ? layout.touchTarget : metrics.itemHeight,
        paddingHorizontal: props.compact ? SETTINGS_ROW_INSET : metrics.itemPadding,
        paddingVertical: props.secondary ? space.xs + space.hair : 0,
        borderRadius: props.compact ? 0 : metrics.itemRadius, borderCurve: "continuous",
        backgroundColor: props.active ? colors()?.rowSelection ?? palette().chromeActive
          : props.highlighted ? colors()?.navigationHover ?? palette().surfaceSubtle : "transparent",
        gap: metrics.itemGap, cursor: "pointer", userSelect: "none",
        ...paintTransition(MOTION_DURATION.fast),
      }}
      hoverStyle={{ backgroundColor: props.active ? colors()?.rowSelection ?? palette().chromeActive
        : colors()?.navigationHover ?? palette().surfaceSubtle }}
      activeStyle={tactileActiveStyle(0.985, { backgroundColor: colors()?.navigationPressed ?? palette().buttonSecondaryPressed })}
      focusVisibleStyle={focusRingStyle()}>
      <If when={props.compact && !props.first}><RowSeparator edge="top" /></If>
      <Icon name={props.icon} size={metrics.iconSize} color={props.active ? palette().text : palette().textSecondary} />
      <View style={{ flex: 1, minWidth: 0, gap: space.hair }}>
        <SettingsNavText text={props.label} query={props.query} primary />
        <If when={props.secondary ?? ""}>
          {detail => <SettingsNavText text={detail()} query={props.query} primary={false} />}
        </If>
      </View>
      <If when={props.dirty}>
        <View accessibilityLabel={tr("settings.unsaved.title")} style={{
          width: space.chip, height: space.chip, flexShrink: 0, borderRadius: radii.pill,
          backgroundColor: palette().warning,
        }} />
      </If>
      <If when={props.compact}>
        <Icon name="chevron-right" size={metrics.iconSize} color={palette().textMuted} />
      </If>
    </View>
  );
}

function SettingsNavGroupLabel(props: { label: string; extra?: JSX.Element }) {
  const metrics = settingsNavigationMetrics;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: metrics.headingGap,
        minHeight: metrics.headingHeight,
        paddingLeft: metrics.headingPadding,
        paddingRight: props.extra ? 0 : metrics.headingPadding,
      }}
    >
      <Text
        role="header"
        style={{
          ...textStyle("caption", { color: designControlColors()?.navigationCaption ?? palette().textMuted }),
          fontWeight: metrics.selectedWeight,
          flexShrink: 0,
          numberOfLines: 1,
        }}
      >
        {props.label}
      </Text>
      <If when={Boolean(props.extra)}>
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "flex-end",
          }}
        >
          {props.extra}
        </View>
      </If>
    </View>
  );
}

/** The devices the Device scope may name: runtime devices (including this device), offline ones listed but disabled. */
function scopeDeviceOptions(): SelectDropdownOption<string>[] {
  return fleetDevices()
    .filter(device => device.hostKind !== "cloud" && device.hostKind !== "phone" && device.hostKind !== "browser")
    .map(device => {
      const offline = device.state === "offline" || device.state === "unreachable";
      return {
        value: device.deviceId,
        label: device.name,
        icon: deviceGlyphIcon(device.hostKind),
        description: offline ? tr("settings.offline") : undefined,
        disabled: offline,
        accessibilityLabel: `settings-scope-device-${device.deviceId}`,
      };
    });
}

/**
 * The Device scope chip: which device's settings the Device pages read. It is
 * navigation inside Settings, not a "where should work run" choice. Without
 * the fleet layer there is one device, named as this device.
 */
function DeviceScopeChip() {
  return (
    <If
      when={fleetActive() && scopeDeviceOptions().length > 0}
      else={
        <View
          accessibilityLabel="settings-scope-chip"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            height: controlHeight.sm,
            paddingHorizontal: space.sm,
            minWidth: 0,
            maxWidth: "100%",
          }}
        >
          <Icon name="laptop" size={14} color={palette().textSecondary} />
          <Text
            style={{
              ...textStyle("label", { color: palette().text }),
              flexShrink: 1,
              minWidth: 0,
              numberOfLines: 1,
              textOverflow: "ellipsis",
            }}
          >
            {tr("devices.thisDevice")}
          </Text>
        </View>
      }
    >
      <SelectDropdown<string>
        size="sm"
        variant="ghost"
        value={deviceContext() || null}
        options={scopeDeviceOptions()}
        accessibilityLabel="settings-scope-chip"
        onChange={deviceId => requestDeviceScope(deviceId)}
      />
    </If>
  );
}

function SettingsNavigationPanel(props: { compact?: boolean }) {
  const metrics = settingsNavigationMetrics;
  const highlighted = signal<string | null>(null);
  const activeNode = signal<ViewRef | null>(null);
  const focused = signal(false);
  const composing = signal(false);
  const dirtyPages = computed(() => {
    const pages = new Set(dirtyFields().flatMap(field => {
      const section = sectionOfField(field);
      return section ? [resolveSettingsPage(section.page)] : [];
    }));
    if (mcpJsonDirty() || mcpDraftDirty() || mcpImportDirty()) pages.add("mcp");
    return pages;
  });
  const searchMode = () => settingsSearchQuery().trim().length > 0;
  const inset = () => props.compact ? layout.phoneGutter : metrics.padding;
  const rowRefs = new Map<string, ViewRef>();
  let input: InputRef | null = null;
  let viewport: ScrollRef | null = null;

  const highlight = (hit: SettingsSearchHit | undefined, reveal = false) => {
    const node = hit ? rowRefs.get(hit.key) ?? null : null;
    highlighted.set(hit?.key ?? null);
    activeNode.set(node);
    if (reveal) node?.reveal({ vertical: "nearest", animated: false });
  };
  const edit = (value: string) => {
    settingsSearchQuery.set(value);
    highlight(undefined);
    viewport?.scrollTo({ y: 0, animated: false });
  };
  const clear = () => { edit(""); input?.focus(); };
  const submit = () => {
    if (composing()) return;
    const hits = settingsSearchResults();
    const hit = hits.find(entry => entry.key === highlighted()) ?? (hits.length === 1 ? hits[0] : undefined);
    if (hit) openSettingsSearchHit(hit);
  };

  effect(() => {
    if (!focused() || composing() || !searchMode() || pendingNavigation()) return;
    const move = ({ keystroke }: { keystroke: string }) => {
      const hits = settingsSearchResults();
      if (!hits.length) return;
      const at = hits.findIndex(hit => hit.key === highlighted());
      if (keystroke === "home") highlight(hits[0], true);
      else if (keystroke === "end") highlight(hits.at(-1), true);
      else if (keystroke === "down") highlight(hits[Math.min(hits.length - 1, at + 1)], true);
      else highlight(at > 0 ? hits[at - 1] : undefined, true);
    };
    return keymap.bind({ up: move, down: move, home: move, end: move, escape: clear },
      { when: "always", overFocused: true });
  });

  return (
    <View style={{ flex: 1, minHeight: 0, minWidth: 0, gap: metrics.gap, paddingTop: inset() }}>
      <View style={{ flexShrink: 0, paddingHorizontal: inset() }}>
        <SearchInput value={settingsSearchQuery()} onChange={edit} onSubmit={submit} onClear={clear}
          inputRef={node => { input = node; }}
          onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
          onCompositionChange={value => composing.set(value)}
          accessibilityExpanded={searchMode()} accessibilityActiveDescendant={activeNode()}
          placeholder={tr("settings.search.placeholder")} size={props.compact ? "lg" : "sm"}
          style={props.compact ? { height: layout.touchTarget, minHeight: layout.touchTarget } : undefined}
          accessibilityLabel={props.compact ? "settings-compact-search" : "settings-search"} />
      </View>
      <Scroll smoothWheel ref={node => { viewport = node; }} testID="settings-navigation-scroll"
        style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled"
        contentStyle={{ paddingHorizontal: inset(), paddingBottom: space.x3l }}>
        <If when={searchMode()} else={
          <View style={{ gap: metrics.sectionGap }}>
            <Each of={SETTINGS_PAGE_GROUPS} key={group => group.id}>
              {group => {
                const heading = () => tr(group().labelKey);
                const extra = () => group().id === "device" ? <DeviceScopeChip /> : undefined;
                return <View>
                  <If when={props.compact} else={<SettingsNavGroupLabel label={heading()} extra={extra()} />}>
                    <SectionHeader title={heading()} extra={extra()} />
                  </If>
                  <View style={props.compact ? insetGroupStyle() : { gap: space.hair }}>
                    <Each of={visibleSettingsPages(group())} key={entry => entry.id}>
                      {(entry, index) => <SettingsNavRow
                        label={tr(entry().labelKey)} icon={entry().icon} compact={props.compact} first={index() === 0}
                        active={selectedSettingsPage() === entry().id} dirty={dirtyPages().has(entry().id)}
                        accessibilityLabel={(props.compact ? "settings-compact-page-" : "nav-settings-page-") + entry().id}
                        onPress={() => requestSettingsPage(entry().id)} /> }
                    </Each>
                  </View>
                </View>;
              }}
            </Each>
          </View>
        }>
          <If when={settingsSearchResults().length > 0} else={
            <Text style={{ ...textStyle("caption"), textAlign: "center", padding: space.md }}>
              {tr("settings.search.empty")}
            </Text>
          }>
            <View role="listbox" style={props.compact ? insetGroupStyle() : { gap: space.hair }}>
              <Each of={settingsSearchResults()} key={hit => hit.key}>
                {(hit, index) => <SettingsNavRow
                  label={hit().anchor ? hit().context + " › " + hit().label : hit().context}
                  secondary={hit().detail} icon={hit().icon} query={settingsSearchQuery()}
                  compact={props.compact} first={index() === 0}
                  active={selectedSettingsPage() === hit().pageId && (hit().anchor ?? null) === activeSettingsAnchor()}
                  dirty={dirtyPages().has(hit().pageId)} highlighted={highlighted() === hit().key}
                  accessibilityLabel={(props.compact ? "settings-compact-hit-" : "settings-search-hit-") + hit().key.replace(/:/g, "-")}
                  onHighlight={() => highlight(hit())} onPress={() => openSettingsSearchHit(hit())}
                  rowRef={node => {
                    const key = hit().key;
                    if (node) rowRefs.set(key, node); else rowRefs.delete(key);
                    if (highlighted() === key) activeNode.set(node);
                  }} /> }
              </Each>
            </View>
          </If>
        </If>
      </Scroll>
    </View>
  );
}

// ── wave22-p5: Preferences › Shortcuts ────────────────────────────────────────

function KeyCaps(props: { keystroke: string }) {
  const label = (): string => {
    try {
      return keymap.label(props.keystroke);
    } catch {
      return props.keystroke;
    }
  };
  return (
    <View
      style={{
        paddingHorizontal: space.chip,
        minHeight: space.xxl,
        justifyContent: "center",
        borderRadius: radii.sm,
        borderWidth: 1,
        borderColor: palette().borderSubtle,
        backgroundColor: palette().surfaceTertiary,
      }}
    >
      <Text style={textStyle("label", { color: palette().textSecondary, tabular: true })}>{label()}</Text>
    </View>
  );
}

async function storeShortcut(definition: ShortcutDefinition, keystroke: string): Promise<void> {
  const taken = shortcutUsing(keystroke, definition.id);
  if (taken) {
    shortcutNotice.set(tr("shortcuts.conflict", { action: tr(taken.labelKey) }));
    return;
  }
  try {
    await setShortcut(definition.id, keystroke);
    shortcutNotice.set("");
  } catch (error) {
    shortcutNotice.set(localizeHostError(error instanceof Error ? error.message : String(error)));
  } finally {
    shortcutRecording.set(null);
  }
}

function ShortcutRecorder(props: { definition: ShortcutDefinition }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
      <View
        ref={node => node?.focus()}
        focusable={true}
        captureKeys="all"
        accessibilityLabel={`shortcut-recorder-${props.definition.id}`}
        onKeyDown={event => {
          if (event.key === "Escape") {
            shortcutRecording.set(null);
            return;
          }
          const keystroke = keystrokeFromKeyEvent(event);
          if (keystroke) void storeShortcut(props.definition, keystroke);
        }}
        onBlur={() => {
          if (shortcutRecording() === props.definition.id) shortcutRecording.set(null);
        }}
        style={{
          paddingHorizontal: space.sm,
          minHeight: compactLayout() ? layout.touchTarget : controlHeight.sm,
          justifyContent: "center",
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: palette().accent,
        }}
      >
        <Text style={textStyle("label", { color: palette().textSecondary })}>{tr("shortcuts.recording")}</Text>
      </View>
      <IconButton
        icon="close"
        size="sm"
        tooltip={tr("common.cancel")}
        accessibilityLabel={`shortcut-cancel-${props.definition.id}`}
        onPress={() => shortcutRecording.set(null)}
      />
    </View>
  );
}

function ShortcutRow(props: { definition: ShortcutDefinition; first: boolean }) {
  const overridden = () => props.definition.id in keybindingOverrides();
  return (
    <SettingsRow label={tr(props.definition.labelKey)} first={props.first}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginLeft: "auto" }}>
        <If
          when={shortcutRecording() === props.definition.id}
          else={
            <>
              <View accessibilityLabel={`shortcut-keys-${props.definition.id}`}>
                <KeyCaps keystroke={effectiveKeystroke(props.definition)} />
              </View>
              <If when={keystrokeReservedHere(effectiveKeystroke(props.definition))}>
                <Text style={{ color: palette().textMuted, fontSize: textSize(12), lineHeight: textLineHeight(12, 1.4) }}>
                  {tr("shortcuts.reservedByBrowser")}
                </Text>
              </If>
              <Button
                label={tr("shortcuts.change")}
                variant="ghost"
                size="sm"
                accessibilityLabel={`shortcut-change-${props.definition.id}`}
                onPress={() => {
                  shortcutNotice.set("");
                  shortcutRecording.set(props.definition.id);
                }}
              />
            </>
          }
        >
          <ShortcutRecorder definition={props.definition} />
        </If>
        <If when={overridden()}>
          <IconButton
            icon="undo"
            size="sm"
            tooltip={tr("shortcuts.reset")}
            accessibilityLabel={`shortcut-reset-${props.definition.id}`}
            onPress={() => void resetShortcut(props.definition.id).catch(() => undefined)}
          />
        </If>
      </View>
    </SettingsRow>
  );
}

function ShortcutsSection() {
  void loadKeybindings();
  return (
    <SettingsGroup
      id="shortcuts"
      title={tr("settings.shortcuts.title")}
      hideTitle={repeatsPageTitle(tr("settings.shortcuts.title"))}
      description={tr("shortcuts.body")}
      notice={shortcutNotice()}
      onDismissNotice={() => shortcutNotice.set("")}
      extra={
        <If when={Object.keys(keybindingOverrides()).length > 0}>
          <Button
            label={tr("shortcuts.resetAll")}
            variant="ghost"
            size="sm"
            accessibilityLabel="shortcut-reset-all"
            onPress={() => void resetAllShortcuts().catch(() => undefined)}
          />
        </If>
      }
    >
      <Each of={[...SHORTCUT_DEFINITIONS]} key={definition => definition.id}>
        {(definition, index) => <ShortcutRow definition={definition()} first={index() === 0} />}
      </Each>
    </SettingsGroup>
  );
}

// ── wave22-p5: Device › Browser and desktop control › permissions ─────────────

const COMPUTER_PERMISSION_LABELS: Record<string, MessageKey> = {
  accessibility: "computerUse.kind.accessibility",
  screen_recording: "computerUse.kind.screenRecording",
  input_posting: "computerUse.kind.inputPosting",
  input_monitoring: "computerUse.kind.inputMonitoring",
};

const COMPUTER_PERMISSION_STATES: Record<string, MessageKey> = {
  granted: "computerUse.state.granted",
  required: "computerUse.state.required",
  session_required: "computerUse.state.sessionRequired",
  not_required: "computerUse.state.notRequired",
  unavailable: "computerUse.state.unavailable",
};

function ComputerPermissionRowView(props: { row: () => ComputerPermissionRow; first: () => boolean }) {
  const label = () => {
    const key = COMPUTER_PERMISSION_LABELS[props.row().kind];
    return key ? tr(key) : props.row().kind;
  };
  const stateWord = () => {
    const key = COMPUTER_PERMISSION_STATES[props.row().state];
    return key ? tr(key) : props.row().state;
  };
  const needsAction = () => props.row().state === "required" || props.row().state === "session_required";
  return (
    <SettingsRow label={label()} description={props.row().detail} first={props.first()}>
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, marginLeft: "auto" }}
        accessibilityLabel={`computer-use-${props.row().kind}`}
      >
        <Text style={textStyle("caption", { color: needsAction() ? stateColor("needs_you") : palette().textMuted })}>
          {stateWord()}
        </Text>
        <If when={needsAction() && props.row().requestable}>
          <Button
            label={tr("computerUse.request")}
            variant="secondary"
            size="sm"
            loading={computerUseBusy() === props.row().kind}
            accessibilityLabel={`computer-use-request-${props.row().kind}`}
            onPress={() => void requestComputerPermission(props.row().kind)}
          />
        </If>
        <If when={needsAction() && Boolean(props.row().settingsUrl)}>
          <Button
            label={tr("computerUse.openSettings")}
            variant="ghost"
            size="sm"
            accessibilityLabel={`computer-use-open-${props.row().kind}`}
            onPress={() => void openComputerUseSettings(props.row().kind)}
          />
        </If>
      </View>
    </SettingsRow>
  );
}

interface ExternalControlSettings {
  enabled: boolean;
  listening: boolean;
  port: number;
  endpoint: string;
  error: string | null;
  token: string | null;
  grants: { id: string; name: string; workspaceIds: string[]; origin: string | null }[];
  workspaces: { id: string; name: string }[];
}

type ExternalControlRequest =
  | { operation: "status" }
  | { operation: "setEnabled"; enabled: boolean; port: number }
  | { operation: "issue"; name: string; workspaceIds: string[]; origin?: string }
  | { operation: "revoke"; id: string };

function ExternalControlSection() {
  const settings = signal<ExternalControlSettings | null>(null);
  const busy = signal(false);
  const notice = signal("");
  const port = signal("");
  const name = signal("");
  const origin = signal("");
  const selected = signal<string[]>([]);
  const menuOpen = signal(false);
  let menuAnchor: ViewRef | null = null;
  const workspaces = () => settings()?.workspaces ?? [];
  const allSelected = () => workspaces().length > 0 && selected().length === workspaces().length;
  const selectionLabel = () => {
    if (workspaces().length === 0) return tr("externalControl.noWorkspaces");
    if (selected().length === 0) return tr("common.selectEllipsis");
    if (selected().length === 1) return workspaces().find(ws => ws.id === selected()[0])!.name;
    return tr("externalControl.selectedCount", { count: formatCount(selected().length) });
  };
  let mounted = true;
  cleanup(() => { mounted = false; });
  const validPort = () => /^\d+$/.test(port()) && Number(port()) >= 1 && Number(port()) <= 65535;

  async function run(request: ExternalControlRequest) {
    if (busy()) return;
    busy.set(true);
    notice.set("");
    try {
      const result = await invokeCommand<ExternalControlSettings>("desktop_external_control", request);
      if (!mounted) return;
      selected.update(ids => ids.filter(id => result.workspaces.some(ws => ws.id === id)));
      settings.set(result);
      port.set(String(result.port));
      if (request.operation === "issue") {
        name.set("");
        origin.set("");
        selected.set([]);
      }
    } catch (error) {
      if (mounted) notice.set(isCommandUnavailable(error, "desktop_external_control")
        ? tr("settings.notice.hostUpdateRequired") : errorMessageOf(error));
    } finally {
      if (mounted) busy.set(false);
    }
  }

  void run({ operation: "status" });
  return (
    <SettingsGroup id="external-control" title={tr("externalControl.title")}
      description={tr("externalControl.description")} notice={notice() || settings()?.error || ""}>
      <SettingsRow first label={tr("externalControl.enable")}>
        <ToggleSwitch accessibilityLabel="external-control-enabled" value={settings()?.enabled === true}
          disabled={!settings() || busy() || !validPort()}
          onChange={enabled => void run({ operation: "setEnabled", enabled, port: Number(port()) })} />
      </SettingsRow>
      <If when={settings() && !settings()?.listening}>
        <SettingsRow wrap={false} label={tr("externalControl.port")}>
          <TextField size="sm" style={{ width: 96, maxWidth: "100%" }} value={port()} onChange={value => port.set(value)} accessibilityLabel="external-control-port" />
        </SettingsRow>
      </If>
      <If when={notice() || settings()?.error}>
        <SettingsRow label={tr("common.retry")}>
          <Button label={tr("common.retry")} disabled={busy() || (!!settings()?.enabled && !validPort())}
            onPress={() => void run(settings()?.enabled && !settings()?.listening
              ? { operation: "setEnabled", enabled: true, port: Number(port()) } : { operation: "status" })} />
        </SettingsRow>
      </If>
      <If when={settings()?.listening}>
        <View>
          <SettingsRow wrap={false} label={tr("externalControl.endpoint")}>
            <Text style={textStyle("mono")}>{settings()?.endpoint}</Text>
          </SettingsRow>
          <SettingsRow wrap={false} label={tr("externalControl.name")}>
            <TextField size="sm" style={{ width: 220, maxWidth: "100%" }} value={name()} onChange={value => name.set(value)} accessibilityLabel="external-control-name" />
          </SettingsRow>
          <SettingsRow wrap={false} label={tr("externalControl.workspaces")}>
            <View ref={el => { menuAnchor = el; }} style={{ maxWidth: "100%" }}>
              <Button label={selectionLabel()} variant="outline" size="sm" trailingIcon="chevron-down"
                accessibilityLabel="external-control-workspaces" disabled={busy() || !workspaces().length}
                onPress={() => menuOpen.set(!menuOpen())} />
            </View>
            <DropdownMenu open={menuOpen()} anchor={menuAnchor} align="end" onClose={() => menuOpen.set(false)}
              items={[
                {
                  id: "all", label: tr("shell.menu.selectAll"), active: allSelected(), keepOpenOnSelect: true,
                  onSelect: () => selected.set(allSelected() ? [] : workspaces().map(ws => ws.id)),
                },
                ...workspaces().map((ws, index) => ({
                  id: `workspace-${ws.id}`, label: ws.name, separator: index === 0,
                  active: selected().includes(ws.id), keepOpenOnSelect: true,
                  onSelect: () => selected.update(ids => ids.includes(ws.id)
                    ? ids.filter(id => id !== ws.id) : [...ids, ws.id]),
                })),
              ]} />
          </SettingsRow>
          <SettingsRow stacked label={tr("externalControl.origin")} description={tr("externalControl.originHint")}>
            <TextField value={origin()} onChange={value => origin.set(value)} accessibilityLabel="external-control-origin" />
          </SettingsRow>
          <SettingsRow label={tr("externalControl.issue")}>
            <Button label={tr("externalControl.issue")} accessibilityLabel="external-control-issue"
              disabled={busy() || !name().trim() || selected().length === 0}
              onPress={() => void run({ operation: "issue", name: name().trim(), workspaceIds: selected(), origin: origin().trim() || undefined })} />
          </SettingsRow>
          <If when={settings()?.token}>
            {token => <SettingsRow stacked label={tr("externalControl.token")} description={tr("externalControl.tokenHint")}>
              <Text accessibilityLabel="external-control-token" style={textStyle("body")}>{token()}</Text>
              <Button label={tr("common.copy")} onPress={() => void Clipboard.writeText(token()).then(
                () => pushToast(tr("common.copied"), "success"), error => notice.set(errorMessageOf(error)))} />
            </SettingsRow>}
          </If>
        </View>
      </If>
      <Each of={settings()?.grants ?? []} key={grant => grant.id}>
        {grant => <SettingsRow label={grant().name}
          description={grant().workspaceIds.map(id => settings()?.workspaces.find(ws => ws.id === id)?.name ?? id).join(", ")}>
          <Button label={tr("externalControl.revoke")} disabled={busy()}
            onPress={() => void run({ operation: "revoke", id: grant().id })} />
        </SettingsRow>}
      </Each>
    </SettingsGroup>
  );
}

function ComputerUseSection() {
  effect(() => {
    deviceContext();
    void loadComputerUseStatus();
  });
  return (
    <>
      <If when={computerUseState() === "unsupported"}>
        <UnsupportedNote title={tr("computerUse.title")} message={unsupportedOnDevice()} />
      </If>
      <If when={computerUseState() !== "unsupported"}>
        <SettingsGroup
          id="computer-use"
          title={tr("computerUse.title")}
          description={tr("computerUse.body")}
          notice={computerUseNotice() ? localizeHostError(computerUseNotice()) : ""}
          onDismissNotice={() => computerUseNotice.set("")}
          extra={
            <IconButton
              icon="refresh"
              size="sm"
              tooltip={tr("computerUse.refresh")}
              accessibilityLabel="computer-use-refresh"
              onPress={() => void loadComputerUseStatus()}
            />
          }
        >
          <If when={computerUseState() === "loading" && !computerUseStatus()}>
            <SettingsRow label={tr("computerUse.loading")} first={true} />
          </If>
          <Each of={computerUseStatus()?.permissions ?? []} key={row => row.kind}>
            {(row, index) => <ComputerPermissionRowView row={row} first={() => index() === 0} />}
          </Each>
        </SettingsGroup>
      </If>
    </>
  );
}

// ── wave22-p5: Device › Diagnostics › settings export and import ──────────────

async function exportSettingsToClipboard(): Promise<void> {
  try {
    await copyConfigExport();
    pushToast(tr("configTransfer.copied", { device: scopeDeviceName() || tr("configTransfer.thisDevice") }), "success");
  } catch (error) {
    pushToast(localizeHostError(error instanceof Error ? error.message : String(error)), "error");
  }
}

async function runConfigImport(): Promise<void> {
  const outcome = await importConfigText();
  if (outcome?.success) {
    pushToast(
      outcome.warnings.length > 0
        ? tr("configTransfer.importedWithWarnings", { count: outcome.warnings.length })
        : tr("configTransfer.imported"),
      "success",
    );
    void loadSettingsValues();
  }
}

function configImportErrorText(): string {
  const code = configImportError();
  if (code === "invalidJson") return tr("configTransfer.invalidJson");
  if (code === "tooLarge") return tr("configTransfer.tooLarge");
  if (code === "failed") return tr("configTransfer.failed");
  return localizeHostError(code);
}

function ConfigImportDialog() {
  return (
    <ModalDialog
      open={configImportOpen()}
      title={tr("configTransfer.importTitle")}
      subtitle={tr("configTransfer.importBody", { device: scopeDeviceName() || tr("configTransfer.thisDevice") })}
      size="md"
      accessibilityLabel="config-import-dialog"
      onClose={() => closeConfigImport()}
      footer={
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, flex: 1 }}>
          <Button
            label={tr("configTransfer.chooseFile")}
            variant="ghost"
            size="md"
            leadingIcon="file"
            accessibilityLabel="config-import-choose"
            onPress={() => void pickConfigFile().catch(() => undefined)}
          />
          <View style={{ flex: 1 }} />
          <Button label={tr("common.cancel")} variant="secondary" size="md" onPress={() => closeConfigImport()} />
          <Button
            label={tr("configTransfer.import")}
            variant="primary"
            size="md"
            loading={configTransferBusy() === "import"}
            disabled={!configImportText().trim()}
            accessibilityLabel="config-import-confirm"
            onPress={() => void runConfigImport()}
          />
        </View>
      }
    >
      <View style={{ gap: space.sm }}>
        <If when={configImportName()}>
          <Text style={textStyle("caption", { color: palette().textMuted })}>{configImportName()}</Text>
        </If>
        <TextField
          multiline
          monospace
          minHeight={space.x6l * 2}
          placeholder={tr("configTransfer.pastePlaceholder")}
          value={configImportText()}
          accessibilityLabel="config-import-text"
          onChange={value => configImportText.set(value)}
        />
        <If when={configImportError()}>
          <Text accessibilityLabel="config-import-error" style={textStyle("caption", { color: stateColor("failed") })}>
            {configImportErrorText()}
          </Text>
        </If>
      </View>
    </ModalDialog>
  );
}

function ConfigTransferSection() {
  return (
    <SettingsGroup id="config-transfer" title={tr("configTransfer.title")}>
      <SettingsRow label={tr("configTransfer.export")} description={tr("configTransfer.exportBody")} first={true}>
        <Button
          label={tr("configTransfer.copy")}
          variant="secondary"
          size="sm"
          loading={configTransferBusy() === "export"}
          accessibilityLabel="config-export-copy"
          onPress={() => void exportSettingsToClipboard()}
        />
      </SettingsRow>
      <SettingsRow label={tr("configTransfer.importRow")} description={tr("configTransfer.importRowBody")}>
        <Button
          label={tr("configTransfer.importEllipsis")}
          variant="secondary"
          size="sm"
          accessibilityLabel="config-import-open"
          onPress={() => openConfigImport()}
        />
      </SettingsRow>
      <ConfigImportDialog />
    </SettingsGroup>
  );
}
