//! Skill discovery and management HostInvoke handlers.
//!
//! Discovery and policy storage are owned by Core `SkillRegistry` and
//! `mode_overrides`; this adapter resolves the workspace the controller
//! selected and applies the same ownership/capability rules as Desktop.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use openbitfun_core::agentic::tools::implementations::skills::mode_overrides::{
    clear_user_mode_skill_overrides, load_globally_disabled_project_skills,
    load_globally_disabled_user_skills, load_project_mode_skills_document_local,
    project_mode_skills_path_for_remote, save_project_mode_skills_document_local,
    set_disabled_mode_skills_in_document, set_global_project_skill_disabled,
    set_global_user_skill_disabled, set_mode_skill_disabled_in_document, set_user_mode_skill_state,
    SkillPolicyWorkspace,
};
use openbitfun_core::agentic::tools::implementations::skills::registry::imports::{
    self as skill_imports, SkillImportPreview,
};
use openbitfun_core::agentic::tools::implementations::skills::{
    resolver::resolve_skill_default_enabled_for_mode, SkillData, SkillInfo, SkillLocation,
    SkillRegistry, SkillScanReport,
};
use openbitfun_core::agentic::workspace::RemoteWorkspaceFs;
use openbitfun_core::infrastructure::get_path_manager_arc;
use openbitfun_core::service::config::agent_profile_project_store::{
    deserialize_project_agent_profiles_document, serialize_project_agent_profiles_document,
};
use openbitfun_core::service::workspace::{
    get_global_workspace_service, WorkspaceInfo, WorkspaceKind,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::peer_host::args::{get_string, optional_bool, optional_string, request_value};

const REMOTE_SKILL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(60);

fn can_delete_owned_skill(source_id: &str, source_slot: &str, is_builtin: bool) -> bool {
    if is_builtin {
        return false;
    }
    let source_id = source_id.trim().to_ascii_lowercase();
    if !source_id.is_empty() {
        return matches!(source_id.as_str(), "openbitfun" | "openbitfun-system");
    }
    source_slot
        .trim()
        .to_ascii_lowercase()
        .starts_with("openbitfun")
}

fn can_toggle_skill(level: &str, remote_workspace: bool) -> bool {
    !(remote_workspace && level.eq_ignore_ascii_case("project"))
}

fn annotate_skill_capabilities(response: &mut Value, remote_workspace: bool) {
    let rows = match response {
        Value::Array(rows) => rows,
        Value::Object(object) => match object.get_mut("skills") {
            Some(Value::Array(rows)) => rows,
            _ => return,
        },
        _ => return,
    };
    for row in rows {
        let Some(object) = row.as_object_mut() else {
            continue;
        };
        let text = |key: &str| object.get(key).and_then(Value::as_str).unwrap_or_default();
        let can_delete = can_delete_owned_skill(
            text("sourceId"),
            text("sourceSlot"),
            object
                .get("isBuiltin")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
        let can_toggle = can_toggle_skill(text("level"), remote_workspace);
        object.insert("canDelete".into(), Value::Bool(can_delete));
        object.insert("canToggle".into(), Value::Bool(can_toggle));
    }
}

fn ensure_skill_can_be_deleted(skill: &SkillInfo) -> Result<(), String> {
    if can_delete_owned_skill(&skill.source_id, &skill.source_slot, skill.is_builtin) {
        Ok(())
    } else {
        Err("Only OpenBitFun-owned, non-built-in Skills can be deleted from OpenBitFun".to_string())
    }
}

fn normalize_skill_key_list(keys: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for key in keys {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            continue;
        }
        let owned = trimmed.to_string();
        if seen.insert(owned.clone()) {
            normalized.push(owned);
        }
    }
    normalized
}

async fn resolve_workspace(request: &Value) -> Result<Option<WorkspaceInfo>, String> {
    let id = optional_string(request, "workspaceId");
    let legacy_path = optional_string(request, "workspacePath");
    if id.is_none() && legacy_path.is_none() {
        return Ok(None);
    }
    let service = get_global_workspace_service().ok_or("Workspace service is unavailable")?;
    if let Some(id) = id {
        return service
            .require_workspace(&id)
            .await
            .map(Some)
            .map_err(|error| error.to_string());
    }
    // Pre-ID controllers still send a path; normal callers select a catalog ID.
    service
        .resolve_legacy_workspace_reference(
            None,
            legacy_path.as_deref().unwrap_or_default(),
            None,
            None,
        )
        .await
        .map_err(|error| error.to_string())?
        .map(Some)
        .ok_or_else(|| "Legacy Skill workspace cannot be resolved".to_string())
}

async fn remote_workspace_fs(
    workspace: Option<&WorkspaceInfo>,
) -> Result<Option<(String, RemoteWorkspaceFs)>, String> {
    let Some(record) = workspace else {
        return Ok(None);
    };
    let Some(connection) = record.filesystem_connection_id()? else {
        return Ok(None);
    };
    let connection = connection.to_owned();
    let services =
        openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services()
            .await?;
    let file_service = services
        .get_file_service()
        .await
        .ok_or("Remote file service is unavailable")?;
    Ok(Some((
        record.root_path.to_string_lossy().into_owned(),
        RemoteWorkspaceFs::new(connection, file_service),
    )))
}

async fn within_remote_deadline<T>(
    discovery: impl std::future::Future<Output = T>,
) -> Result<T, String> {
    tokio::time::timeout(REMOTE_SKILL_DISCOVERY_TIMEOUT, discovery)
        .await
        .map_err(|_| {
            format!(
                "Remote Skill discovery timed out after {} seconds. Check the SSH/SFTP connection and retry.",
                REMOTE_SKILL_DISCOVERY_TIMEOUT.as_secs()
            )
        })
}

/// Older controllers expect a bare array unless they asked for diagnostics.
fn scan_response<T: Serialize>(
    report: SkillScanReport<T>,
    include_diagnostics: bool,
) -> Result<Value, String> {
    let value = if include_diagnostics {
        serde_json::to_value(report)
    } else {
        serde_json::to_value(report.skills)
    };
    value.map_err(|error| format!("Failed to serialize skill configs: {error}"))
}

pub(crate) async fn get_skill_configs(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let workspace = resolve_workspace(request).await?;
    let registry = SkillRegistry::global();
    if optional_bool(request, "forceRefresh").unwrap_or(false) {
        registry.refresh().await;
    }
    let remote = remote_workspace_fs(workspace.as_ref()).await?;
    let is_remote = remote.is_some();
    let report = if let Some((root, fs)) = remote {
        within_remote_deadline(registry.get_skill_scan_report_for_remote_workspace(&fs, &root))
            .await?
    } else {
        let root = workspace.as_ref().map(|record| record.root_path.as_path());
        registry.get_skill_scan_report_for_workspace(root).await
    };
    let mut response = scan_response(
        report,
        optional_bool(request, "includeDiagnostics").unwrap_or(false),
    )?;
    annotate_skill_capabilities(&mut response, is_remote);
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "importOperationsVersion".into(),
            Value::from(if is_remote { 0 } else { 3 }),
        );
    }
    Ok(response)
}

