//! ACP client management and ACP flow-session HostInvoke handlers for CLI Peer Host.

use std::path::PathBuf;
use std::sync::Arc;

use openbitfun_acp::client::{
    AcpClientPermissionMode, AcpClientStreamEvent, SetAcpSessionConfigOptionRequest,
    SetAcpSessionModelRequest, SubmitAcpPermissionResponseRequest,
};
use openbitfun_acp::AcpClientService;
use openbitfun_core::agentic::image_analysis::ImageContextData;
use openbitfun_core::service::workspace::WorkspaceInfo;
use openbitfun_core::util::errors::OpenBitFunError;
use openbitfun_runtime_ports::SessionStorePort;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::peer_host::args::request_value;
use crate::peer_host::state::PeerHostState;

async fn acp_service() -> Result<Arc<AcpClientService>, String> {
    if let Some(service) = crate::get_acp_client_service() {
        return Ok(service);
    }
    let config_service = openbitfun_core::service::config::get_global_config_service()
        .await
        .map_err(|error| format!("Failed to get config service: {error}"))?;
    crate::ensure_cli_acp_service(config_service)
        .ok_or_else(|| "ACP client service not initialized".to_string())
}

struct AcpWorkspaceScope {
    workspace_id: String,
    workspace_path: String,
    remote_connection_id: Option<String>,
    remote_ssh_host: Option<String>,
    session_storage_path: PathBuf,
}

impl AcpWorkspaceScope {
    async fn from_workspace(workspace: WorkspaceInfo) -> Result<Self, String> {
        let session_storage_path =
            openbitfun_core::agentic::session::CoreSessionStorePort::default()
                .resolve_workspace_storage(&workspace.id)
                .await
                .map(|resolution| resolution.effective_storage_path)
                .map_err(|error| error.to_string())?;
        let remote_ssh_host = workspace
            .metadata
            .get("sshHost")
            .and_then(|host| host.as_str())
            .map(str::to_string);
        Ok(Self {
            remote_connection_id: workspace.remote_ssh_connection_id().map(str::to_string),
            remote_ssh_host,
            workspace_path: workspace.root_path.to_string_lossy().into_owned(),
            workspace_id: workspace.id,
            session_storage_path,
        })
    }
}

async fn resolve_acp_workspace_scope(
    state: &PeerHostState,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> Result<AcpWorkspaceScope, String> {
    let workspace_id = workspace_id.map(str::trim).filter(|id| !id.is_empty());
    let workspace = match workspace_id {
        Some(id) => state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|error| error.to_string())?,
        None => {
            let path = workspace_path
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .ok_or_else(|| "workspace_id is required for ACP session commands".to_string())?;
            state
                .workspace_service
                .resolve_legacy_workspace_reference(
                    None,
                    path,
                    remote_connection_id,
                    remote_ssh_host,
                )
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Workspace ID is unavailable".to_string())?
        }
    };
    AcpWorkspaceScope::from_workspace(workspace).await
}

