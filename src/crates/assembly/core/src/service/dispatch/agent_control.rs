//! Agent-facing Detached Dispatch controller shared by every product host.
//!
//! Desktop and CLI bind the `detached-dispatch` product-control provider to
//! [`execute_dispatch_control`]; the CLI `dispatch outbound` command reuses the
//! same target resolution and execution engine. Hosts supply only their account
//! session and SSH manager, so device discovery, target resolution, job
//! lifecycle, artifact streaming, and routing cannot drift.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use async_trait::async_trait;
use base64::Engine as _;
use openbitfun_product_domains::detached_dispatch_control::{
    DetachedDispatchControlRequest, DetachedDispatchPermissionReply, DetachedDispatchWaitUntil,
    DEFAULT_DISPATCH_FETCH_MAX_BYTES, HARD_MAX_DISPATCH_FETCH_BYTES,
    MAX_DETACHED_DISPATCH_PROMPT_BYTES,
};
use openbitfun_services_core::dispatch_contract::{
    DispatchFileChunkRequest, DISPATCH_FILE_CHUNK_MAX_BYTES,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    answer_device_dispatch, answer_device_questions, answer_dispatch, append_device_dispatch,
    append_dispatch, cancel_device_dispatch, cancel_dispatch, continue_device_dispatch_job,
    continue_dispatch_job, get_device_dispatch_status, get_dispatch_status,
    list_device_dispatch_jobs, list_dispatch_jobs, list_dispatch_targets,
    probe_device_with_workspace, probe_dispatch_target, publish_device_branch,
    query_device_dispatch_job, query_dispatch_job, status_device_summary, submit_device_dispatch,
    submit_device_from_source, submit_dispatch, sync_device_dispatch_result, sync_dispatch_result,
    AccountRuntimeDeviceDispatchRpc, DeviceDispatchRpc, DispatchAnswerRequest,
    DispatchAppendRequest, DispatchContinueRequest, DispatchJobRequest, DispatchListJobsRequest,
    DispatchListTargetsRequest, DispatchPermissionReplyKind, DispatchProbeTargetRequest,
    DispatchQueryJobRequest, DispatchStatusRequest, DispatchSubmitRequest,
    DispatchSyncResultRequest, DispatchTarget, DispatchTargetRequest, OutboundDispatchStore,
};
use crate::service::remote_connect::account_runtime::{AccountDevice, AccountRuntime};
use crate::service::remote_ssh::SSHConnectionManager;

/// The executing host's account session, as seen by the dispatch controller.
#[async_trait]
pub trait DispatchAccountAccess: Send + Sync {
    /// Every device on the account, this host included. Errors when signed out.
    async fn list_devices(&self) -> anyhow::Result<Vec<AccountDevice>>;
    fn device_rpc(&self) -> Arc<dyn DeviceDispatchRpc>;
}

/// [`DispatchAccountAccess`] over a Core [`AccountRuntime`].
pub struct AccountRuntimeDispatchAccess {
    account: Arc<AccountRuntime>,
}

impl AccountRuntimeDispatchAccess {
    pub fn new(account: Arc<AccountRuntime>) -> Self {
        Self { account }
    }
}

#[async_trait]
impl DispatchAccountAccess for AccountRuntimeDispatchAccess {
    async fn list_devices(&self) -> anyhow::Result<Vec<AccountDevice>> {
        if !self.account.is_logged_in().await {
            bail!("This host is not signed in to an OpenBitFun account");
        }
        self.account.list_devices().await
    }

    fn device_rpc(&self) -> Arc<dyn DeviceDispatchRpc> {
        Arc::new(AccountRuntimeDeviceDispatchRpc::new(self.account.clone()))
    }
}

/// Host resources for one dispatch-control call.
pub struct DispatchControlContext<'a> {
    pub store: &'a OutboundDispatchStore,
    /// `Err` carries why SSH targets are unavailable on this host.
    pub ssh: Result<SSHConnectionManager, String>,
    /// `None` when this host has no account runtime at all.
    pub account: Option<&'a dyn DispatchAccountAccess>,
    /// This host's device identity, used to mark and exclude itself.
    pub local_device_id: Option<String>,
}

/// A target resolved from a user- or Agent-supplied selector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedDispatchTarget {
    Device {
        device_id: String,
        display_name: String,
    },
    Ssh {
        connection_id: String,
    },
}

impl ResolvedDispatchTarget {
    pub fn request(&self) -> DispatchTargetRequest {
        // The target chooses where its worktree lands.
        match self {
            Self::Device { device_id, .. } => DispatchTargetRequest::Device {
                device_id: device_id.clone(),
                workspace_path: String::new(),
            },
            Self::Ssh { connection_id } => DispatchTargetRequest::Ssh {
                connection_id: connection_id.clone(),
                workspace_path: String::new(),
            },
        }
    }
}

pub fn device_label(device: &AccountDevice) -> String {
    device
        .device_alias
        .as_deref()
        .map(str::trim)
        .filter(|alias| !alias.is_empty())
        .unwrap_or(&device.device_name)
        .to_string()
}

