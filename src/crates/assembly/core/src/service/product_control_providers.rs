//! Shared host-agnostic executors for the 8 typed OpenBitFun product-control
//! capability providers (`workspace-ops`, `skills-ops`, `acp-ops`,
//! `ecosystem-ops`, `review-ops`, `ai-policy-ops`, `agent-assistant-ops`,
//! `automation-data-ops`).
//!
//! Each product host (Desktop via `BackendService::dispatch`, CLI via
//! `peer_host::commands::dispatch`) supplies a 1-method [`LocalCommandDispatcher`].
//! All argument translation, safety checks, and result normalization live here
//! once so Desktop, CLI, and peer-forwarded `product_control_invoke` behave
//! identically and degrade loudly when an operation is unsupported on a host.

use async_trait::async_trait;
use openbitfun_product_domains::product_capability_ops::{
    ProductCapabilityOpRequest, RemoteTransferDirection, SessionFileDecisionAction,
};
use serde_json::{json, Value};

/// Minimal command-dispatch adapter supplied by Desktop or CLI product hosts.
#[async_trait]
pub trait LocalCommandDispatcher: Send + Sync {
    async fn invoke(&self, command: &str, args: Value) -> Result<Value, String>;
}

fn insert_optional_str(map: &mut serde_json::Map<String, Value>, key: &str, val: Option<String>) {
    if let Some(v) = val.filter(|s| !s.trim().is_empty()) {
        map.insert(key.to_string(), Value::String(v));
    }
}

fn build_workspace_scope(workspace_id: Option<String>, workspace_path: Option<String>) -> Value {
    let mut obj = serde_json::Map::new();
    insert_optional_str(&mut obj, "workspaceId", workspace_id);
    insert_optional_str(&mut obj, "workspacePath", workspace_path);
    Value::Object(obj)
}

