//! Permission HostInvoke handlers for CLI Peer Host.

use serde_json::{json, Value};

use openbitfun_agent_runtime::sdk::{PermissionGrantKey, PermissionReply};
use openbitfun_core::agentic::workspace::WorkspaceBinding;
use openbitfun_core::service::workspace::WorkspaceKind;

use crate::peer_host::args::{get_string, request_value};
use crate::peer_host::state::PeerHostState;

fn permission_reply(request: &Value) -> Result<PermissionReply, String> {
    let reply = get_string(request, "reply")?;
    if let Some(updated_input) = request.get("updatedInput").filter(|value| !value.is_null()) {
        if reply != "once" || !updated_input.is_object() {
            return Err("Edited input requires a one-time approval and an object".to_string());
        }
        return Ok(PermissionReply::OnceWithInput {
            updated_input: updated_input.clone(),
        });
    }
    match reply.as_str() {
        "once" => Ok(PermissionReply::Once),
        "always" => Ok(PermissionReply::Always),
        "reject" => Ok(PermissionReply::Reject {
            feedback: request
                .get("feedback")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        value => Err(format!("Unsupported permission reply: {value}")),
    }
}

fn pagination_value(request: &Value, key: &str, default: usize) -> usize {
    request
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(default)
}

async fn permission_project_id_for_workspace(
    state: &PeerHostState,
    workspace_id: &str,
) -> Result<String, String> {
    let workspace = state
        .workspace_service
        .get_workspace(workspace_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {workspace_id}"))?;
    let is_remote = workspace.workspace_kind == WorkspaceKind::Remote;
    // The record already names the workspace; its persistence identity is a
    // projection of that record, never a path lookup.
    let binding = WorkspaceBinding::resolve(&workspace.id)
        .await
        .map_err(|error| format!("Workspace identity is unavailable: {workspace_id}: {error}"))?;
    openbitfun_core::agentic::tools::pipeline::permission_project_id_for_workspace_identity(
        &binding.session_identity,
        is_remote,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn list_pending_permission_requests(state: &PeerHostState) -> Result<Value, String> {
    let requests = state
        .agent_runtime
        .pending_permission_requests()
        .map_err(|error| error.into_message())?;
    serde_json::to_value(requests)
        .map_err(|error| format!("Failed to serialize permission requests: {error}"))
}

pub(crate) fn subscribe_permission_requests() -> Result<Value, String> {
    Ok(Value::Null)
}

pub(crate) async fn respond_permission(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let request_id = get_string(request, "requestId")?;
    // Any attached surface of the account may answer any pending request on
    // this host. The Runtime mailbox is the arbiter: it resolves exactly once,
    // so a request answered in this host's TUI is simply gone by the time a
    // second answer arrives, and `respond_permission` reports that itself.
    let reply = permission_reply(request)?;
    state
        .agent_runtime
        .respond_permission(&request_id, reply)
        .await
        .map_err(|error| error.into_message())?;
    Ok(Value::Null)
}

pub(crate) async fn respond_permission_batch(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let request_id = get_string(request, "requestId")?;
    let reply = permission_reply(request)?;
    let resolved_request_ids = state
        .agent_runtime
        .respond_permission_batch(&request_id, reply)
        .await
        .map_err(|error| error.into_message())?;
    serde_json::to_value(resolved_request_ids).map_err(|error| error.to_string())
}

pub(crate) async fn list_project_permission_grants(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_id = get_string(request, "workspaceId")?;
    let project_id = permission_project_id_for_workspace(state, &workspace_id).await?;
    let grants = state
        .agent_runtime
        .list_project_permission_grants(&project_id)
        .await
        .map_err(|error| error.into_message())?;
    serde_json::to_value(grants)
        .map_err(|error| format!("Failed to serialize permission grants: {error}"))
}

pub(crate) async fn remove_project_permission_grant(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_id = get_string(request, "workspaceId")?;
    let project_id = permission_project_id_for_workspace(state, &workspace_id).await?;
    let removed = state
        .agent_runtime
        .remove_project_permission_grant(PermissionGrantKey {
            project_id,
            action: get_string(request, "action")?,
            resource: get_string(request, "resource")?,
        })
        .await
        .map_err(|error| error.into_message())?;
    Ok(json!(removed))
}

pub(crate) async fn clear_project_permission_grants(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_id = get_string(request, "workspaceId")?;
    let project_id = permission_project_id_for_workspace(state, &workspace_id).await?;
    let removed = state
        .agent_runtime
        .clear_project_permission_grants(&project_id)
        .await
        .map_err(|error| error.into_message())?;
    Ok(json!(removed))
}

pub(crate) async fn list_project_permission_audit(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_id = get_string(request, "workspaceId")?;
    let project_id = permission_project_id_for_workspace(state, &workspace_id).await?;
    let mut records = state
        .agent_runtime
        .list_project_permission_audit(&project_id)
        .await
        .map_err(|error| error.into_message())?;
    records.sort_by(|left, right| {
        right
            .timestamp_ms
            .cmp(&left.timestamp_ms)
            .then_with(|| right.audit_id.cmp(&left.audit_id))
    });
    let page = pagination_value(request, "page", 0);
    let page_size = pagination_value(request, "pageSize", 50).clamp(1, 100);
    let total = records.len();
    let offset = page.saturating_mul(page_size).min(total);
    let records = records
        .into_iter()
        .skip(offset)
        .take(page_size)
        .collect::<Vec<_>>();
    Ok(json!({
        "projectId": project_id,
        "records": records,
        "page": page,
        "pageSize": page_size,
        "total": total,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_reply_rejects_unknown_values() {
        let error = permission_reply(&json!({ "reply": "later" })).unwrap_err();
        assert_eq!(error, "Unsupported permission reply: later");
    }

    #[test]
    fn permission_reply_preserves_rejection_feedback() {
        assert_eq!(
            permission_reply(&json!({ "reply": "reject", "feedback": "not now" })).unwrap(),
            PermissionReply::Reject {
                feedback: Some("not now".to_string()),
            }
        );
    }

    #[test]
    fn permission_audit_page_size_is_bounded() {
        assert_eq!(
            pagination_value(&json!({}), "pageSize", 50).clamp(1, 100),
            50
        );
        assert_eq!(
            pagination_value(&json!({ "pageSize": 0 }), "pageSize", 50).clamp(1, 100),
            1
        );
        assert_eq!(
            pagination_value(&json!({ "pageSize": 500 }), "pageSize", 50).clamp(1, 100),
            100
        );
    }
}

/// Preserve Desktop's distinct persisted-session and exact-active-turn selectors.
pub(crate) async fn session_permission_mode(
    state: &PeerHostState,
    args: &Value,
    mutate: bool,
    active_turn_only: bool,
) -> Result<Value, String> {
    use crate::peer_host::args::{get_string, optional_string};
    use openbitfun_core::agentic::core::SessionState;

    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("session_id is required".into());
    }
    let mode = parse_selector_mode(request)?;
    let turn_id = optional_string(request, "turnId");
    if active_turn_only && turn_id.is_none() {
        return Err("turn_id is required".into());
    }
    let manager = &state.compatibility;
    let session = if mutate {
        if optional_string(request, "workspaceId").is_some()
            || optional_string(request, "workspacePath").is_some()
        {
            super::session::ensure_coordinator_session(state, args).await?;
        }
        manager
            .loaded_session_snapshot(session_id)
            .map_err(|error| error.to_string())?
            .ok_or("Session is not loaded")?
    } else {
        super::session::read_session_header_for_selector(state, request, session_id).await?
    };
    // Persisted state cannot establish a live Turn, even when a previous
    // process stopped while its on-disk snapshot still said Processing.
    let live_session = manager
        .loaded_session_snapshot(session_id)
        .map_err(|error| error.to_string())?;
    let active_turn_id = turn_id.filter(|turn_id| {
        live_session.as_ref().is_some_and(|live| matches!(
            &live.state, SessionState::Processing { current_turn_id, .. } if current_turn_id == turn_id
        ))
    });
    if mutate {
        if active_turn_only {
            let turn_id = active_turn_id
                .as_deref()
                .ok_or("Turn is no longer active for this session")?;
            match mode {
                Some(mode) => {
                    if !manager.set_active_turn_permission_mode(session_id, turn_id, mode) {
                        return Err("Turn is no longer active for this session".into());
                    }
                }
                None => {
                    manager.clear_active_turn_permission_mode(session_id, turn_id);
                }
            }
        } else {
            manager
                .update_session_permission_mode(session_id, mode)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(turn_id) = optional_string(request, "turnId") {
                manager.clear_active_turn_permission_mode(session_id, &turn_id);
            }
        }
    }
    Ok(serde_json::json!({
        "mode": if mutate { manager.session_permission_mode(session_id) } else { session.config.permission_mode },
        "turnMode": active_turn_id.as_deref().and_then(|turn| manager.active_turn_permission_mode(session_id, turn)),
        "activeTurnId": active_turn_id,
    }))
}

fn parse_selector_mode(
    request: &Value,
) -> Result<Option<openbitfun_runtime_ports::PermissionMode>, String> {
    use openbitfun_runtime_ports::PermissionMode;
    match request.get("mode") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(value)) => Ok(Some(
            PermissionMode::parse(value.trim())
                .ok_or_else(|| format!("unsupported permission mode: {value}"))?,
        )),
        _ => return Err("Invalid permission mode".into()),
    }
}

#[cfg(test)]
mod selector_tests {
    use super::*;
    use openbitfun_runtime_ports::PermissionMode;

    #[test]
    fn legacy_and_current_selectors_preserve_clear_and_explicit_modes() {
        for request in [
            serde_json::json!({}),
            serde_json::json!({"mode": null}),
            serde_json::json!({"mode": " "}),
        ] {
            assert_eq!(parse_selector_mode(&request).unwrap(), None);
        }
        assert_eq!(
            parse_selector_mode(&serde_json::json!({"mode": "full_access"})).unwrap(),
            Some(PermissionMode::FullAccess)
        );
        assert_eq!(
            parse_selector_mode(&serde_json::json!({"mode": "ask"})).unwrap(),
            Some(PermissionMode::Ask)
        );
        for value in [
            serde_json::json!("unknown-future-mode"),
            serde_json::json!(false),
            serde_json::json!({}),
        ] {
            assert!(parse_selector_mode(&serde_json::json!({"mode": value})).is_err());
        }
    }
}

/// Small live mailbox for reconnecting controllers; never reads transcript history.
pub(crate) fn get_session_interaction_mailbox(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let session_id = get_string(request_value(args), "sessionId")?;
    serde_json::to_value(
        state
            .agent_runtime
            .session_interaction_snapshot(&session_id),
    )
    .map_err(|error| error.to_string())
}

fn project_permission_rules_revision(content: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    match content {
        Some(content) => {
            hasher.update(b"present\0");
            hasher.update(content.as_bytes());
        }
        None => hasher.update(b"missing\0"),
    }
    format!("{:x}", hasher.finalize())
}

fn local_project_permission_path_for(
    workspace: &openbitfun_core::service::workspace::WorkspaceInfo,
) -> Result<std::path::PathBuf, String> {
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Err(format!(
            "CLI peer project permission rules do not support remote workspaces: {}",
            workspace.id
        ));
    }
    Ok(
        openbitfun_core::service::config::project_permission_store::project_permission_file_path(
            &workspace.root_path,
        ),
    )
}

async fn local_project_permission_path(
    workspace_service: &openbitfun_core::service::workspace::WorkspaceService,
    workspace_id: &str,
) -> Result<std::path::PathBuf, String> {
    let workspace = workspace_service
        .get_workspace(workspace_id)
        .await
        .ok_or_else(|| format!("Workspace not found: {workspace_id}"))?;
    local_project_permission_path_for(&workspace)
}

async fn get_project_permission_rules_in(
    workspace_service: &openbitfun_core::service::workspace::WorkspaceService,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_id = get_string(request, "workspaceId")?;
    let path = local_project_permission_path(workspace_service, &workspace_id).await?;
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "Failed to read project permission rules '{}': {error}",
                path.display()
            ))
        }
    };
    let rules = content
        .as_deref()
        .map(openbitfun_core::service::config::project_permission_store::deserialize_project_permission_config)
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or_default()
        .rules;
    Ok(json!({
        "rules": rules,
        "revision": project_permission_rules_revision(content.as_deref()),
    }))
}

