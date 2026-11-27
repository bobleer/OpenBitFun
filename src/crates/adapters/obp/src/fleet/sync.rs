//! Fleet replication: keeping every peer's partition current.
//!
//! For each other device of the account that is online and reachable over
//! OBP on the device network, the host keeps one index-only link:
//!
//! - a peer with `fleet_v1` is pulled with `fleet_digest {sinceRevision,
//!   instanceId}` on connect, on every `fleet://digest-changed` hint, and on
//!   [`FleetSync::hint`]; a full snapshot is pulled on an instance change, on
//!   a gap, and every [`FleetSyncConfig::anti_entropy`] (anti-entropy);
//! - a relay-only host (no OBP on the device network) is never dialed; the
//!   index shows it `update_required`.
//!
//! The host's own partition comes from [`FleetBackend::local_digest`] on
//! [`FleetSync::local_changed`]. Losing a link keeps the partition (shown
//! stale) and reconnects with backoff.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, watch, Notify};
use tokio::task::JoinHandle;

use openbitfun_product_domains::fleet::*;

use super::index::{FleetApply, FleetIndex};
use super::router::FleetBackend;
use super::{FleetCallError, FleetFuture};

// ---------------------------------------------------------------------------
// The transport the host provides
// ---------------------------------------------------------------------------

/// One other device of the account, as the host's mesh sees it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FleetPeerPresence {
    pub device_id: String,
    pub name: String,
    pub host_kind: FleetHostKind,
    pub online: bool,
    /// The device serves OBP on the device network. `false`: a relay-only
    /// host (Tauri desktop, CLI before wave 9), shown `update_required`.
    pub mesh: bool,
    pub route: Option<FleetDeviceRoute>,
    pub version: Option<String>,
    pub as_of_ms: u64,
    /// This host cannot open a link to the device at all (a cloud node on a
    /// host without a cloud dialer): it is listed `unknown` with this reason
    /// code and never dialed.
    pub unsupported: Option<String>,
}

/// What a peer's `hello` said about it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FleetPeerLinkInfo {
    /// The peer backend's process instance (the owner partition key).
    pub instance_id: Option<String>,
    /// Mesh capabilities (`fleet_v1`, `dispatch_target_v1`, ...).
    pub capabilities: Vec<String>,
    /// The registry's peer-host capabilities of that host.
    pub host_capabilities: Vec<String>,
    pub version: Option<String>,
}

impl FleetPeerLinkInfo {
    /// The peer serves the owner verbs `fleet_digest` / `fleet_replay`.
    pub fn serves_fleet(&self) -> bool {
        self.capabilities
            .iter()
            .any(|capability| capability == FLEET_V1_CAPABILITY)
    }
}

/// What arrives on an index link.
#[derive(Debug, Clone, PartialEq)]
pub enum FleetPeerSignal {
    Event { event: String, payload: Value },
    Closed { reason: String },
}

/// An open index link: the peer's hello and its event signals. Dropping the
/// receiver releases the link.
pub struct FleetPeerSubscription {
    pub link: FleetPeerLinkInfo,
    pub signals: mpsc::UnboundedReceiver<FleetPeerSignal>,
}

/// Links to the other devices of the account (the host wraps its
/// `PeerLinks` and Link runtime).
pub trait FleetPeerTransport: Send + Sync + 'static {
    /// The other devices of the account with their presence (never this
    /// host itself).
    fn presence(&self) -> FleetFuture<'_, Vec<FleetPeerPresence>>;
    /// Open (or reuse) the index-only link to a device: for a peer with
    /// `fleet_v1` its hello asks for `events: {prefixes: ["fleet://"]}`.
    fn subscribe_index(
        &self,
        device_id: &str,
    ) -> FleetFuture<'_, Result<FleetPeerSubscription, String>>;
    /// A plain `call` on the link to a device (its own allowlist applies).
    fn call(
        &self,
        device_id: &str,
        command: &str,
        args: Value,
    ) -> FleetFuture<'_, Result<Value, FleetCallError>>;
    /// This host's own display name from the account directory (alias first,
    /// else reported name), if the latest presence read saw one.
    fn self_display_name(&self) -> Option<String> {
        None
    }
    /// Drops any cached directory snapshot so the next [`Self::presence`]
    /// reads fresh names and membership from the account directory.
    fn invalidate_directory(&self) {}
}

