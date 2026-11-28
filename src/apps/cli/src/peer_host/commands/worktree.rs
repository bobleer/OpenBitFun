//! Managed worktree HostInvoke handlers for CLI Peer Host.
//!
//! Thin adapter over product-owned `WorktreeService`, resolving workspace IDs
//! authoritatively and rejecting remote SSH workspaces before Git IO.

use openbitfun_core::service::workspace::{get_global_workspace_service, WorkspaceKind};
use openbitfun_core::service::worktree::{
    WorktreeCreateBranchRequest, WorktreeCreateRequest, WorktreeListRequest,
    WorktreeProjectListRequest, WorktreePromoteRequest, WorktreeRecreateRequest,
    WorktreeRemoveRequest, WorktreeService, WorktreeSessionBindingRequest,
};
use openbitfun_core_types::{WorktreeError, WorktreeErrorCode};
use serde_json::Value;

use crate::peer_host::args::request_value;

fn remote_unsupported() -> WorktreeError {
    WorktreeError {
        code: WorktreeErrorCode::RemoteUnsupported,
        message: "Managed worktrees are not supported for remote SSH workspaces yet".to_string(),
        recovery_path: None,
    }
}

fn invalid_project(message: impl Into<String>) -> WorktreeError {
    WorktreeError {
        code: WorktreeErrorCode::InvalidPath,
        message: message.into(),
        recovery_path: None,
    }
}

async fn resolve_local_project(
    project_workspace_id: Option<&str>,
    project_workspace_path: &str,
) -> Result<String, WorktreeError> {
    let project_workspace_id = project_workspace_id
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let Some(service) = get_global_workspace_service() else {
        if project_workspace_id.is_some() {
            return Err(invalid_project(
                "Workspace service is not initialized; cannot resolve the project workspace",
            ));
        }
        return Ok(project_workspace_path.to_string());
    };
    match project_workspace_id {
        Some(id) => {
            let workspace = service
                .require_workspace(id)
                .await
                .map_err(|error| invalid_project(error.to_string()))?;
            if workspace.workspace_kind == WorkspaceKind::Remote {
                return Err(remote_unsupported());
            }
            Ok(workspace.root_path.to_string_lossy().into_owned())
        }
        None => {
            let trimmed = project_workspace_path.trim();
            if trimmed.is_empty() {
                return Err(invalid_project(
                    "A project workspace ID is required for managed worktrees",
                ));
            }
            match service
                .resolve_legacy_workspace_reference(None, trimmed, None, None)
                .await
                .map_err(|error| invalid_project(error.to_string()))?
            {
                Some(workspace) if workspace.workspace_kind == WorkspaceKind::Remote => {
                    Err(remote_unsupported())
                }
                Some(workspace) => Ok(workspace.root_path.to_string_lossy().into_owned()),
                None => Ok(trimmed.to_string()),
            }
        }
    }
}

fn format_worktree_error(error: WorktreeError) -> String {
    serde_json::to_string(&error).unwrap_or(error.message)
}

pub(crate) async fn dispatch(command: &str, args: &Value) -> Result<Value, String> {
    let request = request_value(args).clone();
    match command {
        "worktree_list" => {
            let mut req: WorktreeListRequest = serde_json::from_value(request)
                .map_err(|e| format!("Invalid worktree_list request: {e}"))?;
            req.project_workspace_path = resolve_local_project(
                req.project_workspace_id.as_deref(),
                &req.project_workspace_path,
            )
            .await
            .map_err(format_worktree_error)?;
            let out = WorktreeService::list(req)
                .await
                .map_err(format_worktree_error)?;
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        "worktree_list_projects" => {
            let req: WorktreeProjectListRequest =
                serde_json::from_value(request).unwrap_or_default();
            let out = WorktreeService::list_projects(req)
                .await
                .map_err(format_worktree_error)?;
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        "worktree_create" => {
            let mut req: WorktreeCreateRequest = serde_json::from_value(request)
                .map_err(|e| format!("Invalid worktree_create request: {e}"))?;
            req.project_workspace_path = resolve_local_project(
                req.project_workspace_id.as_deref(),
                &req.project_workspace_path,
            )
            .await
            .map_err(format_worktree_error)?;
            let out = WorktreeService::create(req)
                .await
                .map_err(format_worktree_error)?;
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        "worktree_create_branch" => {
            let mut req: WorktreeCreateBranchRequest = serde_json::from_value(request)
                .map_err(|e| format!("Invalid worktree_create_branch request: {e}"))?;
            req.project_workspace_path = resolve_local_project(
                req.project_workspace_id.as_deref(),
                &req.project_workspace_path,
            )
            .await
            .map_err(format_worktree_error)?;
            let out = WorktreeService::create_branch(req)
                .await
                .map_err(format_worktree_error)?;
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        "worktree_promote" => {
            let mut req: WorktreePromoteRequest = serde_json::from_value(request)
                .map_err(|e| format!("Invalid worktree_promote request: {e}"))?;
            req.project_workspace_path = resolve_local_project(
                req.project_workspace_id.as_deref(),
                &req.project_workspace_path,
            )
            .await
            .map_err(format_worktree_error)?;
            let out = WorktreeService::promote(req)
                .await
                .map_err(format_worktree_error)?;
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        "worktree_remove" => {
            let mut req: WorktreeRemoveRequest = serde_json::from_value(request)
                .map_err(|e| format!("Invalid worktree_remove request: {e}"))?;
            req.project_workspace_path = resolve_local_project(
                req.project_workspace_id.as_deref(),
                &req.project_workspace_path,
            )
            .await
            .map_err(format_worktree_error)?;
            let out = WorktreeService::remove(req)
                .await
                .map_err(format_worktree_error)?;
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        "worktree_bind_session" => {
            let req: WorktreeSessionBindingRequest = serde_json::from_value(request)
                .map_err(|e| format!("Invalid worktree_bind_session request: {e}"))?;
            let out = WorktreeService::bind_session(req)
                .await
                .map_err(format_worktree_error)?;
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        "worktree_recreate" => {
            let mut req: WorktreeRecreateRequest = serde_json::from_value(request)
                .map_err(|e| format!("Invalid worktree_recreate request: {e}"))?;
            req.project_workspace_path = resolve_local_project(
                req.project_workspace_id.as_deref(),
                &req.project_workspace_path,
            )
            .await
            .map_err(format_worktree_error)?;
            let out = WorktreeService::recreate(req)
                .await
                .map_err(format_worktree_error)?;
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        other => Err(format!("Unknown worktree command '{other}'")),
    }
}
