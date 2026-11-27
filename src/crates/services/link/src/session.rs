//! The account-driven Link lifecycle every host embeds (desktop backend,
//! CLI host): join the account's network after sign-in, keep the join token
//! fresh, restart a node that stopped, leave on sign-out or shutdown, and
//! hand the host inbound OBP streams and outbound streams to devices.
//!
//! Credentials are cached per account (0600) so a restart works while the
//! issuer is unreachable; they are never logged or shown.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch, Notify};

use crate::config::DeviceNodeConfig;
use crate::credentials::{MeshCredentials, DEFAULT_MESH_API_URL};
use crate::issuer::{fetch_credentials_with, FetchError};
use crate::node::{LinkNode, NodeOptions};
use crate::status::{MeshState, MeshStatus, NodeRole};
use crate::stream::LinkStream;
use crate::{MESH_OBP_PORT_FIRST, MESH_OBP_PORT_LAST};

const CREDENTIALS_FILE: &str = "credentials.json";
/// Refresh the join token when less than this much validity remains.
const TOKEN_REFRESH_MARGIN_SECS: i64 = 10 * 60;
/// Inbound OBP streams waiting for the host.
const ACCEPT_QUEUE: usize = 64;
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// A boxed future (object-safe session callbacks).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The signed-in account, as Link needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountIdentity {
    /// The verified account id (the relay `user_id`).
    pub user_id: String,
    /// This device's account device id (its Link hostname).
    pub device_id: String,
}

/// The host's account session.
pub trait AccountSession: Send + Sync + 'static {
    /// The signed-in account; `None` while signed out.
    fn identity(&self) -> BoxFuture<'_, Option<AccountIdentity>>;
    /// A current OpenBitFun identity access token (`None`: signed out).
    fn access_token(&self) -> BoxFuture<'_, Result<Option<String>, String>>;
}

/// How a host runs Link.
#[derive(Debug, Clone)]
pub struct LinkOptions {
    /// Private directory for the credential cache (`<data>/mesh`).
    pub data_dir: PathBuf,
    /// The issuer base URL (`OPENBITFUN_MESH_API_URL`, default production).
    pub issuer_url: String,
    pub client_version: String,
    /// Preferred direct-connection port (TCP+UDP, IPv4 and IPv6); `None`
    /// runs without listeners.
    pub preferred_listener_port: Option<u16>,
    /// Relay only (`OPENBITFUN_MESH_DISABLE_P2P=1`); diagnostics.
    pub disable_p2p: bool,
    /// `Device` for hosts that serve OBP (desktop backend, CLI host);
    /// `Controller` for ends that only open streams to devices (the phone
    /// app). A controller runs no OBP listener, admits no inbound streams,
    /// forwards no other device's data, and is listed by devices as a
    /// controller.
    pub role: NodeRole,
    /// The name advertised to the account's other members (the phone app's
    /// device name); desktops prefer the account directory's name.
    pub display_name: Option<String>,
    /// HTTPS roots for the account issuer: the platform verifier, or the
    /// bundled Mozilla roots where the platform verifier needs setup this
    /// host does not do (Android without its Java-side initialisation).
    pub tls_roots: crate::issuer::TlsRoots,
    /// How often the account is re-checked without a wake.
    pub account_poll: Duration,
    /// How often node status is rebuilt.
    pub status_interval: Duration,
}

impl LinkOptions {
    /// Defaults plus the environment knobs every host honours.
    pub fn from_environment(data_dir: PathBuf, client_version: &str) -> Self {
        Self {
            data_dir,
            issuer_url: std::env::var("OPENBITFUN_MESH_API_URL")
                .ok()
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| DEFAULT_MESH_API_URL.to_string()),
            client_version: client_version.to_string(),
            preferred_listener_port: Some(11010),
            disable_p2p: std::env::var("OPENBITFUN_MESH_DISABLE_P2P")
                .is_ok_and(|value| value == "1"),
            role: NodeRole::Device,
            display_name: None,
            tls_roots: crate::issuer::TlsRoots::default(),
            account_poll: Duration::from_secs(15),
            status_interval: Duration::from_secs(10),
        }
    }
}

