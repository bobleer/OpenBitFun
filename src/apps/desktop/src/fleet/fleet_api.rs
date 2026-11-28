//! The fleet backend commands of the desktop host.
//!
//! `fleet_call`, `fleet_navigator`, `fleet_prompts`, `fleet_attention`,
//! `fleet_recent_sessions`, `fleet_device_detail`, `fleet_models` and
//! `fleet_ui_bundle`
//! serve every client of this host (the native UI, and phones and browsers
//! over the mesh in the `account-device` scope). `fleet_subscribe` and
//! `fleet_events` serve the native UI in-process: OBP connections answer them
//! in the connection layer, so they never reach these handlers from a mesh
//! client. The owner verbs `fleet_digest` / `fleet_replay` are mesh host
//! verbs ([`owner_verb`], routed by `backend_protocol::ws::mesh_verbs`).
//!
//! The client-facing verbs are served by the local-only fleet while the
//! device network is off (`super::serving`): a command aimed at this host
//! runs here whether or not the network runs, and one aimed at another
//! device answers `fleet_device_offline: <id> (device_network_off)`. The
//! owner verbs need the account fleet (`super::require`).

use openbitfun_obp::fleet::FleetCallError;
use openbitfun_product_domains::fleet::{
    FleetAttentionMarkReadRequest, FleetAttentionMarkReadResponse, FleetAttentionRequest,
    FleetAttentionView, FleetCallRequest, FleetDeviceDetail, FleetDeviceDetailRequest,
    FleetEventsRequest, FleetEventsResponse, FleetModels, FleetModelsRequest, FleetNavigator,
    FleetNavigatorRequest, FleetPromptsRequest, FleetPromptsResponse, FleetRecentSessions,
    FleetRecentSessionsRequest, FleetSubscribeRequest, FleetSubscribeResponse,
    FleetUiBundleRequest, FleetUiBundleResponse,
};
use serde_json::Value;

/// `fleet_call {target, command, args}`: runs here or on the owner device.
// @backend-command
pub async fn fleet_call(request: FleetCallRequest) -> Result<Value, String> {
    match super::serving("fleet_call") {
        Ok(host) => host
            .router()
            .fleet_call(request)
            .await
            .map_err(FleetCallError::into_message),
        // No fleet can be built yet (the backend runtime is still starting):
        // a call aimed here still runs here.
        Err(_) => super::fleet_call_here(request)
            .await
            .map_err(FleetCallError::into_message),
    }
}

/// `fleet_navigator {sinceRevision?}`: every device, workspace and session.
// @backend-command
pub async fn fleet_navigator(request: FleetNavigatorRequest) -> Result<FleetNavigator, String> {
    Ok(super::serving("fleet_navigator")?
        .router()
        .navigator(request))
}

/// `fleet_prompts`: the pending prompts of every device.
// @backend-command
pub async fn fleet_prompts(request: FleetPromptsRequest) -> Result<FleetPromptsResponse, String> {
    let _ = request;
    Ok(super::serving("fleet_prompts")?.router().prompts())
}

/// `fleet_attention`: the Inbox of every device (prompts, the cloud
/// agent's jobs that need the user, unread Done and Failed items).
// @backend-command
pub async fn fleet_attention(request: FleetAttentionRequest) -> Result<FleetAttentionView, String> {
    let _ = request;
    Ok(super::serving("fleet_attention")?.attention().view().await)
}

/// `fleet_attention_mark_read {revision}`: marks the Done and Failed items
/// of the view served at `revision` read (read state lives with this entry).
// @backend-command
pub async fn fleet_attention_mark_read(
    request: FleetAttentionMarkReadRequest,
) -> Result<FleetAttentionMarkReadResponse, String> {
    Ok(super::serving("fleet_attention_mark_read")?
        .attention()
        .mark_read(request.revision))
}

/// `fleet_recent_sessions {limit?, cursor?}`: All sessions › Recent, every
/// device's sessions newest first with device and workspace labels.
// @backend-command
pub async fn fleet_recent_sessions(
    request: FleetRecentSessionsRequest,
) -> Result<FleetRecentSessions, String> {
    Ok(super::serving("fleet_recent_sessions")?
        .views()
        .recent_sessions(&request))
}

/// `fleet_models {deviceId?}`: every device's models grouped by device,
/// the device that runs the session first, with each device's online state.
// @backend-command
pub async fn fleet_models(request: FleetModelsRequest) -> Result<FleetModels, String> {
    Ok(super::serving("fleet_models")?.views().models(&request))
}

/// `fleet_device_detail {deviceId}`: the device page (facts, route,
/// workspaces, what runs there now and what waits to start).
// @backend-command
pub async fn fleet_device_detail(
    request: FleetDeviceDetailRequest,
) -> Result<FleetDeviceDetail, String> {
    super::serving("fleet_device_detail")?
        .views()
        .device_detail(&request)
        .await
}

/// `fleet_subscribe {follow}` for the native UI.
// @backend-command
pub async fn fleet_subscribe(
    request: FleetSubscribeRequest,
) -> Result<FleetSubscribeResponse, String> {
    super::remember_follow(&request);
    super::serving("fleet_subscribe")?.subscribe(request).await
}

