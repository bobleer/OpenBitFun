//! Agent-facing Fleet controller shared by every product host (Desktop & CLI).
//!
//! Treats THIS executing device (`"self"` / `"local"` / omitted target) and
//! every same-account peer device on OpenBitFun Link symmetrically: one single
//! control plane for direct read/git/exec/search inspection across devices,
//! browsing workspaces/models/sessions/prompts, creating/driving/waiting on
//! sessions, answering prompts, and pulling workspace files back to this host.

use std::io::Write as _;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use async_trait::async_trait;
use base64::Engine as _;
use openbitfun_product_domains::fleet::{
    parse_model_ref, FleetAnswerRoute, FleetAttentionMarkReadResponse, FleetAttentionView,
    FleetDevice, FleetDeviceDetail, FleetDeviceState, FleetHostKind, FleetModelChoice,
    FleetModelRef, FleetModels, FleetNavigator, FleetPromptsResponse, FleetRecentSessions,
    FleetRecentSessionsRequest, FleetRouteKind, FleetWorkspace, FleetWorkspaceKind,
    MODEL_REASON_DEVICE_REQUIRES_UPDATE,
};
use openbitfun_product_domains::fleet_control::{
    FleetControlRequest, FleetCronAction, FleetFileAction, FleetPromptRoute, FleetSessionTargetRef,
    FleetTerminalAction, FleetWaitUntil, DEFAULT_FLEET_PULL_FILE_MAX_BYTES,
    DEFAULT_FLEET_WAIT_SECONDS, HARD_MAX_FLEET_PULL_FILE_BYTES, MAX_FLEET_WAIT_SECONDS,
    MAX_FLEET_WRITE_FILE_BYTES,
};
use openbitfun_product_domains::product_control::{
    ProductControlAction, ProductControlRequest, ProductControlSource,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const DEFAULT_NAVIGATOR_SESSIONS_PER_WORKSPACE: usize = 3;
const MAX_GIT_INSPECT_WORKSPACES_PER_DEVICE: usize = 12;
const MAX_GIT_INSPECT_DIFF_CHARS: usize = 12_000;
const MAX_RUN_COMMAND_OUTPUT_CHARS: usize = 16_000;
const DEFAULT_READ_FILE_MAX_CHARS: usize = 32_000;
const MAX_TURN_ASSISTANT_CHARS: usize = 6_000;
const MAX_TOOL_CALLS_PER_TURN: usize = 24;
const PUSH_FILE_CHUNK_BYTES: usize = 2 * 1024 * 1024;

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

fn default_workspace_for_device<'a>(
    navigator: &'a FleetNavigator,
    device_id: &str,
) -> Option<&'a FleetWorkspace> {
    let device = navigator
        .devices
        .iter()
        .find(|device| device.device_id == device_id)?;
    device
        .workspaces
        .iter()
        .find(|ws| {
            ws.is_host_current
                && ws.kind != FleetWorkspaceKind::Assistant
                && !ws.root_path.trim().is_empty()
        })
        .or_else(|| {
            device.workspaces.iter().find(|ws| {
                ws.kind != FleetWorkspaceKind::Assistant && !ws.root_path.trim().is_empty()
            })
        })
        .or_else(|| {
            device
                .workspaces
                .iter()
                .find(|ws| !ws.root_path.trim().is_empty())
        })
}

fn resolve_workspace_refs(
    navigator: &FleetNavigator,
    device_id: &str,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
    allow_default_workspace: bool,
) -> (Option<String>, Option<String>) {
    let mut resolved_id = workspace_id.filter(|v| !v.trim().is_empty()).or_else(|| {
        workspace_path
            .as_deref()
            .and_then(|path| find_workspace_id_by_path_in_navigator(navigator, device_id, path))
    });
    let mut resolved_path = workspace_path.filter(|v| !v.trim().is_empty()).or_else(|| {
        resolved_id
            .as_deref()
            .and_then(|id| find_workspace_path_in_navigator(navigator, device_id, id))
    });

    if allow_default_workspace && resolved_id.is_none() && resolved_path.is_none() {
        if let Some(ws) = default_workspace_for_device(navigator, device_id) {
            resolved_id = Some(ws.workspace_id.clone());
            resolved_path = Some(ws.root_path.clone());
        }
    }

    (resolved_id, resolved_path)
}

fn is_remote_absolute_path(path: &str) -> bool {
    let trimmed = path.trim();
    if trimmed.starts_with('/')
        || trimmed.starts_with("\\\\")
        || trimmed.starts_with("openbitfun://")
    {
        return true;
    }
    let bytes = trimmed.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// Join a target-relative path against a target workspace root using the target
/// workspace's separator convention (never controller host `std::path::Path`).
fn resolve_remote_workspace_path(root: Option<&str>, path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return root.unwrap_or_default().trim().to_string();
    }
    if is_remote_absolute_path(trimmed) {
        return trimmed.to_string();
    }
    let Some(root) = root.map(str::trim).filter(|v| !v.is_empty()) else {
        return trimmed.to_string();
    };
    let uses_backslash = root.contains('\\') && !root.contains('/');
    let sep = if uses_backslash { '\\' } else { '/' };
    let clean_root = root.trim_end_matches(['/', '\\']);
    let mut clean_rel = trimmed;
    loop {
        if let Some(rest) = clean_rel.strip_prefix("./") {
            clean_rel = rest;
        } else if let Some(rest) = clean_rel.strip_prefix(".\\") {
            clean_rel = rest;
        } else {
            break;
        }
    }
    if clean_rel.is_empty() || clean_rel == "." {
        return clean_root.to_string();
    }
    let normalized_rel = if uses_backslash {
        clean_rel.replace('/', "\\")
    } else {
        clean_rel.replace('\\', "/")
    };
    format!("{clean_root}{sep}{normalized_rel}")
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

fn tail_truncate_text(text: &str, max_chars: usize) -> (String, bool) {
    let total = text.chars().count();
    if total <= max_chars {
        return (text.to_string(), false);
    }
    let skip = total.saturating_sub(max_chars);
    let tail: String = text.chars().skip(skip).collect();
    (format!("…[truncated earlier output]\n{tail}"), true)
}

fn find_choice_matching<'a>(
    choices: &'a [FleetModelChoice],
    selector: &str,
) -> Option<&'a FleetModelChoice> {
    choices
        .iter()
        .find(|c| c.selectable && c.model.model_id == selector)
        .or_else(|| {
            choices.iter().find(|c| {
                c.selectable
                    && (c.model.model_name.eq_ignore_ascii_case(selector)
                        || c.model.display_name.eq_ignore_ascii_case(selector)
                        || c.model.label.eq_ignore_ascii_case(selector))
            })
        })
}

fn resolve_controller_model_choice<'a>(
    models_view: &'a FleetModels,
    local_device_id: Option<&str>,
    target_device_id: &str,
) -> Option<(&'a FleetModelChoice, &'static str)> {
    // 1. Prefer the exact model actively running this controller session.
    if let Some(caller_raw) =
        crate::agentic::tools::openbitfun_control_host::current_caller_model_id()
    {
        match parse_model_ref(&caller_raw) {
            FleetModelRef::Device {
                device_id,
                model_id,
            } => {
                if let Some(dev) = models_view
                    .devices
                    .iter()
                    .find(|d| d.device_id == device_id)
                {
                    if let Some(choice) = find_choice_matching(&dev.models, model_id) {
                        let source = if device_id == target_device_id {
                            "controller_model_local_on_target"
                        } else {
                            "controller_model_fleet_relay"
                        };
                        return Some((choice, source));
                    }
                }
            }
            FleetModelRef::Local(model_id) => {
                if let Some(local_id) = local_device_id {
                    if let Some(dev) = models_view.devices.iter().find(|d| d.device_id == local_id)
                    {
                        if let Some(choice) = find_choice_matching(&dev.models, model_id) {
                            return Some((choice, "controller_session_fleet_relay"));
                        }
                    }
                }
            }
        }
    }

    // 2. Fallback: controller device's primary (or first selectable) published model.
    if let Some(local_id) = local_device_id {
        if let Some(dev) = models_view.devices.iter().find(|d| d.device_id == local_id) {
            if let Some(choice) = dev
                .models
                .iter()
                .find(|c| c.selectable && c.model.primary)
                .or_else(|| dev.models.iter().find(|c| c.selectable))
            {
                return Some((choice, "controller_primary_fleet_relay"));
            }
        }
    }
    None
}

async fn resolve_effective_fleet_model(
    host: &dyn FleetControlHost,
    local_device_id: Option<&str>,
    target_device_id: &str,
    is_current_device: bool,
    requested: Option<&str>,
    auto_inherit_controller_for_peer: bool,
) -> Option<(String, &'static str)> {
    let trimmed = requested.map(str::trim).filter(|v| !v.is_empty());
    if let Some(raw) = trimmed {
        if raw.eq_ignore_ascii_case("target-default") || raw.eq_ignore_ascii_case("local-default") {
            return None;
        }
    }

    let models_view = host.models(Some(target_device_id)).await.ok();
    let target_outdated = models_view.as_ref().is_some_and(|view| {
        view.devices.iter().any(|d| {
            d.device_id == target_device_id
                && d.unavailable_reason.as_deref() == Some(MODEL_REASON_DEVICE_REQUIRES_UPDATE)
        })
    });

    if let Some(raw) = trimmed {
        if raw.eq_ignore_ascii_case("controller") || raw.eq_ignore_ascii_case("inherit") {
            if !target_outdated {
                if let Some(view) = models_view.as_ref() {
                    if let Some((choice, source)) =
                        resolve_controller_model_choice(view, local_device_id, target_device_id)
                    {
                        return Some((choice.model_ref.clone(), source));
                    }
                }
            }
            return crate::agentic::tools::openbitfun_control_host::current_caller_model_id()
                .map(|id| (id, "caller_model_fallback"));
        }

        if let Some(view) = models_view.as_ref() {
            match parse_model_ref(raw) {
                FleetModelRef::Device {
                    device_id,
                    model_id,
                } => {
                    if device_id == target_device_id {
                        return Some((model_id.to_string(), "target_local_unwrapped"));
                    }
                    if let Some(dev) = view.devices.iter().find(|d| d.device_id == device_id) {
                        if let Some(choice) = find_choice_matching(&dev.models, model_id) {
                            return Some((choice.model_ref.clone(), "explicit_fleet_ref"));
                        }
                    }
                    return Some((raw.to_string(), "explicit_passthrough"));
                }
                FleetModelRef::Local(name) => {
                    if let Some(target_dev) = view.devices.iter().find(|d| d.is_this_device) {
                        if let Some(choice) = find_choice_matching(&target_dev.models, name) {
                            return Some((choice.model_ref.clone(), "target_local_match"));
                        }
                    }
                    if !target_outdated {
                        if let Some(local_id) = local_device_id {
                            if let Some(local_dev) =
                                view.devices.iter().find(|d| d.device_id == local_id)
                            {
                                if let Some(choice) = find_choice_matching(&local_dev.models, name)
                                {
                                    return Some((
                                        choice.model_ref.clone(),
                                        "controller_model_matched_via_relay",
                                    ));
                                }
                            }
                        }
                        for dev in &view.devices {
                            if dev.is_this_device {
                                continue;
                            }
                            if let Some(choice) = find_choice_matching(&dev.models, name) {
                                return Some((
                                    choice.model_ref.clone(),
                                    "peer_model_matched_via_relay",
                                ));
                            }
                        }
                    }
                    return Some((raw.to_string(), "explicit_passthrough"));
                }
            }
        }
        return Some((raw.to_string(), "explicit_passthrough"));
    }

    // No model explicitly requested: on a remote peer, auto-inherit the
    // controller's active working model over `fleet_model_v1` so peers without
    // configured or reachable local API keys still work seamlessly.
    if auto_inherit_controller_for_peer && !is_current_device && !target_outdated {
        if let Some(view) = models_view.as_ref() {
            if let Some((choice, source)) =
                resolve_controller_model_choice(view, local_device_id, target_device_id)
            {
                return Some((choice.model_ref.clone(), source));
            }
        }
    }
    None
}

fn compact_tool_result_preview(tool_result: &Value) -> (Option<String>, Option<String>) {
    let error = tool_result
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| truncate_text(v, 300));
    if error.is_some() {
        return (error, None);
    }
    let preview = tool_result
        .get("resultForAssistant")
        .or_else(|| tool_result.get("result_for_assistant"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| truncate_text(v, 240))
        .or_else(|| {
            tool_result.get("result").and_then(|val| match val {
                Value::Null => None,
                Value::String(s) => {
                    let trimmed = s.trim();
                    (!trimmed.is_empty()).then(|| truncate_text(trimmed, 240))
                }
                other => {
                    let serialized = serde_json::to_string(other).unwrap_or_default();
                    (!serialized.is_empty() && serialized != "{}" && serialized != "[]")
                        .then(|| truncate_text(&serialized, 240))
                }
            })
        });
    (None, preview)
}

