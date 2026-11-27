//! Relay server configuration.

use anyhow::Context;
use std::net::SocketAddr;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(super) struct RelayConfig {
    pub listen_addr: SocketAddr,
    pub heartbeat_interval_secs: u64,
    pub heartbeat_timeout_secs: u64,
    pub static_dir: Option<String>,
    /// Directory for published Page assets.
    pub asset_dir: String,
    /// Global capacity for content-addressed Page assets.
    pub asset_store_max_bytes: u64,
    pub cors_allow_origins: Vec<String>,
    /// Browser-visible base URL used for published Page content.
    pub page_public_base_url: Option<String>,
    /// Browser-visible base URL used for trusted Relay Page login.
    pub page_auth_base_url: Option<String>,
    /// Path to the SQLite database file used for account storage.
    /// Required at startup; every device connection is account-authenticated.
    pub db_path: Option<String>,
    /// `RELAY_PROFILE=directory`: run as the OpenBitFun 2.0 account directory
    /// (periodic retention and quota freeing; published Pages off unless
    /// isolated origins and an explicit asset directory are configured).
    /// Unset: the relay profile.
    pub directory_profile: bool,
}

/// Asset-store variables that only apply when published Pages are configured.
pub(super) const PAGE_ASSET_ENV_VARS: [&str; 3] = [
    "RELAY_ASSET_DIR",
    "RELAY_ROOM_WEB_DIR",
    "RELAY_ASSET_STORE_MAX_BYTES",
];

fn has_non_empty(lookup: &impl Fn(&str) -> Option<String>, name: &str) -> bool {
    lookup(name).is_some_and(|value| !value.trim().is_empty())
}

/// Reads `RELAY_PROFILE`: `directory`, or unset / `relay` for the relay.
///
/// Under `directory`, published Pages are opt-in: either leave all Page/asset
/// variables unset (Pages off), or configure both `RELAY_PAGE_PUBLIC_BASE_URL`
/// and `RELAY_PAGE_AUTH_BASE_URL` together with an explicit `RELAY_ASSET_DIR`
/// (or legacy `RELAY_ROOM_WEB_DIR`) so assets are never placed in ephemeral
/// `/tmp`.
pub(super) fn directory_profile(lookup: &impl Fn(&str) -> Option<String>) -> anyhow::Result<bool> {
    match lookup("RELAY_PROFILE").as_deref().map(str::trim) {
        None | Some("") | Some("relay") => Ok(false),
        Some("directory") => {
            let has_public = has_non_empty(lookup, "RELAY_PAGE_PUBLIC_BASE_URL");
            let has_auth = has_non_empty(lookup, "RELAY_PAGE_AUTH_BASE_URL");
            if has_public != has_auth {
                anyhow::bail!(
                    "RELAY_PAGE_PUBLIC_BASE_URL and RELAY_PAGE_AUTH_BASE_URL must be configured together"
                );
            }
            if has_public && has_auth {
                if !has_non_empty(lookup, "RELAY_ASSET_DIR")
                    && !has_non_empty(lookup, "RELAY_ROOM_WEB_DIR")
                {
                    anyhow::bail!(
                        "RELAY_PROFILE=directory with published Pages requires RELAY_ASSET_DIR"
                    );
                }
                return Ok(true);
            }
            let set: Vec<&str> = PAGE_ASSET_ENV_VARS
                .iter()
                .copied()
                .filter(|name| has_non_empty(lookup, name))
                .collect();
            if !set.is_empty() {
                anyhow::bail!(
                    "RELAY_PROFILE=directory without published Pages cannot set {}; configure RELAY_PAGE_PUBLIC_BASE_URL and RELAY_PAGE_AUTH_BASE_URL or unset them",
                    set.join(", ")
                );
            }
            Ok(true)
        }
        Some(other) => anyhow::bail!("RELAY_PROFILE must be relay or directory, got {other:?}"),
    }
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            listen_addr: ([0, 0, 0, 0], 9700).into(),
            heartbeat_interval_secs: 30,
            heartbeat_timeout_secs: 90,
            static_dir: None,
            // Also stores published OpenBitFun Pages under `{asset_dir}/pages/{user_id}/{slug}/`.
            asset_dir: "/tmp/openbitfun-room-web".to_string(),
            asset_store_max_bytes: openbitfun_relay_service::DEFAULT_DISK_ASSET_STORE_MAX_BYTES,
            cors_allow_origins: Vec::new(),
            page_public_base_url: None,
            page_auth_base_url: None,
            db_path: None,
            directory_profile: false,
        }
    }
}