/// Resolve `ssh:<connectionId>`, `device:<deviceId>`, a device ID, or an
/// exact (case-insensitive) device name or alias. `devices` must already
/// exclude this host. Names must match exactly one device.
pub fn resolve_dispatch_target(
    selector: &str,
    devices: &[AccountDevice],
) -> anyhow::Result<ResolvedDispatchTarget> {
    let selector = selector.trim();
    if let Some(connection_id) = selector.strip_prefix("ssh:") {
        let connection_id = connection_id.trim();
        if connection_id.is_empty() {
            bail!("ssh: targets need a saved connection id");
        }
        return Ok(ResolvedDispatchTarget::Ssh {
            connection_id: connection_id.to_string(),
        });
    }
    let matches: Vec<&AccountDevice> = match selector.strip_prefix("device:") {
        Some(device_id) => devices
            .iter()
            .filter(|device| device.device_id == device_id.trim())
            .collect(),
        None => {
            let by_id: Vec<_> = devices
                .iter()
                .filter(|device| device.device_id == selector)
                .collect();
            if by_id.is_empty() {
                devices
                    .iter()
                    .filter(|device| {
                        device.device_name.eq_ignore_ascii_case(selector)
                            || device
                                .device_alias
                                .as_deref()
                                .is_some_and(|alias| alias.trim().eq_ignore_ascii_case(selector))
                    })
                    .collect()
            } else {
                by_id
            }
        }
    };
    match matches.as_slice() {
        [device] if device.online => Ok(ResolvedDispatchTarget::Device {
            device_id: device.device_id.clone(),
            display_name: device_label(device),
        }),
        [_] => bail!("Dispatch device {selector} is offline; no local fallback was attempted"),
        [] => bail!(
            "No other device on this account matches {selector}; list targets first and use a device name, device:<deviceId>, or ssh:<connectionId>"
        ),
        _ => bail!("Several account devices match {selector}; use device:<deviceId>"),
    }
}

fn device_json(device: &AccountDevice, local_device_id: Option<&str>) -> Value {
    json!({
        "deviceId": device.device_id,
        "name": device_label(device),
        "deviceName": device.device_name,
        "alias": device.device_alias,
        "kind": device.device_kind,
        "online": device.online,
        "isCurrentDevice": local_device_id == Some(device.device_id.as_str()),
        "model": device.device_model,
        "os": device.device_os,
        "osVersion": device.device_os_version,
        "compatible": device.compatible,
    })
}

fn is_terminal_state(state: &str) -> bool {
    matches!(
        state,
        "completed" | "failed" | "cancelled" | "canceled" | "succeeded" | "done"
    )
}

