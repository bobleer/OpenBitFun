//! External compatibility HostInvoke handlers for CLI Peer Host.

use openbitfun_core::external_sources::{
    apply_external_source_control_action, choose_external_mcp_conflict,
    choose_external_subagent_conflict, external_source_discovery_snapshot,
    external_source_snapshot, get_external_source_control_snapshot,
    set_external_mcp_server_decision, set_external_mcp_servers_enabled,
    set_external_prompt_command_conflict_choice, set_external_source_enabled,
    set_external_subagent_activation, set_external_subagent_model_binding,
    set_external_subagents_enabled, set_external_tool_conflict_choice,
    set_external_tool_target_decision, set_external_tool_targets_enabled,
    update_external_integration_policy, ExternalIntegrationPolicyMutation,
    ExternalSourceControlRequestV1, ExternalSourceHostCapabilities, ExternalSourceOperationError,
    ExternalSourceOperationErrorCode, ExternalSourceOperationResult, ExternalSourcePublicSnapshot,
    ExternalSubagentModelBindingTarget,
};
use serde_json::Value;

use crate::peer_host::args::request_value;
use crate::peer_host::state::PeerHostState;

fn required_bool(request: &Value, key: &str) -> ExternalSourceOperationResult<bool> {
    optional_bool_field(request, key)?.ok_or_else(|| {
        ExternalSourceOperationError::invalid_request(format!("Missing or invalid '{key}'"))
    })
}

fn required_string(request: &Value, key: &str) -> ExternalSourceOperationResult<String> {
    optional_string_field(request, key)?.ok_or_else(|| {
        ExternalSourceOperationError::invalid_request(format!("Missing or invalid '{key}'"))
    })
}

fn optional_bool_field(request: &Value, key: &str) -> ExternalSourceOperationResult<Option<bool>> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        _ => Err(ExternalSourceOperationError::invalid_request(format!(
            "'{key}' must be a boolean when provided"
        ))),
    }
}

fn optional_string_field(
    request: &Value,
    key: &str,
) -> ExternalSourceOperationResult<Option<String>> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        _ => Err(ExternalSourceOperationError::invalid_request(format!(
            "'{key}' must be a non-empty string when provided"
        ))),
    }
}

fn required_u64(request: &Value, key: &str) -> ExternalSourceOperationResult<u64> {
    request.get(key).and_then(Value::as_u64).ok_or_else(|| {
        ExternalSourceOperationError::invalid_request(format!("Missing or invalid '{key}'"))
    })
}

fn decision_pairs(
    request: &Value,
    first_key: &str,
    second_key: &str,
) -> ExternalSourceOperationResult<Vec<(String, String)>> {
    let decisions = request
        .get("decisions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ExternalSourceOperationError::invalid_request("Missing or invalid 'decisions'")
        })?;
    decisions
        .iter()
        .map(|decision| {
            Ok((
                required_string(decision, first_key)?,
                required_string(decision, second_key)?,
            ))
        })
        .collect()
}

fn model_binding_target_field(
    request: &Value,
    key: &str,
) -> ExternalSourceOperationResult<Option<ExternalSubagentModelBindingTarget>> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| {
                ExternalSourceOperationError::invalid_request(format!(
                    "'{key}' must be a valid external subagent model binding target"
                ))
            }),
    }
}

pub(super) async fn workspace_id(
    state: &PeerHostState,
    request: &Value,
) -> ExternalSourceOperationResult<Option<String>> {
    let id = optional_string_field(request, "workspaceId")?;
    let legacy = optional_string_field(request, "workspacePath")?;
    if id.is_none() && legacy.is_none() {
        return Ok(None);
    }
    let workspace = state
        .workspace_service
        .resolve_legacy_workspace_reference(
            id.as_deref(),
            legacy.as_deref().unwrap_or_default(),
            None,
            None,
        )
        .await
        .map_err(|error| ExternalSourceOperationError::invalid_request(error.to_string()))?
        .ok_or_else(|| {
            ExternalSourceOperationError::invalid_request("Unknown workspace reference")
        })?;
    if workspace.workspace_kind == openbitfun_core::service::workspace::WorkspaceKind::Remote {
        return Err(ExternalSourceOperationError::host_capability_unavailable(
            "External sources do not support remote workspaces",
        ));
    }
    Ok(Some(workspace.id))
}

