//! Review launch: resolves a workspace Review target with Git, builds the
//! launch plan (`openbitfun_agent_runtime::deep_review::launch_plan`) and
//! starts the read-only reviewer as a child session of the session that asked.
//!
//! Clients only send the intent, an optional file or folder scope and an
//! optional focus; they never build manifests or prompts. Remote workspaces
//! are refused explicitly: bounded exact diff evidence and the restricted read
//! envelope are local-only today (see `docs/architecture/deep-review.md`).

use crate::api::agentic_api::{
    create_session, desktop_session_scope, start_dialog_turn, CreateSessionRequest,
    StartDialogTurnRequest,
};
use crate::api::app_state::AppState;
use crate::api::review_platform_api::review_platform_ui_error;
use crate::api::session_storage_path::desktop_session_storage_root;
use crate::host::{HostHandle, State};
use crate::runtime::DesktopRuntimeContext;
use log::{info, warn};
use openbitfun_agent_runtime::deep_review::launch_plan::{
    parse_review_command, parse_review_git_range, plan_git_range_review, plan_pull_request_review,
    plan_workspace_review, review_child_session_id, scope_workspace_changes,
    stable_review_fingerprint, GitRangeReviewSnapshot, PullRequestReviewFile,
    PullRequestReviewSnapshot, ReviewGitRange, ReviewLaunchIntent, ReviewLaunchPlan,
    ReviewLaunchRefusal, UntrackedContentFact, WorkspaceChange, WorkspaceReviewSnapshot,
};
use openbitfun_agent_runtime::deep_review::{
    remediation::{
        PostFixReviewScope, ReviewFixItemState, ReviewFixRunState, ReviewRemediationPlan,
        ReviewRemediationProgress, ReviewRemediationSelection, ReviewRemediationTracking,
        REMEDIATION_TRACKING_KEY,
    },
    target_evidence::ReviewTargetWorkspaceBinding,
    ReviewTargetEvidence, ReviewTargetEvidenceSource, DEEP_REVIEW_AGENT_TYPE,
    REVIEW_FIXER_AGENT_TYPE,
};
use openbitfun_agent_runtime::session::keyed_lock::{KeyedAsyncLock, KeyedAsyncLockGuard};
use openbitfun_core::agentic::coordination::ConversationCoordinator;
use openbitfun_core::agentic::deep_review::history::{
    PullRequestReviewPage, PullRequestReviewRun, PullRequestReviewSelection, ReviewFreshness,
    ReviewHistoryCursor, ReviewRunPhase, SessionReviewPage,
};
use openbitfun_core::agentic::deep_review::revision::{
    lock_review_record, PostFixReviewLink, PullRequestReviewRevision,
};
use openbitfun_core::service::git::{
    trust, GitChangedFileStatus, GitChangedFilesParams, GitDiffParams, GitError, GitService,
    GitStatus,
};
use openbitfun_core::service::review_platform::{
    ReviewFileStatus, ReviewPlatformKind, ReviewPlatformPullRequest, ReviewPlatformRemote,
    ReviewPlatformService, ReviewRepositoryLocator,
};
use openbitfun_core::service::session::{SessionMetadata, SessionRelationshipKind};
use openbitfun_core::service::workspace::WorkspaceKind;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, LazyLock};

static PULL_REQUEST_LAUNCHES: LazyLock<KeyedAsyncLock> = LazyLock::new(KeyedAsyncLock::default);
static GIT_RANGE_LAUNCHES: LazyLock<KeyedAsyncLock> = LazyLock::new(KeyedAsyncLock::default);
static REMEDIATION_LAUNCHES: LazyLock<KeyedAsyncLock> = LazyLock::new(KeyedAsyncLock::default);
static COVERAGE_REVIEW_LAUNCHES: LazyLock<KeyedAsyncLock> = LazyLock::new(KeyedAsyncLock::default);

