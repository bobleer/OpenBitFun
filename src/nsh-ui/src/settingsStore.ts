// Settings values and writes.
//
// Reads are per config path, because `get_configs` fails the whole batch when a
// single path is missing on the host. Fields read dotted leaf paths
// (`app.auto_update`, `editor.font_size`, `memories.extract_model`) and write
// through `set_config` or a typed settings intent. The combined memory toggle
// uses its owner's intent to update both flags together. Nothing here patches
// a snapshot of a parent object read at load time: such a write would put back every
// sibling as it was when the page opened, reverting what another section or
// surface changed since (the quick-action list in `app.ai_experience`, the
// interface language in `app`).

import { batch, signal } from "nsh";
import { getConfig, setConfig } from "./api";
import { backendConnection, fleetDeviceContext, invokeCommand, invokeRawCommand, listenEvent } from "./bridge";
import { fleetDeviceById } from "./fleetStore";
import {
  appLocaleSaving,
  currentLocale,
  localeMeta,
  normalizeLocale,
  setAppLocale,
  tr,
  type AppLocale,
  type MessageKey,
} from "./i18n";
import { errorText, invokeSettingsMutation } from "./settingsMutations";
import { setPromptSuggestionsEnabled } from "./promptSuggestionStore";
import { currentDeviceScopeKey, isDeviceOnThisMachine } from "./shared/deviceScope";
import { runStep } from "./state";
import { superAgentUi } from "./productGates"; // wave23-E

export type FieldKind = "boolean" | "select" | "number" | "text" | "model" | "model-target";

type ExecutionCapability = "model_routing_v1" | "model_pool_selection_v1" | "subagent_model_override_policy_v1";
export type AgentModelTarget =
  | { kind: "inherit" }
  | { kind: "model"; model_ref: string }
  | { kind: "pool"; pool_id: string };

export interface FieldOption {
  value: string;
  label: string;
  labelKey?: MessageKey;
  disabledReason?: MessageKey;
}

export interface FieldSpec {
  /** Stable id, used as the control's accessibility label. */
  id: string;
  label: string;
  labelKey?: MessageKey;
  /** The dotted leaf config path the value lives at. */
  path: string;
  /** A second boolean controlled by the same toggle; enabled only when both are true. */
  linkedBooleanPath?: string;
  /**
   * Legacy: a dotted field inside `path`. Read and written as the leaf
   * `${path}.${field}`, never by patching the parent object.
   */
  field?: string;
  /** The scalar or typed leaf used by a host predating model routing. */
  legacyPath?: string;
  capability?: ExecutionCapability;
  kind: FieldKind;
  options?: FieldOption[];
  /** Keep a select's control consistent across locales instead of sizing it from translated labels. */
  selectPresentation?: "segmented" | "dropdown";
  min?: number;
  max?: number;
  /** Decimal places for a fractional stepper. Other numeric controls stay integer. */
  precision?: number;
  /**
   * A number the host keeps as `Option`: an empty field or 0 stores `null`
   * ("no limit"), and the stepper offers to clear it.
   */
  clearable?: boolean;
  /** A secret text value (a proxy password): drawn masked. */
  masked?: boolean;
  /** Extra words the settings search matches besides the label and description. */
  keywords?: string[];
  /** A select whose choices the host lists (its installed browsers), read when drawn. */
  dynamicOptions?: () => FieldOption[];
  /** The option an empty stored string stands for. */
  emptyMeans?: string;
  /** The label of the empty choice a `model` field needs: what "no override" means. */
  emptyLabel?: string;
  emptyLabelKey?: MessageKey;
  hint?: string;
  hintKey?: MessageKey;
  /** Concise friendly description key rendered under the row label. */
  descriptionKey?: MessageKey;
  /** Domain-specific input placeholder for `text` and `number` fields. */
  placeholder?: string;
  placeholderKey?: MessageKey;
  /** Short measurement unit label for numeric inputs (e.g. `s`, `px`, `days`). */
  unit?: string;
  unitKey?: MessageKey;
  /** Paths older hosts may not have; a missing one without a default is unavailable. */
  optional?: boolean;
  /**
   * What the host does when the path is absent. A field with a default stays
   * writable: the value shown is the product's own default, and the first write
   * creates the path.
   */
  defaultValue?: string | number | boolean;
  /**
   * A typed settings command that writes this value instead of a leaf
   * `set_config` (`{ [requestKey]: value }`, sent to the device in context).
   */
  mutation?: { command: string; requestKey: string; request?: Record<string, unknown> };
}

/** The settings pages, mirroring the desktop's settings registry. */
export type SettingsPageId =
  | "general"
  | "appearance"
  | "input"
  | "shortcuts"
  | "pet"
  | "profile"
  | "devices"
  | "openbitfun"
  | "activity"
  | "storage"
  | "archived"
  | "models"
  | "session-memory"
  | "execution"
  | "permissions"
  | "editor"
  | "terminal"
  | "workspace"
  | "external-import"
  | "web-search"
  | "desktop-control"
  | "mcp"
  | "external-agents"
  | "automation"
  | "usage"
  | "diagnostics";

export interface SettingsSection {
  id: string;
  title: string;
  titleKey?: MessageKey;
  /** The settings page that draws this section. */
  page: SettingsPageId;
  fields: FieldSpec[];
}


// wave23-E: this device's Super Agent switches only make sense next to the
// Super Agent entry, so they are hidden while it is gated off (`productGates.ts`).
const SUPER_AGENT_DEVICE_SECTIONS: SettingsSection[] = [
  {
    // This device's switches for the OpenBitFun cloud agent (config path
    // `superagent`); both are on unless they are exactly `false`.
    id: "superagent-device",
    title: "Super Agent",
    titleKey: "obf.toggle",
    page: "permissions",
    fields: [
      {
        id: "superagent-allow-auto-approval",
        label: "Let Super Agent answer for me",
        labelKey: "perm.agentAnswers",
        descriptionKey: "perm.agentAnswersBody",
        path: "superagent.allowAutoApproval",
        kind: "boolean",
        mutation: { command: "set_superagent_settings", requestKey: "allowAutoApproval" },
        optional: true,
        defaultValue: true,
        keywords: ["openbitfun", "super agent", "approve", "superagent"],
      },
      {
        id: "superagent-accept-dispatch",
        label: "Accept jobs from Super Agent",
        labelKey: "perm.acceptJobs",
        descriptionKey: "perm.acceptJobsBody",
        path: "superagent.acceptDispatch",
        kind: "boolean",
        mutation: { command: "set_superagent_settings", requestKey: "acceptDispatch" },
        optional: true,
        defaultValue: true,
        keywords: ["openbitfun", "super agent", "jobs", "superagent"],
      },
    ],
  },
];

const MEMORY_ENABLE_PATHS = ["memories.generate_memories", "memories.use_memories"] as const;