fn public_snapshot(
    snapshot: openbitfun_core::external_sources::ExternalSourceCatalogSnapshot,
) -> ExternalSourceOperationResult<Value> {
    serde_json::to_value(ExternalSourcePublicSnapshot::from(snapshot)).map_err(|_| {
        ExternalSourceOperationError::new(
            ExternalSourceOperationErrorCode::Internal,
            "External source response could not be encoded",
            false,
        )
    })
}

pub(crate) async fn dispatch(
    command: &str,
    args: &Value,
    state: &PeerHostState,
) -> Result<Value, String> {
    dispatch_inner(command, args, state)
        .await
        .map_err(|error| error.encode())
}

async fn dispatch_inner(
    command: &str,
    args: &Value,
    state: &PeerHostState,
) -> ExternalSourceOperationResult<Value> {
    if command == "reveal_external_source_location" {
        return Err(ExternalSourceOperationError::host_capability_unavailable(
            "This Peer Host cannot reveal source locations in its file manager",
        ));
    }
    let request = request_value(args);
    let workspace = workspace_id(state, request).await?;
    let workspace = workspace.as_deref();
    if command == "get_external_source_discovery_snapshot" {
        let snapshot = external_source_discovery_snapshot(
            workspace,
            optional_bool_field(request, "forceRefresh")?.unwrap_or(false),
            ExternalSourceHostCapabilities::read_write(),
        )
        .await
        .map_err(openbitfun_core::external_sources::sanitize_external_source_operation_error)?;
        return serde_json::to_value(snapshot).map_err(|_| {
            ExternalSourceOperationError::new(
                ExternalSourceOperationErrorCode::Internal,
                "External discovery response could not be encoded",
                false,
            )
        });
    }
    if command == "get_external_source_control_snapshot" {
        let snapshot = get_external_source_control_snapshot(
            workspace,
            optional_bool_field(request, "forceRefresh")?.unwrap_or(false),
            ExternalSourceHostCapabilities::read_write(),
        )
        .await?;
        return serde_json::to_value(snapshot).map_err(|_| {
            ExternalSourceOperationError::new(
                ExternalSourceOperationErrorCode::Internal,
                "External source control response could not be encoded",
                false,
            )
        });
    }
    if command == "apply_external_source_control_action_command" {
        let control = request.get("control").ok_or_else(|| {
            ExternalSourceOperationError::invalid_request("Missing control request")
        })?;
        let snapshot =
            apply_external_source_control_action(workspace, control_request(control)?).await?;
        return serde_json::to_value(snapshot).map_err(|_| {
            ExternalSourceOperationError::new(
                ExternalSourceOperationErrorCode::Internal,
                "External source control response could not be encoded",
                false,
            )
        });
    }
    let snapshot = match command {
        "get_external_source_snapshot" => {
            external_source_snapshot(
                workspace,
                optional_bool_field(request, "forceRefresh")?.unwrap_or(false),
            )
            .await
        }
        "set_external_source_enabled_command" => {
            set_external_source_enabled(
                workspace,
                &required_string(request, "sourceKey")?,
                required_bool(request, "enabled")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_source_conflict_choice_command" => {
            set_external_prompt_command_conflict_choice(
                workspace,
                &required_string(request, "conflictKey")?,
                &required_string(request, "candidateId")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_tool_target_decision_command" => {
            set_external_tool_target_decision(
                workspace,
                &required_string(request, "approvalKey")?,
                &required_string(request, "decisionKey")?,
                required_bool(request, "approved")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_tool_targets_enabled_command" => {
            set_external_tool_targets_enabled(
                workspace,
                decision_pairs(request, "approvalKey", "decisionKey")?,
                required_bool(request, "enabled")?,
                required_u64(request, "expectedCatalogGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_tool_conflict_choice_command" => {
            set_external_tool_conflict_choice(
                workspace,
                &required_string(request, "conflictKey")?,
                &required_string(request, "candidateId")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_subagent_activation_command" => {
            set_external_subagent_activation(
                workspace,
                &required_string(request, "candidateId")?,
                required_bool(request, "approved")?,
                required_u64(request, "expectedSubagentGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
                &required_string(request, "decisionKey")?,
            )
            .await
        }
        "set_external_subagents_enabled_command" => {
            set_external_subagents_enabled(
                workspace,
                decision_pairs(request, "candidateId", "decisionKey")?,
                required_bool(request, "enabled")?,
                required_u64(request, "expectedSubagentGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_subagent_model_binding_command" => {
            set_external_subagent_model_binding(
                workspace,
                &required_string(request, "bindingKey")?,
                model_binding_target_field(request, "target")?,
                required_u64(request, "expectedSubagentGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "choose_external_subagent_conflict_command" => {
            choose_external_subagent_conflict(
                workspace,
                &required_string(request, "conflictKey")?,
                &required_string(request, "candidateId")?,
                optional_bool_field(request, "approveExternal")?.unwrap_or(false),
                required_u64(request, "expectedSubagentGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_mcp_server_decision_command" => {
            set_external_mcp_server_decision(
                workspace,
                &required_string(request, "candidateId")?,
                &required_string(request, "decisionKey")?,
                required_bool(request, "approved")?,
                required_u64(request, "expectedMcpGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "set_external_mcp_servers_enabled_command" => {
            set_external_mcp_servers_enabled(
                workspace,
                decision_pairs(request, "candidateId", "decisionKey")?,
                required_bool(request, "enabled")?,
                required_u64(request, "expectedMcpGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "choose_external_mcp_conflict_command" => {
            choose_external_mcp_conflict(
                workspace,
                &required_string(request, "conflictKey")?,
                &required_string(request, "candidateId")?,
                optional_bool_field(request, "approveExternal")?.unwrap_or(false),
                required_u64(request, "expectedMcpGeneration")?,
                required_u64(request, "expectedPreferenceRevision")?,
            )
            .await
        }
        "update_external_integration_policy_command" => {
            let mutation = request
                .get("mutation")
                .cloned()
                .ok_or_else(|| ExternalSourceOperationError::invalid_request("Missing mutation"))?;
            let mutation: ExternalIntegrationPolicyMutation = serde_json::from_value(mutation)
                .map_err(|_| {
                    ExternalSourceOperationError::invalid_request("Invalid policy mutation")
                })?;
            update_external_integration_policy(workspace, mutation).await
        }
        _ => {
            return Err(ExternalSourceOperationError::host_capability_unavailable(
                format!("External compatibility command '{command}' is not supported"),
            ))
        }
    }
    .map_err(openbitfun_core::external_sources::sanitize_external_source_operation_error)?;

    public_snapshot(snapshot)
}

pub(crate) async fn plan_external_mcp_import_command(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let plan = openbitfun_core::external_mcp_import::plan_external_mcp_import(workspace)
        .await
        .map_err(|error| error.encode())?;
    serde_json::to_value(plan).map_err(|error| error.to_string())
}

pub(crate) async fn apply_external_mcp_import_command(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let import_request_val = request
        .get("importRequest")
        .or_else(|| request.get("import_request"))
        .cloned()
        .ok_or_else(|| {
            ExternalSourceOperationError::invalid_request("Missing 'importRequest'").encode()
        })?;
    let import_request: openbitfun_product_domains::external_sources::ExternalMcpImportApplyRequestV1 =
        serde_json::from_value(import_request_val).map_err(|error| {
            ExternalSourceOperationError::invalid_request(format!(
                "Invalid importRequest: {error}"
            ))
            .encode()
        })?;
    let result =
        openbitfun_core::external_mcp_import::apply_external_mcp_import(workspace, import_request)
            .await
            .map_err(|error| error.encode())?;
    serde_json::to_value(result).map_err(|error| error.to_string())
}

pub(crate) async fn list_removed_external_sessions(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let ecosystem_id = required_string(request, "ecosystemId")
        .or_else(|_| required_string(request, "ecosystem_id"))
        .map_err(|error| error.encode())?;
    let sessions =
        openbitfun_core::external_session_import::list_removed_external_sessions(&ecosystem_id)
            .await
            .map_err(|error| error.encode())?;
    serde_json::to_value(sessions).map_err(|error| error.to_string())
}

pub(crate) async fn restore_removed_external_session(args: &Value) -> Result<Value, String> {
    let request: openbitfun_product_domains::session_import::RestoreRemovedExternalSessionRequest =
        serde_json::from_value(request_value(args).clone()).map_err(|error| {
            ExternalSourceOperationError::invalid_request(format!(
                "Invalid restore_removed_external_session request: {error}"
            ))
            .encode()
        })?;
    openbitfun_core::external_session_import::restore_removed_external_session(request)
        .await
        .map_err(|error| error.encode())?;
    Ok(Value::Null)
}

pub(crate) async fn get_instruction_source_catalog(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let root = if let Some(id) = id.as_deref() {
        Some(
            state
                .workspace_service
                .require_workspace(id)
                .await
                .map_err(|error| {
                    ExternalSourceOperationError::invalid_request(error.to_string()).encode()
                })?
                .root_path,
        )
    } else {
        None
    };
    let catalog =
        openbitfun_core::external_sources::instruction_source_catalog(root.as_deref()).await;
    serde_json::to_value(catalog).map_err(|error| error.to_string())
}

pub(crate) async fn get_workspace_reference_snapshot(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let force_refresh = optional_bool_field(request, "forceRefresh")
        .map_err(|error| error.encode())?
        .unwrap_or(false);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?
        .ok_or_else(|| {
            ExternalSourceOperationError::invalid_request("Workspace ID is required").encode()
        })?;
    let workspace = state
        .workspace_service
        .require_workspace(&id)
        .await
        .map_err(|error| {
            ExternalSourceOperationError::invalid_request(error.to_string()).encode()
        })?;
    let snapshot = openbitfun_core::external_sources::workspace_reference_snapshot(
        &workspace.id,
        &workspace.related_paths,
        force_refresh,
    )
    .await
    .map_err(|error| {
        openbitfun_core::external_sources::sanitize_external_source_operation_error(error).encode()
    })?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

pub(crate) async fn get_external_ecosystem_awareness_command(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let unacknowledged_ecosystem_ids =
        openbitfun_core::external_sources::unacknowledged_external_ecosystems(id.as_deref())
            .await
            .map_err(|error| {
                openbitfun_core::external_sources::sanitize_external_source_operation_error(error)
                    .encode()
            })?;
    Ok(serde_json::json!({
        "unacknowledgedEcosystemIds": unacknowledged_ecosystem_ids,
    }))
}

pub(crate) async fn acknowledge_external_ecosystems_command(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let ecosystem_ids: Vec<String> = serde_json::from_value(
        request
            .get("ecosystemIds")
            .or_else(|| request.get("ecosystem_ids"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|error| {
        ExternalSourceOperationError::invalid_request(format!("Invalid ecosystemIds: {error}"))
            .encode()
    })?;
    openbitfun_core::external_sources::acknowledge_external_ecosystems(
        id.as_deref(),
        ecosystem_ids,
    )
    .await
    .map_err(|error| {
        openbitfun_core::external_sources::sanitize_external_source_operation_error(error).encode()
    })?;
    Ok(Value::Null)
}

pub(crate) async fn get_native_prompt_command_conflicts_command(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let native_commands = serde_json::from_value(
        request
            .get("nativeCommands")
            .or_else(|| request.get("native_commands"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|error| {
        ExternalSourceOperationError::invalid_request(format!("Invalid nativeCommands: {error}"))
            .encode()
    })?;
    let response = openbitfun_core::external_sources::native_prompt_command_conflicts(
        id.as_deref(),
        native_commands,
    )
    .await
    .map_err(|error| {
        openbitfun_core::external_sources::sanitize_external_source_operation_error(error).encode()
    })?;
    serde_json::to_value(response).map_err(|error| error.to_string())
}

pub(crate) async fn set_native_prompt_command_conflict_choice_command(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let native_commands = serde_json::from_value(
        request
            .get("nativeCommands")
            .or_else(|| request.get("native_commands"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|error| {
        ExternalSourceOperationError::invalid_request(format!("Invalid nativeCommands: {error}"))
            .encode()
    })?;
    let selected_candidate_id =
        required_string(request, "selectedCandidateId").map_err(|error| error.encode())?;
    let expected_preference_revision =
        required_u64(request, "expectedPreferenceRevision").map_err(|error| error.encode())?;
    let response = openbitfun_core::external_sources::set_native_prompt_command_conflict_choice(
        id.as_deref(),
        native_commands,
        &selected_candidate_id,
        expected_preference_revision,
    )
    .await
    .map_err(|error| {
        openbitfun_core::external_sources::sanitize_external_source_operation_error(error).encode()
    })?;
    serde_json::to_value(response).map_err(|error| error.to_string())
}

pub(crate) async fn expand_external_prompt_command_command(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let name = required_string(request, "name").map_err(|error| error.encode())?;
    let arguments = request
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let native_commands = serde_json::from_value(
        request
            .get("nativeCommands")
            .or_else(|| request.get("native_commands"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|error| {
        ExternalSourceOperationError::invalid_request(format!("Invalid nativeCommands: {error}"))
            .encode()
    })?;
    let candidate_id = required_string(request, "candidateId").map_err(|error| error.encode())?;
    let expected_content_version =
        required_string(request, "expectedContentVersion").map_err(|error| error.encode())?;
    let expected_native_conflict_key = optional_string_field(request, "expectedNativeConflictKey")
        .map_err(|error| error.encode())?;
    let expected_preference_revision = request
        .get("expectedPreferenceRevision")
        .and_then(Value::as_u64);
    let shell_review_decision = request
        .get("shellReviewDecision")
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .map_err(|error| {
            ExternalSourceOperationError::invalid_request(format!(
                "Invalid shellReviewDecision: {error}"
            ))
            .encode()
        })?;
    let response = openbitfun_core::external_sources::expand_external_prompt_command(
        id.as_deref(),
        &name,
        arguments,
        native_commands,
        Some(&candidate_id),
        Some(&expected_content_version),
        expected_native_conflict_key.as_deref(),
        expected_preference_revision,
        shell_review_decision.as_ref(),
    )
    .await
    .map_err(|error| {
        openbitfun_core::external_sources::sanitize_external_source_operation_error(error).encode()
    })?;
    serde_json::to_value(response).map_err(|error| error.to_string())
}

pub(crate) async fn get_external_hook_catalog(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let force_refresh = optional_bool_field(request, "forceRefresh")
        .map_err(|error| error.encode())?
        .unwrap_or(false);
    let snapshot = openbitfun_core::external_hooks::local_external_hook_catalog_snapshot(
        id.as_deref(),
        force_refresh,
    )
    .await
    .map_err(|error| error.encode())?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

pub(crate) async fn get_external_hook_import_snapshot(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let refresh_updates = optional_bool_field(request, "refreshUpdates")
        .map_err(|error| error.encode())?
        .unwrap_or(false);
    let snapshot = openbitfun_core::external_hook_import::external_hook_import_snapshot(
        id.as_deref(),
        refresh_updates,
    )
    .await
    .map_err(|error| error.encode())?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

pub(crate) async fn plan_external_hook_import_command(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let source = serde_json::from_value(request.get("source").cloned().ok_or_else(|| {
        ExternalSourceOperationError::invalid_request("Missing 'source'").encode()
    })?)
    .map_err(|error| {
        ExternalSourceOperationError::invalid_request(format!("Invalid source: {error}")).encode()
    })?;
    let plan =
        openbitfun_core::external_hook_import::plan_external_hook_import(id.as_deref(), source)
            .await
            .map_err(|error| error.encode())?;
    serde_json::to_value(plan).map_err(|error| error.to_string())
}

pub(crate) async fn apply_external_hook_import_command(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let import_request = serde_json::from_value(
        request
            .get("importRequest")
            .or_else(|| request.get("import_request"))
            .cloned()
            .ok_or_else(|| {
                ExternalSourceOperationError::invalid_request("Missing 'importRequest'").encode()
            })?,
    )
    .map_err(|error| {
        ExternalSourceOperationError::invalid_request(format!("Invalid importRequest: {error}"))
            .encode()
    })?;
    let result = openbitfun_core::external_hook_import::apply_external_hook_import(
        id.as_deref(),
        import_request,
    )
    .await
    .map_err(|error| error.encode())?;
    serde_json::to_value(result).map_err(|error| error.to_string())
}

pub(crate) async fn mutate_external_hook_import_command(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let id = workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    let mutation = serde_json::from_value(request.get("mutation").cloned().ok_or_else(|| {
        ExternalSourceOperationError::invalid_request("Missing 'mutation'").encode()
    })?)
    .map_err(|error| {
        ExternalSourceOperationError::invalid_request(format!("Invalid mutation: {error}")).encode()
    })?;
    let snapshot =
        openbitfun_core::external_hook_import::mutate_external_hook_import(id.as_deref(), mutation)
            .await
            .map_err(|error| error.encode())?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

fn control_request(
    request: &Value,
) -> ExternalSourceOperationResult<ExternalSourceControlRequestV1> {
    serde_json::from_value(request.clone()).map_err(|_| {
        ExternalSourceOperationError::invalid_request("Invalid external source control request")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core::external_sources::ExternalSourceControlActionV1;

    #[test]
    fn optional_host_fields_reject_wrong_types() {
        let request = serde_json::json!({
            "workspacePath": false,
            "forceRefresh": "false"
        });
        assert_eq!(
            optional_string_field(&request, "workspacePath")
                .unwrap_err()
                .code,
            ExternalSourceOperationErrorCode::InvalidRequest
        );
        assert_eq!(
            optional_bool_field(&request, "forceRefresh")
                .unwrap_err()
                .code,
            ExternalSourceOperationErrorCode::InvalidRequest
        );
    }

    #[test]
    fn peer_errors_use_the_shared_typed_envelope() {
        let encoded = ExternalSourceOperationError::new(
            ExternalSourceOperationErrorCode::StaleRevision,
            "Refresh before retrying",
            true,
        )
        .encode();
        let value: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(value["code"], "stale_revision");
        assert_eq!(value["retryable"], true);
    }

    #[test]
    fn peer_host_does_not_advertise_desktop_local_reveal_actions() {
        assert!(!ExternalSourceHostCapabilities::read_write().can_reveal_source_location);
    }

    #[test]
    fn peer_control_request_deserializes_the_shared_action() {
        let request = serde_json::json!({
            "schemaVersion": 1,
            "operationId": "peer-safe-mode",
            "expectedPreferenceRevision": 3,
            "action": { "type": "set_safe_mode", "enabled": true }
        });

        let control = control_request(&request).unwrap();

        assert!(matches!(
            control.action,
            ExternalSourceControlActionV1::SetSafeMode { enabled: true }
        ));
    }

    #[test]
    fn peer_model_binding_target_parser_accepts_set_and_clear_shapes() {
        let set = serde_json::json!({
            "target": { "kind": "primary" }
        });
        assert_eq!(
            model_binding_target_field(&set, "target").unwrap(),
            Some(ExternalSubagentModelBindingTarget::Primary)
        );

        let clear = serde_json::json!({ "target": null });
        assert_eq!(model_binding_target_field(&clear, "target").unwrap(), None);

        let invalid = serde_json::json!({ "target": { "kind": "automatic" } });
        assert_eq!(
            model_binding_target_field(&invalid, "target")
                .unwrap_err()
                .code,
            ExternalSourceOperationErrorCode::InvalidRequest
        );
    }

    #[test]
    fn peer_bulk_decisions_preserve_the_reviewed_identity_pairs() {
        let request = serde_json::json!({
            "decisions": [
                { "candidateId": "agent-a", "decisionKey": "decision-a" },
                { "candidateId": "agent-b", "decisionKey": "decision-b" }
            ]
        });

        assert_eq!(
            decision_pairs(&request, "candidateId", "decisionKey").unwrap(),
            vec![
                ("agent-a".to_string(), "decision-a".to_string()),
                ("agent-b".to_string(), "decision-b".to_string()),
            ]
        );
    }
}
