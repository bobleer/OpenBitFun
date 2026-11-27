//! Workspace and assistant HostInvoke handlers.

use std::path::{Path, PathBuf};

use openbitfun_core::service::workspace::{
    identity_document::IdentityFieldPatch, remote_workspace_connection_conflict_message,
    RelatedPath, RemoteConnectionRebind, WorkspaceCreateOptions, WorkspaceInfoUpdates,
    WorkspaceKind,
};
use openbitfun_runtime_ports::SessionStoragePathRequest;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::peer_host::args::{
    get_string, get_string_vec, optional_bool, optional_string, request_value,
};
use crate::peer_host::fanout::publish_host_event;
use crate::peer_host::state::PeerHostState;
use crate::peer_host::workspace_dto::{workspace_info_to_json, workspace_list_to_json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssistantWorkspaceDirectoryPlan {
    DeleteDirectoryWhenPresent,
    RegistryEntryOnly,
}

fn assistant_workspace_directory_plan(
    path: &Path,
    is_managed_path: bool,
) -> Result<AssistantWorkspaceDirectoryPlan, String> {
    if is_managed_path {
        return Ok(AssistantWorkspaceDirectoryPlan::DeleteDirectoryWhenPresent);
    }
    if path.exists() {
        Err(format!(
            "Workspace path is not a managed assistant workspace: {}",
            path.display()
        ))
    } else {
        Ok(AssistantWorkspaceDirectoryPlan::RegistryEntryOnly)
    }
}

async fn write_assistant_identity(
    state: &PeerHostState,
    workspace_id: &str,
    patch: &IdentityFieldPatch,
) -> Result<String, String> {
    let (content, changed) = state
        .workspace_service
        .set_assistant_identity(workspace_id, patch)
        .await
        .map_err(|error| format!("Failed to set assistant identity: {error}"))?;
    if let Some(event) = changed {
        if let Ok(payload) = serde_json::to_value(&event) {
            publish_host_event("workspace-identity-changed", &payload);
        }
    }
    Ok(content)
}

async fn clear_directory_contents(directory: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| {
            format!(
                "Failed to create workspace directory '{}': {error}",
                directory.display()
            )
        })?;
    let mut entries = tokio::fs::read_dir(directory).await.map_err(|error| {
        format!(
            "Failed to read workspace directory '{}': {error}",
            directory.display()
        )
    })?;
    while let Some(entry) = entries.next_entry().await.map_err(|error| {
        format!(
            "Failed to iterate workspace directory '{}': {error}",
            directory.display()
        )
    })? {
        let entry_path = entry.path();
        let file_type = entry.file_type().await.map_err(|error| {
            format!(
                "Failed to inspect workspace entry '{}': {error}",
                entry_path.display()
            )
        })?;
        if file_type.is_dir() {
            tokio::fs::remove_dir_all(&entry_path)
                .await
                .map_err(|error| {
                    format!(
                        "Failed to remove workspace directory '{}': {error}",
                        entry_path.display()
                    )
                })?;
        } else {
            tokio::fs::remove_file(&entry_path).await.map_err(|error| {
                format!(
                    "Failed to remove workspace file '{}': {error}",
                    entry_path.display()
                )
            })?;
        }
    }
    Ok(())
}

pub(crate) async fn initialize_workspace_startup_state(
    state: &PeerHostState,
) -> Result<Value, String> {
    let cleanup_removed_count = state
        .workspace_service
        .cleanup_invalid_workspaces()
        .await
        .map_err(|e| format!("Failed to cleanup invalid workspaces: {e}"))?;

    let current_workspace = state.workspace_service.get_current_workspace().await;
    let recent_workspaces = state.workspace_service.get_recent_workspaces().await;
    let opened_workspaces = state.workspace_service.get_opened_workspaces().await;
    let assistant_workspaces = state.workspace_service.get_assistant_workspaces().await;
    let primary_assistant_workspace_id = state
        .workspace_service
        .get_primary_assistant_workspace()
        .await
        .map(|workspace| workspace.id);

    Ok(json!({
        "cleanupRemovedCount": cleanup_removed_count,
        "currentWorkspace": current_workspace.as_ref().map(workspace_info_to_json),
        "recentWorkspaces": workspace_list_to_json(&recent_workspaces),
        "openedWorkspaces": workspace_list_to_json(&opened_workspaces),
        "assistantWorkspaces": workspace_list_to_json(&assistant_workspaces),
        "primaryAssistantWorkspaceId": primary_assistant_workspace_id,
    }))
}