pub(crate) async fn get_project_permission_rules(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    get_project_permission_rules_in(&state.workspace_service, args).await
}

async fn save_project_permission_rules_in(
    workspace_service: &openbitfun_core::service::workspace::WorkspaceService,
    args: &Value,
) -> Result<Value, String> {
    use openbitfun_core::service::config::project_permission_store::ProjectPermissionConfig;
    use openbitfun_product_domains::tool_permissions::PermissionRule;

    let request = request_value(args);
    let workspace_id = get_string(request, "workspaceId")?;
    let expected_revision = get_string(request, "revision")?;
    let rules: Vec<PermissionRule> = serde_json::from_value(
        request
            .get("rules")
            .cloned()
            .ok_or_else(|| "Missing 'rules' field".to_string())?,
    )
    .map_err(|error| format!("Invalid project permission rules: {error}"))?;
    if rules
        .iter()
        .any(|rule| rule.action.trim().is_empty() || rule.resource.trim().is_empty())
    {
        return Err("Project permission rule action and resource must be non-empty".to_string());
    }
    let path = local_project_permission_path(workspace_service, &workspace_id).await?;
    let current_content = match tokio::fs::read_to_string(&path).await {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "Failed to read project permission rules '{}': {error}",
                path.display()
            ))
        }
    };
    let current_revision = project_permission_rules_revision(current_content.as_deref());
    if expected_revision != current_revision {
        return Err(
            "Project permission rules changed outside OpenBitFun. Reload before saving."
                .to_string(),
        );
    }
    let content = format!(
        "{}\n",
        serde_json::to_string_pretty(&ProjectPermissionConfig {
            rules: rules.clone(),
        })
        .map_err(|error| format!("Failed to serialize project permission rules: {error}"))?
    );
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            format!(
                "Failed to create project permission rules directory '{}': {error}",
                parent.display()
            )
        })?;
    }
    tokio::fs::write(&path, &content).await.map_err(|error| {
        format!(
            "Failed to write project permission rules '{}': {error}",
            path.display()
        )
    })?;
    Ok(json!({
        "rules": rules,
        "revision": project_permission_rules_revision(Some(&content)),
    }))
}

