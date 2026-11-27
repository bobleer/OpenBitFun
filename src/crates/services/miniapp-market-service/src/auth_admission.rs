//! Resource admission for the shared identity authority.
//!
//! Enforces per-client-IP rate limits (with IPv6 `/64` prefix aggregation and
//! LRU eviction) alongside high process-wide circuit-breaker ceilings so a
//! single source cannot deny sign-in globally.
use crate::error::MarketError;
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

pub(crate) const MAX_AUTH_BODY: usize = 16 * 1024;
const MAX_AUTH_REQUESTS: usize = 128;
const WINDOW_SECS: u64 = 60;
const MAX_IP_BUCKETS: usize = 32_768;

// Per-client-IP limits within one 60-second window.
const PER_IP_STARTS_PER_MINUTE: u32 = 30;
const PER_IP_CALLBACKS_PER_MINUTE: u32 = 60;
const PER_IP_EMAIL_SENDS_PER_MINUTE: u32 = 10;
const PER_IP_EMAIL_VERIFIES_PER_MINUTE: u32 = 30;
const PER_IP_POLLS_PER_MINUTE: u32 = 120;

// High global circuit-breaker ceilings so one IP can never exhaust global auth.
const GLOBAL_STARTS_PER_MINUTE: u32 = 3_000;
const GLOBAL_CALLBACKS_PER_MINUTE: u32 = 3_000;
const GLOBAL_EMAIL_SENDS_PER_MINUTE: u32 = 300;
const GLOBAL_EMAIL_VERIFIES_PER_MINUTE: u32 = 3_000;
const GLOBAL_POLLS_PER_MINUTE: u32 = 6_000;

#[derive(Debug, Clone, Copy)]
enum AuthorizationKind {
    Start,
    Callback,
    EmailSend,
    EmailVerify,
    Poll,
}

#[derive(Debug, Clone)]
struct RateCounters {
    window: Instant,
    last_seen: Instant,
    starts: u32,
    callbacks: u32,
    email_sends: u32,
    email_verifications: u32,
    polls: u32,
}

impl RateCounters {
    fn new(now: Instant) -> Self {
        Self {
            window: now,
            last_seen: now,
            starts: 0,
            callbacks: 0,
            email_sends: 0,
            email_verifications: 0,
            polls: 0,
        }
    }

    fn reset_if_expired(&mut self, now: Instant) {
        if now.saturating_duration_since(self.window) >= Duration::from_secs(WINDOW_SECS) {
            *self = Self::new(now);
        }
    }

    fn count_mut(&mut self, kind: AuthorizationKind) -> &mut u32 {
        match kind {
            AuthorizationKind::Start => &mut self.starts,
            AuthorizationKind::Callback => &mut self.callbacks,
            AuthorizationKind::EmailSend => &mut self.email_sends,
            AuthorizationKind::EmailVerify => &mut self.email_verifications,
            AuthorizationKind::Poll => &mut self.polls,
        }
    }

    fn check_limit(&self, kind: AuthorizationKind, limit: u32) -> bool {
        let current = match kind {
            AuthorizationKind::Start => self.starts,
            AuthorizationKind::Callback => self.callbacks,
            AuthorizationKind::EmailSend => self.email_sends,
            AuthorizationKind::EmailVerify => self.email_verifications,
            AuthorizationKind::Poll => self.polls,
        };
        current < limit
    }
}

struct LimiterState {
    global: RateCounters,
    per_ip: HashMap<String, RateCounters>,
    max_ip_buckets: usize,
}

impl LimiterState {
    fn new(max_ip_buckets: usize) -> Self {
        Self {
            global: RateCounters::new(Instant::now()),
            per_ip: HashMap::new(),
            max_ip_buckets: max_ip_buckets.max(1),
        }
    }

