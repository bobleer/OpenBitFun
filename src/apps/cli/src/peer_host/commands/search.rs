//! Workspace file, content, and index search HostInvoke handlers for CLI Peer Host.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use openbitfun_core::infrastructure::{FileSearchOutcome, FileSearchResult, SearchMatchType};
use openbitfun_core::service::filesystem::FileSearchOptions;
use openbitfun_core::service::search::{
    workspace_search_daemon_available, workspace_search_feature_enabled, ContentSearchOutputMode,
    ContentSearchRequest, ContentSearchResult, WorkspaceSearchBackend, WorkspaceSearchRepoPhase,
};
use openbitfun_core::service::workspace::{WorkspaceInfo, WorkspaceKind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::peer_host::args::request_value;
use crate::peer_host::state::PeerHostState;

const DEFAULT_FILENAME_SEARCH_RESULTS: usize = 512;
const DEFAULT_CONTENT_SEARCH_RESULTS: usize = 1_000;
const HARD_MAX_SEARCH_RESULTS: usize = 2_000;
const NON_GIT_WORKSPACE_MESSAGE: &str =
    "Workspace search requires a Git worktree with a HEAD commit";

fn default_include_directories() -> bool {
    true
}

fn resolve_search_limit(requested: Option<usize>, fallback: usize) -> usize {
    requested
        .unwrap_or(fallback)
        .clamp(1, HARD_MAX_SEARCH_RESULTS)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFilesRequest {
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    root_path: String,
    pattern: String,
    #[serde(default)]
    search_content: bool,
    #[serde(default)]
    remote_connection_id: Option<String>,
    #[serde(default)]
    search_id: Option<String>,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    use_regex: bool,
    #[serde(default)]
    whole_word: bool,
    #[serde(default)]
    max_results: Option<usize>,
    #[serde(default = "default_include_directories")]
    include_directories: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFilenamesRequest {
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    root_path: String,
    pattern: String,
    #[serde(default)]
    remote_connection_id: Option<String>,
    #[serde(default)]
    search_id: Option<String>,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    use_regex: bool,
    #[serde(default)]
    whole_word: bool,
    #[serde(default)]
    max_results: Option<usize>,
    #[serde(default = "default_include_directories")]
    include_directories: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFileContentsRequest {
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    root_path: String,
    pattern: String,
    #[serde(default)]
    search_id: Option<String>,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    use_regex: bool,
    #[serde(default)]
    whole_word: bool,
    #[serde(default)]
    max_results: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelSearchRequest {
    search_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchRepoIndexRequest {
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    root_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMetadataResponse {
    backend: WorkspaceSearchBackend,
    repo_phase: WorkspaceSearchRepoPhase,
    base_advance_in_progress: bool,
    workspace_probe_pending: bool,
    candidate_docs: usize,
    matched_lines: usize,
    matched_occurrences: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchCommandResponse {
    results: Vec<Value>,
    limit: usize,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    search_metadata: Option<SearchMetadataResponse>,
}

fn serialize_search_result(result: &FileSearchResult) -> Value {
    json!({
        "path": result.path,
        "name": result.name,
        "isDirectory": result.is_directory,
        "matchType": match result.match_type {
            SearchMatchType::FileName => "fileName",
            SearchMatchType::Content => "content",
        },
        "lineNumber": result.line_number,
        "matchedContent": result.matched_content,
        "previewBefore": result.preview_before,
        "previewInside": result.preview_inside,
        "previewAfter": result.preview_after,
    })
}

fn serialize_search_results(results: Vec<FileSearchResult>) -> Vec<Value> {
    results.iter().map(serialize_search_result).collect()
}

fn serialize_search_response(
    outcome: FileSearchOutcome,
    limit: usize,
    search_metadata: Option<SearchMetadataResponse>,
) -> Value {
    serde_json::to_value(SearchCommandResponse {
        results: serialize_search_results(outcome.results),
        limit,
        truncated: outcome.truncated,
        search_metadata,
    })
    .unwrap_or_else(
        |_| json!({ "results": [], "limit": limit, "truncated": false, "searchMetadata": null }),
    )
}

fn search_metadata_from_content_result(result: &ContentSearchResult) -> SearchMetadataResponse {
    SearchMetadataResponse {
        backend: result.backend,
        repo_phase: result.repo_status.phase,
        base_advance_in_progress: result.repo_status.base_advance_in_progress,
        workspace_probe_pending: result.repo_status.workspace_probe_pending,
        candidate_docs: result.candidate_docs,
        matched_lines: result.matched_lines,
        matched_occurrences: result.matched_occurrences,
    }
}

fn register_search(state: &PeerHostState, search_id: Option<&str>) -> Option<Arc<AtomicBool>> {
    let id = search_id.map(str::trim).filter(|id| !id.is_empty())?;
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut searches) = state.active_searches.lock() {
        searches.insert(id.to_string(), flag.clone());
    }
    Some(flag)
}

fn unregister_search(state: &PeerHostState, search_id: Option<&str>) {
    let Some(id) = search_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return;
    };
    if let Ok(mut searches) = state.active_searches.lock() {
        searches.remove(id);
    }
}

fn require_local_search_workspace(
    workspace: WorkspaceInfo,
    command: &str,
) -> Result<WorkspaceInfo, String> {
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Err(format!(
            "{command} cannot search remote workspace path '{}': CLI peer search only serves local workspaces; local filesystem fallback was not attempted",
            workspace.root_path.to_string_lossy()
        ));
    }
    Ok(workspace)
}

async fn resolve_local_search_workspace_in(
    workspace_service: &openbitfun_core::service::workspace::WorkspaceService,
    command: &str,
    workspace_id: Option<&str>,
    legacy_root: &str,
    legacy_connection: Option<&str>,
) -> Result<WorkspaceInfo, String> {
    let workspace = if let Some(id) = workspace_id.map(str::trim).filter(|id| !id.is_empty()) {
        workspace_service
            .require_workspace(id)
            .await
            .map_err(|error| error.to_string())?
    } else {
        workspace_service
            .resolve_legacy_workspace_reference(None, legacy_root, legacy_connection, None)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| {
                "Legacy search workspace cannot be resolved; select its ID".to_string()
            })?
    };
    require_local_search_workspace(workspace, command)
}

async fn resolve_local_search_workspace(
    state: &PeerHostState,
    command: &str,
    workspace_id: Option<&str>,
    legacy_root: &str,
    legacy_connection: Option<&str>,
) -> Result<WorkspaceInfo, String> {
    resolve_local_search_workspace_in(
        &state.workspace_service,
        command,
        workspace_id,
        legacy_root,
        legacy_connection,
    )
    .await
}

fn repo_status_error_message(error: impl std::fmt::Display) -> String {
    let message = error.to_string();
    if message.contains("requires a Git worktree with a HEAD commit") {
        return NON_GIT_WORKSPACE_MESSAGE.to_string();
    }
    format!("Failed to get search repository status: {message}")
}

async fn require_workspace_search_daemon(
    state: &PeerHostState,
    request: &SearchRepoIndexRequest,
) -> Result<String, String> {
    let workspace = resolve_local_search_workspace(
        state,
        "workspace_search",
        request.workspace_id.as_deref(),
        &request.root_path,
        None,
    )
    .await?;
    if !workspace_search_feature_enabled().await {
        return Err(
            "Workspace search is disabled. Enable it in Settings > Session Config to use accelerated workspace search."
                .to_string(),
        );
    }
    if !workspace_search_daemon_available() {
        return Err(
            "Workspace search daemon is unavailable. OpenBitFun will continue using legacy search."
                .to_string(),
        );
    }
    Ok(workspace.root_path.to_string_lossy().into_owned())
}

async fn try_workspace_content_search(
    state: &PeerHostState,
    root_path: &str,
    pattern: &str,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
    max_results: usize,
) -> Option<Result<ContentSearchResult, String>> {
    if !workspace_search_feature_enabled().await || !workspace_search_daemon_available() {
        return None;
    }
    let request = ContentSearchRequest {
        repo_root: root_path.into(),
        search_path: None,
        pattern: pattern.to_string(),
        output_mode: ContentSearchOutputMode::Content,
        case_sensitive,
        use_regex,
        whole_word,
        multiline: false,
        max_results: Some(max_results),
        globs: Vec::new(),
        file_types: Vec::new(),
        exclude_file_types: Vec::new(),
    };
    match state.workspace_search_service.search_content(request).await {
        Ok(result) => Some(Ok(result)),
        Err(error)
            if error
                .to_string()
                .contains("requires a Git worktree with a HEAD commit") =>
        {
            None
        }
        Err(error) => Some(Err(format!(
            "Failed to search file contents via workspace search: {error}"
        ))),
    }
}

pub(crate) async fn search_files(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request: SearchFilesRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid search_files request: {error}"))?;
    let workspace = resolve_local_search_workspace(
        state,
        "search_files",
        request.workspace_id.as_deref(),
        &request.root_path,
        request.remote_connection_id.as_deref(),
    )
    .await?;
    let root_path = workspace.root_path.to_string_lossy().into_owned();
    let search_id = request.search_id.clone();
    let cancel_flag = register_search(state, search_id.as_deref());
    let max_results = resolve_search_limit(
        request.max_results,
        if request.search_content {
            DEFAULT_CONTENT_SEARCH_RESULTS
        } else {
            DEFAULT_FILENAME_SEARCH_RESULTS
        },
    );
    let options = FileSearchOptions {
        include_content: request.search_content,
        case_sensitive: request.case_sensitive,
        use_regex: request.use_regex,
        whole_word: request.whole_word,
        max_results: Some(max_results),
        file_extensions: None,
        include_directories: request.include_directories,
    };

    let result = if request.search_content {
        let filename_outcome = state
            .filesystem_service
            .search_file_names(
                &root_path,
                &request.pattern,
                FileSearchOptions {
                    include_content: false,
                    include_directories: request.include_directories,
                    ..options.clone()
                },
                cancel_flag.clone(),
            )
            .await
            .map_err(|error| error.to_string());
        match filename_outcome {
            Ok(outcome) => {
                let mut results = outcome.results;
                if results.len() >= max_results {
                    Ok(results)
                } else {
                    let remaining = max_results - results.len();
                    let content_result = match try_workspace_content_search(
                        state,
                        &root_path,
                        &request.pattern,
                        request.case_sensitive,
                        request.use_regex,
                        request.whole_word,
                        remaining,
                    )
                    .await
                    {
                        Some(res) => res.map(|r| r.outcome.results),
                        None => state
                            .filesystem_service
                            .search_file_contents(
                                &root_path,
                                &request.pattern,
                                FileSearchOptions {
                                    include_content: true,
                                    include_directories: false,
                                    max_results: Some(remaining),
                                    ..options
                                },
                                cancel_flag,
                            )
                            .await
                            .map(|o| o.results)
                            .map_err(|error| error.to_string()),
                    };
                    content_result.map(|mut more| {
                        results.append(&mut more);
                        results
                    })
                }
            }
            Err(error) => Err(error),
        }
    } else {
        state
            .filesystem_service
            .search_file_names(&root_path, &request.pattern, options, cancel_flag)
            .await
            .map(|outcome| outcome.results)
            .map_err(|error| format!("Failed to search filenames: {error}"))
    };
    unregister_search(state, search_id.as_deref());
    result.map(|results| json!(serialize_search_results(results)))
}

pub(crate) async fn search_filenames(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request: SearchFilenamesRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid search_filenames request: {error}"))?;
    let workspace = resolve_local_search_workspace(
        state,
        "search_filenames",
        request.workspace_id.as_deref(),
        &request.root_path,
        request.remote_connection_id.as_deref(),
    )
    .await?;
    let root_path = workspace.root_path.to_string_lossy().into_owned();
    let search_id = request.search_id.clone();
    let cancel_flag = register_search(state, search_id.as_deref());
    let limit = resolve_search_limit(request.max_results, DEFAULT_FILENAME_SEARCH_RESULTS);
    let options = FileSearchOptions {
        include_content: false,
        case_sensitive: request.case_sensitive,
        use_regex: request.use_regex,
        whole_word: request.whole_word,
        max_results: Some(limit),
        file_extensions: None,
        include_directories: request.include_directories,
    };
    let result = state
        .filesystem_service
        .search_file_names(&root_path, &request.pattern, options, cancel_flag)
        .await
        .map_err(|error| format!("Failed to search filenames: {error}"));
    unregister_search(state, search_id.as_deref());
    result.map(|outcome| serialize_search_response(outcome, limit, None))
}

pub(crate) async fn search_file_contents(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: SearchFileContentsRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid search_file_contents request: {error}"))?;
    let workspace = resolve_local_search_workspace(
        state,
        "search_file_contents",
        request.workspace_id.as_deref(),
        &request.root_path,
        None,
    )
    .await?;
    let root_path = workspace.root_path.to_string_lossy().into_owned();
    let search_id = request.search_id.clone();
    let cancel_flag = register_search(state, search_id.as_deref());
    let limit = resolve_search_limit(request.max_results, DEFAULT_CONTENT_SEARCH_RESULTS);
    let options = FileSearchOptions {
        include_content: true,
        case_sensitive: request.case_sensitive,
        use_regex: request.use_regex,
        whole_word: request.whole_word,
        max_results: Some(limit),
        file_extensions: None,
        include_directories: false,
    };
    let result = match try_workspace_content_search(
        state,
        &root_path,
        &request.pattern,
        request.case_sensitive,
        request.use_regex,
        request.whole_word,
        limit,
    )
    .await
    {
        Some(res) => res.map(|r| {
            let meta = search_metadata_from_content_result(&r);
            (r.outcome, Some(meta))
        }),
        None => state
            .filesystem_service
            .search_file_contents(&root_path, &request.pattern, options, cancel_flag)
            .await
            .map(|outcome| (outcome, None))
            .map_err(|error| format!("Failed to search file contents: {error}")),
    };
    unregister_search(state, search_id.as_deref());
    result.map(|(outcome, meta)| serialize_search_response(outcome, limit, meta))
}

pub(crate) fn cancel_search(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request: CancelSearchRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid cancel_search request: {error}"))?;
    let cancelled = state
        .active_searches
        .lock()
        .ok()
        .and_then(|mut searches| searches.remove(&request.search_id))
        .map(|flag| {
            flag.store(true, Ordering::Relaxed);
            true
        })
        .unwrap_or(false);
    Ok(json!(cancelled))
}

pub(crate) async fn search_get_repo_status(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: SearchRepoIndexRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid search_get_repo_status request: {error}"))?;
    let root_path = require_workspace_search_daemon(state, &request).await?;
    state
        .workspace_search_service
        .get_index_status(&root_path)
        .await
        .map(|status| serde_json::to_value(status).unwrap_or_else(|_| json!({})))
        .map_err(repo_status_error_message)
}

pub(crate) async fn search_build_index(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: SearchRepoIndexRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid search_build_index request: {error}"))?;
    let root_path = require_workspace_search_daemon(state, &request).await?;
    state
        .workspace_search_service
        .build_index(&root_path)
        .await
        .map(|task| serde_json::to_value(task).unwrap_or_else(|_| json!({})))
        .map_err(|error| format!("Failed to build workspace index: {error}"))
}

pub(crate) async fn search_rebuild_index(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request: SearchRepoIndexRequest = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid search_rebuild_index request: {error}"))?;
    let root_path = require_workspace_search_daemon(state, &request).await?;
    state
        .workspace_search_service
        .rebuild_index(&root_path)
        .await
        .map(|task| serde_json::to_value(task).unwrap_or_else(|_| json!({})))
        .map_err(|error| format!("Failed to rebuild workspace index: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core::service::workspace::WorkspaceInfoRuntimeExt;

    #[tokio::test]
    async fn local_search_workspace_refuses_remote_workspace_without_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let mut remote =
            WorkspaceInfo::new_without_worktree(temp.path().to_path_buf(), Default::default())
                .await
                .unwrap();
        remote.workspace_kind = WorkspaceKind::Remote;
        let err = require_local_search_workspace(remote, "search_files").unwrap_err();
        assert!(err.contains("local filesystem fallback was not attempted"));
    }

    #[tokio::test]
    async fn local_filename_and_content_search_return_matching_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/hello.rs"), "pub fn needle_token() {}\n").unwrap();

        let fs = openbitfun_core::service::filesystem::FileSystemService::default();
        let names = fs
            .search_file_names(
                &root.to_string_lossy(),
                "hello",
                FileSearchOptions {
                    include_content: false,
                    include_directories: true,
                    case_sensitive: false,
                    use_regex: false,
                    whole_word: false,
                    max_results: Some(20),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(names.results.len(), 1);
        assert!(names.results[0].path.ends_with("hello.rs"));

        let contents = fs
            .search_file_contents(
                &root.to_string_lossy(),
                "needle_token",
                FileSearchOptions {
                    include_content: true,
                    include_directories: false,
                    case_sensitive: false,
                    use_regex: false,
                    whole_word: false,
                    max_results: Some(20),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(contents.results.len(), 1);
        assert_eq!(contents.results[0].line_number, Some(1));
    }
}
