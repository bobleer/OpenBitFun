//! Soft / empty responses for Desktop subsystems CLI Peer Host does not run.

use serde_json::{json, Value};

/// MiniApps are a Desktop-hosted runtime; return empty catalog so hydrate succeeds.
pub(crate) async fn list_miniapps() -> Result<Value, String> {
    Ok(json!([]))
}

pub(crate) async fn miniapp_worker_list_running() -> Result<Value, String> {
    Ok(json!([]))
}
