//! Tools HostInvoke handlers for CLI Peer Host.

use serde_json::Value;

use openbitfun_core::agentic::tools::product_runtime::build_all_tools_info;

pub(crate) async fn get_chat_mcp_catalog(args: &Value) -> Result<Value, String> {
    let request = serde_json::from_value(crate::peer_host::args::request_value(args).clone())
        .map_err(|error| format!("Invalid MCP catalog request: {error}"))?;
    let catalog =
        openbitfun_core::agentic::tools::product_runtime::build_chat_mcp_catalog(request).await?;
    serde_json::to_value(catalog)
        .map_err(|error| format!("Failed to serialize MCP catalog: {error}"))
}

/// Read-only tool catalog for the Agents / Assistant Defaults UI.
///
/// CLI Host assembles the same Core tool registry as Desktop; this returns the
/// identical DTO shape so a controller cannot tell "CLI Host doesn't support
/// catalog query" from "the runtime really has no tools". Without this, the
/// controller's `get_all_tools_info` call would fall into the unsupported
/// dispatch branch and the UI would silently render an empty tool list.
pub(crate) async fn get_all_tools_info() -> Result<Value, String> {
    let tools = build_all_tools_info().await;
    serde_json::to_value(tools).map_err(|error| format!("Failed to serialize tool info: {error}"))
}

/// Query the host registry using the same visibility and remote-source rules as Desktop.
pub(crate) async fn list_subagents(command: &str, args: &Value) -> Result<Value, String> {
    use crate::peer_host::args::{get_string, optional_string, request_value};
    use openbitfun_core::agentic::agents::{SubagentListScope, SubagentQueryContext};
    let request = request_value(args);
    let parent = if command == "list_subagents" {
        None
    } else {
        Some(get_string(request, "parentAgentType")?)
    };
    let source: Option<openbitfun_core::agentic::agents::SubAgentSource> = request
        .get("source")
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .map_err(|error| format!("Invalid subagent source: {error}"))?;
    let visible = command == "list_visible_subagents";
    let workspace_id = optional_string(request, "workspaceId");
    let legacy_path = optional_string(request, "workspacePath");
    let workspace = if workspace_id.is_some() || legacy_path.is_some() {
        let service = openbitfun_core::service::workspace::get_global_workspace_service()
            .ok_or("Workspace service is unavailable")?;
        Some(
            service
                .resolve_legacy_workspace_reference(
                    workspace_id.as_deref(),
                    legacy_path.as_deref().unwrap_or_default(),
                    None,
                    None,
                )
                .await
                .map_err(|error| error.to_string())?
                .ok_or("Unknown workspace reference")?,
        )
    } else {
        None
    };
    let external_sources_supported = workspace.as_ref().is_none_or(|record| {
        record.workspace_kind != openbitfun_core::service::workspace::WorkspaceKind::Remote
    });
    let mut agents = openbitfun_core::agentic::get_agent_registry()
        .get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: parent.as_deref(),
            workspace_id: external_sources_supported
                .then_some(workspace.as_ref().map(|record| record.id.as_str()))
                .flatten(),
            list_scope: if visible {
                SubagentListScope::TaskVisible
            } else {
                SubagentListScope::RegistryManagement
            },
            include_disabled: !visible,
            external_sources_supported,
        })
        .await;
    if let Some(source) = source {
        agents.retain(|agent| agent.subagent_source.as_ref() == Some(&source));
    }
    if command == "list_subagents" {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct SubagentListItem {
            #[serde(flatten)]
            info: openbitfun_core::agentic::agents::AgentInfo,
            #[serde(flatten)]
            mutability: openbitfun_core::agentic::agents::AgentMutability,
        }
        let items: Vec<SubagentListItem> = agents
            .into_iter()
            .map(|info| SubagentListItem {
                mutability: info.source.mutability(external_sources_supported),
                info,
            })
            .collect();
        return serde_json::to_value(items).map_err(|error| error.to_string());
    }
    serde_json::to_value(agents).map_err(|error| error.to_string())
}

pub(crate) async fn get_available_tools() -> Result<Value, String> {
    let tools = openbitfun_core::agentic::tools::get_all_tools().await;
    let names: Vec<String> = tools.into_iter().map(|t| t.name().to_string()).collect();
    serde_json::to_value(names).map_err(|error| error.to_string())
}

pub(crate) async fn get_readonly_tools_info() -> Result<Value, String> {
    let tools = openbitfun_core::agentic::tools::get_readonly_tools()
        .await
        .map_err(|error| format!("Failed to get readonly tools: {error}"))?;
    let mut infos = Vec::with_capacity(tools.len());
    for tool in tools {
        infos.push(openbitfun_core::agentic::tools::product_runtime::build_tool_info(&tool).await);
    }
    serde_json::to_value(infos).map_err(|error| error.to_string())
}

pub(crate) async fn get_tool_info(args: &Value) -> Result<Value, String> {
    let tool_name = crate::peer_host::args::get_string(
        crate::peer_host::args::request_value(args),
        "toolName",
    )?;
    let tools = openbitfun_core::agentic::tools::get_all_tools().await;
    for tool in tools {
        if tool.name() == tool_name {
            let info =
                openbitfun_core::agentic::tools::product_runtime::build_tool_info(&tool).await;
            return serde_json::to_value(Some(info)).map_err(|error| error.to_string());
        }
    }
    Ok(Value::Null)
}

