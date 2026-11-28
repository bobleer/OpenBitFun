//! Closed Agent-facing requests for the executing host's Fleet controller:
//! inspect every runtime device of the account (always including THIS local
//! device), browse workspaces and sessions, collaborate across sessions on any
//! device (local or peer over OpenBitFun Link), inspect account-wide models,
//! answer pending prompts/questions, pull files from a workspace on any device
//! to this host, inspect cross-device Inbox attention and recent sessions,
//! search session history across devices, schedule Cron jobs on always-on
//! devices, and forward `OpenBitFunControl` requests to any peer device.
//!
//! Every target selector accepts `"self"` / `"local"` (or omitted `target`)
//! for the executing device, `"all"` where documented, or a device ID,
//! `device:<deviceId>`, or exact device name/alias.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::product_control::ProductControlAction;

pub const FLEET_CONTROL_PROVIDER: &str = "fleet";
pub const FLEET_CONTROL_CAPABILITY: &str = "feature.fleet";
/// Largest message body sent to a session through Fleet control.
pub const MAX_FLEET_MESSAGE_BYTES: usize = 64 * 1024;
/// Largest shell command body sent to `feature.fleet:run-command` or `feature.fleet:terminal`.
pub const MAX_FLEET_COMMAND_BYTES: usize = 16 * 1024;
/// Largest inline UTF-8 text file written via `feature.fleet:write-file` (4 MiB; larger or binary files use `push-file`).
pub const MAX_FLEET_WRITE_FILE_BYTES: usize = 4 * 1024 * 1024;
/// Default wait timeout for `feature.fleet:wait-session` (seconds).
pub const DEFAULT_FLEET_WAIT_SECONDS: u64 = 60;
/// Maximum wait timeout for `feature.fleet:wait-session` (seconds).
pub const MAX_FLEET_WAIT_SECONDS: u64 = 300;
/// Default ceiling when pulling or pushing a workspace file (64 MiB).
pub const DEFAULT_FLEET_PULL_FILE_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Hard ceiling for `pull-file` / `push-file` (128 MiB; larger binaries use `detached-dispatch:fetch-file`).
pub const HARD_MAX_FLEET_PULL_FILE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FleetFileAction {
    Stat,
    Exists,
    Mkdir,
    Rename,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FleetTerminalAction {
    List,
    Create,
    Execute,
    Write,
    Read,
    Signal,
    Close,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FleetWaitUntil {
    #[default]
    AllDone,
    AnyDone,
    AnyPrompt,
    StateChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetSessionTargetRef {
    #[serde(default)]
    pub target: Option<String>,
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FleetPermissionReply {
    Once,
    Always,
    Reject,
}

impl FleetPermissionReply {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::Reject => "reject",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FleetPromptRoute {
    #[default]
    Auto,
    Session,
    Dispatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FleetCronAction {
    List,
    Create,
    Update,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FleetControlRequest {
    /// Fleet topology: compact view of every device of the account (including this device),
    /// state, Link route, workspaces, and bounded recent session summaries.
    Navigator {
        /// Optional device filter (`"self"`, `"local"`, `"all"`, device ID, `device:<id>`, or device name/alias).
        #[serde(default)]
        target: Option<String>,
        /// Include raw per-device `hostCapabilities` lists (omitted by default to keep payload compact).
        #[serde(default)]
        include_capabilities: bool,
        /// Max recent sessions included per workspace (0..=20, defaults to 3).
        #[serde(default)]
        max_sessions_per_workspace: Option<usize>,
    },
    /// Inspect Git branch, tracking status, ahead/behind, dirty counts, and latest commits directly
    /// on `"self"`, a chosen online peer, or `"all"` online devices without spawning LLM sessions.
    GitInspect {
        /// `"self"` (default), `"all"`, or a specific device selector.
        #[serde(default)]
        target: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        /// Optional case-insensitive filter matching workspace name or rootPath (useful with `target: "all"`).
        #[serde(default)]
        workspace_name: Option<String>,
        #[serde(default)]
        include_branches: bool,
        #[serde(default)]
        include_diff: bool,
        #[serde(default)]
        max_commits: Option<usize>,
    },
    /// Run a one-shot shell command directly on `"self"` or any online peer device (without spawning an LLM session).
    RunCommand {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        command: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        timeout_ms: Option<u64>,
    },
    /// Control persistent PTY terminals directly on `"self"` or any online peer device
    /// (list existing terminals, create, execute, write stdin, read/tail history, signal, close)
    /// without spawning a remote LLM session.
    Terminal {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        action: FleetTerminalAction,
        #[serde(default)]
        terminal_id: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        command: Option<String>,
        #[serde(default)]
        data: Option<String>,
        #[serde(default)]
        signal: Option<String>,
        #[serde(default)]
        after_offset: Option<u64>,
        #[serde(default)]
        max_chars: Option<usize>,
        #[serde(default)]
        timeout_ms: Option<u64>,
        #[serde(default)]
        immediate: Option<bool>,
    },
    /// Read a text file inline from a workspace on `"self"` or any online peer device.
    ReadFile {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        path: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        start_line: Option<usize>,
        #[serde(default)]
        end_line: Option<usize>,
        #[serde(default)]
        max_chars: Option<usize>,
    },
    /// Write or update a UTF-8 text file directly on `"self"` or any online peer device.
    WriteFile {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        path: String,
        content: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        expected_hash: Option<String>,
    },
    /// Manage files and directories (`stat`, `exists`, `mkdir`, `rename`, `delete`) directly on `"self"` or any online peer device.
    ManageFile {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        action: FleetFileAction,
        path: String,
        #[serde(default)]
        new_path: Option<String>,
        #[serde(default)]
        is_directory: bool,
        #[serde(default)]
        recursive: bool,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    /// List files and directories inside a workspace on `"self"` or any online peer device.
    ListFiles {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        offset: Option<usize>,
        #[serde(default)]
        limit: Option<usize>,
    },
    /// Search filenames or file contents inside a workspace on `"self"` or any online peer device.
    SearchFiles {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        pattern: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        search_content: bool,
        #[serde(default)]
        case_sensitive: bool,
        #[serde(default)]
        use_regex: bool,
        #[serde(default)]
        max_results: Option<usize>,
    },
    /// Detailed runtime facts, active sessions, dispatch jobs, capabilities, and prompts for one device.
    DeviceDetail {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
    },
    /// Account-wide chat model catalog across this device and all online peers.
    ListModels {
        /// Optional device selector whose session perspective ranks the catalog; defaults to `"self"`.
        #[serde(default)]
        target: Option<String>,
    },
    /// Opened and recent workspaces on `"self"` (default), `"all"` devices, or one device.
    ListWorkspaces {
        #[serde(default)]
        target: Option<String>,
    },
    /// List persisted/active sessions of a workspace on any device (local or peer).
    ListSessions {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
    },
    /// Create a new session in a workspace on any device (local or peer), optionally sending an initial message and waiting for completion.
    CreateSession {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        session_name: String,
        #[serde(default)]
        agent_type: Option<String>,
        #[serde(default)]
        model_name: Option<String>,
        /// Optional initial prompt to send immediately after session creation.
        #[serde(default)]
        message: Option<String>,
        /// When `message` is provided, optionally wait up to N seconds (1..=180) for the turn to settle or pause for approval.
        #[serde(default)]
        wait_seconds: Option<u64>,
    },
    /// Send a user message / start a dialog turn in a session on any device (local or peer), optionally waiting for completion.
    SendMessage {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        session_id: String,
        message: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        agent_type: Option<String>,
        #[serde(default)]
        model_id: Option<String>,
        /// Optionally wait up to N seconds (1..=180) for the turn to settle or pause for approval.
        #[serde(default)]
        wait_seconds: Option<u64>,
    },
    /// Block until one or more sessions on any devices finish their active turn, pause on a prompt, or reach `timeoutSeconds`.
    WaitSession {
        /// Shorthand target when waiting on a single session.
        #[serde(default)]
        target: Option<String>,
        /// Shorthand sessionId when waiting on a single session.
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        /// Multiple sessions to watch in parallel across devices.
        #[serde(default)]
        sessions: Vec<FleetSessionTargetRef>,
        #[serde(default)]
        until: FleetWaitUntil,
        #[serde(default)]
        timeout_seconds: Option<u64>,
        #[serde(default)]
        tail_turn_count: Option<usize>,
    },
    /// Read a session's metadata, latest turn summaries, running state, and pending interaction mailbox on any device (local or peer).
    ReadSession {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        session_id: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        tail_turn_count: Option<usize>,
    },
    /// Cancel an active dialog turn on any device (local or peer).
    CancelSession {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        session_id: String,
    },
    /// List pending permission prompts and user questions across this device and all online peers.
    ListPrompts {
        /// Optional device filter (`"self"`, `"all"`, or a device selector). Defaults to `"all"`.
        #[serde(default)]
        target: Option<String>,
    },
    /// Answer a pending permission prompt or user question on any device (local or peer),
    /// for either a live session or a detached dispatch job.
    AnswerPrompt {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        request_id: String,
        #[serde(default)]
        route: FleetPromptRoute,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        job_id: Option<String>,
        #[serde(default)]
        reply: Option<FleetPermissionReply>,
        #[serde(default)]
        feedback: Option<String>,
        #[serde(default)]
        answers: Option<Value>,
    },
    /// Pull a file from a workspace on any device (local or peer) to a local file path on this host.
    PullFile {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        remote_path: String,
        local_path: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        overwrite: bool,
        #[serde(default)]
        max_bytes: Option<u64>,
    },
    /// Push a local file from this host to a workspace on `"self"` or any online peer device (supports binary and text with SHA-256 verification).
    PushFile {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        local_path: String,
        remote_path: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        expected_hash: Option<String>,
        #[serde(default)]
        max_bytes: Option<u64>,
    },
    /// Cross-device Fleet Inbox: prompts, blocked runs, and unread Done/Failed notifications across every device.
    Attention {},
    /// Mark Done/Failed items of the Fleet Inbox read up to `revision`.
    MarkAttentionRead { revision: u64 },
    /// Recent sessions across every device of the account, newest first.
    RecentSessions {
        #[serde(default)]
        limit: Option<usize>,
        #[serde(default)]
        cursor: Option<String>,
    },
    /// Search session transcript content on `"self"`, a specific peer device, or `"all"` online devices.
    SearchSessions {
        /// `"self"` (default), `"all"`, or a specific device selector.
        #[serde(default)]
        target: Option<String>,
        query: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
    },
    /// Manage scheduled Cron jobs on `"self"` or any always-on peer device.
    ManageCron {
        /// Defaults to `"self"` (this device).
        #[serde(default)]
        target: Option<String>,
        action: FleetCronAction,
        #[serde(default)]
        job_id: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        schedule: Option<Value>,
        #[serde(default)]
        payload: Option<Value>,
        #[serde(default)]
        enabled: Option<bool>,
    },
    /// Forward an `OpenBitFunControl` `get`, `configure`, or `execute` request to any target device (`"self"` or peer).
    InvokeControl {
        /// Target device selector (`"self"`, device ID, `device:<id>`, or device name/alias).
        #[serde(default)]
        target: Option<String>,
        action: ProductControlAction,
        capability_id: String,
        #[serde(default)]
        operation_id: Option<String>,
        #[serde(default)]
        option_id: Option<String>,
        #[serde(default)]
        arguments: Option<Value>,
        #[serde(default)]
        value: Option<Value>,
    },
}

impl FleetControlRequest {
    pub const ALL_OPERATIONS: &[&str] = &[
        "navigator",
        "git-inspect",
        "run-command",
        "terminal",
        "read-file",
        "write-file",
        "manage-file",
        "list-files",
        "search-files",
        "device-detail",
        "list-models",
        "list-workspaces",
        "list-sessions",
        "create-session",
        "send-message",
        "wait-session",
        "read-session",
        "cancel-session",
        "list-prompts",
        "answer-prompt",
        "pull-file",
        "push-file",
        "attention",
        "mark-attention-read",
        "recent-sessions",
        "search-sessions",
        "manage-cron",
        "invoke-control",
    ];

    pub fn from_operation(operation: &str, arguments: Option<&Value>) -> Result<Self, String> {
        let mut arguments = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
        let object = arguments
            .as_object_mut()
            .ok_or("Fleet control arguments must be an object")?;
        if object.contains_key("operation") {
            return Err(
                "Fleet control operation must be supplied by the registered handler".into(),
            );
        }
        object.insert("operation".into(), Value::String(operation.into()));
        let parsed: Self = serde_json::from_value(arguments)
            .map_err(|error| format!("Invalid Fleet control operation or arguments: {error}"))?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Navigator {
                max_sessions_per_workspace,
                ..
            } => {
                if let Some(max) = max_sessions_per_workspace {
                    if *max > 20 {
                        return Err("maxSessionsPerWorkspace must be between 0 and 20".into());
                    }
                }
            }
            Self::GitInspect { max_commits, .. } => {
                if let Some(max) = max_commits {
                    if *max == 0 || *max > 20 {
                        return Err("maxCommits must be between 1 and 20".into());
                    }
                }
            }
            Self::RunCommand {
                command,
                timeout_ms,
                ..
            } => {
                if command.trim().is_empty() {
                    return Err("run-command requires a non-empty command".into());
                }
                if command.len() > MAX_FLEET_COMMAND_BYTES {
                    return Err(format!(
                        "command exceeds the {MAX_FLEET_COMMAND_BYTES} byte limit"
                    ));
                }
                if let Some(ms) = timeout_ms {
                    if *ms < 1000 || *ms > 300_000 {
                        return Err("timeoutMs must be between 1000 and 300000".into());
                    }
                }
            }
            Self::Terminal {
                action,
                terminal_id,
                command,
                data,
                signal,
                max_chars,
                timeout_ms,
                ..
            } => {
                if let Some(max) = max_chars {
                    if *max == 0 || *max > 131_072 {
                        return Err("maxChars must be between 1 and 131072".into());
                    }
                }
                if let Some(ms) = timeout_ms {
                    if *ms < 1000 || *ms > 300_000 {
                        return Err("timeoutMs must be between 1000 and 300000".into());
                    }
                }
                let has_tid = terminal_id.as_deref().is_some_and(|v| !v.trim().is_empty());
                match action {
                    FleetTerminalAction::List | FleetTerminalAction::Create => {}
                    FleetTerminalAction::Execute => {
                        if !has_tid {
                            return Err("terminal action=execute requires terminalId".into());
                        }
                        let Some(cmd) = command.as_deref().filter(|v| !v.trim().is_empty()) else {
                            return Err(
                                "terminal action=execute requires a non-empty command".into()
                            );
                        };
                        if cmd.len() > MAX_FLEET_COMMAND_BYTES {
                            return Err(format!(
                                "command exceeds the {MAX_FLEET_COMMAND_BYTES} byte limit"
                            ));
                        }
                    }
                    FleetTerminalAction::Write => {
                        if !has_tid {
                            return Err("terminal action=write requires terminalId".into());
                        }
                        let Some(raw) = data.as_deref().filter(|v| !v.is_empty()) else {
                            return Err("terminal action=write requires non-empty data".into());
                        };
                        if raw.len() > MAX_FLEET_COMMAND_BYTES {
                            return Err(format!(
                                "data exceeds the {MAX_FLEET_COMMAND_BYTES} byte limit"
                            ));
                        }
                    }
                    FleetTerminalAction::Read | FleetTerminalAction::Close => {
                        if !has_tid {
                            return Err("terminal read/close requires terminalId".into());
                        }
                    }
                    FleetTerminalAction::Signal => {
                        if !has_tid {
                            return Err("terminal action=signal requires terminalId".into());
                        }
                        if signal.as_deref().is_none_or(|v| v.trim().is_empty()) {
                            return Err(
                                "terminal action=signal requires signal (e.g. SIGINT)".into()
                            );
                        }
                    }
                }
            }
            Self::ReadFile {
                path,
                start_line,
                end_line,
                max_chars,
                ..
            } => {
                if path.trim().is_empty() {
                    return Err("read-file requires a non-empty path".into());
                }
                if let (Some(s), Some(e)) = (start_line, end_line) {
                    if *s == 0 || *e < *s {
                        return Err("startLine must be >= 1 and <= endLine".into());
                    }
                } else if start_line.is_some_and(|s| s == 0) || end_line.is_some_and(|e| e == 0) {
                    return Err("startLine and endLine must be >= 1".into());
                }
                if let Some(max) = max_chars {
                    if *max == 0 || *max > 131_072 {
                        return Err("maxChars must be between 1 and 131072".into());
                    }
                }
            }
            Self::WriteFile { path, content, .. } => {
                if path.trim().is_empty() {
                    return Err("write-file requires a non-empty path".into());
                }
                if content.len() > MAX_FLEET_WRITE_FILE_BYTES {
                    return Err(format!(
                        "content exceeds the {MAX_FLEET_WRITE_FILE_BYTES} byte limit; use push-file for large or binary files"
                    ));
                }
            }
            Self::ManageFile {
                action,
                path,
                new_path,
                ..
            } => {
                if path.trim().is_empty() {
                    return Err("manage-file requires a non-empty path".into());
                }
                if matches!(action, FleetFileAction::Rename)
                    && new_path.as_deref().is_none_or(|v| v.trim().is_empty())
                {
                    return Err("manage-file action=rename requires newPath".into());
                }
            }
            Self::ListFiles { limit, .. } => {
                if let Some(limit) = limit {
                    if *limit == 0 || *limit > 200 {
                        return Err("limit must be between 1 and 200".into());
                    }
                }
            }
            Self::SearchFiles {
                pattern,
                max_results,
                ..
            } => {
                if pattern.trim().is_empty() {
                    return Err("search-files requires a non-empty pattern".into());
                }
                if let Some(max) = max_results {
                    if *max == 0 || *max > 100 {
                        return Err("maxResults must be between 1 and 100".into());
                    }
                }
            }
            Self::ListSessions {
                workspace_id,
                workspace_path,
                limit,
                ..
            } => {
                if workspace_id.as_deref().is_none_or(|v| v.trim().is_empty())
                    && workspace_path
                        .as_deref()
                        .is_none_or(|v| v.trim().is_empty())
                {
                    return Err("list-sessions requires workspaceId or workspacePath".into());
                }
                if let Some(limit) = limit {
                    if *limit == 0 || *limit > 100 {
                        return Err("limit must be between 1 and 100".into());
                    }
                }
            }
            Self::CreateSession {
                workspace_id,
                workspace_path,
                session_name,
                message,
                wait_seconds,
                ..
            } => {
                if session_name.trim().is_empty() {
                    return Err("sessionName cannot be empty".into());
                }
                if workspace_id.as_deref().is_none_or(|v| v.trim().is_empty())
                    && workspace_path
                        .as_deref()
                        .is_none_or(|v| v.trim().is_empty())
                {
                    return Err("create-session requires workspaceId or workspacePath".into());
                }
                if let Some(msg) = message {
                    if msg.trim().is_empty() {
                        return Err("message cannot be empty when provided".into());
                    }
                    if msg.len() > MAX_FLEET_MESSAGE_BYTES {
                        return Err(format!(
                            "message exceeds the {MAX_FLEET_MESSAGE_BYTES} byte limit"
                        ));
                    }
                }
                if let Some(secs) = wait_seconds {
                    if message.is_none() {
                        return Err("waitSeconds requires message on create-session".into());
                    }
                    if *secs == 0 || *secs > 180 {
                        return Err("waitSeconds must be between 1 and 180".into());
                    }
                }
            }
            Self::SendMessage {
                session_id,
                message,
                wait_seconds,
                ..
            } => {
                if session_id.trim().is_empty() {
                    return Err("sessionId cannot be empty".into());
                }
                if message.trim().is_empty() {
                    return Err("message cannot be empty".into());
                }
                if message.len() > MAX_FLEET_MESSAGE_BYTES {
                    return Err(format!(
                        "message exceeds the {MAX_FLEET_MESSAGE_BYTES} byte limit"
                    ));
                }
                if let Some(secs) = wait_seconds {
                    if *secs == 0 || *secs > 180 {
                        return Err("waitSeconds must be between 1 and 180".into());
                    }
                }
            }
            Self::WaitSession {
                session_id,
                sessions,
                timeout_seconds,
                tail_turn_count,
                ..
            } => {
                let has_single = session_id.as_deref().is_some_and(|v| !v.trim().is_empty());
                if !has_single && sessions.is_empty() {
                    return Err(
                        "wait-session requires sessionId or a non-empty sessions array".into(),
                    );
                }
                if sessions.iter().any(|s| s.session_id.trim().is_empty()) {
                    return Err("every entry in sessions requires a non-empty sessionId".into());
                }
                if sessions.len() > 16 {
                    return Err("sessions may contain at most 16 entries".into());
                }
                if let Some(secs) = timeout_seconds {
                    if *secs == 0 || *secs > MAX_FLEET_WAIT_SECONDS {
                        return Err(format!(
                            "timeoutSeconds must be between 1 and {MAX_FLEET_WAIT_SECONDS}"
                        ));
                    }
                }
                if let Some(count) = tail_turn_count {
                    if *count == 0 || *count > 16 {
                        return Err("tailTurnCount must be between 1 and 16".into());
                    }
                }
            }
            Self::ReadSession {
                session_id,
                tail_turn_count,
                ..
            } => {
                if session_id.trim().is_empty() {
                    return Err("sessionId cannot be empty".into());
                }
                if let Some(count) = tail_turn_count {
                    if *count == 0 || *count > 16 {
                        return Err("tailTurnCount must be between 1 and 16".into());
                    }
                }
            }
            Self::CancelSession { session_id, .. } => {
                if session_id.trim().is_empty() {
                    return Err("sessionId cannot be empty".into());
                }
            }
            Self::AnswerPrompt {
                request_id,
                route,
                job_id,
                reply,
                answers,
                ..
            } => {
                if request_id.trim().is_empty() {
                    return Err("requestId cannot be empty".into());
                }
                if reply.is_some() == answers.is_some() {
                    return Err(
                        "answer-prompt requires exactly one of reply (permissions) or answers (questions)"
                            .into(),
                    );
                }
                if matches!(route, FleetPromptRoute::Dispatch)
                    && job_id.as_deref().is_none_or(|v| v.trim().is_empty())
                {
                    return Err("dispatch route requires jobId".into());
                }
            }
            Self::PullFile {
                remote_path,
                local_path,
                max_bytes,
                ..
            } => {
                if remote_path.trim().is_empty() || local_path.trim().is_empty() {
                    return Err("pull-file requires non-empty remotePath and localPath".into());
                }
                if let Some(limit) = max_bytes {
                    if *limit == 0 || *limit > HARD_MAX_FLEET_PULL_FILE_BYTES {
                        return Err(format!(
                            "maxBytes must be between 1 and {HARD_MAX_FLEET_PULL_FILE_BYTES}"
                        ));
                    }
                }
            }
            Self::PushFile {
                local_path,
                remote_path,
                max_bytes,
                ..
            } => {
                if local_path.trim().is_empty() || remote_path.trim().is_empty() {
                    return Err("push-file requires non-empty localPath and remotePath".into());
                }
                if let Some(limit) = max_bytes {
                    if *limit == 0 || *limit > HARD_MAX_FLEET_PULL_FILE_BYTES {
                        return Err(format!(
                            "maxBytes must be between 1 and {HARD_MAX_FLEET_PULL_FILE_BYTES}"
                        ));
                    }
                }
            }
            Self::RecentSessions { limit, .. } => {
                if let Some(limit) = limit {
                    if *limit == 0 || *limit > 100 {
                        return Err("limit must be between 1 and 100".into());
                    }
                }
            }
            Self::SearchSessions { query, limit, .. } => {
                if query.trim().is_empty() {
                    return Err("search-sessions requires a non-empty query".into());
                }
                if let Some(limit) = limit {
                    if *limit == 0 || *limit > 100 {
                        return Err("limit must be between 1 and 100".into());
                    }
                }
            }
            Self::ManageCron {
                action,
                job_id,
                name,
                schedule,
                payload,
                ..
            } => match action {
                FleetCronAction::List => {}
                FleetCronAction::Create => {
                    if name.as_deref().is_none_or(|v| v.trim().is_empty()) {
                        return Err("manage-cron action=create requires name".into());
                    }
                    if schedule.is_none() || payload.is_none() {
                        return Err(
                            "manage-cron action=create requires schedule and payload objects"
                                .into(),
                        );
                    }
                }
                FleetCronAction::Update | FleetCronAction::Delete => {
                    if job_id.as_deref().is_none_or(|v| v.trim().is_empty()) {
                        return Err("manage-cron update/delete requires jobId".into());
                    }
                }
            },
            Self::InvokeControl {
                action,
                capability_id,
                operation_id,
                option_id,
                value,
                ..
            } => {
                if capability_id.trim().is_empty() {
                    return Err("invoke-control requires capabilityId".into());
                }
                match action {
                    ProductControlAction::Get => {}
                    ProductControlAction::Execute => {
                        if operation_id.as_deref().is_none_or(|v| v.trim().is_empty()) {
                            return Err("invoke-control action=execute requires operationId".into());
                        }
                    }
                    ProductControlAction::Configure => {
                        if option_id.as_deref().is_none_or(|v| v.trim().is_empty())
                            || value.is_none()
                        {
                            return Err(
                                "invoke-control action=configure requires optionId and value"
                                    .into(),
                            );
                        }
                    }
                    ProductControlAction::List
                    | ProductControlAction::Search
                    | ProductControlAction::Open => {
                        return Err(
                            "invoke-control only supports get, configure, or execute".into()
                        );
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn operation_id(&self) -> &'static str {
        match self {
            Self::Navigator { .. } => "navigator",
            Self::GitInspect { .. } => "git-inspect",
            Self::RunCommand { .. } => "run-command",
            Self::Terminal { .. } => "terminal",
            Self::ReadFile { .. } => "read-file",
            Self::WriteFile { .. } => "write-file",
            Self::ManageFile { .. } => "manage-file",
            Self::ListFiles { .. } => "list-files",
            Self::SearchFiles { .. } => "search-files",
            Self::DeviceDetail { .. } => "device-detail",
            Self::ListModels { .. } => "list-models",
            Self::ListWorkspaces { .. } => "list-workspaces",
            Self::ListSessions { .. } => "list-sessions",
            Self::CreateSession { .. } => "create-session",
            Self::SendMessage { .. } => "send-message",
            Self::WaitSession { .. } => "wait-session",
            Self::ReadSession { .. } => "read-session",
            Self::CancelSession { .. } => "cancel-session",
            Self::ListPrompts { .. } => "list-prompts",
            Self::AnswerPrompt { .. } => "answer-prompt",
            Self::PullFile { .. } => "pull-file",
            Self::PushFile { .. } => "push-file",
            Self::Attention {} => "attention",
            Self::MarkAttentionRead { .. } => "mark-attention-read",
            Self::RecentSessions { .. } => "recent-sessions",
            Self::SearchSessions { .. } => "search-sessions",
            Self::ManageCron { .. } => "manage-cron",
            Self::InvokeControl { .. } => "invoke-control",
        }
    }

    pub fn is_readonly(&self) -> bool {
        matches!(
            self,
            Self::Navigator { .. }
                | Self::GitInspect { .. }
                | Self::ReadFile { .. }
                | Self::ListFiles { .. }
                | Self::SearchFiles { .. }
                | Self::DeviceDetail { .. }
                | Self::ListModels { .. }
                | Self::ListWorkspaces { .. }
                | Self::ListSessions { .. }
                | Self::WaitSession { .. }
                | Self::ReadSession { .. }
                | Self::ListPrompts { .. }
                | Self::Attention {}
                | Self::RecentSessions { .. }
                | Self::SearchSessions { .. }
        )
    }

    /// A detached dispatch worker runs unattended and may inspect fleet state,
    /// but must not spawn or drive new sessions or mutate other hosts.
    pub fn ensure_allowed_in_dispatch_worker(&self) -> Result<(), String> {
        if self.is_readonly() {
            Ok(())
        } else {
            Err(format!(
                "fleet_nested_mutation_unsupported: A detached dispatch worker cannot execute mutating fleet operation '{}'; report the follow-up in the job result instead",
                self.operation_id()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fleet_control_parses_and_validates_closed_requests() {
        let nav = FleetControlRequest::from_operation("navigator", None).unwrap();
        assert!(nav.is_readonly());
        assert!(nav.ensure_allowed_in_dispatch_worker().is_ok());

        let attn = FleetControlRequest::from_operation("attention", None).unwrap();
        assert!(attn.is_readonly());

        let search = FleetControlRequest::from_operation(
            "search-sessions",
            Some(&json!({"target": "all", "query": "OOM crash", "limit": 20})),
        )
        .unwrap();
        assert!(search.is_readonly());

        let cron = FleetControlRequest::from_operation(
            "manage-cron",
            Some(&json!({
                "target": "linux-box",
                "action": "list"
            })),
        )
        .unwrap();
        assert!(!cron.is_readonly());
        assert!(cron.ensure_allowed_in_dispatch_worker().is_err());

        let forwarded = FleetControlRequest::from_operation(
            "invoke-control",
            Some(&json!({
                "target": "linux-box",
                "action": "get",
                "capabilityId": "setting.ai.models"
            })),
        )
        .unwrap();
        assert_eq!(forwarded.operation_id(), "invoke-control");

        for (op, args) in [
            ("list-sessions", json!({})),
            ("create-session", json!({"sessionName": "x"})),
            ("send-message", json!({"sessionId": "s", "message": "   "})),
            (
                "read-session",
                json!({"sessionId": "s", "tailTurnCount": 99}),
            ),
            ("answer-prompt", json!({"requestId": "r1"})),
            (
                "answer-prompt",
                json!({"requestId": "r1", "route": "dispatch", "reply": "once"}),
            ),
            ("pull-file", json!({"remotePath": "a", "localPath": ""})),
            ("search-sessions", json!({"query": "  "})),
            ("manage-cron", json!({"action": "create", "name": "x"})),
            ("manage-cron", json!({"action": "delete"})),
            (
                "invoke-control",
                json!({"action": "open", "capabilityId": "feature.git"}),
            ),
            (
                "invoke-control",
                json!({"action": "execute", "capabilityId": "feature.skills"}),
            ),
            ("navigator", json!({"unknown": 1})),
        ] {
            assert!(
                FleetControlRequest::from_operation(op, Some(&args)).is_err(),
                "{op} {args}"
            );
        }
    }

    #[test]
    fn fleet_controls_declare_risk_host_paths_and_cli_availability() {
        use crate::product_control::*;
        let registry = ProductControlRegistry::global();
        let capability = FLEET_CONTROL_CAPABILITY;
        for (operation, risk) in [
            ("navigator", ProductControlRisk::Read),
            ("git-inspect", ProductControlRisk::Read),
            ("run-command", ProductControlRisk::Execute),
            ("terminal", ProductControlRisk::Execute),
            ("read-file", ProductControlRisk::Read),
            ("write-file", ProductControlRisk::Write),
            ("manage-file", ProductControlRisk::Write),
            ("list-files", ProductControlRisk::Read),
            ("search-files", ProductControlRisk::Read),
            ("device-detail", ProductControlRisk::Read),
            ("list-models", ProductControlRisk::Read),
            ("list-workspaces", ProductControlRisk::Read),
            ("list-sessions", ProductControlRisk::Read),
            ("wait-session", ProductControlRisk::Read),
            ("read-session", ProductControlRisk::Read),
            ("list-prompts", ProductControlRisk::Read),
            ("attention", ProductControlRisk::Read),
            ("recent-sessions", ProductControlRisk::Read),
            ("search-sessions", ProductControlRisk::Read),
            ("mark-attention-read", ProductControlRisk::Write),
            ("create-session", ProductControlRisk::Execute),
            ("send-message", ProductControlRisk::Execute),
            ("answer-prompt", ProductControlRisk::Execute),
            ("manage-cron", ProductControlRisk::Execute),
            ("invoke-control", ProductControlRisk::Execute),
            ("pull-file", ProductControlRisk::Write),
            ("push-file", ProductControlRisk::Write),
            ("cancel-session", ProductControlRisk::Destructive),
        ] {
            assert_eq!(
                registry.operation(capability, operation).unwrap().risk,
                risk,
                "{operation}"
            );
            let definition = registry
                .definition(&format!("{capability}:operation:{operation}"))
                .unwrap();
            assert!(
                definition.availability[&ProductControlDeliveryProfile::Desktop].available,
                "{operation}"
            );
            assert!(
                definition.availability[&ProductControlDeliveryProfile::Cli].available,
                "{operation}"
            );
            assert_eq!(
                definition.availability[&ProductControlDeliveryProfile::DetachedDispatch].available,
                risk == ProductControlRisk::Read,
                "{operation}"
            );
        }
        let pull = registry.operation(capability, "pull-file").unwrap();
        let pull_args = json!({"remotePath":"/peer/a.bin","localPath":"/host/a.bin"});
        validate_operation_arguments(&pull.input_schema, Some(&pull_args)).unwrap();
        assert!(validate_operation_argument_scopes(pull, Some(&pull_args), true).is_err());
    }
}