/// Timers of the replication.
#[derive(Debug, Clone)]
pub struct FleetSyncConfig {
    /// Full snapshot pull from every `fleet_v1` peer.
    pub anti_entropy: Duration,
    /// Presence re-read without a presence hint.
    pub presence_poll: Duration,
    /// Local digests are coalesced into one pull per this window.
    pub local_coalesce: Duration,
    /// Reconnect backoff.
    pub retry_min: Duration,
    pub retry_max: Duration,
}

impl Default for FleetSyncConfig {
    fn default() -> Self {
        Self {
            anti_entropy: Duration::from_secs(5 * 60),
            presence_poll: Duration::from_secs(30),
            local_coalesce: Duration::from_millis(300),
            retry_min: Duration::from_secs(1),
            retry_max: Duration::from_secs(60),
        }
    }
}

// ---------------------------------------------------------------------------
// The replication driver
// ---------------------------------------------------------------------------

struct PeerTask {
    hint: Arc<Notify>,
    retry_now: watch::Sender<u64>,
    handle: JoinHandle<()>,
}

/// Keeps the index current. One per host.
pub struct FleetSync {
    index: Arc<FleetIndex>,
    backend: Arc<dyn FleetBackend>,
    peers: Arc<dyn FleetPeerTransport>,
    config: FleetSyncConfig,
    tasks: Mutex<HashMap<String, PeerTask>>,
    presence_hint: Notify,
    local_hint: Notify,
    stop: watch::Sender<bool>,
    drivers: Mutex<Vec<JoinHandle<()>>>,
}

impl FleetSync {
    pub fn new(
        index: Arc<FleetIndex>,
        backend: Arc<dyn FleetBackend>,
        peers: Arc<dyn FleetPeerTransport>,
        config: FleetSyncConfig,
    ) -> Arc<Self> {
        let (stop, _) = watch::channel(false);
        Arc::new(Self {
            index,
            backend,
            peers,
            config,
            tasks: Mutex::new(HashMap::new()),
            presence_hint: Notify::new(),
            local_hint: Notify::new(),
            stop,
            drivers: Mutex::new(Vec::new()),
        })
    }

    /// The index this driver keeps.
    pub fn index(&self) -> &Arc<FleetIndex> {
        &self.index
    }

    /// Start the presence and local drivers (needs a Tokio runtime).
    pub fn start(self: &Arc<Self>) {
        let presence = tokio::spawn(Arc::clone(self).presence_loop());
        let local = tokio::spawn(Arc::clone(self).local_loop());
        let mut drivers = self.drivers.lock().unwrap_or_else(|p| p.into_inner());
        drivers.push(presence);
        drivers.push(local);
    }

    /// The mesh presence changed (a device came online, left, or moved).
    pub fn presence_changed(&self) {
        self.presence_hint.notify_one();
    }

    /// This host's own digest changed (`fleet://digest-changed` on its hub).
    pub fn local_changed(&self) {
        self.local_hint.notify_one();
    }

    /// Pull a device now (a hint from elsewhere, a failed forward).
    pub fn hint(&self, device_id: &str) {
        if device_id == self.index.self_device_id() {
            self.local_changed();
            return;
        }
        let tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(task) = tasks.get(device_id) {
            task.hint.notify_one();
        }
    }

    /// Stop every driver and release every index link.
    pub fn shutdown(&self) {
        let _ = self.stop.send(true);
        for (_, task) in self.tasks.lock().unwrap_or_else(|p| p.into_inner()).drain() {
            task.handle.abort();
        }
        for driver in self
            .drivers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .drain(..)
        {
            driver.abort();
        }
        if let Err(error) = self.index.flush() {
            log::warn!("Fleet index cache not written at shutdown: {error}");
        }
    }

    /// Pull this host's own digest into the index.
    pub async fn refresh_local(&self) -> Result<(), String> {
        self.index.set_self_facts(self.backend.local_facts());
        let self_id = self.index.self_device_id().to_string();
        let cursor = self.index.partition_cursor(&self_id);
        let request = FleetDigestRequest {
            since_revision: cursor.as_ref().map(|(_, revision)| *revision),
            instance_id: cursor.map(|(instance, _)| instance),
        };
        let since = request.since_revision;
        let digest = self.backend.local_digest(request).await?;
        if let FleetApply::NeedFull { .. } = self.index.apply_digest(&self_id, since, digest) {
            let digest = self
                .backend
                .local_digest(FleetDigestRequest::default())
                .await?;
            self.index.apply_digest(&self_id, None, digest);
        }
        Ok(())
    }