    fn allow(&mut self, ip_key: &str, kind: AuthorizationKind, now: Instant) -> bool {
        let per_ip_limit = match kind {
            AuthorizationKind::Start => PER_IP_STARTS_PER_MINUTE,
            AuthorizationKind::Callback => PER_IP_CALLBACKS_PER_MINUTE,
            AuthorizationKind::EmailSend => PER_IP_EMAIL_SENDS_PER_MINUTE,
            AuthorizationKind::EmailVerify => PER_IP_EMAIL_VERIFIES_PER_MINUTE,
            AuthorizationKind::Poll => PER_IP_POLLS_PER_MINUTE,
        };
        let global_limit = match kind {
            AuthorizationKind::Start => GLOBAL_STARTS_PER_MINUTE,
            AuthorizationKind::Callback => GLOBAL_CALLBACKS_PER_MINUTE,
            AuthorizationKind::EmailSend => GLOBAL_EMAIL_SENDS_PER_MINUTE,
            AuthorizationKind::EmailVerify => GLOBAL_EMAIL_VERIFIES_PER_MINUTE,
            AuthorizationKind::Poll => GLOBAL_POLLS_PER_MINUTE,
        };

        self.global.reset_if_expired(now);
        if !self.global.check_limit(kind, global_limit) {
            return false;
        }

        if !self.per_ip.contains_key(ip_key) && self.per_ip.len() >= self.max_ip_buckets {
            self.evict(now);
        }

        let bucket = self
            .per_ip
            .entry(ip_key.to_string())
            .or_insert_with(|| RateCounters::new(now));
        bucket.reset_if_expired(now);
        bucket.last_seen = now;
        if !bucket.check_limit(kind, per_ip_limit) {
            return false;
        }

        *bucket.count_mut(kind) += 1;
        self.global.last_seen = now;
        *self.global.count_mut(kind) += 1;
        true
    }

    fn evict(&mut self, now: Instant) {
        let ttl = Duration::from_secs(WINDOW_SECS);
        self.per_ip
            .retain(|_, bucket| now.saturating_duration_since(bucket.window) < ttl);
        // Never fail closed globally on bucket-table pressure: evict oldest entries.
        while self.per_ip.len() >= self.max_ip_buckets {
            let Some(oldest_key) = self
                .per_ip
                .iter()
                .min_by_key(|(_, bucket)| bucket.last_seen)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.per_ip.remove(&oldest_key);
        }
    }
}

/// Per-router auth admission limiter (per-IP + global circuit breaker + concurrency).
pub(crate) struct AuthorizationLimiter {
    state: Mutex<LimiterState>,
    slots: Arc<Semaphore>,
}

impl AuthorizationLimiter {
    pub(crate) fn new() -> Arc<Self> {
        Self::with_max_buckets(MAX_IP_BUCKETS)
    }

    fn with_max_buckets(max_ip_buckets: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(LimiterState::new(max_ip_buckets)),
            slots: Arc::new(Semaphore::new(MAX_AUTH_REQUESTS)),
        })
    }

    fn allow(&self, ip_key: &str, kind: AuthorizationKind) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .allow(ip_key, kind, Instant::now())
    }
}

pub(crate) async fn admit_with_limiter(
    State(limiter): State<Arc<AuthorizationLimiter>>,
    request: Request,
    next: Next,
) -> Response {
    admit_inner(limiter, request, next).await
}

#[cfg(test)]
pub(crate) async fn admit(request: Request, next: Next) -> Response {
    static DEFAULT_LIMITER: std::sync::OnceLock<Arc<AuthorizationLimiter>> =
        std::sync::OnceLock::new();
    let limiter = Arc::clone(DEFAULT_LIMITER.get_or_init(AuthorizationLimiter::new));
    admit_inner(limiter, request, next).await
}

fn normalized_auth_path(path: &str) -> &str {
    path.strip_prefix("/miniapp/api/v1")
        .or_else(|| path.strip_prefix("/api/v1"))
        .unwrap_or(path)
}

