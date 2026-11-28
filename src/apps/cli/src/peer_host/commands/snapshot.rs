//! Snapshot / rollback HostInvoke handlers for CLI Peer Host.

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::{json, Value};

use std::sync::Arc;

use openbitfun_core::service::snapshot::{
    ensure_snapshot_manager_for_workspace, get_snapshot_manager_for_workspace,
    initialize_snapshot_manager_for_workspace, open_snapshot_manager_for_view, FileChangeEntry,
    OperationType, SnapshotManager,
};
use openbitfun_core::service::workspace::{WorkspaceInfo, WorkspaceKind};
use openbitfun_runtime_ports::{
    AgentSessionRollbackToTurnRequest, LocalWorkspaceSnapshotFileDiffStats,
    LocalWorkspaceSnapshotFileRequest, LocalWorkspaceSnapshotPort,
    LocalWorkspaceSnapshotSessionRequest, LocalWorkspaceSnapshotStats, PortError, PortErrorKind,
};

use crate::peer_host::args::{get_string, optional_bool, optional_string, request_value};
use crate::peer_host::state::PeerHostState;

use super::session::{ensure_session_workspace_runtime_ownership, resolved_session_storage_scope};

async fn ensure_snapshot_manager_ready_for_workspace(
    workspace_id: &str,
) -> Result<Arc<SnapshotManager>, String> {
    if let Some(manager) = get_snapshot_manager_for_workspace(workspace_id) {
        return Ok(manager);
    }
    initialize_snapshot_manager_for_workspace(workspace_id, None)
        .await
        .map_err(|error| error.to_string())?;
    ensure_snapshot_manager_for_workspace(workspace_id).map_err(|error| error.to_string())
}

pub(super) async fn resolve_snapshot_workspace(
    state: &PeerHostState,
    request: &Value,
) -> Result<WorkspaceInfo, String> {
    if let Some(id) = optional_string(request, "workspaceId") {
        return state
            .workspace_service
            .require_workspace(&id)
            .await
            .map_err(|e| e.to_string());
    }
    // Temporary pre-ID protocol adapter; all downstream owners receive IDs.
    state
        .workspace_service
        .resolve_legacy_workspace_reference(
            None,
            &get_string(request, "workspacePath")?,
            optional_string(request, "remoteConnectionId").as_deref(),
            optional_string(request, "remoteSshHost").as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Legacy snapshot workspace cannot be resolved".into())
}

pub(super) fn require_local_snapshot_workspace(workspace: &WorkspaceInfo) -> Result<(), String> {
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Err(format!(
            "Snapshot system not supported for remote workspace: {}",
            workspace.id
        ));
    }
    Ok(())
}

fn require_complete_rollback_workspace(workspace: &WorkspaceInfo) -> Result<(), String> {
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Err(format!("Complete rollback is not supported for remote workspaces because remote file snapshots are not recorded. No workspace files or session messages were changed: {}", workspace.id));
    }
    Ok(())
}

pub(super) fn snapshot_compatibility_error(error: PortError) -> String {
    if error.kind == PortErrorKind::InvalidRequest {
        error.message
    } else {
        format!("Service error: {}", error.message)
    }
}

pub(super) async fn local_snapshot_session_files(
    port: &dyn LocalWorkspaceSnapshotPort,
    workspace_id: String,
    session_id: String,
    max_turn_exclusive: Option<usize>,
) -> Result<Vec<PathBuf>, String> {
    port.get_session_files(LocalWorkspaceSnapshotSessionRequest {
        workspace_id,
        session_id,
        max_turn_exclusive,
    })
    .await
    .map_err(|error| {
        format!(
            "Failed to get session files: {}",
            snapshot_compatibility_error(error)
        )
    })
}

pub(super) async fn local_snapshot_session_stats(
    port: &dyn LocalWorkspaceSnapshotPort,
    workspace_id: String,
    session_id: String,
    max_turn_exclusive: Option<usize>,
) -> Result<LocalWorkspaceSnapshotStats, String> {
    port.get_session_stats(LocalWorkspaceSnapshotSessionRequest {
        workspace_id,
        session_id,
        max_turn_exclusive,
    })
    .await
    .map_err(|error| {
        format!(
            "Failed to get session stats: {}",
            snapshot_compatibility_error(error)
        )
    })
}

