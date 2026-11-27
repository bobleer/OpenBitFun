//! System HostInvoke handlers.

use serde_json::{json, Value};

use openbitfun_core::service::token_usage::TokenUsageStatisticsRequest;

use crate::peer_host::state::PeerHostState;

pub(crate) async fn get_system_info() -> Result<Value, String> {
    let info = openbitfun_core::service::system::get_system_info();
    Ok(json!({
        "platform": info.platform,
        "arch": info.arch,
        "osVersion": info.os_version,
        "homeDir": info.home_dir,
    }))
}

/// `ui_bundle_manifest`: the web UI bundle compiled into this CLI.
pub(crate) async fn ui_bundle_manifest() -> Result<Value, String> {
    crate::ui_bundle::ui_bundle_manifest().await
}

pub(crate) async fn get_app_version() -> Result<Value, String> {
    Ok(Value::String(env!("CARGO_PKG_VERSION").to_string()))
}

pub(crate) async fn get_memory_paths(state: &PeerHostState) -> Result<Value, String> {
    let memories_root_dir = state.workspace_service.path_manager().memories_root_dir();
    tokio::fs::create_dir_all(&memories_root_dir)
        .await
        .map_err(|error| format!("Failed to create memory directory: {error}"))?;
    Ok(json!({
        "memoriesRootDir": memories_root_dir.to_string_lossy().to_string(),
    }))
}

pub(crate) async fn reset_memory(state: &PeerHostState) -> Result<Value, String> {
    let path_manager = state.workspace_service.path_manager().clone();
    let db = openbitfun_core::agentic::memories::db::MemoryDatabase::new(path_manager.clone());
    db.reset_memory_state()
        .await
        .map_err(|error| format!("Failed to reset memory database: {error}"))?;
    openbitfun_core::agentic::memories::workspace::reset_memory_workspace(
        &path_manager.memories_root_dir(),
    )
    .await
    .map_err(|error| format!("Failed to reset memory workspace: {error}"))?;
    Ok(json!({ "success": true }))
}

pub(crate) async fn get_runtime_logging_info() -> Result<Value, String> {
    Ok(crate::logging::runtime_logging_info())
}

pub(crate) async fn get_token_usage_statistics(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = args
        .get("request")
        .cloned()
        .ok_or_else(|| "Missing 'request' field in args".to_string())?;
    let request: TokenUsageStatisticsRequest =
        serde_json::from_value(request).map_err(|error| error.to_string())?;
    let statistics = state
        .token_usage_service
        .get_statistics_for_request(request)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(statistics).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn system_info_home_contract_reports_serving_host_in_camel_case() {
        let response = super::get_system_info().await.unwrap();
        let info = openbitfun_core::service::system::get_system_info();
        assert_eq!(response["homeDir"], serde_json::json!(info.home_dir));
        assert!(response.get("home_dir").is_none());
        assert_eq!(response["platform"], info.platform);
    }
}