/// Whether `OPENBITFUN_MESH=off|0` turned Link off for this process.
pub fn disabled_by_environment() -> bool {
    std::env::var("OPENBITFUN_MESH")
        .map(|value| value.eq_ignore_ascii_case("off") || value == "0")
        .unwrap_or(false)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedCredentials {
    user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    issuer_url: Option<String>,
    credentials: MeshCredentials,
}

fn same_network(a: &MeshCredentials, b: &MeshCredentials) -> bool {
    a.network_name == b.network_name && a.network_secret == b.network_secret && a.peers == b.peers
}

struct Running {
    account: AccountIdentity,
    node: Arc<LinkNode>,
    credentials: MeshCredentials,
    needs_rejoin: bool,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

/// Link in this process.
pub struct Link {
    options: LinkOptions,
    session: Arc<dyn AccountSession>,
    status: watch::Sender<MeshStatus>,
    running: tokio::sync::Mutex<Option<Running>>,
    node: Mutex<Option<Arc<LinkNode>>>,
    wake: Notify,
    stopping: watch::Sender<bool>,
    restarts: Mutex<u32>,
    inbound_sender: mpsc::Sender<LinkStream>,
    inbound: tokio::sync::Mutex<mpsc::Receiver<LinkStream>>,
    supervisor: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_secs() -> i64 {
    (crate::now_ms() / 1000) as i64
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(path)?;
    file.write_all(bytes)
}

/// `preferred` when both its TCP and UDP sockets are free on all IPv4
/// interfaces, otherwise an ephemeral port free for both.
pub fn free_listener_port(preferred: u16) -> std::io::Result<u16> {
    let free = |port: u16| {
        let tcp = std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).ok()?;
        let port = tcp.local_addr().ok()?.port();
        std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).ok()?;
        Some(port)
    };
    if let Some(port) = free(preferred) {
        return Ok(port);
    }
    for _ in 0..16 {
        if let Some(port) = free(0) {
            return Ok(port);
        }
    }
    Err(std::io::Error::other("no free Link listener port"))
}

impl Link {
    /// Starts supervising Link for the host's account session.
    pub fn start(options: LinkOptions, session: Arc<dyn AccountSession>) -> Arc<Self> {
        let (inbound_sender, inbound) = mpsc::channel(ACCEPT_QUEUE);
        let mut initial = MeshStatus::new(MeshState::SignedOut, None);
        initial.role = options.role;
        let link = Arc::new(Self {
            options,
            session,
            status: watch::channel(initial).0,
            running: tokio::sync::Mutex::new(None),
            node: Mutex::new(None),
            wake: Notify::new(),
            stopping: watch::channel(false).0,
            restarts: Mutex::new(0),
            inbound_sender,
            inbound: tokio::sync::Mutex::new(inbound),
            supervisor: Mutex::new(None),
        });
        let supervisor = tokio::spawn(Arc::clone(&link).run());
        *lock(&link.supervisor) = Some(supervisor);
        link
    }

    /// The current status.
    pub fn status(&self) -> MeshStatus {
        self.status.borrow().clone()
    }

    /// Notified whenever the status changes (including latency updates).
    pub fn subscribe(&self) -> watch::Receiver<MeshStatus> {
        self.status.subscribe()
    }

    /// Re-checks the account now (sign-in or sign-out just happened).
    pub fn wake(&self) {
        self.wake.notify_one();
    }

    /// The running node, while signed in.
    pub fn node(&self) -> Option<Arc<LinkNode>> {
        lock(&self.node).clone()
    }

    /// The account the running node belongs to.
    pub async fn account(&self) -> Option<AccountIdentity> {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|running| running.account.clone())
    }

    /// Rebuilds the status now.
    pub async fn refresh(&self) -> MeshStatus {
        if let Some(node) = self.node() {
            let status = node.refresh_status().await;
            self.publish_node_status(status);
        }
        self.status()
    }

    fn publish_node_status(&self, mut status: MeshStatus) {
        status.restarts = *lock(&self.restarts);
        self.status.send_replace(status);
    }

    fn set_state(&self, state: MeshState, reason: Option<String>) {
        let device_id = self.status.borrow().device_id.clone();
        let mut status = MeshStatus::new(state, reason);
        status.device_id = device_id;
        status.role = self.options.role;
        status.restarts = *lock(&self.restarts);
        self.status.send_replace(status);
    }

    /// Why no stream can be opened now.
    fn unavailable(&self) -> String {
        let status = self.status();
        match status.state {
            MeshState::SignedOut => {
                "mesh_signed_out: sign in to reach your other devices".to_string()
            }
            state => format!(
                "mesh_unavailable: the device network is not running ({state:?}){}",
                status
                    .reason
                    .map(|reason| format!("; {reason}"))
                    .unwrap_or_default()
            ),
        }
    }

    /// Opens a virtual TCP stream to `port` on the account device
    /// `device_id`.
    pub async fn connect(
        &self,
        device_id: &str,
        port: u16,
        timeout: Duration,
    ) -> Result<LinkStream, String> {
        let node = self.node().ok_or_else(|| self.unavailable())?;
        node.connect(device_id, port, timeout).await
    }

    /// The next inbound stream on this device's OBP listener (labelled with
    /// the peer device when the route table names it). `None` after
    /// [`Link::shutdown`]. A controller has no listener: this only returns
    /// `None` at shutdown.
    pub async fn accept(&self) -> Option<LinkStream> {
        let mut inbound = self.inbound.lock().await;
        tokio::select! {
            stream = inbound.recv() => stream,
            _ = async {
                let mut stopping = self.stopping.subscribe();
                while !*stopping.borrow_and_update() {
                    if stopping.changed().await.is_err() {
                        break;
                    }
                }
            } => None,
        }
    }

    /// Leaves the network and stops supervising (host shutdown).
    pub async fn shutdown(&self) {
        self.stopping.send_replace(true);
        self.wake.notify_one();
        let supervisor = lock(&self.supervisor).take();
        if let Some(supervisor) = supervisor {
            let _ = tokio::time::timeout(Duration::from_secs(8), supervisor).await;
        }
        self.stop_running(MeshState::Stopped).await;
    }

    async fn run(self: Arc<Self>) {
        let mut stopping = self.stopping.subscribe();
        let mut retry_backoff = MIN_BACKOFF;
        loop {
            if *stopping.borrow() {
                break;
            }
            self.reconcile().await;
            let wait = match self.status.borrow().state {
                MeshState::Failed => {
                    let wait = retry_backoff.min(self.options.account_poll);
                    retry_backoff = (retry_backoff * 2).min(self.options.account_poll);
                    wait
                }
                MeshState::Restarting | MeshState::Starting => {
                    retry_backoff = MIN_BACKOFF;
                    Duration::ZERO
                }
                _ => {
                    retry_backoff = MIN_BACKOFF;
                    self.options.account_poll
                }
            };
            if wait.is_zero() {
                continue;
            }
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = self.wake.notified() => {
                    retry_backoff = MIN_BACKOFF;
                }
                _ = stopping.changed() => {}
            }
        }
        self.stop_running(MeshState::Stopped).await;
    }

    async fn reconcile(self: &Arc<Self>) {
        let account = self.session.identity().await;
        let current = self
            .running
            .lock()
            .await
            .as_ref()
            .map(|running| running.account.clone());
        match (account, current) {
            (None, None) => self.set_state(MeshState::SignedOut, None),
            (None, Some(_)) => self.stop_running(MeshState::SignedOut).await,
            (Some(account), Some(current)) if account == current => {
                self.maintain().await;
            }
            (Some(account), current) => {
                if current.is_some() {
                    self.stop_running(MeshState::Starting).await;
                }
                self.set_state(MeshState::Starting, None);
                match self.start_account(account).await {
                    Ok((mut running, verify_in_background)) => {
                        log::info!("Link started for the signed-in account");
                        let verify_args = verify_in_background.then(|| {
                            (
                                running.account.clone(),
                                Arc::clone(&running.node),
                                running.credentials.clone(),
                            )
                        });
                        *lock(&self.node) = Some(Arc::clone(&running.node));
                        let mut guard = self.running.lock().await;
                        if let Some((verify_account, verify_node, verify_credentials)) = verify_args
                        {
                            let link = Arc::clone(self);
                            running.tasks.push(tokio::spawn(async move {
                                link.verify_cached_credentials(
                                    verify_account,
                                    verify_node,
                                    verify_credentials,
                                )
                                .await;
                            }));
                        }
                        *guard = Some(running);
                        drop(guard);
                        self.refresh().await;
                    }
                    Err((state, reason)) => {
                        log::warn!("Link not started: {}", reason);
                        self.set_state(state, Some(reason));
                    }
                }
            }
        }
    }

    /// Keeps a running node's token fresh and replaces a node that stopped.
    async fn maintain(self: &Arc<Self>) {
        let (account, node, credentials, needs_rejoin) = {
            let running = self.running.lock().await;
            let Some(running) = running.as_ref() else {
                return;
            };
            (
                running.account.clone(),
                Arc::clone(&running.node),
                running.credentials.clone(),
                running.needs_rejoin,
            )
        };
        if needs_rejoin {
            log::warn!("The account network changed; rejoining");
            self.stop_running(MeshState::Starting).await;
            self.wake.notify_one();
            return;
        }
        if node.has_stopped() {
            log::warn!("Link node stopped unexpectedly; restarting");
            *lock(&self.restarts) += 1;
            self.stop_running(MeshState::Restarting).await;
            let backoff = MIN_BACKOFF
                .saturating_mul(1 << (*lock(&self.restarts)).min(6))
                .min(MAX_BACKOFF);
            tokio::time::sleep(backoff).await;
            return;
        }
        let needs_token = credentials
            .usable_join_token(now_secs(), TOKEN_REFRESH_MARGIN_SECS)
            .is_none();
        if !needs_token {
            return;
        }
        match self.fetch(&account).await {
            Ok(fresh) if same_network(&fresh, &credentials) => {
                node.set_join_token(fresh.join_token.as_deref());
                if let Some(running) = self.running.lock().await.as_mut() {
                    running.credentials = fresh;
                }
                log::debug!("Link join token refreshed");
            }
            Ok(_) => {
                log::warn!("The account network changed; rejoining");
                self.stop_running(MeshState::Starting).await;
                self.wake.notify_one();
            }
            Err(error) => log::warn!("Link join token refresh failed: {}", error),
        }
    }

    fn normalized_issuer_url(&self) -> &str {
        self.options.issuer_url.trim().trim_end_matches('/')
    }

    fn load_cached(&self, account: &AccountIdentity) -> Option<CachedCredentials> {
        std::fs::read(self.options.data_dir.join(CREDENTIALS_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<CachedCredentials>(&bytes).ok())
            .filter(|cached| cached.user_id == account.user_id)
            .filter(|cached| {
                cached
                    .device_id
                    .as_deref()
                    .is_none_or(|device_id| device_id == account.device_id)
            })
            .filter(|cached| cached.credentials.validate().is_ok())
    }

    fn fresh_cached_credentials(&self, account: &AccountIdentity) -> Option<MeshCredentials> {
        let cached = self.load_cached(account)?;
        if cached.device_id.as_deref() != Some(account.device_id.as_str()) {
            return None;
        }
        if cached.issuer_url.as_deref() != Some(self.normalized_issuer_url()) {
            return None;
        }
        cached
            .credentials
            .usable_join_token(now_secs(), TOKEN_REFRESH_MARGIN_SECS)?;
        Some(cached.credentials)
    }

    async fn verify_cached_credentials(
        &self,
        account: AccountIdentity,
        node: Arc<LinkNode>,
        cached: MeshCredentials,
    ) {
        match self.fetch(&account).await {
            Ok(fresh) if same_network(&fresh, &cached) => {
                node.set_join_token(fresh.join_token.as_deref());
                let mut running = self.running.lock().await;
                if let Some(running) = running.as_mut() {
                    if running.account == account && Arc::ptr_eq(&running.node, &node) {
                        running.credentials = fresh;
                    }
                }
                log::debug!("Verified cached Link credentials in background");
            }
            Ok(_) => {
                log::warn!("Cached Link network parameters changed on server; scheduling rejoin");
                let should_wake = {
                    let mut guard = self.running.lock().await;
                    if let Some(running) = guard.as_mut() {
                        if running.account == account && Arc::ptr_eq(&running.node, &node) {
                            running.needs_rejoin = true;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                };
                if should_wake {
                    self.wake.notify_one();
                }
            }
            Err(error) => {
                log::debug!(
                    "Background Link credential verification deferred: {}",
                    error
                );
            }
        }
    }

    async fn fetch(&self, account: &AccountIdentity) -> Result<MeshCredentials, FetchError> {
        let token = self
            .session
            .access_token()
            .await
            .map_err(FetchError::Transient)?
            .ok_or_else(|| {
                FetchError::Refused("sign in to OpenBitFun to join your devices".into())
            })?;
        let credentials = fetch_credentials_with(
            &self.options.issuer_url,
            &token,
            &account.device_id,
            &self.options.client_version,
            self.options.tls_roots,
        )
        .await?;
        let cached = CachedCredentials {
            user_id: account.user_id.clone(),
            device_id: Some(account.device_id.clone()),
            issuer_url: Some(self.normalized_issuer_url().to_string()),
            credentials: credentials.clone(),
        };
        if let Ok(json) = serde_json::to_vec(&cached) {
            if let Err(error) = write_private(&self.options.data_dir.join(CREDENTIALS_FILE), &json)
            {
                log::warn!("Failed to cache Link credentials: {}", error);
            }
        }
        Ok(credentials)
    }

    async fn credentials(
        &self,
        account: &AccountIdentity,
    ) -> Result<(MeshCredentials, bool), (MeshState, String)> {
        if let Some(cached) = self.fresh_cached_credentials(account) {
            log::debug!("Starting Link with fresh cached credentials");
            return Ok((cached, true));
        }
        match self.fetch(account).await {
            Ok(credentials) => Ok((credentials, false)),
            Err(FetchError::Transient(error)) => match self.load_cached(account) {
                Some(cached) => {
                    log::warn!(
                        "Link issuer unavailable; using cached credentials: {}",
                        error
                    );
                    Ok((cached.credentials, true))
                }
                None => Err((MeshState::Failed, error)),
            },
            Err(FetchError::Refused(error)) => Err((MeshState::Failed, error)),
            Err(FetchError::Unsupported(error)) => Err((MeshState::Unsupported, error)),
        }
    }

    async fn start_account(
        self: &Arc<Self>,
        account: AccountIdentity,
    ) -> Result<(Running, bool), (MeshState, String)> {
        let (credentials, from_cache) = self.credentials(&account).await?;
        let listener_port = match self.options.preferred_listener_port {
            Some(port) => Some(free_listener_port(port).map_err(|error| {
                (
                    MeshState::Failed,
                    format!("no free Link listener port: {error}"),
                )
            })?),
            None => None,
        };
        let config = DeviceNodeConfig {
            instance_name: format!(
                "openbitfun-{}",
                &account.device_id[..account.device_id.len().min(12)]
            ),
            hostname: account.device_id.clone(),
            credentials: credentials.clone(),
            listener_port,
            inbound_tcp_ports: (MESH_OBP_PORT_FIRST, MESH_OBP_PORT_LAST),
            disable_p2p: self.options.disable_p2p,
        };
        let role = self.options.role;
        let node = LinkNode::start_with(
            NodeOptions {
                config_toml: config
                    .render_as(role)
                    .map_err(|error| (MeshState::Failed, error))?,
                network_name: credentials.network_name.clone(),
                hostname: account.device_id.clone(),
                join_token: credentials
                    .usable_join_token(now_secs(), 0)
                    .map(str::to_string),
                status_interval: self.options.status_interval,
            },
            crate::node::NodeProfile {
                role,
                display_name: self.options.display_name.clone(),
            },
        )
        .await
        .map_err(|error| (MeshState::Failed, error))?;

        let mut tasks = Vec::new();
        // Status forwarding.
        let mut updates = node.subscribe();
        let link = Arc::clone(self);
        tasks.push(tokio::spawn(async move {
            loop {
                let status = updates.borrow_and_update().clone();
                if status.state == MeshState::Running {
                    link.publish_node_status(status);
                }
                if updates.changed().await.is_err() {
                    break;
                }
            }
        }));
        // The OBP listener: bound once the node has an address, re-bound
        // when the address changes. Controllers serve nothing.
        if !role.is_controller() {
            let accept_node = Arc::clone(&node);
            let sender = self.inbound_sender.clone();
            tasks.push(tokio::spawn(async move {
                accept_loop(accept_node, sender).await;
            }));
        }
        Ok((
            Running {
                account,
                node,
                credentials,
                needs_rejoin: false,
                tasks,
            },
            from_cache,
        ))
    }

    async fn stop_running(&self, reason: MeshState) {
        let running = self.running.lock().await.take();
        *lock(&self.node) = None;
        if let Some(running) = running {
            for task in running.tasks {
                task.abort();
            }
            running.node.stop().await;
            log::info!("Link stopped: reason={:?}", reason);
        }
        self.set_state(reason, None);
    }
}

/// Binds the OBP port range on the node's address and forwards accepted
/// streams; re-binds after the listener fails (address change).
async fn accept_loop(node: Arc<LinkNode>, sender: mpsc::Sender<LinkStream>) {
    let mut delay = Duration::from_millis(250);
    loop {
        let mut bound = None;
        for port in MESH_OBP_PORT_FIRST..=MESH_OBP_PORT_LAST {
            match node.bind(port, Duration::from_secs(30)).await {
                Ok(listener) => {
                    bound = Some((port, listener));
                    break;
                }
                Err(error) => log::debug!("Link OBP bind failed: port={}, error={}", port, error),
            }
        }
        let Some((port, mut listener)) = bound else {
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(10));
            continue;
        };
        delay = Duration::from_millis(250);
        node.set_obp_port(Some(port));
        log::info!("Link OBP listener bound: port={}", port);
        loop {
            match listener.accept().await {
                Ok(mut stream) => {
                    if let std::net::IpAddr::V4(ip) = stream.peer_addr().ip() {
                        stream.set_peer_device(node.device_for_ip(ip).await);
                    }
                    if sender.send(stream).await.is_err() {
                        return;
                    }
                }
                Err(error) => {
                    log::info!("Link OBP listener closed: {}", error);
                    node.set_obp_port(None);
                    break;
                }
            }
        }
        if node.has_stopped() {
            return;
        }
        tokio::time::sleep(delay).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    struct StaticSession {
        identity: AccountIdentity,
        token: Option<String>,
        token_calls: Arc<AtomicUsize>,
    }

    impl AccountSession for StaticSession {
        fn identity(&self) -> BoxFuture<'_, Option<AccountIdentity>> {
            let identity = self.identity.clone();
            Box::pin(async move { Some(identity) })
        }

        fn access_token(&self) -> BoxFuture<'_, Result<Option<String>, String>> {
            let token = self.token.clone();
            let calls = Arc::clone(&self.token_calls);
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(token)
            })
        }
    }

    fn sample_credentials(expires_at: Option<i64>) -> MeshCredentials {
        MeshCredentials {
            version: 1,
            network_name: "obf-0123456789abcdef".into(),
            network_secret: "0123456789abcdef0123456789abcdef".into(),
            peers: vec!["ws://127.0.0.1:1/".into()],
            easytier_version: None,
            issued_at: Some(now_secs()),
            join_token: Some("obfjt1.e30.c2ln".into()),
            join_token_expires_at: expires_at,
        }
    }

    fn test_link(
        data_dir: PathBuf,
        issuer_url: &str,
        account_poll: Duration,
        token: Option<String>,
    ) -> (Arc<Link>, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let (inbound_sender, inbound) = mpsc::channel(ACCEPT_QUEUE);
        let options = LinkOptions {
            data_dir,
            issuer_url: issuer_url.to_string(),
            client_version: "2.0.0-test".into(),
            preferred_listener_port: None,
            disable_p2p: true,
            role: NodeRole::Device,
            display_name: None,
            tls_roots: crate::issuer::TlsRoots::default(),
            account_poll,
            status_interval: Duration::from_secs(10),
        };
        let session = Arc::new(StaticSession {
            identity: AccountIdentity {
                user_id: "user-1".into(),
                device_id: "dev-a".into(),
            },
            token,
            token_calls: Arc::clone(&calls),
        });
        let link = Arc::new(Link {
            options,
            session,
            status: watch::channel(MeshStatus::new(MeshState::SignedOut, None)).0,
            running: tokio::sync::Mutex::new(None),
            node: Mutex::new(None),
            wake: Notify::new(),
            stopping: watch::channel(false).0,
            restarts: Mutex::new(0),
            inbound_sender,
            inbound: tokio::sync::Mutex::new(inbound),
            supervisor: Mutex::new(None),
        });
        (link, calls)
    }

    #[tokio::test]
    async fn fast_starts_from_fresh_cached_credentials_without_blocking_on_issuer() {
        let dir = tempfile::tempdir().unwrap();
        let account = AccountIdentity {
            user_id: "user-1".into(),
            device_id: "dev-a".into(),
        };
        let creds = sample_credentials(Some(now_secs() + TOKEN_REFRESH_MARGIN_SECS + 600));
        let cached = CachedCredentials {
            user_id: account.user_id.clone(),
            device_id: Some(account.device_id.clone()),
            issuer_url: Some("https://issuer.example".into()),
            credentials: creds.clone(),
        };
        write_private(
            &dir.path().join(CREDENTIALS_FILE),
            &serde_json::to_vec(&cached).unwrap(),
        )
        .unwrap();

        let (link, calls) = test_link(
            dir.path().to_path_buf(),
            "https://issuer.example/",
            Duration::from_secs(15),
            Some("tok".into()),
        );
        let (resolved, from_cache) = link.credentials(&account).await.unwrap();
        assert!(from_cache);
        assert_eq!(resolved, creds);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "fresh cache should skip blocking on issuer HTTP"
        );

        // Changing issuer URL bypasses fast-start cache.
        let (other_issuer, _) = test_link(
            dir.path().to_path_buf(),
            "https://other.example",
            Duration::from_secs(15),
            Some("tok".into()),
        );
        assert!(other_issuer.fresh_cached_credentials(&account).is_none());

        // Expiring token bypasses fast-start cache.
        let expiring = CachedCredentials {
            credentials: sample_credentials(Some(now_secs() + TOKEN_REFRESH_MARGIN_SECS - 10)),
            ..cached
        };
        write_private(
            &dir.path().join(CREDENTIALS_FILE),
            &serde_json::to_vec(&expiring).unwrap(),
        )
        .unwrap();
        assert!(link.fresh_cached_credentials(&account).is_none());
    }

    #[test]
    fn legacy_cached_credentials_without_device_id_still_load_for_offline_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let creds = sample_credentials(Some(now_secs() + 3600));
        // Format written by builds before `deviceId` and `issuerUrl` existed.
        let legacy_json = serde_json::json!({
            "userId": "user-1",
            "credentials": creds,
        });
        write_private(
            &dir.path().join(CREDENTIALS_FILE),
            &serde_json::to_vec(&legacy_json).unwrap(),
        )
        .unwrap();

        let account = AccountIdentity {
            user_id: "user-1".into(),
            device_id: "dev-a".into(),
        };
        let (link, _) = test_link(
            dir.path().to_path_buf(),
            "https://issuer.example",
            Duration::from_secs(15),
            Some("tok".into()),
        );
        // Legacy files don't fast-start (device binding unknown), but still load
        // on transient issuer failures.
        assert!(link.fresh_cached_credentials(&account).is_none());
        let loaded = link.load_cached(&account).expect("legacy cache loads");
        assert_eq!(loaded.credentials, creds);
        assert_eq!(loaded.device_id, None);
    }

    #[tokio::test]
    async fn startup_failure_retries_with_backoff_faster_than_account_poll() {
        let dir = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        struct FailingTokenSession(Arc<AtomicUsize>);
        impl AccountSession for FailingTokenSession {
            fn identity(&self) -> BoxFuture<'_, Option<AccountIdentity>> {
                Box::pin(async {
                    Some(AccountIdentity {
                        user_id: "user-1".into(),
                        device_id: "dev-a".into(),
                    })
                })
            }
            fn access_token(&self) -> BoxFuture<'_, Result<Option<String>, String>> {
                let calls = Arc::clone(&self.0);
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Err("temporary network error".into())
                })
            }
        }
        let mut options = LinkOptions::from_environment(dir.path().to_path_buf(), "2.0.0-test");
        options.account_poll = Duration::from_secs(30);
        options.preferred_listener_port = None;
        let link = Link::start(options, Arc::new(FailingTokenSession(Arc::clone(&calls))));
        // Should attempt initially and retry at ~1s (well before the 30s account_poll).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
        while calls.load(Ordering::SeqCst) < 2 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let count = calls.load(Ordering::SeqCst);
        link.shutdown().await;
        assert!(
            count >= 2,
            "expected failed startup to retry before 30s account_poll, got {count} calls"
        );
    }
}