pub(crate) async fn get_session_files(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let workspace = resolve_snapshot_workspace(state, request).await?;

    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let read = state
        .compatibility
        .begin_persisted_session_read(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;
    let files = local_snapshot_session_files(
        state.local_workspace_snapshot.as_ref(),
        workspace.id,
        session_id,
        read.visible_turn_end(),
    )
    .await?;

    Ok(json!(files
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()))
}

/// Desktop's `SessionFileDiffStats` wire shape, read by the file badges.
fn file_diff_stats_to_json(stats: LocalWorkspaceSnapshotFileDiffStats) -> Value {
    json!({
        "filePath": stats.file_path,
        "linesAdded": stats.lines_added,
        "linesRemoved": stats.lines_removed,
        "approximate": stats.approximate,
        "changeKind": stats.change_kind,
    })
}

pub(super) async fn local_snapshot_file_diff_stats(
    port: &dyn LocalWorkspaceSnapshotPort,
    request: LocalWorkspaceSnapshotFileRequest,
) -> Result<Value, String> {
    port.get_session_file_diff_stats(request)
        .await
        .map(file_diff_stats_to_json)
        .map_err(|error| {
            format!(
                "Failed to get session file diff stats: {}",
                snapshot_compatibility_error(error)
            )
        })
}

/// Line-level change of one session file, like Desktop
/// `get_session_file_diff_stats`. A controller renders it as the file badges
/// and toolbars of the session's changed files.
pub(crate) async fn get_session_file_diff_stats(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let file_path = get_string(request, "filePath")?;
    let workspace = resolve_snapshot_workspace(state, request).await?;

    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let read = state
        .compatibility
        .begin_persisted_session_read(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;
    local_snapshot_file_diff_stats(
        state.local_workspace_snapshot.as_ref(),
        LocalWorkspaceSnapshotFileRequest {
            workspace_id: workspace.id,
            session_id,
            file_path,
            max_turn_exclusive: read.visible_turn_end(),
        },
    )
    .await
}

pub(crate) async fn get_operation_diff(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let file_path = get_string(request, "filePath")?;
    let operation_id = optional_string(request, "operationId");
    let workspace = resolve_snapshot_workspace(state, request).await?;

    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let read = state
        .compatibility
        .begin_persisted_session_read(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;
    let manager = openbitfun_core::service::snapshot::open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    let diff = match operation_id.as_deref() {
        Some(operation_id) => {
            manager
                .get_operation_diff_before(
                    &session_id,
                    &file_path,
                    operation_id,
                    read.visible_turn_end(),
                )
                .await
        }
        None => {
            manager
                .get_file_diff_before(&session_id, &file_path, None, read.visible_turn_end())
                .await
        }
    }
    .map_err(|error| format!("Failed to get operation diff: {error}"))?;

    let original = diff
        .get("original_content")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let modified = diff
        .get("modified_content")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    Ok(json!({
        "filePath": diff.get("file_path").and_then(|v| v.as_str()).unwrap_or(&file_path),
        "originalContent": original.to_string(),
        "modifiedContent": modified.to_string(),
        "anchorLine": diff.get("anchor_line").and_then(|v| v.as_u64()),
    }))
}

pub(crate) async fn rollback_session_to_turn(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let mut rollback_request: AgentSessionRollbackToTurnRequest =
        serde_json::from_value(request.clone())
            .map_err(|error| format!("Invalid targeted Session rollback request: {error}"))?;

    openbitfun_agent_runtime::session_control::validate_session_id(&rollback_request.session_id)?;
    let workspace = if let Some(id) = rollback_request.workspace_id.as_deref() {
        state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|e| e.to_string())?
    } else {
        state
            .workspace_service
            .resolve_legacy_workspace_reference(
                None,
                &rollback_request.workspace_path,
                rollback_request.remote_connection_id.as_deref(),
                rollback_request.remote_ssh_host.as_deref(),
            )
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Legacy rollback workspace cannot be resolved")?
    };
    require_complete_rollback_workspace(&workspace)?;
    rollback_request.remote_connection_id = None;
    rollback_request.remote_ssh_host = None;
    rollback_request.workspace_id = Some(workspace.id);
    rollback_request.workspace_path = workspace.root_path.to_string_lossy().into_owned();
    let resolved_request = serde_json::to_value(&rollback_request).map_err(|e| e.to_string())?;
    let request = &resolved_request;
    ensure_session_workspace_runtime_ownership(state, request).await?;
    let outcome = state
        .agent_runtime
        .rollback_session_to_turn(rollback_request)
        .await
        .map_err(|error| error.into_message())?;
    serde_json::to_value(outcome).map_err(|error| error.to_string())
}

pub(crate) async fn rollback_session(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let delete_session = optional_bool(request, "deleteSession").unwrap_or(false);
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_complete_rollback_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let _mutation = state
        .compatibility
        .begin_persisted_session_mutation(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to acquire snapshot mutation lock: {error}"))?;
    let manager = ensure_snapshot_manager_ready_for_workspace(&workspace.id)
        .await
        .map_err(|error| format!("Failed to initialize snapshot manager: {error}"))?;
    let restored_files = manager
        .rollback_session(&session_id)
        .await
        .map_err(|error| format!("Failed to rollback session: {error}"))?;
    let restored_files_str: Vec<String> = restored_files
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    crate::obp_host::publish_event(
        "session_rolled_back",
        &json!({
            "session_id": session_id,
            "files_count": restored_files_str.len(),
            "session_deleted": delete_session,
        }),
    );
    Ok(json!(restored_files_str))
}

pub(crate) async fn accept_session(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let _mutation = state
        .compatibility
        .begin_persisted_session_mutation(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to acquire snapshot mutation lock: {error}"))?;
    let manager = ensure_snapshot_manager_ready_for_workspace(&workspace.id)
        .await
        .map_err(|error| format!("Failed to initialize snapshot manager: {error}"))?;
    manager
        .accept_session(&session_id)
        .await
        .map_err(|error| format!("Failed to accept session: {error}"))?;
    crate::obp_host::publish_event("session_accepted", &json!({ "session_id": session_id }));
    Ok(json!({ "success": true, "message": "Session changes accepted" }))
}

pub(crate) async fn accept_file(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let file_path = get_string(request, "filePath")?;
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let _mutation = state
        .compatibility
        .begin_persisted_session_mutation(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to acquire snapshot mutation lock: {error}"))?;
    let manager = ensure_snapshot_manager_ready_for_workspace(&workspace.id)
        .await
        .map_err(|error| format!("Failed to initialize snapshot manager: {error}"))?;
    manager
        .accept_file(&session_id, &file_path)
        .await
        .map_err(|error| format!("Failed to accept file: {error}"))?;
    crate::obp_host::publish_event(
        "file_accepted",
        &json!({ "session_id": session_id, "file_path": file_path }),
    );
    Ok(json!({ "success": true, "message": "File changes accepted" }))
}

pub(crate) async fn reject_file(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let file_path = get_string(request, "filePath")?;
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let _mutation = state
        .compatibility
        .begin_persisted_session_mutation(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to acquire snapshot mutation lock: {error}"))?;
    let manager = ensure_snapshot_manager_ready_for_workspace(&workspace.id)
        .await
        .map_err(|error| format!("Failed to initialize snapshot manager: {error}"))?;
    let restored_files = manager
        .reject_file(&session_id, &file_path)
        .await
        .map_err(|error| format!("Failed to reject file: {error}"))?;
    let restored_files_str: Vec<String> = restored_files
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    crate::obp_host::publish_event(
        "file_rejected",
        &json!({
            "session_id": session_id,
            "file_path": file_path,
            "restored_files": restored_files_str,
        }),
    );
    Ok(json!({
        "success": true,
        "message": "File changes rejected",
        "restored_files": restored_files_str,
    }))
}

pub(crate) async fn accept_operation(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let operation_id = get_string(request, "operationId")?;
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let _mutation = state
        .compatibility
        .begin_persisted_session_mutation(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to acquire snapshot mutation lock: {error}"))?;
    let manager = ensure_snapshot_manager_ready_for_workspace(&workspace.id)
        .await
        .map_err(|error| format!("Failed to initialize snapshot manager: {error}"))?;
    let summary = manager
        .get_operation_summary(&session_id, &operation_id)
        .await
        .map_err(|error| format!("Failed to accept operation: {error}"))?;
    let file_path = summary
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or_else(|| "Operation file path not found".to_string())?;
    manager
        .accept_file(&session_id, file_path)
        .await
        .map_err(|error| format!("Failed to accept operation: {error}"))?;
    crate::obp_host::publish_event(
        "operation_accepted",
        &json!({
            "session_id": session_id,
            "operation_id": operation_id,
            "file_path": file_path,
        }),
    );
    Ok(json!({ "success": true, "message": "Operation accepted" }))
}

pub(crate) async fn reject_operation(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let operation_id = get_string(request, "operationId")?;
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let _mutation = state
        .compatibility
        .begin_persisted_session_mutation(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to acquire snapshot mutation lock: {error}"))?;
    let manager = ensure_snapshot_manager_ready_for_workspace(&workspace.id)
        .await
        .map_err(|error| format!("Failed to initialize snapshot manager: {error}"))?;
    let summary = manager
        .get_operation_summary(&session_id, &operation_id)
        .await
        .map_err(|error| format!("Failed to reject operation: {error}"))?;
    let file_path = summary
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or_else(|| "Operation file path not found".to_string())?;
    let restored_files = manager
        .reject_file(&session_id, file_path)
        .await
        .map_err(|error| format!("Failed to reject operation: {error}"))?;
    let restored_files_str: Vec<String> = restored_files
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    crate::obp_host::publish_event(
        "operation_rejected",
        &json!({
            "session_id": session_id,
            "operation_id": operation_id,
            "file_path": file_path,
            "restored_files": restored_files_str,
        }),
    );
    Ok(json!({ "success": true, "message": "Operation rejected" }))
}

pub(crate) async fn get_session_turns(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let read = state
        .compatibility
        .begin_persisted_session_read(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;
    let manager = open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    let turns = manager
        .get_session_turns_before(&session_id, read.visible_turn_end())
        .await
        .map_err(|error| format!("Failed to get session turns: {error}"))?;
    Ok(json!(turns))
}

pub(crate) async fn get_turn_files(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let turn_index = request
        .get("turnIndex")
        .or_else(|| request.get("turn_index"))
        .and_then(Value::as_u64)
        .and_then(|v| usize::try_from(v).ok())
        .ok_or_else(|| "Missing or invalid 'turnIndex' field".to_string())?;
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let read = state
        .compatibility
        .begin_persisted_session_read(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;
    let manager = open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    let files = manager
        .get_turn_files_before(&session_id, turn_index, read.visible_turn_end())
        .await
        .map_err(|error| format!("Failed to get turn files: {error}"))?;
    Ok(json!(files
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()))
}

pub(crate) async fn get_file_diff(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let file_path = get_string(request, "filePath")?;
    let operation_id = optional_string(request, "operationId");
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let read = state
        .compatibility
        .begin_persisted_session_read(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;
    let manager = open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    manager
        .get_file_diff_before(
            &session_id,
            &file_path,
            operation_id.as_deref(),
            read.visible_turn_end(),
        )
        .await
        .map_err(|error| format!("Failed to get file diff: {error}"))
}

pub(crate) async fn get_operation_summary(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let operation_id = get_string(request, "operationId")?;
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let read = state
        .compatibility
        .begin_persisted_session_read(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;
    let manager = open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    let summary = manager
        .get_operation_summary_before(&session_id, &operation_id, read.visible_turn_end())
        .await
        .map_err(|error| format!("Failed to get operation summary: {error}"))?;
    Ok(json!({
        "operationId": summary.get("operation_id").and_then(Value::as_str).unwrap_or(&operation_id),
        "sessionId": summary.get("session_id").and_then(Value::as_str).unwrap_or(&session_id),
        "turnIndex": summary.get("turn_index").and_then(Value::as_u64),
        "seqInTurn": summary.get("seq_in_turn").and_then(Value::as_u64),
        "filePath": summary.get("file_path").and_then(Value::as_str),
        "operationType": summary.get("operation_type").and_then(Value::as_str),
        "toolName": summary.get("tool_name").and_then(Value::as_str),
        "linesAdded": summary.get("lines_added").and_then(Value::as_u64),
        "linesRemoved": summary.get("lines_removed").and_then(Value::as_u64),
    }))
}

pub(crate) async fn get_session_operations(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let read = state
        .compatibility
        .begin_persisted_session_read(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;
    let manager = open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    let session = manager
        .get_session_before(&session_id, read.visible_turn_end())
        .await
        .map_err(|error| format!("Failed to get session operations: {error}"))?;
    let operations: Vec<Value> = session
        .operations
        .into_iter()
        .map(|operation| {
            let operation_type = match operation.operation_type {
                OperationType::Create => "create",
                OperationType::Modify => "modify",
                OperationType::Delete => "delete",
                OperationType::Rename => "rename",
            };
            json!({
                "operation_id": operation.operation_id,
                "session_id": operation.session_id,
                "turn_index": operation.turn_index,
                "seq_in_turn": operation.seq_in_turn,
                "file_path": operation.file_path.to_string_lossy().to_string(),
                "tool_name": operation.tool_context.tool_name,
                "operation_type": operation_type,
                "status": "applied",
                "timestamp": chrono::DateTime::<chrono::Utc>::from(operation.timestamp).to_rfc3339(),
                "diff_summary": {
                    "lines_added": operation.diff_summary.lines_added,
                    "lines_removed": operation.diff_summary.lines_removed,
                    "blocks_changed": operation.diff_summary.lines_modified,
                }
            })
        })
        .collect();
    Ok(Value::Array(operations))
}

pub(crate) async fn get_snapshot_system_stats(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let manager = open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    manager
        .get_system_stats()
        .await
        .map_err(|error| format!("Failed to get system stats: {error}"))
}

pub(crate) async fn get_snapshot_sessions(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let manager = open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    let sessions = manager
        .list_sessions()
        .await
        .map_err(|error| format!("Failed to list snapshot sessions: {error}"))?;
    Ok(json!(sessions))
}

pub(crate) async fn check_git_isolation(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let manager = open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    let is_isolated = manager
        .check_git_isolation()
        .await
        .map_err(|error| format!("Failed to check git isolation: {error}"))?;
    Ok(json!({
        "git_isolated": is_isolated,
        "message": if is_isolated {
            "Git repository is safely isolated"
        } else {
            "Git isolation status abnormal"
        }
    }))
}

pub(crate) async fn get_file_change_history(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let file_path = PathBuf::from(get_string(request, "filePath")?);
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let manager = open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    let session_ids = manager
        .list_sessions()
        .await
        .map_err(|error| format!("Failed to list snapshot sessions: {error}"))?;
    let mut changes = Vec::new();
    for session_id in session_ids {
        let read = state
            .compatibility
            .begin_persisted_session_read(&storage_path, &session_id)
            .await
            .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;
        let session = manager
            .get_session_before(&session_id, read.visible_turn_end())
            .await
            .map_err(|error| format!("Failed to get file change history: {error}"))?;
        changes.extend(
            session
                .operations
                .into_iter()
                .filter(|operation| operation.file_path == file_path)
                .map(|operation| FileChangeEntry {
                    session_id: operation.session_id,
                    turn_index: operation.turn_index,
                    snapshot_id: operation
                        .before_snapshot_id
                        .unwrap_or_else(|| format!("empty_snapshot_{}", operation.operation_id)),
                    timestamp: operation.timestamp,
                    operation_type: operation.operation_type,
                    tool_name: operation.tool_context.tool_name,
                }),
        );
    }
    changes.sort_by_key(|entry| (entry.session_id.clone(), entry.turn_index, entry.timestamp));
    serde_json::to_value(changes).map_err(|error| format!("Serialization failed: {error}"))
}

pub(crate) async fn get_all_modified_files(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let manager = open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    let session_ids = manager
        .list_sessions()
        .await
        .map_err(|error| format!("Failed to list snapshot sessions: {error}"))?;
    let mut files = BTreeSet::new();
    for session_id in session_ids {
        let read = state
            .compatibility
            .begin_persisted_session_read(&storage_path, &session_id)
            .await
            .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;
        files.extend(
            manager
                .get_session_files_before(&session_id, read.visible_turn_end())
                .await
                .map_err(|error| format!("Failed to get modified files: {error}"))?,
        );
    }
    Ok(json!(files
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()))
}

pub(crate) async fn get_baseline_snapshot_diff(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let file_path = get_string(request, "filePath")?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    require_local_snapshot_workspace(&workspace)?;
    let manager = open_snapshot_manager_for_view(&workspace.id)
        .await
        .map_err(|error| format!("Failed to open snapshot view: {error}"))?;
    let (baseline_content, current_content) = {
        let snapshot_service = manager.get_snapshot_service();
        let snapshot_service = snapshot_service.read().await;
        snapshot_service
            .get_baseline_snapshot_diff(&PathBuf::from(&file_path))
            .await
            .unwrap_or_else(|_| (String::new(), String::new()))
    };
    Ok(json!({
        "filePath": file_path,
        "originalContent": baseline_content,
        "modifiedContent": current_content,
    }))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use openbitfun_runtime_ports::{
        LocalWorkspaceSnapshotFileDiffStats, LocalWorkspaceSnapshotFileRequest,
        LocalWorkspaceSnapshotPort, LocalWorkspaceSnapshotSessionRequest,
        LocalWorkspaceSnapshotStats, LocalWorkspaceSnapshotTurnRequest, PortError, PortErrorKind,
        PortResult,
    };
    use serde_json::json;

    use super::{
        local_snapshot_file_diff_stats, local_snapshot_session_files, local_snapshot_session_stats,
        require_complete_rollback_workspace, require_local_snapshot_workspace,
        snapshot_compatibility_error,
    };

    #[derive(Default)]
    struct RecordingSnapshotPort {
        file_calls: AtomicUsize,
        stats_calls: AtomicUsize,
        file_request: Mutex<Option<LocalWorkspaceSnapshotSessionRequest>>,
        stats_request: Mutex<Option<LocalWorkspaceSnapshotSessionRequest>>,
        diff_request: Mutex<Option<LocalWorkspaceSnapshotFileRequest>>,
    }

    #[async_trait::async_trait]
    impl LocalWorkspaceSnapshotPort for RecordingSnapshotPort {
        async fn prepare_local_workspace(&self, _workspace_id: String) -> PortResult<()> {
            Ok(())
        }

        async fn get_session_files(
            &self,
            request: LocalWorkspaceSnapshotSessionRequest,
        ) -> PortResult<Vec<PathBuf>> {
            self.file_calls.fetch_add(1, Ordering::SeqCst);
            *self.file_request.lock().expect("file request lock") = Some(request);
            Ok(vec![PathBuf::from("changed.txt")])
        }

        async fn get_session_stats(
            &self,
            request: LocalWorkspaceSnapshotSessionRequest,
        ) -> PortResult<LocalWorkspaceSnapshotStats> {
            self.stats_calls.fetch_add(1, Ordering::SeqCst);
            let session_id = request.session_id.clone();
            *self.stats_request.lock().expect("stats request lock") = Some(request);
            Ok(LocalWorkspaceSnapshotStats {
                session_id,
                total_files: 1,
                total_turns: 2,
                total_changes: 3,
            })
        }

        async fn get_session_file_diff_stats(
            &self,
            request: LocalWorkspaceSnapshotFileRequest,
        ) -> PortResult<LocalWorkspaceSnapshotFileDiffStats> {
            let file_path = request.file_path.clone();
            *self.diff_request.lock().expect("diff request lock") = Some(request);
            Ok(LocalWorkspaceSnapshotFileDiffStats {
                file_path,
                lines_added: 4,
                lines_removed: 1,
                approximate: false,
                change_kind: "modify".to_string(),
            })
        }

        async fn rollback_workspace_files_to_turn(
            &self,
            _request: LocalWorkspaceSnapshotTurnRequest,
        ) -> PortResult<Vec<PathBuf>> {
            Ok(vec![PathBuf::from("restored.txt")])
        }
    }

    #[tokio::test]
    async fn file_diff_stats_keep_desktop_wire_shape_and_visible_turn_end() {
        let port = RecordingSnapshotPort::default();
        let stats = local_snapshot_file_diff_stats(
            &port,
            LocalWorkspaceSnapshotFileRequest {
                workspace_id: "workspace".to_string(),
                session_id: "session-1".to_string(),
                file_path: "/repo/src/main.rs".to_string(),
                max_turn_exclusive: Some(3),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            stats,
            json!({
                "filePath": "/repo/src/main.rs",
                "linesAdded": 4,
                "linesRemoved": 1,
                "approximate": false,
                "changeKind": "modify",
            })
        );
        let request = port.diff_request.lock().unwrap().clone().unwrap();
        assert_eq!(request.max_turn_exclusive, Some(3));
        assert_eq!(request.workspace_id, "workspace");
    }

    #[tokio::test]
    async fn snapshot_kind_is_authoritative_without_transport_inference() {
        use openbitfun_core::service::workspace::WorkspaceInfoRuntimeExt;
        let directory = tempfile::tempdir().unwrap();
        let mut workspace =
            openbitfun_core::service::workspace::WorkspaceInfo::new_without_worktree(
                directory.path().to_path_buf(),
                Default::default(),
            )
            .await
            .unwrap();
        workspace
            .metadata
            .insert("connectionId".into(), json!("stale-ssh"));
        require_local_snapshot_workspace(&workspace).unwrap();
        require_complete_rollback_workspace(&workspace).unwrap();
        workspace.workspace_kind = super::WorkspaceKind::Remote;
        workspace.metadata.clear();
        assert!(require_local_snapshot_workspace(&workspace)
            .unwrap_err()
            .contains("not supported"));
        assert!(require_complete_rollback_workspace(&workspace)
            .unwrap_err()
            .contains("remote file snapshots"));
    }

    #[tokio::test]
    async fn local_snapshot_adapter_calls_each_port_operation_once_with_typed_requests() {
        let port = RecordingSnapshotPort::default();
        let workspace = "workspace-id".to_string();

        let files = local_snapshot_session_files(
            &port,
            workspace.clone(),
            "session-1".to_string(),
            Some(2),
        )
        .await
        .expect("file projection should succeed");
        let stats = local_snapshot_session_stats(
            &port,
            workspace.clone(),
            "session-1".to_string(),
            Some(2),
        )
        .await
        .expect("stats projection should succeed");
        assert_eq!(port.file_calls.load(Ordering::SeqCst), 1);
        assert_eq!(port.stats_calls.load(Ordering::SeqCst), 1);
        assert_eq!(files, vec![PathBuf::from("changed.txt")]);
        assert_eq!(stats.total_changes, 3);
        assert_eq!(
            port.file_request
                .lock()
                .expect("file request lock")
                .as_ref()
                .expect("file request")
                .workspace_id,
            workspace
        );
        assert_eq!(
            port.file_request
                .lock()
                .expect("file request lock")
                .as_ref()
                .expect("file request")
                .max_turn_exclusive,
            Some(2)
        );
    }

    #[test]
    fn port_errors_keep_the_existing_peer_host_error_categories() {
        let invalid = snapshot_compatibility_error(PortError::new(
            PortErrorKind::InvalidRequest,
            "Validation error: invalid session_id",
        ));
        assert_eq!(invalid, "Validation error: invalid session_id");

        let backend = snapshot_compatibility_error(PortError::new(
            PortErrorKind::Backend,
            "snapshot backend failed",
        ));
        assert_eq!(backend, "Service error: snapshot backend failed");
    }
}
