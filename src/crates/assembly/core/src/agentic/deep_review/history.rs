//! Bounded presentation facts for persisted pull request Reviews.

use super::outcome::{persisted_review_target, ReviewOutcome, StoredReviewOutcome};
use super::revision::PullRequestReviewRevision;
use openbitfun_agent_runtime::deep_review::target_evidence::{
    ReviewTargetEvidence, ReviewTargetEvidenceCompleteness, ReviewTargetEvidenceSource,
};
use openbitfun_services_core::session::{SessionMetadata, SessionRelationshipKind, TurnStatus};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::HashMap;

const REVIEW_PAGE_SIZE: usize = 12;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewSelection {
    pub platform: String,
    pub host: String,
    pub project_path: String,
    pub pull_request_id: String,
    #[serde(default)]
    pub base_revision: Option<String>,
    #[serde(default)]
    pub head_revision: Option<String>,
}

impl PullRequestReviewSelection {
    fn verified_revisions(&self) -> bool {
        is_commit(self.base_revision.as_deref()) && is_commit(self.head_revision.as_deref())
    }
}

fn is_commit(revision: Option<&str>) -> bool {
    revision.is_some_and(|id| {
        matches!(id.len(), 40 | 64) && id.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewFreshness {
    Current,
    Stale,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewRunPhase {
    Running,
    Completed,
    Failed,
    Stopped,
    Interrupted,
    Pending,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewRun {
    pub session_id: String,
    pub session_name: String,
    pub agent_type: String,
    pub parent_session_id: Option<String>,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub phase: ReviewRunPhase,
    pub freshness: ReviewFreshness,
    pub prepared_evidence_limited: bool,
    pub revision: PullRequestReviewRevision,
    pub latest_for_record: bool,
    pub record_history_complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ReviewOutcome>,
    #[serde(skip)]
    pub(crate) outcome_turn_index: Option<usize>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewHistoryCursor {
    pub created_at: u64,
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewPage {
    pub runs: Vec<PullRequestReviewRun>,
    pub current_running: Option<PullRequestReviewRun>,
    pub next_cursor: Option<ReviewHistoryCursor>,
    pub supports_linked_re_review: bool,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SessionReviewTarget {
    Workspace,
    GitRange {
        #[serde(skip_serializing_if = "Option::is_none")]
        base_revision: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        head_revision: Option<String>,
    },
    PullRequest {
        number: u64,
        project_path: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReviewRecord {
    #[serde(flatten)]
    pub run: PullRequestReviewRun,
    pub target: SessionReviewTarget,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReviewPage {
    pub records: Vec<SessionReviewRecord>,
    pub next_cursor: Option<ReviewHistoryCursor>,
}

impl SessionReviewPage {
    pub(crate) fn new(
        records: Vec<SessionReviewRecord>,
        before: Option<&ReviewHistoryCursor>,
    ) -> Self {
        let (mut runs, mut targets): (Vec<_>, HashMap<_, _>) = records
            .into_iter()
            .map(|record| ((record.run.session_id.clone(), record.target), record.run))
            .map(|(target, run)| (run, target))
            .unzip();
        identify_latest_review_revisions(&mut runs);
        runs.retain(|run| run.latest_for_record || !run.record_history_complete);
        let page = PullRequestReviewPage::new(runs, before);
        Self {
            records: page
                .runs
                .into_iter()
                .filter_map(|run| {
                    let target = targets.remove(&run.session_id)?;
                    Some(SessionReviewRecord { run, target })
                })
                .collect(),
            next_cursor: page.next_cursor,
        }
    }
}

pub(crate) fn identify_latest_review_revisions(runs: &mut [PullRequestReviewRun]) {
    let mut records = HashMap::<String, Vec<usize>>::new();
    for (index, run) in runs.iter().enumerate() {
        if run.record_history_complete {
            records
                .entry(run.revision.record_id.clone())
                .or_default()
                .push(index);
        }
    }
    for indices in records.values_mut() {
        indices.sort_unstable_by_key(|&index| runs[index].revision.number);
        let complete = indices.iter().enumerate().all(|(offset, &index)| {
            let run = &runs[index];
            if offset == 0 {
                return run.revision.number == 1 && run.revision.record_id == run.session_id;
            }
            let previous = &runs[indices[offset - 1]];
            previous.revision.number.checked_add(1) == Some(run.revision.number)
                && run.revision.previous_session_id.as_deref() == Some(previous.session_id.as_str())
                && run.parent_session_id == previous.parent_session_id
        });
        for &index in indices.iter() {
            runs[index].record_history_complete = complete;
        }
        if let Some(&index) = indices.last().filter(|_| complete) {
            runs[index].latest_for_record = true;
        }
    }
}

impl PullRequestReviewPage {
    pub(crate) fn new(
        mut runs: Vec<PullRequestReviewRun>,
        before: Option<&ReviewHistoryCursor>,
    ) -> Self {
        runs.sort_unstable_by(|a, b| {
            Reverse((a.created_at, a.session_id.as_str()))
                .cmp(&Reverse((b.created_at, b.session_id.as_str())))
        });
        let current_running = runs
            .iter()
            .find(|run| {
                run.phase == ReviewRunPhase::Running && run.freshness == ReviewFreshness::Current
            })
            .map(|run| PullRequestReviewRun {
                outcome: None,
                outcome_turn_index: None,
                ..run.clone()
            });
        if let Some(before) = before {
            runs.retain(|run| {
                (run.created_at, run.session_id.as_str())
                    < (before.created_at, before.session_id.as_str())
            });
        }
        let has_more = runs.len() > REVIEW_PAGE_SIZE;
        runs.truncate(REVIEW_PAGE_SIZE);
        let next_cursor = runs
            .last()
            .filter(|_| has_more)
            .map(|last| ReviewHistoryCursor {
                created_at: last.created_at,
                session_id: last.session_id.clone(),
            });
        Self {
            runs,
            current_running,
            next_cursor,
            supports_linked_re_review: true,
        }
    }
}

pub(crate) fn project_pull_request_review(
    metadata: &SessionMetadata,
    selection: &PullRequestReviewSelection,
    running: impl FnOnce(&str) -> bool,
) -> Option<PullRequestReviewRun> {
    let evidence = persisted_review_target(metadata)?;
    let identity = evidence.pull_request()?;
    let path_matches = if selection.platform == "github" {
        identity
            .project_path()
            .eq_ignore_ascii_case(selection.project_path.trim_matches('/'))
    } else {
        identity.project_path() == selection.project_path.trim_matches('/')
    };
    if identity.platform() != selection.platform
        || !identity.host().eq_ignore_ascii_case(&selection.host)
        || !path_matches
        || identity.pull_request_id() != selection.pull_request_id
    {
        return None;
    }

    let freshness = if !selection.verified_revisions()
        || !is_commit(evidence.base_revision())
        || !is_commit(evidence.head_revision())
    {
        ReviewFreshness::Unknown
    } else if evidence
        .base_revision()
        .zip(selection.base_revision.as_deref())
        .is_some_and(|(saved, current)| saved.eq_ignore_ascii_case(current))
        && evidence
            .head_revision()
            .zip(selection.head_revision.as_deref())
            .is_some_and(|(saved, current)| saved.eq_ignore_ascii_case(current))
    {
        ReviewFreshness::Current
    } else {
        ReviewFreshness::Stale
    };
    Some(project_review_run(metadata, &evidence, freshness, running))
}

pub(crate) fn project_session_review_record(
    metadata: &SessionMetadata,
    parent_session_id: &str,
    running: impl FnOnce(&str) -> bool,
) -> Option<SessionReviewRecord> {
    let relationship = metadata.relationship.as_ref()?;
    if relationship.parent_session_id.as_deref() != Some(parent_session_id)
        || !matches!(
            relationship.kind,
            Some(SessionRelationshipKind::Review | SessionRelationshipKind::DeepReview)
        )
    {
        return None;
    }
    let evidence = persisted_review_target(metadata)?;
    let target = match evidence.source() {
        ReviewTargetEvidenceSource::Workspace => SessionReviewTarget::Workspace,
        ReviewTargetEvidenceSource::GitRange => SessionReviewTarget::GitRange {
            base_revision: evidence.base_revision().map(str::to_owned),
            head_revision: evidence.head_revision().map(str::to_owned),
        },
        ReviewTargetEvidenceSource::PullRequest => {
            let identity = evidence.pull_request()?;
            SessionReviewTarget::PullRequest {
                number: identity.number(),
                project_path: identity.project_path().into(),
            }
        }
    };
    Some(SessionReviewRecord {
        run: project_review_run(metadata, &evidence, ReviewFreshness::Unknown, running),
        target,
    })
}

fn project_review_run(
    metadata: &SessionMetadata,
    evidence: &ReviewTargetEvidence,
    freshness: ReviewFreshness,
    running: impl FnOnce(&str) -> bool,
) -> PullRequestReviewRun {
    let last_turn = metadata.last_turn.as_ref();
    let phase = if running(&metadata.session_id) {
        ReviewRunPhase::Running
    } else {
        match last_turn.map(|turn| (&turn.status, turn.recovery_pending.unwrap_or(false))) {
            Some((TurnStatus::Completed, _)) => ReviewRunPhase::Completed,
            Some((TurnStatus::Error, _)) => ReviewRunPhase::Failed,
            Some((TurnStatus::Cancelled, false)) => ReviewRunPhase::Stopped,
            Some((TurnStatus::Cancelled, true) | (TurnStatus::InProgress, _)) => {
                ReviewRunPhase::Interrupted
            }
            None if metadata.turn_count == 0 => ReviewRunPhase::Pending,
            None => ReviewRunPhase::Unknown,
        }
    };
    let deferred = metadata
        .deep_review_run_manifest
        .as_ref()
        .and_then(|manifest| {
            manifest
                .get("managedReviewPlan")
                .or_else(|| manifest.get("managed_review_plan"))
        })
        .and_then(|plan| {
            plan.get("deferredFileCount")
                .or_else(|| plan.get("deferred_file_count"))
        })
        .and_then(|count| count.as_u64())
        .unwrap_or(0);
    let outcome = StoredReviewOutcome::read(metadata);
    let revision = PullRequestReviewRevision::read(metadata);
    let record_history_complete = revision.is_ok();
    PullRequestReviewRun {
        session_id: metadata.session_id.clone(),
        session_name: metadata.session_name.clone(),
        agent_type: metadata.agent_type.clone(),
        parent_session_id: metadata
            .relationship
            .as_ref()
            .and_then(|relationship| relationship.parent_session_id.clone()),
        created_at: metadata.created_at,
        finished_at: last_turn.and_then(|turn| turn.end_time),
        phase,
        freshness,
        prepared_evidence_limited: evidence.completeness()
            != ReviewTargetEvidenceCompleteness::Complete
            || deferred > 0,
        revision: revision
            .unwrap_or_else(|_| PullRequestReviewRevision::root(&metadata.session_id)),
        latest_for_record: false,
        record_history_complete,
        outcome_turn_index: outcome.as_ref().map(|outcome| outcome.turn_index),
        outcome: outcome.map(|outcome| outcome.outcome),
    }
}

#[cfg(test)]
mod revision_tests {
    use super::*;

    fn run(id: &str, record: &str, previous: Option<&str>, number: u32) -> PullRequestReviewRun {
        PullRequestReviewRun {
            session_id: id.into(),
            session_name: "Review".into(),
            agent_type: "CodeReview".into(),
            parent_session_id: Some("original-chat".into()),
            created_at: 1,
            finished_at: Some(2),
            phase: ReviewRunPhase::Completed,
            freshness: ReviewFreshness::Current,
            prepared_evidence_limited: false,
            revision: PullRequestReviewRevision {
                record_id: record.into(),
                previous_session_id: previous.map(str::to_owned),
                number,
                post_fix: None,
            },
            latest_for_record: false,
            record_history_complete: true,
            outcome: None,
            outcome_turn_index: None,
        }
    }

    #[test]
    fn review_revisions_use_links_and_keep_independent_records() {
        let mut runs = [
            run("second", "anchor", Some("anchor"), 2),
            run("separate", "separate", None, 1),
            run("anchor", "anchor", None, 1),
        ];
        identify_latest_review_revisions(&mut runs);
        assert!(runs[0].latest_for_record && runs[1].latest_for_record);
        assert!(!runs[2].latest_for_record);
        assert!(runs.iter().all(|run| run.record_history_complete));
    }

    #[test]
    fn unresolved_or_forked_links_have_no_eligible_latest_revision() {
        let mut runs = [
            run("orphan", "missing", Some("missing"), 2),
            run("anchor", "anchor", None, 1),
            run("one", "anchor", Some("anchor"), 2),
            run("two", "anchor", Some("anchor"), 2),
        ];
        identify_latest_review_revisions(&mut runs);
        assert!(runs
            .iter()
            .all(|run| !run.latest_for_record && !run.record_history_complete));
    }
}