pub(crate) async fn get_mode_skill_configs(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let mode_id = get_string(request, "modeId")?;
    let summary_ids = request
        .get("summaryModeIds")
        .filter(|value| !value.is_null())
        .map(|value| {
            serde_json::from_value::<Vec<String>>(value.clone())
                .map_err(|error| format!("Invalid summaryModeIds: {error}"))
        })
        .transpose()?;
    let include_diagnostics = optional_bool(request, "includeDiagnostics").unwrap_or(false);
    let summary = include_diagnostics && summary_ids.is_some();
    let mut mode_ids = if summary {
        summary_ids.unwrap_or_default()
    } else {
        Vec::new()
    };
    if !mode_ids.contains(&mode_id) {
        mode_ids.push(mode_id.clone());
    }
    let workspace = resolve_workspace(request).await?;
    let registry = SkillRegistry::global();
    if optional_bool(request, "forceRefresh").unwrap_or(false) {
        registry.refresh().await;
    }
    let mut reports = if let Some((root, fs)) = remote_workspace_fs(workspace.as_ref()).await? {
        within_remote_deadline(
            registry.get_mode_skill_scan_reports_for_remote_workspace(&fs, &root, &mode_ids),
        )
        .await?
    } else {
        registry
            .get_mode_skill_scan_reports_for_workspace(
                workspace.as_ref().map(SkillPolicyWorkspace::from_record),
                &mode_ids,
            )
            .await
    };
    let counts: std::collections::HashMap<String, usize> = reports
        .iter()
        .map(|(id, report)| {
            (
                id.clone(),
                report
                    .skills
                    .iter()
                    .filter(|skill| skill.effective_enabled)
                    .count(),
            )
        })
        .collect();
    let report = reports
        .remove(&mode_id)
        .expect("The anchor mode is included in the summary");
    let mut response = scan_response(report, include_diagnostics)?;
    if summary {
        let object = response
            .as_object_mut()
            .expect("Diagnostics responses are objects");
        object.insert("skillCountsVersion".into(), Value::from(1));
        object.insert(
            "enabledSkillCounts".into(),
            serde_json::to_value(counts).map_err(|error| error.to_string())?,
        );
    }
    Ok(response)
}