export const SETTINGS_SECTIONS: SettingsSection[] = [
  ...(superAgentUi() ? SUPER_AGENT_DEVICE_SECTIONS : []),
  {
    id: "general",
    title: "Startup",
    titleKey: "settings.section.startup",
    page: "general",
    fields: [
      {
        id: "close-button",
        label: "Close button",
        labelKey: "settings.field.closeButton",
        descriptionKey: "settings.field.closeButtonDesc",
        path: "app.close_button_behavior",
        kind: "select",
        selectPresentation: "segmented",
        options: [
          { value: "minimize_to_tray", label: "Minimize to tray", labelKey: "settings.opt.minimizeToTray" },
          { value: "quit", label: "Quit", labelKey: "settings.opt.quit" },
          { value: "ask", label: "Ask", labelKey: "settings.opt.ask" },
        ],
        optional: true,
        keywords: ["window", "tray", "quit"],
      },
      {
        id: "notify-dialog-completion",
        label: "Notify when a dialog turn finishes",
        labelKey: "settings.field.notifyDialogCompletion",
        descriptionKey: "settings.field.notifyDialogCompletionDesc",
        path: "app.notifications.dialog_completion_notify",
        kind: "boolean",
        optional: true,
        keywords: ["notification"],
      },
      {
        id: "notify-permission-request",
        label: "Notify on permission requests",
        labelKey: "settings.field.notifyPermissionRequest",
        descriptionKey: "settings.field.notifyPermissionRequestDesc",
        path: "app.notifications.permission_request_notify",
        kind: "boolean",
        optional: true,
        keywords: ["notification", "approval"],
      },
      // `telemetry`, `confirm_on_exit` and `restore_windows` are stored on the
      // host but nothing reads them, so they are not drawn.
      {
        id: "auto-update",
        label: "Check for updates automatically",
        labelKey: "settings.field.autoUpdate",
        descriptionKey: "settings.field.autoUpdateDesc",
        path: "app.auto_update",
        kind: "boolean",
        optional: true,
        keywords: ["update", "upgrade"],
      },
      {
        id: "prevent-sleep",
        label: "Keep the computer awake",
        labelKey: "settings.field.preventSleep",
        descriptionKey: "settings.field.preventSleepDesc",
        path: "app.prevent_sleep",
        kind: "boolean",
        optional: true,
        keywords: ["sleep", "awake"],
      },
    ],
  },
  {
    id: "input",
    title: "Input",
    titleKey: "settings.section.input",
    page: "input",
    fields: [
      {
        id: "selection-toolbar",
        label: "Show excerpt actions after selecting text",
        labelKey: "settings.field.selectionToolbar",
        descriptionKey: "settings.field.selectionToolbarDesc",
        path: "app.flow_chat.auto_show_selection_toolbar",
        kind: "boolean",
        optional: true,
        keywords: ["selection", "excerpt", "toolbar"],
      },
    ],
  },
  {
    id: "session",
    title: "Session",
    titleKey: "settings.section.session",
    page: "session-memory",
    fields: [
      {
        id: "session-title-generation",
        label: "Let the model name new sessions",
        labelKey: "settings.field.sessionTitleGeneration",
        descriptionKey: "settings.field.sessionTitleGenerationDesc",
        path: "app.ai_experience.enable_session_title_generation",
        kind: "boolean",
        optional: true,
        keywords: ["title", "name"],
      },
      {
        id: "prompt-suggestion",
        label: "Suggest the next message",
        labelKey: "settings.field.promptSuggestion",
        descriptionKey: "settings.field.promptSuggestionDesc",
        path: "app.ai_experience.enable_prompt_suggestion",
        kind: "boolean",
        optional: true,
        keywords: ["suggestion", "next input"],
      },
    ],
  },
  {
    id: "editor",
    title: "Appearance",
    titleKey: "settings.editor.appearance",
    page: "editor",
    fields: [
      {
        id: "editor-font-size",
        label: "Font size",
        labelKey: "settings.field.editorFontSize",
        descriptionKey: "settings.field.editorFontSizeDesc",
        path: "editor.font_size",
        kind: "number",
        min: 10,
        max: 32,
        optional: true,
        unit: "px",
        unitKey: "settings.unit.px",
      },
      {
        id: "editor-line-height",
        label: "Line height",
        labelKey: "settings.editor.lineHeight",
        descriptionKey: "settings.editor.lineHeightDesc",
        path: "editor.line_height",
        kind: "number",
        min: 1,
        max: 3,
        precision: 1,
        optional: true,
        unit: "em",
      },
    ],
  },
  {
    id: "editor-behavior",
    title: "Editing behavior",
    titleKey: "settings.editor.behavior",
    page: "editor",
    fields: [
      {
        id: "editor-tab-size",
        label: "Tab size",
        labelKey: "settings.field.editorTabSize",
        descriptionKey: "settings.field.editorTabSizeDesc",
        path: "editor.tab_size",
        kind: "number",
        min: 1,
        max: 8,
        optional: true,
        unit: "spaces",
        unitKey: "settings.unit.spaces",
        keywords: ["indent"],
      },
      {
        id: "editor-insert-spaces",
        label: "Insert spaces",
        labelKey: "settings.field.editorInsertSpaces",
        descriptionKey: "settings.field.editorInsertSpacesDesc",
        path: "editor.insert_spaces",
        kind: "boolean",
        optional: true,
      },
      {
        id: "editor-detect-indentation",
        label: "Detect indentation",
        labelKey: "settings.field.editorDetectIndentation",
        descriptionKey: "settings.field.editorDetectIndentationDesc",
        path: "editor.detect_indentation",
        kind: "boolean",
        optional: true,
      },
      {
        id: "editor-word-wrap",
        label: "Word wrap",
        labelKey: "settings.field.editorWordWrap",
        descriptionKey: "settings.field.editorWordWrapDesc",
        path: "editor.word_wrap",
        kind: "select",
        optional: true,
        options: [
          { value: "off", label: "Off", labelKey: "settings.opt.off" },
          { value: "on", label: "On", labelKey: "settings.opt.on" },
          { value: "wordWrapColumn", label: "At column", labelKey: "settings.editor.wrapColumn", disabledReason: "settings.editor.wrapFallback" },
          { value: "bounded", label: "Bounded", labelKey: "settings.opt.bounded", disabledReason: "settings.editor.wrapFallback" },
        ],
      },
      {
        id: "editor-scroll-beyond-last-line",
        label: "Scroll beyond last line",
        labelKey: "settings.editor.scrollBeyondLastLine",
        descriptionKey: "settings.editor.scrollBeyondLastLineDesc",
        path: "editor.scroll_beyond_last_line",
        kind: "boolean",
        optional: true,
      },
    ],
  },
  {
    id: "editor-display",
    title: "Display settings",
    titleKey: "settings.editor.display",
    page: "editor",
    fields: [
      {
        id: "editor-line-numbers",
        label: "Line numbers",
        labelKey: "settings.field.editorLineNumbers",
        descriptionKey: "settings.field.editorLineNumbersDesc",
        path: "editor.line_numbers",
        kind: "select",
        optional: true,
        options: [
          { value: "on", label: "On", labelKey: "settings.opt.on" },
          { value: "off", label: "Off", labelKey: "settings.opt.off" },
          { value: "relative", label: "Relative", labelKey: "settings.opt.relative", disabledReason: "settings.editor.lineNumbersFallback" },
          { value: "interval", label: "Interval", labelKey: "settings.editor.interval", disabledReason: "settings.editor.lineNumbersFallback" },
        ],
      },
      {
        id: "editor-active-line",
        label: "Active line highlight",
        labelKey: "settings.editor.activeLine",
        descriptionKey: "settings.editor.activeLineDesc",
        path: "editor.render_line_highlight",
        kind: "select",
        optional: true,
        options: [
          { value: "none", label: "Off", labelKey: "settings.opt.off" },
          { value: "line", label: "Line", labelKey: "settings.opt.line" },
          { value: "gutter", label: "Gutter", labelKey: "settings.editor.gutter", disabledReason: "settings.editor.nativeUnavailable" },
          { value: "all", label: "Line and gutter", labelKey: "settings.editor.lineAndGutter", disabledReason: "settings.editor.nativeUnavailable" },
        ],
      },
      {
        id: "editor-whitespace",
        label: "Render whitespace",
        labelKey: "settings.editor.renderWhitespace",
        descriptionKey: "settings.editor.renderWhitespaceDesc",
        path: "editor.render_whitespace",
        kind: "select",
        optional: true,
        options: [
          { value: "none", label: "Off", labelKey: "settings.opt.off" },
          { value: "all", label: "All", labelKey: "settings.editor.allWhitespace" },
          { value: "boundary", label: "Boundary", labelKey: "settings.editor.boundaryWhitespace", disabledReason: "settings.editor.nativeUnavailable" },
          { value: "selection", label: "Selection", labelKey: "settings.editor.selectedWhitespace", disabledReason: "settings.editor.nativeUnavailable" },
          { value: "trailing", label: "Trailing", labelKey: "settings.editor.trailingWhitespace", disabledReason: "settings.editor.nativeUnavailable" },
        ],
      },
    ],
  },
  {
    id: "terminal",
    title: "Terminal",
    titleKey: "settings.section.terminal",
    page: "terminal",
    fields: [
      {
        id: "terminal-font-size",
        label: "Font size",
        labelKey: "settings.field.terminalFontSize",
        descriptionKey: "settings.field.terminalFontSizeDesc",
        path: "terminal.font_size",
        kind: "number",
        min: 10,
        max: 24,
        optional: true,
        placeholder: "14 (10–24)",
        placeholderKey: "settings.placeholder.terminalFontSize",
        unit: "px",
        unitKey: "settings.unit.px",
      },
      {
        id: "terminal-scrollback",
        label: "Scrollback (lines)",
        labelKey: "settings.field.terminalScrollback",
        descriptionKey: "settings.field.terminalScrollbackDesc",
        path: "terminal.scrollback",
        kind: "number",
        min: 100,
        max: 100000,
        optional: true,
        placeholder: "1000 (100–100000)",
        placeholderKey: "settings.placeholder.terminalScrollback",
        unit: "lines",
        unitKey: "settings.unit.lines",
      },
      {
        id: "terminal-cursor-style",
        label: "Cursor",
        labelKey: "settings.field.terminalCursorStyle",
        descriptionKey: "settings.field.terminalCursorStyleDesc",
        path: "terminal.cursor_style",
        kind: "select",
        optional: true,
        // xterm's cursor styles; `line` is not one of them.
        options: [
          { value: "block", label: "Block", labelKey: "settings.opt.block" },
          { value: "underline", label: "Underline", labelKey: "settings.opt.underline" },
          { value: "bar", label: "Bar", labelKey: "settings.opt.bar" },
        ],
      },
    ],
  },
  {
    id: "workspace",
    title: "Worktrees",
    titleKey: "settings.section.workspace",
    page: "workspace",
    fields: [
      // `app.worktrees` is stored in camelCase by the worktree service, and the
      // Product Operation Registry names these same keys.
      {
        id: "worktree-root",
        label: "Worktree folder",
        labelKey: "settings.field.worktreeRoot",
        descriptionKey: "settings.field.worktreeRootDesc",
        path: "app.worktrees.rootPath",
        kind: "text",
        optional: true,
        placeholder: "~/.openbitfun/worktrees",
        placeholderKey: "settings.placeholder.worktreeRoot",
        keywords: ["worktree", "isolation"],
      },
      {
        id: "worktree-branch-prefix",
        label: "Worktree branch prefix",
        labelKey: "settings.field.worktreeBranchPrefix",
        descriptionKey: "settings.field.worktreeBranchPrefixDesc",
        path: "app.worktrees.branchPrefix",
        kind: "text",
        optional: true,
        placeholder: "openbitfun/",
        placeholderKey: "settings.placeholder.worktreeBranchPrefix",
        keywords: ["branch"],
      },
      {
        id: "worktree-copy-changes",
        label: "Copy local changes into a new worktree",
        labelKey: "settings.field.worktreeCopyChanges",
        descriptionKey: "settings.field.worktreeCopyChangesDesc",
        path: "app.worktrees.copyLocalChanges",
        kind: "boolean",
        optional: true,
      },
      {
        id: "worktree-auto-delete",
        label: "Delete old worktrees automatically",
        labelKey: "settings.field.worktreeAutoDelete",
        descriptionKey: "settings.field.worktreeAutoDeleteDesc",
        path: "app.worktrees.autoDeleteEnabled",
        kind: "boolean",
        optional: true,
      },
      {
        id: "worktree-auto-delete-limit",
        label: "Worktrees to keep",
        labelKey: "settings.field.worktreeAutoDeleteLimit",
        descriptionKey: "settings.field.worktreeAutoDeleteLimitDesc",
        path: "app.worktrees.autoDeleteLimit",
        kind: "number",
        optional: true,
        unit: "items",
        unitKey: "settings.unit.count",
      },
    ],
  },
  {
    id: "workspace-search",
    title: "Workspace search",
    titleKey: "settings.section.workspaceSearch",
    page: "workspace",
    fields: [
      {
        id: "workspace-search",
        label: "Accelerated workspace search",
        labelKey: "settings.field.workspaceSearch",
        descriptionKey: "settings.field.workspaceSearchDesc",
        path: "app.ai_experience.enable_workspace_search",
        kind: "boolean",
        optional: true,
        keywords: ["search", "index", "files"],
      },
    ],
  },
  {
    id: "git",
    title: "Git",
    titleKey: "settings.section.git",
    page: "workspace",
    fields: [
      {
        id: "commit-coauthor",
        label: "Attribute commits to OpenBitFun",
        labelKey: "settings.field.commitCoauthor",
        path: "app.ai_experience.enable_git_commit_coauthor",
        kind: "boolean",
        optional: true,
        hint: "Adds the co-author trailer the desktop uses to generated commit messages",
        hintKey: "settings.field.commitCoauthorHint",
        keywords: ["git", "commit", "co-author"],
      },
    ],
  },
  {
    id: "ai-execution",
    title: "Tool schema loading",
    titleKey: "settings.execution.schemaLoading",
    page: "execution",
    fields: [
      {
        id: "deferred-tool-loading",
        label: "Load tool schemas on demand",
        labelKey: "settings.field.deferredToolLoading",
        descriptionKey: "settings.field.deferredToolLoadingDesc",
        path: "ai.enable_deferred_tool_loading",
        kind: "boolean",
        optional: true,
      },
    ],
  },
  {
    id: "tool-presentation",
    title: "Tool calls",
    titleKey: "settings.execution.toolCalls",
    page: "execution",
    fields: [
      {
        id: "tool-presentation-mode",
        label: "Tool presentation",
        labelKey: "settings.field.toolPresentationMode",
        path: "ai.tool_presentation_mode",
        kind: "select",
        options: [
          { value: "native", label: "Native calls", labelKey: "settings.opt.nativeCalls" },
          { value: "ptc", label: "Program (TypeScript)", labelKey: "settings.opt.ptcTs" },
          { value: "ptc_python", label: "Program (Python)", labelKey: "settings.opt.ptcPy" },
        ],
        hint: "A session keeps the mode it was created with",
        hintKey: "settings.field.toolPresentationModeHint",
        optional: true,
      },
    ],
  },
  {
    id: "tool-execution",
    title: "Tool execution",
    titleKey: "settings.execution.toolExecution",
    page: "execution",
    fields: [
      {
        // `Option<u64>` on the host: `None` (the default) waits indefinitely.
        id: "tool-execution-timeout",
        label: "Tool timeout (s)",
        labelKey: "settings.field.toolExecutionTimeout",
        descriptionKey: "settings.field.toolExecutionTimeoutDesc",
        path: "ai.tool_execution_timeout_secs",
        kind: "number",
        optional: true,
        clearable: true,
        defaultValue: undefined,
        unit: "s",
        unitKey: "settings.unit.seconds",
      },
      {
        // `Option<u32>`: null or zero waits indefinitely; 180 by default.
        id: "user-question-timeout",
        label: "Waiting for an answer (s)",
        labelKey: "settings.field.userQuestionTimeout",
        descriptionKey: "settings.field.userQuestionTimeoutDesc",
        path: "ai.user_question_timeout_secs",
        kind: "number",
        min: 10,
        max: 3600,
        optional: true,
        clearable: true,
        placeholder: "180 (10–3600)",
        placeholderKey: "settings.placeholder.userQuestionTimeout",
        unit: "s",
        unitKey: "settings.unit.seconds",
      },
    ],
  },
  {
    id: "subagent-execution",
    title: "Subagents",
    titleKey: "settings.execution.subagents",
    page: "execution",
    fields: [
      {
        id: "subagent-default-model",
        label: "Default subagent model",
        labelKey: "settings.execution.defaultModel",
        descriptionKey: "settings.execution.defaultModelDesc",
        kind: "model-target",
        path: "ai.agent_model_selections.subagents.default",
        legacyPath: "ai.agent_model_defaults.subagents.default",
        optional: true,
      },
      {
        id: "subagent-fork-model",
        label: "Default model for forked subagents",
        labelKey: "settings.execution.forkModel",
        descriptionKey: "settings.execution.forkModelDesc",
        kind: "model-target",
        path: "ai.agent_model_selections.subagents.fork",
        legacyPath: "ai.agent_model_defaults.subagents.fork",
        optional: true,
      },
      {
        id: "subagent-model-override",
        label: "Allow subagents to choose a different model",
        labelKey: "settings.execution.modelOverride",
        descriptionKey: "settings.execution.modelOverrideDesc",
        path: "ai.allow_subagent_model_override",
        kind: "boolean",
        optional: true,
        capability: "subagent_model_override_policy_v1",
      },
      {
        id: "subagent-batch-policy",
        label: "Subagent batch",
        labelKey: "settings.field.subagentBatchPolicy",
        descriptionKey: "settings.field.subagentBatchPolicyDesc",
        path: "ai.subagent_batch_execution_policy",
        kind: "select",
        options: [
          { value: "force_parallel", label: "Force parallel", labelKey: "settings.opt.forceParallel" },
          { value: "safe_only", label: "Only when read-only", labelKey: "settings.opt.safeOnly" },
          { value: "serial", label: "Serial", labelKey: "settings.opt.serial" },
        ],
        optional: true,
      },
      {
        id: "subagent-concurrency",
        label: "Parallel subagents",
        labelKey: "settings.field.subagentConcurrency",
        descriptionKey: "settings.field.subagentConcurrencyDesc",
        path: "ai.subagent_max_concurrency",
        kind: "number",
        optional: true,
        unit: "max",
        unitKey: "settings.unit.concurrent",
      },
      {
        id: "swarm-concurrency",
        label: "Parallel swarm members",
        labelKey: "settings.field.swarmConcurrency",
        descriptionKey: "settings.field.swarmConcurrencyDesc",
        path: "ai.swarm_max_concurrency",
        kind: "number",
        optional: true,
        unit: "max",
        unitKey: "settings.unit.concurrent",
      },
    ],
  },
  {
    id: "tool-json-repair",
    title: "Tool arguments",
    titleKey: "settings.execution.toolArguments",
    page: "execution",
    fields: [
      {
        id: "tool-json-repair",
        label: "Repair malformed JSON arguments",
        labelKey: "settings.execution.toolJsonRepair",
        descriptionKey: "settings.execution.toolJsonRepairDesc",
        path: "ai.allow_tool_json_repair",
        kind: "boolean",
        optional: true,
      },
    ],
  },
  {
    id: "network",
    title: "Network",
    titleKey: "settings.section.network",
    page: "models",
    fields: [
      {
        id: "proxy-enabled",
        label: "Use a proxy for model requests",
        labelKey: "settings.field.proxyEnabled",
        descriptionKey: "settings.field.proxyEnabledDesc",
        path: "ai.proxy.enabled",
        kind: "boolean",
        optional: true,
        keywords: ["proxy", "network"],
      },
      {
        id: "proxy-url",
        label: "Proxy address",
        labelKey: "settings.field.proxyUrl",
        path: "ai.proxy.url",
        kind: "text",
        optional: true,
        placeholder: "http://127.0.0.1:7890",
        keywords: ["proxy"],
      },
      {
        id: "proxy-username",
        label: "Proxy user name",
        labelKey: "settings.field.proxyUsername",
        path: "ai.proxy.username",
        kind: "text",
        optional: true,
        defaultValue: "",
        placeholderKey: "settings.placeholder.optional",
      },
      {
        id: "proxy-password",
        label: "Proxy password",
        labelKey: "settings.field.proxyPassword",
        path: "ai.proxy.password",
        kind: "text",
        masked: true,
        optional: true,
        defaultValue: "",
        placeholderKey: "settings.placeholder.optional",
      },
      {
        // `Option<u64>`, 600 by default; empty waits indefinitely.
        id: "stream-idle-timeout",
        label: "Stream idle timeout (s)",
        labelKey: "settings.field.streamIdleTimeout",
        descriptionKey: "settings.field.streamIdleTimeoutDesc",
        path: "ai.stream_idle_timeout_secs",
        kind: "number",
        optional: true,
        clearable: true,
        unit: "s",
        unitKey: "settings.unit.seconds",
        keywords: ["timeout", "stream"],
      },
      {
        id: "stream-ttft-timeout",
        label: "First token timeout (s)",
        labelKey: "settings.field.streamTtftTimeout",
        descriptionKey: "settings.field.streamTtftTimeoutDesc",
        path: "ai.stream_ttft_timeout_secs",
        kind: "number",
        optional: true,
        clearable: true,
        unit: "s",
        unitKey: "settings.unit.seconds",
        keywords: ["timeout", "first token"],
      },
    ],
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    titleKey: "settings.section.diagnostics",
    page: "diagnostics",
    fields: [
      {
        id: "logging-level",
        label: "Log level",
        labelKey: "settings.field.loggingLevel",
        descriptionKey: "settings.field.loggingLevelDesc",
        path: "app.logging.level",
        kind: "select",
        options: [
          { value: "trace", label: "Trace", labelKey: "settings.opt.trace" },
          { value: "debug", label: "Debug", labelKey: "settings.opt.debug" },
          { value: "info", label: "Info", labelKey: "settings.opt.info" },
          { value: "warn", label: "Warn", labelKey: "settings.opt.warn" },
          { value: "error", label: "Error", labelKey: "settings.opt.error" },
        ],
        keywords: ["log"],
      },
      {
        id: "logging-sensitive",
        label: "Include sensitive payloads in diagnostics",
        labelKey: "settings.field.loggingSensitive",
        descriptionKey: "settings.field.loggingSensitiveDesc",
        path: "app.logging.include_sensitive_diagnostics",
        kind: "boolean",
        optional: true,
      },
    ],
  },
  {
    id: "memory",
    title: "Memory",
    titleKey: "settings.section.memory",
    page: "session-memory",
    fields: [
      {
        id: "memory-btw-sessions",
        label: "Learn from background sessions",
        labelKey: "settings.field.memoryBtwSessions",
        descriptionKey: "settings.field.memoryBtwSessionsDesc",
        path: "memories.generate_for_btw_sessions",
        kind: "boolean",
        optional: true,
      },
      {
        id: "memory-external-context",
        label: "Sessions that used external context",
        labelKey: "settings.field.memoryExternalContext",
        descriptionKey: "settings.field.memoryExternalContextDesc",
        path: "memories.external_context_policy",
        kind: "select",
        options: [
          { value: "clear_tool_results", label: "Clear external tool output", labelKey: "settings.opt.clearToolResults" },
          { value: "allow", label: "Keep as-is", labelKey: "settings.opt.keepAsIs" },
          { value: "skip_session", label: "Skip extracting", labelKey: "settings.opt.skipExtracting" },
        ],
        optional: true,
      },
      {
        id: "memory-extract-model",
        label: "Model that extracts memories",
        labelKey: "settings.field.memoryExtractModel",
        descriptionKey: "settings.field.memoryExtractModelDesc",
        path: "memories.extract_model",
        kind: "model",
        emptyLabel: "Follow the primary model",
        emptyLabelKey: "settings.field.memoryExtractModelEmpty",
        optional: true,
        defaultValue: "",
      },
      {
        id: "memory-consolidation-model",
        label: "Model that consolidates memories",
        labelKey: "settings.field.memoryConsolidationModel",
        descriptionKey: "settings.field.memoryConsolidationModelDesc",
        path: "memories.consolidation_model",
        kind: "model",
        emptyLabel: "Follow the extraction model",
        emptyLabelKey: "settings.field.memoryConsolidationModelEmpty",
        optional: true,
        defaultValue: "",
      },
    ],
  },
  {
    id: "memory-processing",
    title: "Memory processing",
    titleKey: "settings.section.memoryProcessing",
    page: "session-memory",
    fields: [
      {
        id: "memory-idle-hours",
        label: "A session must be idle for (hours)",
        labelKey: "settings.field.memoryIdleHours",
        descriptionKey: "settings.field.memoryIdleHoursDesc",
        path: "memories.min_rollout_idle_hours",
        kind: "number",
        min: 1,
        max: 48,
        placeholder: "6 (1–48)",
        placeholderKey: "settings.placeholder.memoryIdleHours",
        unit: "h",
        unitKey: "settings.unit.hours",
        optional: true,
      },
      {
        id: "memory-rollout-age-days",
        label: "Extract from sessions no older than (days)",
        labelKey: "settings.field.memoryRolloutAgeDays",
        descriptionKey: "settings.field.memoryRolloutAgeDaysDesc",
        path: "memories.max_rollout_age_days",
        kind: "number",
        min: 0,
        max: 3650,
        // The host refuses a window longer than the retention it extracts into.
        placeholder: "10 (0–3650)",
        placeholderKey: "settings.placeholder.memoryRolloutAgeDays",
        unit: "days",
        unitKey: "settings.unit.days",
        optional: true,
      },
      {
        id: "memory-rollouts-per-startup",
        label: "Sessions extracted per startup",
        labelKey: "settings.field.memoryRolloutsPerStartup",
        descriptionKey: "settings.field.memoryRolloutsPerStartupDesc",
        path: "memories.max_rollouts_per_startup",
        kind: "number",
        min: 1,
        max: 128,
        placeholder: "2 (1–128)",
        placeholderKey: "settings.placeholder.memoryRolloutsPerStartup",
        unit: "sessions",
        unitKey: "settings.unit.sessions",
        optional: true,
      },
      {
        id: "memory-rollouts-scan-limit",
        label: "Sessions scanned per startup",
        labelKey: "settings.field.memoryRolloutsScanLimit",
        descriptionKey: "settings.field.memoryRolloutsScanLimitDesc",
        path: "memories.max_rollouts_scan_limit",
        kind: "number",
        min: 1,
        max: 50000,
        placeholder: "2000 (1–50000)",
        placeholderKey: "settings.placeholder.memoryRolloutsScanLimit",
        unit: "sessions",
        unitKey: "settings.unit.sessions",
        optional: true,
      },
      {
        id: "memory-phase1-concurrency",
        label: "Extraction concurrency",
        labelKey: "settings.field.memoryPhase1Concurrency",
        descriptionKey: "settings.field.memoryPhase1ConcurrencyDesc",
        path: "memories.phase1_max_concurrency",
        kind: "number",
        min: 1,
        max: 16,
        placeholder: "1 (1–16)",
        placeholderKey: "settings.placeholder.memoryPhase1Concurrency",
        unit: "max",
        unitKey: "settings.unit.concurrent",
        optional: true,
      },
      {
        id: "memory-consolidation-batch",
        label: "Memories per consolidation",
        labelKey: "settings.field.memoryConsolidationBatch",
        descriptionKey: "settings.field.memoryConsolidationBatchDesc",
        path: "memories.max_raw_memories_for_consolidation",
        kind: "number",
        min: 1,
        max: 512,
        optional: true,
        placeholder: "64 (1–512)",
        placeholderKey: "settings.placeholder.memoryConsolidationBatch",
        unit: "items",
        unitKey: "settings.unit.memories",
      },
      {
        id: "memory-max-unused-days",
        label: "Forget after (days)",
        labelKey: "settings.field.memoryMaxUnusedDays",
        descriptionKey: "settings.field.memoryMaxUnusedDaysDesc",
        path: "memories.max_unused_days",
        kind: "number",
        min: 1,
        max: 3650,
        optional: true,
        placeholder: "30 (1–3650)",
        placeholderKey: "settings.placeholder.memoryMaxUnusedDays",
        unit: "days",
        unitKey: "settings.unit.days",
      },
    ],
  },
  {
    id: "tools",
    title: "Desktop control",
    titleKey: "settings.page.desktopControl",
    page: "desktop-control",
    fields: [
      {
        id: "computer-use",
        label: "Allow computer use",
        labelKey: "settings.field.computerUse",
        path: "ai.computer_use_enabled",
        kind: "boolean",
        hint: "The host still asks for its own system consent",
        hintKey: "settings.field.computerUseHint",
        optional: true,
        keywords: ["computer use", "desktop"],
      },
      {
        id: "browser-control-auto-connect",
        label: "Reattach the browser at launch",
        labelKey: "settings.field.browserControlAutoConnect",
        path: "ai.browser_control_auto_connect_on_startup",
        kind: "boolean",
        hint: "The browser forgets its approval when it restarts",
        hintKey: "settings.field.browserControlAutoConnectHint",
        optional: true,
        keywords: ["browser"],
      },
      {
        // The choices are the browsers the host reports (`browser_control_list_browsers`).
        id: "preferred-browser",
        label: "Preferred browser",
        labelKey: "settings.field.preferredBrowser",
        path: "ai.browser_control_preferred_browser",
        kind: "select",
        defaultValue: "default",
        emptyMeans: "default",
        dynamicOptions: () => browserOptions(),
        hint: "The browser agents open and drive",
        hintKey: "settings.field.preferredBrowserPick",
        optional: true,
        keywords: ["browser", "chrome"],
      },
    ],
  },
  {
    id: "agent-hooks",
    title: "Agent hooks",
    titleKey: "settings.section.agentHooks",
    page: "automation",
    fields: [
      {
        id: "hooks-enabled",
        label: "Run native agent hooks",
        labelKey: "settings.field.hooksEnabled",
        descriptionKey: "settings.field.hooksEnabledDesc",
        path: "app.hooks.enabled",
        kind: "boolean",
        optional: true,
        keywords: ["hooks"],
      },
      {
        id: "hooks-project",
        label: "Honor project hook files",
        labelKey: "settings.field.hooksProject",
        path: "app.hooks.project_hooks_enabled",
        kind: "boolean",
        hint: "A project hook file runs commands from the checked-out repository",
        hintKey: "settings.field.hooksProjectHint",
        optional: true,
      },
    ],
  },
];

