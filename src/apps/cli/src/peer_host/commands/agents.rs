//! Custom agent, subagent, and agent profile HostInvoke handlers for CLI Peer Host.

use std::collections::{HashMap, HashSet};

use openbitfun_core::agentic::agents::{
    custom_agent_model_or_default, custom_agent_review_writable_tools, default_custom_agent_tools,
    default_custom_agent_user_context_policy, CustomAgentKind, CustomAgentLevel, CustomMode,
    CustomSubagent, CustomSubagentKind, UserContextPolicy, UserContextSection,
};
use openbitfun_core::agentic::get_agent_registry;
use openbitfun_core::agentic::tools::registry::get_all_registered_tools;
use openbitfun_core::service::config::model_pool::AgentModelSelection;
use openbitfun_core::service::config::GlobalConfig;
use openbitfun_core::service::workspace::WorkspaceKind;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::peer_host::args::{get_string, request_value};
use crate::peer_host::state::PeerHostState;

async fn local_workspace_from_request(
    state: &PeerHostState,
    workspace_id: Option<&str>,
    legacy_path: Option<&str>,
) -> Result<Option<String>, String> {
    if workspace_id.is_none() && legacy_path.is_none() {
        return Ok(None);
    }
    let record = state
        .workspace_service
        .resolve_legacy_workspace_reference(
            workspace_id,
            legacy_path.unwrap_or_default(),
            None,
            None,
        )
        .await
        .map_err(|error| error.to_string())?
        .ok_or("Unknown workspace reference")?;
    if record.workspace_kind == WorkspaceKind::Remote {
        return Err("Custom Agent management is unsupported for remote workspaces".into());
    }
    Ok(Some(record.id))
}

fn reject_external_agent_mutation(agent_id: &str, workspace: Option<&str>) -> Result<(), String> {
    if get_agent_registry().is_external_subagent_route(agent_id, workspace) {
        return Err(
            "external_subagent_read_only: manage external agents in External AI Apps".to_string(),
        );
    }
    Ok(())
}

fn validate_agent_id(id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("Id cannot be empty".to_string());
    }
    let mut chars = id.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return Err(
            "Id must start with a letter and contain only letters, numbers, -, _".to_string(),
        );
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(
            "Id must start with a letter and contain only letters, numbers, -, _".to_string(),
        );
    }
    Ok(())
}

fn validate_agent_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    Ok(())
}

fn validate_subagent_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    let mut chars = name.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return Err("Name must start with a letter".to_string());
    }
    for c in chars {
        if !c.is_ascii_alphanumeric() && c != '-' && c != '_' {
            return Err("Name can only contain letters, numbers, -, _".to_string());
        }
    }
    Ok(())
}

fn policy_from_sections(
    sections: Option<Vec<UserContextSection>>,
    kind: CustomAgentKind,
) -> UserContextPolicy {
    sections
        .map(|sections| {
            let mut policy = UserContextPolicy::empty();
            for section in sections {
                policy = policy.with_section(section);
            }
            policy
        })
        .unwrap_or_else(|| default_custom_agent_user_context_policy(kind))
}

async fn readonly_tool_names() -> Vec<String> {
    get_all_registered_tools()
        .await
        .into_iter()
        .filter(|tool| tool.is_readonly())
        .map(|tool| tool.name().to_string())
        .collect()
}

async fn ensure_review_tools_are_readonly(agent_id: &str, tools: &[String]) -> Result<(), String> {
    let readonly_tools = readonly_tool_names().await;
    let writable_tools = custom_agent_review_writable_tools(tools, &readonly_tools);
    if writable_tools.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Review Sub-Agent '{agent_id}' can only use read-only tools; remove writable tools: {}",
        writable_tools.join(", ")
    ))
}

async fn existing_agent_ids(workspace: Option<&str>) -> HashSet<String> {
    let registry = get_agent_registry();
    let modes = registry.get_modes_info().await;
    let subagents = registry.get_subagents_info(workspace).await;
    modes
        .iter()
        .map(|mode| mode.id.to_lowercase())
        .chain(subagents.iter().map(|agent| agent.id.to_lowercase()))
        .collect()
}