async fn load_global_settings_value(workspace: Option<&WorkspaceInfo>) -> Result<Value, String> {
    let user_keys = load_globally_disabled_user_skills()
        .await
        .map_err(|error| error.to_string())?;
    let project_keys = match workspace {
        Some(record) if record.workspace_kind != WorkspaceKind::Remote => {
            load_globally_disabled_project_skills(SkillPolicyWorkspace::from_record(record))
                .await
                .map_err(|error| error.to_string())?
        }
        _ => Vec::new(),
    };
    Ok(global_settings_value(user_keys, project_keys))
}

pub(crate) async fn get_global_skill_settings(args: &Value) -> Result<Value, String> {
    let workspace = resolve_workspace(request_value(args)).await?;
    load_global_settings_value(workspace.as_ref()).await
}

fn global_settings_value(user_keys: Vec<String>, project_keys: Vec<String>) -> Value {
    json!({
        "globallyDisabledUserSkillKeys": user_keys,
        "globallyDisabledProjectSkillKeys": project_keys,
        "directSkillManagementVersion": 1,
    })
}

pub(crate) async fn set_global_skill_disabled(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let skill_key = get_string(request, "skillKey")?;
    let skill_key = skill_key.trim();
    let disabled = optional_bool(request, "disabled")
        .ok_or_else(|| "Missing or invalid 'disabled' field".to_string())?;
    let workspace = resolve_workspace(request).await?;
    if let Some(record) = workspace.as_ref() {
        if record.workspace_kind == WorkspaceKind::Remote {
            return Err(
                "Direct Skill availability management is not supported for remote workspaces"
                    .into(),
            );
        }
    }
    let known_skill = SkillRegistry::global()
        .get_all_skills_for_workspace(workspace.as_ref().map(|record| record.root_path.as_path()))
        .await
        .into_iter()
        .find(|skill| skill.key == skill_key)
        .ok_or_else(|| format!("Skill '{skill_key}' was not found"))?;
    match known_skill.level {
        SkillLocation::User => {
            set_global_user_skill_disabled(skill_key, disabled)
                .await
                .map_err(|error| error.to_string())?;
        }
        SkillLocation::Project => {
            let record = workspace
                .as_ref()
                .ok_or_else(|| "Project Skill availability requires a workspace".to_string())?;
            set_global_project_skill_disabled(
                SkillPolicyWorkspace::from_record(record),
                skill_key,
                disabled,
            )
            .await
            .map_err(|error| error.to_string())?;
        }
    }
    if let Err(error) = openbitfun_core::service::config::reload_global_config().await {
        tracing::warn!(
            "Failed to reload configuration after Skill availability update: skill_key={}, error={}",
            skill_key,
            error
        );
    }
    load_global_settings_value(workspace.as_ref()).await
}

async fn resolve_external_skill_import_source(
    source_path: &str,
    source_key: &str,
    workspace: Option<&WorkspaceInfo>,
) -> Result<SkillInfo, String> {
    if let Some(record) = workspace {
        if record.workspace_kind == WorkspaceKind::Remote {
            return Err("External Skill import into remote workspaces is not supported".into());
        }
    }
    let source = SkillRegistry::global()
        .find_skill_by_key_for_workspace(
            source_key,
            workspace.map(|record| record.root_path.as_path()),
        )
        .await
        .ok_or("skill_import_stale: External Skill source changed; refresh before importing")?;
    if tokio::fs::canonicalize(&source.path)
        .await
        .map_err(|error| error.to_string())?
        != tokio::fs::canonicalize(source_path)
            .await
            .map_err(|error| error.to_string())?
    {
        return Err("External Skill path does not match the selected source".into());
    }
    Ok(source)
}

#[derive(Debug, Clone, Serialize)]
struct SkillValidationResultDto {
    #[serde(rename = "importPreview", skip_serializing_if = "Option::is_none")]
    import_preview: Option<SkillImportPreview>,
    valid: bool,
    name: Option<String>,
    description: Option<String>,
    error: Option<String>,
}

async fn validate_local_skill_path(path: &str) -> SkillValidationResultDto {
    let skill_path = Path::new(path);
    if !skill_path.exists() {
        return SkillValidationResultDto {
            import_preview: None,
            valid: false,
            name: None,
            description: None,
            error: Some("Path does not exist".to_string()),
        };
    }
    if !skill_path.is_dir() {
        return SkillValidationResultDto {
            import_preview: None,
            valid: false,
            name: None,
            description: None,
            error: Some("Path is not a directory".to_string()),
        };
    }
    let skill_md_path = skill_path.join("SKILL.md");
    if !skill_md_path.exists() {
        return SkillValidationResultDto {
            import_preview: None,
            valid: false,
            name: None,
            description: None,
            error: Some("Directory is missing SKILL.md file".to_string()),
        };
    }
    match tokio::fs::read_to_string(&skill_md_path).await {
        Ok(content) => {
            match SkillData::from_markdown(path.to_string(), &content, SkillLocation::User, false) {
                Ok(data) => SkillValidationResultDto {
                    import_preview: None,
                    valid: true,
                    name: Some(data.name),
                    description: Some(data.description),
                    error: None,
                },
                Err(error) => SkillValidationResultDto {
                    import_preview: None,
                    valid: false,
                    name: None,
                    description: None,
                    error: Some(error.to_string()),
                },
            }
        }
        Err(error) => SkillValidationResultDto {
            import_preview: None,
            valid: false,
            name: None,
            description: None,
            error: Some(format!("Failed to read SKILL.md: {error}")),
        },
    }
}