/** The leaf config path a field reads and writes. */
export function leafPath(spec: Pick<FieldSpec, "path" | "field">): string {
  return spec.field ? `${spec.path}.${spec.field}` : spec.path;
}

/** The section that owns a field, by id. */
export function sectionOfField(spec: FieldSpec): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find(section => section.fields.some(field => field.id === spec.id));
}

/** Reactive localized title for a settings section. */
export function sectionTitle(section: SettingsSection): string {
  return section.titleKey ? tr(section.titleKey) : section.title;
}

/** Reactive localized label for a settings field. */
export function fieldLabel(spec: FieldSpec): string {
  return spec.labelKey ? tr(spec.labelKey) : spec.label;
}

/** Reactive localized hint/description for a settings field. */
export function fieldHint(spec: FieldSpec): string | undefined {
  if (spec.hintKey) return tr(spec.hintKey);
  if (spec.descriptionKey) return tr(spec.descriptionKey);
  return spec.hint;
}

/** Reactive localized empty-choice label for a `model` settings field. */
export function fieldEmptyLabel(spec: FieldSpec): string | undefined {
  if (spec.emptyLabelKey) return tr(spec.emptyLabelKey);
  return spec.emptyLabel;
}

/** Reactive localized label for a select option. */
export function optionLabel(option: FieldOption): string {
  return option.labelKey ? tr(option.labelKey) : option.label;
}

