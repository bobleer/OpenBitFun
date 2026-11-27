//! Scheduled jobs (routines) HostInvoke handlers for the CLI Peer Host.
//!
//! Calls the same Core `CronService` owner that Desktop (`cron_api.rs`) serves,
//! so a controller inspecting or managing routines on this CLI host operates on
//! the real scheduler running here.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

use openbitfun_core::service::cron::{
    answer_preview_request, get_global_cron_service, validate_cron_job_draft, CreateCronJobRequest,
    CronJobDraft, CronJobTargetKind, CronService, PreviewCronOccurrencesRequest,
    UpdateCronJobRequest,
};

use crate::peer_host::args::request_value;
use crate::peer_host::state::PeerHostState;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCronJobsPayload {
    #[serde(default, alias = "workspace_path")]
    workspace_path: Option<String>,
    #[serde(default, alias = "workspace_id")]
    workspace_id: Option<String>,
    #[serde(default, alias = "remote_connection_id")]
    remote_connection_id: Option<String>,
    #[serde(default, alias = "session_id")]
    session_id: Option<String>,
    #[serde(default, alias = "target_kind")]
    target_kind: Option<CronJobTargetKind>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCronJobPayload {
    #[serde(alias = "job_id")]
    job_id: String,
    #[serde(flatten)]
    changes: UpdateCronJobRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteCronJobPayload {
    #[serde(alias = "job_id")]
    job_id: String,
}

fn cron_service() -> Result<Arc<CronService>, String> {
    get_global_cron_service()
        .ok_or_else(|| "Scheduled jobs are unavailable in this execution host".to_string())
}

fn parse<T: DeserializeOwned>(args: &Value) -> Result<T, String> {
    serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid request: {error}"))
}

pub(crate) async fn list_cron_jobs(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request: ListCronJobsPayload = if request_value(args).is_null() {
        ListCronJobsPayload::default()
    } else {
        parse(args)?
    };
    let service = cron_service()?;
    let workspace_id = if request.workspace_id.is_some()
        || request.workspace_path.is_some()
        || request.remote_connection_id.is_some()
    {
        Some(
            state
                .workspace_service
                .resolve_legacy_workspace_reference(
                    request.workspace_id.as_deref(),
                    request.workspace_path.as_deref().unwrap_or_default(),
                    request.remote_connection_id.as_deref(),
                    None,
                )
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Scheduled job workspace is unavailable".to_string())?
                .id,
        )
    } else {
        None
    };
    let jobs = service
        .list_jobs_filtered(
            workspace_id.as_deref(),
            request.session_id.as_deref(),
            request.target_kind,
        )
        .await;
    serde_json::to_value(jobs).map_err(|error| error.to_string())
}

pub(crate) async fn create_cron_job(args: &Value) -> Result<Value, String> {
    let request: CreateCronJobRequest = parse(args)?;
    let service = cron_service()?;
    let job = service
        .create_job(request)
        .await
        .map_err(|error| format!("Failed to create scheduled job: {error}"))?;
    serde_json::to_value(job).map_err(|error| error.to_string())
}

pub(crate) async fn update_cron_job(args: &Value) -> Result<Value, String> {
    let request: UpdateCronJobPayload = parse(args)?;
    let service = cron_service()?;
    let job = service
        .update_job(&request.job_id, request.changes)
        .await
        .map_err(|error| format!("Failed to update scheduled job: {error}"))?;
    serde_json::to_value(job).map_err(|error| error.to_string())
}

pub(crate) async fn delete_cron_job(args: &Value) -> Result<Value, String> {
    let request: DeleteCronJobPayload = parse(args)?;
    let service = cron_service()?;
    let deleted = service
        .delete_job(&request.job_id)
        .await
        .map_err(|error| format!("Failed to delete scheduled job: {error}"))?;
    serde_json::to_value(deleted).map_err(|error| error.to_string())
}

/// The embedded CLI starts scheduling during bootstrap; repeated readiness
/// signals from peer controllers are idempotent.
pub(crate) async fn notify_cron_host_ready() -> Result<Value, String> {
    let service = cron_service()?;
    service.start();
    Ok(Value::Null)
}

pub(crate) async fn validate_draft(args: &Value) -> Result<Value, String> {
    let draft: CronJobDraft = parse(args)?;
    serde_json::to_value(validate_cron_job_draft(
        &draft,
        chrono::Utc::now().timestamp_millis(),
    ))
    .map_err(|error| error.to_string())
}

pub(crate) async fn preview_occurrences(args: &Value) -> Result<Value, String> {
    let request: PreviewCronOccurrencesRequest = parse(args)?;
    let wants_jobs = request.job_ids.is_some() || request.schedule.is_none();
    let jobs = match get_global_cron_service() {
        Some(service) if wants_jobs => service.list_jobs().await,
        _ => Vec::new(),
    };
    serde_json::to_value(answer_preview_request(
        &request,
        &jobs,
        chrono::Utc::now().timestamp_millis(),
    ))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn previews_a_draft_without_a_cron_host() {
        let value = preview_occurrences(&json!({
            "request": {
                "schedule": { "kind": "cron", "expr": "0 9 * * 1-5", "tz": "UTC" },
                "count": 3
            }
        }))
        .await
        .expect("preview");
        assert_eq!(value["schedule"]["valid"], true);
        assert_eq!(
            value["schedule"]["occurrences"].as_array().map(Vec::len),
            Some(3)
        );
        assert!(value["jobs"].as_array().is_some_and(Vec::is_empty));
    }

    #[tokio::test]
    async fn validates_a_draft() {
        let value = validate_draft(&json!({
            "request": { "name": "", "payload": { "text": "x" }, "schedule": { "kind": "every", "everyMs": 0 } }
        }))
        .await
        .expect("validate");
        assert_eq!(value["valid"], false);
        assert_eq!(value["issues"][0]["code"], "name_required");
        assert_eq!(value["issues"][1]["code"], "interval_positive");
    }
}