async fn build_cli_tool_context(
    workspace_id: Option<&str>,
    legacy_path: Option<&str>,
) -> Result<openbitfun_core::agentic::tools::framework::ToolUseContext, String> {
    use openbitfun_core::agentic::tools::framework::ToolUseContext;
    use openbitfun_core::agentic::workspace::{local_workspace_services, WorkspaceBinding};

    let id = if let Some(id) = workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id.to_owned())
    } else if let Some(path) = legacy_path.map(str::trim).filter(|s| !s.is_empty()) {
        let service = openbitfun_core::service::workspace::get_global_workspace_service()
            .ok_or_else(|| "Workspace service is unavailable".to_string())?;
        let record = service
            .resolve_legacy_workspace_reference(None, path, None, None)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Legacy workspace reference is unavailable".to_string())?;
        Some(record.id)
    } else {
        None
    };
    let workspace = match id {
        Some(id) => Some(
            WorkspaceBinding::resolve(&id)
                .await
                .map_err(|error| error.to_string())?,
        ),
        None => None,
    };
    if let Some(binding) = workspace.as_ref().filter(|b| b.is_remote()) {
        return Err(format!(
            "CLI peer direct tool execution does not support remote workspace {}; no controller-local fallback was attempted",
            binding.root_path_string()
        ));
    }
    let workspace_services = workspace
        .as_ref()
        .map(|binding| local_workspace_services(binding.root_path_string()));
    Ok(ToolUseContext::for_tool_listing_with_remote_exec_port(
        workspace,
        workspace_services,
        None,
    ))
}

pub(crate) async fn validate_tool_input(args: &Value) -> Result<Value, String> {
    let request = crate::peer_host::args::request_value(args);
    let tool_name = crate::peer_host::args::get_string(request, "toolName")?;
    let input = request.get("input").cloned().unwrap_or(Value::Null);
    let workspace_id = crate::peer_host::args::optional_string(request, "workspaceId");
    let workspace_path = crate::peer_host::args::optional_string(request, "workspacePath");
    let tools = openbitfun_core::agentic::tools::get_all_tools().await;
    for tool in tools {
        if tool.name() == tool_name {
            let context =
                build_cli_tool_context(workspace_id.as_deref(), workspace_path.as_deref()).await?;
            let result = tool.validate_input(&input, Some(&context)).await;
            return Ok(serde_json::json!({
                "tool_name": tool_name,
                "valid": result.result,
                "message": result.message,
                "error_code": result.error_code,
                "meta": result.meta,
            }));
        }
    }
    Err(format!("Tool '{tool_name}' not found"))
}

pub(crate) async fn execute_tool(args: &Value) -> Result<Value, String> {
    use openbitfun_core::agentic::tools::framework::ToolResult;
    use openbitfun_core::util::elapsed_ms_u64;

    let start = std::time::Instant::now();
    let request = crate::peer_host::args::request_value(args);
    let tool_name = crate::peer_host::args::get_string(request, "toolName")?;
    let input = request.get("input").cloned().unwrap_or(Value::Null);
    let workspace_id = crate::peer_host::args::optional_string(request, "workspaceId");
    let workspace_path = crate::peer_host::args::optional_string(request, "workspacePath");
    let tools = openbitfun_core::agentic::tools::get_all_tools().await;
    for tool in tools {
        if tool.name() == tool_name {
            let context =
                build_cli_tool_context(workspace_id.as_deref(), workspace_path.as_deref()).await?;
            let validation = tool.validate_input(&input, Some(&context)).await;
            if !validation.result {
                return Ok(serde_json::json!({
                    "tool_name": tool_name,
                    "success": false,
                    "result": null,
                    "error": null,
                    "validation_error": validation.message,
                    "duration_ms": elapsed_ms_u64(start),
                }));
            }
            return match tool.call(&input, &context).await {
                Ok(results) => {
                    let combined = if results.len() == 1 {
                        match &results[0] {
                            ToolResult::Result { data, .. } => Some(data.clone()),
                            ToolResult::Progress { content, .. } => Some(content.clone()),
                            ToolResult::StreamChunk { data, .. } => Some(data.clone()),
                        }
                    } else {
                        Some(serde_json::json!({
                            "results": results.iter().map(|r| match r {
                                ToolResult::Result { data, .. } => data.clone(),
                                ToolResult::Progress { content, .. } => content.clone(),
                                ToolResult::StreamChunk { data, .. } => data.clone(),
                            }).collect::<Vec<_>>()
                        }))
                    };
                    Ok(serde_json::json!({
                        "tool_name": tool_name,
                        "success": true,
                        "result": combined,
                        "error": null,
                        "validation_error": null,
                        "duration_ms": elapsed_ms_u64(start),
                    }))
                }
                Err(error) => Ok(serde_json::json!({
                    "tool_name": tool_name,
                    "success": false,
                    "result": null,
                    "error": format!("Tool execution failed: {error}"),
                    "validation_error": null,
                    "duration_ms": elapsed_ms_u64(start),
                })),
            };
        }
    }
    Err(format!("Tool '{tool_name}' not found"))
}
