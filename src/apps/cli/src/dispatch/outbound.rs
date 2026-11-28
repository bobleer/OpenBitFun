//! Controller side of Detached Dispatch for the CLI.
//!
//! `openbitfun dispatch outbound ...` submits jobs to another OpenBitFun host and
//! observes, continues, syncs, and fetches artifacts from them. The existing
//! `openbitfun dispatch <verb>` commands are the target protocol and stay
//! untouched. This module and the CLI's Agent product-control provider both run
//! the Core dispatch-control executor; they only supply this host's account
//! session and SSH manager.

use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Subcommand, ValueEnum};
use openbitfun_core::infrastructure::try_get_path_manager_arc;
use openbitfun_core::service::dispatch::{
    execute_dispatch_control, AccountRuntimeDispatchAccess, DispatchControlContext,
    OutboundDispatchStore,
};
use openbitfun_core::service::remote_connect::account_runtime::AccountRuntime;
use openbitfun_core::service::remote_connect::DeviceIdentity;
use openbitfun_product_domains::detached_dispatch_control::{
    DetachedDispatchApprovalPolicy, DetachedDispatchControlRequest,
    DetachedDispatchPermissionReply, DetachedDispatchSource, DetachedDispatchWaitUntil,
    DEFAULT_DISPATCH_WAIT_SECONDS, MAX_DETACHED_DISPATCH_PROMPT_BYTES,
};
use serde_json::Value;