/** Reactive localized domain-specific placeholder for a `text` or `number` field. */
export function fieldPlaceholder(spec: FieldSpec): string {
  if (spec.placeholderKey) return tr(spec.placeholderKey);
  if (spec.placeholder) return spec.placeholder;
  const fallback = defaultForField(spec);
  if (fallback !== undefined && fallback !== "") {
    return String(fallback);
  }
  return tr("settings.field.newValuePlaceholder");
}

/** Reactive localized unit suffix for a numeric field, when applicable. */
export function fieldUnit(spec: FieldSpec): string | undefined {
  if (spec.unitKey) return tr(spec.unitKey);
  return spec.unit;
}

/** Values by config path; `undefined` means the host does not have that path. */
export const settingsValues = signal<Record<string, unknown>>({});
const settingsValuesDevice = signal<string | null>(null);
export const settingsLoaded = signal(false);
/** A page-level message (the interface language); field notices go to their section. */
export const settingsNotice = signal("");
/** The latest outcome of a write, by the id of the section that owns the field. */
export const sectionNotices = signal<Record<string, string>>({});
/** Fields with a write in flight, by field id, so the row can show it is saving. */
export const savingFields = signal<Record<string, boolean>>({});

export function sectionNotice(sectionId: string): string {
  return sectionNotices()[sectionId] ?? "";
}