pub(crate) async fn validate_skill_path(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let source_key = optional_string(request, "sourceKey");
    let workspace = resolve_workspace(request).await?;
    let result = if let Some(source_key) = source_key {
        let source =
            resolve_external_skill_import_source(&path, &source_key, workspace.as_ref()).await?;
        let preview = skill_imports::preview_import(source).await?;
        SkillValidationResultDto {
            valid: true,
            name: Some(preview.name.clone()),
            description: Some(preview.description.clone()),
            error: None,
            import_preview: Some(preview),
        }
    } else {
        validate_local_skill_path(&path).await
    };
    serde_json::to_value(result).map_err(|error| error.to_string())
}

async fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dst).await?;
    let mut entries = tokio::fs::read_dir(src).await?;
    while let Some(entry) = entries.next_entry().await? {
        let ty = entry.file_type().await?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            Box::pin(copy_dir_all(&src_path, &dst_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path).await?;
        }
    }
    Ok(())
}

pub(crate) async fn add_skill(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let source_path = get_string(request, "sourcePath")?;
    let level = get_string(request, "level")?;
    let source_key = optional_string(request, "sourceKey");
    let target_name = optional_string(request, "targetName");
    let expected_source_fingerprint = optional_string(request, "expectedSourceFingerprint");
    let workspace = resolve_workspace(request).await?;

    if let Some(source_key) = source_key {
        if !matches!(level.as_str(), "user" | "project") {
            return Err("Invalid Skill target scope".into());
        }
        let workspace_root = workspace.as_ref().map(|record| record.root_path.clone());
        let source =
            resolve_external_skill_import_source(&source_path, &source_key, workspace.as_ref())
                .await?;
        let paths = get_path_manager_arc();
        let target = if level == "project" {
            paths
                .project_root(workspace_root.as_deref().ok_or("No workspace selected")?)
                .join("skills")
        } else {
            paths.user_skills_dir()
        };
        skill_imports::import_copy_as_reviewed(
            source,
            target,
            target_name,
            expected_source_fingerprint,
        )
        .await?;
        SkillRegistry::global()
            .refresh_for_workspace(workspace_root.as_deref())
            .await;
        return Ok(json!("External Skill imported successfully"));
    }

    if target_name.is_some() || expected_source_fingerprint.is_some() {
        return Err("Reviewed or renamed Skill imports require their source identity".into());
    }
    let validation = validate_local_skill_path(&source_path).await;
    if !validation.valid {
        return Err(validation
            .error
            .unwrap_or_else(|| "Invalid skill path".to_string()));
    }
    let skill_name = validation
        .name
        .as_deref()
        .ok_or_else(|| "Skill name missing after validation".to_string())?;
    let source = Path::new(&source_path);

    let target_dir = if level == "project" {
        let record = workspace
            .as_ref()
            .ok_or_else(|| "No workspace open, cannot add project-level Skill".to_string())?;
        if record.workspace_kind == WorkspaceKind::Remote {
            return Err(
                "Installing project skills into remote workspaces is not supported yet".to_string(),
            );
        }
        get_path_manager_arc()
            .project_root(&record.root_path)
            .join("skills")
    } else {
        get_path_manager_arc().user_skills_dir()
    };

    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|error| format!("Failed to create skills directory: {error}"))?;
    let folder_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Unable to get folder name")?;
    let target_path = target_dir.join(folder_name);
    if target_path.exists() {
        return Err(format!(
            "Skill '{folder_name}' already exists in {} level directory",
            if level == "project" {
                "project"
            } else {
                "user"
            }
        ));
    }
    copy_dir_all(source, &target_path)
        .await
        .map_err(|error| format!("Failed to copy skill folder: {error}"))?;
    SkillRegistry::global()
        .refresh_for_workspace(workspace.as_ref().map(|record| record.root_path.as_path()))
        .await;
    Ok(json!(format!("Skill '{skill_name}' added successfully")))
}