pub(crate) async fn list_agent_tool_names() -> Result<Value, String> {
    let names: Vec<String> = get_all_registered_tools()
        .await
        .into_iter()
        .map(|tool| tool.name().to_string())
        .collect();
    serde_json::to_value(names).map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdScopePayload {
    #[serde(alias = "agent_id")]
    agent_id: String,
    #[serde(default, alias = "workspace_id")]
    workspace_id: Option<String>,
    #[serde(default, alias = "workspace_path")]
    workspace_path: Option<String>,
}

pub(crate) async fn get_custom_agent_detail(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: AgentIdScopePayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid get_custom_agent_detail request: {error}"))?;
    let workspace = local_workspace_from_request(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_agent_mutation(&request.agent_id, workspace.as_deref())?;
    let detail = get_agent_registry()
        .get_custom_agent_detail(&request.agent_id, workspace.as_deref())
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(detail).map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCustomAgentPayload {
    kind: CustomAgentKind,
    #[serde(default)]
    level: Option<CustomAgentLevel>,
    id: String,
    name: String,
    description: String,
    prompt: String,
    #[serde(default)]
    tools: Option<Vec<String>>,
    #[serde(default)]
    readonly: Option<bool>,
    #[serde(default)]
    review: Option<bool>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default, alias = "user_context_policy")]
    user_context_policy: Option<Vec<UserContextSection>>,
    #[serde(default, alias = "workspace_id")]
    workspace_id: Option<String>,
    #[serde(default, alias = "workspace_path")]
    workspace_path: Option<String>,
}

pub(crate) async fn create_custom_agent(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: CreateCustomAgentPayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid create_custom_agent request: {error}"))?;
    let id = request.id.trim().to_string();
    validate_agent_id(&id)?;
    validate_agent_name(&request.name)?;
    if request.description.trim().is_empty() {
        return Err("Description cannot be empty".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("Prompt cannot be empty".to_string());
    }

    let workspace = local_workspace_from_request(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    let level = request.level.unwrap_or(CustomAgentLevel::User);
    if request.kind == CustomAgentKind::Mode && level == CustomAgentLevel::Project {
        return Err("Custom modes do not support project level".to_string());
    }
    if level == CustomAgentLevel::Project && workspace.is_none() {
        return Err("Project-level Agent requires opening a workspace first".to_string());
    }

    let registry = get_agent_registry();
    registry.load_custom_agents(workspace.as_deref()).await;
    let existing = existing_agent_ids(workspace.as_deref()).await;
    if existing.contains(&id.to_lowercase()) {
        return Err(format!("Id '{id}' conflicts with an existing agent"));
    }

    let path_manager = state.workspace_service.path_manager();
    let agents_dir = match level {
        CustomAgentLevel::User => path_manager.user_agents_dir(),
        CustomAgentLevel::Project => {
            let ws_id = workspace.as_deref().ok_or("Workspace ID not available")?;
            let record = state
                .workspace_service
                .require_workspace(ws_id)
                .await
                .map_err(|error| error.to_string())?;
            path_manager.project_agents_dir(&record.root_path)
        }
    };
    std::fs::create_dir_all(&agents_dir)
        .map_err(|error| format!("Failed to create directory: {error}"))?;

    let file_path = agents_dir.join(format!("{}.md", id.to_lowercase()));
    let path_str = file_path.to_string_lossy().to_string();
    if file_path.exists() {
        return Err(format!("File '{path_str}' already exists"));
    }

    let mut tools = request
        .tools
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| default_custom_agent_tools(request.kind));
    if tools.is_empty() {
        tools = default_custom_agent_tools(request.kind);
    }

    let review = request.review.unwrap_or(false);
    if request.kind == CustomAgentKind::Mode && review {
        return Err("Custom modes cannot enable review".to_string());
    }
    if review {
        ensure_review_tools_are_readonly(&id, &tools).await?;
    }

    let readonly = if review {
        true
    } else {
        request
            .readonly
            .unwrap_or(request.kind == CustomAgentKind::Subagent)
    };
    let model_is_explicit = request
        .model
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let model = request
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| custom_agent_model_or_default(request.kind, None).to_string());
    let user_context_policy =
        policy_from_sections(request.user_context_policy.clone(), request.kind);

    match request.kind {
        CustomAgentKind::Mode => {
            let mode = CustomMode::new(
                id.clone(),
                request.name.trim().to_string(),
                request.description.trim().to_string(),
                tools,
                request.prompt.trim().to_string(),
                readonly,
                path_str,
                model,
                user_context_policy,
            );
            mode.save_to_file(None).map_err(|error| error.to_string())?;
        }
        CustomAgentKind::Subagent => {
            let mut subagent = CustomSubagent::new_with_id_and_model_explicit(
                id.clone(),
                request.name.trim().to_string(),
                request.description.trim().to_string(),
                tools,
                request.prompt.trim().to_string(),
                readonly,
                path_str,
                level,
                model,
                model_is_explicit,
                user_context_policy,
            );
            subagent.set_review(review);
            subagent
                .save_to_file(None)
                .map_err(|error| error.to_string())?;
        }
    }
    registry.load_custom_agents(workspace.as_deref()).await;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCustomAgentPayload {
    #[serde(alias = "agent_id")]
    agent_id: String,
    name: String,
    description: String,
    prompt: String,
    #[serde(default)]
    tools: Option<Vec<String>>,
    #[serde(default)]
    readonly: Option<bool>,
    #[serde(default)]
    review: Option<bool>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default, alias = "user_context_policy")]
    user_context_policy: Option<Vec<UserContextSection>>,
    #[serde(default, alias = "workspace_id")]
    workspace_id: Option<String>,
    #[serde(default, alias = "workspace_path")]
    workspace_path: Option<String>,
}