export function setSectionNotice(sectionId: string, message: string): void {
  sectionNotices.update(current => ({ ...current, [sectionId]: message }));
}

export function fieldSaving(spec: FieldSpec): boolean {
  return savingFields()[spec.id] === true;
}

/**
 * Fields whose write just landed, by field id, for a moment: the row shows a
 * quiet check in a slot it always reserves, instead of a banner that pushes the
 * page while the user is still editing. The control itself shows the value.
 */
export const savedFields = signal<Record<string, boolean>>({});
const savedFieldTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function fieldJustSaved(id: string): boolean {
  return savedFields()[id] === true;
}

export function flashFieldSaved(id: string): void {
  const previous = savedFieldTimers.get(id);
  if (previous !== undefined) clearTimeout(previous);
  savedFields.update(current => ({ ...current, [id]: true }));
  savedFieldTimers.set(
    id,
    setTimeout(() => {
      savedFieldTimers.delete(id);
      savedFields.update(current => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }, 1600),
  );
}

function noticeFor(spec: FieldSpec, message: string): void {
  const section = sectionOfField(spec);
  if (section) setSectionNotice(section.id, message);
  else settingsNotice.set(message);
}

/** The current value of a field, or `undefined` when the host lacks it. */
export function fieldValue(spec: FieldSpec): unknown {
  return settingsValues()[leafPath(spec)];
}

export function settingsValuesCurrent(): boolean {
  return settingsValuesDevice() === currentDeviceScopeKey();
}

export function supportsExecutionCapability(capability: ExecutionCapability): boolean {
  const device = fleetDeviceContext();
  return isDeviceOnThisMachine() || (device !== null && fleetDeviceById(device)?.hostCapabilities.includes(capability) === true);
}

function modelTargetPath(spec: FieldSpec): string {
  return spec.legacyPath && !supportsExecutionCapability("model_routing_v1") ? spec.legacyPath : leafPath(spec);
}

function readModelTarget(value: unknown, legacy: boolean): AgentModelTarget | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.kind === "inherit") return { kind: "inherit" };
  if (legacy && row.kind === "fixed" && typeof row.model_id === "string" && row.model_id.trim()) {
    return { kind: "model", model_ref: row.model_id };
  }
  if (!legacy && row.kind === "model" && typeof row.model_ref === "string" && row.model_ref.trim()) {
    return { kind: "model", model_ref: row.model_ref };
  }
  if (!legacy && row.kind === "pool" && typeof row.pool_id === "string" && row.pool_id.trim()) {
    return { kind: "pool", pool_id: row.pool_id };
  }
  return null;
}

