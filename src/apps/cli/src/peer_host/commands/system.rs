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

pub(crate) async fn get_runtime_capabilities() -> Result<Value, String> {
    let manager = openbitfun_core::service::runtime::RuntimeManager::new()
        .map_err(|error| error.to_string())?;
    serde_json::to_value(manager.get_capabilities()).map_err(|error| error.to_string())
}

pub(crate) async fn get_health_status(state: &PeerHostState) -> Result<Value, String> {
    let mut services = std::collections::HashMap::new();
    services.insert(
        "config".to_string(),
        openbitfun_core::service::config::GlobalConfigManager::is_initialized(),
    );
    services.insert(
        "workspace".to_string(),
        openbitfun_core::service::workspace::get_global_workspace_service().is_some(),
    );
    services.insert(
        "mcp".to_string(),
        openbitfun_core::service::mcp::get_global_mcp_service().is_some(),
    );
    services.insert("acp".to_string(), crate::get_acp_client_service().is_some());
    Ok(json!({
        "status": "healthy",
        "message": "CLI peer host is healthy",
        "services": services,
        "uptime_seconds": state.start_time.elapsed().as_secs(),
    }))
}

pub(crate) async fn check_command_exists(args: &Value) -> Result<Value, String> {
    let command = args
        .get("command")
        .or_else(|| args.get("request").and_then(|r| r.get("command")))
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing 'command' field".to_string())?
        .to_string();
    let result = tokio::task::spawn_blocking(move || {
        openbitfun_core::service::system::check_command(&command)
    })
    .await
    .map_err(|error| format!("Failed to check command: {error}"))?;
    Ok(json!({
        "exists": result.exists,
        "path": result.path,
    }))
}

pub(crate) async fn check_commands_exist(args: &Value) -> Result<Value, String> {
    let commands: Vec<String> = serde_json::from_value(
        args.get("commands")
            .or_else(|| args.get("request").and_then(|r| r.get("commands")))
            .cloned()
            .ok_or_else(|| "Missing 'commands' field".to_string())?,
    )
    .map_err(|error| format!("Invalid 'commands' field: {error}"))?;
    let results = tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = commands.iter().map(String::as_str).collect();
        openbitfun_core::service::system::check_commands(&refs)
    })
    .await
    .map_err(|error| format!("Failed to check commands: {error}"))?;
    let payload: Vec<Value> = results
        .into_iter()
        .map(|(name, result)| {
            json!([
                name,
                {
                    "exists": result.exists,
                    "path": result.path,
                }
            ])
        })
        .collect();
    Ok(Value::Array(payload))
}

pub(crate) async fn get_file_watch_status() -> Result<Value, String> {
    let status = openbitfun_core::service::file_watch::get_file_watch_status();
    serde_json::to_value(status).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[tokio::test]
    async fn system_info_home_contract_reports_serving_host_in_camel_case() {
        let response = super::get_system_info().await.unwrap();
        let info = openbitfun_core::service::system::get_system_info();
        assert_eq!(response["homeDir"], serde_json::json!(info.home_dir));
        assert!(response.get("home_dir").is_none());
        assert_eq!(response["platform"], info.platform);
    }

    #[tokio::test]
    async fn runtime_capabilities_and_command_checks_report_host_facts() {
        let capabilities = super::get_runtime_capabilities().await.unwrap();
        let list = capabilities.as_array().unwrap();
        assert!(!list.is_empty());
        assert!(list[0]["command"].is_string());
        assert!(list[0]["available"].is_boolean());

        let missing = super::check_command_exists(&json!({
            "request": { "command": "openbitfun_definitely_missing_cmd_xyz" }
        }))
        .await
        .unwrap();
        assert_eq!(missing["exists"], json!(false));

        let batch = super::check_commands_exist(&json!({
            "commands": ["openbitfun_definitely_missing_cmd_xyz"]
        }))
        .await
        .unwrap();
        assert_eq!(batch.as_array().unwrap().len(), 1);
        assert_eq!(batch[0][0], json!("openbitfun_definitely_missing_cmd_xyz"));
        assert_eq!(batch[0][1]["exists"], json!(false));

        let watch = super::get_file_watch_status().await.unwrap();
        assert!(watch.is_object());
    }
}