pub(crate) async fn get_assistant_workspaces(state: &PeerHostState) -> Result<Value, String> {
    let list = state.workspace_service.get_assistant_workspaces().await;
    Ok(workspace_list_to_json(&list))
}

pub(crate) async fn get_primary_assistant_workspace(
    state: &PeerHostState,
) -> Result<Value, String> {
    let workspace = state
        .workspace_service
        .get_primary_assistant_workspace()
        .await;
    Ok(workspace
        .as_ref()
        .map(workspace_info_to_json)
        .unwrap_or(Value::Null))
}

pub(crate) async fn create_assistant_workspace(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let mut workspace_info = state
        .workspace_service
        .create_assistant_workspace(None)
        .await
        .map_err(|error| format!("Failed to create assistant workspace: {error}"))?;
    let name = optional_string(request, "name")
        .map(|raw| raw.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|trimmed| !trimmed.is_empty());
    if let Some(name) = name {
        let patch = IdentityFieldPatch {
            name: Some(name),
            ..Default::default()
        };
        write_assistant_identity(state, &workspace_info.id, &patch).await?;
        if let Some(updated) = state
            .workspace_service
            .get_workspace(&workspace_info.id)
            .await
        {
            workspace_info = updated;
        }
    }
    crate::fleet_host::refresh_local_now().await;
    Ok(workspace_info_to_json(&workspace_info))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAssistantIdentityPayload {
    #[serde(alias = "workspace_id")]
    workspace_id: String,
    #[serde(flatten)]
    patch: IdentityFieldPatch,
}

pub(crate) async fn set_assistant_identity(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let payload: SetAssistantIdentityPayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid set_assistant_identity request: {error}"))?;
    let workspace_id = payload.workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("workspace_id is required".to_string());
    }
    let content = write_assistant_identity(state, workspace_id, &payload.patch).await?;
    crate::fleet_host::refresh_local_now().await;
    let workspace = state
        .workspace_service
        .get_workspace(workspace_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {workspace_id}"))?;
    Ok(json!({
        "workspace": workspace_info_to_json(&workspace),
        "content": content,
    }))
}

pub(crate) async fn set_primary_assistant_workspace(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let workspace_id = get_string(request_value(args), "workspaceId")?;
    let workspace = state
        .workspace_service
        .set_primary_assistant_workspace(&workspace_id)
        .await
        .map_err(|error| format!("Failed to set primary assistant workspace: {error}"))?;
    crate::fleet_host::refresh_local_now().await;
    Ok(workspace_info_to_json(&workspace))
}

pub(crate) async fn delete_assistant_workspace(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let workspace_id = get_string(request_value(args), "workspaceId")?;
    let workspace_info = state
        .workspace_service
        .get_workspace(&workspace_id)
        .await
        .ok_or_else(|| format!("Assistant workspace not found: {workspace_id}"))?;
    if workspace_info.workspace_kind != WorkspaceKind::Assistant {
        return Err(format!(
            "Workspace is not an assistant workspace: {workspace_id}"
        ));
    }
    if state
        .workspace_service
        .is_primary_assistant_workspace(&workspace_id)
        .await
    {
        return Err("Primary assistant workspace cannot be deleted".to_string());
    }
    let is_managed_path = state
        .workspace_service
        .is_manageable_assistant_workspace_path(&workspace_info.root_path);
    let directory_plan =
        assistant_workspace_directory_plan(&workspace_info.root_path, is_managed_path)?;

    let is_active_workspace = state
        .workspace_service
        .get_current_workspace()
        .await
        .is_some_and(|workspace| workspace.id == workspace_id);
    if is_active_workspace {
        state
            .workspace_service
            .close_workspace(&workspace_id)
            .await
            .map_err(|error| {
                format!("Failed to close assistant workspace before deletion: {error}")
            })?;
    }

    let delete_files = matches!(
        directory_plan,
        AssistantWorkspaceDirectoryPlan::DeleteDirectoryWhenPresent
    ) && workspace_info.root_path.exists();
    if delete_files {
        let workspace_path = workspace_info.root_path.to_string_lossy().to_string();
        state
            .filesystem_service
            .delete_directory(&workspace_path, true)
            .await
            .map_err(|error| format!("Failed to delete assistant workspace files: {error}"))?;
    }

    state
        .workspace_service
        .remove_workspace(&workspace_id)
        .await
        .map_err(|error| format!("Failed to remove assistant workspace state: {error}"))?;
    crate::fleet_host::refresh_local_now().await;
    Ok(Value::Null)
}

pub(crate) async fn reset_assistant_workspace(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let workspace_id = get_string(request_value(args), "workspaceId")?;
    let workspace_info = state
        .workspace_service
        .get_workspace(&workspace_id)
        .await
        .ok_or_else(|| format!("Assistant workspace not found: {workspace_id}"))?;
    if workspace_info.workspace_kind != WorkspaceKind::Assistant {
        return Err(format!(
            "Workspace is not an assistant workspace: {workspace_id}"
        ));
    }
    if !state
        .workspace_service
        .is_manageable_assistant_workspace_path(&workspace_info.root_path)
    {
        return Err(format!(
            "Workspace path is not a managed assistant workspace: {}",
            workspace_info.root_path.display()
        ));
    }
    clear_directory_contents(&workspace_info.root_path).await?;
    openbitfun_core::service::reset_workspace_persona_files_to_default(&workspace_info.root_path)
        .await
        .map_err(|error| format!("Failed to restore assistant workspace persona files: {error}"))?;
    let updated_workspace = state
        .workspace_service
        .rescan_workspace(&workspace_id)
        .await
        .map_err(|error| format!("Failed to rescan assistant workspace after reset: {error}"))?;
    crate::fleet_host::refresh_local_now().await;
    Ok(workspace_info_to_json(&updated_workspace))
}

pub(crate) async fn reset_workspace_persona_files(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_id = optional_string(request, "workspaceId");
    let legacy_path = optional_string(request, "workspacePath");
    let workspace = match (workspace_id.as_deref(), legacy_path.as_deref()) {
        (Some(id), _) => state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|error| error.to_string())?,
        (None, Some(path)) => state
            .workspace_service
            .resolve_legacy_workspace_reference(None, path, None, None)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| {
                format!(
                    "Workspace path {path} is not an open workspace; select the assistant by its ID"
                )
            })?,
        (None, None) => {
            return Err("A workspace ID is required to reset persona files".to_string());
        }
    };
    if workspace.workspace_kind != WorkspaceKind::Assistant
        || !state
            .workspace_service
            .is_manageable_assistant_workspace_path(&workspace.root_path)
    {
        return Err(format!(
            "Workspace {} is not a managed assistant workspace",
            workspace.id
        ));
    }
    openbitfun_core::service::reset_workspace_persona_files_to_default(&workspace.root_path)
        .await
        .map_err(|error| format!("Failed to reset workspace persona files: {error}"))?;
    Ok(Value::Null)
}