async fn admit_inner(limiter: Arc<AuthorizationLimiter>, request: Request, next: Next) -> Response {
    let path = normalized_auth_path(request.uri().path());
    if !path.starts_with("/auth/") {
        return next.run(request).await;
    }
    let mut response = admit_auth(limiter, request, next).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

async fn admit_auth(
    limiter: Arc<AuthorizationLimiter>,
    mut request: Request,
    next: Next,
) -> Response {
    let path = normalized_auth_path(request.uri().path()).to_string();
    let kind = match path.as_str() {
        "/auth/github/start"
        | "/auth/desktop/start"
        | "/auth/login/start"
        | "/auth/login/github" => Some(AuthorizationKind::Start),
        "/auth/github/callback" => Some(AuthorizationKind::Callback),
        "/auth/email/send" => Some(AuthorizationKind::EmailSend),
        "/auth/email/verify" => Some(AuthorizationKind::EmailVerify),
        "/auth/desktop/poll" => Some(AuthorizationKind::Poll),
        _ => None,
    };
    if let Some(kind) = kind {
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0);
        let ip_key = client_ip_bucket(request.headers(), peer);
        if !limiter.allow(&ip_key, kind) {
            let mut response = MarketError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "auth_rate_limit",
                "Sign-in is busy. Please try again shortly.",
            )
            .into_response();
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
            return response;
        }
    }
    let Ok(_permit) = Arc::clone(&limiter.slots).try_acquire_owned() else {
        return MarketError::service_unavailable(
            "auth_capacity",
            "Sign-in is busy. Please try again shortly.",
        )
        .into_response();
    };
    if request.method() == Method::POST {
        let body = std::mem::replace(request.body_mut(), axum::body::Body::empty());
        let bytes = match tokio::time::timeout(
            Duration::from_secs(10),
            axum::body::to_bytes(body, MAX_AUTH_BODY),
        )
        .await
        {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(_)) => {
                return MarketError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "The authentication request exceeds its size limit.",
                )
                .into_response()
            }
            Err(_) => {
                return MarketError::new(
                    StatusCode::REQUEST_TIMEOUT,
                    "auth_timeout",
                    "The authentication request timed out.",
                )
                .into_response()
            }
        };
        *request.body_mut() = axum::body::Body::from(bytes);
    }
    tokio::time::timeout(Duration::from_secs(45), next.run(request))
        .await
        .unwrap_or_else(|_| {
            MarketError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "auth_timeout",
                "The identity service timed out.",
            )
            .into_response()
        })
}

/// Extracts the rate-limit bucket key for a client.
///
/// Only trusts proxy forwarding headers when the immediate TCP peer is loopback
/// or a local Docker/private reverse-proxy bridge. Always reads the rightmost
/// `X-Forwarded-For` entry (appended/overwritten by Nginx) rather than the
/// client-spoofable leftmost entry, and collapses IPv6 addresses to `/64`.
pub(crate) fn client_ip_bucket(headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
    let trusted_proxy = peer.is_none_or(|addr| is_trusted_local_proxy(addr.ip()));
    let ip = if trusted_proxy {
        extract_forwarded_ip(headers).or_else(|| peer.map(|addr| addr.ip()))
    } else {
        peer.map(|addr| addr.ip())
    };
    match ip {
        Some(addr) => normalize_ip_bucket(addr),
        None => "local".to_string(),
    }
}

fn is_trusted_local_proxy(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || is_ipv4_cgnat_or_bridge(v4),
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_trusted_local_proxy(IpAddr::V4(mapped));
            }
            v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00
        }
    }
}

fn is_ipv4_cgnat_or_bridge(v4: Ipv4Addr) -> bool {
    let [a, b, _, _] = v4.octets();
    a == 172 && (16..=31).contains(&b)
}

fn extract_forwarded_ip(headers: &HeaderMap) -> Option<IpAddr> {
    if let Some(ip) = headers
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .and_then(|value| value.parse::<IpAddr>().ok())
    {
        return Some(ip);
    }
    headers
        .get_all("x-forwarded-for")
        .iter()
        .next_back()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .rsplit(',')
                .map(str::trim)
                .find(|part| !part.is_empty())
        })
        .and_then(|value| value.parse::<IpAddr>().ok())
}

