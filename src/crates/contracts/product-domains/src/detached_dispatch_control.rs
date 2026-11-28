//! Closed Agent-facing requests for the executing host's Detached Dispatch
//! controller: list same-account devices and saved SSH targets, probe targets,
//! submit jobs (from a local Git checkout or target-resolved source), observe,
//! wait, steer, continue, answer prompts, sync Git changes, fetch binary/text
//! job artifacts back to this host, publish branches, and cancel jobs.
//!
//! The controller semantics live in the Core dispatch owner; this contract only
//! names the operations and their arguments so every host binds them the same way.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DETACHED_DISPATCH_CONTROL_PROVIDER: &str = "detached-dispatch";
/// Largest prompt a controller may submit; mirrors the dispatch protocol limit.
pub const MAX_DETACHED_DISPATCH_PROMPT_BYTES: usize = 32 * 1024;
/// Default wait timeout in seconds for `wait`.
pub const DEFAULT_DISPATCH_WAIT_SECONDS: u32 = 120;
/// Maximum wait timeout in seconds for a single `wait` call.
pub const MAX_DISPATCH_WAIT_SECONDS: u32 = 600;
/// Maximum job IDs watched in a single `wait` call.
pub const MAX_DISPATCH_WAIT_JOB_IDS: usize = 64;
/// Default safety ceiling when streaming a remote job file back to disk (512 MiB).
pub const DEFAULT_DISPATCH_FETCH_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// Hard safety ceiling when streaming a remote job file back to disk (2 GiB).
pub const HARD_MAX_DISPATCH_FETCH_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn default_dispatch_wait_seconds() -> u32 {
    DEFAULT_DISPATCH_WAIT_SECONDS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetachedDispatchApprovalPolicy {
    /// Approve every tool request that static rules do not deny.
    Auto,
    /// Reject permission prompts and report them in the job result.
    RejectAndReport,
    /// Park permission prompts in the target's mailbox until answered via `answer`.
    Remote,
}

impl DetachedDispatchApprovalPolicy {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::RejectAndReport => "reject-and-report",
            Self::Remote => "remote",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetachedDispatchWaitUntil {
    #[default]
    StateChange,
    AnyBlocked,
    AnyTerminal,
    AllTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetachedDispatchPermissionReply {
    Once,
    Always,
    Reject,
}

impl DetachedDispatchPermissionReply {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::Reject => "reject",
        }
    }
}

/// Target-resolved job source (`workspace_target_source_v1` / `workspace_peer_import_v1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum DetachedDispatchSource {
    /// One of the target device's own workspaces by fleet workspace ID.
    #[serde(rename_all = "camelCase")]
    Workspace {
        workspace_id: String,
        #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
        git_ref: Option<String>,
    },
    /// A Git remote URL fetched directly by the target with its own credentials.
    #[serde(rename_all = "camelCase")]
    Remote {
        remote_url: String,
        #[serde(rename = "ref")]
        git_ref: String,
    },
    /// Another same-account device's dispatch job branch (`workspace_peer_import_v1`).
    #[serde(rename_all = "camelCase")]
    Job {
        job_id: String,
        source_device_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        head: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_commit: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DetachedDispatchControlRequest {
    /// Same-account devices (including this one, marked) and saved SSH targets.
    ListTargets,
    /// Probe one target device or SSH host for OS, arch, CLI readiness, and capabilities.
    Probe {
        /// Device name or alias, `device:<deviceId>`, or `ssh:<connectionId>`.
        target: String,
        /// Optional fleet workspace ID on the target to validate (`workspace_target_source_v1`).
        #[serde(default)]
        workspace_id: Option<String>,
    },
    /// Submit a durable detached job to another host.
    ///
    /// Supply either `workspacePath` (local Git checkout on this host) or `source`
    /// (target-resolved workspace, Git remote, or peer job result).
    Submit {
        /// Device name or alias, `device:<deviceId>`, or `ssh:<connectionId>`.
        target: String,
        prompt: String,
        approval_policy: DetachedDispatchApprovalPolicy,
        /// Git checkout on this host the job branches from.
        #[serde(default)]
        workspace_path: Option<String>,
        /// Target-resolved source (device targets with `workspace_target_source_v1`).
        #[serde(default)]
        source: Option<DetachedDispatchSource>,
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        base_ref: Option<String>,
        #[serde(default)]
        include_uncommitted: bool,
        #[serde(default)]
        title: Option<String>,
    },
    /// Read a job's state, pending prompts, and incremental events.
    Status {
        job_id: String,
        #[serde(default)]
        cursor: u64,
        #[serde(default)]
        summary_only: bool,
    },
    /// Wait for one or more submitted jobs until state changes, any blocks, or terminal state.
    Wait {
        job_ids: Vec<String>,
        #[serde(default)]
        until: DetachedDispatchWaitUntil,
        #[serde(default = "default_dispatch_wait_seconds")]
        timeout_seconds: u32,
    },
    /// Read a compact structured summary (state, commits, diff numstat, bounded last reply).
    ResultSummary { job_id: String },
    /// Queue a follow-up turn on a finished job reusing its session and worktree.
    Continue {
        job_id: String,
        prompt: String,
        #[serde(default)]
        approval_policy: Option<DetachedDispatchApprovalPolicy>,
        #[serde(default)]
        model: Option<String>,
    },
    /// Steer an active running turn with a follow-up message.
    Append { job_id: String, prompt: String },
    /// Answer a pending permission request or user question on a job.
    Answer {
        job_id: String,
        request_id: String,
        #[serde(default)]
        reply: Option<DetachedDispatchPermissionReply>,
        #[serde(default)]
        feedback: Option<String>,
        #[serde(default)]
        answers: Option<Value>,
    },
    /// Synchronize Git-visible changes from a job back into this host's baseline worktree.
    SyncResult {
        job_id: String,
        #[serde(default)]
        message: Option<String>,
    },
    /// Stream a file (including compiled binaries) from a job workspace or output root
    /// directly to a local file path on this host (`query_file_chunks_v1`).
    FetchFile {
        job_id: String,
        remote_path: String,
        local_path: String,
        #[serde(default)]
        overwrite: bool,
        #[serde(default)]
        max_bytes: Option<u64>,
    },
    /// Push a finished job's managed dispatch branch to its Git remote (`workspace_publish_v1`).
    PublishBranch {
        job_id: String,
        #[serde(default)]
        remote: Option<String>,
    },
    /// List jobs submitted from this host or owned by a target.
    ListJobs {
        #[serde(default)]
        target: Option<String>,
    },
    /// Cancel a queued or running job.
    Cancel { job_id: String },
}

impl DetachedDispatchControlRequest {
    pub const ALL_OPERATIONS: &[&str] = &[
        "list-targets",
        "probe",
        "submit",
        "status",
        "wait",
        "result-summary",
        "continue",
        "append",
        "answer",
        "sync-result",
        "fetch-file",
        "publish-branch",
        "list-jobs",
        "cancel",
    ];

    pub fn from_operation(operation: &str, arguments: Option<&Value>) -> Result<Self, String> {
        let mut arguments = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
        let object = arguments
            .as_object_mut()
            .ok_or("Detached Dispatch arguments must be an object")?;
        if object.contains_key("operation") {
            return Err(
                "Detached Dispatch operation must be supplied by the registered handler".into(),
            );
        }
        object.insert("operation".into(), Value::String(operation.into()));
        let parsed: Self = serde_json::from_value(arguments).map_err(|error| {
            format!("Invalid Detached Dispatch operation or arguments: {error}")
        })?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Submit {
                workspace_path,
                source,
                ..
            } => {
                let has_workspace_path = workspace_path
                    .as_deref()
                    .is_some_and(|path| !path.trim().is_empty());
                match (has_workspace_path, source.is_some()) {
                    (true, true) => {
                        return Err("Provide either workspacePath or source, not both".into());
                    }
                    (false, false) => {
                        return Err(
                            "Submit requires either workspacePath (local Git checkout) or source"
                                .into(),
                        );
                    }
                    _ => {}
                }
            }
            Self::Wait {
                job_ids,
                timeout_seconds,
                ..
            } => {
                if job_ids.is_empty() || job_ids.len() > MAX_DISPATCH_WAIT_JOB_IDS {
                    return Err(format!(
                        "jobIds must contain between 1 and {MAX_DISPATCH_WAIT_JOB_IDS} job IDs"
                    ));
                }
                if job_ids.iter().any(|id| id.trim().is_empty()) {
                    return Err("jobIds cannot contain empty values".into());
                }
                if *timeout_seconds == 0 || *timeout_seconds > MAX_DISPATCH_WAIT_SECONDS {
                    return Err(format!(
                        "timeoutSeconds must be between 1 and {MAX_DISPATCH_WAIT_SECONDS}"
                    ));
                }
            }
            Self::Answer { reply, answers, .. } => {
                if reply.is_some() == answers.is_some() {
                    return Err(
                        "Answer requires exactly one of reply (for permissions) or answers (for user questions)"
                            .into(),
                    );
                }
            }
            Self::FetchFile {
                remote_path,
                local_path,
                max_bytes,
                ..
            } => {
                if remote_path.trim().is_empty() || local_path.trim().is_empty() {
                    return Err("fetch-file requires non-empty remotePath and localPath".into());
                }
                if let Some(limit) = max_bytes {
                    if *limit == 0 || *limit > HARD_MAX_DISPATCH_FETCH_BYTES {
                        return Err(format!(
                            "maxBytes must be between 1 and {HARD_MAX_DISPATCH_FETCH_BYTES}"
                        ));
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn operation_id(&self) -> &'static str {
        match self {
            Self::ListTargets => "list-targets",
            Self::Probe { .. } => "probe",
            Self::Submit { .. } => "submit",
            Self::Status { .. } => "status",
            Self::Wait { .. } => "wait",
            Self::ResultSummary { .. } => "result-summary",
            Self::Continue { .. } => "continue",
            Self::Append { .. } => "append",
            Self::Answer { .. } => "answer",
            Self::SyncResult { .. } => "sync-result",
            Self::FetchFile { .. } => "fetch-file",
            Self::PublishBranch { .. } => "publish-branch",
            Self::ListJobs { .. } => "list-jobs",
            Self::Cancel { .. } => "cancel",
        }
    }

    pub fn is_readonly(&self) -> bool {
        matches!(
            self,
            Self::ListTargets
                | Self::Probe { .. }
                | Self::Status { .. }
                | Self::Wait { .. }
                | Self::ResultSummary { .. }
                | Self::ListJobs { .. }
        )
    }

    /// A detached dispatch worker runs unattended on a target; it may observe
    /// jobs but must not fan out further dispatches.
    pub fn ensure_allowed_in_dispatch_worker(&self) -> Result<(), String> {
        match self {
            Self::Submit { .. } => Err("detached_dispatch_nested_submit_unsupported: A detached dispatch job cannot dispatch further work; report the follow-up in the job result instead".into()),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn closed_requests_parse_documented_arguments_only() {
        let submit = DetachedDispatchControlRequest::from_operation(
            "submit",
            Some(&json!({
                "target": "MacBook-Pro-2.local",
                "prompt": "run the tests",
                "approvalPolicy": "reject-and-report",
                "workspacePath": "/repo",
            })),
        )
        .unwrap();
        assert!(!submit.is_readonly());
        assert!(submit.ensure_allowed_in_dispatch_worker().is_err());
        assert_eq!(submit.operation_id(), "submit");

        let submit_source = DetachedDispatchControlRequest::from_operation(
            "submit",
            Some(&json!({
                "target": "device:linux-box",
                "prompt": "build release",
                "approvalPolicy": "auto",
                "source": { "kind": "workspace", "workspaceId": "ws-1", "ref": "main" },
            })),
        )
        .unwrap();
        assert_eq!(submit_source.operation_id(), "submit");

        let submit_remote = DetachedDispatchControlRequest::from_operation(
            "submit",
            Some(&json!({
                "target": "device:win-box",
                "prompt": "build",
                "approvalPolicy": "remote",
                "workspacePath": "/repo",
            })),
        )
        .unwrap();
        assert_eq!(submit_remote.operation_id(), "submit");

        let list = DetachedDispatchControlRequest::from_operation("list-targets", None).unwrap();
        assert!(list.is_readonly());
        assert!(list.ensure_allowed_in_dispatch_worker().is_ok());

        let probe = DetachedDispatchControlRequest::from_operation(
            "probe",
            Some(&json!({"target": "device:linux-box", "workspaceId": "ws-1"})),
        )
        .unwrap();
        assert!(probe.is_readonly());

        let wait = DetachedDispatchControlRequest::from_operation(
            "wait",
            Some(&json!({"jobIds": ["j1", "j2"], "until": "all_terminal", "timeoutSeconds": 60})),
        )
        .unwrap();
        assert!(wait.is_readonly());

        let fetch = DetachedDispatchControlRequest::from_operation(
            "fetch-file",
            Some(&json!({
                "jobId": "j1",
                "remotePath": "target/release/app",
                "localPath": "/tmp/app-linux",
                "overwrite": true
            })),
        )
        .unwrap();
        assert!(!fetch.is_readonly());
        assert_eq!(fetch.operation_id(), "fetch-file");

        let answer_perm = DetachedDispatchControlRequest::from_operation(
            "answer",
            Some(&json!({"jobId": "j1", "requestId": "req-1", "reply": "once"})),
        )
        .unwrap();
        assert_eq!(answer_perm.operation_id(), "answer");

        let answer_question = DetachedDispatchControlRequest::from_operation(
            "answer",
            Some(&json!({"jobId": "j1", "requestId": "q-1", "answers": {"0": "yes"}})),
        )
        .unwrap();
        assert_eq!(answer_question.operation_id(), "answer");

        for (operation, arguments) in [
            (
                "submit",
                json!({"target":"a","prompt":"p","approvalPolicy":"auto"}),
            ),
            (
                "submit",
                json!({"target":"a","prompt":"p","approvalPolicy":"auto","workspacePath":"/r","source":{"kind":"workspace","workspaceId":"w"}}),
            ),
            ("wait", json!({"jobIds": []})),
            ("wait", json!({"jobIds": ["j1"], "timeoutSeconds": 9999})),
            ("answer", json!({"jobId": "j1", "requestId": "r1"})),
            (
                "answer",
                json!({"jobId": "j1", "requestId": "r1", "reply": "once", "answers": {"0": "a"}}),
            ),
            ("status", json!({"jobId":"j","token":"secret"})),
            ("cancel", json!({"operation":"submit","jobId":"j"})),
            ("delete", json!({})),
        ] {
            assert!(
                DetachedDispatchControlRequest::from_operation(operation, Some(&arguments))
                    .is_err(),
                "{operation} {arguments}"
            );
        }
    }

    #[test]
    fn controls_declare_risk_host_paths_and_cli_availability() {
        use crate::product_control::*;
        let registry = ProductControlRegistry::global();
        let capability = "feature.detached-dispatch";
        for (operation, risk) in [
            ("list-targets", ProductControlRisk::Read),
            ("probe", ProductControlRisk::Read),
            ("status", ProductControlRisk::Read),
            ("wait", ProductControlRisk::Read),
            ("result-summary", ProductControlRisk::Read),
            ("list-jobs", ProductControlRisk::Read),
            ("submit", ProductControlRisk::Execute),
            ("continue", ProductControlRisk::Execute),
            ("append", ProductControlRisk::Execute),
            ("answer", ProductControlRisk::Execute),
            ("sync-result", ProductControlRisk::Execute),
            ("publish-branch", ProductControlRisk::Execute),
            ("fetch-file", ProductControlRisk::Write),
            ("cancel", ProductControlRisk::Destructive),
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
                operation != "submit",
                "{operation}"
            );
        }
        let submit = registry.operation(capability, "submit").unwrap();
        let args = json!({"target":"mac","prompt":"p","approvalPolicy":"auto","workspacePath":"/host/repo"});
        validate_operation_arguments(&submit.input_schema, Some(&args)).unwrap();
        assert!(validate_operation_argument_scopes(submit, Some(&args), true).is_err());

        let fetch = registry.operation(capability, "fetch-file").unwrap();
        let fetch_args = json!({"jobId":"j1","remotePath":"dist/app","localPath":"/host/app"});
        validate_operation_arguments(&fetch.input_schema, Some(&fetch_args)).unwrap();
        assert!(validate_operation_argument_scopes(fetch, Some(&fetch_args), true).is_err());
    }
}
