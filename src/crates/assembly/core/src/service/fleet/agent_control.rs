//! Agent-facing Fleet controller shared by every product host (Desktop & CLI).
//!
//! Treats THIS executing device (`"self"` / `"local"` / omitted target) and
//! every same-account peer device on OpenBitFun Link symmetrically: one single
//! control plane for inspecting devices, workspaces, models, sessions, and
//! prompts; creating and driving sessions; answering prompts; and pulling
//! workspace files back to this machine.

use std::io::Write as _;
use std::path::Path;

use anyhow::{anyhow, bail, Context};
use async_trait::async_trait;
use base64::Engine as _;
use openbitfun_product_domains::fleet::{
    FleetAnswerRoute, FleetAttentionMarkReadResponse, FleetAttentionView, FleetDevice,
    FleetDeviceDetail, FleetDeviceState, FleetModels, FleetNavigator, FleetPromptsResponse,
    FleetRecentSessions, FleetRecentSessionsRequest, FleetRouteKind,
};
use openbitfun_product_domains::fleet_control::{
    FleetControlRequest, FleetCronAction, FleetPromptRoute, DEFAULT_FLEET_PULL_FILE_MAX_BYTES,
    HARD_MAX_FLEET_PULL_FILE_BYTES,
};
use openbitfun_product_domains::product_control::{
    ProductControlAction, ProductControlRequest, ProductControlSource,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Host adapter supplied by Desktop or CLI to the shared Fleet control executor.
#[async_trait]
pub trait FleetControlHost: Send + Sync {
    /// Device ID of THIS local host, when known.
    fn local_device_id(&self) -> Option<String>;

    /// Full fleet navigator snapshot (always includes this device, plus peers when Link is running).
    async fn navigator(&self) -> anyhow::Result<FleetNavigator>;

    /// Detailed runtime view for one device (this device or a peer).
    async fn device_detail(&self, device_id: &str) -> anyhow::Result<FleetDeviceDetail>;

    /// Account-wide model catalog grouped relative to `device_id` (or this host when `None`).
    async fn models(&self, device_id: Option<&str>) -> anyhow::Result<FleetModels>;

    /// Pending permission prompts and user questions across all known devices.
    async fn prompts(&self) -> anyhow::Result<FleetPromptsResponse>;

    /// Cross-device Fleet Inbox view (prompts + unread Done/Failed notifications).
    async fn attention(&self) -> anyhow::Result<FleetAttentionView> {
        bail!("fleet_attention is unavailable on this host")
    }

    /// Mark Fleet Inbox items read up to `revision`.
    async fn mark_attention_read(
        &self,
        _revision: u64,
    ) -> anyhow::Result<FleetAttentionMarkReadResponse> {
        bail!("fleet_attention_mark_read is unavailable on this host")
    }

    /// Recent sessions across every device of the account.
    async fn recent_sessions(
        &self,
        _request: FleetRecentSessionsRequest,
    ) -> anyhow::Result<FleetRecentSessions> {
        bail!("fleet_recent_sessions is unavailable on this host")
    }

    /// Forward one `Proxied` product command to `target_device_id` (local or peer).
    async fn fleet_call(
        &self,
        target_device_id: &str,
        command: &str,
        args: Value,
    ) -> anyhow::Result<Value>;

    /// Answer a Detached Dispatch prompt (`dispatch_target_answer`) on `target_device_id` (local or peer).
    async fn dispatch_answer(
        &self,
        target_device_id: &str,
        payload: Value,
    ) -> anyhow::Result<Value>;
}

#[derive(Debug, Clone)]
struct ResolvedDevice {
    device_id: String,
    name: String,
    is_current_device: bool,
}

fn is_local_device(device: &FleetDevice, local_device_id: Option<&str>) -> bool {
    if local_device_id.is_some_and(|id| !id.is_empty() && id == device.device_id) {
        return true;
    }
    device.is_client_device
        || device
            .route
            .as_ref()
            .is_some_and(|route| route.kind == FleetRouteKind::Local)
}

fn resolve_target_device(
    navigator: &FleetNavigator,
    local_device_id: Option<&str>,
    selector: Option<&str>,
    require_online: bool,
) -> anyhow::Result<ResolvedDevice> {
    let trimmed = selector.map(str::trim).filter(|value| !value.is_empty());
    let wants_self = trimmed.is_none()
        || trimmed.is_some_and(|value| {
            value.eq_ignore_ascii_case("self") || value.eq_ignore_ascii_case("local")
        });

    if wants_self {
        if let Some(device) = navigator
            .devices
            .iter()
            .find(|device| is_local_device(device, local_device_id))
        {
            return Ok(ResolvedDevice {
                device_id: device.device_id.clone(),
                name: device.name.clone(),
                is_current_device: true,
            });
        }
        if let Some(id) = local_device_id.filter(|id| !id.is_empty()) {
            return Ok(ResolvedDevice {
                device_id: id.to_string(),
                name: id.to_string(),
                is_current_device: true,
            });
        }
        bail!("Local device is not present in the fleet index yet");
    }

    let raw = trimmed.unwrap();
    let matches: Vec<&FleetDevice> = match raw.strip_prefix("device:") {
        Some(device_id) => navigator
            .devices
            .iter()
            .filter(|device| device.device_id == device_id.trim())
            .collect(),
        None => {
            let by_id: Vec<&FleetDevice> = navigator
                .devices
                .iter()
                .filter(|device| device.device_id == raw)
                .collect();
            if by_id.is_empty() {
                navigator
                    .devices
                    .iter()
                    .filter(|device| device.name.eq_ignore_ascii_case(raw))
                    .collect()
            } else {
                by_id
            }
        }
    };

    match matches.as_slice() {
        [device] => {
            let current = is_local_device(device, local_device_id);
            if require_online && !current && device.state != FleetDeviceState::Online {
                bail!(
                    "Fleet device '{}' ({}) is {:?}; no local fallback was attempted",
                    device.name,
                    device.device_id,
                    device.state
                );
            }
            Ok(ResolvedDevice {
                device_id: device.device_id.clone(),
                name: device.name.clone(),
                is_current_device: current,
            })
        }
        [] => bail!(
            "No device in the fleet matches '{raw}'; call feature.fleet:navigator first and pass 'self', device:<deviceId>, or an exact device name"
        ),
        _ => bail!("Several fleet devices match '{raw}'; pass device:<deviceId>"),
    }
}

fn find_workspace_path_in_navigator(
    navigator: &FleetNavigator,
    device_id: &str,
    workspace_id: &str,
) -> Option<String> {
    navigator
        .devices
        .iter()
        .find(|device| device.device_id == device_id)
        .and_then(|device| {
            device
                .workspaces
                .iter()
                .find(|ws| ws.workspace_id == workspace_id)
                .map(|ws| ws.root_path.clone())
        })
        .filter(|path| !path.trim().is_empty())
}

fn find_workspace_id_by_path_in_navigator(
    navigator: &FleetNavigator,
    device_id: &str,
    workspace_path: &str,
) -> Option<String> {
    let needle = workspace_path.trim().trim_end_matches(['/', '\\']);
    navigator
        .devices
        .iter()
        .find(|device| device.device_id == device_id)
        .and_then(|device| {
            device
                .workspaces
                .iter()
                .find(|ws| ws.root_path.trim().trim_end_matches(['/', '\\']) == needle)
                .map(|ws| ws.workspace_id.clone())
        })
}

fn find_session_context_in_navigator(
    navigator: &FleetNavigator,
    device_id: &str,
    session_id: &str,
) -> Option<(String, Option<String>, Option<String>)> {
    let device = navigator
        .devices
        .iter()
        .find(|device| device.device_id == device_id)?;
    for workspace in &device.workspaces {
        if let Some(session) = workspace
            .sessions
            .iter()
            .find(|session| session.session_id == session_id)
        {
            let agent = (!session.agent_type.trim().is_empty()).then(|| session.agent_type.clone());
            return Some((
                workspace.workspace_id.clone(),
                (!workspace.root_path.trim().is_empty()).then(|| workspace.root_path.clone()),
                agent,
            ));
        }
    }
    None
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let prefix: String = text.chars().take(max_chars).collect();
    format!("{prefix}…[truncated]")
}

fn summarize_turn(turn: &Value) -> Value {
    let turn_id = turn
        .get("turnId")
        .or_else(|| turn.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let status = turn
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let user_text = turn
        .pointer("/userMessage/content")
        .or_else(|| turn.get("userInput"))
        .and_then(Value::as_str)
        .map(|text| truncate_text(text, 1000))
        .unwrap_or_default();

    let mut assistant_chunks = Vec::new();
    let mut tool_calls = Vec::new();
    if let Some(rounds) = turn.get("modelRounds").and_then(Value::as_array) {
        for round in rounds {
            if let Some(items) = round.get("items").and_then(Value::as_array) {
                for item in items {
                    let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
                    if kind == "text" {
                        if let Some(content) = item.get("content").and_then(Value::as_str) {
                            if !content.trim().is_empty() {
                                assistant_chunks.push(content.to_string());
                            }
                        }
                    } else if kind == "tool" {
                        tool_calls.push(json!({
                            "toolName": item.get("toolName").cloned().unwrap_or(Value::Null),
                            "status": item.get("status").cloned().unwrap_or(Value::Null),
                        }));
                    }
                }
            }
        }
    }
    let assistant_text = truncate_text(&assistant_chunks.join("\n"), 4000);
    json!({
        "turnId": turn_id,
        "status": status,
        "userMessage": user_text,
        "assistantText": assistant_text,
        "toolCalls": tool_calls,
    })
}

fn project_device_for_agent(device: &FleetDevice, local_device_id: Option<&str>) -> Value {
    let mut value = serde_json::to_value(device).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "isCurrentDevice".to_string(),
            Value::Bool(is_local_device(device, local_device_id)),
        );
    }
    value
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

/// Execute one Agent-facing Fleet control request on this host.
pub async fn execute_fleet_control(
    host: &dyn FleetControlHost,
    request: FleetControlRequest,
) -> anyhow::Result<Value> {
    let local_device_id = host.local_device_id();
    match request {
        FleetControlRequest::Navigator { target } => {
            let nav = host.navigator().await?;
            let filter_all = target
                .as_deref()
                .map(str::trim)
                .is_none_or(|value| value.is_empty() || value.eq_ignore_ascii_case("all"));
            let devices: Vec<Value> = if filter_all {
                nav.devices
                    .iter()
                    .map(|device| project_device_for_agent(device, local_device_id.as_deref()))
                    .collect()
            } else {
                let resolved = resolve_target_device(
                    &nav,
                    local_device_id.as_deref(),
                    target.as_deref(),
                    false,
                )?;
                nav.devices
                    .iter()
                    .filter(|device| device.device_id == resolved.device_id)
                    .map(|device| project_device_for_agent(device, local_device_id.as_deref()))
                    .collect()
            };
            Ok(json!({
                "localDeviceId": local_device_id,
                "revision": nav.revision,
                "totals": nav.totals,
                "devices": devices,
            }))
        }
        FleetControlRequest::DeviceDetail { target } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), false)?;
            let detail = host.device_detail(&resolved.device_id).await?;
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "detail": detail,
            }))
        }
        FleetControlRequest::ListModels { target } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), false)?;
            let models = host.models(Some(&resolved.device_id)).await?;
            Ok(json!({
                "perspectiveDeviceId": resolved.device_id,
                "perspectiveIsCurrentDevice": resolved.is_current_device,
                "models": models,
            }))
        }
        FleetControlRequest::ListWorkspaces { target } => {
            let nav = host.navigator().await?;
            let all = target
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| value.eq_ignore_ascii_case("all"));
            let selected_ids: Option<String> = if all {
                None
            } else {
                let resolved = resolve_target_device(
                    &nav,
                    local_device_id.as_deref(),
                    target.as_deref(),
                    false,
                )?;
                Some(resolved.device_id)
            };
            let mut workspaces = Vec::new();
            for device in &nav.devices {
                if let Some(ref id) = selected_ids {
                    if &device.device_id != id {
                        continue;
                    }
                }
                let current = is_local_device(device, local_device_id.as_deref());
                for ws in &device.workspaces {
                    workspaces.push(json!({
                        "deviceId": device.device_id,
                        "deviceName": device.name,
                        "deviceState": device.state,
                        "isCurrentDevice": current,
                        "workspaceId": ws.workspace_id,
                        "name": ws.name,
                        "rootPath": ws.root_path,
                        "kind": ws.kind,
                        "isHostCurrent": ws.is_host_current,
                        "sshHost": ws.ssh_host,
                        "connectionName": ws.connection_name,
                        "sessionCount": ws.sessions.len(),
                        "sessionTotal": ws.session_total,
                    }));
                }
            }
            Ok(json!({
                "scope": if all { "all" } else { "device" },
                "workspaces": workspaces,
            }))
        }
        FleetControlRequest::ListSessions {
            target,
            workspace_id,
            workspace_path,
            limit,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let resolved_ws_id = workspace_id
                .clone()
                .filter(|v| !v.trim().is_empty())
                .or_else(|| {
                    workspace_path.as_deref().and_then(|path| {
                        find_workspace_id_by_path_in_navigator(&nav, &resolved.device_id, path)
                    })
                });
            let resolved_ws_path = workspace_path
                .clone()
                .filter(|v| !v.trim().is_empty())
                .or_else(|| {
                    resolved_ws_id.as_deref().and_then(|id| {
                        find_workspace_path_in_navigator(&nav, &resolved.device_id, id)
                    })
                });
            let mut req = json!({
                "limit": limit.unwrap_or(30),
            });
            if let Some(id) = &resolved_ws_id {
                req["workspaceId"] = Value::String(id.clone());
            }
            if let Some(path) = &resolved_ws_path {
                req["workspacePath"] = Value::String(path.clone());
            }
            let page = host
                .fleet_call(
                    &resolved.device_id,
                    "list_persisted_sessions_page",
                    json!({ "request": req }),
                )
                .await?;
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "workspaceId": resolved_ws_id,
                "workspacePath": resolved_ws_path,
                "page": page,
            }))
        }
        FleetControlRequest::CreateSession {
            target,
            workspace_id,
            workspace_path,
            session_name,
            agent_type,
            model_name,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let resolved_ws_id = workspace_id
                .clone()
                .filter(|v| !v.trim().is_empty())
                .or_else(|| {
                    workspace_path.as_deref().and_then(|path| {
                        find_workspace_id_by_path_in_navigator(&nav, &resolved.device_id, path)
                    })
                });
            let resolved_ws_path = workspace_path
                .clone()
                .filter(|v| !v.trim().is_empty())
                .or_else(|| {
                    resolved_ws_id.as_deref().and_then(|id| {
                        find_workspace_path_in_navigator(&nav, &resolved.device_id, id)
                    })
                })
                .unwrap_or_default();
            let canonical_agent = openbitfun_core_types::agent_identity::canonical_agent_id(
                agent_type.as_deref().unwrap_or("Standard"),
            )
            .to_string();
            let mut req = json!({
                "sessionName": session_name,
                "agentType": canonical_agent,
                "workspacePath": resolved_ws_path,
            });
            if let Some(id) = &resolved_ws_id {
                req["workspaceId"] = Value::String(id.clone());
            }
            if let Some(model) = model_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                req["config"] = json!({ "modelName": model });
            }
            let created = host
                .fleet_call(
                    &resolved.device_id,
                    "create_session",
                    json!({ "request": req }),
                )
                .await?;
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "session": created,
            }))
        }
        FleetControlRequest::SendMessage {
            target,
            session_id,
            message,
            workspace_id,
            workspace_path,
            agent_type,
            model_id,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let nav_ctx = find_session_context_in_navigator(&nav, &resolved.device_id, &session_id);
            let resolved_ws_id = workspace_id
                .filter(|v| !v.trim().is_empty())
                .or_else(|| nav_ctx.as_ref().map(|(id, _, _)| id.clone()));
            let resolved_ws_path = workspace_path
                .filter(|v| !v.trim().is_empty())
                .or_else(|| nav_ctx.as_ref().and_then(|(_, path, _)| path.clone()))
                .or_else(|| {
                    resolved_ws_id.as_deref().and_then(|id| {
                        find_workspace_path_in_navigator(&nav, &resolved.device_id, id)
                    })
                });
            let resolved_agent = agent_type
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|agent| {
                    openbitfun_core_types::agent_identity::canonical_agent_id(agent).to_string()
                })
                .or_else(|| nav_ctx.as_ref().and_then(|(_, _, agent)| agent.clone()))
                .unwrap_or_else(|| "Standard".to_string());
            let turn_id = uuid::Uuid::new_v4().to_string();
            let mut req = json!({
                "sessionId": session_id,
                "userInput": message,
                "agentType": resolved_agent,
                "turnId": turn_id,
            });
            if let Some(id) = &resolved_ws_id {
                req["workspaceId"] = Value::String(id.clone());
            }
            if let Some(path) = &resolved_ws_path {
                req["workspacePath"] = Value::String(path.clone());
            }
            if let Some(model) = model_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                req["execution"] = json!({ "modelId": model });
            }
            let response = host
                .fleet_call(
                    &resolved.device_id,
                    "start_dialog_turn",
                    json!({ "request": req }),
                )
                .await?;
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "sessionId": session_id,
                "turnId": turn_id,
                "agentType": resolved_agent,
                "response": response,
                "nextStep": "Call feature.fleet:read-session to inspect progress and results, or feature.fleet:list-prompts if the session pauses for approval or a question.",
            }))
        }
        FleetControlRequest::ReadSession {
            target,
            session_id,
            workspace_id,
            workspace_path,
            tail_turn_count,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let nav_ctx = find_session_context_in_navigator(&nav, &resolved.device_id, &session_id);
            let resolved_ws_id = workspace_id
                .filter(|v| !v.trim().is_empty())
                .or_else(|| nav_ctx.as_ref().map(|(id, _, _)| id.clone()));
            let resolved_ws_path = workspace_path
                .filter(|v| !v.trim().is_empty())
                .or_else(|| nav_ctx.as_ref().and_then(|(_, path, _)| path.clone()))
                .or_else(|| {
                    resolved_ws_id.as_deref().and_then(|id| {
                        find_workspace_path_in_navigator(&nav, &resolved.device_id, id)
                    })
                });
            let mut req = json!({
                "sessionId": session_id,
                "tailTurnCount": tail_turn_count.unwrap_or(4),
            });
            if let Some(id) = &resolved_ws_id {
                req["workspaceId"] = Value::String(id.clone());
            }
            if let Some(path) = &resolved_ws_path {
                req["workspacePath"] = Value::String(path.clone());
            }
            let raw = host
                .fleet_call(
                    &resolved.device_id,
                    "restore_session_view",
                    json!({ "request": req }),
                )
                .await?;
            let turns: Vec<Value> = raw
                .get("turns")
                .and_then(Value::as_array)
                .map(|turns| turns.iter().map(summarize_turn).collect())
                .unwrap_or_default();
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "session": raw.get("session").cloned().unwrap_or(Value::Null),
                "totalTurnCount": raw.get("totalTurnCount").cloned().unwrap_or(Value::Null),
                "loadedTurnCount": turns.len(),
                "turns": turns,
                "interactionSnapshot": raw.get("interactionSnapshot").cloned().unwrap_or(Value::Null),
            }))
        }
        FleetControlRequest::CancelSession { target, session_id } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let response = host
                .fleet_call(
                    &resolved.device_id,
                    "cancel_session",
                    json!({ "request": { "sessionId": session_id } }),
                )
                .await?;
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "sessionId": session_id,
                "response": response,
            }))
        }
        FleetControlRequest::ListPrompts { target } => {
            let nav = host.navigator().await?;
            let filter_all = target
                .as_deref()
                .map(str::trim)
                .is_none_or(|value| value.is_empty() || value.eq_ignore_ascii_case("all"));
            let filter_device_id = if filter_all {
                None
            } else {
                Some(
                    resolve_target_device(
                        &nav,
                        local_device_id.as_deref(),
                        target.as_deref(),
                        false,
                    )?
                    .device_id,
                )
            };
            let response = host.prompts().await?;
            let prompts: Vec<Value> = response
                .prompts
                .into_iter()
                .filter(|prompt| {
                    filter_device_id
                        .as_deref()
                        .is_none_or(|id| prompt.device_id == id)
                })
                .map(|prompt| {
                    let device_name = nav
                        .devices
                        .iter()
                        .find(|d| d.device_id == prompt.device_id)
                        .map(|d| d.name.clone())
                        .unwrap_or_else(|| prompt.device_id.clone());
                    let current = local_device_id
                        .as_deref()
                        .is_some_and(|id| id == prompt.device_id);
                    let mut val = serde_json::to_value(prompt).unwrap_or(Value::Null);
                    if let Some(obj) = val.as_object_mut() {
                        obj.insert("deviceName".to_string(), Value::String(device_name));
                        obj.insert("isCurrentDevice".to_string(), Value::Bool(current));
                    }
                    val
                })
                .collect();
            Ok(json!({
                "revision": response.revision,
                "count": prompts.len(),
                "prompts": prompts,
            }))
        }
        FleetControlRequest::AnswerPrompt {
            target,
            request_id,
            route,
            session_id,
            job_id,
            reply,
            feedback,
            answers,
        } => {
            let nav = host.navigator().await?;
            let prompts = host.prompts().await.ok();
            let matched_prompt = prompts.as_ref().and_then(|resp| {
                resp.prompts
                    .iter()
                    .find(|prompt| prompt.prompt_id == request_id)
            });

            let effective_target_selector = target
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .or_else(|| matched_prompt.map(|p| format!("device:{}", p.device_id)));
            let resolved = resolve_target_device(
                &nav,
                local_device_id.as_deref(),
                effective_target_selector.as_deref(),
                true,
            )?;

            let effective_route = match route {
                FleetPromptRoute::Dispatch => FleetPromptRoute::Dispatch,
                FleetPromptRoute::Session => FleetPromptRoute::Session,
                FleetPromptRoute::Auto => {
                    if job_id.as_deref().is_some_and(|v| !v.trim().is_empty())
                        || matched_prompt
                            .is_some_and(|p| p.answer_route == FleetAnswerRoute::Dispatch)
                    {
                        FleetPromptRoute::Dispatch
                    } else {
                        FleetPromptRoute::Session
                    }
                }
            };

            match effective_route {
                FleetPromptRoute::Dispatch => {
                    let effective_job_id = job_id
                        .filter(|v| !v.trim().is_empty())
                        .or_else(|| matched_prompt.and_then(|p| p.job_id.clone()))
                        .ok_or_else(|| {
                            anyhow!("Answering a dispatch prompt requires jobId (or an active prompt in list-prompts)")
                        })?;
                    let payload = if let Some(answers) = answers {
                        json!({
                            "jobId": effective_job_id,
                            "requestId": request_id,
                            "answers": answers,
                        })
                    } else {
                        let reply = reply.ok_or_else(|| anyhow!("reply is required"))?;
                        let mut p = json!({
                            "jobId": effective_job_id,
                            "requestId": request_id,
                            "reply": reply.wire(),
                        });
                        if let Some(fb) = feedback {
                            p["feedback"] = Value::String(fb);
                        }
                        p
                    };
                    let result = host.dispatch_answer(&resolved.device_id, payload).await?;
                    Ok(json!({
                        "deviceId": resolved.device_id,
                        "isCurrentDevice": resolved.is_current_device,
                        "route": "dispatch",
                        "jobId": effective_job_id,
                        "requestId": request_id,
                        "result": result,
                    }))
                }
                FleetPromptRoute::Session | FleetPromptRoute::Auto => {
                    if let Some(answers) = answers {
                        let effective_session_id = session_id
                            .filter(|v| !v.trim().is_empty())
                            .or_else(|| matched_prompt.map(|p| p.session_id.clone()));
                        let mut payload = json!({
                            "toolId": request_id,
                            "answers": answers,
                        });
                        if let Some(sid) = effective_session_id {
                            payload["sessionId"] = Value::String(sid);
                        }
                        let result = host
                            .fleet_call(&resolved.device_id, "submit_user_answers", payload)
                            .await?;
                        Ok(json!({
                            "deviceId": resolved.device_id,
                            "isCurrentDevice": resolved.is_current_device,
                            "route": "session",
                            "kind": "question",
                            "requestId": request_id,
                            "result": result,
                        }))
                    } else {
                        let reply = reply.ok_or_else(|| anyhow!("reply is required"))?;
                        let mut req = json!({
                            "requestId": request_id,
                            "reply": reply.wire(),
                        });
                        if let Some(fb) = feedback {
                            req["feedback"] = Value::String(fb);
                        }
                        let result = host
                            .fleet_call(
                                &resolved.device_id,
                                "respond_permission",
                                json!({ "request": req }),
                            )
                            .await?;
                        Ok(json!({
                            "deviceId": resolved.device_id,
                            "isCurrentDevice": resolved.is_current_device,
                            "route": "session",
                            "kind": "permission",
                            "requestId": request_id,
                            "result": result,
                        }))
                    }
                }
            }
        }
        FleetControlRequest::PullFile {
            target,
            remote_path,
            local_path,
            workspace_id,
            overwrite,
            max_bytes,
        } => {
            let dest = Path::new(local_path.trim());
            if !dest.is_absolute() {
                bail!("localPath must be an absolute file path on this host");
            }
            if dest.is_dir() {
                bail!(
                    "localPath ({}) is an existing directory; pass a destination file path",
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
                .unwrap_or(DEFAULT_FLEET_PULL_FILE_MAX_BYTES)
                .min(HARD_MAX_FLEET_PULL_FILE_BYTES);

            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let mut req = json!({
                "filePath": remote_path,
                "encoding": "base64",
            });
            if let Some(ws_id) = workspace_id.filter(|v| !v.trim().is_empty()) {
                req["workspaceId"] = Value::String(ws_id);
            }
            let encoded = host
                .fleet_call(
                    &resolved.device_id,
                    "read_file_content",
                    json!({ "request": req }),
                )
                .await?;
            let encoded_str = encoded.as_str().ok_or_else(|| {
                anyhow!("Source device returned an unexpected payload for base64 read_file_content")
            })?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded_str)
                .context("decode base64 payload from source device")?;
            if bytes.len() as u64 > max_bytes {
                bail!(
                    "Pulled file ({} bytes) exceeds maxBytes ({max_bytes} bytes); for very large build artifacts use detached-dispatch:fetch-file",
                    bytes.len()
                );
            }
            let parent = dest
                .parent()
                .ok_or_else(|| anyhow!("localPath has no parent directory"))?;
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create destination directory {}", parent.display()))?;
            let file_name = dest
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("pulled-file");
            let temp_path = parent.join(format!(".{file_name}.{}.part", uuid::Uuid::new_v4()));
            let mut temp_guard = TempFileGuard::new(temp_path.clone());
            let mut output = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp_path)
                .with_context(|| format!("create staging file {}", temp_path.display()))?;
            output.write_all(&bytes)?;
            output.sync_all()?;
            drop(output);
            #[cfg(windows)]
            if dest.exists() && overwrite {
                std::fs::remove_file(dest)?;
            }
            std::fs::rename(&temp_path, dest)?;
            temp_guard.commit();

            let sha256 = format!("{:x}", Sha256::digest(&bytes));
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "remotePath": remote_path,
                "localPath": dest.to_string_lossy(),
                "size": bytes.len() as u64,
                "sha256": sha256,
            }))
        }
        FleetControlRequest::Attention {} => {
            let view = host.attention().await?;
            Ok(serde_json::to_value(view)?)
        }
        FleetControlRequest::MarkAttentionRead { revision } => {
            let response = host.mark_attention_read(revision).await?;
            Ok(serde_json::to_value(response)?)
        }
        FleetControlRequest::RecentSessions { limit, cursor } => {
            let response = host
                .recent_sessions(FleetRecentSessionsRequest {
                    limit: limit.map(|v| v as u32),
                    cursor,
                })
                .await?;
            Ok(serde_json::to_value(response)?)
        }
        FleetControlRequest::SearchSessions {
            target,
            query,
            workspace_id,
            workspace_path,
            limit,
        } => {
            let nav = host.navigator().await?;
            let build_args = || {
                let mut req = json!({ "query": query });
                if let Some(ws_id) = workspace_id.as_deref().filter(|v| !v.trim().is_empty()) {
                    req["workspaceId"] = Value::String(ws_id.to_string());
                }
                if let Some(ws_path) = workspace_path.as_deref().filter(|v| !v.trim().is_empty()) {
                    req["workspacePath"] = Value::String(ws_path.to_string());
                }
                if let Some(l) = limit {
                    req["limit"] = Value::from(l);
                }
                json!({ "request": req })
            };
            let wants_all = target
                .as_deref()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("all"));
            if wants_all {
                let mut per_device = Vec::new();
                for device in &nav.devices {
                    let current = is_local_device(device, local_device_id.as_deref());
                    if !current && device.state != FleetDeviceState::Online {
                        per_device.push(json!({
                            "deviceId": device.device_id,
                            "deviceName": device.name,
                            "isCurrentDevice": false,
                            "state": device.state,
                            "skipped": "device is offline",
                        }));
                        continue;
                    }
                    match host
                        .fleet_call(&device.device_id, "search_session_content", build_args())
                        .await
                    {
                        Ok(results) => per_device.push(json!({
                            "deviceId": device.device_id,
                            "deviceName": device.name,
                            "isCurrentDevice": current,
                            "results": results,
                        })),
                        Err(error) => per_device.push(json!({
                            "deviceId": device.device_id,
                            "deviceName": device.name,
                            "isCurrentDevice": current,
                            "error": error.to_string(),
                        })),
                    }
                }
                return Ok(json!({
                    "query": query,
                    "deviceCount": per_device.len(),
                    "devices": per_device,
                }));
            }
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let results = host
                .fleet_call(&resolved.device_id, "search_session_content", build_args())
                .await?;
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "query": query,
                "results": results,
            }))
        }
        FleetControlRequest::ManageCron {
            target,
            action,
            job_id,
            workspace_id,
            workspace_path,
            session_id,
            name,
            schedule,
            payload,
            enabled,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let (command, args) = match action {
                FleetCronAction::List => {
                    let mut req = serde_json::Map::new();
                    if let Some(ws_id) = workspace_id.filter(|v| !v.trim().is_empty()) {
                        req.insert("workspaceId".into(), Value::String(ws_id));
                    }
                    if let Some(ws_path) = workspace_path.filter(|v| !v.trim().is_empty()) {
                        req.insert("workspacePath".into(), Value::String(ws_path));
                    }
                    ("list_cron_jobs", json!({ "request": Value::Object(req) }))
                }
                FleetCronAction::Create => {
                    let mut req = serde_json::Map::new();
                    if let Some(n) = name.filter(|v| !v.trim().is_empty()) {
                        req.insert("name".into(), Value::String(n));
                    }
                    if let Some(s) = schedule {
                        req.insert("schedule".into(), s);
                    }
                    if let Some(p) = payload {
                        req.insert("payload".into(), p);
                    }
                    if let Some(en) = enabled {
                        req.insert("enabled".into(), Value::Bool(en));
                    }
                    if let Some(ws_id) = workspace_id.filter(|v| !v.trim().is_empty()) {
                        req.insert("workspaceId".into(), Value::String(ws_id));
                    }
                    if let Some(ws_path) = workspace_path.filter(|v| !v.trim().is_empty()) {
                        req.insert("workspacePath".into(), Value::String(ws_path));
                    }
                    if let Some(sid) = session_id.filter(|v| !v.trim().is_empty()) {
                        req.insert("sessionId".into(), Value::String(sid));
                    }
                    ("create_cron_job", json!({ "request": Value::Object(req) }))
                }
                FleetCronAction::Update => {
                    let id = job_id
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| anyhow!("jobId is required for manage-cron update"))?;
                    let mut patch = serde_json::Map::new();
                    if let Some(n) = name.filter(|v| !v.trim().is_empty()) {
                        patch.insert("name".into(), Value::String(n));
                    }
                    if let Some(s) = schedule {
                        patch.insert("schedule".into(), s);
                    }
                    if let Some(p) = payload {
                        patch.insert("payload".into(), p);
                    }
                    if let Some(en) = enabled {
                        patch.insert("enabled".into(), Value::Bool(en));
                    }
                    (
                        "update_cron_job",
                        json!({ "request": { "jobId": id, "patch": Value::Object(patch) } }),
                    )
                }
                FleetCronAction::Delete => {
                    let id = job_id
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| anyhow!("jobId is required for manage-cron delete"))?;
                    ("delete_cron_job", json!({ "request": { "jobId": id } }))
                }
            };
            let result = host.fleet_call(&resolved.device_id, command, args).await?;
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "command": command,
                "result": result,
            }))
        }
        FleetControlRequest::InvokeControl {
            target,
            action,
            capability_id,
            operation_id,
            option_id,
            arguments,
            value,
        } => {
            let forwarded = ProductControlRequest {
                action,
                target: None,
                query: None,
                capability_id: Some(capability_id),
                item_id: None,
                operation_id,
                option_id,
                arguments,
                value,
                cursor: None,
                limit: None,
                source: ProductControlSource::Peer,
            };
            forward_product_control(host, target.as_deref(), forwarded).await
        }
    }
}