export function modelTargetForField(spec: FieldSpec): AgentModelTarget | null {
  if (!settingsValuesCurrent()) return null;
  const path = modelTargetPath(spec);
  return readModelTarget(settingsValues()[path], path === spec.legacyPath);
}

/** Whether the host stores no value for this field at all. */
export function fieldMissing(spec: FieldSpec): boolean {
  return fieldValue(spec) === undefined;
}

/** What the row shows: the stored value, or the default the host applies instead. */
export function fieldDisplay(spec: FieldSpec): unknown {
  const stored = fieldValue(spec);
  const displayed = stored === undefined ? defaultForField(spec) : stored;
  if (!spec.linkedBooleanPath) return displayed;
  const linked = fieldDisplay({ ...spec, path: spec.linkedBooleanPath, linkedBooleanPath: undefined });
  return displayed === true && linked === true;
}

let unsavedLanguage: AppLocale | null = null;

export async function writeAppLanguage(locale: string): Promise<void> {
  const canonical = normalizeLocale(locale);
  if (!canonical || appLocaleSaving() || (canonical === currentLocale() && canonical !== unsavedLanguage)) return;
  const connection = backendConnection();
  settingsNotice.set("");
  await runStep(async () => {
    const persisted = await setAppLocale(canonical, { persistHost: true });
    if (backendConnection() !== connection || currentLocale() !== canonical) return;
    unsavedLanguage = persisted ? null : canonical;
    settingsNotice.set(
      persisted
        ? tr("settings.notice.languageSaved", { label: localeMeta(canonical).nativeName })
        : tr("settings.notice.languageNotPersisted"),
    );
  });
}