#[derive(Subcommand, Debug)]
pub(crate) enum OutboundAction {
    /// List SSH connections and online account devices this machine can dispatch to
    Targets,
    /// Probe a target device or SSH host for OS, arch, CLI readiness, and capabilities
    Probe {
        /// Target: an account device name, `device:<deviceId>`, or `ssh:<connectionId>`
        #[arg(long)]
        target: String,
        /// Optional fleet workspace ID on the target device (`workspace_target_source_v1`)
        #[arg(long)]
        workspace_id: Option<String>,
    },
    /// Submit a detached job to another host and print its acknowledgement
    ///
    /// By default the job runs in a worktree on the target branched from the
    /// current Git checkout. Pass `--source-workspace` or `--source-remote` to
    /// provision directly on an account device without uploading a local bundle.
    Submit {
        /// Target: an account device name, `device:<deviceId>`, or `ssh:<connectionId>`
        #[arg(long)]
        target: String,
        /// How the target answers tool permission prompts while unattended
        #[arg(long, value_enum)]
        approval_policy: OutboundApprovalPolicy,
        /// Task prompt. If omitted, stdin is used when piped.
        prompt: Option<String>,
        /// Agent type on the target
        #[arg(short, long, default_value = "Standard")]
        agent: String,
        /// Model id on the target; defaults to the target's own default model
        #[arg(long)]
        model: Option<String>,
        /// Revision the target worktree starts from
        #[arg(long, default_value = "HEAD")]
        base_ref: String,
        /// Carry this checkout's uncommitted changes to the target
        #[arg(long)]
        include_uncommitted: bool,
        /// Short job title shown in job lists
        #[arg(long)]
        title: Option<String>,
        /// Git checkout to dispatch from; defaults to the current directory when no `--source-*` flag is given
        #[arg(long)]
        workspace: Option<std::path::PathBuf>,
        /// Provision directly from a workspace ID on the target device
        #[arg(long, conflicts_with_all = ["workspace", "source_remote"])]
        source_workspace: Option<String>,
        /// Provision directly from a Git remote URL fetched by the target device
        #[arg(long, conflicts_with_all = ["workspace", "source_workspace"])]
        source_remote: Option<String>,
    },
    /// Read a job's state and events after a cursor
    Status {
        job_id: String,
        /// Event cursor returned by a previous status call
        #[arg(long, default_value_t = 0)]
        cursor: u64,
        /// Request a compact summary without the event log when supported
        #[arg(long)]
        summary_only: bool,
    },
    /// Wait for one or more jobs to change state, block on a prompt, or reach terminal state
    Wait {
        /// Job IDs to watch
        #[arg(required = true)]
        job_ids: Vec<String>,
        /// Condition to stop waiting on
        #[arg(long, value_enum, default_value_t = OutboundWaitUntil::AllTerminal)]
        until: OutboundWaitUntil,
        /// Maximum seconds to wait (1..=600)
        #[arg(long, default_value_t = DEFAULT_DISPATCH_WAIT_SECONDS)]
        timeout: u32,
    },
    /// Read a structured summary (commits, diff numstat, last reply) for a job
    ResultSummary { job_id: String },
    /// Queue a follow-up turn on a finished job reusing its session and worktree
    Continue {
        job_id: String,
        /// Follow-up prompt. If omitted, stdin is used when piped.
        prompt: Option<String>,
        #[arg(long, value_enum)]
        approval_policy: Option<OutboundApprovalPolicy>,
        #[arg(long)]
        model: Option<String>,
    },
    /// Steer an active running turn with an appended message
    Append {
        job_id: String,
        /// Steering message. If omitted, stdin is used when piped.
        prompt: Option<String>,
    },
    /// Answer a pending permission request or user question on a job
    Answer {
        job_id: String,
        #[arg(long)]
        request_id: String,
        #[arg(long, value_enum)]
        reply: Option<OutboundPermissionReply>,
        #[arg(long)]
        feedback: Option<String>,
        /// JSON object of question answers (mutually exclusive with `--reply`)
        #[arg(long)]
        answers_json: Option<String>,
    },
    /// Synchronize Git-visible changes from a job back into this machine's baseline worktree
    SyncResult {
        job_id: String,
        #[arg(long)]
        message: Option<String>,
    },
    /// Stream a file or compiled binary from a job workspace/output root to a local file path
    FetchFile {
        job_id: String,
        #[arg(long)]
        remote_path: String,
        #[arg(long)]
        local_path: std::path::PathBuf,
        #[arg(long)]
        overwrite: bool,
        #[arg(long)]
        max_bytes: Option<u64>,
    },
    /// Push a finished account-device job branch to its Git remote
    PublishBranch {
        job_id: String,
        #[arg(long)]
        remote: Option<String>,
    },
    /// List jobs submitted from this machine, or the jobs a target owns
    List {
        /// Target to ask directly (same forms as `submit --target`)
        #[arg(long)]
        target: Option<String>,
    },
    /// Cancel a submitted job
    Cancel { job_id: String },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub(crate) enum OutboundApprovalPolicy {
    /// Approve every tool request that static rules do not deny
    Auto,
    /// Reject permission prompts and report them in the job result
    RejectAndReport,
    /// Park permission prompts in the target's mailbox until answered remotely
    Remote,
}

impl From<OutboundApprovalPolicy> for DetachedDispatchApprovalPolicy {
    fn from(policy: OutboundApprovalPolicy) -> Self {
        match policy {
            OutboundApprovalPolicy::Auto => Self::Auto,
            OutboundApprovalPolicy::RejectAndReport => Self::RejectAndReport,
            OutboundApprovalPolicy::Remote => Self::Remote,
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub(crate) enum OutboundWaitUntil {
    StateChange,
    AnyBlocked,
    AnyTerminal,
    AllTerminal,
}

impl From<OutboundWaitUntil> for DetachedDispatchWaitUntil {
    fn from(until: OutboundWaitUntil) -> Self {
        match until {
            OutboundWaitUntil::StateChange => Self::StateChange,
            OutboundWaitUntil::AnyBlocked => Self::AnyBlocked,
            OutboundWaitUntil::AnyTerminal => Self::AnyTerminal,
            OutboundWaitUntil::AllTerminal => Self::AllTerminal,
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub(crate) enum OutboundPermissionReply {
    Once,
    Always,
    Reject,
}

impl From<OutboundPermissionReply> for DetachedDispatchPermissionReply {
    fn from(reply: OutboundPermissionReply) -> Self {
        match reply {
            OutboundPermissionReply::Once => Self::Once,
            OutboundPermissionReply::Always => Self::Always,
            OutboundPermissionReply::Reject => Self::Reject,
        }
    }
}

pub(crate) async fn run(action: OutboundAction) -> Result<()> {
    let result = run_action(action).await;
    match result {
        Ok(value) => {
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        Err(error) => {
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &serde_json::json!({ "error": format!("{error:#}") })
                )?
            );
            Err(error)
        }
    }
}

async fn run_action(action: OutboundAction) -> Result<Value> {
    openbitfun_core::service::config::initialize_global_config()
        .await
        .context("initialize global config")?;
    let request = match action {
        OutboundAction::Targets => DetachedDispatchControlRequest::ListTargets,
        OutboundAction::Probe {
            target,
            workspace_id,
        } => DetachedDispatchControlRequest::Probe {
            target,
            workspace_id,
        },
        OutboundAction::Submit {
            target,
            approval_policy,
            prompt,
            agent,
            model,
            base_ref,
            include_uncommitted,
            title,
            workspace,
            source_workspace,
            source_remote,
        } => {
            let (workspace_path, source) = if let Some(workspace_id) = source_workspace {
                (
                    None,
                    Some(DetachedDispatchSource::Workspace {
                        workspace_id,
                        git_ref: Some(base_ref.clone()),
                    }),
                )
            } else if let Some(remote_url) = source_remote {
                (
                    None,
                    Some(DetachedDispatchSource::Remote {
                        remote_url,
                        git_ref: base_ref.clone(),
                    }),
                )
            } else {
                let workspace = match workspace {
                    Some(path) => path,
                    None => std::env::current_dir().context("resolve current directory")?,
                };
                let workspace = std::path::absolute(&workspace)
                    .with_context(|| format!("resolve workspace {}", workspace.display()))?;
                (
                    Some(
                        workspace
                            .to_str()
                            .ok_or_else(|| anyhow!("workspace path is not valid UTF-8"))?
                            .to_string(),
                    ),
                    None,
                )
            };
            DetachedDispatchControlRequest::Submit {
                target,
                prompt: resolve_prompt(prompt)?,
                approval_policy: approval_policy.into(),
                workspace_path,
                source,
                agent: Some(agent),
                model,
                base_ref: Some(base_ref),
                include_uncommitted,
                title,
            }
        }
        OutboundAction::Status {
            job_id,
            cursor,
            summary_only,
        } => DetachedDispatchControlRequest::Status {
            job_id,
            cursor,
            summary_only,
        },
        OutboundAction::Wait {
            job_ids,
            until,
            timeout,
        } => DetachedDispatchControlRequest::Wait {
            job_ids,
            until: until.into(),
            timeout_seconds: timeout,
        },
        OutboundAction::ResultSummary { job_id } => {
            DetachedDispatchControlRequest::ResultSummary { job_id }
        }
        OutboundAction::Continue {
            job_id,
            prompt,
            approval_policy,
            model,
        } => DetachedDispatchControlRequest::Continue {
            job_id,
            prompt: resolve_prompt(prompt)?,
            approval_policy: approval_policy.map(Into::into),
            model,
        },
        OutboundAction::Append { job_id, prompt } => DetachedDispatchControlRequest::Append {
            job_id,
            prompt: resolve_prompt(prompt)?,
        },
        OutboundAction::Answer {
            job_id,
            request_id,
            reply,
            feedback,
            answers_json,
        } => {
            let answers = answers_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .context("parse --answers-json")?;
            let req = DetachedDispatchControlRequest::Answer {
                job_id,
                request_id,
                reply: reply.map(Into::into),
                feedback,
                answers,
            };
            req.validate().map_err(anyhow::Error::msg)?;
            req
        }
        OutboundAction::SyncResult { job_id, message } => {
            DetachedDispatchControlRequest::SyncResult { job_id, message }
        }
        OutboundAction::FetchFile {
            job_id,
            remote_path,
            local_path,
            overwrite,
            max_bytes,
        } => {
            let local_path = std::path::absolute(&local_path)
                .with_context(|| format!("resolve local_path {}", local_path.display()))?;
            let local_path = local_path
                .to_str()
                .ok_or_else(|| anyhow!("local_path is not valid UTF-8"))?
                .to_string();
            let req = DetachedDispatchControlRequest::FetchFile {
                job_id,
                remote_path,
                local_path,
                overwrite,
                max_bytes,
            };
            req.validate().map_err(anyhow::Error::msg)?;
            req
        }
        OutboundAction::PublishBranch { job_id, remote } => {
            DetachedDispatchControlRequest::PublishBranch { job_id, remote }
        }
        OutboundAction::List { target } => DetachedDispatchControlRequest::ListJobs { target },
        OutboundAction::Cancel { job_id } => DetachedDispatchControlRequest::Cancel { job_id },
    };
    let account = crate::account::build_management_account_runtime();
    account.try_restore_session().await;
    execute_for_host(account, request).await
}

/// Run one dispatch-control request with this host's account and SSH manager.
pub(crate) async fn execute_for_host(
    account: Arc<AccountRuntime>,
    request: DetachedDispatchControlRequest,
) -> Result<Value> {
    let path_manager = try_get_path_manager_arc().context("resolve OpenBitFun data directory")?;
    let store = OutboundDispatchStore::new(path_manager.as_ref());
    let access = AccountRuntimeDispatchAccess::new(account);
    let ssh = match openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services().await
    {
        Ok(state) => state
            .get_ssh_manager()
            .await
            .ok_or_else(|| "SSH manager is unavailable".to_string()),
        Err(error) => Err(error),
    };
    let context = DispatchControlContext {
        store: &store,
        ssh,
        account: Some(&access),
        local_device_id: DeviceIdentity::from_current_machine()
            .map(|identity| identity.device_id)
            .ok(),
    };
    execute_dispatch_control(&context, request).await
}

fn resolve_prompt(prompt: Option<String>) -> Result<String> {
    use std::io::{IsTerminal, Read};
    let prompt = match prompt {
        Some(prompt) => prompt,
        None => {
            let stdin = std::io::stdin();
            if stdin.is_terminal() {
                bail!("Provide a prompt argument or pipe it on stdin");
            }
            let mut raw = String::new();
            stdin
                .take(MAX_DETACHED_DISPATCH_PROMPT_BYTES as u64 + 1)
                .read_to_string(&mut raw)
                .context("read dispatch prompt from stdin")?;
            raw
        }
    };
    if prompt.trim().is_empty() {
        bail!("Dispatch prompt cannot be empty");
    }
    Ok(prompt)
}