    /// Re-read presence and start or stop the per-device links.
    pub async fn refresh_presence(self: &Arc<Self>) {
        self.refresh_presence_inner(true).await;
    }

    async fn refresh_presence_inner(self: &Arc<Self>, wake_failing: bool) {
        let presence = self.peers.presence().await;
        if let Some(self_name) = self.peers.self_display_name() {
            self.index.set_self_display_name(Some(self_name));
        }
        let self_id = self.index.self_device_id().to_string();
        let presence: Vec<FleetPeerPresence> = presence
            .into_iter()
            .filter(|peer| peer.device_id != self_id && !peer.device_id.is_empty())
            .collect();
        self.index.set_presence(&presence);
        let wanted: HashMap<String, ()> = presence
            .iter()
            .filter(|peer| peer.online && peer.mesh && peer.unsupported.is_none())
            .map(|peer| (peer.device_id.clone(), ()))
            .collect();
        let mut tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        tasks.retain(|device_id, task| {
            let keep = wanted.contains_key(device_id) && !task.handle.is_finished();
            if !keep {
                task.handle.abort();
            }
            keep
        });
        for device_id in wanted.keys() {
            if let Some(task) = tasks.get(device_id) {
                if wake_failing && self.index.needs_link_retry(device_id) {
                    task.retry_now
                        .send_modify(|generation| *generation = generation.wrapping_add(1));
                }
                continue;
            }
            let hint = Arc::new(Notify::new());
            let (retry_now, retry_rx) = watch::channel(0u64);
            let handle = tokio::spawn(Arc::clone(self).peer_loop(
                device_id.clone(),
                Arc::clone(&hint),
                retry_rx,
            ));
            tasks.insert(
                device_id.clone(),
                PeerTask {
                    hint,
                    retry_now,
                    handle,
                },
            );
        }
        drop(tasks);
        if let Err(error) = self.index.flush() {
            log::warn!("Fleet index cache not written: {error}");
        }
    }

    async fn presence_loop(self: Arc<Self>) {
        let mut stop = self.stop.subscribe();
        let mut wake_failing = true;
        loop {
            self.refresh_presence_inner(wake_failing).await;
            wake_failing = tokio::select! {
                _ = self.presence_hint.notified() => true,
                _ = tokio::time::sleep(self.config.presence_poll) => false,
                _ = stop.changed() => return,
            };
        }
    }

    async fn local_loop(self: Arc<Self>) {
        let mut stop = self.stop.subscribe();
        loop {
            if let Err(error) = self.refresh_local().await {
                log::warn!("Fleet local digest unavailable: {error}");
            }
            tokio::select! {
                _ = self.local_hint.notified() => {}
                _ = tokio::time::sleep(self.config.anti_entropy) => {}
                _ = stop.changed() => return,
            }
            // Coalesce a burst of local changes into one pull.
            tokio::time::sleep(self.config.local_coalesce).await;
        }
    }