impl RelayConfig {
    pub(super) fn from_env() -> anyhow::Result<Self> {
        let mut cfg = Self {
            directory_profile: directory_profile(&|name| std::env::var(name).ok())?,
            ..Self::default()
        };
        if let Ok(port) = std::env::var("RELAY_PORT") {
            if let Ok(p) = port.parse::<u16>() {
                cfg.listen_addr = ([0, 0, 0, 0], p).into();
            }
        }
        if let Ok(addr) = std::env::var("RELAY_LISTEN_ADDR") {
            cfg.listen_addr = addr
                .parse()
                .context("RELAY_LISTEN_ADDR must be an IP socket address")?;
        }
        if let Ok(dir) = std::env::var("RELAY_STATIC_DIR") {
            cfg.static_dir = Some(dir);
        }
        // Keep the previous storage location readable during upgrades.
        if let Ok(dir) =
            std::env::var("RELAY_ASSET_DIR").or_else(|_| std::env::var("RELAY_ROOM_WEB_DIR"))
        {
            cfg.asset_dir = dir;
        }
        if let Ok(limit) = std::env::var("RELAY_ASSET_STORE_MAX_BYTES") {
            if let Ok(bytes) = limit.parse::<u64>() {
                cfg.asset_store_max_bytes = bytes;
            }
        }
        if let Ok(path) = std::env::var("RELAY_DB_PATH") {
            if path.is_empty() {
                cfg.db_path = None;
            } else {
                cfg.db_path = Some(path);
            }
        }
        if let Ok(origins) = std::env::var("RELAY_CORS_ALLOW_ORIGINS") {
            cfg.cors_allow_origins = origins
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .map(str::to_string)
                .collect();
        }
        cfg.page_public_base_url = std::env::var("RELAY_PAGE_PUBLIC_BASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        cfg.page_auth_base_url = std::env::var("RELAY_PAGE_AUTH_BASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        Ok(cfg)
    }
}

#[cfg(test)]
mod tests {
    use super::directory_profile;

    fn lookup(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn the_directory_profile_validates_optional_page_configuration() {
        assert!(!directory_profile(&lookup(&[])).unwrap());
        assert!(!directory_profile(&lookup(&[("RELAY_PROFILE", "relay")])).unwrap());
        // The relay profile keeps accepting Page configuration.
        assert!(!directory_profile(&lookup(&[
            ("RELAY_PAGE_PUBLIC_BASE_URL", "https://pages.example.com"),
            ("RELAY_ASSET_DIR", "/srv/assets"),
        ]))
        .unwrap());
        // Directory without Pages stays valid.
        assert!(directory_profile(&lookup(&[("RELAY_PROFILE", "directory")])).unwrap());
        assert!(directory_profile(&lookup(&[
            ("RELAY_PROFILE", "directory"),
            ("RELAY_PAGE_AUTH_BASE_URL", " "),
        ]))
        .unwrap());
        // Asset vars without Page origins are rejected.
        let asset_only_err = directory_profile(&lookup(&[
            ("RELAY_PROFILE", "directory"),
            ("RELAY_ASSET_DIR", "/srv/assets"),
        ]))
        .unwrap_err()
        .to_string();
        assert!(
            asset_only_err.contains("RELAY_ASSET_DIR"),
            "{asset_only_err}"
        );
        // Only one Page origin URL is rejected.
        let one_origin_err = directory_profile(&lookup(&[
            ("RELAY_PROFILE", "directory"),
            ("RELAY_PAGE_PUBLIC_BASE_URL", "https://pages.example.com/v2"),
            ("RELAY_ASSET_DIR", "/srv/assets"),
        ]))
        .unwrap_err()
        .to_string();
        assert!(
            one_origin_err.contains("configured together"),
            "{one_origin_err}"
        );
        // Both Page origins without an explicit asset directory are rejected.
        let missing_asset_err = directory_profile(&lookup(&[
            ("RELAY_PROFILE", "directory"),
            ("RELAY_PAGE_PUBLIC_BASE_URL", "https://pages.example.com/v2"),
            ("RELAY_PAGE_AUTH_BASE_URL", "https://auth.example.com/v2"),
        ]))
        .unwrap_err()
        .to_string();
        assert!(
            missing_asset_err.contains("RELAY_ASSET_DIR"),
            "{missing_asset_err}"
        );
        // Complete isolated Page configuration is accepted under directory profile.
        assert!(directory_profile(&lookup(&[
            ("RELAY_PROFILE", "directory"),
            ("RELAY_PAGE_PUBLIC_BASE_URL", "https://pages.example.com/v2"),
            ("RELAY_PAGE_AUTH_BASE_URL", "https://auth.example.com/v2"),
            ("RELAY_ASSET_DIR", "/var/lib/openbitfun-directory/assets"),
        ]))
        .unwrap());
        assert!(directory_profile(&lookup(&[("RELAY_PROFILE", "pages")])).is_err());
    }
}