/// Untracked files larger than this are reported as unavailable content.
const UNTRACKED_CONTENT_READ_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchReviewRequest {
    /// The session the Review belongs to; the reviewer runs as its child.
    pub parent_session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// `review` (default) or `strict`.
    #[serde(default)]
    pub intent: Option<String>,
    /// A typed `/review …` / `/DeepReview …` line; its intent and focus win
    /// over `intent` / `focus`.
    #[serde(default)]
    pub command_text: Option<String>,
    /// A range preflight must be approved against the exact commits it showed.
    /// The top-level intent is "git_range" for this request, so an older owner
    /// refuses it instead of launching a workspace Review.
    #[serde(default)]
    approved_git_range: Option<ApprovedReviewGitRange>,
    #[serde(default)]
    retry_coverage: Option<ReviewCoverageRequest>,
    /// Files or folders, relative to the workspace root; empty means every change.
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub focus: Option<String>,
    /// Idempotency key: a retry with the same id finds the child it created.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Resolve and plan only; nothing is created.
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub child_session_name: Option<String>,
    /// What the child's first user message shows instead of the prompt.
    #[serde(default)]
    pub display_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewCoverageRequest {
    report_tool_id: String,
    #[serde(default)]
    scope_fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovedReviewGitRange {
    command_text: String,
    #[serde(flatten)]
    revisions: ReviewGitRevisions,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGitRevisions {
    base_revision: String,
    head_revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPullRequestReviewRequest {
    /// A new record names the chat. An explicit re-review recovers it from the predecessor.
    #[serde(default)]
    pub parent_session_id: Option<String>,
    pub workspace_id: String,
    pub remote_id: String,
    pub pull_request_id: String,
    pub provider: PullRequestProviderSelection,
    #[serde(default)]
    pub expected_base_revision: Option<String>,
    #[serde(default)]
    pub expected_head_revision: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub previous_review_session_id: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub child_session_name: Option<String>,
    #[serde(default)]
    pub display_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestProviderSelection {
    pub platform: ReviewPlatformKind,
    pub host: String,
    pub project_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewHistoryRequest {
    pub workspace_id: String,
    pub selection: PullRequestReviewSelection,
    #[serde(default)]
    pub before: Option<ReviewHistoryCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionReviewRecordsRequest {
    pub workspace_id: String,
    pub session_id: String,
    #[serde(default)]
    pub before: Option<ReviewHistoryCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchReviewRemediationRequest {
    workspace_id: String,
    session_id: String,
    report_tool_id: String,
    #[serde(default)]
    approved: Option<ApprovedReviewRemediation>,
    #[serde(default)]
    review_fixes: Option<ReviewFixesRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovedReviewRemediation {
    request_id: String,
    report_revision: String,
    selection: Vec<ReviewRemediationSelection>,
    #[serde(default)]
    instructions: Option<String>,
    child_session_name: String,
    display_message: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PostFixReviewSelection {
    fix_session_id: String,
    previous_review_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewFixesRequest {
    #[serde(flatten)]
    selection: PostFixReviewSelection,
    report_revision: String,
    #[serde(default)]
    scope_fingerprint: Option<String>,
    child_session_name: String,
    display_message: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostFixReviewState {
    #[serde(skip_serializing_if = "Option::is_none")]
    selection: Option<PostFixReviewSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    existing: Option<PostFixReviewChild>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PostFixReviewChild {
    session_id: String,
    session_name: String,
    agent_type: String,
    phase: ReviewRunPhase,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LaunchReviewRemediationResponse {
    Prepared {
        plan: ReviewRemediationPlan,
        progress: ReviewRemediationProgress,
        post_fix_review: PostFixReviewState,
    },
    Review {
        review: LaunchReviewResponse,
        workspace_fallback: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        scope_fingerprint: Option<String>,
    },
    Started {
        child_session_id: String,
        child_session_name: String,
    },
    Uncertain {
        child_session_id: String,
        child_session_name: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLaunchFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LaunchReviewResponse {
    /// `prepared` (dry run), `started`, `uncertain` (the child exists but its
    /// first turn was not acknowledged), `already_running` (an independent
    /// request already owns this target), or `refused`.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub intent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_range: Option<ReviewGitRevisions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_fingerprint: Option<String>,
    pub file_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub planned_file_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferred_file_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_line_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completeness: Option<String>,
    pub limitations: Vec<String>,
    pub files: Vec<ReviewLaunchFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_name: Option<String>,
    pub parent_review_card: bool,
    /// The requested paths a scope refusal names.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

fn refused(
    intent: ReviewLaunchIntent,
    code: &str,
    message: impl Into<String>,
) -> LaunchReviewResponse {
    LaunchReviewResponse {
        status: "refused".to_string(),
        code: Some(code.to_string()),
        message: Some(message.into()),
        intent: intent.as_str().to_string(),
        ..Default::default()
    }
}

fn refusal_response(
    intent: ReviewLaunchIntent,
    refusal: &ReviewLaunchRefusal,
) -> LaunchReviewResponse {
    let mut response = refused(intent, refusal.code(), refusal.to_string());
    match refusal {
        ReviewLaunchRefusal::MissingScope { paths } | ReviewLaunchRefusal::EmptyScope { paths } => {
            response.paths = paths.clone();
        }
        ReviewLaunchRefusal::PathOutsideWorkspace { path } => {
            response.paths = vec![path.clone()];
        }
        _ => {}
    }
    response
}

fn git_refusal(intent: ReviewLaunchIntent, error: &GitError) -> Option<LaunchReviewResponse> {
    if let Some(path) = error.untrusted_repository_path() {
        return Some(refused(
            intent,
            "review_repository_untrusted",
            trust::untrusted_repository_error_message(path),
        ));
    }
    if matches!(error, GitError::RepositoryNotFound(_)) {
        return Some(refused(
            intent,
            "review_not_git_repository",
            "No Git repository was found in the current workspace. Review requires a Git repository with an existing commit.",
        ));
    }
    None
}

fn status_from_letters(status: &str) -> &'static str {
    if status.contains('C') {
        "unknown"
    } else if status.contains('R') {
        "renamed"
    } else if status.contains('A') || status.contains('?') {
        "added"
    } else if status.contains('D') {
        "deleted"
    } else if status.contains('M') || status.contains('T') {
        "modified"
    } else {
        "unknown"
    }
}

fn changed_file_status(status: &GitChangedFileStatus) -> &'static str {
    match status {
        GitChangedFileStatus::Added => "added",
        GitChangedFileStatus::Modified => "modified",
        GitChangedFileStatus::Deleted => "deleted",
        GitChangedFileStatus::Renamed => "renamed",
        GitChangedFileStatus::Copied => "copied",
        GitChangedFileStatus::Unknown => "unknown",
    }
}

fn clean_path(path: &str) -> String {
    let unified = path.replace('\\', "/");
    unified.trim_start_matches("./").to_string()
}

/// Every path `git status` reports, with renames and statuses from the
/// `HEAD` name-status listing when the repository has a commit.
fn collect_workspace_changes(
    status: &GitStatus,
    changed: &[openbitfun_core::service::git::GitChangedFile],
) -> Vec<WorkspaceChange> {
    let mut by_path: BTreeMap<String, WorkspaceChange> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    fn add(
        by_path: &mut BTreeMap<String, WorkspaceChange>,
        order: &mut Vec<String>,
        change: WorkspaceChange,
    ) {
        if !by_path.contains_key(&change.path) {
            order.push(change.path.clone());
        }
        by_path.insert(change.path.clone(), change);
    }
    for file in status.staged.iter().chain(status.unstaged.iter()) {
        let path = clean_path(&file.path);
        if by_path.contains_key(&path) {
            continue;
        }
        add(
            &mut by_path,
            &mut order,
            WorkspaceChange {
                path: path.clone(),
                previous_path: None,
                status: status_from_letters(&file.status).to_string(),
                untracked: false,
                conflicted: false,
            },
        );
    }
    for file in changed {
        let path = clean_path(&file.path);
        let previous_path = file.old_path.as_deref().map(clean_path);
        if let Some(previous) = previous_path.as_deref() {
            // A rename listed by status under its old path is one change.
            if by_path.remove(previous).is_some() {
                order.retain(|item| item != previous);
            }
        }
        add(
            &mut by_path,
            &mut order,
            WorkspaceChange {
                path,
                previous_path,
                status: changed_file_status(&file.status).to_string(),
                untracked: false,
                conflicted: false,
            },
        );
    }
    for path in &status.untracked {
        let path = clean_path(path);
        let directory = path.ends_with('/');
        add(
            &mut by_path,
            &mut order,
            WorkspaceChange {
                path: path.trim_end_matches('/').to_string(),
                previous_path: None,
                status: if directory { "unknown" } else { "added" }.to_string(),
                untracked: true,
                conflicted: false,
            },
        );
    }
    for path in &status.conflicts {
        let path = clean_path(path);
        let previous_path = by_path
            .get(&path)
            .and_then(|change| change.previous_path.clone());
        add(
            &mut by_path,
            &mut order,
            WorkspaceChange {
                path,
                previous_path,
                status: "unknown".to_string(),
                untracked: false,
                conflicted: true,
            },
        );
    }
    order
        .into_iter()
        .filter_map(|path| by_path.remove(&path))
        .collect()
}

async fn untracked_fact(root: &Path, relative: &str) -> UntrackedContentFact {
    let full = root.join(relative);
    let Ok(metadata) = tokio::fs::metadata(&full).await else {
        return UntrackedContentFact::default();
    };
    if !metadata.is_file() || metadata.len() > UNTRACKED_CONTENT_READ_LIMIT {
        return UntrackedContentFact::default();
    }
    let Ok(bytes) = tokio::fs::read(&full).await else {
        return UntrackedContentFact::default();
    };
    let text = String::from_utf8_lossy(&bytes);
    let fingerprint = stable_review_fingerprint(&json!(text));
    let line_count = std::str::from_utf8(&bytes)
        .ok()
        .map(|text| text.lines().count() as u64);
    UntrackedContentFact {
        fingerprint: Some(fingerprint),
        line_count,
    }
}

fn plan_files(plan: &ReviewLaunchPlan) -> Vec<ReviewLaunchFile> {
    plan.target_evidence["files"]
        .as_array()
        .map(|files| {
            files
                .iter()
                .map(|file| ReviewLaunchFile {
                    path: file["path"].as_str().unwrap_or_default().to_string(),
                    previous_path: file
                        .get("previousPath")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    status: file["status"].as_str().unwrap_or("unknown").to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_intent(request: &LaunchReviewRequest) -> Result<(ReviewLaunchIntent, String), String> {
    let command_text = request
        .approved_git_range
        .as_ref()
        .map(|range| range.command_text.as_str())
        .or(request.command_text.as_deref());
    if let Some(text) = command_text.filter(|text| !text.trim().is_empty()) {
        let command = parse_review_command(text)
            .ok_or_else(|| format!("Not a Review command: {}", text.trim()))?;
        return Ok((command.intent, command.focus));
    }
    let intent =
        ReviewLaunchIntent::parse(request.intent.as_deref().unwrap_or("")).ok_or_else(|| {
            format!(
                "Unknown Review intent: {}",
                request.intent.as_deref().unwrap_or_default()
            )
        })?;
    Ok((intent, request.focus.clone().unwrap_or_default()))
}

/// Resolves, plans and (unless `dryRun`) launches a Review of the workspace
/// or an explicit Git range as a read-only child of `parentSessionId`.
// @backend-command
pub async fn launch_review(
    app: HostHandle,
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    runtime: State<'_, DesktopRuntimeContext>,
    request: LaunchReviewRequest,
) -> Result<LaunchReviewResponse, String> {
    if request.intent.as_deref() == Some("retry_incomplete") {
        return launch_incomplete_coverage_review(app, coordinator, app_state, runtime, request)
            .await;
    }
    if request.retry_coverage.is_some() {
        return Err("A coverage retry requires the retry_incomplete intent".into());
    }
    let parent_session_id = request.parent_session_id.trim().to_string();
    if parent_session_id.is_empty() {
        return Err("parentSessionId is required".to_string());
    }
    let (intent, focus) = resolve_intent(&request)?;
    let range = if request.command_text.is_some() || request.approved_git_range.is_some() {
        match parse_review_git_range(&focus) {
            Ok(range) => range,
            Err(refusal) => return Ok(refusal_response(intent, &refusal)),
        }
    } else {
        None
    };
    let approved_range = request.approved_git_range.as_ref();
    if approved_range.is_some()
        && (range.is_none()
            || request.command_text.is_some()
            || request.intent.as_deref() != Some("git_range"))
    {
        return Ok(refusal_response(
            intent,
            &ReviewLaunchRefusal::GitRangeUnresolved,
        ));
    }
    if range.is_some() && !request.files.is_empty() {
        return Ok(refusal_response(
            intent,
            &ReviewLaunchRefusal::GitRangeWithFiles,
        ));
    }

    let parent = coordinator
        .get_session_manager()
        .get_session(&parent_session_id);
    let parent_config = parent.as_ref().map(|session| &session.config);
    let workspace_id = request
        .workspace_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .or_else(|| parent_config.and_then(|config| config.workspace_id.clone()));
    let requested_path = request
        .workspace_path
        .clone()
        .filter(|path| !path.trim().is_empty())
        .or_else(|| parent_config.and_then(|config| config.workspace_path.clone()))
        .unwrap_or_default();
    let workspace = match workspace_id.as_deref() {
        Some(id) => app_state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|error| error.to_string())?,
        None => app_state
            .workspace_service
            .resolve_legacy_workspace_reference(None, &requested_path, None, None)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Review needs an open workspace".to_string())?,
    };
    if workspace.workspace_kind == WorkspaceKind::Remote
        || parent_config.is_some_and(|config| config.remote_connection_id.is_some())
    {
        return Ok(refused(
            intent,
            "review_remote_workspace_unsupported",
            "Remote workspace Review is not supported until bounded exact diff evidence is available. Use a local checkout.",
        ));
    }

    // The reviewer runs where the parent executes (a managed worktree keeps
    // its own changes); persistence stays with the project workspace.
    let project_root = workspace.root_path.to_string_lossy().into_owned();
    let saved_parent = if range.is_some() && parent_config.is_none() {
        let saved = runtime
            .session_application()
            .load_session_metadata(
                desktop_session_scope(Some(workspace.id.clone()), project_root.clone(), None, None),
                &parent_session_id,
            )
            .await
            .map_err(|error| error.to_string())?;
        let Some(saved) = saved else {
            return Ok(refused(
                intent,
                "review_git_range_session_unavailable",
                "Open the session in its workspace before reviewing Git commits.",
            ));
        };
        Some(saved)
    } else {
        None
    };
    if range.is_some()
        && (parent_config.is_some_and(|config| {
            config.workspace_id.as_deref() != Some(workspace.id.as_str())
                && config.project_workspace_id.as_deref() != Some(workspace.id.as_str())
        }) || saved_parent.as_ref().is_some_and(|saved| {
            (saved
                .workspace_id
                .as_deref()
                .is_some_and(|id| id != workspace.id)
                && saved.project_workspace_id.as_deref() != Some(workspace.id.as_str()))
                || saved
                    .workspace_hostname
                    .as_deref()
                    .is_some_and(|host| host != "localhost")
        }))
    {
        return Ok(refused(
            intent,
            "review_git_range_session_unavailable",
            "Open the session in its workspace before reviewing Git commits.",
        ));
    }
    let execution_root = parent_config
        .and_then(|config| config.workspace_path.clone())
        .or_else(|| {
            saved_parent.as_ref().and_then(|saved| {
                saved
                    .execution_target
                    .as_ref()
                    .map(|target| target.root_path.clone())
                    .or_else(|| saved.workspace_path.clone())
            })
        })
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| project_root.clone());
    let range_request_id = request
        .request_id
        .as_deref()
        .filter(|id| range.is_some() && !request.dry_run && !id.trim().is_empty());
    let _range_launch_guard = if let Some(request_id) = range_request_id {
        Some(
            GIT_RANGE_LAUNCHES
                .lock(&review_child_session_id(request_id))
                .await,
        )
    } else {
        None
    };
    if let (Some(approved), Some(request_id)) = (approved_range, range_request_id) {
        let child_id = review_child_session_id(request_id);
        let previous = runtime
            .session_application()
            .load_session_metadata(
                desktop_session_scope(Some(workspace.id.clone()), project_root.clone(), None, None),
                &child_id,
            )
            .await
            .map_err(|error| error.to_string())?;
        if let Some(previous) = previous {
            return Ok(reopen_git_range(
                &previous,
                intent,
                &workspace.id,
                &parent_session_id,
                request_id,
                &approved.revisions,
            ));
        }
    }
    let preparation = if let Some(range) = &range {
        prepare_git_range_review(
            &execution_root,
            range,
            approved_range.map(|range| &range.revisions),
            intent,
            None,
        )
        .await?
    } else {
        prepare_workspace_review(&execution_root, &request.files, intent, &focus, false).await?
    };
    let plan = match preparation {
        Ok(plan) => plan,
        Err(response) => return Ok(response),
    };

    if request.dry_run {
        return Ok(prepared_response(&plan));
    }
    start_prepared_review(
        app,
        coordinator,
        app_state,
        runtime,
        plan,
        ReviewSessionLaunch {
            parent_session_id,
            workspace_id: workspace.id,
            project_root,
            execution_root,
            model_name: parent_config
                .and_then(|config| config.model_id.clone())
                .or_else(|| saved_parent.map(|saved| saved.model_name)),
            request_id: request.request_id,
            child_session_name: request.child_session_name,
            display_message: request.display_message,
            pull_request: false,
            revision: None,
        },
    )
    .await
}

fn reopen_git_range(
    saved: &SessionMetadata,
    intent: ReviewLaunchIntent,
    workspace_id: &str,
    parent_session_id: &str,
    request_id: &str,
    revisions: &ReviewGitRevisions,
) -> LaunchReviewResponse {
    let expected_kind = match intent {
        ReviewLaunchIntent::Review => SessionRelationshipKind::Review,
        ReviewLaunchIntent::Strict => SessionRelationshipKind::DeepReview,
    };
    let supported_agent = saved.agent_type == DEEP_REVIEW_AGENT_TYPE
        || (intent == ReviewLaunchIntent::Review
            && saved.agent_type == openbitfun_agent_runtime::deep_review::CODE_REVIEW_AGENT_TYPE);
    let linked = supported_agent
        && saved.workspace_id.as_deref() == Some(workspace_id)
        && saved.relationship.as_ref().is_some_and(|relationship| {
            relationship.kind == Some(expected_kind)
                && relationship.parent_session_id.as_deref() == Some(parent_session_id)
                && relationship.parent_request_id.as_deref() == Some(request_id)
        });
    let evidence = saved
        .review_target_evidence
        .as_ref()
        .and_then(|evidence| ReviewTargetEvidence::from_evidence(evidence).ok());
    let Some(evidence) = evidence.filter(|evidence| {
        linked
            && evidence.source() == ReviewTargetEvidenceSource::GitRange
            && evidence.base_revision() == Some(revisions.base_revision.as_str())
            && evidence.head_revision() == Some(revisions.head_revision.as_str())
    }) else {
        return refused(
            intent,
            "review_git_range_request_conflict",
            "This request already belongs to a different Review.",
        );
    };
    let turn_id = format!("review_turn_{request_id}");
    LaunchReviewResponse {
        status: if saved
            .last_turn
            .as_ref()
            .is_some_and(|turn| turn.turn_id == turn_id)
        {
            "started"
        } else {
            "uncertain"
        }
        .into(),
        intent: intent.as_str().into(),
        agent_type: Some(saved.agent_type.clone()),
        git_range: Some(revisions.clone()),
        file_count: evidence
            .files()
            .len()
            .saturating_add(evidence.omitted_file_count()),
        request_id: Some(request_id.into()),
        child_session_id: Some(saved.session_id.clone()),
        child_session_name: Some(saved.session_name.clone()),
        parent_review_card: true,
        ..Default::default()
    }
}

async fn launch_incomplete_coverage_review(
    app: HostHandle,
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    runtime: State<'_, DesktopRuntimeContext>,
    request: LaunchReviewRequest,
) -> Result<LaunchReviewResponse, String> {
    let retry = request
        .retry_coverage
        .as_ref()
        .ok_or("An incomplete coverage review requires a source report")?;
    if request.command_text.is_some()
        || request.approved_git_range.is_some()
        || request.workspace_path.is_some()
        || !request.files.is_empty()
        || request.focus.is_some()
    {
        return Err("The saved report determines the incomplete Review scope".into());
    }
    let workspace_id = request
        .workspace_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or("The source Review workspace is required")?;
    let source_session = request.parent_session_id.trim();
    if source_session.is_empty() || retry.report_tool_id.trim().is_empty() {
        return Err("The source Review session and report are required".into());
    }
    let workspace = app_state
        .workspace_service
        .require_workspace(workspace_id)
        .await
        .map_err(|error| error.to_string())?;
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Err(
            "Incomplete Review coverage requires a local checkout on the owning device".into(),
        );
    }
    let identity =
        stable_review_fingerprint(&json!([workspace_id, source_session, retry.report_tool_id]));
    let _guard = if request.dry_run {
        None
    } else {
        Some(COVERAGE_REVIEW_LAUNCHES.lock(&identity).await)
    };
    let project_root = workspace.root_path.to_string_lossy().into_owned();
    let (checks, evidence, source) = runtime
        .session_application()
        .load_review_coverage_retry(
            desktop_session_scope(Some(workspace_id.into()), project_root.clone(), None, None),
            source_session,
            &retry.report_tool_id,
        )
        .await
        .map_err(|error| error.to_string())?;
    let intent = if source
        .relationship
        .as_ref()
        .and_then(|link| link.kind.as_ref())
        == Some(&SessionRelationshipKind::DeepReview)
    {
        ReviewLaunchIntent::Strict
    } else {
        ReviewLaunchIntent::Review
    };
    let paths: std::collections::BTreeSet<_> = checks
        .iter()
        .flat_map(|check| check.paths.iter().cloned())
        .collect();
    if paths.is_empty() {
        return Ok(refused(
            intent,
            "review_retry_no_scope",
            "This report has no confirmed incomplete file scope",
        ));
    }
    if source
        .workspace_hostname
        .as_deref()
        .is_some_and(|host| host != "localhost")
    {
        return Err("The original Review used a remote workspace".into());
    }
    let root = source
        .execution_target
        .as_ref()
        .map(|target| target.root_path.clone())
        .or(source.workspace_path.clone())
        .filter(|path| !path.trim().is_empty())
        .ok_or("The original Review checkout is unavailable")?;
    let exact: Vec<_> = paths.iter().cloned().collect();
    let focus = "Review only the incomplete coverage named by this prepared file scope. The earlier report remains separate.";
    let planned = match evidence.source() {
        ReviewTargetEvidenceSource::Workspace => {
            prepare_workspace_review(&root, &exact, intent, focus, true).await?
        }
        ReviewTargetEvidenceSource::GitRange => {
            let base = evidence
                .base_revision()
                .ok_or("The original Review base is unavailable")?;
            let head = evidence
                .head_revision()
                .ok_or("The original Review head is unavailable")?;
            let range = ReviewGitRange {
                base: base.into(),
                head: head.into(),
                focus: focus.into(),
            };
            let revisions = ReviewGitRevisions {
                base_revision: base.into(),
                head_revision: head.into(),
            };
            let diff_paths: Vec<_> = exact
                .iter()
                .flat_map(|path| evidence.diff_paths_for_path(path))
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect();
            prepare_git_range_review(
                &root,
                &range,
                Some(&revisions),
                intent,
                Some((&exact, &diff_paths)),
            )
            .await?
        }
        ReviewTargetEvidenceSource::PullRequest => {
            return Ok(refused(
                intent,
                "review_retry_provider_unsupported",
                "Provider Review currently supports a full re-review of the pull request.",
            ));
        }
    };
    let mut plan = match planned {
        Ok(plan) => plan,
        Err(answer) => return Ok(answer),
    };
    if plan
        .requested_files
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        != paths
    {
        return Ok(refused(
            intent,
            "review_retry_scope_changed",
            "The exact incomplete file scope could not be resolved. Open the latest Review report.",
        ));
    }
    let fingerprint = stable_review_fingerprint(&json!([
        identity,
        evidence.fingerprint(),
        checks,
        plan.target_evidence["fingerprint"]
    ]));
    if request.dry_run {
        let mut answer = prepared_response(&plan);
        answer.scope_fingerprint = Some(fingerprint);
        return Ok(answer);
    }
    if retry.scope_fingerprint.as_deref() != Some(fingerprint.as_str()) {
        return Ok(refused(
            intent,
            "review_retry_scope_changed",
            "The incomplete Review scope changed. Confirm the latest scope before starting.",
        ));
    }
    plan.manifest["retryCoverageSource"] = json!({
        "sessionId": source_session,
        "reportToolId": retry.report_tool_id,
        "scopeFingerprint": fingerprint,
    });
    start_prepared_review(
        app,
        coordinator,
        app_state,
        runtime,
        plan,
        ReviewSessionLaunch {
            parent_session_id: source_session.into(),
            workspace_id: workspace_id.into(),
            project_root,
            execution_root: root,
            model_name: Some(source.model_name),
            request_id: Some(format!("coverage_{fingerprint}")),
            child_session_name: request.child_session_name,
            display_message: request.display_message,
            pull_request: false,
            revision: None,
        },
    )
    .await
}

async fn prepare_git_range_review(
    execution_root: &str,
    range: &ReviewGitRange,
    expected: Option<&ReviewGitRevisions>,
    intent: ReviewLaunchIntent,
    exact_scope: Option<(&[String], &[String])>,
) -> Result<Result<ReviewLaunchPlan, LaunchReviewResponse>, String> {
    let repo = Path::new(execution_root);
    let (base, head) = tokio::join!(
        GitService::resolve_revision(repo, &range.base),
        GitService::resolve_revision(repo, &range.head)
    );
    let revisions = match (base, head) {
        (Ok(base_revision), Ok(head_revision)) => ReviewGitRevisions {
            base_revision,
            head_revision,
        },
        results => {
            let actionable = [results.0.err(), results.1.err()]
                .into_iter()
                .flatten()
                .find_map(|error| git_refusal(intent, &error));
            return Ok(Err(actionable.unwrap_or_else(|| {
                refusal_response(intent, &ReviewLaunchRefusal::GitRangeUnresolved)
            })));
        }
    };
    if expected.is_some_and(|expected| expected != &revisions) {
        return Ok(Err(refused(
            intent,
            "review_git_range_changed",
            "The Git refs changed after preparation. Run the Review command again.",
        )));
    }
    let changed_args = GitChangedFilesParams {
        source: Some(revisions.base_revision.clone()),
        target: Some(revisions.head_revision.clone()),
        review_safe: Some(true),
        ..Default::default()
    };
    let diff_args = GitDiffParams {
        source: changed_args.source.clone(),
        target: changed_args.target.clone(),
        files: exact_scope.map(|(_, diff_paths)| diff_paths.to_vec()),
        review_safe: Some(true),
        ..Default::default()
    };
    let (changed, diff, binding) = tokio::join!(
        GitService::get_changed_files(repo, &changed_args),
        GitService::get_diff(repo, &diff_args),
        git_range_checkout_binding(repo, &revisions.head_revision),
    );
    let changes = match changed {
        Ok(changes) => changes
            .into_iter()
            .filter(|change| exact_scope.is_none_or(|(paths, _)| paths.contains(&change.path)))
            .map(|change| WorkspaceChange {
                path: change.path,
                previous_path: change.old_path,
                status: changed_file_status(&change.status).into(),
                untracked: false,
                conflicted: false,
            })
            .collect(),
        Err(error) => {
            return Ok(Err(git_refusal(intent, &error).unwrap_or_else(|| {
                warn!("Review range files unavailable: {error}");
                refused(
                    intent,
                    "review_git_range_files_unavailable",
                    "The changed files between these Git commits could not be read.",
                )
            })))
        }
    };
    let snapshot = GitRangeReviewSnapshot {
        base_revision: revisions.base_revision,
        head_revision: revisions.head_revision,
        workspace_binding: binding,
        changes,
        diff: diff
            .map_err(|error| warn!("Review range diff unavailable: {error}"))
            .ok(),
    };
    Ok(
        plan_git_range_review(snapshot, intent, &range.focus, execution_root)
            .map_err(|refusal| refusal_response(intent, &refusal)),
    )
}

async fn git_range_checkout_binding(
    repo: &Path,
    target_head: &str,
) -> ReviewTargetWorkspaceBinding {
    use ReviewTargetWorkspaceBinding::{MatchingClean, MatchingDirty, Mismatched, Unavailable};

    match GitService::resolve_revision(repo, "HEAD").await {
        Ok(head) if head == target_head => {}
        Ok(_) => return Mismatched,
        Err(_) => return Unavailable,
    }
    let Ok(status) = GitService::get_status(repo).await else {
        return Unavailable;
    };
    match GitService::resolve_revision(repo, "HEAD").await {
        Ok(head) if head == target_head => {
            if status.staged.is_empty()
                && status.unstaged.is_empty()
                && status.untracked.is_empty()
                && status.conflicts.is_empty()
            {
                MatchingClean
            } else {
                MatchingDirty
            }
        }
        Ok(_) => Mismatched,
        Err(_) => Unavailable,
    }
}

async fn prepare_workspace_review(
    execution_root: &str,
    files: &[String],
    intent: ReviewLaunchIntent,
    focus: &str,
    from_saved_review: bool,
) -> Result<Result<ReviewLaunchPlan, LaunchReviewResponse>, String> {
    let repo = Path::new(execution_root);

    let status = match GitService::get_status(repo).await {
        Ok(status) => status,
        Err(error) => {
            return git_refusal(intent, &error)
                .map(|response| Ok(Err(response)))
                .unwrap_or_else(|| Err(format!("Failed to read workspace changes: {error}")));
        }
    };
    let changed = GitService::get_changed_files(
        repo,
        &GitChangedFilesParams {
            source: Some("HEAD".to_string()),
            review_safe: Some(true),
            ..Default::default()
        },
    )
    .await
    .unwrap_or_default();
    let all_changes = collect_workspace_changes(&status, &changed);
    let (changes, unmatched) = if from_saved_review && !files.is_empty() {
        let matches = |path: &str| {
            files.iter().any(|file| {
                if cfg!(windows) {
                    file.eq_ignore_ascii_case(path)
                } else {
                    file == path
                }
            })
        };
        let changes = all_changes
            .into_iter()
            .filter(|change| {
                matches(&change.path) || change.previous_path.as_deref().is_some_and(matches)
            })
            .collect();
        let changes: Vec<_> = changes;
        if changes.is_empty() {
            return Ok(Err(refusal_response(
                intent,
                &ReviewLaunchRefusal::EmptyScope {
                    paths: files.to_vec(),
                },
            )));
        }
        (changes, Vec::new())
    } else {
        match scope_workspace_changes(&all_changes, files) {
            Ok(scoped) => scoped,
            Err(refusal) => return Ok(Err(refusal_response(intent, &refusal))),
        }
    };
    if !unmatched.is_empty() {
        let missing = unmatched
            .iter()
            .filter(|entry| !repo.join(entry.as_str()).exists())
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Ok(Err(refusal_response(
                intent,
                &ReviewLaunchRefusal::MissingScope { paths: missing },
            )));
        }
        if changes.is_empty() {
            return Ok(Err(refusal_response(
                intent,
                &ReviewLaunchRefusal::EmptyScope { paths: unmatched },
            )));
        }
    }

    let tracked_paths = changes
        .iter()
        .filter(|change| !change.untracked)
        .flat_map(|change| std::iter::once(change.path.clone()).chain(change.previous_path.clone()))
        .collect::<Vec<_>>();
    let base_revision = GitService::resolve_revision(repo, "HEAD").await.ok();
    let diff = if tracked_paths.is_empty() {
        Some(String::new())
    } else if base_revision.is_none() {
        None
    } else {
        GitService::get_diff(
            repo,
            &GitDiffParams {
                source: Some("HEAD".to_string()),
                target: None,
                files: Some(tracked_paths),
                staged: None,
                stat: None,
                review_safe: Some(true),
            },
        )
        .await
        .map_err(|error| warn!("Review diff unavailable: {error}"))
        .ok()
    };
    let mut untracked = BTreeMap::new();
    for change in changes.iter().filter(|change| change.untracked) {
        untracked.insert(
            change.path.clone(),
            untracked_fact(repo, &change.path).await,
        );
    }
    let snapshot = WorkspaceReviewSnapshot {
        base_revision,
        changes,
        diff,
        untracked,
    };
    Ok(
        plan_workspace_review(&snapshot, intent, focus, execution_root)
            .map_err(|refusal| refusal_response(intent, &refusal)),
    )
}

/// Reads the owning runtime's saved Reviews for this exact provider request.
// @backend-command
pub async fn review_platform_list_pull_request_reviews(
    runtime: State<'_, DesktopRuntimeContext>,
    request: PullRequestReviewHistoryRequest,
) -> Result<PullRequestReviewPage, String> {
    if request.workspace_id.trim().is_empty() {
        return Err("workspaceId is required".into());
    }
    runtime
        .session_application()
        .pull_request_review_history(
            desktop_session_scope(Some(request.workspace_id), String::new(), None, None),
            &request.selection,
            request.before.as_ref(),
        )
        .await
        .map_err(|error| error.to_string())
}

/// Reads the owning runtime's latest saved Review revision per parent record.
// @backend-command
pub async fn list_session_review_records(
    runtime: State<'_, DesktopRuntimeContext>,
    request: ListSessionReviewRecordsRequest,
) -> Result<SessionReviewPage, String> {
    if request.workspace_id.trim().is_empty() {
        return Err("workspaceId is required".into());
    }
    runtime
        .session_application()
        .list_session_review_records(
            desktop_session_scope(Some(request.workspace_id), String::new(), None, None),
            &request.session_id,
            request.before.as_ref(),
        )
        .await
        .map_err(|error| error.to_string())
}

/// Prepares or starts the user-approved fixer on the owning runtime.
// @backend-command
pub async fn launch_review_remediation(
    app: HostHandle,
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    runtime: State<'_, DesktopRuntimeContext>,
    request: LaunchReviewRemediationRequest,
) -> Result<LaunchReviewRemediationResponse, String> {
    let workspace = app_state
        .workspace_service
        .require_workspace(&request.workspace_id)
        .await
        .map_err(|error| error.to_string())?;
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Err("Review fixes require an editable local checkout on the owning device".into());
    }
    let report_lock = stable_review_fingerprint(&json!([
        workspace.id,
        request.session_id,
        request.report_tool_id
    ]));
    let _report_guard = if request.approved.is_some() || request.review_fixes.is_some() {
        Some(REMEDIATION_LAUNCHES.lock(&report_lock).await)
    } else {
        None
    };
    let (plan, evidence, review) = runtime
        .session_application()
        .load_workspace_review_remediation(
            desktop_session_scope(Some(workspace.id.clone()), String::new(), None, None),
            &request.session_id,
            &request.report_tool_id,
        )
        .await
        .map_err(|error| error.to_string())?;
    if let Some(follow_up) = request.review_fixes.as_ref() {
        if request.approved.is_some() {
            return Err("Choose either Review fixes or start fixes".into());
        }
        let selection = ReviewFixesSource {
            workspace_id: &workspace.id,
            project_root: &workspace.root_path,
            plan: &plan,
            evidence: &evidence,
            review: &review,
            report_tool_id: &request.report_tool_id,
        };
        return start_workspace_post_fix_review(
            app,
            coordinator,
            app_state,
            runtime,
            selection,
            follow_up,
        )
        .await;
    }
    let progress = || {
        runtime
            .session_application()
            .workspace_review_remediation_progress(
                desktop_session_scope(Some(workspace.id.clone()), String::new(), None, None),
                &request.session_id,
                &request.report_tool_id,
                &plan,
                None,
            )
    };
    let Some(approved) = request.approved.as_ref() else {
        let progress = progress().await.map_err(|error| error.to_string())?;
        let post_fix_review = if progress.latest_run.is_some() {
            match workspace_post_fix_runs(&runtime, &workspace.id, &review).await {
                Ok(runs) => project_post_fix_review(
                    &runs,
                    &review.session_id,
                    &request.report_tool_id,
                    &progress,
                ),
                Err(error) => {
                    warn!("Post-fix Review history is unavailable: {error}");
                    PostFixReviewState::default()
                }
            }
        } else {
            PostFixReviewState::default()
        };
        return Ok(LaunchReviewRemediationResponse::Prepared {
            plan,
            progress,
            post_fix_review,
        });
    };
    let request_id = uuid::Uuid::parse_str(&approved.request_id)
        .map_err(|_| "Review fix requires a valid request ID")?;
    let mut prompt = plan.prompt(
        &approved.report_revision,
        &approved.selection,
        approved.instructions.as_deref(),
    )?;
    let paths = evidence
        .files()
        .iter()
        .map(|file| file.path())
        .collect::<Vec<_>>();
    prompt.push_str("\n\nReviewed workspace paths (JSON):\n");
    prompt.push_str(&serde_json::to_string(&paths).map_err(|error| error.to_string())?);
    let project_root = workspace.root_path.to_string_lossy().into_owned();
    let execution_root = review
        .execution_target
        .as_ref()
        .map(|target| target.root_path.as_str())
        .or(review.workspace_path.as_deref())
        .filter(|path| !path.trim().is_empty())
        .ok_or("The original Review checkout is unavailable")?;
    let child_session_id = format!("review_fix_{}", request_id.simple());
    let turn_id = format!("review_fix_turn_{}", request_id.simple());
    let _launch_guard = REMEDIATION_LAUNCHES.lock(&child_session_id).await;
    let manager = Arc::clone(coordinator.get_session_manager());
    let storage = desktop_session_storage_root(
        &coordinator,
        Some(&workspace.id),
        Some(&project_root),
        None,
        None,
    )
    .await?;
    let previous = manager
        .load_session_metadata(&storage, &child_session_id)
        .await
        .map_err(|error| error.to_string())?;
    let existed = previous.is_some() || manager.get_session(&child_session_id).is_some();
    if !existed {
        let progress = progress().await.map_err(|error| error.to_string())?;
        if progress.running {
            return Err(
                "A fix for this report is already running. Open its fix session to follow progress"
                    .into(),
            );
        }
        if approved
            .selection
            .iter()
            .any(|item| progress.items.get(&item.id) == Some(&ReviewFixItemState::Completed))
        {
            return Err("A selected item was already reported complete. Refresh the report before choosing remaining fixes".into());
        }
        let current = GitService::resolve_revision(Path::new(execution_root), "HEAD")
            .await
            .map_err(|error| format!("The Review checkout is unavailable: {error}"))?;
        if evidence.base_revision() != Some(current.as_str()) {
            return Err("The checkout changed since this Review. Review the current changes before starting fixes".into());
        }
    }
    let action_fingerprint = stable_review_fingerprint(&json!([request.report_tool_id, prompt]));
    let create: CreateSessionRequest = serde_json::from_value(json!({
        "sessionId": child_session_id,
        "sessionName": approved.child_session_name,
        "agentType": REVIEW_FIXER_AGENT_TYPE,
        "workspaceId": workspace.id,
        "workspacePath": execution_root,
        "projectWorkspacePath": project_root,
        "relationship": {
            "kind": "review",
            "parentSessionId": request.session_id,
            "parentToolCallId": request.report_tool_id,
            "parentRequestId": format!("fix-{request_id}-{action_fingerprint}"),
        },
        "config": { "modelName": review.model_name, "enableTools": true, "safeMode": true },
    }))
    .map_err(|error| format!("Invalid Review fix session request: {error}"))?;
    let created = create_session(coordinator, app_state, runtime, create).await?;
    let started = if existed {
        manager
            .get_session(&created.session_id)
            .is_some_and(|session| session.dialog_turn_ids.contains(&turn_id))
            || previous
                .and_then(|record| record.last_turn)
                .is_some_and(|turn| turn.turn_id == turn_id)
    } else {
        let tracking = ReviewRemediationTracking {
            report_revision: plan.report_revision,
            turn_id: turn_id.clone(),
            item_ids: plan
                .items
                .into_iter()
                .filter(|item| {
                    approved
                        .selection
                        .iter()
                        .any(|selected| selected.id == item.id)
                })
                .map(|item| item.id)
                .collect(),
        };
        manager
            .merge_session_custom_metadata(
                &created.session_id,
                json!({ (REMEDIATION_TRACKING_KEY): &tracking }),
            )
            .await
            .map_err(|error| error.to_string())?;
        // Keep the existing idempotency fingerprint compatible with earlier clients.
        tracking.append_progress_instructions(&mut prompt);
        let turn: StartDialogTurnRequest = serde_json::from_value(json!({
            "sessionId": created.session_id,
            "userInput": prompt,
            "originalUserInput": approved.display_message,
            "agentType": REVIEW_FIXER_AGENT_TYPE,
            "workspaceId": workspace.id,
            "workspacePath": execution_root,
            "projectWorkspacePath": project_root,
            "turnId": turn_id,
        }))
        .map_err(|error| format!("Invalid Review fix turn request: {error}"))?;
        match start_dialog_turn(app, runtime, turn).await {
            Ok(_) => true,
            Err(error) => {
                warn!(
                    "Review fix start acknowledgement was uncertain: child={}, error={error}",
                    created.session_id
                );
                false
            }
        }
    };
    let child_session_id = created.session_id;
    let child_session_name = created.session_name;
    Ok(if started {
        LaunchReviewRemediationResponse::Started {
            child_session_id,
            child_session_name,
        }
    } else {
        LaunchReviewRemediationResponse::Uncertain {
            child_session_id,
            child_session_name,
        }
    })
}

// Post-fix actions reuse the report's owner route and the standard Review planner.
struct ReviewFixesSource<'a> {
    workspace_id: &'a str,
    project_root: &'a Path,
    plan: &'a ReviewRemediationPlan,
    evidence: &'a ReviewTargetEvidence,
    review: &'a SessionMetadata,
    report_tool_id: &'a str,
}

fn review_parent(review: &SessionMetadata) -> Result<&str, String> {
    review
        .relationship
        .as_ref()
        .and_then(|relationship| relationship.parent_session_id.as_deref())
        .ok_or_else(|| "The saved Review no longer has its original chat".into())
}

async fn workspace_post_fix_runs(
    runtime: &DesktopRuntimeContext,
    workspace_id: &str,
    review: &SessionMetadata,
) -> Result<Vec<PullRequestReviewRun>, String> {
    let revision = PullRequestReviewRevision::read(review)?;
    runtime
        .session_application()
        .workspace_review_record_runs(
            desktop_session_scope(Some(workspace_id.to_owned()), String::new(), None, None),
            review_parent(review)?,
            &revision.record_id,
        )
        .await
        .map_err(|error| error.to_string())
}

fn linked_post_fix_run<'a>(
    runs: &'a [PullRequestReviewRun],
    source_session_id: &str,
    report_tool_id: &str,
) -> Option<&'a PullRequestReviewRun> {
    runs.iter()
        .filter(|run| {
            run.record_history_complete
                && run.revision.post_fix.as_ref().is_some_and(|link| {
                    link.source_session_id == source_session_id
                        && link.report_tool_id == report_tool_id
                })
        })
        .max_by_key(|run| run.revision.number)
}

fn project_post_fix_review(
    runs: &[PullRequestReviewRun],
    source_session_id: &str,
    report_tool_id: &str,
    progress: &ReviewRemediationProgress,
) -> PostFixReviewState {
    let linked = linked_post_fix_run(runs, source_session_id, report_tool_id);
    let existing = linked.map(|run| PostFixReviewChild {
        session_id: run.session_id.clone(),
        session_name: run.session_name.clone(),
        agent_type: run.agent_type.clone(),
        phase: run.phase,
    });
    let selection = runs
        .iter()
        .find(|run| run.latest_for_record)
        .zip(progress.latest_run.as_ref())
        .filter(|(latest, fixer)| {
            if progress.running
                || matches!(
                    fixer.state,
                    ReviewFixRunState::Running | ReviewFixRunState::StartUnconfirmed
                )
            {
                return false;
            }
            if latest.session_id == source_session_id {
                return true;
            }
            if linked.is_none_or(|run| run.session_id != latest.session_id) {
                return false;
            }
            let same_fix = latest
                .revision
                .post_fix
                .as_ref()
                .is_some_and(|link| link.fix_session_id == fixer.session_id);
            match latest.phase {
                ReviewRunPhase::Failed | ReviewRunPhase::Stopped | ReviewRunPhase::Interrupted => {
                    true
                }
                ReviewRunPhase::Completed => !same_fix,
                _ => false,
            }
        })
        .map(|(previous, fixer)| PostFixReviewSelection {
            fix_session_id: fixer.session_id.clone(),
            previous_review_session_id: previous.session_id.clone(),
        });
    PostFixReviewState {
        selection,
        existing,
    }
}

async fn start_workspace_post_fix_review(
    app: HostHandle,
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    runtime: State<'_, DesktopRuntimeContext>,
    source: ReviewFixesSource<'_>,
    request: &ReviewFixesRequest,
) -> Result<LaunchReviewRemediationResponse, String> {
    let ReviewFixesSource {
        workspace_id,
        project_root,
        plan,
        evidence,
        review,
        report_tool_id,
    } = source;
    let parent_session_id = review_parent(review)?.to_owned();
    let root = review
        .execution_target
        .as_ref()
        .map(|target| target.root_path.as_str())
        .or(review.workspace_path.as_deref())
        .filter(|path| !path.trim().is_empty())
        .ok_or("The original Review checkout is unavailable")?;
    let intent = if review.relationship.as_ref().is_some_and(|relationship| {
        relationship.kind
            == Some(openbitfun_core::service::session::SessionRelationshipKind::DeepReview)
    }) {
        ReviewLaunchIntent::Strict
    } else {
        ReviewLaunchIntent::Review
    };
    if request.report_revision != plan.report_revision {
        return Err(
            "The Review report changed. Reopen the latest report before reviewing fixes".into(),
        );
    }
    let anchor = PullRequestReviewRevision::read(review)?;
    let record_guard = lock_review_record(&anchor.record_id).await;
    let runs = workspace_post_fix_runs(&runtime, workspace_id, review).await?;

    if let Some(existing) =
        linked_post_fix_run(&runs, &review.session_id, report_tool_id).filter(|run| {
            run.revision.previous_session_id.as_deref()
                == Some(request.selection.previous_review_session_id.as_str())
                && run
                    .revision
                    .post_fix
                    .as_ref()
                    .is_some_and(|link| link.fix_session_id == request.selection.fix_session_id)
        })
    {
        // A second controller or a lost acknowledgement must reopen the
        // already reserved child, including a metadata-only pending revision.
        return Ok(LaunchReviewRemediationResponse::Review {
            review: LaunchReviewResponse {
                status: if existing.phase == ReviewRunPhase::Pending {
                    "uncertain"
                } else {
                    "already_running"
                }
                .into(),
                intent: intent.as_str().into(),
                agent_type: Some(existing.agent_type.clone()),
                child_session_id: Some(existing.session_id.clone()),
                child_session_name: Some(existing.session_name.clone()),
                ..Default::default()
            },
            workspace_fallback: false,
            scope_fingerprint: None,
        });
    }

    let mut scope = PostFixReviewScope::from_evidence(evidence);
    let progress = runtime
        .session_application()
        .workspace_review_remediation_progress(
            desktop_session_scope(Some(workspace_id.to_owned()), String::new(), None, None),
            &review.session_id,
            report_tool_id,
            plan,
            Some((root, &mut scope)),
        )
        .await
        .map_err(|error| error.to_string())?;
    let state = project_post_fix_review(&runs, &review.session_id, report_tool_id, &progress);
    let selected = state
        .selection
        .as_ref()
        .filter(|selected| *selected == &request.selection)
        .ok_or("The fix or Review revision changed. Refresh the report before reviewing fixes")?;
    let files = scope.files();
    let workspace_fallback = files.is_none();
    let preparation = prepare_workspace_review(
        root, files.as_deref().unwrap_or_default(), intent,
        "Re-review the workspace changes after the approved fixes. Check for remaining issues and regressions.",
        true,
    ).await?;
    let plan = match preparation {
        Ok(plan) => plan,
        Err(review) => {
            return Ok(LaunchReviewRemediationResponse::Review {
                review,
                workspace_fallback,
                scope_fingerprint: None,
            })
        }
    };
    let scope_fingerprint = stable_review_fingerprint(&json!([
        workspace_fallback,
        plan.intent.as_str(),
        plan.target_evidence["fingerprint"]
    ]));
    let Some(approved_scope) = request.scope_fingerprint.as_deref() else {
        return Ok(LaunchReviewRemediationResponse::Review {
            review: prepared_response(&plan),
            workspace_fallback,
            scope_fingerprint: Some(scope_fingerprint),
        });
    };
    if approved_scope != scope_fingerprint {
        return Ok(LaunchReviewRemediationResponse::Review {
            review: refused(
                intent,
                "review_post_fix_scope_changed",
                "The workspace diff changed. Review the updated scope before continuing.",
            ),
            workspace_fallback,
            scope_fingerprint: None,
        });
    }
    let previous = runs
        .iter()
        .find(|run| run.session_id == selected.previous_review_session_id)
        .ok_or("The preceding Review revision is unavailable")?;
    let number = previous
        .revision
        .number
        .checked_add(1)
        .ok_or("Review revision limit reached")?;
    let request_id = format!(
        "post_fix_{}",
        stable_review_fingerprint(&json!([
            workspace_id,
            anchor.record_id,
            previous.session_id,
            review.session_id,
            report_tool_id,
            selected.fix_session_id
        ]))
    );
    let revision = PullRequestReviewRevision {
        record_id: anchor.record_id,
        previous_session_id: Some(previous.session_id.clone()),
        number,
        post_fix: Some(PostFixReviewLink {
            source_session_id: review.session_id.clone(),
            report_tool_id: report_tool_id.to_owned(),
            fix_session_id: selected.fix_session_id.clone(),
        }),
    };
    let review = start_prepared_review(
        app,
        coordinator,
        app_state,
        runtime,
        plan,
        ReviewSessionLaunch {
            parent_session_id,
            workspace_id: workspace_id.to_owned(),
            project_root: project_root.to_string_lossy().into_owned(),
            execution_root: root.to_owned(),
            model_name: Some(review.model_name.clone()),
            request_id: Some(request_id),
            child_session_name: Some(request.child_session_name.clone()),
            display_message: Some(request.display_message.clone()),
            pull_request: false,
            revision: Some((revision, record_guard)),
        },
    )
    .await?;
    Ok(LaunchReviewRemediationResponse::Review {
        review,
        workspace_fallback,
        scope_fingerprint: None,
    })
}

fn prepared_response(plan: &ReviewLaunchPlan) -> LaunchReviewResponse {
    let evidence = &plan.target_evidence;
    let git_range = match (
        evidence["source"].as_str(),
        evidence["baseRevision"].as_str(),
        evidence["headRevision"].as_str(),
    ) {
        (Some("git_range"), Some(base), Some(head)) => Some(ReviewGitRevisions {
            base_revision: base.into(),
            head_revision: head.into(),
        }),
        _ => None,
    };
    LaunchReviewResponse {
        status: "prepared".to_string(),
        intent: plan.intent.as_str().to_string(),
        mode: Some(plan.mode.to_string()),
        agent_type: Some(plan.agent_type.to_string()),
        git_range,
        file_count: plan.file_count,
        planned_file_count: plan.manifest["managedReviewPlan"]["plannedFileCount"].as_u64(),
        deferred_file_count: plan.manifest["managedReviewPlan"]["deferredFileCount"].as_u64(),
        changed_line_count: plan.changed_line_count,
        completeness: Some(plan.completeness.clone()),
        limitations: plan.limitations.clone(),
        files: plan_files(plan),
        ..Default::default()
    }
}

fn pull_request_selection_matches(
    request: &LaunchPullRequestReviewRequest,
    remote: &ReviewPlatformRemote,
    pull_request: &ReviewPlatformPullRequest,
) -> bool {
    let revision_matches = |expected: Option<&str>, actual: Option<&str>| {
        expected.is_none_or(|expected| {
            actual.is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
        })
    };
    request.remote_id == remote.id
        && request.provider.platform == remote.platform
        && request.provider.host.eq_ignore_ascii_case(&remote.host)
        && request.provider.project_path == remote.project_path
        && revision_matches(
            request.expected_base_revision.as_deref(),
            pull_request.base_revision.as_deref(),
        )
        && revision_matches(
            request.expected_head_revision.as_deref(),
            pull_request.head_revision.as_deref(),
        )
}

/// Prepares an ordinary read-only Review of the selected provider pull request.
// @backend-command
pub async fn review_platform_launch_pull_request_review(
    app: HostHandle,
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    runtime: State<'_, DesktopRuntimeContext>,
    request: LaunchPullRequestReviewRequest,
) -> Result<LaunchReviewResponse, String> {
    let intent = ReviewLaunchIntent::Review;
    let workspace_id = request.workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("workspaceId is required".into());
    }
    let request_id = request.request_id.as_deref();
    if !request.dry_run
        && !request_id.is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 80
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
    {
        return Err("A valid pull request Review requestId is required".into());
    }
    let workspace = app_state
        .workspace_service
        .require_workspace(workspace_id)
        .await
        .map_err(|error| error.to_string())?;
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Ok(refused(
            intent,
            "review_remote_workspace_unsupported",
            "Pull request Review is unavailable for SSH workspaces on this runtime.",
        ));
    }
    let project_root = workspace.root_path.to_string_lossy().into_owned();
    let history_scope =
        desktop_session_scope(Some(workspace.id.clone()), project_root.clone(), None, None);
    let preceding_metadata =
        if let Some(previous_id) = request.previous_review_session_id.as_deref() {
            openbitfun_core_types::validate_session_id(previous_id)?;
            let saved = runtime
                .session_application()
                .load_session_metadata(history_scope.clone(), previous_id)
                .await
                .map_err(|error| error.to_string())?;
            let Some(saved) = saved else {
                return Ok(refused(
                    intent,
                    "review_pull_request_record_changed",
                    "The selected Review record is unavailable. Refresh its history.",
                ));
            };
            Some(saved)
        } else {
            None
        };
    let requested_parent = request
        .parent_session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let parent_session_id = if let Some(saved) = preceding_metadata.as_ref() {
        let parent = saved
            .relationship
            .as_ref()
            .and_then(|relationship| relationship.parent_session_id.as_deref());
        let Some(parent) =
            parent.filter(|parent| requested_parent.is_none_or(|requested| requested == *parent))
        else {
            return Ok(refused(
                intent,
                "review_pull_request_record_changed",
                "The review record no longer belongs to this chat.",
            ));
        };
        parent.to_owned()
    } else {
        requested_parent
            .ok_or_else(|| "parentSessionId is required for a new PR Review".to_string())?
            .to_owned()
    };
    let parent = match coordinator
        .get_session_manager()
        .get_session(&parent_session_id)
    {
        Some(session) => session,
        None => match runtime
            .session_application()
            .restore_session(
                desktop_session_scope(Some(workspace.id.clone()), project_root.clone(), None, None),
                &parent_session_id,
                false,
            )
            .await
        {
            Ok(session) => session,
            Err(error) => {
                warn!("Pull request Review parent is unavailable: {error}");
                return Ok(refused(
                    intent,
                    "review_pull_request_session_required",
                    "Open a chat in the selected workspace to start a pull request Review.",
                ));
            }
        },
    };
    let owns_parent = parent.config.workspace_id.as_deref() == Some(workspace.id.as_str())
        || parent.config.project_workspace_id.as_deref() == Some(workspace.id.as_str());
    if !owns_parent || parent.kind != openbitfun_core_types::SessionKind::Standard {
        return Ok(refused(
            intent,
            "review_pull_request_session_required",
            "Open a chat in the selected workspace to start a pull request Review.",
        ));
    }
    if parent.config.workspace_kind == Some(WorkspaceKind::Remote)
        || parent.config.remote_connection_id.is_some()
    {
        return Ok(refused(
            intent,
            "review_remote_workspace_unsupported",
            "Pull request Review is unavailable for SSH workspaces on this runtime.",
        ));
    }

    let _request_guard = match request_id {
        Some(id) if !request.dry_run => Some(PULL_REQUEST_LAUNCHES.lock(id).await),
        _ => None,
    };
    let repository = ReviewRepositoryLocator::new(Some(workspace.id.clone()), &project_root);
    let (remote, target) = ReviewPlatformService::pull_request_review_target_with_remote(
        &repository,
        &request.remote_id,
        &request.pull_request_id,
    )
    .await
    .map_err(|error| review_platform_ui_error(&error))?;
    if !pull_request_selection_matches(&request, &remote, &target.pull_request) {
        return Ok(refused(intent, "review_pull_request_changed",
            "The pull request or its repository changed. Refresh its details before starting a Review."));
    }
    let pr = target.pull_request;
    let snapshot = PullRequestReviewSnapshot {
        remote_id: remote.id,
        platform: remote.platform.as_str().into(),
        host: remote.host,
        project_path: remote.project_path,
        pull_request_id: pr.id,
        number: u64::try_from(pr.number)
            .map_err(|_| "Invalid provider pull request number".to_string())?,
        web_url: pr.web_url,
        base_revision: pr.base_revision,
        head_revision: pr.head_revision,
        files: target
            .files
            .into_iter()
            .map(|file| PullRequestReviewFile {
                path: file.path,
                previous_path: file.old_path,
                status: match file.status {
                    ReviewFileStatus::Added => "added",
                    ReviewFileStatus::Modified => "modified",
                    ReviewFileStatus::Deleted => "deleted",
                    ReviewFileStatus::Renamed => "renamed",
                }
                .into(),
                changed_lines: u64::from(file.additions.max(0) as u32)
                    + u64::from(file.deletions.max(0) as u32),
                diff_available: file.diff_available,
            })
            .collect(),
        omitted_file_count: target.omitted_file_count,
        limitations: target.limitations,
    };
    let plan = match plan_pull_request_review(&snapshot, &project_root) {
        Ok(plan) => plan,
        Err(refusal) => return Ok(refusal_response(intent, &refusal)),
    };
    if request.dry_run && request.previous_review_session_id.is_none() {
        return Ok(prepared_response(&plan));
    }
    let selection = PullRequestReviewSelection {
        platform: snapshot.platform,
        host: snapshot.host,
        project_path: snapshot.project_path,
        pull_request_id: snapshot.pull_request_id,
        base_revision: snapshot.base_revision,
        head_revision: snapshot.head_revision,
    };
    // Separate controllers can launch the same PR with different request ids.
    // Serialize across different commit pairs for the same provider PR on this owner.
    let active_key = json!([
        workspace.id,
        selection.platform,
        selection.host.to_ascii_lowercase(),
        if selection.platform == "github" {
            selection.project_path.to_ascii_lowercase()
        } else {
            selection.project_path.clone()
        },
        selection.pull_request_id
    ])
    .to_string();
    let _target_guard = PULL_REQUEST_LAUNCHES.lock(&active_key).await;
    let new_child_id = if request.dry_run {
        None
    } else {
        request_id.map(review_child_session_id)
    };
    let revision = if let Some(metadata) = preceding_metadata {
        let previous_id = metadata.session_id.as_str();
        let Ok(record) = PullRequestReviewRevision::read(&metadata) else {
            return Ok(refused(
                intent,
                "review_pull_request_record_changed",
                "The selected Review record is unavailable. Refresh its history.",
            ));
        };
        let guard = lock_review_record(&record.record_id).await;
        let runs = runtime
            .session_application()
            .pull_request_review_runs(history_scope.clone(), &selection)
            .await
            .map_err(|error| error.to_string())?;
        if let Some(saved) = runs
            .iter()
            .find(|run| Some(run.session_id.as_str()) == new_child_id.as_deref())
        {
            if saved.revision.previous_session_id.as_deref() != Some(previous_id)
                || saved.revision.record_id != record.record_id
                || saved.parent_session_id.as_deref() != Some(parent_session_id.as_str())
                || saved.freshness != ReviewFreshness::Current
            {
                return Ok(refused(
                    intent,
                    "review_pull_request_record_changed",
                    "This request already belongs to a different Review revision.",
                ));
            }
            let mut response = prepared_response(&plan);
            response.status = if matches!(
                saved.phase,
                ReviewRunPhase::Pending | ReviewRunPhase::Unknown
            ) {
                "uncertain"
            } else {
                "started"
            }
            .into();
            response.request_id = request_id.map(str::to_owned);
            response.child_session_id = Some(saved.session_id.clone());
            response.child_session_name = Some(saved.session_name.clone());
            response.parent_review_card = true;
            return Ok(response);
        }
        let Some(previous) = runs.iter().find(|run| {
            run.session_id == previous_id
                && run.latest_for_record
                && run.record_history_complete
                && run.revision.record_id == record.record_id
                && run.parent_session_id.as_deref() == Some(parent_session_id.as_str())
        }) else {
            return Ok(refused(
                intent,
                "review_pull_request_record_changed",
                "The Review record changed. Refresh its history before starting another revision.",
            ));
        };
        if matches!(
            previous.phase,
            ReviewRunPhase::Running | ReviewRunPhase::Pending | ReviewRunPhase::Unknown
        ) || runs.iter().any(|run| {
            run.freshness == ReviewFreshness::Current && run.phase == ReviewRunPhase::Running
        }) {
            return Ok(refused(intent, "review_pull_request_record_busy", "A Review is already in progress. Wait for it to finish before starting another revision."));
        }
        let number = previous
            .revision
            .number
            .checked_add(1)
            .ok_or_else(|| "Review revision number cannot be represented".to_string())?;
        Some((
            PullRequestReviewRevision {
                record_id: record.record_id,
                previous_session_id: Some(previous_id.into()),
                number,
                post_fix: None,
            },
            guard,
        ))
    } else {
        None
    };
    if request.dry_run {
        return Ok(prepared_response(&plan));
    }
    if revision.is_none() {
        let history = runtime
            .session_application()
            .pull_request_review_history(history_scope.clone(), &selection, None)
            .await
            .map_err(|error| error.to_string())?;
        if let (Some(run), Some(child_id)) = (history.current_running, new_child_id) {
            // Transport retries still resolve the original child when a different
            // run was started on the same revisions in the meantime.
            let existing_request = child_id == run.session_id
                || runtime
                    .session_application()
                    .load_session_metadata(history_scope, &child_id)
                    .await
                    .map_err(|error| error.to_string())?
                    .is_some();
            if !existing_request {
                let mut response = prepared_response(&plan);
                response.status = "already_running".to_owned();
                response.mode = None;
                response.agent_type = Some(run.agent_type);
                response.child_session_id = Some(run.session_id);
                response.child_session_name = Some(run.session_name);
                return Ok(response);
            }
        }
    }
    start_prepared_review(
        app,
        coordinator,
        app_state,
        runtime,
        plan,
        ReviewSessionLaunch {
            parent_session_id,
            workspace_id: workspace.id,
            execution_root: project_root.clone(),
            project_root,
            model_name: parent.config.model_id,
            request_id: request.request_id,
            child_session_name: request
                .child_session_name
                .or_else(|| Some(format!("Review: PR #{}", snapshot.number))),
            display_message: request
                .display_message
                .or_else(|| Some(format!("Review pull request #{}", snapshot.number))),
            pull_request: true,
            revision,
        },
    )
    .await
}

struct ReviewSessionLaunch {
    parent_session_id: String,
    workspace_id: String,
    project_root: String,
    execution_root: String,
    model_name: Option<String>,
    request_id: Option<String>,
    child_session_name: Option<String>,
    display_message: Option<String>,
    pull_request: bool,
    revision: Option<(PullRequestReviewRevision, KeyedAsyncLockGuard)>,
}

async fn start_prepared_review(
    app: HostHandle,
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    app_state: State<'_, AppState>,
    runtime: State<'_, DesktopRuntimeContext>,
    plan: ReviewLaunchPlan,
    launch: ReviewSessionLaunch,
) -> Result<LaunchReviewResponse, String> {
    let mut response = prepared_response(&plan);
    let ReviewSessionLaunch {
        parent_session_id,
        workspace_id,
        project_root,
        execution_root,
        model_name,
        request_id,
        child_session_name,
        display_message,
        pull_request,
        revision,
    } = launch;
    let (admitted_review_revision, record_guard) =
        revision.map_or((None, None), |(link, guard)| (Some(link), Some(guard)));
    let request_id = request_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let child_session_id = review_child_session_id(&request_id);
    let turn_id = format!("review_turn_{request_id}");
    let child_session_name = child_session_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| match plan.intent {
            ReviewLaunchIntent::Review => "Review".to_string(),
            ReviewLaunchIntent::Strict => "Review: Strict".to_string(),
        });
    let model_name = model_name
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_else(|| "default".to_string());
    let session_manager = Arc::clone(coordinator.get_session_manager());
    let existing_child = if pull_request
        || admitted_review_revision.is_some()
        || plan.target_evidence["source"].as_str() == Some("git_range")
        || plan.manifest.get("retryCoverageSource").is_some()
    {
        let storage = desktop_session_storage_root(
            &coordinator,
            Some(&workspace_id),
            Some(&project_root),
            None,
            None,
        )
        .await?;
        session_manager.get_session(&child_session_id).is_some()
            || session_manager
                .load_session_metadata(&storage, &child_session_id)
                .await
                .map_err(|error| format!("Failed to check existing Review session: {error}"))?
                .is_some()
    } else {
        false
    };
    let create_payload = json!({
        "sessionId": child_session_id,
        "sessionName": child_session_name,
        "agentType": plan.agent_type,
        "workspacePath": execution_root,
        "projectWorkspacePath": project_root,
        "workspaceId": workspace_id,
        "relationship": {
            "kind": plan.session_kind,
            "parentSessionId": parent_session_id,
            "parentRequestId": request_id,
        },
        "deepReviewRunManifest": plan.manifest,
        "reviewTargetEvidence": plan.target_evidence,
        "config": {
            "modelName": model_name,
            "enableTools": true,
            "safeMode": true,
            "autoCompact": true,
            "enableContextCompression": true,
        },
    });
    let create = || -> Result<CreateSessionRequest, String> {
        let mut request: CreateSessionRequest = serde_json::from_value(create_payload.clone())
            .map_err(|error| format!("Invalid Review session request: {error}"))?;
        request.admitted_review_revision = admitted_review_revision.clone();
        Ok(request)
    };
    let created = match create_session(coordinator, app_state, runtime, create()?).await {
        Ok(created) => created,
        Err(first) => {
            // Creation is idempotent for a Review child with a parent request id.
            warn!("Review child creation was uncertain; retrying: {first}");
            create_session(coordinator, app_state, runtime, create()?).await?
        }
    };
    drop(record_guard);
    response.request_id = Some(request_id.clone());
    response.child_session_id = Some(created.session_id.clone());
    response.child_session_name = Some(created.session_name.clone());
    response.parent_review_card = true;

    if existing_child {
        // Creation verified the same relationship and manifest. A transport retry
        // never sends the initial turn again, even if its first acknowledgement
        // or the creation-to-start handoff was interrupted.
        let started = session_manager
            .get_session(&created.session_id)
            .is_some_and(|session| session.dialog_turn_ids.contains(&turn_id));
        response.status = if started { "started" } else { "uncertain" }.into();
        return Ok(response);
    }

    let display_message = display_message
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| child_session_name.clone());
    let mut turn = json!({
        "sessionId": created.session_id,
        "userInput": plan.prompt,
        "originalUserInput": display_message,
        "agentType": plan.agent_type,
        "workspaceId": workspace_id,
        "workspacePath": execution_root,
        "projectWorkspacePath": project_root,
        "turnId": turn_id,
    });
    if plan.agent_type == DEEP_REVIEW_AGENT_TYPE {
        turn["userMessageMetadata"] = json!({ "deepReviewRunManifest": plan.manifest });
    }
    let turn: StartDialogTurnRequest = serde_json::from_value(turn)
        .map_err(|error| format!("Invalid Review turn request: {error}"))?;
    match start_dialog_turn(app.clone(), runtime, turn).await {
        Ok(_) => {
            info!(
                "Review launched: parent={}, child={}, mode={}, files={}",
                parent_session_id, created.session_id, plan.mode, plan.file_count
            );
            response.status = "started".to_string();
        }
        Err(error) => {
            // The child exists and may be running: keep it, never resubmit.
            warn!(
                "Review start acknowledgement was uncertain: child={}, error={}",
                created.session_id, error
            );
            response.status = "uncertain".to_string();
            response.message = Some(error);
        }
    }
    if let Err(error) = app.emit(
        "agentic://review-record-changed",
        json!({
            "parentSessionId": parent_session_id,
            "workspaceId": workspace_id,
        }),
    ) {
        warn!("Failed to notify the parent Review record: {error}");
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core::service::git::{GitChangedFile, GitFileStatus};

    fn file(path: &str, status: &str) -> GitFileStatus {
        GitFileStatus {
            path: path.to_string(),
            status: status.to_string(),
            index_status: None,
            workdir_status: Some(status.to_string()),
        }
    }

    #[test]
    fn workspace_changes_merge_status_renames_untracked_and_conflicts() {
        let status = GitStatus {
            staged: vec![file("src/old.rs", "R")],
            unstaged: vec![file("src/lib.rs", "M"), file("src/gone.rs", "D")],
            untracked: vec!["notes.md".to_string(), "assets/".to_string()],
            conflicts: vec!["src/conflict.rs".to_string()],
            current_branch: "main".to_string(),
            ahead: 0,
            behind: 0,
        };
        let changed = vec![GitChangedFile {
            path: "src/new.rs".to_string(),
            old_path: Some("src/old.rs".to_string()),
            status: GitChangedFileStatus::Renamed,
        }];
        let changes = collect_workspace_changes(&status, &changed);
        let summary = changes
            .iter()
            .map(|change| {
                (
                    change.path.as_str(),
                    change.previous_path.as_deref(),
                    change.status.as_str(),
                    change.untracked,
                    change.conflicted,
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                ("src/lib.rs", None, "modified", false, false),
                ("src/gone.rs", None, "deleted", false, false),
                ("src/new.rs", Some("src/old.rs"), "renamed", false, false),
                ("notes.md", None, "added", true, false),
                ("assets", None, "unknown", true, false),
                ("src/conflict.rs", None, "unknown", false, true),
            ]
        );
    }

    #[test]
    fn requests_accept_intent_or_command_text() {
        let request: LaunchReviewRequest = serde_json::from_value(json!({
            "parentSessionId": "s1",
            "commandText": "/review strict check locking",
            "intent": "review",
        }))
        .unwrap();
        assert_eq!(
            resolve_intent(&request).unwrap(),
            (ReviewLaunchIntent::Strict, "check locking".to_string())
        );
        let request: LaunchReviewRequest = serde_json::from_value(json!({
            "parentSessionId": "s1",
            "focus": "auth",
        }))
        .unwrap();
        assert_eq!(
            resolve_intent(&request).unwrap(),
            (ReviewLaunchIntent::Review, "auth".to_string())
        );
        let request: LaunchReviewRequest = serde_json::from_value(json!({
            "parentSessionId": "s1",
            "commandText": "/compact",
        }))
        .unwrap();
        assert!(resolve_intent(&request).is_err());
    }

    #[test]
    fn refusals_carry_a_code_and_the_planner_sentence() {
        let response = refusal_response(
            ReviewLaunchIntent::Review,
            &ReviewLaunchRefusal::NoWorkspaceChanges,
        );
        let value = serde_json::to_value(&response).unwrap();
        assert_eq!(value["status"], "refused");
        assert_eq!(value["code"], "review_no_workspace_changes");
        assert!(value["message"]
            .as_str()
            .unwrap()
            .contains("workspace changes"));
        assert_eq!(value["intent"], "review");
        assert!(value.get("childSessionId").is_none());
        let scope = serde_json::to_value(refusal_response(
            ReviewLaunchIntent::Review,
            &ReviewLaunchRefusal::EmptyScope {
                paths: vec!["docs".to_string()],
            },
        ))
        .unwrap();
        assert_eq!(scope["paths"], json!(["docs"]));
        let git = git_refusal(
            ReviewLaunchIntent::Strict,
            &GitError::RepositoryNotFound("/tmp/x".to_string()),
        )
        .unwrap();
        assert_eq!(git.code.as_deref(), Some("review_not_git_repository"));
    }

    #[tokio::test]
    async fn git_range_reads_committed_renames_and_refuses_refs_that_moved_after_preparation() {
        fn git(root: &Path, args: &[&str]) {
            let output = openbitfun_services_core::process_manager::create_command("git")
                .current_dir(root)
                .args([
                    "-c",
                    "user.name=Review Test",
                    "-c",
                    "user.email=review@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path();
        git(repo, &["init", "--template="]);
        std::fs::write(repo.join("before.txt"), "This file will be renamed\n").unwrap();
        git(repo, &["add", "--", "before.txt"]);
        git(repo, &["commit", "-m", "Base"]);
        git(repo, &["branch", "review-base"]);
        std::fs::rename(repo.join("before.txt"), repo.join("after.txt")).unwrap();
        std::fs::write(repo.join("outside.txt"), "A separate committed change\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "Rename"]);
        git(repo, &["branch", "review-head"]);
        std::fs::write(repo.join("uncommitted.txt"), "Not part of the review\n").unwrap();

        let range = parse_review_git_range("review-base..review-head")
            .unwrap()
            .unwrap();
        let root = repo.to_str().unwrap();
        let intent = ReviewLaunchIntent::Strict;
        let plan = prepare_git_range_review(root, &range, None, intent, None)
            .await
            .unwrap()
            .unwrap();
        let answer = prepared_response(&plan);
        assert_eq!(answer.file_count, 2);
        let rename = answer
            .files
            .iter()
            .find(|file| file.path == "after.txt")
            .unwrap();
        assert_eq!(rename.previous_path.as_deref(), Some("before.txt"));
        assert_eq!(plan.target_evidence["workspaceBinding"], "matching_dirty");
        assert_eq!(answer.completeness.as_deref(), Some("partial"));

        let approved = answer.git_range.unwrap();
        let exact_files = ["after.txt".to_owned()];
        let diff_paths = ["before.txt".to_owned(), "after.txt".to_owned()];
        let scoped = prepare_git_range_review(
            root,
            &range,
            Some(&approved),
            intent,
            Some((&exact_files, &diff_paths)),
        )
        .await
        .unwrap()
        .unwrap();
        let scoped_answer = prepared_response(&scoped);
        assert_eq!(scoped.requested_files, exact_files);
        assert_eq!(scoped_answer.file_count, 1);
        assert_eq!(
            scoped_answer.files[0].previous_path.as_deref(),
            Some("before.txt")
        );
        assert_eq!(scoped_answer.git_range, Some(approved.clone()));
        git(repo, &["branch", "-f", "review-head", "review-base"]);
        let refused = prepare_git_range_review(root, &range, Some(&approved), intent, None)
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(refused.code.as_deref(), Some("review_git_range_changed"));

        let request_id = "range-with-lost-ack";
        let mut saved = SessionMetadata::new(
            review_child_session_id(request_id),
            "Saved review".into(),
            DEEP_REVIEW_AGENT_TYPE.into(),
            "default".into(),
        );
        saved.workspace_id = Some("workspace".into());
        saved.relationship = Some(openbitfun_core::service::session::SessionRelationship {
            kind: Some(SessionRelationshipKind::DeepReview),
            parent_session_id: Some("parent".into()),
            parent_request_id: Some(request_id.into()),
            ..Default::default()
        });
        saved.review_target_evidence = Some(plan.target_evidence);
        let replay = reopen_git_range(&saved, intent, "workspace", "parent", request_id, &approved);
        assert_eq!(replay.status, "uncertain");
        assert_eq!(
            replay.child_session_id.as_deref(),
            Some(saved.session_id.as_str())
        );
        let conflict = reopen_git_range(
            &saved,
            intent,
            "workspace",
            "other-chat",
            request_id,
            &approved,
        );
        assert_eq!(
            conflict.code.as_deref(),
            Some("review_git_range_request_conflict")
        );
    }

    #[tokio::test]
    async fn untracked_facts_read_text_and_skip_directories() {
        let dir = std::env::temp_dir().join(format!("obf-review-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        let fact = untracked_fact(&dir, "a.txt").await;
        assert!(fact.fingerprint.is_some());
        assert_eq!(fact.line_count, Some(2));
        assert_eq!(
            untracked_fact(&dir, "sub").await,
            UntrackedContentFact::default()
        );
        assert_eq!(
            untracked_fact(&dir, "missing").await,
            UntrackedContentFact::default()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
