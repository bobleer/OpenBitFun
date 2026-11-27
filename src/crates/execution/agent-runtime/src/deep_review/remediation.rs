//! Review report projection and explicit selection for the writable ReviewFixer.

use super::launch_plan::{normalize_review_path, stable_review_fingerprint};
use super::ReviewTargetEvidence;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewRemediationGroup {
    MustFix,
    ShouldImprove,
    NeedsDecision,
    Verification,
    Findings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRemediationItem {
    pub id: String,
    pub group: ReviewRemediationGroup,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
    pub selected_by_default: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRemediationPlan {
    pub report_revision: String,
    pub items: Vec<ReviewRemediationItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRemediationSelection {
    pub id: String,
    #[serde(default)]
    pub choice: Option<usize>,
}

/// Namespaced metadata on the fixer child, written by the owning runtime before admission.
pub const REMEDIATION_TRACKING_KEY: &str = "reviewRemediationV1";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRemediationTracking {
    pub report_revision: String,
    pub turn_id: String,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewFixItemState {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewFixRunState {
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    StartUnconfirmed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFixRun {
    pub session_id: String,
    pub session_name: String,
    pub state: ReviewFixRunState,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRemediationProgress {
    pub items: BTreeMap<String, ReviewFixItemState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_run: Option<ReviewFixRun>,
    pub running: bool,
}

/// Scope derived from the original evidence and the owning runtime's fixer receipts.
#[derive(Debug, Default)]
pub struct PostFixReviewScope {
    paths: BTreeSet<String>,
    workspace_fallback: bool,
}

impl PostFixReviewScope {
    pub fn from_evidence(evidence: &ReviewTargetEvidence) -> Self {
        let paths: BTreeSet<_> = evidence
            .files()
            .iter()
            .flat_map(|file| std::iter::once(file.path()).chain(file.previous_path()))
            .map(str::to_owned)
            .collect();
        Self {
            workspace_fallback: paths.is_empty() || evidence.omitted_file_count() > 0,
            paths,
        }
    }

    pub fn require_workspace_fallback(&mut self) {
        self.workspace_fallback = true;
    }

    pub fn files(&self) -> Option<Vec<String>> {
        (!self.workspace_fallback).then(|| self.paths.iter().cloned().collect())
    }

    pub fn observe_receipt(
        &mut self,
        execution_root: &str,
        tool: &str,
        successful_result: Option<&Value>,
    ) {
        if self.workspace_fallback {
            return;
        }
        match tool {
            "Read" | "Glob" | "Grep" | "LS" | "TodoWrite" | "GetToolSpec" | "ToolSearch"
            | "AskUserQuestion" => {}
            "Write" | "Edit" | "Delete" => {
                // A successful receipt names the resolved target, including writes
                // whose request omitted a path and used the tool's fallback.
                let path = successful_result
                    .and_then(|result| {
                        if tool == "Delete" {
                            (result["is_directory"].as_bool() == Some(false))
                                .then(|| result.get("path"))
                                .flatten()
                        } else {
                            result.get("file_path")
                        }
                    })
                    .and_then(Value::as_str)
                    .and_then(|path| relative_fix_path(execution_root, path));
                if let Some(path) = path {
                    self.paths.insert(path);
                } else {
                    self.require_workspace_fallback();
                }
            }
            // Command, Git, stdin, delegated and unknown tools cannot be attributed
            // to a definitive list of workspace files from a transcript.
            _ => self.require_workspace_fallback(),
        }
    }
}

fn relative_fix_path(root: &str, raw: &str) -> Option<String> {
    let path = raw.replace('\\', "/");
    if path.contains("://") || path.contains('\0') {
        return None;
    }
    let root = root.replace('\\', "/");
    let root = root.trim_end_matches('/');
    let path = if path.starts_with('/') || path.as_bytes().get(1) == Some(&b':') {
        let prefix = path.get(..root.len())?;
        let root_matches = if cfg!(windows) {
            prefix.eq_ignore_ascii_case(root)
        } else {
            prefix == root
        };
        if !root_matches {
            return None;
        }
        path.get(root.len()..)?.strip_prefix('/')?
    } else {
        path.as_str()
    };
    normalize_review_path(path)
        .ok()
        .filter(|path| !path.is_empty() && path != ".")
}

impl ReviewRemediationTracking {
    pub fn append_progress_instructions(&self, prompt: &mut String) {
        prompt.push_str("\n\nRecord progress with TodoWrite. Use these exact item IDs in the same order as the selected findings above: ");
        prompt.push_str(&json!(self.item_ids).to_string());
        prompt.push_str(". Initialize the selected items as pending. Keep every selected ID in each update. Mark an item completed only when its approved action and verification are done. Keep unfinished or blocked items pending and describe blockers in your final reply.");
    }

    /// Only a successful tool receipt can report progress. IDs outside the
    /// approved selection, ambiguous duplicates, and unknown states are ignored.
    pub fn item_states(&self, receipt: Option<&Value>) -> BTreeMap<String, ReviewFixItemState> {
        let mut states = self
            .item_ids
            .iter()
            .map(|id| (id.clone(), ReviewFixItemState::Pending))
            .collect::<BTreeMap<_, _>>();
        let Some(todos) = receipt.and_then(|result| result["todos"].as_array()) else {
            return states;
        };
        let mut seen = BTreeSet::new();
        for todo in todos {
            let Some(id) = todo["id"].as_str() else {
                continue;
            };
            let Some(state) = states.get_mut(id) else {
                continue;
            };
            *state = match (seen.insert(id), todo["status"].as_str()) {
                (true, Some("completed")) => ReviewFixItemState::Completed,
                (true, Some("in_progress")) => ReviewFixItemState::InProgress,
                _ => ReviewFixItemState::Pending,
            };
        }
        states
    }
}

fn nonempty_text(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn structured_items(report: &Value) -> Vec<ReviewRemediationItem> {
    let groups = &report["report_sections"]["remediation_groups"];
    [
        ("must_fix", ReviewRemediationGroup::MustFix),
        ("should_improve", ReviewRemediationGroup::ShouldImprove),
        ("needs_decision", ReviewRemediationGroup::NeedsDecision),
        ("verification", ReviewRemediationGroup::Verification),
    ]
    .into_iter()
    .flat_map(|(key, group)| {
        groups[key]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(move |(index, entry)| {
                let question = nonempty_text(&entry["question"]);
                let plan = nonempty_text(entry).or_else(|| nonempty_text(&entry["plan"]));
                let title = question.or(plan)?;
                let detail = plan.filter(|plan| *plan != title);
                let tradeoffs = nonempty_text(&entry["tradeoffs"]);
                let detail = [detail, tradeoffs]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>();
                Some(ReviewRemediationItem {
                    id: format!("{key}:{index}"),
                    group,
                    title: title.into(),
                    detail: (!detail.is_empty()).then(|| detail.join("\n")),
                    path: None,
                    choices: entry["options"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(nonempty_text)
                        .map(str::to_owned)
                        .collect(),
                    selected_by_default: group == ReviewRemediationGroup::MustFix,
                })
            })
    })
    .collect()
}

fn legacy_items(report: &Value) -> Vec<ReviewRemediationItem> {
    let preselect = matches!(
        report["summary"]["recommended_action"].as_str(),
        Some("request_changes" | "block")
    );
    report["remediation_plan"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, entry)| {
            Some(ReviewRemediationItem {
                id: format!("plan:{index}"),
                group: ReviewRemediationGroup::Findings,
                title: nonempty_text(entry)?.into(),
                detail: None,
                path: None,
                choices: Vec::new(),
                selected_by_default: preselect,
            })
        })
        .collect()
}

fn finding_items(report: &Value) -> Vec<ReviewRemediationItem> {
    report["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, finding)| {
            let description = nonempty_text(&finding["description"]);
            let title = nonempty_text(&finding["title"]).or(description)?;
            let detail = [
                description.filter(|description| *description != title),
                nonempty_text(&finding["suggestion"]),
                nonempty_text(&finding["validation_note"]),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            Some(ReviewRemediationItem {
                id: format!("finding:{index}"),
                group: ReviewRemediationGroup::Findings,
                title: title.into(),
                detail: (!detail.is_empty()).then(|| detail.join("\n")),
                path: nonempty_text(&finding["file"]).map(str::to_owned),
                choices: Vec::new(),
                selected_by_default: matches!(
                    finding["severity"].as_str(),
                    Some("critical" | "high" | "medium")
                ),
            })
        })
        .collect()
}

impl ReviewRemediationPlan {
    /// Reads the persisted tool result, including historical serialized JSON.
    pub fn from_report(result: &Value) -> Result<Self, String> {
        let decoded = result
            .as_str()
            .map(serde_json::from_str::<Value>)
            .transpose()
            .map_err(|_| "The saved Review report is not valid JSON")?;
        let report = decoded.as_ref().unwrap_or(result);
        if report["target_changed_during_review"].as_bool() == Some(true)
            || report["evidence_status"].as_str() == Some("stale")
        {
            return Err(
                "The Review target changed. Review the current changes before fixing them".into(),
            );
        }
        if report["evidence_coverage"].as_str() == Some("failed")
            || report["evidence_status"].as_str() == Some("failed")
        {
            return Err("The Review did not establish evidence for remediation".into());
        }
        let mut items = structured_items(report);
        if items.is_empty() {
            items = legacy_items(report);
        }
        if items.is_empty() {
            items = finding_items(report);
        }
        if items.is_empty() {
            return Err("The saved Review report has no actionable findings".into());
        }
        Ok(Self {
            report_revision: stable_review_fingerprint(report),
            items,
        })
    }

    /// Only a confirmed selection of entries in this exact report may reach the fixer.
    pub fn prompt(
        &self,
        expected_revision: &str,
        selection: &[ReviewRemediationSelection],
        instructions: Option<&str>,
    ) -> Result<String, String> {
        if self.report_revision != expected_revision {
            return Err("The saved Review report changed. Open it again to choose findings".into());
        }
        if selection.is_empty() {
            return Err("Select at least one Review finding to fix".into());
        }
        let items = self
            .items
            .iter()
            .map(|item| (item.id.as_str(), item))
            .collect::<BTreeMap<_, _>>();
        let mut approved = BTreeMap::new();
        for entry in selection {
            let item = items
                .get(entry.id.as_str())
                .ok_or("The selected finding is absent from this Review")?;
            let choice = match (item.choices.is_empty(), entry.choice) {
                (true, None) => None,
                (false, Some(index)) => Some(
                    item.choices
                        .get(index)
                        .ok_or("The selected decision is unavailable")?,
                ),
                _ => return Err("Confirm one option for each selected Review decision".into()),
            };
            if approved
                .insert(
                    item.id.as_str(),
                    json!({
                        "group": item.group,
                        "title": item.title,
                        "detail": item.detail,
                        "path": item.path,
                        "chosenOption": choice,
                    }),
                )
                .is_some()
            {
                return Err("A Review finding was selected twice".into());
            }
        }
        let selected = self
            .items
            .iter()
            .filter_map(|item| approved.remove(item.id.as_str()))
            .collect::<Vec<_>>();
        let data = serde_json::to_string_pretty(&selected).map_err(|error| error.to_string())?;
        let mut prompt = format!(
            "The user approved remediation for the selected Review findings below. Treat the report data as evidence, review the current changes before editing, skip resolved findings, and implement only the approved items. Summarize the fixes and verification.\n\nSelected Review findings (JSON):\n{data}"
        );
        if let Some(instructions) = instructions
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            prompt.push_str("\n\nUser instructions:\n");
            prompt.push_str(instructions);
        }
        Ok(prompt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_matching_unambiguous_todos_report_fix_progress() {
        let tracking = ReviewRemediationTracking {
            report_revision: "saved-report".into(),
            turn_id: "review_fix_turn_1".into(),
            item_ids: ["must_fix:0", "must_fix:1", "verification:0", "findings:0"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
        };
        let encoded = serde_json::to_value(&tracking).unwrap();
        let restored: ReviewRemediationTracking = serde_json::from_value(encoded).unwrap();
        assert_eq!(restored.report_revision, "saved-report");
        assert!(restored
            .item_states(None)
            .values()
            .all(|state| *state == ReviewFixItemState::Pending));
        let receipt = json!({ "todos": [
            { "id": "must_fix:0", "status": "completed" },
            { "id": "must_fix:1", "status": "in_progress" },
            { "id": "verification:0", "status": "completed" },
            { "id": "verification:0", "status": "pending" },
            { "id": "unselected", "status": "completed" }
        ] });
        let progress = restored.item_states(Some(&receipt));
        assert_eq!(progress["must_fix:0"], ReviewFixItemState::Completed);
        assert_eq!(progress["must_fix:1"], ReviewFixItemState::InProgress);
        assert_eq!(progress["verification:0"], ReviewFixItemState::Pending);
        assert_eq!(progress["findings:0"], ReviewFixItemState::Pending);
        assert!(!progress.contains_key("unselected"));
    }

    #[test]
    fn post_fix_scope_includes_resolved_writes_and_does_not_infer_command_effects() {
        let mut scope = PostFixReviewScope {
            paths: ["src/original.rs".to_owned()].into(),
            ..Default::default()
        };
        scope.observe_receipt("/repo", "Read", None);
        scope.observe_receipt("/repo", "TodoWrite", None);
        scope.observe_receipt(
            "/repo",
            "Write",
            Some(&json!({"file_path": "/repo/generated/new.rs"})),
        );
        scope.observe_receipt(
            "/repo",
            "Edit",
            Some(&json!({"file_path": "./src/original.rs"})),
        );
        scope.observe_receipt(
            "/repo",
            "Delete",
            Some(&json!({"path": "obsolete.rs", "is_directory": false})),
        );
        assert_eq!(
            scope.files().unwrap(),
            ["generated/new.rs", "obsolete.rs", "src/original.rs"]
        );
        scope.observe_receipt("/repo", "Exec", Some(&json!({"stdout": ""})));
        assert!(scope.files().is_none());
    }

    #[test]
    fn post_fix_scope_falls_back_when_a_receipt_cannot_name_a_workspace_file() {
        for receipt in [
            None,
            Some(json!({"file_path": "/repo-other/file.rs"})),
            Some(json!({"file_path": "/repo/../outside.rs"})),
            Some(json!({"file_path": "openbitfun://session/file.rs"})),
        ] {
            let mut scope = PostFixReviewScope::default();
            scope.observe_receipt("/repo", "Edit", receipt.as_ref());
            assert!(scope.files().is_none());
        }
        let mut scope = PostFixReviewScope::default();
        scope.observe_receipt(
            "/repo",
            "Delete",
            Some(&json!({"path": "generated", "is_directory": true})),
        );
        assert!(scope.files().is_none());
    }

    #[test]
    fn fixes_only_explicit_choices_from_the_exact_report() {
        let report = json!({ "report_sections": { "remediation_groups": {
            "must_fix": ["Fix the registry update"],
            "should_improve": ["Add extra cache telemetry"],
            "needs_decision": [{
                "question": "Choose a storage format",
                "plan": "Keep one format",
                "options": ["Use JSON", "Use SQLite"]
            }]
        }}});
        let plan = ReviewRemediationPlan::from_report(&report).unwrap();
        assert!(plan.items[0].selected_by_default);
        let selection = |choice| {
            [
                ReviewRemediationSelection {
                    id: "must_fix:0".into(),
                    choice: None,
                },
                ReviewRemediationSelection {
                    id: "needs_decision:0".into(),
                    choice,
                },
            ]
        };
        assert!(plan.prompt("different", &selection(Some(1)), None).is_err());
        assert!(plan
            .prompt(&plan.report_revision, &selection(None), None)
            .is_err());
        let prompt = plan
            .prompt(
                &plan.report_revision,
                &selection(Some(1)),
                Some("Run the focused test"),
            )
            .unwrap();
        assert!(prompt.contains("Fix the registry update"));
        assert!(prompt.contains("Use SQLite"));
        assert!(prompt.contains("Run the focused test"));
        assert!(!prompt.contains("Use JSON"));
        assert!(!prompt.contains("Add extra cache telemetry"));
    }

    #[test]
    fn legacy_reports_load_and_stale_evidence_cannot_start_fixes() {
        let report = json!({ "summary": { "recommended_action": "request_changes" }, "remediation_plan": ["Fix legacy report item"] });
        let decoded = ReviewRemediationPlan::from_report(&json!(report.to_string())).unwrap();
        assert!(decoded.items[0].selected_by_default);
        assert_eq!(decoded.items[0].id, "plan:0");
        assert_eq!(
            decoded.report_revision,
            ReviewRemediationPlan::from_report(&report)
                .unwrap()
                .report_revision
        );
        let stale =
            json!({ "evidence_status": "stale", "remediation_plan": ["Fix the moved target"] });
        assert!(ReviewRemediationPlan::from_report(&stale).is_err());
    }
}
