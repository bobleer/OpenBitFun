//! MCP server, prompt, resource, and OAuth HostInvoke handlers for CLI Peer Host.

use std::collections::HashMap;
use std::sync::Arc;

use openbitfun_core::service::mcp::config::MCPConfigService;
use openbitfun_core::service::mcp::{
    get_global_mcp_service, set_global_mcp_service, MCPServerManager, MCPServerType, MCPService,
};
use openbitfun_core::service::runtime::{RuntimeManager, RuntimeSource};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::peer_host::args::{get_string, request_value};

async fn mcp_service() -> Result<Arc<MCPService>, String> {
    if let Some(service) = get_global_mcp_service() {
        return Ok(service);
    }
    let config_service = openbitfun_core::service::config::get_global_config_service()
        .await
        .map_err(|error| format!("Failed to get config service: {error}"))?;
    let service = Arc::new(
        MCPService::new(config_service)
            .map_err(|error| format!("MCP service not initialized: {error}"))?,
    );
    set_global_mcp_service(service.clone());
    Ok(service)
}

async fn ensure_unscoped_host_mcp_access(
    manager: &MCPServerManager,
    server_id: &str,
) -> Result<(), String> {
    manager
        .server_available_for_context(server_id, None, false)
        .await
        .then_some(())
        .ok_or_else(|| "MCP server is unavailable in this product surface".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MCPServerInfoDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    import_origin: Option<openbitfun_core::service::mcp::server::MCPImportOrigin>,
    id: String,
    name: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_message: Option<String>,
    server_type: String,
    transport: String,
    enabled: bool,
    auto_start: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_configured: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    oauth_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    xaa_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command_resolved_path: Option<String>,
    start_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_disabled_reason: Option<String>,
}

pub(crate) async fn get_mcp_servers() -> Result<Value, String> {
    let mcp_service = mcp_service().await?;
    let configs = mcp_service
        .config_service()
        .load_all_configs()
        .await
        .map_err(|error| error.to_string())?;
    let runtime_manager = RuntimeManager::new().ok();
    let mcp_server_manager = mcp_service.server_manager();
    let mut infos = Vec::with_capacity(configs.len());

    for config in configs {
        let transport = config.resolved_transport();
        let static_auth_configured = if matches!(config.server_type, MCPServerType::Remote) {
            MCPConfigService::has_remote_authorization(&config)
        } else {
            false
        };
        let oauth_enabled =
            matches!(config.server_type, MCPServerType::Remote) && config.remote_oauth_enabled();
        let oauth_auth_configured = if oauth_enabled {
            mcp_server_manager
                .has_remote_oauth_credentials(&config.id)
                .await
                .unwrap_or(false)
        } else {
            false
        };

        let (command, command_available, command_source, command_resolved_path) =
            if transport == openbitfun_core::service::mcp::MCPServerTransport::Stdio {
                if let Some(command) = config.command.clone() {
                    let capability = runtime_manager
                        .as_ref()
                        .map(|manager| manager.get_command_capability(&command));
                    let available = capability.as_ref().map(|c| c.available);
                    let source = capability.and_then(|c| {
                        c.source.map(|source| match source {
                            RuntimeSource::System => "system".to_string(),
                            RuntimeSource::Managed => "managed".to_string(),
                        })
                    });
                    let resolved_path = runtime_manager
                        .as_ref()
                        .and_then(|manager| manager.resolve_command(&command))
                        .and_then(|resolved| resolved.resolved_path);
                    (Some(command), available, source, resolved_path)
                } else {
                    (None, None, None, None)
                }
            } else {
                (None, None, None, None)
            };

        let (start_supported, start_disabled_reason) = match config.server_type {
            MCPServerType::Remote if transport.as_str() == "sse" => (
                false,
                Some("Remote MCP SSE transport is not yet supported".to_string()),
            ),
            _ => (true, None),
        };

        let (status, status_message) = match mcp_server_manager.get_server_status(&config.id).await
        {
            Ok(s) => {
                let status_message = mcp_server_manager
                    .get_server_status_message(&config.id)
                    .await
                    .ok()
                    .flatten();
                (format!("{s:?}"), status_message)
            }
            Err(_) => {
                if !config.enabled {
                    ("Stopped".to_string(), None)
                } else if config.auto_start {
                    ("Starting".to_string(), None)
                } else {
                    ("Uninitialized".to_string(), None)
                }
            }
        };

        infos.push(MCPServerInfoDto {
            import_origin: config
                .settings
                .get("_openbitfunImport")
                .cloned()
                .and_then(|value| {
                    serde_json::from_value::<openbitfun_core::service::mcp::server::MCPImportOrigin>(
                        value,
                    )
                    .ok()
                })
                .map(|mut origin| {
                    if origin.source_id.is_none() {
                        origin.source_id = openbitfun_core::external_sources::ecosystem_for_imported_mcp_candidate(
                            &origin.source_candidate_id,
                        );
                    }
                    origin
                }),
            id: config.id.clone(),
            name: config.name.clone(),
            status,
            status_message,
            server_type: format!("{:?}", config.server_type),
            transport: transport.as_str().to_string(),
            enabled: config.enabled,
            auto_start: config.auto_start,
            url: config.url.clone(),
            auth_configured: if matches!(config.server_type, MCPServerType::Remote) {
                Some(static_auth_configured || oauth_auth_configured)
            } else {
                None
            },
            auth_source: if matches!(config.server_type, MCPServerType::Remote) {
                if static_auth_configured {
                    MCPConfigService::get_remote_authorization_source(&config)
                        .map(|source| source.to_string())
                } else if oauth_auth_configured {
                    Some("oauth".to_string())
                } else {
                    None
                }
            } else {
                None
            },
            oauth_enabled: if matches!(config.server_type, MCPServerType::Remote) {
                Some(oauth_enabled)
            } else {
                None
            },
            xaa_enabled: if matches!(config.server_type, MCPServerType::Remote) {
                Some(MCPConfigService::has_remote_xaa(&config))
            } else {
                None
            },
            command,
            command_available,
            command_source,
            command_resolved_path,
            start_supported,
            start_disabled_reason,
        });
    }

    serde_json::to_value(infos).map_err(|error| error.to_string())
}

pub(crate) async fn start_mcp_server(args: &Value) -> Result<Value, String> {
    let server_id = get_string(request_value(args), "serverId")?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    manager
        .start_server(&server_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn stop_mcp_server(args: &Value) -> Result<Value, String> {
    let server_id = get_string(request_value(args), "serverId")?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    manager
        .stop_server(&server_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn restart_mcp_server(args: &Value) -> Result<Value, String> {
    let server_id = get_string(request_value(args), "serverId")?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    manager
        .restart_server(&server_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn get_mcp_server_status(args: &Value) -> Result<Value, String> {
    let server_id = get_string(request_value(args), "serverId")?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    let status = manager
        .get_server_status(&server_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::String(format!("{status:?}")))
}

pub(crate) async fn load_mcp_json_config() -> Result<Value, String> {
    let service = mcp_service().await?;
    let snapshot = service
        .config_service()
        .load_mcp_json_config()
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

pub(crate) async fn save_mcp_json_config(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let json_config = get_string(request, "jsonConfig")?;
    let expected_fingerprint = get_string(request, "expectedFingerprint")?;
    let service = mcp_service().await?;
    service
        .save_json_config_and_reconcile(&json_config, &expected_fingerprint)
        .await?;
    Ok(Value::Null)
}

pub(crate) async fn delete_mcp_server(args: &Value) -> Result<Value, String> {
    let server_id = get_string(request_value(args), "serverId")?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    manager
        .remove_server(&server_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListMcpCatalogPayload {
    #[serde(alias = "server_id")]
    server_id: String,
    #[serde(default)]
    refresh: bool,
}

pub(crate) async fn list_mcp_resources(args: &Value) -> Result<Value, String> {
    let request: ListMcpCatalogPayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid list_mcp_resources request: {error}"))?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    let mut resources = manager.get_cached_resources(&request.server_id).await;
    if request.refresh || resources.is_empty() {
        manager
            .refresh_server_resource_catalog(&request.server_id)
            .await
            .map_err(|error| error.to_string())?;
        resources = manager.get_cached_resources(&request.server_id).await;
    }
    serde_json::to_value(resources).map_err(|error| error.to_string())
}

pub(crate) async fn read_mcp_resource(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let server_id = get_string(request, "serverId")?;
    let resource_uri = get_string(request, "resourceUri")?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    let connection = manager
        .get_connection(&server_id)
        .await
        .ok_or_else(|| format!("MCP server not connected: {server_id}"))?;
    let result = connection
        .read_resource(&resource_uri)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(result).map_err(|error| error.to_string())
}

pub(crate) async fn list_mcp_prompts(args: &Value) -> Result<Value, String> {
    let request: ListMcpCatalogPayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid list_mcp_prompts request: {error}"))?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    let mut prompts = manager.get_cached_prompts(&request.server_id).await;
    if request.refresh || prompts.is_empty() {
        manager
            .refresh_server_prompt_catalog(&request.server_id)
            .await
            .map_err(|error| error.to_string())?;
        prompts = manager.get_cached_prompts(&request.server_id).await;
    }
    serde_json::to_value(prompts).map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetMcpPromptPayload {
    #[serde(alias = "server_id")]
    server_id: String,
    #[serde(alias = "prompt_name")]
    prompt_name: String,
    #[serde(default)]
    arguments: Option<HashMap<String, String>>,
}

pub(crate) async fn get_mcp_prompt(args: &Value) -> Result<Value, String> {
    let request: GetMcpPromptPayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid get_mcp_prompt request: {error}"))?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    let connection = manager
        .get_connection(&request.server_id)
        .await
        .ok_or_else(|| format!("MCP server not connected: {}", request.server_id))?;
    let result = connection
        .get_prompt(&request.prompt_name, request.arguments)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(result).map_err(|error| error.to_string())
}

pub(crate) async fn update_mcp_remote_auth(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let server_id = get_string(request, "serverId")?;
    let authorization_value = get_string(request, "authorizationValue")?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    manager
        .reauthenticate_remote_server(&server_id, &authorization_value)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn clear_mcp_remote_auth(args: &Value) -> Result<Value, String> {
    let server_id = get_string(request_value(args), "serverId")?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    manager
        .clear_remote_server_auth(&server_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn start_mcp_remote_oauth(args: &Value) -> Result<Value, String> {
    let server_id = get_string(request_value(args), "serverId")?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    let snapshot = manager
        .start_remote_oauth_authorization(&server_id)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

pub(crate) async fn get_mcp_remote_oauth_session(args: &Value) -> Result<Value, String> {
    let server_id = get_string(request_value(args), "serverId")?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    let snapshot = manager.get_remote_oauth_session(&server_id).await;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

pub(crate) async fn cancel_mcp_remote_oauth(args: &Value) -> Result<Value, String> {
    let server_id = get_string(request_value(args), "serverId")?;
    let service = mcp_service().await?;
    let manager = service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    manager
        .cancel_remote_oauth_authorization(&server_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}