fn extract_live_text_from_runtime_events(
    runtime_event_snapshot: Option<&Value>,
    turn_id: &str,
) -> Option<String> {
    let events = runtime_event_snapshot?
        .get("events")
        .and_then(Value::as_array)?;
    let mut chunks = Vec::new();
    for event in events {
        let name = event
            .get("eventName")
            .or_else(|| event.get("event_name"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = event.get("payload").unwrap_or(event);
        if !turn_id.is_empty() {
            if let Some(ev_turn) = payload
                .get("turnId")
                .or_else(|| payload.get("turn_id"))
                .and_then(Value::as_str)
            {
                if ev_turn != turn_id {
                    continue;
                }
            }
        }
        let lower = name.to_ascii_lowercase();
        if lower.contains("text") {
            if let Some(text) = payload
                .get("text")
                .or_else(|| payload.get("content"))
                .or_else(|| payload.get("delta"))
                .and_then(Value::as_str)
            {
                if !text.is_empty() {
                    chunks.push(text);
                }
            }
        }
    }
    if chunks.is_empty() {
        None
    } else {
        Some(chunks.concat())
    }
}

fn summarize_turn_with_events(turn: &Value, runtime_event_snapshot: Option<&Value>) -> Value {
    let turn_id = turn
        .get("turnId")
        .or_else(|| turn.get("turn_id"))
        .or_else(|| turn.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let status = turn
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let user_text = turn
        .pointer("/userMessage/content")
        .or_else(|| turn.pointer("/user_message/content"))
        .or_else(|| turn.get("userInput"))
        .and_then(Value::as_str)
        .map(|text| truncate_text(text, 1000))
        .unwrap_or_default();

    let mut assistant_chunks = Vec::new();
    let mut subagent_text_fallback = Vec::new();
    let mut tool_calls = Vec::new();
    let mut failure_categories = Vec::new();
    let mut total_tool_calls = 0usize;

    let rounds = turn
        .get("modelRounds")
        .or_else(|| turn.get("model_rounds"))
        .and_then(Value::as_array);

    if let Some(rounds) = rounds {
        for round in rounds {
            if let Some(cat) = round
                .get("failureCategory")
                .or_else(|| round.get("failure_category"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                if !failure_categories.iter().any(|existing| existing == cat) {
                    failure_categories.push(cat.to_string());
                }
            }

            // Real persisted ModelRoundData shape: `textItems` + `toolItems`.
            if let Some(text_items) = round
                .get("textItems")
                .or_else(|| round.get("text_items"))
                .and_then(Value::as_array)
            {
                for item in text_items {
                    let Some(content) = item.get("content").and_then(Value::as_str) else {
                        continue;
                    };
                    if content.trim().is_empty() {
                        continue;
                    }
                    let is_subagent = item
                        .get("isSubagentItem")
                        .or_else(|| item.get("is_subagent_item"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if is_subagent {
                        subagent_text_fallback.push(content.to_string());
                    } else {
                        assistant_chunks.push(content.to_string());
                    }
                }
            }

            if let Some(tool_items) = round
                .get("toolItems")
                .or_else(|| round.get("tool_items"))
                .and_then(Value::as_array)
            {
                for item in tool_items {
                    let is_subagent = item
                        .get("isSubagentItem")
                        .or_else(|| item.get("is_subagent_item"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if is_subagent {
                        continue;
                    }
                    total_tool_calls += 1;
                    if tool_calls.len() >= MAX_TOOL_CALLS_PER_TURN {
                        continue;
                    }
                    let tool_name = item
                        .get("toolName")
                        .or_else(|| item.get("tool_name"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    let tool_result = item.get("toolResult").or_else(|| item.get("tool_result"));
                    let item_status = item
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| {
                            tool_result
                                .and_then(|r| r.get("success"))
                                .and_then(Value::as_bool)
                                .map(|ok| if ok { "completed" } else { "error" }.to_string())
                        });
                    let mut entry = serde_json::Map::new();
                    entry.insert("toolName".into(), tool_name);
                    entry.insert(
                        "status".into(),
                        item_status.map(Value::String).unwrap_or(Value::Null),
                    );
                    if let Some(intent) = item
                        .get("aiIntent")
                        .or_else(|| item.get("ai_intent"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                    {
                        entry.insert("aiIntent".into(), Value::String(truncate_text(intent, 160)));
                    }
                    if let Some(res) = tool_result {
                        let (err, preview) = compact_tool_result_preview(res);
                        if let Some(err) = err {
                            entry.insert("error".into(), Value::String(err));
                        } else if let Some(preview) = preview {
                            entry.insert("resultPreview".into(), Value::String(preview));
                        }
                    }
                    tool_calls.push(Value::Object(entry));
                }
            }

            // Legacy/synthetic shape fallback: `items: [{ type: "text" | "tool", ... }]`.
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
                        total_tool_calls += 1;
                        if tool_calls.len() < MAX_TOOL_CALLS_PER_TURN {
                            tool_calls.push(json!({
                                "toolName": item.get("toolName").cloned().unwrap_or(Value::Null),
                                "status": item.get("status").cloned().unwrap_or(Value::Null),
                            }));
                        }
                    }
                }
            }
        }
    }

    if assistant_chunks.is_empty() && !subagent_text_fallback.is_empty() {
        assistant_chunks = subagent_text_fallback;
    }
    if assistant_chunks.is_empty() {
        if let Some(live_text) =
            extract_live_text_from_runtime_events(runtime_event_snapshot, turn_id)
        {
            if !live_text.trim().is_empty() {
                assistant_chunks.push(live_text);
            }
        }
    }

    let assistant_text = truncate_text(&assistant_chunks.join("\n"), MAX_TURN_ASSISTANT_CHARS);
    let mut summary = json!({
        "turnId": turn_id,
        "status": status,
        "userMessage": user_text,
        "assistantText": assistant_text,
        "toolCalls": tool_calls,
    });
    if total_tool_calls > tool_calls.len() {
        summary["totalToolCalls"] = Value::from(total_tool_calls);
    }
    if !failure_categories.is_empty() {
        summary["failureCategories"] = Value::from(failure_categories);
    }
    if let Some(error) = turn
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        summary["error"] = Value::String(truncate_text(error, 1000));
    }
    if let Some(detail) = turn
        .get("errorDetail")
        .or_else(|| turn.get("error_detail"))
        .filter(|v| !v.is_null())
    {
        summary["errorDetail"] = detail.clone();
    }
    summary
}

fn project_device_for_agent(
    device: &FleetDevice,
    local_device_id: Option<&str>,
    include_capabilities: bool,
    max_sessions_per_workspace: usize,
) -> Value {
    let is_current = is_local_device(device, local_device_id);
    let workspaces: Vec<Value> = device
        .workspaces
        .iter()
        .map(|ws| {
            let recent_sessions: Vec<Value> = ws
                .sessions
                .iter()
                .take(max_sessions_per_workspace)
                .map(|s| {
                    json!({
                        "sessionId": s.session_id,
                        "title": s.title,
                        "status": s.status,
                        "agentType": s.agent_type,
                        "needsAttention": s.needs_attention,
                        "unread": s.unread,
                    })
                })
                .collect();
            let mut obj = serde_json::Map::new();
            obj.insert("workspaceId".into(), Value::String(ws.workspace_id.clone()));
            obj.insert("name".into(), Value::String(ws.name.clone()));
            obj.insert("rootPath".into(), Value::String(ws.root_path.clone()));
            obj.insert(
                "kind".into(),
                serde_json::to_value(ws.kind).unwrap_or(Value::Null),
            );
            obj.insert("isHostCurrent".into(), Value::Bool(ws.is_host_current));
            if let Some(ssh_host) = &ws.ssh_host {
                obj.insert("sshHost".into(), Value::String(ssh_host.clone()));
            }
            if let Some(conn) = &ws.connection_name {
                obj.insert("connectionName".into(), Value::String(conn.clone()));
            }
            obj.insert("sessionTotal".into(), Value::from(ws.session_total));
            obj.insert(
                "hasMoreSessions".into(),
                Value::Bool(ws.has_more || ws.sessions.len() > recent_sessions.len()),
            );
            obj.insert("recentSessions".into(), Value::Array(recent_sessions));
            Value::Object(obj)
        })
        .collect();

    let mut obj = serde_json::Map::new();
    obj.insert("deviceId".into(), Value::String(device.device_id.clone()));
    obj.insert("name".into(), Value::String(device.name.clone()));
    obj.insert(
        "hostKind".into(),
        serde_json::to_value(device.host_kind).unwrap_or(Value::Null),
    );
    obj.insert(
        "state".into(),
        serde_json::to_value(device.state).unwrap_or(Value::Null),
    );
    if let Some(reason) = &device.state_reason {
        obj.insert("stateReason".into(), Value::String(reason.clone()));
    }
    obj.insert("isCurrentDevice".into(), Value::Bool(is_current));
    if let Some(version) = &device.version {
        obj.insert("version".into(), Value::String(version.clone()));
    }
    if let Some(route) = &device.route {
        obj.insert(
            "route".into(),
            serde_json::to_value(route).unwrap_or(Value::Null),
        );
    }
    obj.insert(
        "capabilityCount".into(),
        Value::from(device.host_capabilities.len()),
    );
    if include_capabilities {
        obj.insert(
            "hostCapabilities".into(),
            serde_json::to_value(&device.host_capabilities).unwrap_or(Value::Array(Vec::new())),
        );
    }
    obj.insert("workspaceCount".into(), Value::from(workspaces.len()));
    obj.insert("workspaces".into(), Value::Array(workspaces));
    Value::Object(obj)
}

fn count_pending_prompts_in_snapshot(snapshot: &Value) -> usize {
    let mut count = 0usize;
    if let Some(arr) = snapshot
        .pointer("/permissions/requests")
        .or_else(|| snapshot.get("pendingPermissions"))
        .and_then(Value::as_array)
    {
        count += arr.len();
    }
    if let Some(arr) = snapshot
        .pointer("/userQuestions/questions")
        .or_else(|| snapshot.pointer("/user_questions/questions"))
        .or_else(|| snapshot.get("pendingQuestions"))
        .and_then(Value::as_array)
    {
        count += arr.len();
    }
    if let Some(arr) = snapshot
        .get("pendingConfirmations")
        .and_then(Value::as_array)
    {
        count += arr.len();
    }
    count
}

fn is_terminal_turn_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "completed" | "complete" | "done" | "error" | "failed" | "cancelled" | "canceled"
    )
}

fn is_active_session_state(state: &str) -> bool {
    let lower = state.trim().to_ascii_lowercase();
    lower.contains("processing") || lower.contains("running") || lower.contains("streaming")
}

#[derive(Debug, Clone)]
struct PolledSessionView {
    device_id: String,
    session_id: String,
    session_state: String,
    latest_turn_id: String,
    latest_turn_status: String,
    pending_prompt_count: usize,
    is_done: bool,
    summary_json: Value,
}

async fn poll_session_view(
    host: &dyn FleetControlHost,
    nav: &FleetNavigator,
    local_device_id: Option<&str>,
    target: Option<&str>,
    session_id: &str,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
    tail_turn_count: usize,
    expected_turn_id: Option<&str>,
) -> anyhow::Result<PolledSessionView> {
    let resolved = resolve_target_device(nav, local_device_id, target, true)?;
    let nav_ctx = find_session_context_in_navigator(nav, &resolved.device_id, session_id);
    let resolved_ws_id = workspace_id
        .filter(|v| !v.trim().is_empty())
        .or_else(|| nav_ctx.as_ref().map(|(id, _, _)| id.clone()));
    let resolved_ws_path = workspace_path
        .filter(|v| !v.trim().is_empty())
        .or_else(|| nav_ctx.as_ref().and_then(|(_, path, _)| path.clone()))
        .or_else(|| {
            resolved_ws_id
                .as_deref()
                .and_then(|id| find_workspace_path_in_navigator(nav, &resolved.device_id, id))
        });

    let mut req = json!({
        "sessionId": session_id,
        "tailTurnCount": tail_turn_count,
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

    let runtime_events = raw
        .get("runtimeEventSnapshot")
        .or_else(|| raw.get("runtime_event_snapshot"));
    let turns: Vec<Value> = raw
        .get("turns")
        .and_then(Value::as_array)
        .map(|turns| {
            turns
                .iter()
                .map(|turn| summarize_turn_with_events(turn, runtime_events))
                .collect()
        })
        .unwrap_or_default();

    let session_obj = raw.get("session").cloned().unwrap_or(Value::Null);
    let session_state = session_obj
        .get("state")
        .or_else(|| session_obj.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let interaction_snapshot = raw
        .get("interactionSnapshot")
        .or_else(|| raw.get("interaction_snapshot"))
        .cloned()
        .unwrap_or(Value::Null);
    let pending_prompt_count = count_pending_prompts_in_snapshot(&interaction_snapshot);

    let (latest_turn_id, latest_turn_status) = turns
        .last()
        .map(|turn| {
            (
                turn.get("turnId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                turn.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
            )
        })
        .unwrap_or_else(|| (String::new(), "none".to_string()));

    let turn_settled = match expected_turn_id {
        Some(expected) => turns.iter().any(|turn| {
            turn.get("turnId").and_then(Value::as_str) == Some(expected)
                && turn
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(is_terminal_turn_status)
        }),
        None => turns.is_empty() || is_terminal_turn_status(&latest_turn_status),
    };
    let is_done =
        !is_active_session_state(&session_state) && pending_prompt_count == 0 && turn_settled;

    let mut summary_json = json!({
        "deviceId": resolved.device_id,
        "deviceName": resolved.name,
        "isCurrentDevice": resolved.is_current_device,
        "sessionId": session_id,
        "sessionState": session_state,
        "isDone": is_done,
        "hasPendingPrompt": pending_prompt_count > 0,
        "pendingPromptCount": pending_prompt_count,
        "session": session_obj,
        "totalTurnCount": raw.get("totalTurnCount").cloned().unwrap_or(Value::Null),
        "loadedTurnCount": turns.len(),
        "turns": turns,
        "interactionSnapshot": interaction_snapshot,
    });

    // If a remote session failed (e.g. peer-local model unreachable), surface the
    // controller's working Fleet relay model so the caller can recover immediately.
    let latest_failed = !resolved.is_current_device
        && turns.last().is_some_and(|turn| {
            let st = turn
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            st.eq_ignore_ascii_case("error")
                || st.eq_ignore_ascii_case("failed")
                || turn
                    .get("failureCategories")
                    .and_then(Value::as_array)
                    .is_some_and(|arr| !arr.is_empty())
        });
    if latest_failed {
        if let Some((fallback_ref, source)) = resolve_effective_fleet_model(
            host,
            local_device_id,
            &resolved.device_id,
            false,
            None,
            true,
        )
        .await
        {
            summary_json["suggestedFallbackModel"] = json!({
                "modelRef": fallback_ref,
                "source": source,
                "hint": "Peer turn failed; retry with feature.fleet:send-message passing modelId: \"controller\" (or this modelRef) to route inference through this controller's working model via Fleet model relay.",
            });
        }
    }

    Ok(PolledSessionView {
        device_id: resolved.device_id,
        session_id: session_id.to_string(),
        session_state,
        latest_turn_id,
        latest_turn_status,
        pending_prompt_count,
        is_done,
        summary_json,
    })
}

async fn start_session_turn(
    host: &dyn FleetControlHost,
    nav: &FleetNavigator,
    resolved: &ResolvedDevice,
    session_id: &str,
    message: &str,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
    agent_type: Option<String>,
    model_id: Option<String>,
) -> anyhow::Result<(String, String, Value)> {
    let nav_ctx = find_session_context_in_navigator(nav, &resolved.device_id, session_id);
    let resolved_ws_id = workspace_id
        .filter(|v| !v.trim().is_empty())
        .or_else(|| nav_ctx.as_ref().map(|(id, _, _)| id.clone()));
    let resolved_ws_path = workspace_path
        .filter(|v| !v.trim().is_empty())
        .or_else(|| nav_ctx.as_ref().and_then(|(_, path, _)| path.clone()))
        .or_else(|| {
            resolved_ws_id
                .as_deref()
                .and_then(|id| find_workspace_path_in_navigator(nav, &resolved.device_id, id))
        });
    let resolved_agent = agent_type
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|agent| openbitfun_core_types::agent_identity::canonical_agent_id(agent).to_string())
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
    Ok((turn_id, resolved_agent, response))
}

async fn wait_for_sessions(
    host: &dyn FleetControlHost,
    nav: &FleetNavigator,
    local_device_id: Option<&str>,
    targets: &[FleetSessionTargetRef],
    expected_turn_id: Option<&str>,
    until: FleetWaitUntil,
    timeout_seconds: u64,
    tail_turn_count: usize,
) -> anyhow::Result<Value> {
    let started = Instant::now();
    let deadline = started + Duration::from_secs(timeout_seconds.clamp(1, MAX_FLEET_WAIT_SECONDS));
    let mut initial_fingerprints: Option<Vec<(String, String, String, usize)>> = None;
    let mut poll_index = 0u32;

    loop {
        let polled = futures::future::join_all(targets.iter().map(|target_ref| async move {
            (
                target_ref,
                poll_session_view(
                    host,
                    nav,
                    local_device_id,
                    target_ref.target.as_deref(),
                    &target_ref.session_id,
                    target_ref.workspace_id.clone(),
                    target_ref.workspace_path.clone(),
                    tail_turn_count,
                    expected_turn_id,
                )
                .await,
            )
        }))
        .await;
        let mut views = Vec::with_capacity(targets.len());
        let mut poll_errors = Vec::new();
        for (target_ref, outcome) in polled {
            match outcome {
                Ok(view) => views.push(view),
                Err(error) => poll_errors.push(json!({
                    "target": target_ref.target,
                    "sessionId": target_ref.session_id,
                    "error": error.to_string(),
                })),
            }
        }

        // Cross-check Fleet-level prompts too so permission/question waits surface immediately.
        if let Ok(fleet_prompts) = host.prompts().await {
            for view in &mut views {
                let extra = fleet_prompts
                    .prompts
                    .iter()
                    .filter(|p| p.device_id == view.device_id && p.session_id == view.session_id)
                    .count();
                if extra > view.pending_prompt_count {
                    view.pending_prompt_count = extra;
                    view.is_done = false;
                    if let Some(obj) = view.summary_json.as_object_mut() {
                        obj.insert("isDone".into(), Value::Bool(false));
                        obj.insert("hasPendingPrompt".into(), Value::Bool(true));
                        obj.insert("pendingPromptCount".into(), Value::from(extra));
                    }
                }
            }
        }

        let current_fingerprints: Vec<(String, String, String, usize)> = views
            .iter()
            .map(|v| {
                (
                    v.session_state.clone(),
                    v.latest_turn_id.clone(),
                    v.latest_turn_status.clone(),
                    v.pending_prompt_count,
                )
            })
            .collect();

        let blocked_on_prompt = views.iter().any(|v| v.pending_prompt_count > 0);
        let all_settled = !views.is_empty()
            && poll_errors.is_empty()
            && views
                .iter()
                .all(|v| v.is_done || v.pending_prompt_count > 0);
        let any_done = views.iter().any(|v| v.is_done);
        let state_changed = initial_fingerprints
            .as_ref()
            .is_some_and(|initial| initial != &current_fingerprints);
        if initial_fingerprints.is_none() {
            initial_fingerprints = Some(current_fingerprints);
        }

        let (satisfied, reason) = match until {
            FleetWaitUntil::AllDone => {
                if all_settled {
                    (
                        true,
                        if blocked_on_prompt {
                            "prompt_required"
                        } else {
                            "all_done"
                        },
                    )
                } else {
                    (false, "timeout")
                }
            }
            FleetWaitUntil::AnyDone => {
                if any_done {
                    (true, "any_done")
                } else if blocked_on_prompt {
                    (true, "prompt_required")
                } else {
                    (false, "timeout")
                }
            }
            FleetWaitUntil::AnyPrompt => {
                if blocked_on_prompt {
                    (true, "prompt_required")
                } else if all_settled {
                    (true, "all_done")
                } else {
                    (false, "timeout")
                }
            }
            FleetWaitUntil::StateChange => {
                if state_changed {
                    (true, "state_change")
                } else if all_settled && poll_index > 0 {
                    (
                        true,
                        if blocked_on_prompt {
                            "prompt_required"
                        } else {
                            "all_done"
                        },
                    )
                } else {
                    (false, "timeout")
                }
            }
        };

        let now = Instant::now();
        if satisfied || now >= deadline {
            let mut result = json!({
                "satisfied": satisfied,
                "timedOut": !satisfied,
                "reason": reason,
                "blockedOnPrompt": blocked_on_prompt,
                "elapsedMs": started.elapsed().as_millis() as u64,
                "sessions": views.into_iter().map(|v| v.summary_json).collect::<Vec<_>>(),
            });
            if !poll_errors.is_empty() {
                result["errors"] = Value::Array(poll_errors);
            }
            return Ok(result);
        }

        let delay_ms = match poll_index {
            0 => 400,
            1 => 800,
            2 => 1_500,
            _ => 2_000,
        };
        poll_index = poll_index.saturating_add(1);
        let remaining = deadline.saturating_duration_since(now);
        tokio::time::sleep(Duration::from_millis(delay_ms).min(remaining)).await;
    }
}

fn is_unsupported_command_error(error: &anyhow::Error) -> bool {
    let lower = error.to_string().to_ascii_lowercase();
    lower.contains("unknown command")
        || lower.contains("unsupported")
        || lower.contains("not implemented")
        || lower.contains("unhandled command")
        || lower.contains("method not found")
}

fn git_str_field<'a>(value: &'a Value, snake: &str, camel: &str) -> Option<&'a str> {
    value
        .get(snake)
        .or_else(|| value.get(camel))
        .and_then(Value::as_str)
}

fn git_i64_field(value: &Value, snake: &str, camel: &str) -> i64 {
    value
        .get(snake)
        .or_else(|| value.get(camel))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn extract_git_file_paths(value: &Value, key: &str) -> (usize, Vec<String>) {
    let Some(arr) = value.get(key).and_then(Value::as_array) else {
        return (0, Vec::new());
    };
    let total = arr.len();
    let paths = arr
        .iter()
        .take(20)
        .filter_map(|entry| match entry {
            Value::String(s) => Some(s.clone()),
            Value::Object(map) => map.get("path").and_then(Value::as_str).map(str::to_string),
            _ => None,
        })
        .collect();
    (total, paths)
}

async fn inspect_workspace_git(
    host: &dyn FleetControlHost,
    device_id: &str,
    workspace_id: Option<&str>,
    workspace_name: &str,
    root_path: &str,
    include_branches: bool,
    include_diff: bool,
    max_commits: usize,
) -> Value {
    let mut base_req = json!({ "repositoryPath": root_path });
    if let Some(ws_id) = workspace_id.filter(|v| !v.trim().is_empty()) {
        base_req["workspaceId"] = Value::String(ws_id.to_string());
    }

    let repo = match host
        .fleet_call(
            device_id,
            "git_get_repository",
            json!({ "request": base_req }),
        )
        .await
    {
        Ok(val) => val,
        Err(error) => {
            let msg = error.to_string();
            let lower = msg.to_ascii_lowercase();
            let not_git = lower.contains("not a git repository")
                || lower.contains("repository not found")
                || lower.contains("could not find repository");
            return json!({
                "workspaceId": workspace_id,
                "workspaceName": workspace_name,
                "rootPath": root_path,
                "isGitRepo": !not_git,
                "error": msg,
            });
        }
    };

    let mut commits_req = base_req.clone();
    commits_req["params"] = json!({ "max_count": max_commits as i32 });
    let status_fut = host.fleet_call(device_id, "git_get_status", json!({ "request": base_req }));
    let commits_fut = host.fleet_call(
        device_id,
        "git_get_commits",
        json!({ "request": commits_req }),
    );
    let branches_fut = async {
        if !include_branches {
            return None;
        }
        let mut branches_req = base_req.clone();
        branches_req["includeRemote"] = Value::Bool(true);
        host.fleet_call(
            device_id,
            "git_get_branches",
            json!({ "request": branches_req }),
        )
        .await
        .ok()
    };
    let diff_fut = async {
        if !include_diff {
            return None;
        }
        let mut diff_req = base_req.clone();
        diff_req["params"] = json!({});
        host.fleet_call(device_id, "git_get_diff", json!({ "request": diff_req }))
            .await
            .ok()
    };
    let (status_res, commits_res, branches_raw, diff_raw) =
        tokio::join!(status_fut, commits_fut, branches_fut, diff_fut);
    let status = status_res.ok();
    let commits_raw = commits_res.ok();

    let current_branch = status
        .as_ref()
        .and_then(|s| git_str_field(s, "current_branch", "currentBranch"))
        .filter(|s| !s.trim().is_empty())
        .or_else(|| git_str_field(&repo, "current_branch", "currentBranch"))
        .unwrap_or("HEAD")
        .to_string();

    let ahead = status
        .as_ref()
        .map(|s| git_i64_field(s, "ahead", "ahead"))
        .unwrap_or(0);
    let behind = status
        .as_ref()
        .map(|s| git_i64_field(s, "behind", "behind"))
        .unwrap_or(0);
    let (staged_count, staged_files) = status
        .as_ref()
        .map(|s| extract_git_file_paths(s, "staged"))
        .unwrap_or((0, Vec::new()));
    let (unstaged_count, unstaged_files) = status
        .as_ref()
        .map(|s| extract_git_file_paths(s, "unstaged"))
        .unwrap_or((0, Vec::new()));
    let (untracked_count, untracked_files) = status
        .as_ref()
        .map(|s| extract_git_file_paths(s, "untracked"))
        .unwrap_or((0, Vec::new()));
    let (conflict_count, conflict_files) = status
        .as_ref()
        .map(|s| extract_git_file_paths(s, "conflicts"))
        .unwrap_or((0, Vec::new()));
    let is_clean =
        staged_count == 0 && unstaged_count == 0 && untracked_count == 0 && conflict_count == 0;

    let commits: Vec<Value> = commits_raw
        .as_ref()
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(max_commits)
                .map(|c| {
                    json!({
                        "shortHash": git_str_field(c, "short_hash", "shortHash").unwrap_or_default(),
                        "hash": git_str_field(c, "hash", "hash").unwrap_or_default(),
                        "message": git_str_field(c, "message", "message").map(|m| truncate_text(m, 200)).unwrap_or_default(),
                        "author": git_str_field(c, "author", "author").unwrap_or_default(),
                        "date": git_str_field(c, "date", "date").unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let remotes: Vec<String> = repo
        .get("remotes")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let mut summary = json!({
        "workspaceId": workspace_id,
        "workspaceName": workspace_name,
        "rootPath": root_path,
        "isGitRepo": true,
        "currentBranch": current_branch,
        "ahead": ahead,
        "behind": behind,
        "isClean": is_clean,
        "stagedCount": staged_count,
        "unstagedCount": unstaged_count,
        "untrackedCount": untracked_count,
        "conflictCount": conflict_count,
        "remotes": remotes,
        "commits": commits,
    });
    if !staged_files.is_empty() {
        summary["stagedFiles"] = Value::from(staged_files);
    }
    if !unstaged_files.is_empty() {
        summary["unstagedFiles"] = Value::from(unstaged_files);
    }
    if !untracked_files.is_empty() {
        summary["untrackedFiles"] = Value::from(untracked_files);
    }
    if !conflict_files.is_empty() {
        summary["conflictFiles"] = Value::from(conflict_files);
    }

    if let Some(branches_raw) = branches_raw {
        if let Some(arr) = branches_raw.as_array() {
            let projected: Vec<Value> = arr
                .iter()
                .take(40)
                .map(|b| {
                    json!({
                        "name": b.get("name").and_then(Value::as_str).unwrap_or_default(),
                        "current": b.get("current").and_then(Value::as_bool).unwrap_or(false),
                        "remote": b.get("remote").and_then(Value::as_bool).unwrap_or(false),
                        "upstream": b.get("upstream").cloned().unwrap_or(Value::Null),
                        "ahead": git_i64_field(b, "ahead", "ahead"),
                        "behind": git_i64_field(b, "behind", "behind"),
                    })
                })
                .collect();
            summary["branches"] = Value::Array(projected);
        }
    }

    if let Some(diff_raw) = diff_raw {
        if let Some(diff_text) = diff_raw.as_str() {
            summary["diff"] = Value::String(truncate_text(diff_text, MAX_GIT_INSPECT_DIFF_CHARS));
        }
    }

    summary
}

async fn search_sessions_on_device(
    host: &dyn FleetControlHost,
    nav: &FleetNavigator,
    device: &FleetDevice,
    query: &str,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    limit: Option<usize>,
) -> anyhow::Result<Value> {
    let explicit_ws_id = workspace_id.map(str::trim).filter(|v| !v.is_empty());
    let explicit_ws_path = workspace_path.map(str::trim).filter(|v| !v.is_empty());

    if explicit_ws_id.is_some() || explicit_ws_path.is_some() {
        let (resolved_ws_id, resolved_ws_path) = resolve_workspace_refs(
            nav,
            &device.device_id,
            explicit_ws_id.map(str::to_string),
            explicit_ws_path.map(str::to_string),
            false,
        );
        let mut req = json!({
            "query": query,
            "workspacePath": resolved_ws_path.unwrap_or_default(),
        });
        if let Some(id) = resolved_ws_id {
            req["workspaceId"] = Value::String(id);
        }
        if let Some(l) = limit {
            req["limit"] = Value::from(l);
        }
        return host
            .fleet_call(
                &device.device_id,
                "search_session_content",
                json!({ "request": req }),
            )
            .await;
    }

    let searchable_workspaces: Vec<&FleetWorkspace> = device
        .workspaces
        .iter()
        .filter(|ws| !ws.root_path.trim().is_empty())
        .collect();
    if searchable_workspaces.is_empty() {
        let mut req = json!({ "query": query, "workspacePath": "" });
        if let Some(l) = limit {
            req["limit"] = Value::from(l);
        }
        return host
            .fleet_call(
                &device.device_id,
                "search_session_content",
                json!({ "request": req }),
            )
            .await;
    }

    let mut per_workspace = Vec::new();
    let mut aggregated_matches = Vec::new();
    let mut errors = Vec::new();
    for ws in searchable_workspaces {
        let mut req = json!({
            "query": query,
            "workspaceId": ws.workspace_id,
            "workspacePath": ws.root_path,
        });
        if let Some(l) = limit {
            req["limit"] = Value::from(l);
        }
        match host
            .fleet_call(
                &device.device_id,
                "search_session_content",
                json!({ "request": req }),
            )
            .await
        {
            Ok(result) => {
                if let Some(arr) = result.as_array() {
                    for item in arr {
                        let mut entry = item.clone();
                        if let Some(obj) = entry.as_object_mut() {
                            obj.entry("workspaceId".to_string())
                                .or_insert_with(|| Value::String(ws.workspace_id.clone()));
                            obj.entry("workspaceName".to_string())
                                .or_insert_with(|| Value::String(ws.name.clone()));
                        }
                        aggregated_matches.push(entry);
                    }
                } else if let Some(arr) = result
                    .get("results")
                    .or_else(|| result.get("matches"))
                    .or_else(|| result.get("sessions"))
                    .and_then(Value::as_array)
                {
                    for item in arr {
                        let mut entry = item.clone();
                        if let Some(obj) = entry.as_object_mut() {
                            obj.entry("workspaceId".to_string())
                                .or_insert_with(|| Value::String(ws.workspace_id.clone()));
                            obj.entry("workspaceName".to_string())
                                .or_insert_with(|| Value::String(ws.name.clone()));
                        }
                        aggregated_matches.push(entry);
                    }
                }
                per_workspace.push(json!({
                    "workspaceId": ws.workspace_id,
                    "workspaceName": ws.name,
                    "rootPath": ws.root_path,
                    "result": result,
                }));
            }
            Err(error) => {
                errors.push(json!({
                    "workspaceId": ws.workspace_id,
                    "workspaceName": ws.name,
                    "error": error.to_string(),
                }));
            }
        }
    }

    if let Some(limit) = limit {
        aggregated_matches.truncate(limit);
    }
    let mut out = json!({
        "searchedWorkspaces": per_workspace.len(),
        "matchCount": aggregated_matches.len(),
        "matches": aggregated_matches,
        "workspaces": per_workspace,
    });
    if !errors.is_empty() {
        out["errors"] = Value::Array(errors);
    }
    Ok(out)
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
        FleetControlRequest::Navigator {
            target,
            include_capabilities,
            max_sessions_per_workspace,
        } => {
            let nav = host.navigator().await?;
            let max_sessions =
                max_sessions_per_workspace.unwrap_or(DEFAULT_NAVIGATOR_SESSIONS_PER_WORKSPACE);
            let filter_all = target
                .as_deref()
                .map(str::trim)
                .is_none_or(|value| value.is_empty() || value.eq_ignore_ascii_case("all"));
            let devices: Vec<Value> = if filter_all {
                nav.devices
                    .iter()
                    .map(|device| {
                        project_device_for_agent(
                            device,
                            local_device_id.as_deref(),
                            include_capabilities,
                            max_sessions,
                        )
                    })
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
                    .map(|device| {
                        project_device_for_agent(
                            device,
                            local_device_id.as_deref(),
                            include_capabilities,
                            max_sessions,
                        )
                    })
                    .collect()
            };
            Ok(json!({
                "localDeviceId": local_device_id,
                "revision": nav.revision,
                "totals": nav.totals,
                "devices": devices,
            }))
        }
        FleetControlRequest::GitInspect {
            target,
            workspace_id,
            workspace_path,
            workspace_name,
            include_branches,
            include_diff,
            max_commits,
        } => {
            let nav = host.navigator().await?;
            let max_commits = max_commits.unwrap_or(3);
            let name_filter = workspace_name
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_ascii_lowercase);
            let wants_all = target
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| value.eq_ignore_ascii_case("all"));

            let target_devices: Vec<&FleetDevice> = if wants_all {
                nav.devices
                    .iter()
                    .filter(|d| d.host_kind != FleetHostKind::Cloud)
                    .collect()
            } else {
                let resolved = resolve_target_device(
                    &nav,
                    local_device_id.as_deref(),
                    target.as_deref(),
                    true,
                )?;
                nav.devices
                    .iter()
                    .filter(|d| d.device_id == resolved.device_id)
                    .collect()
            };

            let explicit_id = workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());
            let explicit_path = workspace_path
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());

            let per_device: Vec<Value> =
                futures::future::join_all(target_devices.into_iter().map(|device| {
                    let nav = &nav;
                    let local_device_id = local_device_id.as_deref();
                    let name_filter = name_filter.as_deref();
                    async move {
                        let current = is_local_device(device, local_device_id);
                        if !current && device.state != FleetDeviceState::Online {
                            return json!({
                                "deviceId": device.device_id,
                                "deviceName": device.name,
                                "isCurrentDevice": false,
                                "state": device.state,
                                "skipped": "device is offline",
                            });
                        }

                        let mut matched: Vec<(Option<String>, String, String)> = Vec::new();
                        if explicit_id.is_some() || explicit_path.is_some() {
                            let (res_id, res_path) = resolve_workspace_refs(
                                nav,
                                &device.device_id,
                                explicit_id.map(str::to_string),
                                explicit_path.map(str::to_string),
                                false,
                            );
                            if let Some(root) = res_path {
                                let ws_name = res_id
                                    .as_deref()
                                    .and_then(|id| {
                                        device
                                            .workspaces
                                            .iter()
                                            .find(|w| w.workspace_id == id)
                                            .map(|w| w.name.clone())
                                    })
                                    .unwrap_or_else(|| root.clone());
                                matched.push((res_id, ws_name, root));
                            }
                        } else {
                            for ws in &device.workspaces {
                                if ws.root_path.trim().is_empty() {
                                    continue;
                                }
                                if let Some(filter) = name_filter {
                                    let name_hit = ws.name.to_ascii_lowercase().contains(filter);
                                    let path_hit =
                                        ws.root_path.to_ascii_lowercase().contains(filter);
                                    if !name_hit && !path_hit {
                                        continue;
                                    }
                                } else if ws.kind == FleetWorkspaceKind::Assistant {
                                    continue;
                                }
                                matched.push((
                                    Some(ws.workspace_id.clone()),
                                    ws.name.clone(),
                                    ws.root_path.clone(),
                                ));
                            }
                        }

                        let omitted = matched
                            .len()
                            .saturating_sub(MAX_GIT_INSPECT_WORKSPACES_PER_DEVICE);
                        let selected: Vec<_> = matched
                            .into_iter()
                            .take(MAX_GIT_INSPECT_WORKSPACES_PER_DEVICE)
                            .collect();
                        let repositories: Vec<Value> = futures::future::join_all(
                            selected.iter().map(|(ws_id, ws_name, root)| {
                                inspect_workspace_git(
                                    host,
                                    &device.device_id,
                                    ws_id.as_deref(),
                                    ws_name,
                                    root,
                                    include_branches,
                                    include_diff,
                                    max_commits,
                                )
                            }),
                        )
                        .await;

                        let mut entry = json!({
                            "deviceId": device.device_id,
                            "deviceName": device.name,
                            "isCurrentDevice": current,
                            "state": device.state,
                            "repositoryCount": repositories.len(),
                            "repositories": repositories,
                        });
                        if omitted > 0 {
                            entry["omittedWorkspaceCount"] = Value::from(omitted);
                        }
                        entry
                    }
                }))
                .await;

            Ok(json!({
                "scope": if wants_all { "all" } else { "device" },
                "deviceCount": per_device.len(),
                "devices": per_device,
                "note": "ahead/behind counts reflect each device's local tracking refs; use feature.fleet:run-command with `git fetch` if you need live remote ref freshness.",
            }))
        }
        FleetControlRequest::RunCommand {
            target,
            command,
            workspace_id,
            workspace_path,
            cwd,
            timeout_ms,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let (resolved_ws_id, resolved_ws_path) = resolve_workspace_refs(
                &nav,
                &resolved.device_id,
                workspace_id,
                workspace_path,
                true,
            );
            let effective_cwd = match cwd.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                Some(raw_cwd) => Some(resolve_remote_workspace_path(
                    resolved_ws_path.as_deref(),
                    raw_cwd,
                )),
                None => resolved_ws_path.clone(),
            };
            let effective_timeout_ms = timeout_ms.unwrap_or(30_000);
            let started = Instant::now();

            // Prefer `execute_tool(ExecCommand)` (non-PTY pipe-backed stdout/exitCode).
            let mut try_terminal_fallback = resolved_ws_id.is_none() && resolved_ws_path.is_none();
            if !try_terminal_fallback {
                let mut tool_input = json!({
                    "cmd": command,
                    "tty": false,
                    "yield_time_ms": effective_timeout_ms,
                });
                if let Some(ref workdir) = effective_cwd {
                    tool_input["workdir"] = Value::String(workdir.clone());
                }
                let mut req = json!({
                    "toolName": "ExecCommand",
                    "input": tool_input,
                });
                if let Some(ref id) = resolved_ws_id {
                    req["workspaceId"] = Value::String(id.clone());
                }
                if let Some(ref path) = resolved_ws_path {
                    req["workspacePath"] = Value::String(path.clone());
                }

                match host
                    .fleet_call(
                        &resolved.device_id,
                        "execute_tool",
                        json!({ "request": req }),
                    )
                    .await
                {
                    Ok(exec_resp) => {
                        let success = exec_resp
                            .get("success")
                            .and_then(Value::as_bool)
                            .unwrap_or(true);
                        if !success {
                            let reason = exec_resp
                                .get("validation_error")
                                .or_else(|| exec_resp.get("validationError"))
                                .or_else(|| exec_resp.get("error"))
                                .and_then(Value::as_str)
                                .unwrap_or("ExecCommand execution failed");
                            bail!(
                                "run-command failed on '{}' ({}): {reason}",
                                resolved.name,
                                resolved.device_id
                            );
                        }
                        let payload = exec_resp.get("result").unwrap_or(&exec_resp);
                        let raw_output = payload
                            .get("output")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let truncated = raw_output.chars().count() > MAX_RUN_COMMAND_OUTPUT_CHARS;
                        let output = truncate_text(raw_output, MAX_RUN_COMMAND_OUTPUT_CHARS);
                        let exit_code = payload
                            .get("exit_code")
                            .or_else(|| payload.get("exitCode"))
                            .and_then(Value::as_i64);
                        let timed_out = exit_code.is_none()
                            && payload
                                .get("session_id")
                                .or_else(|| payload.get("sessionId"))
                                .is_some_and(|v| !v.is_null());
                        return Ok(json!({
                            "deviceId": resolved.device_id,
                            "deviceName": resolved.name,
                            "isCurrentDevice": resolved.is_current_device,
                            "workspaceId": resolved_ws_id,
                            "workspacePath": resolved_ws_path,
                            "cwd": effective_cwd,
                            "command": command,
                            "exitCode": exit_code,
                            "timedOut": timed_out,
                            "truncated": truncated,
                            "durationMs": exec_resp
                                .get("duration_ms")
                                .and_then(Value::as_u64)
                                .unwrap_or_else(|| started.elapsed().as_millis() as u64),
                            "transport": "execute_tool",
                            "output": output,
                        }));
                    }
                    Err(error) if is_unsupported_command_error(&error) => {
                        try_terminal_fallback = true;
                    }
                    Err(error) => return Err(error),
                }
            }

            // Fallback for older CLI peers without `execute_tool` or devices with no workspace.
            let mut create_req = json!({
                "name": "fleet-run-command",
                "source": "agent",
            });
            if let Some(ref id) = resolved_ws_id {
                create_req["workspaceId"] = Value::String(id.clone());
            }
            if let Some(ref workdir) = effective_cwd {
                create_req["workingDirectory"] = Value::String(workdir.clone());
            }
            let created = host
                .fleet_call(
                    &resolved.device_id,
                    "terminal_create",
                    json!({ "request": create_req }),
                )
                .await?;
            let terminal_id = created
                .get("id")
                .or_else(|| created.get("sessionId"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| anyhow!("terminal_create did not return a terminal id"))?;

            let exec_result = host
                .fleet_call(
                    &resolved.device_id,
                    "terminal_execute",
                    json!({
                        "request": {
                            "sessionId": terminal_id,
                            "command": command,
                            "timeoutMs": effective_timeout_ms,
                            "preventHistory": true,
                        }
                    }),
                )
                .await;

            // Always close the temporary terminal session.
            let _ = host
                .fleet_call(
                    &resolved.device_id,
                    "terminal_close",
                    json!({ "request": { "sessionId": terminal_id, "immediate": true } }),
                )
                .await;

            let exec_resp = exec_result?;
            let raw_output = exec_resp
                .get("output")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let truncated = raw_output.chars().count() > MAX_RUN_COMMAND_OUTPUT_CHARS;
            let output = truncate_text(raw_output, MAX_RUN_COMMAND_OUTPUT_CHARS);
            let exit_code = exec_resp
                .get("exitCode")
                .or_else(|| exec_resp.get("exit_code"))
                .and_then(Value::as_i64);
            let timed_out = exec_resp
                .get("completionReason")
                .and_then(Value::as_str)
                .is_some_and(|r| r.to_ascii_lowercase().contains("timeout"));

            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "workspaceId": resolved_ws_id,
                "workspacePath": resolved_ws_path,
                "cwd": effective_cwd,
                "command": command,
                "exitCode": exit_code,
                "timedOut": timed_out,
                "truncated": truncated,
                "durationMs": started.elapsed().as_millis() as u64,
                "transport": "terminal",
                "output": output,
            }))
        }
        FleetControlRequest::Terminal {
            target,
            action,
            terminal_id,
            workspace_id,
            workspace_path,
            cwd,
            name,
            command,
            data,
            signal,
            after_offset,
            max_chars,
            timeout_ms,
            immediate,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            match action {
                FleetTerminalAction::List => {
                    let (filter_ws_id, _) = resolve_workspace_refs(
                        &nav,
                        &resolved.device_id,
                        workspace_id,
                        workspace_path,
                        false,
                    );
                    let raw = host
                        .fleet_call(&resolved.device_id, "terminal_list", json!({}))
                        .await?;
                    let terminals: Vec<Value> = raw
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|entry| {
                            filter_ws_id.as_deref().is_none_or(|wanted| {
                                entry
                                    .get("workspaceId")
                                    .or_else(|| entry.get("workspace_id"))
                                    .and_then(Value::as_str)
                                    == Some(wanted)
                            })
                        })
                        .collect();
                    Ok(json!({
                        "deviceId": resolved.device_id,
                        "deviceName": resolved.name,
                        "isCurrentDevice": resolved.is_current_device,
                        "count": terminals.len(),
                        "terminals": terminals,
                    }))
                }
                FleetTerminalAction::Create => {
                    let (resolved_ws_id, resolved_ws_path) = resolve_workspace_refs(
                        &nav,
                        &resolved.device_id,
                        workspace_id,
                        workspace_path,
                        true,
                    );
                    let effective_cwd =
                        match cwd.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                            Some(raw_cwd) => Some(resolve_remote_workspace_path(
                                resolved_ws_path.as_deref(),
                                raw_cwd,
                            )),
                            None => resolved_ws_path.clone(),
                        };
                    let mut req = json!({
                        "name": name.unwrap_or_else(|| "fleet-terminal".to_string()),
                        "source": "agent",
                    });
                    if let Some(ref ws_id) = resolved_ws_id {
                        req["workspaceId"] = Value::String(ws_id.clone());
                    }
                    if let Some(ref workdir) = effective_cwd {
                        req["workingDirectory"] = Value::String(workdir.clone());
                    }
                    let terminal = host
                        .fleet_call(
                            &resolved.device_id,
                            "terminal_create",
                            json!({ "request": req }),
                        )
                        .await?;
                    let created_id = terminal
                        .get("id")
                        .or_else(|| terminal.get("sessionId"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    Ok(json!({
                        "deviceId": resolved.device_id,
                        "deviceName": resolved.name,
                        "isCurrentDevice": resolved.is_current_device,
                        "workspaceId": resolved_ws_id,
                        "terminalId": created_id,
                        "terminal": terminal,
                    }))
                }
                FleetTerminalAction::Execute => {
                    let tid = terminal_id
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| anyhow!("terminalId is required"))?;
                    let cmd = command
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| anyhow!("command is required"))?;
                    let exec_resp = host
                        .fleet_call(
                            &resolved.device_id,
                            "terminal_execute",
                            json!({
                                "request": {
                                    "sessionId": tid,
                                    "command": cmd,
                                    "timeoutMs": timeout_ms.unwrap_or(30_000),
                                    "preventHistory": true,
                                }
                            }),
                        )
                        .await?;
                    let raw_output = exec_resp
                        .get("output")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let limit = max_chars.unwrap_or(MAX_RUN_COMMAND_OUTPUT_CHARS);
                    let truncated = raw_output.chars().count() > limit;
                    let output = truncate_text(raw_output, limit);
                    let exit_code = exec_resp
                        .get("exitCode")
                        .or_else(|| exec_resp.get("exit_code"))
                        .and_then(Value::as_i64);
                    let timed_out = exec_resp
                        .get("completionReason")
                        .and_then(Value::as_str)
                        .is_some_and(|r| r.to_ascii_lowercase().contains("timeout"));
                    Ok(json!({
                        "deviceId": resolved.device_id,
                        "deviceName": resolved.name,
                        "isCurrentDevice": resolved.is_current_device,
                        "terminalId": tid,
                        "command": cmd,
                        "exitCode": exit_code,
                        "timedOut": timed_out,
                        "truncated": truncated,
                        "output": output,
                    }))
                }
                FleetTerminalAction::Write => {
                    let tid = terminal_id
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| anyhow!("terminalId is required"))?;
                    let raw = data.ok_or_else(|| anyhow!("data is required"))?;
                    let written_bytes = raw.len();
                    host.fleet_call(
                        &resolved.device_id,
                        "terminal_write",
                        json!({ "request": { "sessionId": tid, "data": raw } }),
                    )
                    .await?;
                    Ok(json!({
                        "deviceId": resolved.device_id,
                        "deviceName": resolved.name,
                        "isCurrentDevice": resolved.is_current_device,
                        "terminalId": tid,
                        "writtenBytes": written_bytes,
                    }))
                }
                FleetTerminalAction::Read => {
                    let tid = terminal_id
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| anyhow!("terminalId is required"))?;
                    // `terminal_get_history` takes top-level `sessionId` and `afterOffset`
                    // on Desktop and falls back to top-level on CLI Peer Host.
                    let history = host
                        .fleet_call(
                            &resolved.device_id,
                            "terminal_get_history",
                            json!({
                                "sessionId": tid,
                                "afterOffset": after_offset,
                            }),
                        )
                        .await?;
                    let raw_data = history
                        .get("data")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let (output, truncated_from_start) = tail_truncate_text(
                        raw_data,
                        max_chars.unwrap_or(MAX_RUN_COMMAND_OUTPUT_CHARS),
                    );
                    Ok(json!({
                        "deviceId": resolved.device_id,
                        "deviceName": resolved.name,
                        "isCurrentDevice": resolved.is_current_device,
                        "terminalId": tid,
                        "output": output,
                        "truncatedFromStart": truncated_from_start,
                        "historySize": history.get("historySize").or_else(|| history.get("history_size")).cloned().unwrap_or(Value::Null),
                        "nextOffset": history.get("nextOffset").or_else(|| history.get("next_offset")).cloned().unwrap_or(Value::Null),
                        "cursor": history.get("cursor").cloned().unwrap_or(Value::Null),
                        "cols": history.get("cols").cloned().unwrap_or(Value::Null),
                        "rows": history.get("rows").cloned().unwrap_or(Value::Null),
                    }))
                }
                FleetTerminalAction::Signal => {
                    let tid = terminal_id
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| anyhow!("terminalId is required"))?;
                    let sig = signal
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| anyhow!("signal is required"))?;
                    host.fleet_call(
                        &resolved.device_id,
                        "terminal_signal",
                        json!({ "request": { "sessionId": tid, "signal": sig } }),
                    )
                    .await?;
                    Ok(json!({
                        "deviceId": resolved.device_id,
                        "deviceName": resolved.name,
                        "isCurrentDevice": resolved.is_current_device,
                        "terminalId": tid,
                        "signal": sig,
                    }))
                }
                FleetTerminalAction::Close => {
                    let tid = terminal_id
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| anyhow!("terminalId is required"))?;
                    host.fleet_call(
                        &resolved.device_id,
                        "terminal_close",
                        json!({
                            "request": {
                                "sessionId": tid,
                                "immediate": immediate.unwrap_or(true),
                            }
                        }),
                    )
                    .await?;
                    Ok(json!({
                        "deviceId": resolved.device_id,
                        "deviceName": resolved.name,
                        "isCurrentDevice": resolved.is_current_device,
                        "terminalId": tid,
                        "closed": true,
                    }))
                }
            }
        }
        FleetControlRequest::ReadFile {
            target,
            path,
            workspace_id,
            workspace_path,
            start_line,
            end_line,
            max_chars,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let (resolved_ws_id, resolved_ws_path) = resolve_workspace_refs(
                &nav,
                &resolved.device_id,
                workspace_id,
                workspace_path,
                !is_remote_absolute_path(&path),
            );
            if !is_remote_absolute_path(&path) && resolved_ws_path.is_none() {
                bail!(
                    "Relative path '{}' requires workspaceId or workspacePath (or an opened workspace on '{}')",
                    path,
                    resolved.name
                );
            }
            let resolved_file_path =
                resolve_remote_workspace_path(resolved_ws_path.as_deref(), &path);
            let mut req = json!({ "filePath": resolved_file_path });
            if let Some(ref ws_id) = resolved_ws_id {
                req["workspaceId"] = Value::String(ws_id.clone());
            }
            let raw = host
                .fleet_call(
                    &resolved.device_id,
                    "read_file_content",
                    json!({ "request": req }),
                )
                .await?;
            let text = raw.as_str().ok_or_else(|| {
                anyhow!("Target device returned a non-string payload for read_file_content")
            })?;
            let lines: Vec<&str> = text.lines().collect();
            let total_lines = lines.len();
            let (slice_start, slice_end, sliced) = if start_line.is_some() || end_line.is_some() {
                let s = start_line.unwrap_or(1).max(1);
                let e = end_line.unwrap_or(total_lines).min(total_lines);
                if s > total_lines || total_lines == 0 {
                    (s, e, String::new())
                } else {
                    (s, e, lines[(s - 1)..e].join("\n"))
                }
            } else {
                (1, total_lines, text.to_string())
            };
            let max_chars = max_chars.unwrap_or(DEFAULT_READ_FILE_MAX_CHARS);
            let truncated = sliced.chars().count() > max_chars;
            let content = truncate_text(&sliced, max_chars);

            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "workspaceId": resolved_ws_id,
                "path": path,
                "resolvedPath": resolved_file_path,
                "totalLines": total_lines,
                "startLine": slice_start,
                "endLine": slice_end,
                "truncated": truncated,
                "content": content,
            }))
        }
        FleetControlRequest::WriteFile {
            target,
            path,
            content,
            workspace_id,
            workspace_path,
            expected_hash,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let (resolved_ws_id, resolved_ws_path) = resolve_workspace_refs(
                &nav,
                &resolved.device_id,
                workspace_id,
                workspace_path,
                !is_remote_absolute_path(&path),
            );
            if !is_remote_absolute_path(&path) && resolved_ws_path.is_none() {
                bail!(
                    "Relative path '{}' requires workspaceId or workspacePath (or an opened workspace on '{}')",
                    path,
                    resolved.name
                );
            }
            let resolved_file_path =
                resolve_remote_workspace_path(resolved_ws_path.as_deref(), &path);
            let sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
            let bytes_written = content.len();
            let mut req = json!({
                "filePath": resolved_file_path,
                "content": content,
            });
            if let Some(ref ws_id) = resolved_ws_id {
                req["workspaceId"] = Value::String(ws_id.clone());
            }
            if let Some(hash) = expected_hash
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                req["expectedHash"] = Value::String(hash.to_string());
            }
            host.fleet_call(
                &resolved.device_id,
                "write_file_content",
                json!({ "request": req }),
            )
            .await?;
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "workspaceId": resolved_ws_id,
                "path": path,
                "resolvedPath": resolved_file_path,
                "bytesWritten": bytes_written,
                "sha256": sha256,
            }))
        }
        FleetControlRequest::ManageFile {
            target,
            action,
            path,
            new_path,
            is_directory,
            recursive,
            workspace_id,
            workspace_path,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let (resolved_ws_id, resolved_ws_path) = resolve_workspace_refs(
                &nav,
                &resolved.device_id,
                workspace_id,
                workspace_path,
                !is_remote_absolute_path(&path),
            );
            if !is_remote_absolute_path(&path) && resolved_ws_path.is_none() {
                bail!(
                    "Relative path '{}' requires workspaceId or workspacePath (or an opened workspace on '{}')",
                    path,
                    resolved.name
                );
            }
            let resolved_path = resolve_remote_workspace_path(resolved_ws_path.as_deref(), &path);
            let mut req = json!({});
            if let Some(ref ws_id) = resolved_ws_id {
                req["workspaceId"] = Value::String(ws_id.clone());
            }
            let (command, resolved_new_path) = match action {
                FleetFileAction::Stat => {
                    req["path"] = Value::String(resolved_path.clone());
                    ("get_file_metadata", None)
                }
                FleetFileAction::Exists => {
                    req["path"] = Value::String(resolved_path.clone());
                    ("check_path_exists", None)
                }
                FleetFileAction::Mkdir => {
                    req["path"] = Value::String(resolved_path.clone());
                    ("create_directory", None)
                }
                FleetFileAction::Rename => {
                    let target_new = new_path
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                        .ok_or_else(|| anyhow!("newPath is required for manage-file rename"))?;
                    let resolved_new =
                        resolve_remote_workspace_path(resolved_ws_path.as_deref(), target_new);
                    req["oldPath"] = Value::String(resolved_path.clone());
                    req["newPath"] = Value::String(resolved_new.clone());
                    ("rename_file", Some(resolved_new))
                }
                FleetFileAction::Delete => {
                    req["path"] = Value::String(resolved_path.clone());
                    if is_directory {
                        req["recursive"] = Value::Bool(recursive);
                        ("delete_directory", None)
                    } else {
                        ("delete_file", None)
                    }
                }
            };
            let result = host
                .fleet_call(&resolved.device_id, command, json!({ "request": req }))
                .await?;
            let mut out = json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "workspaceId": resolved_ws_id,
                "command": command,
                "path": path,
                "resolvedPath": resolved_path,
                "result": result,
            });
            if let Some(new_resolved) = resolved_new_path {
                out["resolvedNewPath"] = Value::String(new_resolved);
            }
            Ok(out)
        }
        FleetControlRequest::ListFiles {
            target,
            workspace_id,
            workspace_path,
            path,
            offset,
            limit,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let path_is_abs = path.as_deref().is_some_and(is_remote_absolute_path);
            let (resolved_ws_id, resolved_ws_path) = resolve_workspace_refs(
                &nav,
                &resolved.device_id,
                workspace_id,
                workspace_path,
                !path_is_abs,
            );
            let resolved_dir = match path.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                Some(subpath) => {
                    if !is_remote_absolute_path(subpath) && resolved_ws_path.is_none() {
                        bail!(
                            "Relative directory '{}' requires workspaceId or workspacePath on '{}'",
                            subpath,
                            resolved.name
                        );
                    }
                    resolve_remote_workspace_path(resolved_ws_path.as_deref(), subpath)
                }
                None => resolved_ws_path.clone().ok_or_else(|| {
                    anyhow!(
                        "list-files requires path, workspaceId, or workspacePath (no opened workspace found on '{}')",
                        resolved.name
                    )
                })?,
            };
            let mut req = json!({
                "path": resolved_dir,
                "offset": offset.unwrap_or(0),
                "limit": limit.unwrap_or(100),
            });
            if let Some(ref ws_id) = resolved_ws_id {
                req["workspaceId"] = Value::String(ws_id.clone());
            }
            let page = host
                .fleet_call(
                    &resolved.device_id,
                    "get_directory_children_paginated",
                    json!({ "request": req }),
                )
                .await?;
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "workspaceId": resolved_ws_id,
                "path": resolved_dir,
                "page": page,
            }))
        }
        FleetControlRequest::SearchFiles {
            target,
            pattern,
            workspace_id,
            workspace_path,
            search_content,
            case_sensitive,
            use_regex,
            max_results,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let (resolved_ws_id, resolved_ws_path) = resolve_workspace_refs(
                &nav,
                &resolved.device_id,
                workspace_id,
                workspace_path,
                true,
            );
            let root_path = resolved_ws_path.clone().ok_or_else(|| {
                anyhow!(
                    "search-files requires workspaceId or workspacePath (no opened workspace found on '{}')",
                    resolved.name
                )
            })?;
            let mut req = json!({
                "rootPath": root_path,
                "pattern": pattern,
                "searchContent": search_content,
                "caseSensitive": case_sensitive,
                "useRegex": use_regex,
                "maxResults": max_results.unwrap_or(50),
            });
            if let Some(ref ws_id) = resolved_ws_id {
                req["workspaceId"] = Value::String(ws_id.clone());
            }
            let command = if search_content {
                "search_file_contents"
            } else {
                "search_files"
            };
            let results = host
                .fleet_call(&resolved.device_id, command, json!({ "request": req }))
                .await?;
            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "workspaceId": resolved_ws_id,
                "rootPath": root_path,
                "pattern": pattern,
                "searchContent": search_content,
                "results": results,
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
            let (resolved_ws_id, resolved_ws_path) = resolve_workspace_refs(
                &nav,
                &resolved.device_id,
                workspace_id,
                workspace_path,
                false,
            );
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
            message,
            wait_seconds,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let (resolved_ws_id, resolved_ws_path_opt) = resolve_workspace_refs(
                &nav,
                &resolved.device_id,
                workspace_id,
                workspace_path,
                false,
            );
            let resolved_ws_path = resolved_ws_path_opt.clone().unwrap_or_default();
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
            let resolved_model = resolve_effective_fleet_model(
                host,
                local_device_id.as_deref(),
                &resolved.device_id,
                resolved.is_current_device,
                model_name.as_deref(),
                true,
            )
            .await;
            if let Some((ref model_ref, _)) = resolved_model {
                req["config"] = json!({ "modelName": model_ref });
            }
            let created = host
                .fleet_call(
                    &resolved.device_id,
                    "create_session",
                    json!({ "request": req }),
                )
                .await?;

            let mut out = json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "workspaceId": resolved_ws_id,
                "workspacePath": resolved_ws_path_opt,
                "session": created,
            });
            if let Some((ref model_ref, source)) = resolved_model {
                out["resolvedModel"] = json!({
                    "modelRef": model_ref,
                    "source": source,
                });
            }

            if let Some(initial_message) = message {
                let created_session_id = created
                    .get("sessionId")
                    .or_else(|| created.get("session_id"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| {
                        anyhow!("create_session succeeded but did not return sessionId for initial message")
                    })?;
                let (turn_id, used_agent, turn_response) = start_session_turn(
                    host,
                    &nav,
                    &resolved,
                    &created_session_id,
                    &initial_message,
                    resolved_ws_id.clone(),
                    resolved_ws_path_opt.clone(),
                    Some(canonical_agent),
                    resolved_model.as_ref().map(|(m, _)| m.clone()),
                )
                .await?;
                out["sessionId"] = Value::String(created_session_id.clone());
                out["turnId"] = Value::String(turn_id.clone());
                out["agentType"] = Value::String(used_agent);
                out["turnResponse"] = turn_response;

                if let Some(secs) = wait_seconds {
                    let watch = vec![FleetSessionTargetRef {
                        target: Some(format!("device:{}", resolved.device_id)),
                        session_id: created_session_id,
                        workspace_id: resolved_ws_id,
                        workspace_path: resolved_ws_path_opt,
                    }];
                    let waited = wait_for_sessions(
                        host,
                        &nav,
                        local_device_id.as_deref(),
                        &watch,
                        Some(&turn_id),
                        FleetWaitUntil::AllDone,
                        secs,
                        4,
                    )
                    .await?;
                    out["wait"] = waited;
                } else {
                    out["nextStep"] = Value::String(
                        "Call feature.fleet:wait-session (instead of shell sleep) to wait for this session or multiple device sessions to finish or pause on a prompt."
                            .to_string(),
                    );
                }
            }

            Ok(out)
        }
        FleetControlRequest::SendMessage {
            target,
            session_id,
            message,
            workspace_id,
            workspace_path,
            agent_type,
            model_id,
            wait_seconds,
        } => {
            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let resolved_model = resolve_effective_fleet_model(
                host,
                local_device_id.as_deref(),
                &resolved.device_id,
                resolved.is_current_device,
                model_id.as_deref(),
                false,
            )
            .await;
            let (turn_id, resolved_agent, response) = start_session_turn(
                host,
                &nav,
                &resolved,
                &session_id,
                &message,
                workspace_id.clone(),
                workspace_path.clone(),
                agent_type,
                resolved_model.as_ref().map(|(m, _)| m.clone()),
            )
            .await?;

            let mut out = json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "sessionId": session_id,
                "turnId": turn_id,
                "agentType": resolved_agent,
                "response": response,
            });
            if let Some((ref model_ref, source)) = resolved_model {
                out["resolvedModel"] = json!({
                    "modelRef": model_ref,
                    "source": source,
                });
            }
            if let Some(secs) = wait_seconds {
                let watch = vec![FleetSessionTargetRef {
                    target: Some(format!("device:{}", resolved.device_id)),
                    session_id,
                    workspace_id,
                    workspace_path,
                }];
                let waited = wait_for_sessions(
                    host,
                    &nav,
                    local_device_id.as_deref(),
                    &watch,
                    Some(&turn_id),
                    FleetWaitUntil::AllDone,
                    secs,
                    4,
                )
                .await?;
                out["wait"] = waited;
            } else {
                out["nextStep"] = Value::String(
                    "Call feature.fleet:wait-session (instead of shell sleep) to wait for this session or multiple device sessions to finish, or feature.fleet:list-prompts if a prompt needs approval."
                        .to_string(),
                );
            }
            Ok(out)
        }
        FleetControlRequest::WaitSession {
            target,
            session_id,
            workspace_id,
            workspace_path,
            mut sessions,
            until,
            timeout_seconds,
            tail_turn_count,
        } => {
            if let Some(sid) = session_id.filter(|v| !v.trim().is_empty()) {
                sessions.insert(
                    0,
                    FleetSessionTargetRef {
                        target,
                        session_id: sid,
                        workspace_id,
                        workspace_path,
                    },
                );
            }
            let nav = host.navigator().await?;
            wait_for_sessions(
                host,
                &nav,
                local_device_id.as_deref(),
                &sessions,
                None,
                until,
                timeout_seconds.unwrap_or(DEFAULT_FLEET_WAIT_SECONDS),
                tail_turn_count.unwrap_or(4),
            )
            .await
        }
        FleetControlRequest::ReadSession {
            target,
            session_id,
            workspace_id,
            workspace_path,
            tail_turn_count,
        } => {
            let nav = host.navigator().await?;
            let polled = poll_session_view(
                host,
                &nav,
                local_device_id.as_deref(),
                target.as_deref(),
                &session_id,
                workspace_id,
                workspace_path,
                tail_turn_count.unwrap_or(4),
                None,
            )
            .await?;
            Ok(polled.summary_json)
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
            workspace_path,
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
            let (resolved_ws_id, resolved_ws_path) = resolve_workspace_refs(
                &nav,
                &resolved.device_id,
                workspace_id,
                workspace_path,
                !is_remote_absolute_path(&remote_path),
            );
            let resolved_remote_path =
                resolve_remote_workspace_path(resolved_ws_path.as_deref(), &remote_path);
            let mut req = json!({
                "filePath": resolved_remote_path,
                "encoding": "base64",
            });
            if let Some(ref ws_id) = resolved_ws_id {
                req["workspaceId"] = Value::String(ws_id.clone());
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
                "workspaceId": resolved_ws_id,
                "remotePath": remote_path,
                "resolvedRemotePath": resolved_remote_path,
                "localPath": dest.to_string_lossy(),
                "size": bytes.len() as u64,
                "sha256": sha256,
            }))
        }
        FleetControlRequest::PushFile {
            target,
            local_path,
            remote_path,
            workspace_id,
            workspace_path,
            expected_hash,
            max_bytes,
        } => {
            let src = Path::new(local_path.trim());
            if !src.is_absolute() {
                bail!("localPath must be an absolute file path on this host");
            }
            let metadata = std::fs::metadata(src)
                .with_context(|| format!("inspect local source file {}", src.display()))?;
            if metadata.is_dir() {
                bail!(
                    "localPath ({}) is a directory; pass a file path",
                    src.display()
                );
            }
            let max_bytes = max_bytes
                .unwrap_or(DEFAULT_FLEET_PULL_FILE_MAX_BYTES)
                .min(HARD_MAX_FLEET_PULL_FILE_BYTES);
            if metadata.len() > max_bytes {
                bail!(
                    "Source file ({} bytes) exceeds maxBytes ({max_bytes} bytes)",
                    metadata.len()
                );
            }
            let bytes = std::fs::read(src)
                .with_context(|| format!("read local source file {}", src.display()))?;
            let total_bytes = bytes.len() as u64;
            let sha256 = format!("{:x}", Sha256::digest(&bytes));

            let nav = host.navigator().await?;
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let (resolved_ws_id, resolved_ws_path) = resolve_workspace_refs(
                &nav,
                &resolved.device_id,
                workspace_id,
                workspace_path,
                !is_remote_absolute_path(&remote_path),
            );
            if !is_remote_absolute_path(&remote_path) && resolved_ws_path.is_none() {
                bail!(
                    "Relative remotePath '{}' requires workspaceId or workspacePath (or an opened workspace on '{}')",
                    remote_path,
                    resolved.name
                );
            }
            let resolved_remote_path =
                resolve_remote_workspace_path(resolved_ws_path.as_deref(), &remote_path);

            let transfer_id = uuid::Uuid::new_v4().to_string();
            let mut begin_req = json!({
                "action": "begin",
                "transferId": transfer_id,
                "path": resolved_remote_path,
                "totalBytes": total_bytes,
                "sha256": sha256,
            });
            if let Some(ref ws_id) = resolved_ws_id {
                begin_req["workspaceId"] = Value::String(ws_id.clone());
            }
            if let Some(ref ws_path) = resolved_ws_path {
                begin_req["workspacePath"] = Value::String(ws_path.clone());
            }
            if let Some(hash) = expected_hash
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                begin_req["expectedHash"] = Value::String(hash.to_string());
            }

            let transport = match host
                .fleet_call(
                    &resolved.device_id,
                    "workspace_file_upload",
                    json!({ "request": begin_req }),
                )
                .await
            {
                Ok(_) => {
                    let mut offset = 0u64;
                    let mut upload_err: Option<anyhow::Error> = None;
                    for chunk in bytes.chunks(PUSH_FILE_CHUNK_BYTES) {
                        let mut append_req = json!({
                            "action": "append",
                            "transferId": transfer_id,
                            "path": resolved_remote_path,
                            "offset": offset,
                            "contentBase64": base64::engine::general_purpose::STANDARD.encode(chunk),
                        });
                        if let Some(ref ws_id) = resolved_ws_id {
                            append_req["workspaceId"] = Value::String(ws_id.clone());
                        }
                        if let Some(ref ws_path) = resolved_ws_path {
                            append_req["workspacePath"] = Value::String(ws_path.clone());
                        }
                        if let Err(err) = host
                            .fleet_call(
                                &resolved.device_id,
                                "workspace_file_upload",
                                json!({ "request": append_req }),
                            )
                            .await
                        {
                            upload_err = Some(err);
                            break;
                        }
                        offset += chunk.len() as u64;
                    }
                    if let Some(err) = upload_err {
                        let mut cancel_req = json!({
                            "action": "cancel",
                            "transferId": transfer_id,
                            "path": resolved_remote_path,
                        });
                        if let Some(ref ws_id) = resolved_ws_id {
                            cancel_req["workspaceId"] = Value::String(ws_id.clone());
                        }
                        let _ = host
                            .fleet_call(
                                &resolved.device_id,
                                "workspace_file_upload",
                                json!({ "request": cancel_req }),
                            )
                            .await;
                        return Err(err);
                    }
                    let mut finish_req = json!({
                        "action": "finish",
                        "transferId": transfer_id,
                        "path": resolved_remote_path,
                    });
                    if let Some(ref ws_id) = resolved_ws_id {
                        finish_req["workspaceId"] = Value::String(ws_id.clone());
                    }
                    if let Some(ref ws_path) = resolved_ws_path {
                        finish_req["workspacePath"] = Value::String(ws_path.clone());
                    }
                    host.fleet_call(
                        &resolved.device_id,
                        "workspace_file_upload",
                        json!({ "request": finish_req }),
                    )
                    .await?;
                    "workspace_file_upload"
                }
                Err(error) => {
                    let lower = error.to_string().to_ascii_lowercase();
                    let can_fallback = (is_unsupported_command_error(&error)
                        || lower.contains("sign in"))
                        && bytes.len() <= MAX_FLEET_WRITE_FILE_BYTES;
                    if can_fallback {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            let mut write_req = json!({
                                "filePath": resolved_remote_path,
                                "content": text,
                            });
                            if let Some(ref ws_id) = resolved_ws_id {
                                write_req["workspaceId"] = Value::String(ws_id.clone());
                            }
                            if let Some(hash) = expected_hash
                                .as_deref()
                                .map(str::trim)
                                .filter(|v| !v.is_empty())
                            {
                                write_req["expectedHash"] = Value::String(hash.to_string());
                            }
                            host.fleet_call(
                                &resolved.device_id,
                                "write_file_content",
                                json!({ "request": write_req }),
                            )
                            .await?;
                            "write_file_content"
                        } else {
                            return Err(error);
                        }
                    } else {
                        return Err(error);
                    }
                }
            };

            Ok(json!({
                "deviceId": resolved.device_id,
                "deviceName": resolved.name,
                "isCurrentDevice": resolved.is_current_device,
                "workspaceId": resolved_ws_id,
                "localPath": src.to_string_lossy(),
                "remotePath": remote_path,
                "resolvedRemotePath": resolved_remote_path,
                "size": total_bytes,
                "sha256": sha256,
                "transport": transport,
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
            let wants_all = target
                .as_deref()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("all"));
            if wants_all {
                let candidates: Vec<&FleetDevice> = nav
                    .devices
                    .iter()
                    .filter(|d| d.host_kind != FleetHostKind::Cloud)
                    .collect();
                let per_device: Vec<Value> =
                    futures::future::join_all(candidates.into_iter().map(|device| {
                        let nav = &nav;
                        let local_device_id = local_device_id.as_deref();
                        let query = query.as_str();
                        let workspace_id = workspace_id.as_deref();
                        let workspace_path = workspace_path.as_deref();
                        async move {
                            let current = is_local_device(device, local_device_id);
                            if !current && device.state != FleetDeviceState::Online {
                                return json!({
                                    "deviceId": device.device_id,
                                    "deviceName": device.name,
                                    "isCurrentDevice": false,
                                    "state": device.state,
                                    "skipped": "device is offline",
                                });
                            }
                            match search_sessions_on_device(
                                host,
                                nav,
                                device,
                                query,
                                workspace_id,
                                workspace_path,
                                limit,
                            )
                            .await
                            {
                                Ok(results) => json!({
                                    "deviceId": device.device_id,
                                    "deviceName": device.name,
                                    "isCurrentDevice": current,
                                    "results": results,
                                }),
                                Err(error) => json!({
                                    "deviceId": device.device_id,
                                    "deviceName": device.name,
                                    "isCurrentDevice": current,
                                    "error": error.to_string(),
                                }),
                            }
                        }
                    }))
                    .await;
                return Ok(json!({
                    "query": query,
                    "deviceCount": per_device.len(),
                    "devices": per_device,
                }));
            }
            let resolved =
                resolve_target_device(&nav, local_device_id.as_deref(), target.as_deref(), true)?;
            let device = nav
                .devices
                .iter()
                .find(|d| d.device_id == resolved.device_id)
                .ok_or_else(|| {
                    anyhow!(
                        "Resolved device '{}' missing from navigator",
                        resolved.device_id
                    )
                })?;
            let results = search_sessions_on_device(
                host,
                &nav,
                device,
                &query,
                workspace_id.as_deref(),
                workspace_path.as_deref(),
                limit,
            )
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
        FleetDeviceRoute, FleetPrompt, FleetPromptKind, FleetSession, FleetTotals,
    };
    use openbitfun_services_core::session::types::{
        DialogTurnData, ModelRoundData, TextItemData, ToolCallData, ToolItemData, ToolResultData,
        TurnStatus, UserMessageData,
    };
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    struct FakeFleetHost {
        local_id: String,
        nav: FleetNavigator,
        prompts: FleetPromptsResponse,
        calls: Mutex<Vec<(String, String, Value)>>,
        dispatch_answers: Mutex<Vec<(String, Value)>>,
        fail_execute_tool_unsupported: AtomicBool,
        restore_polls: AtomicUsize,
        complete_after_polls: usize,
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
        async fn models(&self, device_id: Option<&str>) -> anyhow::Result<FleetModels> {
            use openbitfun_product_domains::fleet::{
                device_model_ref, FleetModel, FleetModelsDevice,
            };
            let perspective = device_id.unwrap_or(&self.local_id);
            let mac_is_this = perspective == "mac-local";
            let win_is_this = perspective == "win-peer";
            Ok(FleetModels {
                revision: 3,
                devices: vec![
                    FleetModelsDevice {
                        device_id: "mac-local".into(),
                        name: "My MacBook".into(),
                        host_kind: FleetHostKind::Desktop,
                        state: FleetDeviceState::Online,
                        online: true,
                        is_this_device: mac_is_this,
                        unavailable_reason: None,
                        models: vec![
                            FleetModelChoice {
                                model: FleetModel {
                                    model_id: "claude-sonnet-cfg".into(),
                                    display_name: "Claude Sonnet".into(),
                                    provider: "anthropic".into(),
                                    model_name: "claude-sonnet-4".into(),
                                    primary: true,
                                    label: "claude-sonnet-4".into(),
                                    detail: "Anthropic".into(),
                                    ..Default::default()
                                },
                                model_ref: if mac_is_this {
                                    "claude-sonnet-cfg".into()
                                } else {
                                    device_model_ref("mac-local", "claude-sonnet-cfg")
                                },
                                selectable: true,
                            },
                            FleetModelChoice {
                                model: FleetModel {
                                    model_id: "gpt-5-cfg".into(),
                                    display_name: "GPT-5".into(),
                                    provider: "openai".into(),
                                    model_name: "gpt-5".into(),
                                    primary: false,
                                    label: "gpt-5".into(),
                                    detail: "OpenAI".into(),
                                    ..Default::default()
                                },
                                model_ref: if mac_is_this {
                                    "gpt-5-cfg".into()
                                } else {
                                    device_model_ref("mac-local", "gpt-5-cfg")
                                },
                                selectable: true,
                            },
                        ],
                    },
                    FleetModelsDevice {
                        device_id: "win-peer".into(),
                        name: "Win Desktop".into(),
                        host_kind: FleetHostKind::Desktop,
                        state: FleetDeviceState::Online,
                        online: true,
                        is_this_device: win_is_this,
                        unavailable_reason: None,
                        models: vec![],
                    },
                ],
            })
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
                args.clone(),
            ));
            match command {
                "create_session" => Ok(json!({ "sessionId": "new-sess-1" })),
                "start_dialog_turn" => Ok(json!({ "success": true })),
                "restore_session_view" => {
                    let poll_num = self.restore_polls.fetch_add(1, Ordering::SeqCst) + 1;
                    let completed = poll_num >= self.complete_after_polls;
                    let turn_id = self
                        .calls
                        .lock()
                        .unwrap()
                        .iter()
                        .rev()
                        .find(|(_, cmd, _)| cmd == "start_dialog_turn")
                        .and_then(|(_, _, a)| a.pointer("/request/turnId").and_then(Value::as_str))
                        .unwrap_or("t1")
                        .to_string();

                    let real_turn = DialogTurnData {
                        turn_id: turn_id.clone(),
                        turn_index: 0,
                        session_id: "sess-mac".into(),
                        timestamp: 1_700_000_000,
                        kind: Default::default(),
                        agent_type: Some("Standard".into()),
                        user_message: UserMessageData {
                            id: "u1".into(),
                            content: "build mac binary".into(),
                            timestamp: 1_700_000_000,
                            metadata: None,
                        },
                        published_figures: Default::default(),
                        model_rounds: vec![ModelRoundData {
                            id: "r1".into(),
                            turn_id: turn_id.clone(),
                            round_index: 0,
                            round_group_id: None,
                            timestamp: 1_700_000_001,
                            text_items: vec![TextItemData {
                                id: "txt1".into(),
                                content: "Done: target/release/app".into(),
                                is_streaming: !completed,
                                timestamp: 1_700_000_002,
                                is_markdown: true,
                                order_index: Some(0),
                                is_subagent_item: None,
                                parent_task_tool_id: None,
                                subagent_session_id: None,
                                status: Some(
                                    if completed { "completed" } else { "streaming" }.into(),
                                ),
                                attempt_id: None,
                                attempt_index: None,
                            }],
                            tool_items: vec![ToolItemData {
                                id: "tool1".into(),
                                tool_name: "ExecCommand".into(),
                                tool_call: ToolCallData {
                                    input: json!({ "cmd": "cargo build --release" }),
                                    id: "tc1".into(),
                                },
                                tool_result: Some(ToolResultData {
                                    result: json!({ "exit_code": 0 }),
                                    success: true,
                                    result_for_assistant: Some("Finished release target".into()),
                                    image_attachments: None,
                                    error: None,
                                    duration_ms: Some(1200),
                                }),
                                ai_intent: Some("Build release binary".into()),
                                start_time: 1_700_000_001,
                                end_time: Some(1_700_000_002),
                                duration_ms: Some(1200),
                                queue_wait_ms: None,
                                preflight_ms: None,
                                confirmation_wait_ms: None,
                                execution_ms: None,
                                order_index: Some(1),
                                is_subagent_item: None,
                                parent_task_tool_id: None,
                                subagent_session_id: None,
                                subagent_dialog_turn_id: None,
                                attempt_id: None,
                                attempt_index: None,
                                subagent_model_id: None,
                                subagent_model_display_name: None,
                                status: Some("completed".into()),
                                interruption_reason: None,
                            }],
                            thinking_items: Vec::new(),
                            start_time: 1_700_000_001,
                            end_time: completed.then_some(1_700_000_003),
                            duration_ms: Some(2000),
                            provider_id: None,
                            model_config_id: None,
                            effective_model_name: None,
                            routing: None,
                            first_chunk_ms: None,
                            first_visible_output_ms: None,
                            stream_duration_ms: None,
                            ttft_ms: None,
                            attempt_count: None,
                            attempt_diagnostics: Vec::new(),
                            failure_category: None,
                            token_details: None,
                            status: if completed {
                                "completed"
                            } else {
                                "in_progress"
                            }
                            .into(),
                        }],
                        start_time: 1_700_000_000,
                        end_time: completed.then_some(1_700_000_003),
                        duration_ms: Some(3000),
                        token_usage: None,
                        finish_reason: None,
                        has_final_response: Some(completed),
                        error: None,
                        error_detail: None,
                        recovery: None,
                        recovery_epoch: None,
                        status: if completed {
                            TurnStatus::Completed
                        } else {
                            TurnStatus::InProgress
                        },
                    };

                    Ok(json!({
                        "session": {
                            "sessionId": "sess-mac",
                            "sessionName": "Mac Build",
                            "state": if completed { "Idle" } else { "Processing" },
                        },
                        "totalTurnCount": 1,
                        "turns": [serde_json::to_value(real_turn).unwrap()],
                        "interactionSnapshot": {
                            "sessionId": "sess-mac",
                            "permissions": { "requests": [] },
                            "userQuestions": { "questions": [] }
                        }
                    }))
                }
                "read_file_content" => {
                    if args.pointer("/request/encoding").and_then(Value::as_str) == Some("base64") {
                        Ok(Value::String(
                            base64::engine::general_purpose::STANDARD.encode(b"MZ-win-binary"),
                        ))
                    } else {
                        Ok(Value::String("line1\nline2\nline3\n".to_string()))
                    }
                }
                "git_get_repository" => Ok(json!({
                    "path": args.pointer("/request/repositoryPath").cloned().unwrap_or(Value::Null),
                    "name": "OpenBitFun",
                    "current_branch": if target_device_id == "mac-local" { "openbitfun-rs" } else { "main" },
                    "is_bare": false,
                    "has_changes": target_device_id == "win-peer",
                    "remotes": ["origin", "upstream"]
                })),
                "git_get_status" => Ok(json!({
                    "staged": [],
                    "unstaged": if target_device_id == "win-peer" {
                        vec![json!({ "path": "Cargo.toml", "status": "modified" })]
                    } else {
                        vec![]
                    },
                    "untracked": [],
                    "conflicts": [],
                    "current_branch": if target_device_id == "mac-local" { "openbitfun-rs" } else { "main" },
                    "ahead": if target_device_id == "mac-local" { 1 } else { 0 },
                    "behind": if target_device_id == "win-peer" { 3 } else { 0 }
                })),
                "git_get_commits" => Ok(json!([{
                    "hash": "abc1234567890",
                    "short_hash": "abc1234",
                    "message": "feat: fleet direct ops",
                    "author": "dev",
                    "author_email": "dev@example.com",
                    "date": "2026-11-28T23:00:00Z",
                    "parents": []
                }])),
                "execute_tool" => {
                    if self.fail_execute_tool_unsupported.load(Ordering::SeqCst) {
                        bail!("Unknown command: execute_tool");
                    }
                    Ok(json!({
                        "tool_name": "ExecCommand",
                        "success": true,
                        "duration_ms": 42,
                        "result": {
                            "wall_time_seconds": 0.04,
                            "output": "ok-from-exec\n",
                            "session_id": null,
                            "exit_code": 0,
                            "completion": { "source": "process", "status": "exited" }
                        }
                    }))
                }
                "terminal_list" => Ok(json!([{
                    "id": "term-existing-1",
                    "name": "dev-server",
                    "workspaceId": "ws-win",
                    "cwd": "C:/dev/OpenBitFun",
                    "shellType": "PowerShell",
                    "status": "Active"
                }])),
                "terminal_create" => {
                    Ok(json!({ "id": "term-fallback-1", "name": "fleet-terminal" }))
                }
                "terminal_execute" => Ok(json!({
                    "command": "git status -sb",
                    "commandId": "cmd-1",
                    "output": "## main...origin/main\n",
                    "exitCode": 0,
                    "completionReason": "Completed"
                })),
                "terminal_write" | "terminal_signal" | "terminal_close" => Ok(Value::Null),
                "terminal_get_history" => Ok(json!({
                    "sessionId": args.get("sessionId").cloned().unwrap_or(Value::Null),
                    "data": "0123456789READY\n",
                    "historySize": 16,
                    "nextOffset": 16,
                    "cursor": 16,
                    "truncated": false,
                    "cols": 120,
                    "rows": 30
                })),
                "write_file_content" | "create_directory" | "rename_file" | "delete_file"
                | "delete_directory" => Ok(Value::Null),
                "check_path_exists" => Ok(Value::Bool(true)),
                "get_file_metadata" => Ok(json!({ "size": 128, "isDirectory": false })),
                "workspace_file_upload" => Ok(json!({ "completed": true })),
                "get_directory_children_paginated" => Ok(json!({
                    "children": [{ "name": "Cargo.toml", "path": "C:/dev/OpenBitFun/Cargo.toml", "isDirectory": false }],
                    "total": 1,
                    "hasMore": false,
                    "offset": 0,
                    "limit": 100
                })),
                "search_file_contents" | "search_files" => Ok(json!({
                    "results": [{ "path": "src/main.rs", "lineNumber": 12, "matchedContent": "fn main()" }],
                    "limit": 50,
                    "truncated": false
                })),
                "search_session_content" => Ok(json!([{
                    "sessionId": "sess-hit-1",
                    "title": "OOM investigation"
                }])),
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
        let mut local_sessions = Vec::new();
        for idx in 0..5 {
            local_sessions.push(FleetSession {
                device_id: "mac-local".into(),
                workspace_id: "ws-mac".into(),
                session_id: if idx == 0 {
                    "sess-mac".into()
                } else {
                    format!("sess-mac-{idx}")
                },
                title: format!("Mac Build {idx}"),
                agent_type: "Standard".into(),
                ..Default::default()
            });
        }
        let local = FleetDevice {
            device_id: "mac-local".into(),
            name: "My MacBook".into(),
            host_kind: FleetHostKind::Desktop,
            is_client_device: true,
            state: FleetDeviceState::Online,
            host_capabilities: (0..25).map(|i| format!("cap.v{i}")).collect(),
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
                sessions: local_sessions,
                session_total: 5,
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
            host_capabilities: vec!["cap.win".into()],
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
            fail_execute_tool_unsupported: AtomicBool::new(false),
            restore_polls: AtomicUsize::new(0),
            complete_after_polls: 1,
        }
    }

    #[tokio::test]
    async fn navigator_is_compact_by_default_and_caps_sessions() {
        let host = sample_host();
        let compact = execute_fleet_control(
            &host,
            FleetControlRequest::Navigator {
                target: None,
                include_capabilities: false,
                max_sessions_per_workspace: None,
            },
        )
        .await
        .unwrap();
        let mac = &compact["devices"][0];
        assert!(mac.get("hostCapabilities").is_none());
        assert_eq!(mac["capabilityCount"], 25);
        assert_eq!(
            mac["workspaces"][0]["recentSessions"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(mac["workspaces"][0]["hasMoreSessions"], true);

        let full = execute_fleet_control(
            &host,
            FleetControlRequest::Navigator {
                target: Some("self".into()),
                include_capabilities: true,
                max_sessions_per_workspace: Some(5),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            full["devices"][0]["hostCapabilities"]
                .as_array()
                .unwrap()
                .len(),
            25
        );
        assert_eq!(
            full["devices"][0]["workspaces"][0]["recentSessions"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
    }

    #[tokio::test]
    async fn git_inspect_fans_out_across_all_devices_and_skips_offline_loudly() {
        let host = sample_host();
        let git = execute_fleet_control(
            &host,
            FleetControlRequest::GitInspect {
                target: Some("all".into()),
                workspace_id: None,
                workspace_path: None,
                workspace_name: Some("openbitfun".into()),
                include_branches: false,
                include_diff: false,
                max_commits: Some(2),
            },
        )
        .await
        .unwrap();
        assert_eq!(git["deviceCount"], 3);
        let devices = git["devices"].as_array().unwrap();
        let mac = devices
            .iter()
            .find(|d| d["deviceId"] == "mac-local")
            .unwrap();
        assert_eq!(mac["repositories"][0]["currentBranch"], "openbitfun-rs");
        assert_eq!(mac["repositories"][0]["ahead"], 1);
        assert_eq!(mac["repositories"][0]["isClean"], true);
        assert_eq!(mac["repositories"][0]["commits"][0]["shortHash"], "abc1234");

        let win = devices
            .iter()
            .find(|d| d["deviceId"] == "win-peer")
            .unwrap();
        assert_eq!(win["repositories"][0]["currentBranch"], "main");
        assert_eq!(win["repositories"][0]["behind"], 3);
        assert_eq!(win["repositories"][0]["unstagedCount"], 1);
        assert_eq!(win["repositories"][0]["isClean"], false);

        let off = devices
            .iter()
            .find(|d| d["deviceId"] == "linux-off")
            .unwrap();
        assert_eq!(off["skipped"], "device is offline");
    }

    #[tokio::test]
    async fn run_command_uses_execute_tool_and_falls_back_to_terminal_on_old_peers() {
        let host = sample_host();
        let fast = execute_fleet_control(
            &host,
            FleetControlRequest::RunCommand {
                target: Some("Win Desktop".into()),
                command: "git status -sb".into(),
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
                cwd: Some("src".into()),
                timeout_ms: Some(10_000),
            },
        )
        .await
        .unwrap();
        assert_eq!(fast["transport"], "execute_tool");
        assert_eq!(fast["exitCode"], 0);
        assert_eq!(fast["output"], "ok-from-exec\n");
        assert_eq!(fast["cwd"], "C:/dev/OpenBitFun/src");

        host.fail_execute_tool_unsupported
            .store(true, Ordering::SeqCst);
        let fallback = execute_fleet_control(
            &host,
            FleetControlRequest::RunCommand {
                target: Some("Win Desktop".into()),
                command: "git status -sb".into(),
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
                cwd: None,
                timeout_ms: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(fallback["transport"], "terminal");
        assert_eq!(fallback["exitCode"], 0);
        assert!(fallback["output"].as_str().unwrap().contains("## main"));
        let calls = host.calls.lock().unwrap();
        assert!(calls.iter().any(|(_, cmd, _)| cmd == "terminal_close"));
    }

    #[tokio::test]
    async fn read_file_list_files_search_files_and_relative_pull_file_resolve_remote_paths() {
        let host = sample_host();
        let read = execute_fleet_control(
            &host,
            FleetControlRequest::ReadFile {
                target: Some("Win Desktop".into()),
                path: "./Cargo.toml".into(),
                workspace_id: None,
                workspace_path: Some("C:/dev/OpenBitFun".into()),
                start_line: Some(2),
                end_line: Some(3),
                max_chars: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(read["resolvedPath"], "C:/dev/OpenBitFun/Cargo.toml");
        assert_eq!(read["content"], "line2\nline3");

        let listed = execute_fleet_control(
            &host,
            FleetControlRequest::ListFiles {
                target: Some("Win Desktop".into()),
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
                path: None,
                offset: None,
                limit: Some(20),
            },
        )
        .await
        .unwrap();
        assert_eq!(listed["path"], "C:/dev/OpenBitFun");
        assert_eq!(listed["page"]["total"], 1);

        let searched = execute_fleet_control(
            &host,
            FleetControlRequest::SearchFiles {
                target: Some("Win Desktop".into()),
                pattern: "fn main".into(),
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
                search_content: true,
                case_sensitive: false,
                use_regex: false,
                max_results: Some(10),
            },
        )
        .await
        .unwrap();
        assert_eq!(searched["results"]["results"][0]["path"], "src/main.rs");

        // Relative pull-file resolves against workspace rootPath instead of peer CWD.
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("artifact.bin");
        let pulled = execute_fleet_control(
            &host,
            FleetControlRequest::PullFile {
                target: Some("Win Desktop".into()),
                remote_path: ".git_check_result.txt".into(),
                local_path: out.to_string_lossy().into_owned(),
                workspace_id: None,
                workspace_path: Some("C:/dev/OpenBitFun".into()),
                overwrite: false,
                max_bytes: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            pulled["resolvedRemotePath"],
            "C:/dev/OpenBitFun/.git_check_result.txt"
        );
        assert_eq!(std::fs::read(&out).unwrap(), b"MZ-win-binary");
    }

    #[tokio::test]
    async fn fleet_control_operates_on_local_self_and_peers_symmetrically() {
        let mut host = sample_host();
        host.complete_after_polls = 2;

        // 1. CreateSession with initial message + waitSeconds runs end-to-end and parses real ModelRoundData.
        let created_local = execute_fleet_control(
            &host,
            FleetControlRequest::CreateSession {
                target: None,
                workspace_id: Some("ws-mac".into()),
                workspace_path: None,
                session_name: "Local Parallel".into(),
                agent_type: None,
                model_name: None,
                message: Some("build mac binary".into()),
                wait_seconds: Some(10),
            },
        )
        .await
        .unwrap();
        assert_eq!(created_local["deviceId"], "mac-local");
        assert_eq!(created_local["isCurrentDevice"], true);
        assert_eq!(created_local["wait"]["satisfied"], true);
        assert_eq!(
            created_local["wait"]["sessions"][0]["turns"][0]["assistantText"],
            "Done: target/release/app"
        );
        assert_eq!(
            created_local["wait"]["sessions"][0]["turns"][0]["toolCalls"][0]["toolName"],
            "ExecCommand"
        );

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
                wait_seconds: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(sent_local["isCurrentDevice"], true);
        assert_eq!(sent_local["agentType"], "Standard");

        // 3. Read session parses real DialogTurnData textItems & toolItems.
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
        assert_eq!(read["turns"][0]["toolCalls"][0]["toolName"], "ExecCommand");
        assert_eq!(
            read["turns"][0]["toolCalls"][0]["resultPreview"],
            "Finished release target"
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
                message: None,
                wait_seconds: None,
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

        // 6. Cross-device search fans out per workspace with workspacePath populated, skipping offline peers.
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
            .any(|d| d["deviceId"] == "mac-local" && d["results"]["matchCount"] == 1));
        assert!(devices
            .iter()
            .any(|d| d["deviceId"] == "win-peer" && d["results"]["matchCount"] == 1));
        assert!(devices
            .iter()
            .any(|d| d["deviceId"] == "linux-off" && d["skipped"].is_string()));
        let search_calls: Vec<_> = host
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, cmd, _)| cmd == "search_session_content")
            .cloned()
            .collect();
        assert!(search_calls.iter().all(|(_, _, args)| args
            .pointer("/request/workspacePath")
            .and_then(Value::as_str)
            .is_some_and(|p| !p.is_empty())));

        // 7. Manage cron on an always-on peer dispatches list_cron_jobs on that peer.
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

        // 8. Forwarded ProductControl strips target on wire and refuses presentation Open.
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

    #[tokio::test]
    async fn direct_file_management_and_persistent_terminal_work_without_remote_sessions() {
        let host = sample_host();

        // 1. write-file resolves workspace-relative path and forwards write_file_content.
        let written = execute_fleet_control(
            &host,
            FleetControlRequest::WriteFile {
                target: Some("Win Desktop".into()),
                path: "config/app.toml".into(),
                content: "port = 8080\n".into(),
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
                expected_hash: Some("deadbeef".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(written["resolvedPath"], "C:/dev/OpenBitFun/config/app.toml");
        assert_eq!(written["bytesWritten"], 12);

        // 2. manage-file supports stat/exists/mkdir/rename/delete cleanly.
        let exists = execute_fleet_control(
            &host,
            FleetControlRequest::ManageFile {
                target: Some("Win Desktop".into()),
                action: FleetFileAction::Exists,
                path: "config/app.toml".into(),
                new_path: None,
                is_directory: false,
                recursive: false,
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(exists["result"], true);

        let renamed = execute_fleet_control(
            &host,
            FleetControlRequest::ManageFile {
                target: Some("Win Desktop".into()),
                action: FleetFileAction::Rename,
                path: "config/app.toml".into(),
                new_path: Some("config/app.bak".into()),
                is_directory: false,
                recursive: false,
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            renamed["resolvedNewPath"],
            "C:/dev/OpenBitFun/config/app.bak"
        );

        // 3. push-file drives chunked workspace_file_upload (begin -> append -> finish).
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("deploy.bin");
        std::fs::write(&src, b"\x00\x01payload-bytes").unwrap();
        let pushed = execute_fleet_control(
            &host,
            FleetControlRequest::PushFile {
                target: Some("Win Desktop".into()),
                local_path: src.to_string_lossy().into_owned(),
                remote_path: "dist/deploy.bin".into(),
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
                expected_hash: None,
                max_bytes: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(pushed["transport"], "workspace_file_upload");
        assert_eq!(
            pushed["resolvedRemotePath"],
            "C:/dev/OpenBitFun/dist/deploy.bin"
        );
        assert_eq!(pushed["size"], 15);
        let upload_actions: Vec<String> = host
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, cmd, _)| cmd == "workspace_file_upload")
            .filter_map(|(_, _, a)| {
                a.pointer("/request/action")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        assert_eq!(upload_actions, vec!["begin", "append", "finish"]);

        // 4. Persistent terminal lifecycle: list, create, execute, write, read (tail), signal, close.
        let listed = execute_fleet_control(
            &host,
            FleetControlRequest::Terminal {
                target: Some("Win Desktop".into()),
                action: FleetTerminalAction::List,
                terminal_id: None,
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
                cwd: None,
                name: None,
                command: None,
                data: None,
                signal: None,
                after_offset: None,
                max_chars: None,
                timeout_ms: None,
                immediate: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(listed["count"], 1);
        assert_eq!(listed["terminals"][0]["id"], "term-existing-1");

        let history = execute_fleet_control(
            &host,
            FleetControlRequest::Terminal {
                target: Some("Win Desktop".into()),
                action: FleetTerminalAction::Read,
                terminal_id: Some("term-existing-1".into()),
                workspace_id: None,
                workspace_path: None,
                cwd: None,
                name: None,
                command: None,
                data: None,
                signal: None,
                after_offset: Some(0),
                max_chars: Some(6),
                timeout_ms: None,
                immediate: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(history["truncatedFromStart"], true);
        assert!(history["output"].as_str().unwrap().ends_with("READY\n"));
        let hist_call = host
            .calls
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(_, cmd, _)| cmd == "terminal_get_history")
            .cloned()
            .unwrap();
        assert_eq!(hist_call.2["sessionId"], "term-existing-1");
        assert_eq!(hist_call.2["afterOffset"], 0);
    }

    #[tokio::test]
    async fn remote_session_inherits_controller_model_via_fleet_relay() {
        let host = sample_host();

        // 1. Inside a controller session running `gpt-5-cfg`, creating a remote session on
        //    `Win Desktop` (which has no local models) automatically binds `fleet:mac-local/gpt-5-cfg`.
        let created = crate::agentic::tools::openbitfun_control_host::with_caller_model_id(
            Some("gpt-5-cfg".into()),
            execute_fleet_control(
                &host,
                FleetControlRequest::CreateSession {
                    target: Some("Win Desktop".into()),
                    workspace_id: Some("ws-win".into()),
                    workspace_path: None,
                    session_name: "Remote Build".into(),
                    agent_type: None,
                    model_name: None,
                    message: Some("run cargo check".into()),
                    wait_seconds: None,
                },
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            created["resolvedModel"]["modelRef"],
            "fleet:mac-local/gpt-5-cfg"
        );
        assert_eq!(
            created["resolvedModel"]["source"],
            "controller_session_fleet_relay"
        );
        let calls = host.calls.lock().unwrap().clone();
        let create_call = calls
            .iter()
            .find(|(_, c, _)| c == "create_session")
            .unwrap();
        assert_eq!(
            create_call
                .2
                .pointer("/request/config/modelName")
                .and_then(Value::as_str),
            Some("fleet:mac-local/gpt-5-cfg")
        );
        let turn_call = calls
            .iter()
            .find(|(_, c, _)| c == "start_dialog_turn")
            .unwrap();
        assert_eq!(
            turn_call
                .2
                .pointer("/request/execution/modelId")
                .and_then(Value::as_str),
            Some("fleet:mac-local/gpt-5-cfg")
        );

        // 2. Passing `modelName: "target-default"` opts out of auto-inheritance.
        let opted_out = execute_fleet_control(
            &host,
            FleetControlRequest::CreateSession {
                target: Some("Win Desktop".into()),
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
                session_name: "Target Default".into(),
                agent_type: None,
                model_name: Some("target-default".into()),
                message: None,
                wait_seconds: None,
            },
        )
        .await
        .unwrap();
        assert!(opted_out.get("resolvedModel").is_none());

        // 3. `send-message` with `modelId: "controller"` routes through controller's primary/active model.
        let sent = execute_fleet_control(
            &host,
            FleetControlRequest::SendMessage {
                target: Some("Win Desktop".into()),
                session_id: "new-sess-1".into(),
                message: "retry with controller model".into(),
                workspace_id: Some("ws-win".into()),
                workspace_path: None,
                agent_type: None,
                model_id: Some("controller".into()),
                wait_seconds: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            sent["resolvedModel"]["modelRef"],
            "fleet:mac-local/claude-sonnet-cfg"
        );
    }
}