fn normalize_ip_bucket(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return mapped.to_string();
            }
            let seg = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", seg[0], seg[1], seg[2], seg[3])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::post, Json, Router};
    use tower::ServiceExt;

    #[test]
    fn per_ip_flood_does_not_starve_other_clients_or_categories() {
        let mut limiter = LimiterState::new(16);
        let now = Instant::now();
        for _ in 0..PER_IP_STARTS_PER_MINUTE {
            assert!(limiter.allow("198.51.100.1", AuthorizationKind::Start, now));
        }
        assert!(!limiter.allow("198.51.100.1", AuthorizationKind::Start, now));
        // Another user on a different IP is unaffected.
        assert!(limiter.allow("198.51.100.2", AuthorizationKind::Start, now));
        // Separate category on the same IP has its own allowance.
        assert!(limiter.allow("198.51.100.1", AuthorizationKind::Callback, now));

        for _ in 0..PER_IP_EMAIL_SENDS_PER_MINUTE {
            assert!(limiter.allow("198.51.100.1", AuthorizationKind::EmailSend, now));
        }
        assert!(!limiter.allow("198.51.100.1", AuthorizationKind::EmailSend, now));
        assert!(limiter.allow("198.51.100.2", AuthorizationKind::EmailSend, now));
        assert!(limiter.allow("198.51.100.1", AuthorizationKind::EmailVerify, now));

        let later = now + Duration::from_secs(61);
        assert!(limiter.allow("198.51.100.1", AuthorizationKind::Start, later));
        assert!(limiter.allow("198.51.100.1", AuthorizationKind::EmailSend, later));
    }

    #[test]
    fn bucket_table_evicts_oldest_entries_instead_of_global_lockout() {
        let mut limiter = LimiterState::new(3);
        let t0 = Instant::now();
        assert!(limiter.allow("198.51.100.1", AuthorizationKind::Start, t0));
        assert!(limiter.allow(
            "198.51.100.2",
            AuthorizationKind::Start,
            t0 + Duration::from_millis(1)
        ));
        assert!(limiter.allow(
            "198.51.100.3",
            AuthorizationKind::Start,
            t0 + Duration::from_millis(2)
        ));
        // 4th distinct IP evicts the oldest bucket rather than failing closed globally.
        assert!(limiter.allow(
            "198.51.100.4",
            AuthorizationKind::Start,
            t0 + Duration::from_millis(3)
        ));
        assert_eq!(limiter.per_ip.len(), 3);
        assert!(!limiter.per_ip.contains_key("198.51.100.1"));
        assert!(limiter.per_ip.contains_key("198.51.100.4"));
    }

    #[test]
    fn client_ip_ignores_leftmost_spoofed_xff_and_aggregates_ipv6_slash_64() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("1.2.3.4, 198.51.100.99"),
        );
        let proxy: SocketAddr = "172.18.0.1:44321".parse().unwrap();
        assert_eq!(client_ip_bucket(&headers, Some(proxy)), "198.51.100.99");

        // Direct untrusted public peer cannot spoof X-Forwarded-For or X-Real-IP.
        let public_peer: SocketAddr = "203.0.113.7:55555".parse().unwrap();
        headers.insert("x-real-ip", HeaderValue::from_static("10.0.0.1"));
        assert_eq!(client_ip_bucket(&headers, Some(public_peer)), "203.0.113.7");

        // IPv6 addresses in the same /64 collapse into one bucket.
        let mut v6_a = HeaderMap::new();
        v6_a.insert(
            "x-forwarded-for",
            HeaderValue::from_static("2001:db8:abcd:1234::1"),
        );
        let mut v6_b = HeaderMap::new();
        v6_b.insert(
            "x-forwarded-for",
            HeaderValue::from_static("2001:db8:abcd:1234:ffff:eeee:dddd:cccc"),
        );
        assert_eq!(
            client_ip_bucket(&v6_a, Some(proxy)),
            client_ip_bucket(&v6_b, Some(proxy))
        );
        assert_eq!(
            client_ip_bucket(&v6_a, Some(proxy)),
            "2001:db8:abcd:1234::/64"
        );
    }

    #[tokio::test]
    async fn auth_body_limit_is_enforced_without_changing_other_api_limits() {
        let app = Router::new()
            .route(
                "/auth/desktop/poll",
                post(|Json(_body): Json<serde_json::Value>| async { StatusCode::NO_CONTENT }),
            )
            .route(
                "/submissions",
                post(|Json(_body): Json<serde_json::Value>| async { StatusCode::NO_CONTENT }),
            )
            .layer(axum::middleware::from_fn(admit));
        for (path, expected) in [
            ("/auth/desktop/poll", StatusCode::PAYLOAD_TOO_LARGE),
            ("/submissions", StatusCode::NO_CONTENT),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(
                            serde_json::json!({"value": "a".repeat(MAX_AUTH_BODY)}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if path.starts_with("/auth/") {
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
                assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
            } else {
                assert!(!response.headers().contains_key(header::CACHE_CONTROL));
            }
        }
    }
}