pub(crate) async fn get_opened_workspaces(state: &PeerHostState) -> Result<Value, String> {
    let list = state.workspace_service.get_opened_workspaces().await;
    Ok(workspace_list_to_json(&list))
}

pub(crate) async fn get_recent_workspaces(state: &PeerHostState) -> Result<Value, String> {
    let list = state.workspace_service.get_recent_workspaces().await;
    Ok(workspace_list_to_json(&list))
}

pub(crate) async fn get_current_workspace(state: &PeerHostState) -> Result<Value, String> {
    let ws = state.workspace_service.get_current_workspace().await;
    Ok(ws
        .as_ref()
        .map(workspace_info_to_json)
        .unwrap_or(Value::Null))
}

pub(crate) async fn close_workspace(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let workspace_id = get_string(request_value(args), "workspaceId")?;
    state
        .workspace_service
        .close_workspace(&workspace_id)
        .await
        .map_err(|error| format!("Failed to close workspace: {error}"))?;
    crate::fleet_host::refresh_local_now().await;
    Ok(Value::Null)
}

pub(crate) async fn remove_recent_workspace(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let workspace_id = get_string(request_value(args), "workspaceId")?;
    state
        .workspace_service
        .remove_workspace_from_recent(&workspace_id)
        .await
        .map_err(|error| format!("Failed to remove workspace from recent: {error}"))?;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateWorkspaceInfoPayload {
    #[serde(alias = "workspace_id")]
    workspace_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default, alias = "related_paths")]
    related_paths: Option<Vec<RelatedPath>>,
}

