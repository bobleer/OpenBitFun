//! Persisted revision links for an explicit Review record.

use openbitfun_agent_runtime::session::keyed_lock::{KeyedAsyncLock, KeyedAsyncLockGuard};
use openbitfun_services_core::session::SessionMetadata;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::LazyLock;

// Kept as a persisted compatibility key for both provider and workspace revisions.
const MANIFEST_KEY: &str = "pullRequestReviewRevision";
static RECORD_WRITES: LazyLock<KeyedAsyncLock> = LazyLock::new(KeyedAsyncLock::default);

pub async fn lock_review_record(record_id: &str) -> KeyedAsyncLockGuard {
    RECORD_WRITES.lock(record_id).await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewRevision {
    pub record_id: String,
    pub previous_session_id: Option<String>,
    pub number: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_fix: Option<PostFixReviewLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostFixReviewLink {
    pub source_session_id: String,
    pub report_tool_id: String,
    pub fix_session_id: String,
}

impl PullRequestReviewRevision {
    pub(crate) fn root(session_id: &str) -> Self {
        Self {
            record_id: session_id.into(),
            previous_session_id: None,
            number: 1,
            post_fix: None,
        }
    }

    pub fn read(metadata: &SessionMetadata) -> Result<Self, &'static str> {
        let Some(value) = metadata
            .deep_review_run_manifest
            .as_ref()
            .and_then(|manifest| manifest.get(MANIFEST_KEY))
        else {
            return Ok(Self::root(&metadata.session_id));
        };
        let link: Self = serde_json::from_value(value.clone())
            .map_err(|_| "Invalid Review revision metadata")?;
        let Some(previous) = link.previous_session_id.as_deref() else {
            return Err("Missing Review predecessor");
        };
        if link.number < 2
            || link.record_id == metadata.session_id
            || previous == metadata.session_id
            || openbitfun_core_types::validate_session_id(&link.record_id).is_err()
            || openbitfun_core_types::validate_session_id(previous).is_err()
            || link.post_fix.as_ref().is_some_and(|fix| {
                openbitfun_core_types::validate_session_id(&fix.source_session_id).is_err()
                    || openbitfun_core_types::validate_session_id(&fix.fix_session_id).is_err()
                    || fix.report_tool_id.is_empty()
            })
        {
            return Err("Invalid Review record or predecessor");
        }
        Ok(link)
    }

    pub fn apply_to_manifest(manifest: &mut Value, admitted: Option<&Self>) {
        if let Some(object) = manifest.as_object_mut() {
            object.remove(MANIFEST_KEY);
            if let Some(link) = admitted {
                object.insert(MANIFEST_KEY.into(), json!(link));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_fix_link_round_trips_and_older_revisions_still_load() {
        let mut metadata = SessionMetadata::new(
            "follow-up".into(),
            "Review".into(),
            "CodeReview".into(),
            "primary".into(),
        );
        let legacy = json!({
            "recordId": "anchor",
            "previousSessionId": "anchor",
            "number": 2,
        });
        metadata.deep_review_run_manifest = Some(json!({ (MANIFEST_KEY): legacy }));
        let old = PullRequestReviewRevision::read(&metadata).unwrap();
        assert_eq!(old.number, 2);
        assert_eq!(old.post_fix, None);

        let linked = PullRequestReviewRevision {
            post_fix: Some(PostFixReviewLink {
                source_session_id: "anchor".into(),
                report_tool_id: "original-report".into(),
                fix_session_id: "fixer".into(),
            }),
            ..old
        };
        let manifest = metadata.deep_review_run_manifest.as_mut().unwrap();
        PullRequestReviewRevision::apply_to_manifest(manifest, Some(&linked));
        let persisted = serde_json::to_value(&metadata).unwrap();
        let recovered = serde_json::from_value(persisted).unwrap();
        assert_eq!(PullRequestReviewRevision::read(&recovered), Ok(linked));

        PullRequestReviewRevision::apply_to_manifest(
            metadata.deep_review_run_manifest.as_mut().unwrap(),
            None,
        );
        assert_eq!(
            PullRequestReviewRevision::read(&metadata).unwrap().number,
            1
        );
    }
}