async fn resolve_optional_acp_workspace_scope(
    state: &PeerHostState,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> Result<Option<AcpWorkspaceScope>, String> {
    let has_id = workspace_id.map(str::trim).is_some_and(|id| !id.is_empty());
    let has_path = workspace_path
        .map(str::trim)
        .is_some_and(|path| !path.is_empty());
    if !has_id && !has_path {
        return Ok(None);
    }
    resolve_acp_workspace_scope(
        state,
        workspace_id,
        workspace_path,
        remote_connection_id,
        remote_ssh_host,
    )
    .await
    .map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcpClientIdRequest {
    client_id: String,
    #[serde(default)]
    remote_connection_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeAcpClientRequirementsRequest {
    #[serde(default)]
    remote_connection_id: Option<String>,
    #[serde(default)]
    force_refresh: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAcpClientPermissionModeRequest {
    client_id: String,
    permission_mode: AcpClientPermissionMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAcpFlowSessionRequest {
    client_id: String,
    #[serde(default)]
    session_name: Option<String>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    workspace_path: String,
    #[serde(default)]
    remote_connection_id: Option<String>,
    #[serde(default)]
    remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartAcpDialogTurnRequest {
    session_id: String,
    client_id: String,
    user_input: String,
    #[serde(default)]
    original_user_input: Option<String>,
    #[serde(default)]
    image_contexts: Option<Vec<ImageContextData>>,
    #[serde(default)]
    user_message_metadata: Option<Value>,
    turn_id: String,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    workspace_path: Option<String>,
    #[serde(default)]
    remote_connection_id: Option<String>,
    #[serde(default)]
    remote_ssh_host: Option<String>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelAcpDialogTurnRequest {
    session_id: String,
    client_id: String,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    workspace_path: Option<String>,
    #[serde(default)]
    remote_connection_id: Option<String>,
    #[serde(default)]
    remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetAcpSessionOptionsRequest {
    #[serde(default)]
    observe_only: bool,
    session_id: String,
    client_id: String,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    workspace_path: Option<String>,
    #[serde(default)]
    remote_connection_id: Option<String>,
    #[serde(default)]
    remote_ssh_host: Option<String>,
}

#[derive(Clone)]
struct PeerAcpEventEmitter {
    service: Arc<AcpClientService>,
}

impl PeerAcpEventEmitter {
    fn emit(&self, name: &str, mut payload: Value) -> Result<(), OpenBitFunError> {
        self.service
            .record_dialog_event(name, &mut payload)
            .map_err(OpenBitFunError::service)?;
        self.publish(name, payload)
    }

    fn publish(&self, name: &str, payload: Value) -> Result<(), OpenBitFunError> {
        crate::obp_host::publish_event(name, &payload);
        Ok(())
    }
}

fn emit_acp_model_round_completed(
    emitter: &PeerAcpEventEmitter,
    session_id: &str,
    turn_id: &str,
    round_id: String,
    has_tool_calls: bool,
) -> Result<(), OpenBitFunError> {
    emitter.emit(
        "agentic://model-round-completed",
        json!({
            "sessionId": session_id,
            "turnId": turn_id,
            "roundId": round_id,
            "hasToolCalls": has_tool_calls,
        }),
    )
}

fn user_message_metadata_map(metadata: Option<Value>) -> serde_json::Map<String, Value> {
    match metadata {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    }
}

pub(crate) async fn initialize_acp_clients() -> Result<Value, String> {
    let service = acp_service().await?;
    service.initialize_all().await.map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn get_acp_clients() -> Result<Value, String> {
    let service = acp_service().await?;
    let clients = service.list_clients().await.map_err(|e| e.to_string())?;
    serde_json::to_value(clients).map_err(|e| format!("Failed to serialize ACP clients: {e}"))
}

pub(crate) async fn probe_acp_client_requirements(args: &Value) -> Result<Value, String> {
    let service = acp_service().await?;
    let request: ProbeAcpClientRequirementsRequest =
        serde_json::from_value(request_value(args).clone()).unwrap_or_default();
    let probes = service
        .probe_client_requirements(
            request.remote_connection_id.as_deref(),
            request.force_refresh,
        )
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(probes).map_err(|e| format!("Failed to serialize ACP probes: {e}"))
}

pub(crate) async fn predownload_acp_client_adapter(args: &Value) -> Result<Value, String> {
    let service = acp_service().await?;
    let request: AcpClientIdRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|e| format!("Invalid ACP client request: {e}"))?;
    service
        .predownload_client_adapter(&request.client_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn install_acp_client_cli(args: &Value) -> Result<Value, String> {
    let service = acp_service().await?;
    let request: AcpClientIdRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|e| format!("Invalid ACP client request: {e}"))?;
    service
        .install_client_cli(&request.client_id, request.remote_connection_id.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn stop_acp_client(args: &Value) -> Result<Value, String> {
    let service = acp_service().await?;
    let request: AcpClientIdRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|e| format!("Invalid ACP client request: {e}"))?;
    service
        .stop_client(&request.client_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn set_acp_client_permission_mode(args: &Value) -> Result<Value, String> {
    let service = acp_service().await?;
    let request: SetAcpClientPermissionModeRequest =
        serde_json::from_value(request_value(args).clone())
            .map_err(|e| format!("Invalid ACP permission mode request: {e}"))?;
    let clients = service
        .set_client_permission_mode(&request.client_id, request.permission_mode)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(clients).map_err(|e| format!("Failed to serialize ACP clients: {e}"))
}

pub(crate) async fn load_acp_json_config() -> Result<Value, String> {
    let service = acp_service().await?;
    let text = service
        .load_json_config()
        .await
        .map_err(|e| e.to_string())?;
    Ok(Value::String(text))
}

pub(crate) async fn save_acp_json_config(args: &Value) -> Result<Value, String> {
    let service = acp_service().await?;
    let json_config = args
        .get("jsonConfig")
        .or_else(|| args.get("json_config"))
        .or_else(|| request_value(args).get("jsonConfig"))
        .or_else(|| request_value(args).get("json_config"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing 'jsonConfig' field".to_string())?;
    service
        .save_json_config(json_config)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn create_acp_flow_session(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let service = acp_service().await?;
    let request: CreateAcpFlowSessionRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|e| format!("Invalid ACP flow session request: {e}"))?;
    let scope = resolve_acp_workspace_scope(
        state,
        request.workspace_id.as_deref(),
        Some(&request.workspace_path),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let response = service
        .create_flow_session_record(
            &scope.session_storage_path,
            &scope.workspace_id,
            &scope.workspace_path,
            &request.client_id,
            request.session_name,
        )
        .await
        .map_err(|e| e.to_string())?;
    if let Err(error) = service
        .start_client_for_session(
            &request.client_id,
            &response.session_id,
            Some(&scope.workspace_path),
            scope.remote_connection_id.as_deref(),
        )
        .await
    {
        if let Err(cleanup_error) = service
            .delete_flow_session_record(&scope.session_storage_path, &response.session_id)
            .await
        {
            tracing::warn!(
                "Failed to delete ACP session record after client start failure: session_id={}, error={}",
                response.session_id,
                cleanup_error
            );
        }
        return Err(error.to_string());
    }

    crate::obp_host::publish_event(
        "agentic://session-created",
        &json!({
            "sessionId": response.session_id,
            "sessionName": response.session_name,
            "agentType": response.agent_type,
            "workspaceId": scope.workspace_id,
            "workspacePath": scope.workspace_path,
            "remoteConnectionId": scope.remote_connection_id,
            "remoteSshHost": scope.remote_ssh_host,
        }),
    );

    serde_json::to_value(response).map_err(|e| format!("Failed to serialize ACP session: {e}"))
}

pub(crate) async fn start_acp_dialog_turn(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let service = acp_service().await?;
    let request: StartAcpDialogTurnRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|e| format!("Invalid ACP dialog turn request: {e}"))?;

    let session_id = request.session_id.clone();
    let turn_id = request.turn_id.clone();
    let user_input = request.user_input.clone();
    let original_user_input = request
        .original_user_input
        .clone()
        .unwrap_or_else(|| request.user_input.clone());
    let scope = resolve_optional_acp_workspace_scope(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let (workspace_path, remote_connection_id, session_storage_path) = match scope {
        Some(scope) => (
            Some(scope.workspace_path),
            scope.remote_connection_id,
            Some(scope.session_storage_path),
        ),
        None => (None, None, None),
    };

    let mut user_metadata = request.user_message_metadata;
    if let Some(images) = request.image_contexts.filter(|images| !images.is_empty()) {
        let mut fields = user_message_metadata_map(user_metadata);
        fields.entry("images").or_insert_with(|| {
            let images = images.into_iter().map(|image| {
                let name = image
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("name"))
                    .and_then(Value::as_str);
                json!({
                    "id": image.id,
                    "name": name,
                    "mime_type": image.mime_type,
                    "image_path": image.image_path,
                    "data_url": image.data_url,
                })
            });
            Value::Array(images.collect())
        });
        fields
            .entry("original_text")
            .or_insert_with(|| original_user_input.clone().into());
        user_metadata = Some(fields.into());
    }

    let Some(start) = service
        .admit_dialog_turn(
            &session_id,
            &turn_id,
            &request.client_id,
            &user_input,
            &original_user_input,
            user_metadata,
            session_storage_path.as_deref(),
        )
        .await?
    else {
        return Ok(Value::Null);
    };

    let emitter = PeerAcpEventEmitter {
        service: service.clone(),
    };
    emitter
        .publish("agentic://dialog-turn-started", start)
        .map_err(|e| e.to_string())?;

    tokio::spawn(async move {
        let mut current_round_id: Option<String> = None;
        let mut current_round_has_tool_calls = false;
        let mut terminal = None;
        let result = service
            .prompt_agent_stream(
                &request.client_id,
                request.user_input,
                workspace_path,
                remote_connection_id,
                request.session_id.clone(),
                Some(&turn_id),
                session_storage_path.clone(),
                request.timeout_seconds,
                |event| {
                    match event {
                        AcpClientStreamEvent::ModelRoundStarted {
                            round_id,
                            round_index,
                            disable_explore_grouping,
                        } => {
                            if let Some(previous_round_id) = current_round_id.take() {
                                emit_acp_model_round_completed(
                                    &emitter,
                                    &request.session_id,
                                    &request.turn_id,
                                    previous_round_id,
                                    current_round_has_tool_calls,
                                )?;
                            }
                            current_round_id = Some(round_id.clone());
                            current_round_has_tool_calls = false;
                            emitter.emit(
                                "agentic://model-round-started",
                                json!({
                                    "sessionId": request.session_id,
                                    "turnId": request.turn_id,
                                    "roundId": round_id,
                                    "roundIndex": round_index,
                                    "renderHints": {
                                        "disableExploreGrouping": disable_explore_grouping,
                                    },
                                    "subagentParentInfo": null,
                                }),
                            )?;
                        }
                        AcpClientStreamEvent::AgentText(text) => {
                            let round_id = current_round_id.clone().ok_or_else(|| {
                                OpenBitFunError::service(
                                    "ACP text arrived before model round start".to_string(),
                                )
                            })?;
                            emitter.emit(
                                "agentic://text-chunk",
                                json!({
                                    "sessionId": request.session_id,
                                    "turnId": request.turn_id,
                                    "roundId": round_id,
                                    "text": text,
                                    "subagentParentInfo": null,
                                }),
                            )?;
                        }
                        AcpClientStreamEvent::AgentThought(text) => {
                            let round_id = current_round_id.clone().ok_or_else(|| {
                                OpenBitFunError::service(
                                    "ACP thought arrived before model round start".to_string(),
                                )
                            })?;
                            emitter.emit(
                                "agentic://text-chunk",
                                json!({
                                    "sessionId": request.session_id,
                                    "turnId": request.turn_id,
                                    "roundId": round_id,
                                    "text": text,
                                    "contentType": "thinking",
                                    "isThinkingEnd": false,
                                    "subagentParentInfo": null,
                                }),
                            )?;
                        }
                        AcpClientStreamEvent::ToolEvent(tool_event) => {
                            let round_id = current_round_id.clone().ok_or_else(|| {
                                OpenBitFunError::service(
                                    "ACP tool event arrived before model round start".to_string(),
                                )
                            })?;
                            current_round_has_tool_calls = true;
                            emitter.emit(
                                "agentic://tool-event",
                                json!({
                                    "sessionId": request.session_id,
                                    "turnId": request.turn_id,
                                    "roundId": round_id,
                                    "toolEvent": tool_event,
                                    "subagentParentInfo": null,
                                }),
                            )?;
                        }
                        AcpClientStreamEvent::ContextUsageUpdated(usage) => {
                            emitter.emit(
                                "agentic://acp-context-usage-updated",
                                json!({
                                    "sessionId": request.session_id,
                                    "turnId": request.turn_id,
                                    "clientId": request.client_id,
                                    "used": usage.used,
                                    "size": usage.size,
                                    "cost": usage.cost,
                                    "subagentParentInfo": null,
                                }),
                            )?;
                        }
                        AcpClientStreamEvent::AvailableCommandsUpdated(commands) => {
                            emitter.emit(
                                "agentic://acp-available-commands-updated",
                                json!({
                                    "sessionId": request.session_id,
                                    "clientId": request.client_id,
                                    "commands": commands,
                                }),
                            )?;
                        }
                        AcpClientStreamEvent::PlanUpdated(entries) => {
                            emitter.emit(
                                "agentic://acp-plan-updated",
                                json!({
                                    "sessionId": request.session_id,
                                    "turnId": request.turn_id,
                                    "clientId": request.client_id,
                                    "entries": entries,
                                }),
                            )?;
                        }
                        AcpClientStreamEvent::ConfigOptionsUpdated(_) => {
                            emitter.emit(
                                "agentic://acp-session-options-changed",
                                json!({
                                    "sessionId": request.session_id,
                                    "clientId": request.client_id,
                                }),
                            )?;
                        }
                        AcpClientStreamEvent::Completed | AcpClientStreamEvent::Cancelled => {
                            if let Some(round_id) = current_round_id.take() {
                                emit_acp_model_round_completed(
                                    &emitter,
                                    &request.session_id,
                                    &request.turn_id,
                                    round_id,
                                    current_round_has_tool_calls,
                                )?;
                            }
                            let name = if matches!(event, AcpClientStreamEvent::Cancelled) {
                                "agentic://dialog-turn-cancelled"
                            } else {
                                "agentic://dialog-turn-completed"
                            };
                            terminal = Some((
                                name,
                                json!({
                                    "sessionId": request.session_id,
                                    "turnId": request.turn_id,
                                    "subagentParentInfo": null,
                                    "partialRecoveryReason": null,
                                }),
                            ));
                        }
                    }
                    Ok(())
                },
            )
            .await;

        if let Err(error) = result {
            let mut detail = error.error_detail();
            let detail = match &error {
                OpenBitFunError::OutcomeUnknown(_) => {
                    detail.recovery_constraint = Some("acp_stop_unconfirmed".into());
                    detail.retryable = Some(false);
                    detail.action_hints = vec!["copy_diagnostics".into()];
                    Some(detail)
                }
                OpenBitFunError::Session(reason) => {
                    detail.provider = Some(format!("acp:{}", request.client_id));
                    detail.provider_message = Some(reason.clone());
                    Some(detail)
                }
                OpenBitFunError::AIProvider(_) => Some(detail),
                _ => None,
            };
            terminal = Some((
                "agentic://dialog-turn-failed",
                json!({
                    "sessionId": request.session_id,
                    "turnId": request.turn_id,
                    "error": error.to_string(),
                    "errorCategory": detail.as_ref().map(|detail| &detail.category),
                    "errorDetail": detail,
                    "subagentParentInfo": null,
                }),
            ));
        }

        if let Some((name, mut payload)) = terminal {
            match service
                .finish_dialog_turn(
                    &session_id,
                    session_storage_path.as_deref(),
                    name,
                    &mut payload,
                )
                .await
            {
                Ok(()) => {
                    let _ = emitter.publish(name, payload);
                }
                Err(error) => {
                    tracing::error!("Failed to commit ACP turn {turn_id}: {error}");
                    if service.execution_snapshot(&session_id).is_none() {
                        let _ = emitter.publish(name, payload);
                    }
                }
            }
        }
    });

    Ok(Value::Null)
}

pub(crate) async fn cancel_acp_dialog_turn(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let service = acp_service().await?;
    let request: CancelAcpDialogTurnRequest =
        serde_json::from_value(request_value(args).clone())
            .map_err(|e| format!("Invalid ACP cancel request: {e}"))?;
    let scope = resolve_optional_acp_workspace_scope(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    service
        .cancel_agent_session(
            &request.client_id,
            scope.map(|scope| scope.workspace_path),
            request.session_id,
            request.turn_id.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn get_acp_session_options(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let service = acp_service().await?;
    let request: GetAcpSessionOptionsRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|e| format!("Invalid ACP session options request: {e}"))?;
    let scope = resolve_optional_acp_workspace_scope(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let (workspace_path, remote_connection_id, session_storage_path) = match scope {
        Some(scope) => (
            Some(scope.workspace_path),
            scope.remote_connection_id,
            Some(scope.session_storage_path),
        ),
        None => (None, None, None),
    };
    let options = if request.observe_only {
        service
            .observe_session_options(
                &request.client_id,
                &request.session_id,
                workspace_path.as_deref(),
                session_storage_path.as_deref(),
            )
            .await
            .map_err(|e| e.to_string())?
    } else {
        service
            .get_session_options(
                &request.client_id,
                workspace_path,
                remote_connection_id,
                session_storage_path,
                request.session_id,
            )
            .await
            .map_err(|e| e.to_string())?
    };
    serde_json::to_value(options).map_err(|e| format!("Failed to serialize ACP options: {e}"))
}

pub(crate) async fn get_acp_session_commands(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let service = acp_service().await?;
    let request: GetAcpSessionOptionsRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|e| format!("Invalid ACP session commands request: {e}"))?;
    let scope = resolve_optional_acp_workspace_scope(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let (workspace_path, remote_connection_id, session_storage_path) = match scope {
        Some(scope) => (
            Some(scope.workspace_path),
            scope.remote_connection_id,
            Some(scope.session_storage_path),
        ),
        None => (None, None, None),
    };
    let commands = if request.observe_only {
        service
            .observe_session_options(
                &request.client_id,
                &request.session_id,
                workspace_path.as_deref(),
                session_storage_path.as_deref(),
            )
            .await
            .map(|options| options.available_commands.unwrap_or_default())
            .map_err(|e| e.to_string())?
    } else {
        service
            .get_session_commands(
                &request.client_id,
                workspace_path,
                remote_connection_id,
                session_storage_path,
                request.session_id,
            )
            .await
            .map_err(|e| e.to_string())?
    };
    serde_json::to_value(commands).map_err(|e| format!("Failed to serialize ACP commands: {e}"))
}

pub(crate) async fn set_acp_session_model(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let service = acp_service().await?;
    let mut request: SetAcpSessionModelRequest =
        serde_json::from_value(request_value(args).clone())
            .map_err(|e| format!("Invalid ACP session model request: {e}"))?;
    let scope = resolve_optional_acp_workspace_scope(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let session_storage_path = scope.map(|scope| {
        request.workspace_path = Some(scope.workspace_path);
        request.remote_connection_id = scope.remote_connection_id;
        scope.session_storage_path
    });
    let options = service
        .set_session_model(request, session_storage_path)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(options).map_err(|e| format!("Failed to serialize ACP options: {e}"))
}

pub(crate) async fn set_acp_session_config_option(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let service = acp_service().await?;
    let mut request: SetAcpSessionConfigOptionRequest =
        serde_json::from_value(request_value(args).clone())
            .map_err(|e| format!("Invalid ACP config option request: {e}"))?;
    let scope = resolve_optional_acp_workspace_scope(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let session_storage_path = scope.map(|scope| {
        request.workspace_path = Some(scope.workspace_path);
        request.remote_connection_id = scope.remote_connection_id;
        scope.session_storage_path
    });
    let options = service
        .set_session_config_option(request, session_storage_path)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(options).map_err(|e| format!("Failed to serialize ACP options: {e}"))
}

pub(crate) async fn submit_acp_permission_response(args: &Value) -> Result<Value, String> {
    let service = acp_service().await?;
    let request: SubmitAcpPermissionResponseRequest =
        serde_json::from_value(request_value(args).clone())
            .map_err(|e| format!("Invalid ACP permission response request: {e}"))?;
    let response = service
        .submit_permission_response(request)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(response)
        .map_err(|e| format!("Failed to serialize ACP permission response: {e}"))
}