function readNestedPath(rootDoc: unknown, segments: readonly string[]): unknown {
  let node: unknown = rootDoc;
  for (const segment of segments) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Deduplicates concurrent `loadSettingsValues` calls targeting the same device. */
const settingsLoadInFlight = new Map<string, Promise<void>>();

export function loadSettingsValues(): Promise<void> {
  const deviceKey = currentDeviceScopeKey();
  const existing = settingsLoadInFlight.get(deviceKey);
  if (existing) return existing;

  const flight = runLoadSettingsValues(deviceKey).finally(() => {
    if (settingsLoadInFlight.get(deviceKey) === flight) {
      settingsLoadInFlight.delete(deviceKey);
    }
  });
  settingsLoadInFlight.set(deviceKey, flight);
  return flight;
}

async function runLoadSettingsValues(deviceKey: string): Promise<void> {
  // Collect all leaf paths and their top-level parent sections (`app`, `ai`,
  // `memories`, `editor`, `terminal`, `superagent`). Reading the 6 parent
  // documents once resolves all nested leaves on real hosts (instead of 63
  // individual `get_config` RPCs); only leaves absent from a parent document
  // fall back to a leaf read (e.g. flat mock fixtures or sparse legacy configs).
  const leafPaths = new Set<string>(MEMORY_ENABLE_PATHS);
  const optional = new Set<string>(MEMORY_ENABLE_PATHS);
  const rootSections = new Set<string>(["app"]);
  for (const section of SETTINGS_SECTIONS) {
    for (const field of section.fields) {
      const path = leafPath(field);
      leafPaths.add(path);
      if (field.optional) optional.add(path);
      if (field.linkedBooleanPath) {
        leafPaths.add(field.linkedBooleanPath);
        if (field.optional) optional.add(field.linkedBooleanPath);
      }
      if (field.legacyPath) {
        leafPaths.add(field.legacyPath);
        optional.add(field.legacyPath);
      }
      const root = path.split(".")[0];
      if (root) rootSections.add(root);
    }
  }
  await runStep(async () => {
    const entries: Record<string, unknown> = {};
    const rootDocs: Record<string, unknown> = {};
    await Promise.all(
      [...rootSections].map(async root => {
        try {
          rootDocs[root] = await getConfig(root, true);
        } catch {
          rootDocs[root] = undefined;
        }
      }),
    );
    entries["app"] = rootDocs["app"];

    const missingLeaves: string[] = [];
    for (const path of leafPaths) {
      const segments = path.split(".");
      const root = segments[0] ?? "";
      const doc = rootDocs[root];
      if (doc && typeof doc === "object" && !Array.isArray(doc)) {
        const resolved = readNestedPath(doc, segments.slice(1));
        if (resolved !== undefined) {
          entries[path] = resolved;
          continue;
        }
      }
      missingLeaves.push(path);
    }

    if (missingLeaves.length > 0) {
      await Promise.all(
        missingLeaves.map(async path => {
          try {
            entries[path] = await getConfig(path, optional.has(path));
          } catch {
            entries[path] = undefined;
          }
        }),
      );
    }

    // Drop stale results if the user switched device scope while this read was in flight.
    if (currentDeviceScopeKey() !== deviceKey) return;
    batch(() => {
      settingsValues.set(entries);
      settingsValuesDevice.set(deviceKey);
    });
    await loadSettingsDescriptor([...leafPaths], deviceKey);
    if (currentDeviceScopeKey() !== deviceKey) return;
    settingsLoaded.set(true);
  });
}

/** One field as `get_settings_schema` describes it. */
export interface SettingsFieldDescriptor {
  type?: string;
  nullable?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  /** Absent when the config has no value at that path by default. */
  default?: unknown;
  /** Whether the host enforces `type` / `enum` / bounds on write. */
  constrained?: boolean;
}

/** `null` until read; `false` when the host cannot describe its settings. */
export const settingsDescriptor = signal<Record<string, SettingsFieldDescriptor> | false | null>(null);

/** Per-device schema overrides so `SETTINGS_SECTIONS` is never mutated in place. */
const deviceDescriptors = signal<Record<string, Record<string, SettingsFieldDescriptor>>>({});

function descriptorForField(spec: FieldSpec): SettingsFieldDescriptor | undefined {
  const byDevice = deviceDescriptors()[currentDeviceScopeKey()];
  if (byDevice) return byDevice[leafPath(spec)];
  const current = settingsDescriptor();
  return current && typeof current === "object" ? current[leafPath(spec)] : undefined;
}

/**
 * Records host-supplied bounds and defaults per device without mutating the
 * shared `SETTINGS_SECTIONS` table, so switching fleet devices never leaks one
 * device's limits or defaults onto another.
 */
export function applySettingsDescriptor(
  fields: Record<string, SettingsFieldDescriptor>,
  deviceKey: string = currentDeviceScopeKey(),
): void {
  const snapshot: Record<string, SettingsFieldDescriptor> = { ...fields };
  deviceDescriptors.update(current => ({ ...current, [deviceKey]: snapshot }));
  if (deviceKey === currentDeviceScopeKey()) {
    settingsDescriptor.set(snapshot);
  }
}

async function loadSettingsDescriptor(paths: string[], deviceKey: string): Promise<void> {
  try {
    const answer = await invokeSettingsMutation<{ fields?: Record<string, SettingsFieldDescriptor> }>(
      "get_settings_schema",
      { paths },
    );
    if (currentDeviceScopeKey() !== deviceKey) return;
    const fields = answer?.fields && typeof answer.fields === "object" ? answer.fields : {};
    applySettingsDescriptor(fields, deviceKey);
  } catch (error) {
    if (currentDeviceScopeKey() !== deviceKey) return;
    // An older host stores the values but cannot say their limits or defaults;
    // clear any stale descriptor for this device instead of drawing guessed limits.
    deviceDescriptors.update(current => {
      if (!(deviceKey in current)) return current;
      const next = { ...current };
      delete next[deviceKey];
      return next;
    });
    settingsDescriptor.set(false);
    settingsNotice.set(errorText(error));
  }
}

/** The floor a field accepts for the active device (schema override or static spec). */
export function minForField(spec: FieldSpec): number | undefined {
  const described = descriptorForField(spec);
  if (described?.constrained && typeof described.minimum === "number") return described.minimum;
  return spec.min;
}

/** The ceiling a field accepts for the active device (schema override or static spec). */
export function maxForField(spec: FieldSpec): number | undefined {
  const described = descriptorForField(spec);
  if (described?.constrained && typeof described.maximum === "number") return described.maximum;
  return spec.max;
}

/** The fallback default a field uses when unset on the active device. */
export function defaultForField(spec: FieldSpec): string | number | boolean | undefined {
  if (spec.defaultValue !== undefined) return spec.defaultValue;
  const fallback = descriptorForField(spec)?.default;
  if (typeof fallback === "string" || typeof fallback === "number" || typeof fallback === "boolean") {
    return fallback;
  }
  return undefined;
}

/**
 * The host's own refusal of a memory window longer than the retention it runs
 * inside, shown in this surface's language.
 */
function localizedWriteError(error: unknown): string {
  const message = errorText(error);
  if (/rollout age must not exceed/i.test(message)) return tr("settings.notice.memoryWindowRefusal");
  return message;
}

/**
 * Writes one field's leaf path. The row shows that it is saving while the write
 * is in flight, and the outcome goes to the notice of the section that owns it.
 */
export async function writeField(spec: FieldSpec, value: unknown): Promise<boolean> {
  if (leafPath(spec) === "app.language") {
    await writeAppLanguage(String(value ?? ""));
    return true;
  }
  const path = spec.kind === "model-target" ? modelTargetPath(spec) : leafPath(spec);
  let storedValue = value;
  if (spec.kind === "model-target") {
    if (!modelTargetForField(spec)) return false;
    const selection = readModelTarget(value, false);
    if (!selection) return false;
    const legacy = path === spec.legacyPath;
    if (selection.kind === "pool" && (legacy || !supportsExecutionCapability("model_pool_selection_v1"))) return false;
    storedValue = legacy && selection.kind === "model" ? { kind: "fixed", model_id: selection.model_ref } : selection;
  }
  if (spec.capability && (!settingsValuesCurrent() || !supportsExecutionCapability(spec.capability))) return false;
  const device = currentDeviceScopeKey();
  const route = { target: fleetDeviceContext() };
  let ok = false;
  savingFields.update(current => ({ ...current, [spec.id]: true }));
  try {
    await runStep(async () => {
      try {
        if (spec.mutation) {
          // The device applies its own rule and stores the section; the row shows what was asked.
          await invokeSettingsMutation(spec.mutation.command, {
            ...spec.mutation.request,
            [spec.mutation.requestKey]: value,
          }, route);
        } else {
          await setConfig(path, storedValue, route);
        }
        ok = true;
        if (currentDeviceScopeKey() !== device) return;
        settingsValues.update(values => ({ ...values, [path]: storedValue, ...(spec.linkedBooleanPath ? { [spec.linkedBooleanPath]: storedValue } : {}) }));
        if (path === "app.ai_experience.enable_prompt_suggestion" && typeof value === "boolean") {
          setPromptSuggestionsEnabled(value);
        }
        // Success is the control's own value plus a passing check; an earlier failure of
        // this section is answered, so its banner goes.
        noticeFor(spec, "");
        flashFieldSaved(spec.id);
      } catch (error) {
        if (currentDeviceScopeKey() === device) noticeFor(spec, localizedWriteError(error));
      }
    });
  } finally {
    savingFields.update(current => {
      const next = { ...current };
      delete next[spec.id];
      return next;
    });
  }
  return ok;
}

/**
 * The general application options the desktop sets through product control
 * (`setting.application.general`): launch at login, keep awake and automatic
 * updates. They apply on the host at once (a login item, a power assertion, the
 * updater), which a bare config write does not, so the General page uses the
 * same command the desktop's page does.
 */
export type GeneralControlOption = "launch-at-login" | "prevent-sleep" | "auto-update";

/** `null` until asked; `false` when the host has no product control for this. */
export const generalControlValues = signal<Record<string, unknown> | false | null>(null);
export const generalControlSaving = signal<GeneralControlOption | null>(null);
let generalControlLoading = false;

export function generalControlValue(option: GeneralControlOption): boolean | undefined {
  const values = generalControlValues();
  if (!values) return undefined;
  const value = values[option];
  return typeof value === "boolean" ? value : undefined;
}

export async function loadGeneralControl(force = false): Promise<void> {
  if (generalControlLoading || (!force && generalControlValues() !== null)) return;
  generalControlLoading = true;
  try {
    const result = await invokeCommand<{ currentOptionValues?: Record<string, unknown> }>("product_control_invoke", {
      action: "get",
      capabilityId: "setting.application.general",
    });
    const values = result?.currentOptionValues;
    generalControlValues.set(values && typeof values === "object" ? values : false);
  } catch {
    // An older host, a peer without the command, or the dev fixtures: the page
    // falls back to the config leaves and says what it cannot set.
    generalControlValues.set(false);
  } finally {
    generalControlLoading = false;
  }
}

export async function setGeneralControl(option: GeneralControlOption, value: boolean): Promise<void> {
  generalControlSaving.set(option);
  try {
    await invokeCommand("product_control_invoke", {
      action: "configure",
      capabilityId: "setting.application.general",
      optionId: option,
      value,
    });
    generalControlValues.update(current => (current ? { ...current, [option]: value } : current));
    setSectionNotice("general", "");
    flashFieldSaved(option);
  } catch (error) {
    setSectionNotice("general", error instanceof Error ? error.message : String(error));
  } finally {
    generalControlSaving.set(null);
  }
}

const memoryFields = SETTINGS_SECTIONS
  .filter(section => section.id === "memory" || section.id === "memory-processing")
  .flatMap(section => section.fields);
const memoryConfigPaths = [...MEMORY_ENABLE_PATHS, ...memoryFields.map(leafPath)];
type MemoryAction = "enabled" | "open" | "reset" | "reset-settings";
export const memoryActionBusy = signal<MemoryAction | null>(null);

export function memoryConfigLoaded(): boolean {
  return settingsValuesCurrent();
}

/** Legacy mixed values stay on disk until the user makes an explicit choice. */
export function memoryEnabledValue(): boolean | undefined {
  if (!memoryConfigLoaded()) return undefined;
  const values = settingsValues();
  const descriptor = deviceDescriptors()[currentDeviceScopeKey()];
  const [generate, use] = MEMORY_ENABLE_PATHS.map(path =>
    values[path] === undefined ? descriptor?.[path]?.default : values[path]);
  return typeof generate === "boolean" && typeof use === "boolean" ? generate && use : undefined;
}

export function memorySettingsBusy(): boolean {
  return memoryActionBusy() !== null || memoryFields.some(fieldSaving);
}

function memoryOperation(action: MemoryAction) {
  if (memorySettingsBusy() || !memoryConfigLoaded()) return null;
  const device = currentDeviceScopeKey();
  const route = { target: fleetDeviceContext() };
  memoryActionBusy.set(action);
  setSectionNotice("memory", "");
  const current = () => device === currentDeviceScopeKey() && memoryConfigLoaded();
  return {
    route,
    current,
    fail: (error: unknown) => { if (current()) setSectionNotice("memory", localizedWriteError(error)); },
    finish: () => memoryActionBusy.set(null),
  };
}

async function reloadMemoryConfig(op: NonNullable<ReturnType<typeof memoryOperation>>): Promise<void> {
  const document = await getConfig("memories", false, op.route);
  if (!op.current()) return;
  const leaves = memoryConfigPaths.map(path => [path, readNestedPath(document, path.split(".").slice(1))]);
  settingsValues.update(values => ({ ...values, ...Object.fromEntries(leaves) }));
}

/** The host persists both switches together and acknowledges their effective value. */
export async function setMemoryEnabled(value: boolean): Promise<void> {
  if (memoryEnabledValue() === undefined) return;
  const op = memoryOperation("enabled");
  if (!op) return;
  try {
    const result = await invokeSettingsMutation<{ effectiveValue?: unknown }>("product_control_invoke", {
      action: "configure", capabilityId: "setting.ai.memory", optionId: "enabled", value,
    }, op.route);
    if (!op.current()) return;
    const effective = result?.effectiveValue;
    if (typeof effective === "boolean") {
      settingsValues.update(values => ({ ...values, [MEMORY_ENABLE_PATHS[0]]: effective, [MEMORY_ENABLE_PATHS[1]]: effective }));
    } else {
      await reloadMemoryConfig(op);
    }
    if (op.current()) flashFieldSaved("memory-enabled");
  } catch (error) {
    op.fail(error);
  } finally {
    op.finish();
  }
}

/** Shows the memory folder in the host's file manager (`get_memory_paths`). */
export async function openMemoryFolder(): Promise<void> {
  if (!isDeviceOnThisMachine()) return;
  const op = memoryOperation("open");
  if (!op) return;
  try {
    const paths = await invokeRawCommand<{ memoriesRootDir?: string; memories_root_dir?: string }>(
      "get_memory_paths",
      {}, op.route,
    );
    if (!op.current() || !isDeviceOnThisMachine()) return;
    const folder = paths?.memoriesRootDir ?? paths?.memories_root_dir ?? "";
    if (!folder) throw new Error(tr("settings.memory.noFolder"));
    await invokeCommand("reveal_in_explorer", { path: folder }, op.route);
  } catch (error) {
    op.fail(error);
  } finally {
    op.finish();
  }
}

/** Clears every stored memory and the extraction state (`reset_memory`); settings stay. */
export async function resetMemory(): Promise<void> {
  const op = memoryOperation("reset");
  if (!op) return;
  try {
    await invokeRawCommand("reset_memory", {}, op.route);
    if (op.current()) setSectionNotice("memory", tr("settings.memory.resetDone"));
  } catch (error) {
    op.fail(error);
  } finally {
    op.finish();
  }
}

export async function resetMemorySettings(): Promise<boolean> {
  const op = memoryOperation("reset-settings");
  if (!op) return false;
  try {
    await invokeSettingsMutation("reset_config", { path: "memories" }, op.route);
    await reloadMemoryConfig(op);
    if (!op.current()) return false;
    setSectionNotice("memory", tr("settings.memory.settingsResetDone"));
    return true;
  } catch (error) {
    op.fail(error);
    return false;
  } finally {
    op.finish();
  }
}

/** The browsers the host can drive, as `browser_control_list_browsers` lists them. */
export const browserChoices = signal<Array<{ value: string; label: string; installed: boolean }> | null>(null);
let browserChoicesLoadingFor: string | null = null;
let browserChoicesLoadedFor: string | null = null;

export async function loadBrowserChoices(force = false): Promise<void> {
  const deviceKey = currentDeviceScopeKey();
  if (!force && (browserChoicesLoadingFor === deviceKey || (browserChoicesLoadedFor === deviceKey && browserChoices() !== null))) {
    return;
  }
  browserChoicesLoadingFor = deviceKey;
  if (browserChoicesLoadedFor !== deviceKey) {
    browserChoices.set(null);
  }
  try {
    const result = await invokeRawCommand<{ options?: Array<{ value?: string; label?: string; installed?: boolean }> }>(
      "browser_control_list_browsers",
      {},
    );
    if (currentDeviceScopeKey() !== deviceKey) return;
    const options = Array.isArray(result?.options) ? result.options : [];
    browserChoices.set(
      options
        .filter(option => option && typeof option.value === "string" && option.value)
        .map(option => ({
          value: String(option.value),
          label: String(option.label ?? option.value),
          installed: option.installed !== false,
        })),
    );
    browserChoicesLoadedFor = deviceKey;
  } catch {
    if (currentDeviceScopeKey() !== deviceKey) return;
    // A host without browser control offers the system default only.
    browserChoices.set([]);
    browserChoicesLoadedFor = deviceKey;
  } finally {
    if (browserChoicesLoadingFor === deviceKey) {
      browserChoicesLoadingFor = null;
    }
  }
}

function browserOptions(): FieldOption[] {
  void loadBrowserChoices();
  const listed = browserChoices() ?? [];
  const rows: FieldOption[] = listed.map(option => ({
    value: option.value,
    label: option.installed ? option.label : tr("settings.field.browserNotInstalled", { name: option.label }),
  }));
  if (!rows.some(row => row.value === "default")) {
    rows.unshift({ value: "default", label: tr("settings.field.browserDefault") });
  }
  return rows;
}