pub(crate) async fn delete_skill(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let skill_key = get_string(request, "skillKey")?;
    let expected_import_id = optional_string(request, "expectedImportId");
    let workspace = resolve_workspace(request).await?;
    let registry = SkillRegistry::global();

    if let Some((remote_root, fs)) = remote_workspace_fs(workspace.as_ref()).await? {
        if expected_import_id.is_some() {
            return Err("External Skill import undo on remote workspaces is not supported".into());
        }
        let skill_info = registry
            .find_skill_by_key_for_remote_workspace(&fs, &remote_root, &skill_key)
            .await
            .ok_or_else(|| format!("Skill '{skill_key}' not found"))?;
        ensure_skill_can_be_deleted(&skill_info)?;
        match skill_info.level {
            SkillLocation::Project => {
                let connection_id = workspace
                    .as_ref()
                    .and_then(|record| record.filesystem_connection_id().ok().flatten())
                    .ok_or("Remote workspace connection is unavailable")?;
                let services = openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services()
                    .await?;
                let remote_fs = services
                    .get_file_service()
                    .await
                    .ok_or("Remote file service is unavailable")?;
                remote_fs
                    .remove_dir_all(connection_id, &skill_info.path)
                    .await
                    .map_err(|error| format!("Failed to delete remote skill folder: {error}"))?;
            }
            SkillLocation::User => {
                let skill_path = PathBuf::from(&skill_info.path);
                if skill_path.exists() {
                    tokio::fs::remove_dir_all(&skill_path)
                        .await
                        .map_err(|error| format!("Failed to delete local skill folder: {error}"))?;
                }
            }
        }
        registry.refresh().await;
        return Ok(json!(format!(
            "Skill '{}' deleted successfully",
            skill_info.name
        )));
    }

    let workspace_root = workspace.as_ref().map(|record| record.root_path.as_path());
    let skill_info = registry
        .find_skill_by_key_for_workspace(&skill_key, workspace_root)
        .await
        .ok_or_else(|| format!("Skill '{skill_key}' not found"))?;
    ensure_skill_can_be_deleted(&skill_info)?;

    let skill_path = PathBuf::from(&skill_info.path);
    if let Some(expected) = expected_import_id {
        skill_imports::remove_imported_copy(&skill_path, &expected).await?;
    } else if skill_path.exists() {
        tokio::fs::remove_dir_all(&skill_path)
            .await
            .map_err(|error| format!("Failed to delete skill folder: {error}"))?;
    }
    registry.refresh_for_workspace(workspace_root).await;
    Ok(json!(format!(
        "Skill '{}' deleted successfully",
        skill_info.name
    )))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceModeSkillSelectionPayload {
    #[serde(alias = "mode_id")]
    mode_id: String,
    #[serde(alias = "enabled_skill_keys")]
    enabled_skill_keys: Vec<String>,
}

pub(crate) async fn replace_mode_skill_selection(args: &Value) -> Result<Value, String> {
    let request_val = request_value(args);
    let payload: ReplaceModeSkillSelectionPayload = serde_json::from_value(request_val.clone())
        .map_err(|error| format!("Invalid replace_mode_skill_selection request: {error}"))?;
    let workspace = resolve_workspace(request_val).await?;
    let registry = SkillRegistry::global();
    let remote = remote_workspace_fs(workspace.as_ref()).await?;
    let all_skills = if let Some((ref remote_root, ref fs)) = remote {
        within_remote_deadline(registry.get_skill_scan_report_for_remote_workspace(fs, remote_root))
            .await?
            .skills
    } else {
        registry
            .get_skill_scan_report_for_workspace(
                workspace.as_ref().map(|record| record.root_path.as_path()),
            )
            .await
            .skills
    };

    let enabled_skill_keys = normalize_skill_key_list(payload.enabled_skill_keys);
    let enabled_keys: HashSet<String> = enabled_skill_keys.iter().cloned().collect();
    let known_keys: HashSet<String> = all_skills.iter().map(|skill| skill.key.clone()).collect();
    let unknown_keys: Vec<String> = enabled_skill_keys
        .iter()
        .filter(|key| !known_keys.contains(*key))
        .cloned()
        .collect();
    if !unknown_keys.is_empty() {
        return Err(format!(
            "Unknown skill keys for mode '{}': {}",
            payload.mode_id,
            unknown_keys.join(", ")
        ));
    }

    let mut disabled_user_skills = Vec::new();
    let mut enabled_user_skills = Vec::new();
    for skill in all_skills
        .iter()
        .filter(|skill| skill.level == SkillLocation::User)
    {
        let should_enable = enabled_keys.contains(&skill.key);
        let default_enabled = resolve_skill_default_enabled_for_mode(skill, &payload.mode_id);
        if default_enabled && !should_enable {
            disabled_user_skills.push(skill.key.clone());
        } else if !default_enabled && should_enable {
            enabled_user_skills.push(skill.key.clone());
        }
    }
    openbitfun_core::service::config::mode_config_canonicalizer::persist_agent_profile_from_value(
        &payload.mode_id,
        json!({
            "disabled_user_skills": normalize_skill_key_list(disabled_user_skills),
            "enabled_user_skills": normalize_skill_key_list(enabled_user_skills),
        }),
    )
    .await
    .map_err(|error| format!("Failed to update user skill overrides: {error}"))?;

    let disabled_project_skills = normalize_skill_key_list(
        all_skills
            .iter()
            .filter(|skill| skill.level == SkillLocation::Project)
            .filter(|skill| !enabled_keys.contains(&skill.key))
            .map(|skill| skill.key.clone())
            .collect(),
    );

    if let Some((remote_root, _)) = remote {
        let connection_id = workspace
            .as_ref()
            .and_then(|record| record.filesystem_connection_id().ok().flatten())
            .ok_or("Remote workspace connection is unavailable")?;
        let services =
            openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services(
            )
            .await?;
        let remote_fs = services
            .get_file_service()
            .await
            .ok_or("Remote file service is unavailable")?;
        let config_path = project_mode_skills_path_for_remote(&remote_root);
        let mut document = if remote_fs
            .exists(connection_id, &config_path)
            .await
            .map_err(|error| format!("Failed to check remote project skill overrides: {error}"))?
        {
            let content = remote_fs
                .read_file(connection_id, &config_path)
                .await
                .map_err(|error| {
                    format!("Failed to read remote project skill overrides: {error}")
                })?;
            let content = String::from_utf8(content).map_err(|error| {
                format!("Remote project skill overrides are not valid UTF-8: {error}")
            })?;
            deserialize_project_agent_profiles_document(&content)
                .map_err(|error| format!("Invalid remote project skill overrides JSON: {error}"))?
        } else {
            Default::default()
        };
        set_disabled_mode_skills_in_document(
            &mut document,
            &payload.mode_id,
            disabled_project_skills,
        )
        .map_err(|error| format!("Failed to update remote project skill overrides: {error}"))?;
        let config_dir = config_path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_string())
            .ok_or_else(|| format!("Invalid remote project config path '{config_path}'"))?;
        remote_fs
            .create_dir_all(connection_id, &config_dir)
            .await
            .map_err(|error| {
                format!("Failed to create remote project skill overrides directory: {error}")
            })?;
        remote_fs
            .write_file(
                connection_id,
                &config_path,
                serialize_project_agent_profiles_document(&document)
                    .map_err(|error| {
                        format!("Failed to serialize remote project skill overrides: {error}")
                    })?
                    .as_slice(),
            )
            .await
            .map_err(|error| format!("Failed to write remote project skill overrides: {error}"))?;
    } else if let Some(record) = workspace.as_ref() {
        let mut document = load_project_mode_skills_document_local(&record.root_path)
            .await
            .map_err(|error| format!("Failed to load project mode skills: {error}"))?;
        set_disabled_mode_skills_in_document(
            &mut document,
            &payload.mode_id,
            disabled_project_skills,
        )
        .map_err(|error| format!("Failed to update project skill overrides: {error}"))?;
        save_project_mode_skills_document_local(&record.root_path, &document)
            .await
            .map_err(|error| format!("Failed to save project mode skills: {error}"))?;
    }

    if let Err(error) = openbitfun_core::service::config::reload_global_config().await {
        tracing::warn!(
            "Failed to reload global config after batch skill update: mode_id={}, error={}",
            payload.mode_id,
            error
        );
    }

    Ok(json!(format!(
        "Mode '{}' skill selection updated successfully",
        payload.mode_id
    )))
}