pub(crate) async fn update_workspace_info(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let payload: UpdateWorkspaceInfoPayload =
        serde_json::from_value(request_value(args).clone())
            .map_err(|error| format!("Invalid update_workspace_info request: {error}"))?;
    let updates = WorkspaceInfoUpdates {
        name: payload.name,
        description: payload.description,
        tags: payload.tags,
        related_paths: payload.related_paths,
    };
    let workspace = state
        .workspace_service
        .update_workspace_info(&payload.workspace_id, updates)
        .await
        .map_err(|error| format!("Failed to update workspace info: {error}"))?;
    crate::fleet_host::refresh_local_now().await;
    Ok(workspace_info_to_json(&workspace))
}

pub(crate) async fn set_active_workspace(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let workspace_id = get_string(request_value(args), "workspaceId")?;
    state
        .workspace_service
        .set_active_workspace(&workspace_id)
        .await
        .map_err(|error| format!("Failed to activate workspace: {error}"))?;
    let workspace = state
        .workspace_service
        .get_current_workspace()
        .await
        .ok_or_else(|| "Active workspace not found after switching".to_string())?;
    crate::fleet_host::refresh_local_now().await;
    Ok(workspace_info_to_json(&workspace))
}

pub(crate) async fn reorder_opened_workspaces(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let workspace_ids = get_string_vec(request_value(args), "workspaceIds")?;
    state
        .workspace_service
        .reorder_opened_workspaces(workspace_ids)
        .await
        .map_err(|error| format!("Failed to reorder opened workspaces: {error}"))?;
    crate::fleet_host::refresh_local_now().await;
    Ok(Value::Null)
}

pub(crate) async fn open_workspace(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    if let Some(id) = crate::peer_host::args::optional_string(request, "workspaceId") {
        let coordinator = openbitfun_core::agentic::coordination::get_global_coordinator()
            .ok_or("Conversation coordinator is unavailable")?;
        let info = coordinator
            .select_workspace_with_runtime_ownership(&state.workspace_service, &id)
            .await
            .map_err(|error| error.to_string())?;
        crate::fleet_host::refresh_local_now().await;
        return Ok(workspace_info_to_json(&info));
    }
    // Explicit new-folder/old-protocol ingress. Existing-workspace selection uses ID.
    let path = get_string(request, "path")?;
    let create_local = optional_bool(request, "createLocal").unwrap_or(false);
    let promote_if_opened = optional_bool(request, "promoteIfOpened").unwrap_or(create_local);
    state
        .compatibility
        .ensure_workspace_runtime_ownership(&SessionStoragePathRequest {
            workspace_path: PathBuf::from(&path),
            remote_connection_id: None,
            remote_ssh_host: None,
        })
        .map_err(|error| format!("Agent Runtime ownership is unavailable: {error}"))?;
    let info = state
        .workspace_service
        .open_workspace_with_options(
            PathBuf::from(path),
            WorkspaceCreateOptions {
                promote_if_opened,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("Failed to open workspace: {e}"))?;

    // Best-effort snapshot init for agent tools (mirrors server bootstrap).
    if let Err(error) = state
        .local_workspace_snapshot
        .prepare_local_workspace(info.id.clone())
        .await
    {
        tracing::warn!("Failed to initialize snapshot system: {}", error.message);
    }

    crate::fleet_host::refresh_local_now().await;
    Ok(workspace_info_to_json(&info))
}

pub(crate) async fn open_remote_workspace(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "remotePath")?;
    let connection_id = get_string(request, "connectionId")?;
    let host = optional_string(request, "sshHost");
    let rebind = if optional_bool(request, "rebindConnection").unwrap_or(false) {
        RemoteConnectionRebind::UserConfirmed
    } else {
        RemoteConnectionRebind::Reject
    };
    let promote_if_opened = optional_bool(request, "promoteIfOpened").unwrap_or(true);
    let coordinator = openbitfun_core::agentic::coordination::get_global_coordinator()
        .ok_or("Conversation coordinator is unavailable")?;
    let info = coordinator
        .create_remote_workspace_with_runtime_ownership(
            &state.workspace_service,
            &path,
            &connection_id,
            host.as_deref(),
            rebind,
            promote_if_opened,
        )
        .await
        .map_err(|e| {
            let message = e.to_string();
            remote_workspace_connection_conflict_message(&message)
                .map(str::to_string)
                .unwrap_or(message)
        })?;
    crate::fleet_host::refresh_local_now().await;
    Ok(workspace_info_to_json(&info))
}