/// `fleet_events {cursor, waitMs}`: the native UI's long poll for the
/// events of other devices (its own stay in-process).
// @backend-command
pub async fn fleet_events(request: FleetEventsRequest) -> Result<FleetEventsResponse, String> {
    Ok(super::serving("fleet_events")?.events(request).await)
}

/// `fleet_ui_bundle`: the web UI a browser loads through this entry.
// @backend-command
pub async fn fleet_ui_bundle(
    request: FleetUiBundleRequest,
) -> Result<FleetUiBundleResponse, String> {
    let _ = request;
    super::serving("fleet_ui_bundle")?.ui_bundle().await
}

/// The owner verbs another runtime host calls on the mesh listener.
pub(crate) async fn owner_verb(command: String, args: Value) -> Result<Value, String> {
    let host = super::require(&command)?;
    host.dispatch(&command, args, &super::instance_id())
        .await
        .unwrap_or_else(|| Err(format!("unknown fleet owner verb {command}")))
}

struct DesktopFleetControlHost;

#[async_trait::async_trait]
impl openbitfun_core::service::fleet::FleetControlHost for DesktopFleetControlHost {
    fn local_device_id(&self) -> Option<String> {
        super::serving("fleet_navigator")
            .ok()
            .map(|host| host.device_id().to_string())
            .or_else(|| crate::api::remote_connect_api::current_device_id_for_peer().ok())
    }

    async fn navigator(&self) -> anyhow::Result<FleetNavigator> {
        let host = super::serving("fleet_navigator").map_err(anyhow::Error::msg)?;
        Ok(host.router().navigator(FleetNavigatorRequest::default()))
    }

    async fn device_detail(&self, device_id: &str) -> anyhow::Result<FleetDeviceDetail> {
        let host = super::serving("fleet_device_detail").map_err(anyhow::Error::msg)?;
        host.views()
            .device_detail(&FleetDeviceDetailRequest {
                device_id: device_id.to_string(),
            })
            .await
            .map_err(anyhow::Error::msg)
    }

    async fn models(&self, device_id: Option<&str>) -> anyhow::Result<FleetModels> {
        let host = super::serving("fleet_models").map_err(anyhow::Error::msg)?;
        Ok(host.views().models(&FleetModelsRequest {
            device_id: device_id.map(str::to_string),
        }))
    }

    async fn prompts(&self) -> anyhow::Result<FleetPromptsResponse> {
        let host = super::serving("fleet_prompts").map_err(anyhow::Error::msg)?;
        Ok(host.router().prompts())
    }

    async fn attention(&self) -> anyhow::Result<FleetAttentionView> {
        let host = super::serving("fleet_attention").map_err(anyhow::Error::msg)?;
        Ok(host.attention().view().await)
    }

    async fn mark_attention_read(
        &self,
        revision: u64,
    ) -> anyhow::Result<FleetAttentionMarkReadResponse> {
        let host = super::serving("fleet_attention_mark_read").map_err(anyhow::Error::msg)?;
        Ok(host.attention().mark_read(revision))
    }

    async fn recent_sessions(
        &self,
        request: FleetRecentSessionsRequest,
    ) -> anyhow::Result<FleetRecentSessions> {
        let host = super::serving("fleet_recent_sessions").map_err(anyhow::Error::msg)?;
        Ok(host.views().recent_sessions(&request))
    }

    async fn fleet_call(
        &self,
        target_device_id: &str,
        command: &str,
        args: Value,
    ) -> anyhow::Result<Value> {
        fleet_call(FleetCallRequest {
            target: Some(target_device_id.to_string()),
            command: command.to_string(),
            args,
        })
        .await
        .map_err(anyhow::Error::msg)
    }

    async fn dispatch_answer(
        &self,
        target_device_id: &str,
        payload: Value,
    ) -> anyhow::Result<Value> {
        let is_local = self
            .local_device_id()
            .as_deref()
            .is_some_and(|local| local == target_device_id);
        if is_local {
            return crate::api::dispatch_host::dispatch("dispatch_target_answer", payload).await;
        }
        openbitfun_core::service::dispatch::invoke_device_dispatch(
            openbitfun_services_integrations::remote_connect::mesh_route::mesh_route(),
            target_device_id,
            "dispatch_target_answer",
            payload,
        )
        .await
    }
}

/// Run one Agent product-control Fleet request on this desktop host.
pub(crate) async fn execute_agent_fleet_control(
    request: openbitfun_product_domains::fleet_control::FleetControlRequest,
) -> Result<Value, String> {
    openbitfun_core::service::fleet::execute_fleet_control(&DesktopFleetControlHost, request)
        .await
        .map_err(|error| format!("{error:#}"))
}

/// Forward an `OpenBitFunControl` request (`get`/`configure`/`execute`) to a peer device.
pub(crate) async fn forward_agent_product_control(
    target: Option<&str>,
    request: openbitfun_product_domains::product_control::ProductControlRequest,
) -> Result<Value, String> {
    openbitfun_core::service::fleet::forward_product_control(
        &DesktopFleetControlHost,
        target,
        request,
    )
    .await
    .map_err(|error| format!("{error:#}"))
}