pub(crate) async fn update_custom_agent(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: UpdateCustomAgentPayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid update_custom_agent request: {error}"))?;
    validate_agent_name(&request.name)?;
    if request.description.trim().is_empty() {
        return Err("Description cannot be empty".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("Prompt cannot be empty".to_string());
    }

    let workspace = local_workspace_from_request(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_agent_mutation(&request.agent_id, workspace.as_deref())?;
    let registry = get_agent_registry();
    let current = registry
        .get_custom_agent_detail(&request.agent_id, workspace.as_deref())
        .await
        .map_err(|error| error.to_string())?;

    let kind = match current.kind.as_str() {
        "mode" => CustomAgentKind::Mode,
        _ => CustomAgentKind::Subagent,
    };
    let user_context_policy = request
        .user_context_policy
        .clone()
        .map(|sections| policy_from_sections(Some(sections), kind));

    if kind == CustomAgentKind::Mode && request.review.unwrap_or(false) {
        return Err("Custom modes cannot enable review".to_string());
    }
    if kind == CustomAgentKind::Subagent && request.review.unwrap_or(current.review) {
        let tools = request
            .tools
            .clone()
            .filter(|items| !items.is_empty())
            .unwrap_or_else(|| current.tools.clone());
        ensure_review_tools_are_readonly(&request.agent_id, &tools).await?;
    }

    registry
        .update_custom_agent_definition(
            &request.agent_id,
            workspace.as_deref(),
            request.name.trim().to_string(),
            request.description.trim().to_string(),
            request.prompt.trim().to_string(),
            request.tools,
            request.readonly,
            request.review,
            user_context_policy,
            request.model,
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn delete_custom_agent(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: AgentIdScopePayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid delete_custom_agent request: {error}"))?;
    let workspace = local_workspace_from_request(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_agent_mutation(&request.agent_id, workspace.as_deref())?;

    if let Some(path) = get_agent_registry()
        .remove_custom_agent(&request.agent_id)
        .map_err(|error| error.to_string())?
    {
        if let Err(error) = std::fs::remove_file(&path) {
            tracing::warn!(
                "Failed to delete custom agent file: path={}, error={}",
                path,
                error
            );
        }
    }

    if let Ok(config_service) = openbitfun_core::service::config::get_global_config_service().await
    {
        let agent_id = request.agent_id.clone();
        if let Err(error) = config_service
            .update_config("", |config: &mut GlobalConfig| {
                config.ai.agent_profiles.remove(&agent_id);
                config.app.flow_chat.remove_mode_reference(&agent_id);
                Ok(())
            })
            .await
        {
            tracing::warn!(
                "Failed to clean up config after custom agent deletion: agent_id={}, error={}",
                request.agent_id,
                error
            );
        }
    }
    if let Err(error) = openbitfun_core::service::config::reload_global_config().await {
        tracing::warn!(
            "Failed to reload global config after custom agent deletion: agent_id={}, error={}",
            request.agent_id,
            error
        );
    }
    Ok(Value::Null)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceScopePayload {
    #[serde(default, alias = "workspace_id")]
    workspace_id: Option<String>,
    #[serde(default, alias = "workspace_path")]
    workspace_path: Option<String>,
}

pub(crate) async fn reload_custom_agents(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: WorkspaceScopePayload = if request_value(args).is_null() {
        WorkspaceScopePayload::default()
    } else {
        serde_json::from_value(request_value(args).clone())
            .map_err(|error| format!("Invalid reload_custom_agents request: {error}"))?
    };
    let workspace = local_workspace_from_request(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    get_agent_registry()
        .load_custom_agents(workspace.as_deref())
        .await;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubagentIdScopePayload {
    #[serde(alias = "subagent_id")]
    subagent_id: String,
    #[serde(default, alias = "workspace_id")]
    workspace_id: Option<String>,
    #[serde(default, alias = "workspace_path")]
    workspace_path: Option<String>,
}

pub(crate) async fn get_subagent_detail(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: SubagentIdScopePayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid get_subagent_detail request: {error}"))?;
    let workspace = local_workspace_from_request(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_agent_mutation(&request.subagent_id, workspace.as_deref())?;
    let detail = get_agent_registry()
        .get_custom_subagent_detail(&request.subagent_id, workspace.as_deref())
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(detail).map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SubagentLevel {
    User,
    Project,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSubagentPayload {
    level: SubagentLevel,
    name: String,
    description: String,
    prompt: String,
    #[serde(default)]
    tools: Option<Vec<String>>,
    #[serde(default)]
    readonly: Option<bool>,
    #[serde(default)]
    review: Option<bool>,
    #[serde(default, alias = "workspace_id")]
    workspace_id: Option<String>,
    #[serde(default, alias = "workspace_path")]
    workspace_path: Option<String>,
}

pub(crate) async fn create_subagent(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request: CreateSubagentPayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid create_subagent request: {error}"))?;
    let name = request.name.trim();
    validate_subagent_name(name)?;
    let workspace = local_workspace_from_request(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    if request.level == SubagentLevel::Project && workspace.is_none() {
        return Err("Project-level Agent requires opening a workspace first".to_string());
    }

    let existing = existing_agent_ids(workspace.as_deref()).await;
    if existing.contains(name.to_lowercase().as_str()) {
        return Err(format!(
            "Name '{name}' conflicts with existing mode or Sub Agent"
        ));
    }

    let pm = state.workspace_service.path_manager();
    let agents_dir = match request.level {
        SubagentLevel::User => pm.user_agents_dir(),
        SubagentLevel::Project => {
            let ws_id = workspace.as_deref().ok_or("Workspace ID not available")?;
            let record = state
                .workspace_service
                .require_workspace(ws_id)
                .await
                .map_err(|error| error.to_string())?;
            pm.project_agents_dir(&record.root_path)
        }
    };
    std::fs::create_dir_all(&agents_dir)
        .map_err(|error| format!("Failed to create directory: {error}"))?;

    let tools = request.tools.filter(|t| !t.is_empty()).unwrap_or_else(|| {
        vec![
            "LS".to_string(),
            "Read".to_string(),
            "Glob".to_string(),
            "Grep".to_string(),
        ]
    });
    let kind = match request.level {
        SubagentLevel::User => CustomSubagentKind::User,
        SubagentLevel::Project => CustomSubagentKind::Project,
    };
    let file_path = agents_dir.join(format!("{}.md", name.to_lowercase()));
    let path_str = file_path.to_string_lossy().to_string();
    if file_path.exists() {
        return Err(format!("File '{path_str}' already exists"));
    }

    let review = request.review.unwrap_or(false);
    if review {
        ensure_review_tools_are_readonly(name, &tools).await?;
    }
    let readonly = if review {
        true
    } else {
        request.readonly.unwrap_or(true)
    };
    let mut subagent = CustomSubagent::new(
        name.to_string(),
        request.description.trim().to_string(),
        tools,
        request.prompt.trim().to_string(),
        readonly,
        path_str,
        kind,
    );
    subagent.set_review(review);
    subagent
        .save_to_file(None)
        .map_err(|error| error.to_string())?;
    get_agent_registry()
        .load_custom_agents(workspace.as_deref())
        .await;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSubagentPayload {
    #[serde(alias = "subagent_id")]
    subagent_id: String,
    description: String,
    prompt: String,
    #[serde(default)]
    tools: Option<Vec<String>>,
    #[serde(default)]
    readonly: Option<bool>,
    #[serde(default)]
    review: Option<bool>,
    #[serde(default, alias = "workspace_id")]
    workspace_id: Option<String>,
    #[serde(default, alias = "workspace_path")]
    workspace_path: Option<String>,
}

pub(crate) async fn update_subagent(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request: UpdateSubagentPayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid update_subagent request: {error}"))?;
    if request.description.trim().is_empty() {
        return Err("Description cannot be empty".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("Prompt cannot be empty".to_string());
    }
    let workspace = local_workspace_from_request(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_agent_mutation(&request.subagent_id, workspace.as_deref())?;
    get_agent_registry()
        .update_custom_subagent_definition(
            &request.subagent_id,
            workspace.as_deref(),
            request.description.trim().to_string(),
            request.prompt.trim().to_string(),
            request.tools,
            request.readonly,
            request.review,
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn delete_subagent(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request: SubagentIdScopePayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid delete_subagent request: {error}"))?;
    let workspace = local_workspace_from_request(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_agent_mutation(&request.subagent_id, workspace.as_deref())?;

    let file_path = get_agent_registry()
        .remove_subagent(&request.subagent_id)
        .map_err(|error| error.to_string())?;
    if let Some(ref path) = file_path {
        if let Err(error) = std::fs::remove_file(path) {
            tracing::warn!(
                "Failed to delete subagent file: path={}, error={}",
                path,
                error
            );
        }
    }
    if let Err(error) = openbitfun_core::service::config::reload_global_config().await {
        tracing::warn!(
            "Failed to reload global config after subagent deletion: subagent_id={}, error={}",
            request.subagent_id,
            error
        );
    }
    Ok(Value::Null)
}

pub(crate) async fn reload_subagents(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request: WorkspaceScopePayload = if request_value(args).is_null() {
        WorkspaceScopePayload::default()
    } else {
        serde_json::from_value(request_value(args).clone())
            .map_err(|error| format!("Invalid reload_subagents request: {error}"))?
    };
    let workspace_id = local_workspace_from_request(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?
    .ok_or_else(|| "workspaceId is required to reload project subagents".to_string())?;
    get_agent_registry()
        .load_custom_subagents(workspace_id.as_str())
        .await;
    Ok(Value::Null)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSubagentConfigPayload {
    #[serde(alias = "subagent_id")]
    subagent_id: String,
    #[serde(default, alias = "parent_agent_type")]
    parent_agent_type: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default, alias = "clear_model_override")]
    clear_model_override: bool,
    #[serde(default, alias = "workspace_id")]
    workspace_id: Option<String>,
    #[serde(default, alias = "workspace_path")]
    workspace_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSubagentConfigResponse {
    availability_updated: bool,
    model_updated: bool,
}

pub(crate) async fn update_subagent_config(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: UpdateSubagentConfigPayload = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid update_subagent_config request: {error}"))?;
    let subagent_id = &request.subagent_id;
    let workspace = local_workspace_from_request(
        state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
    )
    .await?;
    reject_external_agent_mutation(subagent_id, workspace.as_deref())?;
    let registry = get_agent_registry();
    if let Some(workspace) = workspace.as_deref() {
        registry.load_custom_subagents(workspace).await;
    }

    let mut availability_updated = false;
    let mut model_updated = false;

    if request.model.is_some() && request.clear_model_override {
        return Err("model and clearModelOverride cannot be provided together".to_string());
    }

    if let Some(enabled) = request.enabled {
        let parent_agent_type = request.parent_agent_type.as_deref().ok_or_else(|| {
            "parentAgentType is required when updating subagent availability".to_string()
        })?;
        registry
            .update_subagent_override(
                parent_agent_type,
                subagent_id,
                enabled,
                workspace.as_deref(),
            )
            .await
            .map_err(|error| format!("Failed to update subagent availability: {error}"))?;
        availability_updated = true;
    }

    if registry
        .get_custom_subagent_config(subagent_id, workspace.as_deref())
        .is_some()
    {
        if request.model.is_some() || request.clear_model_override {
            registry
                .update_and_save_custom_subagent_config(
                    subagent_id,
                    request.model,
                    request.clear_model_override,
                    workspace.as_deref(),
                )
                .map_err(|error| format!("Failed to update configuration: {error}"))?;
            model_updated = true;
        }
    } else {
        if registry.has_project_custom_subagent(subagent_id) {
            if let Some(workspace) = workspace.as_deref() {
                return Err(format!(
                    "Project Sub-Agent '{subagent_id}' was not found in workspace '{workspace}'"
                ));
            }
            return Err(format!(
                "workspaceId is required to update project Sub-Agent '{subagent_id}'"
            ));
        }

        if request.clear_model_override || request.model.is_some() {
            let config_service = openbitfun_core::service::config::get_global_config_service()
                .await
                .map_err(|error| format!("Failed to get config service: {error}"))?;
            let mut builtin_models: HashMap<String, AgentModelSelection> = config_service
                .get_config(Some("ai.agent_model_selections.subagents.builtin"))
                .await
                .map_err(|error| format!("Failed to read model selections: {error}"))?;
            if request.clear_model_override {
                builtin_models.remove(subagent_id);
            } else {
                let model = request.model.as_deref().unwrap_or_default().trim();
                let selection = if model == "inherit" {
                    AgentModelSelection::Inherit
                } else {
                    AgentModelSelection::Model {
                        model_ref: model.to_string(),
                    }
                };
                builtin_models.insert(subagent_id.clone(), selection);
            }
            config_service
                .set_config(
                    "ai.agent_model_selections.subagents.builtin",
                    &builtin_models,
                )
                .await
                .map_err(|error| format!("Failed to update model configuration: {error}"))?;
            model_updated = true;
        }

        if model_updated || availability_updated {
            if let Err(error) = openbitfun_core::service::config::reload_global_config().await {
                tracing::warn!(
                    "Failed to reload global config after subagent config update: subagent_id={}, error={}",
                    subagent_id,
                    error
                );
            }
        }
    }

    serde_json::to_value(UpdateSubagentConfigResponse {
        availability_updated,
        model_updated,
    })
    .map_err(|error| error.to_string())
}

pub(crate) async fn set_agent_profile_config(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let agent_id = get_string(request, "agentId")?;
    let config = request
        .get("config")
        .cloned()
        .ok_or_else(|| "Missing 'config' field".to_string())?;
    openbitfun_core::service::config::mode_config_canonicalizer::persist_agent_profile_from_value(
        &agent_id, config,
    )
    .await
    .map_err(|error| format!("Failed to set agent profile config: {error}"))?;
    Ok(json!(format!(
        "Agent profile for '{agent_id}' set successfully"
    )))
}

pub(crate) async fn reset_agent_profile_config(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let agent_id = get_string(request, "agentId")?;
    openbitfun_core::service::config::mode_config_canonicalizer::reset_agent_profile_to_default(
        &agent_id,
    )
    .await
    .map_err(|error| format!("Failed to reset agent profile config: {error}"))?;
    Ok(json!(format!(
        "Agent profile for '{agent_id}' reset successfully"
    )))
}

#[cfg(test)]
mod tests {
    use super::{validate_agent_id, validate_subagent_name};

    #[test]
    fn agent_id_and_subagent_name_validation_match_desktop_rules() {
        assert!(validate_agent_id("my_agent-1").is_ok());
        assert!(validate_agent_id("").is_err());
        assert!(validate_agent_id("1invalid").is_err());
        assert!(validate_agent_id("bad/id").is_err());

        assert!(validate_subagent_name("Code_Helper-2").is_ok());
        assert!(validate_subagent_name("").is_err());
        assert!(validate_subagent_name("9bad").is_err());
        assert!(validate_subagent_name("has space").is_err());
    }
}
