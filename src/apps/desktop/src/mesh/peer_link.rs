//! Process-wide OBP peer link pool on the account device mesh.
//!
//! Opens one authenticated `account-device` OBP connection per peer device
//! through [`super::connect_device`] (or [`super::connect_cloud_node`] for the
//! account's cloud node). Used by the fleet mux and mesh integration tests.

use std::sync::Arc;

use crate::backend_protocol::ws::mesh_client::MeshConnectOptions;

/// The link pool itself is shared with the CLI host and the fleet layer
/// (`openbitfun_obp::client::links`); this module keeps the desktop's
/// connector and the process-wide pool.
pub use openbitfun_obp::client::links::{
    ConnectFuture, LinkState, PeerConnector, PeerEventsBatch, PeerLinkInfo, PeerLinks,
};

/// The production connector: the mesh runtime of this process, and the
/// account's cloud node (`cloud-…`, reached at the account server rather
/// than on the device network).
struct RuntimeConnector;

impl PeerConnector for RuntimeConnector {
    fn connect(&self, device_id: String, options: MeshConnectOptions) -> ConnectFuture {
        if openbitfun_obp::client::cloud::is_cloud_device_id(&device_id) {
            return Box::pin(async move { super::connect_cloud_node(&device_id, options).await });
        }
        Box::pin(async move { super::connect_device(&device_id, options).await })
    }

    fn route(&self, device_id: &str) -> Option<(String, Option<f64>)> {
        if openbitfun_obp::client::cloud::is_cloud_device_id(device_id) {
            return None;
        }
        let status = super::global()?.status();
        let peer = status.peer(device_id)?;
        let path = serde_json::to_value(peer.path)
            .ok()?
            .as_str()
            .map(str::to_string)?;
        Some((path, peer.latency_ms))
    }
}

static LINKS: std::sync::OnceLock<Arc<PeerLinks>> = std::sync::OnceLock::new();

/// The peer links of this process (created on first use).
pub fn global() -> Arc<PeerLinks> {
    Arc::clone(LINKS.get_or_init(|| PeerLinks::new(Arc::new(RuntimeConnector))))
}

/// Closes every link if any was opened (sign-out, shutdown).
pub async fn shutdown_global() {
    if let Some(links) = LINKS.get() {
        links.disconnect_all().await;
    }
}