fn pending_count(response: &Value, key: &str) -> usize {
    response
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn to_permission_reply(reply: DetachedDispatchPermissionReply) -> DispatchPermissionReplyKind {
    match reply {
        DetachedDispatchPermissionReply::Once => DispatchPermissionReplyKind::Once,
        DetachedDispatchPermissionReply::Always => DispatchPermissionReplyKind::Always,
        DetachedDispatchPermissionReply::Reject => DispatchPermissionReplyKind::Reject,
    }
}

struct TempFileGuard {
    path: std::path::PathBuf,
    committed: bool,
}

impl TempFileGuard {
    fn new(path: std::path::PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl DispatchControlContext<'_> {
    fn account(&self) -> anyhow::Result<&dyn DispatchAccountAccess> {
        self.account
            .ok_or_else(|| anyhow!("This host has no OpenBitFun account runtime"))
    }

    fn ssh(&self) -> anyhow::Result<&SSHConnectionManager> {
        self.ssh
            .as_ref()
            .map_err(|error| anyhow!("SSH dispatch is unavailable: {error}"))
    }

    /// Account devices other than this host.
    async fn other_devices(&self) -> anyhow::Result<Vec<AccountDevice>> {
        let local = self.local_device_id.as_deref();
        Ok(self
            .account()?
            .list_devices()
            .await?
            .into_iter()
            .filter(|device| local != Some(device.device_id.as_str()))
            .collect())
    }

    pub async fn resolve_target(&self, selector: &str) -> anyhow::Result<ResolvedDispatchTarget> {
        if selector.trim().starts_with("ssh:") {
            return resolve_dispatch_target(selector, &[]);
        }
        resolve_dispatch_target(selector, &self.other_devices().await?)
    }

    async fn job_targets_device(&self, job_id: &str) -> anyhow::Result<bool> {
        let record = self
            .store
            .get(job_id)
            .await?
            .ok_or_else(|| anyhow!("No dispatch job {job_id} was submitted from this host"))?;
        Ok(matches!(record.target, DispatchTarget::Device { .. }))
    }

    async fn fetch_job_status_snapshot(&self, job_id: &str) -> anyhow::Result<Value> {
        let is_device = self.job_targets_device(job_id).await?;
        if is_device {
            let rpc = self.account()?.device_rpc();
            status_device_summary(rpc.as_ref(), self.store, job_id).await
        } else {
            let cursor = self
                .store
                .get(job_id)
                .await?
                .map(|record| record.last_cursor)
                .unwrap_or(0);
            get_dispatch_status(
                self.ssh()?,
                self.store,
                DispatchStatusRequest {
                    job_id: job_id.to_string(),
                    cursor,
                },
            )
            .await
        }
    }

    async fn query_job(&self, request: DispatchQueryJobRequest) -> anyhow::Result<Value> {
        if self.job_targets_device(&request.job_id).await? {
            let rpc = self.account()?.device_rpc();
            query_device_dispatch_job(rpc.as_ref(), self.store, request).await
        } else {
            query_dispatch_job(self.ssh()?, self.store, request).await
        }
    }

    async fn list_targets(&self) -> Value {
        let local = self.local_device_id.as_deref();
        let mut result = json!({
            "submitTargetForms": ["<device name or alias>", "device:<deviceId>", "ssh:<connectionId>"],
        });
        match self.account() {
            Ok(account) => match account.list_devices().await {
                Ok(devices) => {
                    let others = devices
                        .iter()
                        .filter(|device| local != Some(device.device_id.as_str()));
                    result["signedIn"] = json!(true);
                    result["deviceCount"] = json!(devices.len());
                    result["otherOnlineDeviceCount"] =
                        json!(others.filter(|device| device.online).count());
                    result["devices"] = devices
                        .iter()
                        .map(|device| device_json(device, local))
                        .collect();
                }
                Err(error) => {
                    result["signedIn"] = json!(false);
                    result["devices"] = json!([]);
                    result["devicesUnavailable"] = json!(format!("{error:#}"));
                }
            },
            Err(error) => {
                result["signedIn"] = json!(false);
                result["devices"] = json!([]);
                result["devicesUnavailable"] = json!(error.to_string());
            }
        }
        match self.ssh() {
            Ok(ssh) => {
                match list_dispatch_targets(ssh, DispatchListTargetsRequest::default()).await {
                    Ok(targets) => {
                        result["sshTargets"] = targets
                            .into_iter()
                            .filter(|target| target.kind == "ssh")
                            .map(|target| {
                                json!({
                                    "target": format!("ssh:{}", target.connection_id.clone().unwrap_or_default()),
                                    "connectionId": target.connection_id,
                                    "name": target.display_name,
                                    "description": target.description,
                                })
                            })
                            .collect();
                    }
                    Err(error) => {
                        result["sshTargets"] = json!([]);
                        result["sshUnavailable"] = json!(format!("{error:#}"));
                    }
                }
            }
            Err(error) => {
                result["sshTargets"] = json!([]);
                result["sshUnavailable"] = json!(error.to_string());
            }
        }
        result
    }

    async fn fetch_file(
        &self,
        job_id: &str,
        remote_path: &str,
        local_path: &str,
        overwrite: bool,
        max_bytes: Option<u64>,
    ) -> anyhow::Result<Value> {
        let dest = Path::new(local_path.trim());
        if !dest.is_absolute() {
            bail!("localPath must be an absolute file path on this host");
        }
        if dest.is_dir() {
            bail!(
                "localPath ({}) is an existing directory; pass the destination file path",
                dest.display()
            );
        }
        if dest.exists() && !overwrite {
            bail!(
                "Destination file already exists ({}); pass overwrite: true to replace it",
                dest.display()
            );
        }
        let max_bytes = max_bytes
            .unwrap_or(DEFAULT_DISPATCH_FETCH_MAX_BYTES)
            .min(HARD_MAX_DISPATCH_FETCH_BYTES);
        if max_bytes == 0 {
            bail!("maxBytes must be greater than zero");
        }

        let parent = dest
            .parent()
            .ok_or_else(|| anyhow!("localPath has no parent directory"))?;
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create destination directory {}", parent.display()))?;

        let file_name = dest
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("artifact");
        let temp_path = parent.join(format!(".{file_name}.{}.part", uuid::Uuid::new_v4()));
        let mut temp_guard = TempFileGuard::new(temp_path.clone());
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .with_context(|| format!("create staging file {}", temp_path.display()))?;

        let mut offset = 0_u64;
        let mut expected_revision: Option<String> = None;
        let mut total_size: Option<u64> = None;
        let mut mime_type = String::new();
        let mut resolved_remote_path = remote_path.to_string();
        let mut chunks = 0_u64;
        let mut hasher = Sha256::new();

        loop {
            let chunk = self
                .query_job(DispatchQueryJobRequest {
                    job_id: job_id.to_string(),
                    kind: "readFileChunk".to_string(),
                    file_path: Some(remote_path.to_string()),
                    file_chunk: Some(DispatchFileChunkRequest {
                        offset,
                        limit: DISPATCH_FILE_CHUNK_MAX_BYTES,
                        expected_revision: expected_revision.clone(),
                    }),
                })
                .await?;

            let reported_total = chunk
                .get("totalSize")
                .and_then(Value::as_u64)
                .ok_or_else(|| anyhow!("Target chunk response omitted totalSize"))?;
            if reported_total > max_bytes {
                bail!(
                    "Remote file ({reported_total} bytes) exceeds maxBytes ({max_bytes} bytes); pass a larger maxBytes (up to {HARD_MAX_DISPATCH_FETCH_BYTES}) if intentional"
                );
            }
            if let Some(prev_total) = total_size {
                if reported_total != prev_total {
                    bail!(
                        "Remote file size changed during transfer ({prev_total} -> {reported_total})"
                    );
                }
            } else {
                total_size = Some(reported_total);
                if let Some(mime) = chunk.get("mimeType").and_then(Value::as_str) {
                    mime_type = mime.to_string();
                }
                if let Some(path) = chunk.get("filePath").and_then(Value::as_str) {
                    resolved_remote_path = path.to_string();
                }
            }
            let revision = chunk
                .get("revision")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Target chunk response omitted revision"))?;
            match &expected_revision {
                None => expected_revision = Some(revision.to_string()),
                Some(expected) if expected != revision => {
                    bail!("Remote file revision changed during transfer; retry after the remote command finishes");
                }
                _ => {}
            }
            let encoded = chunk
                .get("contentBase64")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("Target chunk response omitted contentBase64"))?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .context("decode remote file chunk base64")?;
            let reported_chunk_size = chunk
                .get("chunkSize")
                .and_then(Value::as_u64)
                .unwrap_or(decoded.len() as u64);
            if decoded.len() as u64 != reported_chunk_size {
                bail!(
                    "Decoded chunk size ({}) did not match reported chunkSize ({reported_chunk_size})",
                    decoded.len()
                );
            }
            if reported_total > 0 && decoded.is_empty() && offset < reported_total {
                bail!("Remote file transfer stalled at offset {offset} of {reported_total}");
            }
            let next_offset = offset
                .checked_add(decoded.len() as u64)
                .ok_or_else(|| anyhow!("File offset overflow"))?;
            if next_offset > reported_total {
                bail!("Target returned more bytes than declared totalSize ({reported_total})");
            }
            if !decoded.is_empty() {
                output
                    .write_all(&decoded)
                    .with_context(|| format!("write staging file {}", temp_path.display()))?;
                hasher.update(&decoded);
            }
            offset = next_offset;
            chunks += 1;
            if offset >= reported_total {
                break;
            }
        }

        output
            .sync_all()
            .with_context(|| format!("flush staging file {}", temp_path.display()))?;
        drop(output);

        if dest.exists() && overwrite {
            // Windows rename does not replace an existing destination file.
            #[cfg(windows)]
            std::fs::remove_file(dest)
                .with_context(|| format!("remove existing destination {}", dest.display()))?;
        }
        std::fs::rename(&temp_path, dest).with_context(|| {
            format!(
                "move downloaded artifact into place ({} -> {})",
                temp_path.display(),
                dest.display()
            )
        })?;
        temp_guard.commit();

        let sha256 = format!("{:x}", hasher.finalize());
        Ok(json!({
            "jobId": job_id,
            "remotePath": remote_path,
            "resolvedRemotePath": resolved_remote_path,
            "localPath": dest.to_string_lossy(),
            "size": total_size.unwrap_or(0),
            "sha256": sha256,
            "mimeType": mime_type,
            "revision": expected_revision,
            "chunks": chunks,
        }))
    }
}

/// Execute one Agent-facing dispatch-control request on this host.
pub async fn execute_dispatch_control(
    context: &DispatchControlContext<'_>,
    request: DetachedDispatchControlRequest,
) -> anyhow::Result<Value> {
    match request {
        DetachedDispatchControlRequest::ListTargets => Ok(context.list_targets().await),
        DetachedDispatchControlRequest::Probe {
            target,
            workspace_id,
        } => {
            let resolved = context.resolve_target(&target).await?;
            match &resolved {
                ResolvedDispatchTarget::Device {
                    device_id,
                    display_name,
                } => {
                    let rpc = context.account()?.device_rpc();
                    let probe = probe_device_with_workspace(
                        rpc.as_ref(),
                        device_id,
                        workspace_id.as_deref(),
                    )
                    .await?;
                    Ok(json!({
                        "target": {"kind": "device", "deviceId": device_id, "name": display_name},
                        "probe": probe,
                    }))
                }
                ResolvedDispatchTarget::Ssh { connection_id } => {
                    if workspace_id.is_some() {
                        bail!("workspaceId probe is only supported on account device targets");
                    }
                    let probe = probe_dispatch_target(
                        context.ssh()?,
                        DispatchProbeTargetRequest {
                            target: resolved.request(),
                        },
                    )
                    .await?;
                    Ok(json!({
                        "target": {"kind": "ssh", "connectionId": connection_id},
                        "probe": probe,
                    }))
                }
            }
        }
        DetachedDispatchControlRequest::Submit {
            target,
            prompt,
            approval_policy,
            workspace_path,
            source,
            agent,
            model,
            base_ref,
            include_uncommitted,
            title,
        } => {
            if prompt.trim().is_empty() {
                bail!("Dispatch prompt cannot be empty");
            }
            if prompt.len() > MAX_DETACHED_DISPATCH_PROMPT_BYTES {
                bail!("Dispatch prompt exceeds the 32 KiB request limit");
            }
            let resolved = context.resolve_target(&target).await?;
            let job_id = uuid::Uuid::new_v4().to_string();
            let session_id = uuid::Uuid::new_v4().to_string();
            let agent_type = openbitfun_core_types::agent_identity::canonical_agent_id(
                agent.as_deref().unwrap_or("Standard"),
            )
            .to_string();

            let ack = if let Some(source) = source {
                let ResolvedDispatchTarget::Device { display_name, .. } = &resolved else {
                    bail!(
                        "source-based dispatch (workspace/remote/job) is only supported on account device targets; SSH targets require workspacePath"
                    );
                };
                let request = DispatchSubmitRequest {
                    target: resolved.request(),
                    base_ref: None,
                    include_uncommitted: false,
                    job_id: job_id.clone(),
                    session_id: session_id.clone(),
                    agent_type,
                    prompt,
                    approval_policy: approval_policy.wire().to_string(),
                    model,
                    reasoning_preset: None,
                    title,
                    source_workspace_path: None,
                    source_workspace_id: None,
                    attachments: Vec::new(),
                };
                let rpc = context.account()?.device_rpc();
                submit_device_from_source(
                    rpc.as_ref(),
                    context.store,
                    display_name.clone(),
                    source,
                    request,
                )
                .await?
            } else {
                let workspace_path = workspace_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| anyhow!("Submit requires either workspacePath or source"))?;
                let workspace = Path::new(workspace_path);
                if !workspace.is_absolute() {
                    bail!("workspacePath must be an absolute path on this host");
                }
                let workspace = workspace
                    .canonicalize()
                    .map_err(|error| anyhow!("resolve workspacePath: {error}"))?;
                let source_workspace_path = workspace
                    .to_str()
                    .ok_or_else(|| anyhow!("workspacePath is not valid UTF-8"))?
                    .to_string();
                let request = DispatchSubmitRequest {
                    target: resolved.request(),
                    base_ref: Some(base_ref.unwrap_or_else(|| "HEAD".to_string())),
                    include_uncommitted,
                    job_id: job_id.clone(),
                    session_id: session_id.clone(),
                    agent_type,
                    prompt,
                    approval_policy: approval_policy.wire().to_string(),
                    model,
                    reasoning_preset: None,
                    title,
                    source_workspace_path: Some(source_workspace_path),
                    source_workspace_id: None,
                    attachments: Vec::new(),
                };
                match &resolved {
                    ResolvedDispatchTarget::Device { display_name, .. } => {
                        let rpc = context.account()?.device_rpc();
                        submit_device_dispatch(
                            rpc.as_ref(),
                            context.store,
                            display_name.clone(),
                            request,
                        )
                        .await?
                    }
                    ResolvedDispatchTarget::Ssh { .. } => {
                        submit_dispatch(context.ssh()?, context.store, request).await?
                    }
                }
            };

            let target = match &resolved {
                ResolvedDispatchTarget::Device {
                    device_id,
                    display_name,
                } => json!({"kind":"device", "deviceId": device_id, "name": display_name}),
                ResolvedDispatchTarget::Ssh { connection_id } => {
                    json!({"kind":"ssh", "connectionId": connection_id})
                }
            };
            Ok(json!({
                "jobId": job_id,
                "sessionId": session_id,
                "target": target,
                "acknowledgement": ack,
                "nextStep": "Use wait or status with this jobId to follow progress; use result-summary, sync-result, or fetch-file once work completes.",
            }))
        }
        DetachedDispatchControlRequest::Status {
            job_id,
            cursor,
            summary_only,
        } => {
            if summary_only && context.job_targets_device(&job_id).await? {
                let rpc = context.account()?.device_rpc();
                return status_device_summary(rpc.as_ref(), context.store, &job_id).await;
            }
            let request = DispatchStatusRequest { job_id, cursor };
            if context.job_targets_device(&request.job_id).await? {
                let rpc = context.account()?.device_rpc();
                get_device_dispatch_status(rpc.as_ref(), context.store, request).await
            } else {
                get_dispatch_status(context.ssh()?, context.store, request).await
            }
        }
        DetachedDispatchControlRequest::Wait {
            job_ids,
            until,
            timeout_seconds,
        } => {
            let started = Instant::now();
            let deadline = started + Duration::from_secs(u64::from(timeout_seconds));
            let mut initial_states: BTreeMap<String, String> = BTreeMap::new();
            let mut poll_delay = Duration::from_millis(500);
            let mut first_pass = true;

            loop {
                let mut snapshots = Vec::with_capacity(job_ids.len());
                let mut any_changed = false;
                let mut any_blocked = false;
                let mut any_terminal = false;
                let mut all_terminal = true;

                for job_id in &job_ids {
                    let status = context.fetch_job_status_snapshot(job_id).await?;
                    let state = status
                        .get("state")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string();
                    let pending_permissions = pending_count(&status, "pendingPermissions");
                    let pending_questions = pending_count(&status, "pendingQuestions");
                    let blocked = pending_permissions > 0 || pending_questions > 0;
                    let terminal = is_terminal_state(&state);

                    if first_pass {
                        initial_states.insert(job_id.clone(), state.clone());
                    } else if initial_states.get(job_id).map(String::as_str) != Some(state.as_str())
                    {
                        any_changed = true;
                    }
                    if blocked {
                        any_blocked = true;
                    }
                    if terminal {
                        any_terminal = true;
                    } else {
                        all_terminal = false;
                    }
                    snapshots.push(json!({
                        "jobId": job_id,
                        "state": state,
                        "terminal": terminal,
                        "blocked": blocked,
                        "pendingPermissions": status.get("pendingPermissions").cloned().unwrap_or_else(|| json!([])),
                        "pendingQuestions": status.get("pendingQuestions").cloned().unwrap_or_else(|| json!([])),
                        "error": status.get("error").cloned().unwrap_or(Value::Null),
                    }));
                }

                let satisfied = match until {
                    DetachedDispatchWaitUntil::StateChange => {
                        any_changed || any_blocked || any_terminal
                    }
                    DetachedDispatchWaitUntil::AnyBlocked => any_blocked || all_terminal,
                    DetachedDispatchWaitUntil::AnyTerminal => any_terminal || any_blocked,
                    DetachedDispatchWaitUntil::AllTerminal => all_terminal || any_blocked,
                };
                if satisfied || Instant::now() >= deadline {
                    return Ok(json!({
                        "satisfied": satisfied,
                        "timedOut": !satisfied,
                        "elapsedMs": started.elapsed().as_millis() as u64,
                        "allTerminal": all_terminal,
                        "anyBlocked": any_blocked,
                        "jobs": snapshots,
                    }));
                }
                first_pass = false;
                let remaining = deadline.saturating_duration_since(Instant::now());
                tokio::time::sleep(poll_delay.min(remaining)).await;
                poll_delay = (poll_delay * 2).min(Duration::from_secs(2));
            }
        }
        DetachedDispatchControlRequest::ResultSummary { job_id } => {
            match context
                .query_job(DispatchQueryJobRequest {
                    job_id: job_id.clone(),
                    kind: "resultSummary".to_string(),
                    file_path: None,
                    file_chunk: None,
                })
                .await
            {
                Ok(summary) => Ok(summary),
                Err(error) => {
                    // Older targets without `query_result_summary_v1` still answer `status`.
                    let status = context.fetch_job_status_snapshot(&job_id).await?;
                    Ok(json!({
                        "jobId": job_id,
                        "fallback": true,
                        "summaryUnavailableReason": format!("{error:#}"),
                        "state": status.get("state").cloned().unwrap_or(Value::Null),
                        "error": status.get("error").cloned().unwrap_or(Value::Null),
                        "pendingPermissions": status.get("pendingPermissions").cloned().unwrap_or_else(|| json!([])),
                        "pendingQuestions": status.get("pendingQuestions").cloned().unwrap_or_else(|| json!([])),
                    }))
                }
            }
        }
        DetachedDispatchControlRequest::Continue {
            job_id,
            prompt,
            approval_policy,
            model,
        } => {
            let request = DispatchContinueRequest {
                job_id,
                turn_id: uuid::Uuid::new_v4().to_string(),
                prompt,
                display_content: None,
                model,
                reasoning_preset: None,
                approval_policy: approval_policy.map(|policy| policy.wire().to_string()),
                kind: None,
                attachments: Vec::new(),
            };
            if context.job_targets_device(&request.job_id).await? {
                let rpc = context.account()?.device_rpc();
                continue_device_dispatch_job(rpc.as_ref(), context.store, request).await
            } else {
                continue_dispatch_job(context.ssh()?, context.store, request).await
            }
        }
        DetachedDispatchControlRequest::Append { job_id, prompt } => {
            let request = DispatchAppendRequest {
                job_id,
                message_id: uuid::Uuid::new_v4().to_string(),
                content: prompt,
                display_content: None,
                attachments: Vec::new(),
            };
            if context.job_targets_device(&request.job_id).await? {
                let rpc = context.account()?.device_rpc();
                append_device_dispatch(rpc.as_ref(), context.store, request).await
            } else {
                append_dispatch(context.ssh()?, context.store, request).await
            }
        }
        DetachedDispatchControlRequest::Answer {
            job_id,
            request_id,
            reply,
            feedback,
            answers,
        } => {
            if let Some(answers) = answers {
                if context.job_targets_device(&job_id).await? {
                    let rpc = context.account()?.device_rpc();
                    answer_device_questions(
                        rpc.as_ref(),
                        context.store,
                        &job_id,
                        &request_id,
                        answers,
                    )
                    .await
                } else {
                    let record = context.store.get(&job_id).await?.ok_or_else(|| {
                        anyhow!("No dispatch job {job_id} was submitted from this host")
                    })?;
                    let DispatchTarget::Ssh { connection_id, .. } = &record.target else {
                        bail!("Dispatch job {job_id} is not bound to an SSH target");
                    };
                    openbitfun_services_integrations::remote_ssh::dispatch_ssh::answer(
                        context.ssh()?,
                        connection_id,
                        &json!({
                            "jobId": job_id,
                            "requestId": request_id,
                            "answers": answers,
                        }),
                    )
                    .await
                }
            } else {
                let reply = reply.ok_or_else(|| {
                    anyhow!("Answer requires reply (permissions) or answers (user questions)")
                })?;
                let request = DispatchAnswerRequest {
                    job_id,
                    request_id,
                    reply: to_permission_reply(reply),
                    feedback,
                };
                if context.job_targets_device(&request.job_id).await? {
                    let rpc = context.account()?.device_rpc();
                    answer_device_dispatch(rpc.as_ref(), context.store, request).await
                } else {
                    answer_dispatch(context.ssh()?, context.store, request).await
                }
            }
        }
        DetachedDispatchControlRequest::SyncResult { job_id, message } => {
            let request = DispatchSyncResultRequest { job_id, message };
            if context.job_targets_device(&request.job_id).await? {
                let rpc = context.account()?.device_rpc();
                sync_device_dispatch_result(rpc.as_ref(), context.store, request).await
            } else {
                sync_dispatch_result(context.ssh()?, context.store, request).await
            }
        }
        DetachedDispatchControlRequest::FetchFile {
            job_id,
            remote_path,
            local_path,
            overwrite,
            max_bytes,
        } => {
            context
                .fetch_file(&job_id, &remote_path, &local_path, overwrite, max_bytes)
                .await
        }
        DetachedDispatchControlRequest::PublishBranch { job_id, remote } => {
            if !context.job_targets_device(&job_id).await? {
                bail!("publish-branch is currently supported for account-device dispatch jobs (`workspace_publish_v1`); for SSH jobs sync the result locally or push from the job");
            }
            let rpc = context.account()?.device_rpc();
            publish_device_branch(rpc.as_ref(), context.store, &job_id, remote.as_deref()).await
        }
        DetachedDispatchControlRequest::Cancel { job_id } => {
            let request = DispatchJobRequest { job_id };
            if context.job_targets_device(&request.job_id).await? {
                let rpc = context.account()?.device_rpc();
                cancel_device_dispatch(rpc.as_ref(), context.store, request).await
            } else {
                cancel_dispatch(context.ssh()?, context.store, request).await
            }
        }
        DetachedDispatchControlRequest::ListJobs { target } => {
            let Some(target) = target else {
                // The local outbound index needs no transport.
                return Ok(serde_json::to_value(context.store.list().await?)?);
            };
            let resolved = context.resolve_target(&target).await?;
            let request = DispatchListJobsRequest {
                target: Some(resolved.request()),
            };
            match resolved {
                ResolvedDispatchTarget::Device { display_name, .. } => {
                    let rpc = context.account()?.device_rpc();
                    list_device_dispatch_jobs(rpc.as_ref(), context.store, display_name, request)
                        .await
                }
                ResolvedDispatchTarget::Ssh { .. } => {
                    list_dispatch_jobs(context.ssh()?, context.store, request).await
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::dispatch::OutboundDispatchRecord;

    fn device(id: &str, name: &str, alias: Option<&str>, online: bool) -> AccountDevice {
        AccountDevice {
            device_id: id.to_string(),
            device_name: name.to_string(),
            device_kind: Some("cli".to_string()),
            device_alias: alias.map(str::to_string),
            device_model: None,
            device_os: None,
            device_os_version: None,
            device_client_version: None,
            device_client_protocol: None,
            compatible: None,
            online,
        }
    }

    #[test]
    fn target_selector_resolves_ids_names_aliases_and_ssh() {
        let devices = vec![
            device("mac-id", "MacBook-Pro-2.local", Some("Office Mac"), true),
            device("ecs-id", "ecs-box", None, true),
            device("old-id", "old-laptop", None, false),
        ];
        let expected = ResolvedDispatchTarget::Device {
            device_id: "mac-id".to_string(),
            display_name: "Office Mac".to_string(),
        };
        for selector in [
            "device:mac-id",
            "mac-id",
            "macbook-pro-2.local",
            "office mac",
        ] {
            assert_eq!(
                resolve_dispatch_target(selector, &devices).unwrap(),
                expected
            );
        }
        assert_eq!(
            resolve_dispatch_target("ssh:a100", &devices).unwrap(),
            ResolvedDispatchTarget::Ssh {
                connection_id: "a100".to_string()
            }
        );
        let offline = resolve_dispatch_target("old-laptop", &devices).unwrap_err();
        assert!(offline.to_string().contains("offline"), "{offline}");
        assert!(resolve_dispatch_target("missing", &devices).is_err());
        assert!(resolve_dispatch_target("ssh:", &devices).is_err());
        let duplicate = vec![
            device("a", "build", None, true),
            device("b", "build", None, true),
        ];
        let error = resolve_dispatch_target("build", &duplicate).unwrap_err();
        assert!(error.to_string().contains("device:<deviceId>"), "{error}");
    }

    struct FixedDevices(Vec<AccountDevice>);

    struct NoRpc;
    #[async_trait]
    impl DeviceDispatchRpc for NoRpc {
        async fn invoke(&self, _: &str, _: &str, _: Value) -> anyhow::Result<Value> {
            bail!("no transport in this test")
        }
    }

    #[async_trait]
    impl DispatchAccountAccess for FixedDevices {
        async fn list_devices(&self) -> anyhow::Result<Vec<AccountDevice>> {
            Ok(self.0.clone())
        }
        fn device_rpc(&self) -> Arc<dyn DeviceDispatchRpc> {
            Arc::new(NoRpc)
        }
    }

    struct ScriptedAccount {
        devices: Vec<AccountDevice>,
        rpc: Arc<dyn DeviceDispatchRpc>,
    }

    #[async_trait]
    impl DispatchAccountAccess for ScriptedAccount {
        async fn list_devices(&self) -> anyhow::Result<Vec<AccountDevice>> {
            Ok(self.devices.clone())
        }
        fn device_rpc(&self) -> Arc<dyn DeviceDispatchRpc> {
            Arc::clone(&self.rpc)
        }
    }

    struct FakeArtifactRpc {
        bytes: Vec<u8>,
        revision: String,
    }

    #[async_trait]
    impl DeviceDispatchRpc for FakeArtifactRpc {
        async fn invoke(
            &self,
            _device_id: &str,
            command: &str,
            args: Value,
        ) -> anyhow::Result<Value> {
            match command {
                "dispatch_target_probe" => Ok(json!({
                    "protocolVersion": 6,
                    "os": "linux",
                    "arch": "x86_64",
                    "capabilities": ["query_file_chunks_v1", "query_result_summary_v1", "status_summary_only_v1"],
                })),
                "dispatch_target_query" => {
                    let kind = args["kind"].as_str().unwrap_or_default();
                    if kind == "resultSummary" {
                        return Ok(json!({
                            "jobId": args["jobId"],
                            "state": "completed",
                            "commitCount": 1,
                            "summary": "built linux binary",
                        }));
                    }
                    let offset = args["fileChunk"]["offset"].as_u64().unwrap_or(0) as usize;
                    let limit = args["fileChunk"]["limit"].as_u64().unwrap_or(4) as usize;
                    let step = limit.min(3);
                    let end = (offset + step).min(self.bytes.len());
                    let slice = &self.bytes[offset..end];
                    Ok(json!({
                        "kind": "readFileChunk",
                        "filePath": "/remote/worktree/target/release/app",
                        "name": "app",
                        "mimeType": "application/octet-stream",
                        "totalSize": self.bytes.len() as u64,
                        "offset": offset as u64,
                        "chunkSize": slice.len() as u64,
                        "contentBase64": base64::engine::general_purpose::STANDARD.encode(slice),
                        "revision": self.revision,
                    }))
                }
                "dispatch_target_status" => Ok(json!({
                    "jobId": args["jobId"],
                    "state": "completed",
                    "pendingPermissions": [],
                    "pendingQuestions": [],
                })),
                other => bail!("unexpected command {other}"),
            }
        }
    }

    #[tokio::test]
    async fn fetch_file_streams_binary_artifact_and_verifies_sha256() {
        let dir = tempfile::tempdir().unwrap();
        let store = OutboundDispatchStore::new_in_root_for_tests(dir.path().to_path_buf());
        let record = OutboundDispatchRecord::new(
            "job-bin-1".to_string(),
            DispatchTarget::Device {
                device_id: "linux-id".to_string(),
                workspace_path: "/remote/worktree".to_string(),
                display_name: "Linux Builder".to_string(),
            },
            "sess-1".to_string(),
            "/remote/worktree".to_string(),
            "build release binary",
            "completed",
        )
        .unwrap();
        store.bind_if_absent(&record).await.unwrap();

        let payload = vec![0x7f, b'E', b'L', b'F', 0x02, 0x01, 0x01, 0x00, 0xde, 0xad];
        let account = ScriptedAccount {
            devices: vec![
                device("mac-id", "My Mac", None, true),
                device("linux-id", "Linux Builder", None, true),
            ],
            rpc: Arc::new(FakeArtifactRpc {
                bytes: payload.clone(),
                revision: "10:123456".to_string(),
            }),
        };
        let context = DispatchControlContext {
            store: &store,
            ssh: Err("unused".into()),
            account: Some(&account),
            local_device_id: Some("mac-id".into()),
        };

        let dest = dir.path().join("out/app-linux");
        let fetched = execute_dispatch_control(
            &context,
            DetachedDispatchControlRequest::FetchFile {
                job_id: "job-bin-1".into(),
                remote_path: "target/release/app".into(),
                local_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
                max_bytes: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        assert_eq!(fetched["size"], payload.len() as u64);
        assert_eq!(fetched["chunks"], 4);
        assert_eq!(
            fetched["sha256"].as_str().unwrap(),
            format!("{:x}", Sha256::digest(&payload))
        );

        // Overwrite guard refuses replacing without overwrite=true.
        assert!(execute_dispatch_control(
            &context,
            DetachedDispatchControlRequest::FetchFile {
                job_id: "job-bin-1".into(),
                remote_path: "target/release/app".into(),
                local_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
                max_bytes: None,
            },
        )
        .await
        .is_err());

        // Wait returns immediately when already terminal.
        let waited = execute_dispatch_control(
            &context,
            DetachedDispatchControlRequest::Wait {
                job_ids: vec!["job-bin-1".into()],
                until: DetachedDispatchWaitUntil::AllTerminal,
                timeout_seconds: 5,
            },
        )
        .await
        .unwrap();
        assert_eq!(waited["satisfied"], true);
        assert_eq!(waited["allTerminal"], true);

        // Result summary queries target directly.
        let summary = execute_dispatch_control(
            &context,
            DetachedDispatchControlRequest::ResultSummary {
                job_id: "job-bin-1".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(summary["summary"], "built linux binary");
    }

    #[tokio::test]
    async fn list_targets_counts_every_device_and_marks_this_host() {
        let dir = tempfile::tempdir().unwrap();
        let path_manager =
            crate::infrastructure::PathManager::with_user_root_for_tests(dir.path().to_path_buf());
        let store = OutboundDispatchStore::new(&path_manager);
        let account = FixedDevices(vec![
            device("self-id", "ecs-openbitfun-personal-lwb", None, true),
            device("mac-id", "MacBook-Pro-2.local", None, true),
        ]);
        let context = DispatchControlContext {
            store: &store,
            ssh: Err("not configured in this test".to_string()),
            account: Some(&account),
            local_device_id: Some("self-id".to_string()),
        };
        let result =
            execute_dispatch_control(&context, DetachedDispatchControlRequest::ListTargets)
                .await
                .unwrap();
        assert_eq!(result["deviceCount"], 2);
        assert_eq!(result["otherOnlineDeviceCount"], 1);
        assert_eq!(result["devices"][0]["isCurrentDevice"], true);
        assert_eq!(result["devices"][1]["isCurrentDevice"], false);
        assert!(result["sshUnavailable"].is_string());

        // A host never resolves itself as a dispatch target.
        assert!(context
            .resolve_target("ecs-openbitfun-personal-lwb")
            .await
            .is_err());
        assert!(context.resolve_target("MacBook-Pro-2.local").await.is_ok());

        let unknown = execute_dispatch_control(
            &context,
            DetachedDispatchControlRequest::Status {
                job_id: "missing".to_string(),
                cursor: 0,
                summary_only: false,
            },
        )
        .await
        .unwrap_err();
        assert!(unknown.to_string().contains("No dispatch job"), "{unknown}");
    }

    #[tokio::test]
    async fn signed_out_hosts_report_why_devices_are_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path_manager =
            crate::infrastructure::PathManager::with_user_root_for_tests(dir.path().to_path_buf());
        let store = OutboundDispatchStore::new(&path_manager);
        let context = DispatchControlContext {
            store: &store,
            ssh: Err("not configured".to_string()),
            account: None,
            local_device_id: None,
        };
        let result =
            execute_dispatch_control(&context, DetachedDispatchControlRequest::ListTargets)
                .await
                .unwrap();
        assert_eq!(result["signedIn"], false);
        assert!(result["devicesUnavailable"].is_string());
    }
}