pub(crate) async fn reload_config() -> Result<Value, String> {
    openbitfun_core::service::config::reload_global_config()
        .await
        .map_err(|e| format!("Failed to reload config: {e}"))?;
    Ok(json!("Configuration reloaded successfully"))
}

pub(crate) async fn cleanup_invalid_workspaces(state: &PeerHostState) -> Result<Value, String> {
    let removed = state
        .workspace_service
        .cleanup_invalid_workspaces()
        .await
        .map_err(|e| format!("Failed to cleanup invalid workspaces: {e}"))?;
    Ok(json!(removed))
}

pub(crate) async fn ssh_list_saved_connections() -> Result<Value, String> {
    let state =
        openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services()
            .await?;
    let ssh = state
        .get_ssh_manager()
        .await
        .ok_or("SSH manager is unavailable")?;
    serde_json::to_value(ssh.get_saved_connections().await).map_err(|e| e.to_string())
}

pub(crate) async fn get_workspace_icon(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: openbitfun_core::service::workspace::WorkspaceIconRequest =
        serde_json::from_value(request_value(args).clone()).map_err(|e| e.to_string())?;
    serde_json::to_value(
        state
            .workspace_service
            .get_workspace_icon(&request.workspace_id)
            .await?,
    )
    .map_err(|e| e.to_string())
}

pub(crate) async fn set_workspace_icon(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = serde_json::from_value(request_value(args).clone()).map_err(|e| e.to_string())?;
    let result = serde_json::to_value(state.workspace_service.set_workspace_icon(request).await?)
        .map_err(|e| e.to_string())?;
    crate::fleet_host::refresh_local_now().await;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{assistant_workspace_directory_plan, AssistantWorkspaceDirectoryPlan};

    #[test]
    fn unmanaged_existing_assistant_directories_are_refused() {
        let temp = tempfile::tempdir().expect("temp root");
        let unmanaged = temp.path().join("Documents").join("not-managed");
        std::fs::create_dir_all(&unmanaged).expect("create dir");
        let err = assistant_workspace_directory_plan(&unmanaged, false)
            .expect_err("unmanaged existing directory must be refused");
        assert!(err.starts_with("Workspace path is not a managed assistant workspace"));
        assert!(unmanaged.exists());
    }

    #[test]
    fn managed_or_missing_assistant_directories_plan_cleanly() {
        let temp = tempfile::tempdir().expect("temp root");
        let missing = temp.path().join("missing-assistant");
        assert_eq!(
            assistant_workspace_directory_plan(&missing, true),
            Ok(AssistantWorkspaceDirectoryPlan::DeleteDirectoryWhenPresent)
        );
        assert_eq!(
            assistant_workspace_directory_plan(&missing, false),
            Ok(AssistantWorkspaceDirectoryPlan::RegistryEntryOnly)
        );
    }
}