pub(crate) async fn reset_mode_skill_selection(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let mode_id = get_string(request, "modeId")?;
    let workspace = resolve_workspace(request).await?;
    clear_user_mode_skill_overrides(&mode_id)
        .await
        .map_err(|error| format!("Failed to reset user skill overrides: {error}"))?;

    if let Some((remote_root, _)) = remote_workspace_fs(workspace.as_ref()).await? {
        let connection_id = workspace
            .as_ref()
            .and_then(|record| record.filesystem_connection_id().ok().flatten())
            .ok_or("Remote workspace connection is unavailable")?;
        let services =
            openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services(
            )
            .await?;
        let remote_fs = services
            .get_file_service()
            .await
            .ok_or("Remote file service is unavailable")?;
        let config_path = project_mode_skills_path_for_remote(&remote_root);
        if remote_fs
            .exists(connection_id, &config_path)
            .await
            .map_err(|error| format!("Failed to check remote project skill overrides: {error}"))?
        {
            let content = remote_fs
                .read_file(connection_id, &config_path)
                .await
                .map_err(|error| {
                    format!("Failed to read remote project skill overrides: {error}")
                })?;
            let content = String::from_utf8(content).map_err(|error| {
                format!("Remote project skill overrides are not valid UTF-8: {error}")
            })?;
            let mut document = deserialize_project_agent_profiles_document(&content)
                .map_err(|error| format!("Invalid remote project skill overrides JSON: {error}"))?;
            set_disabled_mode_skills_in_document(&mut document, &mode_id, Vec::new()).map_err(
                |error| format!("Failed to clear remote project skill overrides: {error}"),
            )?;
            if document.is_empty() {
                let _ = remote_fs.remove_file(connection_id, &config_path).await;
            } else {
                remote_fs
                    .write_file(
                        connection_id,
                        &config_path,
                        serialize_project_agent_profiles_document(&document)
                            .map_err(|error| {
                                format!(
                                    "Failed to serialize remote project skill overrides: {error}"
                                )
                            })?
                            .as_slice(),
                    )
                    .await
                    .map_err(|error| {
                        format!("Failed to write remote project skill overrides: {error}")
                    })?;
            }
        }
    } else if let Some(record) = workspace.as_ref() {
        let path = get_path_manager_arc().project_agent_profiles_file(&record.root_path);
        if tokio::fs::try_exists(&path)
            .await
            .map_err(|error| format!("Failed to check project mode skills file: {error}"))?
        {
            let mut document = load_project_mode_skills_document_local(&record.root_path)
                .await
                .map_err(|error| format!("Failed to load project mode skills: {error}"))?;
            set_disabled_mode_skills_in_document(&mut document, &mode_id, Vec::new())
                .map_err(|error| format!("Failed to clear project skill overrides: {error}"))?;
            if document.is_empty() {
                match tokio::fs::remove_file(&path).await {
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "Failed to remove project mode skills file: {error}"
                        ));
                    }
                }
            } else {
                save_project_mode_skills_document_local(&record.root_path, &document)
                    .await
                    .map_err(|error| format!("Failed to save project mode skills: {error}"))?;
            }
        }
    }

    if let Err(error) = openbitfun_core::service::config::reload_global_config().await {
        tracing::warn!(
            "Failed to reload global config after resetting skill selection: mode_id={}, error={}",
            mode_id,
            error
        );
    }

    Ok(json!(format!(
        "Mode '{mode_id}' skill selection reset successfully"
    )))
}