/// Forward a [`ProductControlRequest`] (`get` / `configure` / `execute`) to a
/// target device (`"self"` or an online peer over OpenBitFun Link) via
/// `product_control_invoke`, stripping `target` on the wire to prevent routing loops.
pub async fn forward_product_control(
    host: &dyn FleetControlHost,
    target: Option<&str>,
    mut request: ProductControlRequest,
) -> anyhow::Result<Value> {
    if matches!(
        request.action,
        ProductControlAction::List | ProductControlAction::Search | ProductControlAction::Open
    ) {
        bail!(
            "remote_product_control_unsupported: action '{}' cannot be forwarded to another device",
            request.action.as_str()
        );
    }
    let local_device_id = host.local_device_id();
    let nav = host.navigator().await?;
    let resolved = resolve_target_device(&nav, local_device_id.as_deref(), target, true)?;
    request.target = None;
    request.source = ProductControlSource::Peer;
    let mut response = host
        .fleet_call(
            &resolved.device_id,
            "product_control_invoke",
            json!({ "request": request }),
        )
        .await?;
    if let Some(obj) = response.as_object_mut() {
        obj.insert(
            "targetDeviceId".to_string(),
            Value::String(resolved.device_id),
        );
        obj.insert("targetDeviceName".to_string(), Value::String(resolved.name));
        obj.insert(
            "targetIsCurrentDevice".to_string(),
            Value::Bool(resolved.is_current_device),
        );
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::fleet::{
        FleetDeviceRoute, FleetHostKind, FleetPrompt, FleetPromptKind, FleetSession, FleetTotals,
        FleetWorkspace,
    };
    use std::sync::Mutex;

    struct FakeFleetHost {
        local_id: String,
        nav: FleetNavigator,
        prompts: FleetPromptsResponse,
        calls: Mutex<Vec<(String, String, Value)>>,
        dispatch_answers: Mutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl FleetControlHost for FakeFleetHost {
        fn local_device_id(&self) -> Option<String> {
            Some(self.local_id.clone())
        }
        async fn navigator(&self) -> anyhow::Result<FleetNavigator> {
            Ok(self.nav.clone())
        }
        async fn device_detail(&self, device_id: &str) -> anyhow::Result<FleetDeviceDetail> {
            let mut detail = FleetDeviceDetail::default();
            detail.device.device_id = device_id.to_string();
            Ok(detail)
        }
        async fn models(&self, _device_id: Option<&str>) -> anyhow::Result<FleetModels> {
            Ok(FleetModels::default())
        }
        async fn prompts(&self) -> anyhow::Result<FleetPromptsResponse> {
            Ok(self.prompts.clone())
        }
        async fn fleet_call(
            &self,
            target_device_id: &str,
            command: &str,
            args: Value,
        ) -> anyhow::Result<Value> {
            self.calls.lock().unwrap().push((
                target_device_id.to_string(),
                command.to_string(),
                args,
            ));
            match command {
                "create_session" => Ok(json!({ "sessionId": "new-sess-1" })),
                "start_dialog_turn" => Ok(json!({ "success": true })),
                "restore_session_view" => Ok(json!({
                    "session": { "sessionId": "sess-mac", "sessionName": "Mac Build" },
                    "totalTurnCount": 1,
                    "turns": [{
                        "turnId": "t1",
                        "status": "completed",
                        "userMessage": { "content": "build mac binary" },
                        "modelRounds": [{
                            "items": [{ "type": "text", "content": "Done: target/release/app" }]
                        }]
                    }],
                    "interactionSnapshot": {}
                })),
                "read_file_content" => Ok(Value::String(
                    base64::engine::general_purpose::STANDARD.encode(b"MZ-win-binary"),
                )),
                _ => Ok(json!({ "ok": true })),
            }
        }
        async fn dispatch_answer(
            &self,
            target_device_id: &str,
            payload: Value,
        ) -> anyhow::Result<Value> {
            self.dispatch_answers
                .lock()
                .unwrap()
                .push((target_device_id.to_string(), payload));
            Ok(json!({ "answered": true }))
        }
    }

    fn sample_host() -> FakeFleetHost {
        let local = FleetDevice {
            device_id: "mac-local".into(),
            name: "My MacBook".into(),
            host_kind: FleetHostKind::Desktop,
            is_client_device: true,
            state: FleetDeviceState::Online,
            route: Some(FleetDeviceRoute {
                kind: FleetRouteKind::Local,
                ..Default::default()
            }),
            workspaces: vec![FleetWorkspace {
                device_id: "mac-local".into(),
                workspace_id: "ws-mac".into(),
                name: "OpenBitFun".into(),
                root_path: "/Users/dev/OpenBitFun".into(),
                is_host_current: true,
                sessions: vec![FleetSession {
                    device_id: "mac-local".into(),
                    workspace_id: "ws-mac".into(),
                    session_id: "sess-mac".into(),
                    title: "Mac Build".into(),
                    agent_type: "Standard".into(),
                    ..Default::default()
                }],
                session_total: 1,
                ..Default::default()
            }],
            ..Default::default()
        };
        let win = FleetDevice {
            device_id: "win-peer".into(),
            name: "Win Desktop".into(),
            host_kind: FleetHostKind::Desktop,
            is_client_device: false,
            state: FleetDeviceState::Online,
            workspaces: vec![FleetWorkspace {
                device_id: "win-peer".into(),
                workspace_id: "ws-win".into(),
                name: "OpenBitFun".into(),
                root_path: "C:/dev/OpenBitFun".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let offline = FleetDevice {
            device_id: "linux-off".into(),
            name: "Offline Linux".into(),
            host_kind: FleetHostKind::Cli,
            is_client_device: false,
            state: FleetDeviceState::Offline,
            ..Default::default()
        };
        FakeFleetHost {
            local_id: "mac-local".into(),
            nav: FleetNavigator {
                revision: 7,
                full: true,
                devices: vec![local, win, offline],
                removed_device_ids: Vec::new(),
                totals: FleetTotals::default(),
            },
            prompts: FleetPromptsResponse {
                revision: 2,
                prompts: vec![FleetPrompt {
                    device_id: "win-peer".into(),
                    workspace_id: "ws-win".into(),
                    session_id: "sess-win".into(),
                    kind: FleetPromptKind::Permission,
                    prompt_id: "perm-1".into(),
                    answer_route: FleetAnswerRoute::Dispatch,
                    job_id: Some("job-win-1".into()),
                    answerable: true,
                    ..Default::default()
                }],
            },
            calls: Mutex::new(Vec::new()),
            dispatch_answers: Mutex::new(Vec::new()),
        }
    }

    #[tokio::test]
    async fn fleet_control_operates_on_local_self_and_peers_symmetrically() {
        let host = sample_host();

        // 1. Default target = THIS local device (never left out).
        let created_local = execute_fleet_control(
            &host,
            FleetControlRequest::CreateSession {
                target: None,
                workspace_id: Some("ws-mac".into()),
                workspace_path: None,
                session_name: "Local Parallel".into(),
                agent_type: None,
                model_name: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(created_local["deviceId"], "mac-local");
        assert_eq!(created_local["isCurrentDevice"], true);

        // 2. Local session message resolves self and preserves session agentType.
        let sent_local = execute_fleet_control(
            &host,
            FleetControlRequest::SendMessage {
                target: Some("self".into()),
                session_id: "sess-mac".into(),
                message: "build mac".into(),
                workspace_id: None,
                workspace_path: None,
                agent_type: None,
                model_id: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(sent_local["isCurrentDevice"], true);
        assert_eq!(sent_local["agentType"], "Standard");

        // 3. Read session projects compact turns.
        let read = execute_fleet_control(
            &host,
            FleetControlRequest::ReadSession {
                target: Some("self".into()),
                session_id: "sess-mac".into(),
                workspace_id: None,
                workspace_path: None,
                tail_turn_count: Some(2),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            read["turns"][0]["assistantText"],
            "Done: target/release/app"
        );

        // 4. Offline peer refuses loudly instead of falling back locally.
        let offline_err = execute_fleet_control(
            &host,
            FleetControlRequest::CreateSession {
                target: Some("Offline Linux".into()),
                workspace_id: Some("ws-x".into()),
                workspace_path: None,
                session_name: "Fail".into(),
                agent_type: None,
                model_name: None,
            },
        )
        .await
        .unwrap_err();
        assert!(
            offline_err.to_string().contains("no local fallback"),
            "{offline_err}"
        );

        // 5. Auto-routed dispatch prompt answer routes to dispatch_answer on owning device.
        let answered = execute_fleet_control(
            &host,
            FleetControlRequest::AnswerPrompt {
                target: None,
                request_id: "perm-1".into(),
                route: FleetPromptRoute::Auto,
                session_id: None,
                job_id: None,
                reply: Some(openbitfun_product_domains::fleet_control::FleetPermissionReply::Once),
                feedback: None,
                answers: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(answered["deviceId"], "win-peer");
        assert_eq!(answered["route"], "dispatch");
        assert_eq!(host.dispatch_answers.lock().unwrap().len(), 1);

        // 6. Pull file from peer workspace writes binary locally with sha256.
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("app.exe");
        let pulled = execute_fleet_control(
            &host,
            FleetControlRequest::PullFile {
                target: Some("Win Desktop".into()),
                remote_path: "C:/dev/OpenBitFun/dist/app.exe".into(),
                local_path: out.to_string_lossy().into_owned(),
                workspace_id: Some("ws-win".into()),
                overwrite: false,
                max_bytes: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"MZ-win-binary");
        assert_eq!(pulled["deviceId"], "win-peer");
        assert_eq!(pulled["size"], 13);

        // 7. Cross-device search fans out to self and online peers, skipping offline peers explicitly.
        let searched = execute_fleet_control(
            &host,
            FleetControlRequest::SearchSessions {
                target: Some("all".into()),
                query: "OOM".into(),
                workspace_id: None,
                workspace_path: None,
                limit: Some(10),
            },
        )
        .await
        .unwrap();
        assert_eq!(searched["deviceCount"], 3);
        let devices = searched["devices"].as_array().unwrap();
        assert!(devices
            .iter()
            .any(|d| d["deviceId"] == "mac-local" && d["results"].is_object()));
        assert!(devices
            .iter()
            .any(|d| d["deviceId"] == "win-peer" && d["results"].is_object()));
        assert!(devices
            .iter()
            .any(|d| d["deviceId"] == "linux-off" && d["skipped"].is_string()));

        // 8. Manage cron on an always-on peer dispatches create_cron_job on that peer.
        let cron = execute_fleet_control(
            &host,
            FleetControlRequest::ManageCron {
                target: Some("Win Desktop".into()),
                action: FleetCronAction::List,
                job_id: None,
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
                session_id: None,
                name: None,
                schedule: None,
                payload: None,
                enabled: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(cron["deviceId"], "win-peer");
        assert_eq!(cron["command"], "list_cron_jobs");

        // 9. Forwarded ProductControl strips target on wire and refuses presentation Open.
        let forwarded = forward_product_control(
            &host,
            Some("Win Desktop"),
            ProductControlRequest {
                action: ProductControlAction::Get,
                target: Some("Win Desktop".into()),
                query: None,
                capability_id: Some("setting.ai.models".into()),
                item_id: None,
                operation_id: None,
                option_id: None,
                arguments: None,
                value: None,
                cursor: None,
                limit: None,
                source: ProductControlSource::Agent,
            },
        )
        .await
        .unwrap();
        assert_eq!(forwarded["targetDeviceId"], "win-peer");
        let last_call = host.calls.lock().unwrap().last().unwrap().clone();
        assert_eq!(last_call.1, "product_control_invoke");
        assert!(last_call.2["request"].get("target").is_none());

        let open_err = forward_product_control(
            &host,
            Some("Win Desktop"),
            ProductControlRequest {
                action: ProductControlAction::Open,
                target: Some("Win Desktop".into()),
                query: None,
                capability_id: Some("feature.git".into()),
                item_id: None,
                operation_id: None,
                option_id: None,
                arguments: None,
                value: None,
                cursor: None,
                limit: None,
                source: ProductControlSource::Agent,
            },
        )
        .await
        .unwrap_err();
        assert!(open_err
            .to_string()
            .contains("remote_product_control_unsupported"));
    }
}