pub(crate) async fn save_project_permission_rules(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    save_project_permission_rules_in(&state.workspace_service, args).await
}

#[cfg(test)]
mod project_permission_tests {
    use super::*;
    use openbitfun_core::service::workspace::{WorkspaceInfoRuntimeExt, WorkspaceService};

    #[tokio::test]
    async fn project_permission_rules_round_trip_and_reject_stale_revision() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let workspaces = WorkspaceService::new_isolated_for_tests(temp.path().join("user")).await;
        let ws = workspaces
            .register_local_workspace_record(root)
            .await
            .unwrap();

        let initial = get_project_permission_rules_in(
            &workspaces,
            &json!({ "request": { "workspaceId": ws.id } }),
        )
        .await
        .unwrap();
        assert_eq!(initial["rules"], json!([]));
        let rev0 = initial["revision"].as_str().unwrap().to_string();

        let saved = save_project_permission_rules_in(
            &workspaces,
            &json!({
                "request": {
                    "workspaceId": ws.id,
                    "revision": rev0,
                    "rules": [{
                        "action": "shell_execute",
                        "resource": "cargo test*",
                        "effect": "allow"
                    }]
                }
            }),
        )
        .await
        .unwrap();
        let rev1 = saved["revision"].as_str().unwrap().to_string();
        assert_ne!(rev0, rev1);
        assert_eq!(saved["rules"].as_array().unwrap().len(), 1);

        let stale_err = save_project_permission_rules_in(
            &workspaces,
            &json!({
                "request": {
                    "workspaceId": ws.id,
                    "revision": rev0,
                    "rules": []
                }
            }),
        )
        .await
        .unwrap_err();
        assert!(stale_err.contains("Reload before saving"));

        let reloaded = get_project_permission_rules_in(
            &workspaces,
            &json!({ "request": { "workspaceId": ws.id } }),
        )
        .await
        .unwrap();
        assert_eq!(reloaded["revision"], json!(rev1));
        assert_eq!(reloaded["rules"][0]["resource"], json!("cargo test*"));
    }

    #[tokio::test]
    async fn project_permission_rules_refuse_remote_workspace_loudly() {
        let temp = tempfile::tempdir().unwrap();
        let mut workspace =
            openbitfun_core::service::workspace::WorkspaceInfo::new_without_worktree(
                temp.path().to_path_buf(),
                Default::default(),
            )
            .await
            .unwrap();
        workspace.workspace_kind = WorkspaceKind::Remote;
        let err = local_project_permission_path_for(&workspace).unwrap_err();
        assert!(err.contains("do not support remote workspaces"));
    }
}