pub(crate) async fn set_mode_skill_disabled(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let mode_id = get_string(request, "modeId")?;
    let skill_key = get_string(request, "skillKey")?;
    let disabled = optional_bool(request, "disabled")
        .ok_or_else(|| "Missing or invalid 'disabled' field".to_string())?;
    let workspace = resolve_workspace(request).await?;
    if skill_key.starts_with("user::") {
        let registry = SkillRegistry::global();
        let skill_info = if let Some((remote_root, remote_workspace_fs)) =
            remote_workspace_fs(workspace.as_ref()).await?
        {
            registry
                .find_skill_by_key_for_remote_workspace(
                    &remote_workspace_fs,
                    &remote_root,
                    &skill_key,
                )
                .await
        } else {
            registry
                .find_skill_by_key_for_workspace(
                    &skill_key,
                    workspace.as_ref().map(|record| record.root_path.as_path()),
                )
                .await
        }
        .ok_or_else(|| format!("Skill '{skill_key}' not found"))?;
        let default_enabled = resolve_skill_default_enabled_for_mode(&skill_info, &mode_id);
        set_user_mode_skill_state(&mode_id, &skill_key, !disabled, default_enabled)
            .await
            .map_err(|error| format!("Failed to update user skill override: {error}"))?;
        let _ = openbitfun_core::service::config::reload_global_config().await;
        return Ok(json!(format!(
            "Mode '{mode_id}' skill '{skill_key}' updated successfully"
        )));
    }
    if !skill_key.starts_with("project::") {
        return Err(format!("Unsupported skill key '{skill_key}'"));
    }
    if let Some((remote_root, _)) = remote_workspace_fs(workspace.as_ref()).await? {
        let connection_id = workspace
            .as_ref()
            .and_then(|record| record.filesystem_connection_id().ok().flatten())
            .ok_or("Remote workspace connection is unavailable")?;
        let services =
            openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services()
                .await?;
        let remote_fs = services
            .get_file_service()
            .await
            .ok_or("Remote file service is unavailable")?;
        let config_path = project_mode_skills_path_for_remote(&remote_root);
        let mut document = if remote_fs
            .exists(connection_id, &config_path)
            .await
            .map_err(|error| format!("Failed to check remote project skill overrides: {error}"))?
        {
            let content = remote_fs
                .read_file(connection_id, &config_path)
                .await
                .map_err(|error| {
                    format!("Failed to read remote project skill overrides: {error}")
                })?;
            let content = String::from_utf8(content).map_err(|error| {
                format!("Remote project skill overrides are not valid UTF-8: {error}")
            })?;
            deserialize_project_agent_profiles_document(&content)
                .map_err(|error| format!("Invalid remote project skill overrides JSON: {error}"))?
        } else {
            Default::default()
        };
        set_mode_skill_disabled_in_document(&mut document, &mode_id, &skill_key, disabled)
            .map_err(|error| format!("Failed to update remote project skill override: {error}"))?;
        let config_dir = config_path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_string())
            .ok_or_else(|| format!("Invalid remote project config path '{config_path}'"))?;
        remote_fs
            .create_dir_all(connection_id, &config_dir)
            .await
            .map_err(|error| {
                format!("Failed to create remote project skill overrides directory: {error}")
            })?;
        remote_fs
            .write_file(
                connection_id,
                &config_path,
                serialize_project_agent_profiles_document(&document)
                    .map_err(|error| {
                        format!("Failed to serialize remote project skill overrides: {error}")
                    })?
                    .as_slice(),
            )
            .await
            .map_err(|error| format!("Failed to write remote project skill overrides: {error}"))?;
    } else {
        let record = workspace
            .as_ref()
            .ok_or_else(|| "Workspace is required to update project skill overrides".to_string())?;
        let mut document = load_project_mode_skills_document_local(&record.root_path)
            .await
            .map_err(|error| format!("Failed to load project mode skills: {error}"))?;
        set_mode_skill_disabled_in_document(&mut document, &mode_id, &skill_key, disabled)
            .map_err(|error| format!("Failed to update project skill override: {error}"))?;
        save_project_mode_skills_document_local(&record.root_path, &document)
            .await
            .map_err(|error| format!("Failed to save project mode skills: {error}"))?;
    }
    let _ = openbitfun_core::service::config::reload_global_config().await;
    Ok(json!(format!(
        "Mode '{mode_id}' skill '{skill_key}' updated successfully"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn mode_skill_configs_require_a_mode() {
        let error = get_mode_skill_configs(&json!({})).await.unwrap_err();
        assert!(error.contains("modeId"), "{error}");
    }

    #[tokio::test]
    async fn invalid_summary_ids_fail_before_discovery() {
        let error = get_mode_skill_configs(
            &json!({"modeId":"Claw","includeDiagnostics":true,"summaryModeIds":[1]}),
        )
        .await
        .unwrap_err();
        assert!(error.contains("summaryModeIds"));
    }

    #[tokio::test]
    async fn mode_summary_preserves_legacy_payloads() {
        let legacy = get_mode_skill_configs(&json!({"modeId":"Claw"}))
            .await
            .unwrap();
        let diagnostic =
            get_mode_skill_configs(&json!({"modeId":"Claw","includeDiagnostics":true}))
                .await
                .unwrap();
        assert_eq!(legacy, diagnostic["skills"]);
        assert!(diagnostic.get("skillCountsVersion").is_none());
        let summary = get_mode_skill_configs(&json!({"modeId":"Claw","includeDiagnostics":true,"summaryModeIds":["Claw","review","Claw"]})).await.unwrap();
        assert_eq!(legacy, summary["skills"]);
        assert_eq!(summary["skillCountsVersion"], 1);
        assert_eq!(
            summary["enabledSkillCounts"]["Claw"].as_u64().unwrap(),
            legacy
                .as_array()
                .unwrap()
                .iter()
                .filter(|skill| skill["effectiveEnabled"] == true)
                .count() as u64
        );
        assert!(summary["enabledSkillCounts"]["review"].is_number());
    }

    #[test]
    fn global_settings_advertise_direct_skill_management() {
        let settings = global_settings_value(vec!["user::a".into()], Vec::new());
        assert_eq!(settings["directSkillManagementVersion"], 1);
        assert_eq!(
            settings["globallyDisabledUserSkillKeys"],
            json!(["user::a"])
        );
        assert_eq!(settings["globallyDisabledProjectSkillKeys"], json!([]));
    }

    #[tokio::test]
    async fn no_workspace_reference_needs_no_workspace_service() {
        assert!(resolve_workspace(&json!({})).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_host_invoke_without_a_workspace_lists_host_level_skills() {
        let bare = get_skill_configs(&json!({})).await.unwrap();
        assert!(bare.is_array(), "legacy controllers read an array");
        let report = get_skill_configs(&json!({ "includeDiagnostics": true }))
            .await
            .unwrap();
        assert!(report["skills"].is_array());
        assert_eq!(report["importOperationsVersion"], 3);
    }
}