    async fn peer_loop(
        self: Arc<Self>,
        device_id: String,
        hint: Arc<Notify>,
        mut retry_rx: watch::Receiver<u64>,
    ) {
        let mut stop = self.stop.subscribe();
        let mut backoff = self.config.retry_min;
        loop {
            // Snapshot the retry generation before dialing so a Link presence
            // change arriving while this attempt fails wakes the backoff wait.
            let _ = *retry_rx.borrow_and_update();
            let attempted_at = tokio::time::Instant::now();
            match self.peers.subscribe_index(&device_id).await {
                Err(error) => {
                    log::debug!("Fleet index link failed: device_id={device_id}, error={error}");
                    self.index.mark_link_failed(&device_id, &error);
                }
                Ok(subscription) => {
                    backoff = self.config.retry_min;
                    let reason = self
                        .follow(&device_id, subscription, &hint, &mut stop)
                        .await;
                    match reason {
                        None => return,
                        Some(reason) => self.index.mark_link_failed(&device_id, &reason),
                    }
                }
            }
            let _ = self.index.flush();
            tokio::select! {
                _ = tokio::time::sleep(backoff) => {
                    backoff = (backoff * 2).min(self.config.retry_max);
                }
                changed = retry_rx.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    let earliest = attempted_at + self.config.retry_min.min(Duration::from_millis(500));
                    if tokio::time::Instant::now() < earliest {
                        tokio::select! {
                            _ = tokio::time::sleep_until(earliest) => {}
                            _ = stop.changed() => return,
                        }
                    }
                    backoff = self.config.retry_min;
                }
                _ = hint.notified() => {
                    backoff = (backoff * 2).min(self.config.retry_max);
                }
                _ = stop.changed() => return,
            }
        }
    }

    /// Follow one index link until it closes (`Some(reason)`) or the driver
    /// stops (`None`).
    async fn follow(
        &self,
        device_id: &str,
        mut subscription: FleetPeerSubscription,
        hint: &Notify,
        stop: &mut watch::Receiver<bool>,
    ) -> Option<String> {
        let link = subscription.link.clone();
        let fleet = link.serves_fleet();
        // The account's cloud node has no workspaces to poll (it serves its
        // own `superagent_*` commands): the link only carries its presence
        // and, while a client follows it, its events.
        let presence_only = !fleet
            && self
                .index
                .device_facts(device_id)
                .is_some_and(|facts| facts.host_kind == FleetHostKind::Cloud);
        self.index.set_link(device_id, link.clone());
        let period = self.config.anti_entropy;
        let mut force_full = false;
        loop {
            let outcome = if fleet {
                // A reconnect to the same instance resumes with a delta.
                self.pull_digest(device_id, &link, force_full).await
            } else if presence_only {
                Ok(FleetApply::Applied { changed: false })
            } else {
                return Some("fleet_v1_required".to_string());
            };
            force_full = false;
            if let Err(error) = outcome {
                if error.is_transport() {
                    return Some(error.message);
                }
                log::warn!("Fleet sync of a device failed: device_id={device_id}, error={error}");
            }
            let _ = self.index.flush();
            let deadline = tokio::time::sleep(period);
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    signal = subscription.signals.recv() => match signal {
                        Some(FleetPeerSignal::Event { event, .. }) => {
                            if fleet && event == FLEET_DIGEST_CHANGED_EVENT {
                                break;
                            }
                        }
                        Some(FleetPeerSignal::Closed { reason }) => return Some(reason),
                        None => return Some("link_closed".to_string()),
                    },
                    _ = hint.notified() => break,
                    _ = &mut deadline => {
                        force_full = true;
                        break;
                    }
                    _ = stop.changed() => return None,
                }
            }
        }
    }

    /// Pull a `fleet_v1` peer's digest (a delta from the held position, or
    /// a full snapshot when asked, after an instance change, or on a gap).
    pub async fn pull_digest(
        &self,
        device_id: &str,
        link: &FleetPeerLinkInfo,
        force_full: bool,
    ) -> Result<FleetApply, FleetCallError> {
        let held = self.index.partition_cursor(device_id);
        let same_instance = matches!((&held, &link.instance_id),
            (Some((held, _)), Some(live)) if held == live);
        let request = match held {
            Some((instance, revision)) if !force_full && same_instance => FleetDigestRequest {
                since_revision: Some(revision),
                instance_id: Some(instance),
            },
            _ => FleetDigestRequest::default(),
        };
        let since = request.since_revision;
        let applied = self.fetch_and_apply(device_id, since, request).await?;
        if let FleetApply::NeedFull { reason } = applied {
            log::debug!("Fleet full resync: device_id={device_id}, reason={reason}");
            return self
                .fetch_and_apply(device_id, None, FleetDigestRequest::default())
                .await;
        }
        Ok(applied)
    }

    async fn fetch_and_apply(
        &self,
        device_id: &str,
        since: Option<u64>,
        request: FleetDigestRequest,
    ) -> Result<FleetApply, FleetCallError> {
        let value = self
            .peers
            .call(device_id, "fleet_digest", json!({ "request": request }))
            .await?;
        let digest: FleetDigest = serde_json::from_value(value).map_err(|error| {
            FleetCallError::command(format!("unreadable fleet digest: {error}"))
        })?;
        Ok(self.index.apply_digest(device_id, since, digest))
    }
}

impl Drop for FleetSync {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}