/// Execute one validated [`ProductCapabilityOpRequest`] against the executing
/// product host's authoritative backend commands.
pub async fn execute_capability_op(
    dispatcher: &dyn LocalCommandDispatcher,
    request: ProductCapabilityOpRequest,
) -> Result<Value, String> {
    let (provider_id, operation_id) = request.provider_and_operation();
    let result = match request {
        // ── workspace-ops ────────────────────────────────────────────────
        ProductCapabilityOpRequest::ListWorkspaces {} => {
            let opened = dispatcher
                .invoke("get_opened_workspaces", json!({}))
                .await?;
            let recent = dispatcher
                .invoke("get_recent_workspaces", json!({}))
                .await
                .unwrap_or_else(|_| json!([]));
            let current = dispatcher
                .invoke("get_current_workspace", json!({}))
                .await
                .unwrap_or(Value::Null);
            json!({
                "currentWorkspace": current,
                "openedWorkspaces": opened,
                "recentWorkspaces": recent,
            })
        }
        ProductCapabilityOpRequest::OpenWorkspace {
            workspace_id,
            path,
            create_local,
            remote_connection_id,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("createLocal".into(), Value::Bool(create_local));
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "path", path);
            insert_optional_str(&mut req, "remoteConnectionId", remote_connection_id);
            dispatcher
                .invoke("open_workspace", json!({ "request": Value::Object(req) }))
                .await?
        }
        ProductCapabilityOpRequest::CloseWorkspace { workspace_id } => {
            dispatcher
                .invoke(
                    "close_workspace",
                    json!({ "request": { "workspaceId": workspace_id } }),
                )
                .await?
        }
        ProductCapabilityOpRequest::SetActiveWorkspace { workspace_id } => {
            dispatcher
                .invoke(
                    "set_active_workspace",
                    json!({ "request": { "workspaceId": workspace_id } }),
                )
                .await?
        }
        ProductCapabilityOpRequest::ListConnections {} => {
            let connections = dispatcher
                .invoke("ssh_list_saved_connections", json!({}))
                .await?;
            json!({ "connections": connections })
        }
        ProductCapabilityOpRequest::DiscoverEnvironments { docker_ssh_config } => {
            let ssh_hosts = dispatcher
                .invoke("ssh_list_config_hosts", json!({}))
                .await
                .unwrap_or_else(|e| json!({ "unavailable": e }));
            let docker = dispatcher
                .invoke(
                    "ssh_list_docker_containers",
                    json!({ "config": docker_ssh_config }),
                )
                .await
                .unwrap_or_else(|e| json!({ "unavailable": e }));
            let wsl = dispatcher
                .invoke("ssh_list_wsl_distributions", json!({}))
                .await
                .unwrap_or_else(|e| json!({ "unavailable": e }));
            json!({
                "sshConfigHosts": ssh_hosts,
                "dockerContainers": docker,
                "wslDistributions": wsl,
            })
        }
        ProductCapabilityOpRequest::TestConnection { config } => {
            dispatcher
                .invoke("ssh_test_connection", json!({ "config": config }))
                .await?
        }
        ProductCapabilityOpRequest::Connect { config } => {
            dispatcher
                .invoke("ssh_connect", json!({ "config": config }))
                .await?
        }
        ProductCapabilityOpRequest::Disconnect { connection_id } => {
            dispatcher
                .invoke("ssh_disconnect", json!({ "connectionId": connection_id }))
                .await?
        }
        ProductCapabilityOpRequest::OpenRemoteWorkspace {
            connection_id,
            connection_name,
            remote_path,
            ssh_host,
            rebind_connection,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("connectionId".into(), Value::String(connection_id));
            req.insert("connectionName".into(), Value::String(connection_name));
            req.insert("remotePath".into(), Value::String(remote_path));
            req.insert("rebindConnection".into(), Value::Bool(rebind_connection));
            insert_optional_str(&mut req, "sshHost", ssh_host);
            dispatcher
                .invoke(
                    "open_remote_workspace",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::TransferFile {
            direction,
            connection_id,
            local_path,
            remote_path,
        } => {
            let transfer_id = format!("pc-transfer-{}", uuid::Uuid::new_v4());
            let (command, args) = match direction {
                RemoteTransferDirection::Upload => (
                    "remote_upload_from_local_path",
                    json!({
                        "connectionId": connection_id,
                        "localPath": local_path,
                        "remotePath": remote_path,
                        "transferId": transfer_id,
                    }),
                ),
                RemoteTransferDirection::Download => (
                    "remote_download_to_local_path",
                    json!({
                        "connectionId": connection_id,
                        "remotePath": remote_path,
                        "localPath": local_path,
                        "transferId": transfer_id,
                    }),
                ),
            };
            dispatcher.invoke(command, args).await?
        }

        // ── skills-ops ───────────────────────────────────────────────────
        ProductCapabilityOpRequest::ListSkills {
            workspace_id,
            workspace_path,
            force_refresh,
        } => {
            let mut args = serde_json::Map::new();
            args.insert("forceRefresh".into(), Value::Bool(force_refresh));
            args.insert("includeDiagnostics".into(), Value::Bool(false));
            insert_optional_str(&mut args, "workspaceId", workspace_id.clone());
            insert_optional_str(&mut args, "workspacePath", workspace_path.clone());
            let skills = dispatcher
                .invoke("get_skill_configs", Value::Object(args))
                .await?;
            let scope = build_workspace_scope(workspace_id, workspace_path);
            let settings = dispatcher
                .invoke("get_global_skill_settings", json!({ "request": scope }))
                .await
                .unwrap_or(Value::Null);
            json!({
                "skills": skills,
                "globalSettings": settings,
            })
        }
        ProductCapabilityOpRequest::SearchMarket { query, limit } => {
            if let Some(q) = query.filter(|s| !s.trim().is_empty()) {
                let mut req = json!({ "query": q });
                if let Some(l) = limit {
                    req["limit"] = Value::from(l);
                }
                dispatcher
                    .invoke("search_skill_market", json!({ "request": req }))
                    .await?
            } else {
                let mut req = json!({});
                if let Some(l) = limit {
                    req["limit"] = Value::from(l);
                }
                dispatcher
                    .invoke("list_skill_market", json!({ "request": req }))
                    .await?
            }
        }
        ProductCapabilityOpRequest::InstallMarketSkill {
            package,
            level,
            workspace_id,
            workspace_path,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("package".into(), Value::String(package));
            insert_optional_str(&mut req, "level", level);
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            dispatcher
                .invoke(
                    "download_skill_market",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::AddLocalSkill {
            source_path,
            level,
            workspace_id,
            workspace_path,
            target_name,
        } => {
            let mut args = serde_json::Map::new();
            args.insert("sourcePath".into(), Value::String(source_path));
            args.insert(
                "level".into(),
                Value::String(level.unwrap_or_else(|| "user".to_string())),
            );
            insert_optional_str(&mut args, "workspaceId", workspace_id);
            insert_optional_str(&mut args, "workspacePath", workspace_path);
            insert_optional_str(&mut args, "targetName", target_name);
            dispatcher.invoke("add_skill", Value::Object(args)).await?
        }
        ProductCapabilityOpRequest::SetSkillEnabled {
            skill_key,
            enabled,
            workspace_id,
            workspace_path,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("skillKey".into(), Value::String(skill_key));
            req.insert("disabled".into(), Value::Bool(!enabled));
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            dispatcher
                .invoke(
                    "set_global_skill_disabled",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::DeleteSkill {
            skill_key,
            workspace_id,
            workspace_path,
        } => {
            let mut args = serde_json::Map::new();
            args.insert("skillKey".into(), Value::String(skill_key));
            insert_optional_str(&mut args, "workspaceId", workspace_id);
            insert_optional_str(&mut args, "workspacePath", workspace_path);
            dispatcher
                .invoke("delete_skill", Value::Object(args))
                .await?
        }

        // ── acp-ops ──────────────────────────────────────────────────────
        ProductCapabilityOpRequest::ListClients {} => {
            let clients = dispatcher.invoke("get_acp_clients", json!({})).await?;
            json!({ "clients": clients })
        }
        ProductCapabilityOpRequest::ProbeClient {
            remote_connection_id,
            force_refresh,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("forceRefresh".into(), Value::Bool(force_refresh));
            insert_optional_str(&mut req, "remoteConnectionId", remote_connection_id);
            dispatcher
                .invoke(
                    "probe_acp_client_requirements",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::InstallClient {
            client_id,
            remote_connection_id,
            predownload_adapter_only,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("clientId".into(), Value::String(client_id));
            insert_optional_str(&mut req, "remoteConnectionId", remote_connection_id);
            let command = if predownload_adapter_only {
                "predownload_acp_client_adapter"
            } else {
                "install_acp_client_cli"
            };
            dispatcher
                .invoke(command, json!({ "request": Value::Object(req) }))
                .await?
        }
        ProductCapabilityOpRequest::SetAcpPermissionMode {
            client_id,
            permission_mode,
        } => {
            dispatcher
                .invoke(
                    "set_acp_client_permission_mode",
                    json!({
                        "request": {
                            "clientId": client_id,
                            "permissionMode": permission_mode,
                        }
                    }),
                )
                .await?
        }

        // ── ecosystem-ops ────────────────────────────────────────────────
        ProductCapabilityOpRequest::DiscoverSources {
            workspace_id,
            workspace_path,
            force_refresh,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("forceRefresh".into(), Value::Bool(force_refresh));
            insert_optional_str(&mut req, "workspaceId", workspace_id.clone());
            insert_optional_str(&mut req, "workspacePath", workspace_path.clone());
            let discovery = dispatcher
                .invoke(
                    "get_external_source_discovery_snapshot",
                    json!({ "request": Value::Object(req.clone()) }),
                )
                .await?;
            let control = dispatcher
                .invoke(
                    "get_external_source_control_snapshot",
                    json!({ "request": Value::Object(req) }),
                )
                .await
                .unwrap_or(Value::Null);
            json!({
                "discovery": discovery,
                "control": control,
            })
        }
        ProductCapabilityOpRequest::SetSourceEnabled {
            source_key,
            enabled,
            expected_preference_revision,
            workspace_id,
            workspace_path,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("sourceKey".into(), Value::String(source_key));
            req.insert("enabled".into(), Value::Bool(enabled));
            req.insert(
                "expectedPreferenceRevision".into(),
                Value::from(expected_preference_revision),
            );
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            dispatcher
                .invoke(
                    "set_external_source_enabled_command",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::PlanMcpImport {
            workspace_id,
            workspace_path,
        } => {
            let scope = build_workspace_scope(workspace_id, workspace_path);
            dispatcher
                .invoke(
                    "plan_external_mcp_import_command",
                    json!({ "request": scope }),
                )
                .await?
        }
        ProductCapabilityOpRequest::ApplyMcpImport {
            workspace_id,
            workspace_path,
            plan,
            server_keys,
        } => {
            let mut req = match plan {
                Some(Value::Object(map)) => map,
                _ => serde_json::Map::new(),
            };
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            if let Some(keys) = server_keys {
                req.insert("serverKeys".into(), json!(keys));
            }
            dispatcher
                .invoke(
                    "apply_external_mcp_import_command",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::ListExternalSessions {
            workspace_id,
            workspace_path,
        } => {
            let scope = build_workspace_scope(workspace_id, workspace_path);
            dispatcher
                .invoke(
                    "list_removed_external_sessions",
                    json!({ "request": scope }),
                )
                .await?
        }
        ProductCapabilityOpRequest::RestoreExternalSession {
            session_id,
            workspace_id,
            workspace_path,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("sessionId".into(), Value::String(session_id));
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            dispatcher
                .invoke(
                    "restore_removed_external_session",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }

        // ── review-ops ───────────────────────────────────────────────────
        ProductCapabilityOpRequest::LaunchDeepReview {
            parent_session_id,
            workspace_id,
            workspace_path,
            intent,
            command_text,
            files,
            focus,
            dry_run,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("parentSessionId".into(), Value::String(parent_session_id));
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            insert_optional_str(&mut req, "intent", intent);
            insert_optional_str(&mut req, "commandText", command_text);
            if !files.is_empty() {
                req.insert("files".into(), json!(files));
            }
            insert_optional_str(&mut req, "focus", focus);
            req.insert("dryRun".into(), Value::Bool(dry_run));
            dispatcher
                .invoke("launch_review", json!({ "request": Value::Object(req) }))
                .await?
        }
        ProductCapabilityOpRequest::LaunchPrReview {
            workspace_id,
            remote_id,
            pull_request_id,
            provider,
            parent_session_id,
            dry_run,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("workspaceId".into(), Value::String(workspace_id));
            req.insert("remoteId".into(), Value::String(remote_id));
            req.insert("pullRequestId".into(), Value::String(pull_request_id));
            req.insert("provider".into(), provider);
            insert_optional_str(&mut req, "parentSessionId", parent_session_id);
            req.insert("dryRun".into(), Value::Bool(dry_run));
            dispatcher
                .invoke(
                    "review_platform_launch_pull_request_review",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::LaunchRemediation { payload } => {
            dispatcher
                .invoke("launch_review_remediation", json!({ "request": payload }))
                .await?
        }
        ProductCapabilityOpRequest::ListReviewRecords {
            workspace_id,
            parent_session_id,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("workspaceId".into(), Value::String(workspace_id));
            insert_optional_str(&mut req, "parentSessionId", parent_session_id);
            dispatcher
                .invoke(
                    "list_session_review_records",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::GenerateCommitMessage { repo_path, options } => {
            let mut req = json!({ "repoPath": repo_path });
            if let Some(opts) = options {
                req["options"] = opts;
            }
            dispatcher
                .invoke("generate_commit_message", json!({ "request": req }))
                .await?
        }
        ProductCapabilityOpRequest::SessionDiffStats {
            session_id,
            workspace_id,
            workspace_path,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("sessionId".into(), Value::String(session_id));
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            let req_val = Value::Object(req);
            let stats = dispatcher
                .invoke(
                    "get_session_file_diff_stats",
                    json!({ "request": req_val.clone() }),
                )
                .await?;
            let files = dispatcher
                .invoke("get_session_files", json!({ "request": req_val }))
                .await
                .unwrap_or_else(|_| json!([]));
            json!({ "stats": stats, "files": files })
        }
        ProductCapabilityOpRequest::AcceptOrRejectFile {
            decision,
            session_id,
            file_path,
            workspace_id,
            workspace_path,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("sessionId".into(), Value::String(session_id));
            insert_optional_str(&mut req, "filePath", file_path);
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            let command = match decision {
                SessionFileDecisionAction::AcceptFile => "accept_file",
                SessionFileDecisionAction::RejectFile => "reject_file",
                SessionFileDecisionAction::AcceptSession => "accept_session",
            };
            dispatcher
                .invoke(command, json!({ "request": Value::Object(req) }))
                .await?
        }
        ProductCapabilityOpRequest::RollbackSessionTurn {
            session_id,
            turn_index,
            workspace_id,
            workspace_path,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("sessionId".into(), Value::String(session_id));
            req.insert("turnIndex".into(), Value::from(turn_index));
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            dispatcher
                .invoke(
                    "rollback_session_to_turn",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }

        // ── ai-policy-ops ────────────────────────────────────────────────
        ProductCapabilityOpRequest::ListCatalog {} => {
            let catalog = dispatcher.invoke("get_ai_model_catalog", json!({})).await?;
            let routing = dispatcher
                .invoke("get_model_routing_status", json!({ "request": {} }))
                .await
                .unwrap_or(Value::Null);
            let default_models = dispatcher
                .invoke("get_config", json!({ "path": "ai.default_models" }))
                .await
                .unwrap_or(Value::Null);
            let task_models = dispatcher
                .invoke("get_config", json!({ "path": "ai.task_models" }))
                .await
                .unwrap_or(Value::Null);
            json!({
                "catalog": catalog,
                "defaultModels": default_models,
                "taskModels": task_models,
                "routingStatus": routing,
            })
        }
        ProductCapabilityOpRequest::ListModelPools { pool_id } => {
            let pools = dispatcher.invoke("get_model_pools", json!({})).await?;
            let status = if let Some(id) = pool_id.filter(|v| !v.trim().is_empty()) {
                dispatcher
                    .invoke(
                        "get_model_pool_status",
                        json!({ "request": { "poolId": id } }),
                    )
                    .await
                    .ok()
            } else {
                None
            };
            json!({
                "pools": pools,
                "poolStatus": status,
            })
        }
        ProductCapabilityOpRequest::SaveModelPool { pool } => {
            dispatcher
                .invoke("save_model_pool", json!({ "request": { "pool": pool } }))
                .await?
        }
        ProductCapabilityOpRequest::DeleteModelPool { pool_id } => {
            dispatcher
                .invoke(
                    "delete_model_pool",
                    json!({ "request": { "poolId": pool_id } }),
                )
                .await?
        }
        ProductCapabilityOpRequest::SetTaskModel { task, selection } => {
            dispatcher
                .invoke(
                    "set_task_model",
                    json!({ "request": { "task": task, "selection": selection } }),
                )
                .await?
        }
        ProductCapabilityOpRequest::SetDefaultModels { primary, fast } => {
            let mut current = dispatcher
                .invoke("get_config", json!({ "path": "ai.default_models" }))
                .await
                .unwrap_or_else(|_| json!({}));
            if !current.is_object() {
                current = json!({});
            }
            if let Some(obj) = current.as_object_mut() {
                if let Some(p) = primary.filter(|v| !v.trim().is_empty()) {
                    obj.insert("primary".into(), Value::String(p));
                }
                if let Some(f) = fast.filter(|v| !v.trim().is_empty()) {
                    obj.insert("fast".into(), Value::String(f));
                }
            }
            dispatcher
                .invoke(
                    "set_config",
                    json!({ "path": "ai.default_models", "value": current }),
                )
                .await?;
            let updated = dispatcher
                .invoke("get_config", json!({ "path": "ai.default_models" }))
                .await
                .unwrap_or(Value::Null);
            json!({ "defaultModels": updated })
        }
        ProductCapabilityOpRequest::GetPermissions {} => {
            let permissions = dispatcher
                .invoke("get_permission_settings", json!({}))
                .await?;
            let device_dispatch = dispatcher
                .invoke("get_config", json!({ "path": "superagent" }))
                .await
                .unwrap_or(Value::Null);
            json!({
                "permissions": permissions,
                "deviceDispatchPolicy": device_dispatch,
            })
        }
        ProductCapabilityOpRequest::SetPermissionMode { mode } => {
            dispatcher
                .invoke(
                    "set_permission_mode",
                    json!({ "request": { "mode": mode } }),
                )
                .await?
        }
        ProductCapabilityOpRequest::UpsertPermissionRule { index, rule } => {
            let mut req = json!({ "rule": rule });
            if let Some(i) = index {
                req["index"] = Value::from(i);
            }
            dispatcher
                .invoke("upsert_permission_rule", json!({ "request": req }))
                .await?
        }
        ProductCapabilityOpRequest::DeletePermissionRule { index, expected } => {
            let mut req = json!({ "index": index });
            if let Some(exp) = expected {
                req["expected"] = exp;
            }
            dispatcher
                .invoke("delete_permission_rule", json!({ "request": req }))
                .await?
        }
        ProductCapabilityOpRequest::SetDeviceDispatchPolicy {
            accept_dispatch,
            allow_auto_approval,
        } => {
            let mut req = serde_json::Map::new();
            if let Some(v) = accept_dispatch {
                req.insert("acceptDispatch".into(), Value::Bool(v));
            }
            if let Some(v) = allow_auto_approval {
                req.insert("allowAutoApproval".into(), Value::Bool(v));
            }
            dispatcher
                .invoke(
                    "set_superagent_settings",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::GetWebSearchStatus {} => {
            let config = dispatcher
                .invoke("get_config", json!({ "path": "ai.web_search" }))
                .await
                .unwrap_or(Value::Null);
            let credential_status = dispatcher
                .invoke("get_web_search_credential_status", json!({ "request": {} }))
                .await
                .unwrap_or(Value::Null);
            json!({
                "config": config,
                "credentialStatus": credential_status,
            })
        }
        ProductCapabilityOpRequest::SetWebSearchProvider {
            provider,
            endpoint,
            protocol,
        } => {
            let mut req = serde_json::Map::new();
            insert_optional_str(&mut req, "provider", provider);
            insert_optional_str(&mut req, "endpoint", endpoint);
            insert_optional_str(&mut req, "protocol", protocol);
            dispatcher
                .invoke(
                    "set_web_search_provider",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }

        // ── agent-assistant-ops ──────────────────────────────────────────
        ProductCapabilityOpRequest::ListAgents {
            workspace_id,
            workspace_path,
        } => {
            let scope = build_workspace_scope(workspace_id, workspace_path);
            let modes = dispatcher
                .invoke("get_available_modes", json!({ "request": scope.clone() }))
                .await?;
            let subagents = dispatcher
                .invoke("list_manageable_subagents", json!({ "request": scope }))
                .await
                .unwrap_or_else(|_| json!([]));
            json!({ "modes": modes, "subagents": subagents })
        }
        ProductCapabilityOpRequest::GetAgentDetail {
            agent_id,
            is_subagent,
            workspace_id,
            workspace_path,
        } => {
            let mut req = serde_json::Map::new();
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            if is_subagent {
                req.insert("subagentId".into(), Value::String(agent_id));
                dispatcher
                    .invoke(
                        "get_subagent_detail",
                        json!({ "request": Value::Object(req) }),
                    )
                    .await?
            } else {
                req.insert("agentId".into(), Value::String(agent_id));
                dispatcher
                    .invoke(
                        "get_custom_agent_detail",
                        json!({ "request": Value::Object(req) }),
                    )
                    .await?
            }
        }
        ProductCapabilityOpRequest::CreateAgent {
            kind,
            id,
            name,
            description,
            prompt,
            level,
            tools,
            readonly,
            review,
            model,
            workspace_id,
            workspace_path,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("kind".into(), Value::String(kind));
            req.insert("id".into(), Value::String(id));
            req.insert("name".into(), Value::String(name));
            req.insert("description".into(), Value::String(description));
            req.insert("prompt".into(), Value::String(prompt));
            insert_optional_str(&mut req, "level", level);
            if let Some(t) = tools {
                req.insert("tools".into(), json!(t));
            }
            if let Some(ro) = readonly {
                req.insert("readonly".into(), Value::Bool(ro));
            }
            if let Some(rv) = review {
                req.insert("review".into(), Value::Bool(rv));
            }
            insert_optional_str(&mut req, "model", model);
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            dispatcher
                .invoke(
                    "create_custom_agent",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::UpdateAgent {
            agent_id,
            is_subagent,
            mut payload,
        } => {
            if let Some(obj) = payload.as_object_mut() {
                if is_subagent {
                    obj.entry("subagentId".to_string())
                        .or_insert(Value::String(agent_id));
                } else {
                    obj.entry("agentId".to_string())
                        .or_insert(Value::String(agent_id));
                }
            }
            let command = if is_subagent {
                "update_subagent"
            } else {
                "update_custom_agent"
            };
            dispatcher
                .invoke(command, json!({ "request": payload }))
                .await?
        }
        ProductCapabilityOpRequest::DeleteAgent {
            agent_id,
            is_subagent,
            workspace_id,
            workspace_path,
        } => {
            let mut req = serde_json::Map::new();
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            if is_subagent {
                req.insert("subagentId".into(), Value::String(agent_id));
                dispatcher
                    .invoke("delete_subagent", json!({ "request": Value::Object(req) }))
                    .await?
            } else {
                req.insert("agentId".into(), Value::String(agent_id));
                dispatcher
                    .invoke(
                        "delete_custom_agent",
                        json!({ "request": Value::Object(req) }),
                    )
                    .await?
            }
        }
        ProductCapabilityOpRequest::ListAssistants {} => {
            let assistants = dispatcher
                .invoke("get_assistant_workspaces", json!({}))
                .await?;
            let primary = dispatcher
                .invoke("get_primary_assistant_workspace", json!({ "request": {} }))
                .await
                .unwrap_or(Value::Null);
            json!({
                "assistants": assistants,
                "primaryAssistant": primary,
            })
        }
        ProductCapabilityOpRequest::CreateAssistant { name } => {
            let mut req = serde_json::Map::new();
            insert_optional_str(&mut req, "name", name);
            dispatcher
                .invoke(
                    "create_assistant_workspace",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::SetAssistantIdentity {
            workspace_id,
            name,
            role,
            creature,
            vibe,
            emoji,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("workspaceId".into(), Value::String(workspace_id));
            insert_optional_str(&mut req, "name", name);
            insert_optional_str(&mut req, "role", role);
            insert_optional_str(&mut req, "creature", creature);
            insert_optional_str(&mut req, "vibe", vibe);
            insert_optional_str(&mut req, "emoji", emoji);
            dispatcher
                .invoke(
                    "set_assistant_identity",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::SetPrimaryAssistant { workspace_id } => {
            dispatcher
                .invoke(
                    "set_primary_assistant_workspace",
                    json!({ "request": { "workspaceId": workspace_id } }),
                )
                .await?
        }
        ProductCapabilityOpRequest::ResetAssistant { workspace_id } => {
            dispatcher
                .invoke(
                    "reset_assistant_workspace",
                    json!({ "request": { "workspaceId": workspace_id } }),
                )
                .await?
        }
        ProductCapabilityOpRequest::DeleteAssistant { workspace_id } => {
            dispatcher
                .invoke(
                    "delete_assistant_workspace",
                    json!({ "request": { "workspaceId": workspace_id } }),
                )
                .await?
        }
        ProductCapabilityOpRequest::GetMemoryPaths {} => {
            dispatcher.invoke("get_memory_paths", json!({})).await?
        }
        ProductCapabilityOpRequest::ResetMemory {} => {
            dispatcher.invoke("reset_memory", json!({})).await?
        }

        // ── automation-data-ops ──────────────────────────────────────────
        ProductCapabilityOpRequest::ComputerUseStatus { port } => {
            let computer_use = dispatcher
                .invoke("computer_use_get_status", json!({}))
                .await?;
            let mut port_req = serde_json::Map::new();
            if let Some(p) = port {
                port_req.insert("port".into(), Value::from(p));
            }
            let browser = dispatcher
                .invoke(
                    "browser_control_get_status",
                    json!({ "request": Value::Object(port_req) }),
                )
                .await
                .unwrap_or_else(|e| json!({ "unavailable": e }));
            let browsers = dispatcher
                .invoke("browser_control_list_browsers", json!({}))
                .await
                .unwrap_or(Value::Null);
            json!({
                "computerUse": computer_use,
                "browserControl": browser,
                "browsers": browsers,
            })
        }
        ProductCapabilityOpRequest::RequestOsPermission {
            kind,
            open_settings_pane,
        } => {
            let mut out = serde_json::Map::new();
            if let Some(k) = kind.filter(|v| !v.trim().is_empty()) {
                let receipt = dispatcher
                    .invoke(
                        "computer_use_request_permission",
                        json!({ "request": { "kind": k } }),
                    )
                    .await?;
                out.insert("permissionReceipt".into(), receipt);
            }
            if let Some(pane) = open_settings_pane.filter(|v| !v.trim().is_empty()) {
                dispatcher
                    .invoke(
                        "computer_use_open_system_settings",
                        json!({ "request": { "pane": pane } }),
                    )
                    .await?;
                out.insert("openedSettingsPane".into(), Value::String(pane));
            }
            Value::Object(out)
        }
        ProductCapabilityOpRequest::LaunchBrowser {
            port,
            enable_default_cdp,
        } => {
            let mut req = serde_json::Map::new();
            if let Some(p) = port {
                req.insert("port".into(), Value::from(p));
            }
            let command = if enable_default_cdp {
                "browser_control_enable_default_cdp"
            } else {
                "browser_control_launch"
            };
            dispatcher
                .invoke(command, json!({ "request": Value::Object(req) }))
                .await?
        }
        ProductCapabilityOpRequest::DisconnectBrowser { port } => {
            let mut req = serde_json::Map::new();
            if let Some(p) = port {
                req.insert("port".into(), Value::from(p));
            }
            dispatcher
                .invoke(
                    "browser_control_disconnect",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::ControlSessionStatus {} => {
            dispatcher
                .invoke("computer_use_control_status", json!({ "request": null }))
                .await?
        }
        ProductCapabilityOpRequest::StopControlSession { generation } => {
            dispatcher
                .invoke(
                    "computer_use_control_stop",
                    json!({ "request": { "generation": generation } }),
                )
                .await?
        }
        ProductCapabilityOpRequest::BrowseMiniappMarket {
            query,
            category,
            limit,
            cursor,
        } => {
            let mut req = serde_json::Map::new();
            insert_optional_str(&mut req, "query", query);
            insert_optional_str(&mut req, "category", category);
            if let Some(l) = limit {
                req.insert("limit".into(), Value::from(l));
            }
            insert_optional_str(&mut req, "cursor", cursor);
            dispatcher
                .invoke(
                    "miniapp_market_browse",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::InstallMarketMiniapp {
            slug,
            release_number,
            existing_app_id,
            confirm_permissions,
            confirm_overwrite,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("slug".into(), Value::String(slug));
            req.insert("releaseNumber".into(), Value::from(release_number));
            insert_optional_str(&mut req, "existingAppId", existing_app_id);
            req.insert(
                "confirmPermissions".into(),
                Value::Bool(confirm_permissions),
            );
            req.insert("confirmOverwrite".into(), Value::Bool(confirm_overwrite));
            dispatcher
                .invoke(
                    "miniapp_market_install",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::CallMiniappWorker {
            app_id,
            method,
            params,
        } => {
            dispatcher
                .invoke(
                    "miniapp_worker_call",
                    json!({
                        "request": {
                            "appId": app_id,
                            "method": method,
                            "params": params.unwrap_or_else(|| json!({})),
                        }
                    }),
                )
                .await?
        }
        ProductCapabilityOpRequest::PersonalOverview { time_zone } => {
            let mut req = serde_json::Map::new();
            insert_optional_str(&mut req, "timeZone", time_zone);
            dispatcher
                .invoke(
                    "get_personal_overview",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::SearchSessions {
            query,
            workspace_id,
            workspace_path,
            limit,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("query".into(), Value::String(query));
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            if let Some(l) = limit {
                req.insert("limit".into(), Value::from(l));
            }
            dispatcher
                .invoke(
                    "search_session_content",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::ListInsights { days } => {
            let reports = dispatcher.invoke("get_latest_insights", json!({})).await?;
            let has_data = dispatcher
                .invoke(
                    "has_insights_data",
                    json!({ "request": { "days": days.unwrap_or(30) } }),
                )
                .await
                .unwrap_or(Value::Null);
            json!({ "reports": reports, "hasData": has_data })
        }
        ProductCapabilityOpRequest::LoadInsightsReport { path } => {
            dispatcher
                .invoke(
                    "load_insights_report",
                    json!({ "request": { "path": path } }),
                )
                .await?
        }
        ProductCapabilityOpRequest::GenerateInsights {
            days,
            model_id,
            generation_id,
        } => {
            let mut req = serde_json::Map::new();
            if let Some(d) = days {
                req.insert("days".into(), Value::from(d));
            }
            insert_optional_str(&mut req, "modelId", model_id);
            insert_optional_str(&mut req, "generationId", generation_id);
            dispatcher
                .invoke(
                    "generate_insights",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::CancelInsights { generation_id } => {
            let mut req = serde_json::Map::new();
            insert_optional_str(&mut req, "generationId", generation_id);
            dispatcher
                .invoke(
                    "cancel_insights_generation",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::GetUsageStats { request } => {
            dispatcher
                .invoke(
                    "get_token_usage_statistics",
                    json!({ "request": request.unwrap_or_else(|| json!({})) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::GetActivityHeatmap { request } => {
            dispatcher
                .invoke(
                    "get_token_usage_activity",
                    json!({ "request": request.unwrap_or_else(|| json!({})) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::ListArchivedSessions {
            workspace_id,
            workspace_path,
        } => {
            let scope = build_workspace_scope(workspace_id, workspace_path);
            let sessions = dispatcher
                .invoke("list_archived_sessions", json!({ "request": scope }))
                .await?;
            json!({ "archivedSessions": sessions })
        }
        ProductCapabilityOpRequest::UnarchiveSession {
            session_id,
            workspace_id,
            workspace_path,
        } => {
            let mut req = serde_json::Map::new();
            req.insert("sessionId".into(), Value::String(session_id));
            insert_optional_str(&mut req, "workspaceId", workspace_id);
            insert_optional_str(&mut req, "workspacePath", workspace_path);
            dispatcher
                .invoke(
                    "unarchive_session",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::DeleteAllArchivedSessions {
            workspace_id,
            workspace_path,
        } => {
            let scope = build_workspace_scope(workspace_id, workspace_path);
            dispatcher
                .invoke("delete_all_archived_sessions", json!({ "request": scope }))
                .await?
        }
        ProductCapabilityOpRequest::InspectSnapshotStorage { period } => {
            let mut req = serde_json::Map::new();
            insert_optional_str(&mut req, "period", period);
            dispatcher
                .invoke(
                    "inspect_snapshot_storage",
                    json!({ "request": Value::Object(req) }),
                )
                .await?
        }
        ProductCapabilityOpRequest::CleanSnapshotStorage {
            workspace_id,
            period,
            candidates,
        } => {
            dispatcher
                .invoke(
                    "clean_snapshot_storage",
                    json!({
                        "request": {
                            "workspaceId": workspace_id,
                            "period": period,
                            "candidates": candidates,
                        }
                    }),
                )
                .await?
        }
        ProductCapabilityOpRequest::RuntimeDiagnosticsInfo {} => {
            let logging = dispatcher
                .invoke("get_runtime_logging_info", json!({}))
                .await
                .unwrap_or(Value::Null);
            let system = dispatcher
                .invoke("get_system_info", json!({}))
                .await
                .unwrap_or(Value::Null);
            let version = dispatcher
                .invoke("get_app_version", json!({ "request": {} }))
                .await
                .unwrap_or(Value::Null);
            json!({
                "logging": logging,
                "system": system,
                "version": version,
            })
        }
        ProductCapabilityOpRequest::ExportDiagnosticsBundle {} => {
            dispatcher
                .invoke("export_diagnostics_bundle", json!({ "request": {} }))
                .await?
        }
    };

    Ok(json!({
        "provider": provider_id,
        "operation": operation_id,
        "executed": true,
        "result": result,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::product_capability_ops::{
        AI_POLICY_OPS_PROVIDER, SKILLS_OPS_PROVIDER, WORKSPACE_OPS_PROVIDER,
    };
    use std::sync::Mutex;

    struct RecordingDispatcher {
        calls: Mutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl LocalCommandDispatcher for RecordingDispatcher {
        async fn invoke(&self, command: &str, args: Value) -> Result<Value, String> {
            self.calls.lock().unwrap().push((command.to_string(), args));
            match command {
                "get_config" => Ok(json!({ "primary": "old-p", "fast": "old-f" })),
                _ => Ok(json!({ "ok": command })),
            }
        }
    }

    #[tokio::test]
    async fn executes_workspace_skill_and_ai_policy_ops_with_exact_wire_shapes() {
        let dispatcher = RecordingDispatcher {
            calls: Mutex::new(Vec::new()),
        };

        let open_req = ProductCapabilityOpRequest::from_provider_operation(
            WORKSPACE_OPS_PROVIDER,
            "open-workspace",
            Some(&json!({ "path": "/repo/app" })),
        )
        .unwrap();
        let res = execute_capability_op(&dispatcher, open_req).await.unwrap();
        assert_eq!(res["executed"], true);

        let skill_req = ProductCapabilityOpRequest::from_provider_operation(
            SKILLS_OPS_PROVIDER,
            "set-skill-enabled",
            Some(&json!({ "skillKey": "my-skill", "enabled": false })),
        )
        .unwrap();
        execute_capability_op(&dispatcher, skill_req).await.unwrap();

        let default_models_req = ProductCapabilityOpRequest::from_provider_operation(
            AI_POLICY_OPS_PROVIDER,
            "set-default-models",
            Some(&json!({ "primary": "model-new" })),
        )
        .unwrap();
        execute_capability_op(&dispatcher, default_models_req)
            .await
            .unwrap();

        let calls = dispatcher.calls.lock().unwrap();
        assert_eq!(calls[0].0, "open_workspace");
        assert_eq!(calls[0].1["request"]["path"], "/repo/app");
        assert_eq!(calls[1].0, "set_global_skill_disabled");
        assert_eq!(calls[1].1["request"]["disabled"], true);
        assert_eq!(calls[3].0, "set_config");
        assert_eq!(calls[3].1["path"], "ai.default_models");
        assert_eq!(calls[3].1["value"]["primary"], "model-new");
        assert_eq!(calls[3].1["value"]["fast"], "old-f");
    }
}
