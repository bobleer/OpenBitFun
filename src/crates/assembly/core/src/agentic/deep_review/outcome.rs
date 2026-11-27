//! Derive a bounded PR Review outcome from a saved report, under the Session write owner.

use openbitfun_agent_runtime::deep_review::target_evidence::ReviewTargetEvidence;
use openbitfun_agent_runtime::deep_review::{CODE_REVIEW_AGENT_TYPE, DEEP_REVIEW_AGENT_TYPE};
use openbitfun_agent_tools::effective_tool_invocation;
use openbitfun_services_core::session::{
    DialogTurnData, DialogTurnKind, SessionMetadata, ToolItemData, TurnStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const METADATA_KEY: &str = "pullRequestReviewOutcomeV1";
const ASSESSMENT_CHARS: usize = 240;

pub(crate) fn persisted_review_target(metadata: &SessionMetadata) -> Option<ReviewTargetEvidence> {
    if !matches!(
        metadata.agent_type.as_str(),
        CODE_REVIEW_AGENT_TYPE | DEEP_REVIEW_AGENT_TYPE
    ) {
        return None;
    }
    match metadata.review_target_evidence.as_ref() {
        Some(evidence) => ReviewTargetEvidence::from_evidence(evidence).ok(),
        None => metadata
            .deep_review_run_manifest
            .as_ref()
            .and_then(|manifest| {
                ReviewTargetEvidence::from_context_value(manifest)
                    .ok()
                    .flatten()
            }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ReviewOutcome {
    Available {
        #[serde(flatten)]
        summary: ReviewOutcomeSummary,
    },
    Invalid,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewOutcomeSummary {
    pub finding_count: Option<usize>,
    pub risk_level: Option<String>,
    pub recommended_action: Option<String>,
    pub assessment: Option<String>,
    pub evidence_coverage: String,
    #[serde(default)]
    pub target_changed_during_review: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredReviewOutcome {
    pub turn_index: usize,
    pub outcome: ReviewOutcome,
}

impl StoredReviewOutcome {
    pub(crate) fn read(metadata: &SessionMetadata) -> Option<Self> {
        serde_json::from_value(
            metadata
                .custom_metadata
                .as_ref()?
                .get(METADATA_KEY)?
                .clone(),
        )
        .ok()
    }

    fn save(metadata: &mut SessionMetadata, outcome: Option<Self>) {
        let custom = metadata.custom_metadata.get_or_insert_with(|| json!({}));
        if let Some(object) = custom.as_object_mut() {
            if let Some(outcome) = outcome {
                object.insert(METADATA_KEY.into(), json!(outcome));
            } else {
                object.remove(METADATA_KEY);
            }
        }
    }
}

fn matches_review(metadata: &SessionMetadata) -> bool {
    persisted_review_target(metadata).is_some()
}

fn bounded_assessment(value: Option<&Value>) -> Option<String> {
    let mut chars = value?.as_str()?.trim().chars();
    let result: String = chars.by_ref().take(ASSESSMENT_CHARS).collect();
    if chars.next().is_some() {
        let mut shortened = result;
        shortened.pop();
        shortened.push('…');
        return Some(shortened);
    }
    (!result.is_empty()).then_some(result)
}

fn known_text<'a>(value: Option<&'a Value>, allowed: &[&str]) -> Option<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
}

fn summarize_report(value: &Value) -> ReviewOutcome {
    let decoded = value
        .as_str()
        .and_then(|data| serde_json::from_str::<Value>(data).ok());
    let report = decoded.as_ref().unwrap_or(value);
    let summary = report.get("summary");
    let assessment =
        bounded_assessment(summary.and_then(|summary| summary.get("overall_assessment")));
    let risk = known_text(
        summary.and_then(|summary| summary.get("risk_level")),
        &["critical", "high", "medium", "low"],
    );
    let action = known_text(
        summary.and_then(|summary| summary.get("recommended_action")),
        &[
            "approve",
            "approve_with_suggestions",
            "request_changes",
            "block",
        ],
    );
    if assessment.is_none() && risk.is_none() && action.is_none() {
        return ReviewOutcome::Invalid;
    }
    let finding_count = report
        .get("issues")
        .and_then(Value::as_array)
        .filter(|issues| {
            if report.get("finding_count_available") == Some(&Value::Bool(false)) {
                return false;
            }
            issues.iter().all(|issue| {
                ["title", "description"].iter().any(|field| {
                    issue
                        .get(field)
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.trim().is_empty())
                })
            })
        })
        .map(Vec::len);
    let coverage_states = ["complete", "limited", "failed", "unknown"];
    let evidence_coverage = known_text(report.get("evidence_coverage"), &coverage_states)
        .or_else(|| known_text(report.get("evidence_status"), &coverage_states))
        .unwrap_or("unknown");
    ReviewOutcome::Available {
        summary: ReviewOutcomeSummary {
            finding_count,
            risk_level: risk.map(str::to_owned),
            recommended_action: action.map(str::to_owned),
            assessment,
            evidence_coverage: evidence_coverage.to_owned(),
            target_changed_during_review: report.get("target_changed_during_review")
                == Some(&Value::Bool(true))
                || report.get("evidence_status").and_then(Value::as_str) == Some("stale"),
        },
    }
}

pub(crate) fn review_report_tool(turn: &DialogTurnData) -> Option<&ToolItemData> {
    turn.model_rounds
        .iter()
        .rev()
        .flat_map(|round| round.tool_items.iter().rev())
        .find_map(|item| {
            if item.is_subagent_item == Some(true)
                || item.subagent_session_id.is_some()
                || item.parent_task_tool_id.is_some()
            {
                return None;
            }
            let (name, _) = effective_tool_invocation(&item.tool_name, &item.tool_call.input);
            (name == "submit_code_review" && item.tool_result.is_some()).then_some(item)
        })
}

fn report_from_turn(turn: &DialogTurnData) -> Option<StoredReviewOutcome> {
    let result = review_report_tool(turn)?.tool_result.as_ref()?;
    let outcome = if result.success {
        summarize_report(&result.result)
    } else {
        ReviewOutcome::Invalid
    };
    Some(StoredReviewOutcome {
        turn_index: turn.turn_index,
        outcome,
    })
}

/// Returns false when replacing a saved source requires the history owner to rebuild.
pub(crate) fn refresh_review_outcome_for_saved_turn(
    metadata: &mut SessionMetadata,
    turn: &DialogTurnData,
) -> bool {
    if turn.kind != DialogTurnKind::UserDialog || !matches_review(metadata) {
        return true;
    }
    let existing = StoredReviewOutcome::read(metadata);
    if existing.as_ref().is_some_and(|saved| {
        saved.turn_index > turn.turn_index && saved.outcome != ReviewOutcome::Missing
    }) {
        return true;
    }
    if let Some(report) = report_from_turn(turn) {
        StoredReviewOutcome::save(metadata, Some(report));
    } else if existing.as_ref().is_some_and(|saved| {
        saved.turn_index == turn.turn_index && saved.outcome != ReviewOutcome::Missing
    }) {
        return false;
    } else if existing.is_none() && turn.turn_index == 0 && turn.status == TurnStatus::Completed {
        StoredReviewOutcome::save(
            metadata,
            Some(StoredReviewOutcome {
                turn_index: 0,
                outcome: ReviewOutcome::Missing,
            }),
        );
    }
    true
}

pub(crate) fn rebuild_review_outcome(metadata: &mut SessionMetadata, turns: &[DialogTurnData]) {
    if !matches_review(metadata) {
        return;
    }
    let user_turns = || {
        turns
            .iter()
            .filter(|turn| turn.kind == DialogTurnKind::UserDialog)
    };
    let report = user_turns()
        .filter_map(report_from_turn)
        .max_by_key(|report| report.turn_index);
    let outcome = report.or_else(|| {
        let turn = user_turns()
            .filter(|turn| turn.status == TurnStatus::Completed)
            .max_by_key(|turn| turn.turn_index)?;
        Some(StoredReviewOutcome {
            turn_index: turn.turn_index,
            outcome: ReviewOutcome::Missing,
        })
    });
    StoredReviewOutcome::save(metadata, outcome);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_report_round_trip_retains_zero_and_independent_evidence() {
        let legacy = json!({"summary": {"overall_assessment": "No findings.", "risk_level": "low"},
            "issues": [], "evidence_status": "stale"});
        let ReviewOutcome::Available { summary } = summarize_report(&json!(legacy.to_string()))
        else {
            panic!("legacy report is readable");
        };
        assert_eq!(summary.finding_count, Some(0));
        assert_eq!(summary.evidence_coverage, "unknown");
        assert!(summary.target_changed_during_review);

        let mut metadata = SessionMetadata::new(
            "review-1".into(),
            "Review".into(),
            CODE_REVIEW_AGENT_TYPE.into(),
            "primary".into(),
        );
        assert!(StoredReviewOutcome::read(&metadata).is_none());
        StoredReviewOutcome::save(
            &mut metadata,
            Some(StoredReviewOutcome {
                turn_index: 0,
                outcome: ReviewOutcome::Available {
                    summary: summary.clone(),
                },
            }),
        );
        let persisted = serde_json::to_value(metadata).unwrap();
        let recovered =
            StoredReviewOutcome::read(&serde_json::from_value(persisted).unwrap()).unwrap();
        assert_eq!(recovered.turn_index, 0);
        assert_eq!(recovered.outcome, ReviewOutcome::Available { summary });
    }

    #[test]
    fn malformed_findings_never_become_zero_and_assessment_is_bounded() {
        let mut report = json!({"summary": {"overall_assessment": "界".repeat(400),
            "risk_level": "high", "recommended_action": "request_changes"},
            "issues": [{"unexpected": true}], "evidence_coverage": "limited",
            "target_changed_during_review": true, "evidence_status": "stale"});
        let ReviewOutcome::Available { summary } = summarize_report(&report) else {
            panic!("readable summary");
        };
        assert_eq!(summary.finding_count, None);
        assert_eq!(summary.evidence_coverage, "limited");
        assert!(summary.target_changed_during_review);
        let assessment = summary.assessment.unwrap();
        assert_eq!(assessment.chars().count(), ASSESSMENT_CHARS);
        assert!(assessment.ends_with('…'));

        report["summary"] = json!({});
        assert_eq!(summarize_report(&report), ReviewOutcome::Invalid);
    }
}
