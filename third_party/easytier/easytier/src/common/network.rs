#[cfg(not(mobile))]
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
#[cfg(any(target_os = "windows", test))]
use std::sync::Arc;
use std::sync::RwLock;
use std::time::{Duration, Instant};

/// OpenBitFun: RFC 2544 benchmarking range (`198.18.0.0/15`), commonly bound by
/// local proxy fake-IP TUN adapters (Clash/Mihomo, Surge, Sing-box). It is
/// never a real physical LAN interface address.
pub(crate) fn is_proxy_fake_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 198 && (b & 0xfe) == 18
}

use network_interface::{NetworkInterface, NetworkInterfaceConfig};
#[cfg(all(target_os = "macos", not(feature = "macos-ne")))]
use tokio::sync::Mutex;

use crate::proto::peer_rpc::GetIpListResponse;

use super::netns::NetNS;

#[cfg(not(mobile))]
#[derive(Clone, Copy, Debug, Default)]
struct InterfaceState {
    is_point_to_point: bool,
    is_loopback: bool,
    is_up: bool,
    #[cfg(target_os = "linux")]
    is_lower_up: bool,
}

#[cfg(any(
    all(target_os = "linux", not(target_env = "ohos")),
    all(target_os = "macos", not(feature = "macos-ne")),
    target_os = "freebsd"
))]
fn collect_interface_states() -> HashMap<String, InterfaceState> {
    let mut states = HashMap::new();
    if let Ok(interfaces) = nix::ifaddrs::getifaddrs() {
        use nix::net::if_::InterfaceFlags;

        for interface in interfaces {
            let flags = interface.flags;
            #[cfg(target_os = "linux")]
            let is_lower_up = flags.contains(InterfaceFlags::IFF_LOWER_UP);
            states.insert(
                interface.interface_name,
                InterfaceState {
                    is_point_to_point: flags.contains(InterfaceFlags::IFF_POINTOPOINT),
                    is_loopback: flags.contains(InterfaceFlags::IFF_LOOPBACK),
                    is_up: flags.contains(InterfaceFlags::IFF_UP),
                    #[cfg(target_os = "linux")]
                    is_lower_up,
                },
            );
        }
    }
    states
}

#[cfg(not(mobile))]
#[cfg(not(any(
    all(target_os = "linux", not(target_env = "ohos")),
    all(target_os = "macos", not(feature = "macos-ne")),
    target_os = "freebsd"
)))]
fn collect_interface_states() -> HashMap<String, InterfaceState> {
    HashMap::new()
}

#[cfg(any(target_os = "freebsd", target_os = "windows"))]
fn has_nonzero_mac(iface: &NetworkInterface) -> bool {
    iface.mac_addr.as_deref().is_some_and(|mac| {
        let mut octets = mac.split([':', '-']);
        let mut nonzero = false;
        for _ in 0..6 {
            let Some(value) = octets
                .next()
                .and_then(|octet| u8::from_str_radix(octet, 16).ok())
            else {
                return false;
            };
            nonzero |= value != 0;
        }
        octets.next().is_none() && nonzero
    })
}

#[allow(dead_code)]
pub(crate) fn ip_mask_to_prefix(mask: IpAddr) -> Result<u8, ()> {
    match mask {
        IpAddr::V4(mask) => {
            let raw = u32::from(mask);
            let prefix = raw.leading_ones() as u8;
            let expected = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };
            (raw == expected).then_some(prefix).ok_or(())
        }
        IpAddr::V6(mask) => {
            let raw = u128::from(mask);
            let prefix = raw.leading_ones() as u8;
            let expected = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            (raw == expected).then_some(prefix).ok_or(())
        }
    }
}

#[cfg(not(mobile))]
struct InterfaceFilter {
    iface: NetworkInterface,
    state: InterfaceState,
}

#[cfg(not(mobile))]
fn interface_state(
    iface: &NetworkInterface,
    states: &HashMap<String, InterfaceState>,
) -> InterfaceState {
    states.get(&iface.name).copied().unwrap_or(InterfaceState {
        is_loopback: iface.internal,
        is_up: true,
        #[cfg(target_os = "linux")]
        is_lower_up: true,
        ..Default::default()
    })
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
impl InterfaceFilter {
    async fn is_tun_tap_device(&self) -> bool {
        let path = format!("/sys/class/net/{}/tun_flags", self.iface.name);
        tokio::fs::metadata(&path).await.is_ok()
    }

    async fn has_valid_ip(&self) -> bool {
        self.iface
            .addr
            .iter()
            .map(|ip| ip.ip())
            .any(|ip| !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast())
    }

    async fn filter_iface(&self) -> bool {
        tracing::trace!(
            "filter linux iface: {:?}, is_point_to_point: {}, is_loopback: {}, is_up: {}, is_lower_up: {}, is_tun: {}, has_valid_ip: {}",
            self.iface,
            self.state.is_point_to_point,
            self.state.is_loopback,
            self.state.is_up,
            self.state.is_lower_up,
            self.is_tun_tap_device().await,
            self.has_valid_ip().await
        );

        !self.state.is_point_to_point
            && !self.state.is_loopback
            && self.state.is_up
            && self.state.is_lower_up
            && !self.is_tun_tap_device().await
            && self.has_valid_ip().await
    }
}

// Cache for networksetup command output
#[cfg(all(target_os = "macos", not(feature = "macos-ne")))]
static NETWORKSETUP_CACHE: std::sync::OnceLock<Mutex<(String, std::time::Instant)>> =
    std::sync::OnceLock::new();

#[cfg(any(
    all(target_os = "macos", not(feature = "macos-ne")),
    target_os = "freebsd"
))]
impl InterfaceFilter {
    #[cfg(all(target_os = "macos", not(feature = "macos-ne")))]
    async fn get_networksetup_output() -> String {
        use anyhow::Context;
        use std::time::{Duration, Instant};
        let cache = NETWORKSETUP_CACHE.get_or_init(|| Mutex::new((String::new(), Instant::now())));
        let mut cache_guard = cache.lock().await;

        // Check if cache is still valid (less than 1 minute old)
        if cache_guard.1.elapsed() < Duration::from_secs(60) && !cache_guard.0.is_empty() {
            return cache_guard.0.clone();
        }

        // Cache is expired or empty, fetch new data
        let stdout = tokio::process::Command::new("networksetup")
            .args(["-listallhardwareports"])
            .output()
            .await
            .with_context(|| "Failed to execute networksetup command")
            .and_then(|output| {
                std::str::from_utf8(&output.stdout)
                    .map(|s| s.to_string())
                    .with_context(|| "Failed to convert networksetup output to string")
            })
            .unwrap_or_else(|e| {
                tracing::error!("Failed to execute networksetup command: {:?}", e);
                String::new()
            });

        // Update cache
        cache_guard.0 = stdout.clone();
        cache_guard.1 = Instant::now();

        stdout
    }

    #[cfg(all(target_os = "macos", not(feature = "macos-ne")))]
    async fn is_interface_physical(&self) -> bool {
        let interface_name = &self.iface.name;
        let stdout = Self::get_networksetup_output().await;

        let lines: Vec<&str> = stdout.lines().collect();

        for i in 0..lines.len() {
            let line = lines[i];

            if line.contains("Device:") && line.contains(interface_name) {
                let next_line = lines[i + 1];
                return !next_line.contains("Virtual Interface");
            }
        }

        false
    }

    #[cfg(target_os = "freebsd")]
    async fn is_interface_physical(&self) -> bool {
        // if mac addr is not zero, then it's physical interface
        has_nonzero_mac(&self.iface)
    }

    async fn filter_iface(&self) -> bool {
        !self.state.is_point_to_point
            && !self.state.is_loopback
            && self.state.is_up
            && self.is_interface_physical().await
    }
}

#[cfg(target_os = "windows")]
impl InterfaceFilter {
    async fn filter_iface(&self) -> bool {
        tracing::debug!(
            "iface_name: {:?}, p2p: {:?}, is_up: {:?}, iface: {:?}",
            self.iface.name,
            self.state.is_point_to_point,
            self.state.is_up,
            self.iface
        );
        !self.state.is_point_to_point
            && !self.state.is_loopback
            && self.iface.addr.iter().map(|ip| ip.ip()).any(|ip| {
                !ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_multicast()
                    && !matches!(ip, IpAddr::V4(v4) if is_proxy_fake_ipv4(v4))
            })
            && has_nonzero_mac(&self.iface)
    }
}

pub async fn local_ipv4() -> std::io::Result<std::net::Ipv4Addr> {
    let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await?;
    socket.connect("8.8.8.8:80").await?;
    let addr = socket.local_addr()?;
    match addr.ip() {
        std::net::IpAddr::V4(ip) => Ok(ip),
        std::net::IpAddr::V6(_) => Err(std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            "no ipv4 address",
        )),
    }
}

pub async fn local_ipv6() -> std::io::Result<std::net::Ipv6Addr> {
    let socket = tokio::net::UdpSocket::bind("[::]:0").await?;
    socket
        .connect("[2001:4860:4860:0000:0000:0000:0000:8888]:80")
        .await?;
    let addr = socket.local_addr()?;
    match addr.ip() {
        std::net::IpAddr::V6(ip) => Ok(ip),
        std::net::IpAddr::V4(_) => Err(std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            "no ipv4 address",
        )),
    }
}

pub(crate) async fn collect_interfaces(net_ns: NetNS, filter: bool) -> Vec<NetworkInterface> {
    #[cfg(target_os = "linux")]
    {
        run_in_namespace(net_ns, move || async move {
            collect_interfaces_in_current_namespace(filter).await
        })
        .await
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _g = net_ns.guard();
        collect_interfaces_in_current_namespace(filter).await
    }
}

/// The Windows bind path resolves an interface name and then its index
/// through full `NetworkInterface::show()` enumerations for every bind
/// candidate. With 10+ adapters (VMware / Hyper-V / APIPA leftovers are
/// common), one connect round turns into O(candidates) synchronous
/// enumerations on the async worker. Interfaces rarely change within a
/// connect round, so snapshots are reused for a short TTL.
/// Only use this cache for socket binding; interface configuration needs
/// fresh enumeration to observe adapter creation and replacement immediately.
#[cfg(target_os = "windows")]
pub(crate) fn get_interfaces_cached() -> Option<Arc<Vec<NetworkInterface>>> {
    static SNAPSHOT: InterfaceSnapshot = RwLock::new(None);
    get_or_refresh_interfaces(&SNAPSHOT, || NetworkInterface::show().ok())
}

#[cfg(any(target_os = "windows", test))]
type InterfaceSnapshot = RwLock<Option<(Instant, Arc<Vec<NetworkInterface>>)>>;

#[cfg(any(target_os = "windows", test))]
fn get_or_refresh_interfaces(
    snapshot: &InterfaceSnapshot,
    enumerate: impl FnOnce() -> Option<Vec<NetworkInterface>>,
) -> Option<Arc<Vec<NetworkInterface>>> {
    const SNAPSHOT_TTL: Duration = Duration::from_secs(1);
    if let Some((at, ifaces)) = snapshot.read().ok().and_then(|guard| guard.clone())
        && at.elapsed() < SNAPSHOT_TTL
    {
        return Some(ifaces);
    }

    // Recheck after acquiring the write lock: another caller may have refreshed
    // while we waited. Keep the lock during enumeration to coalesce refreshes.
    let mut snapshot = snapshot.write().ok()?;
    if let Some((at, ifaces)) = snapshot.as_ref()
        && at.elapsed() < SNAPSHOT_TTL
    {
        return Some(ifaces.clone());
    }
    let ifaces = Arc::new(enumerate()?);
    *snapshot = Some((Instant::now(), ifaces.clone()));
    Some(ifaces)
}

#[cfg(feature = "faketcp")]
fn convert_pnet_interface(iface: pnet_datalink::NetworkInterface) -> NetworkInterface {
    let internal = iface.is_loopback();
    let addr = iface
        .ips
        .into_iter()
        .filter_map(|network| match (network.ip(), network.mask()) {
            (IpAddr::V4(ip), IpAddr::V4(netmask)) => {
                Some(network_interface::Addr::V4(network_interface::V4IfAddr {
                    ip,
                    broadcast: None,
                    netmask: Some(netmask),
                }))
            }
            (IpAddr::V6(ip), IpAddr::V6(netmask)) => {
                Some(network_interface::Addr::V6(network_interface::V6IfAddr {
                    ip,
                    broadcast: None,
                    netmask: Some(netmask),
                }))
            }
            _ => None,
        })
        .collect();
    NetworkInterface {
        name: iface.name,
        addr,
        mac_addr: iface.mac.map(|mac| mac.to_string()),
        index: iface.index,
        internal,
    }
}

async fn collect_interfaces_in_current_namespace(filter: bool) -> Vec<NetworkInterface> {
    let ifaces = match NetworkInterface::show() {
        Ok(ifaces) => ifaces,
        Err(error) => {
            tracing::warn!(?error, "failed to enumerate network interfaces");
            #[cfg(feature = "faketcp")]
            {
                match std::panic::catch_unwind(pnet_datalink::interfaces) {
                    Ok(ifaces) => ifaces.into_iter().map(convert_pnet_interface).collect(),
                    Err(_) => {
                        tracing::error!(
                            "failed to enumerate network interfaces via network-interface and pnet"
                        );
                        return Vec::new();
                    }
                }
            }
            #[cfg(not(feature = "faketcp"))]
            return Vec::new();
        }
    };
    #[cfg(mobile)]
    {
        let _ = filter;
        ifaces
    }

    #[cfg(not(mobile))]
    {
        let states = collect_interface_states();
        let mut ret = vec![];
        for iface in ifaces {
            let f = InterfaceFilter {
                iface: iface.clone(),
                state: interface_state(&iface, &states),
            };

            if filter && !f.filter_iface().await {
                continue;
            }

            ret.push(iface);
        }

        ret
    }
}

#[cfg(target_os = "linux")]
async fn run_in_namespace<T, F, Fut>(net_ns: NetNS, operation: F) -> T
where
    T: Send + 'static,
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = T> + 'static,
{
    tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build namespace-local runtime");
        net_ns.run(|| runtime.block_on(operation()))
    })
    .await
    .expect("namespace-local network operation panicked")
}

#[tracing::instrument(skip(net_ns))]
pub(crate) async fn collect_local_ip_addrs(net_ns: NetNS) -> GetIpListResponse {
    #[cfg(target_os = "linux")]
    {
        return run_in_namespace(net_ns, || async {
            collect_local_ip_addrs_in_current_namespace().await
        })
        .await;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _g = net_ns.guard();
        collect_local_ip_addrs_in_current_namespace().await
    }
}

async fn collect_local_ip_addrs_in_current_namespace() -> GetIpListResponse {
    let mut ret = GetIpListResponse::default();

    let ifaces = collect_interfaces_in_current_namespace(true).await;
    for iface in ifaces {
        for ip in iface.addr {
            let ip: std::net::IpAddr = ip.ip();
            if let std::net::IpAddr::V4(v4) = ip {
                // OpenBitFun: exclude proxy fake-IP TUN addresses (198.18.0.0/15).
                if ip.is_loopback() || ip.is_multicast() || is_proxy_fake_ipv4(v4) {
                    continue;
                }
                ret.interface_ipv4s.push(v4.into());
            }
        }
    }

    let ifaces = collect_interfaces_in_current_namespace(false).await;
    for iface in ifaces {
        for ip in iface.addr {
            let ip: std::net::IpAddr = ip.ip();
            if let std::net::IpAddr::V6(v6) = ip {
                if v6.is_multicast() || v6.is_loopback() || v6.is_unicast_link_local() {
                    continue;
                }
                ret.interface_ipv6s.push(v6.into());
            }
        }
    }

    if let Ok(v4_addr) = local_ipv4().await {
        tracing::trace!("got local ipv4: {}", v4_addr);
        // OpenBitFun: do not re-inject a proxy fake-IP TUN (198.18.0.0/15) into
        // `interface_ipv4s` when `local_ipv4()` routes through Clash/Mihomo TUN.
        if !is_proxy_fake_ipv4(v4_addr) && !ret.interface_ipv4s.contains(&v4_addr.into()) {
            ret.interface_ipv4s.push(v4_addr.into());
        }
    }

    if let Ok(v6_addr) = local_ipv6().await {
        tracing::trace!("got local ipv6: {}", v6_addr);
        if !ret.interface_ipv6s.contains(&v6_addr.into()) {
            ret.interface_ipv6s.push(v6_addr.into());
        }
    }

    ret
}

/// OpenBitFun: returns the underlying physical default-route IPv4 interface
/// name when a local proxy fake-IP TUN (`198.18.0.0/15`) hijacks the OS IPv4
/// default route; returns `None` when the default route is already direct.
#[cfg(not(mobile))]
pub(crate) fn proxy_tun_bypass_interface(net_ns: &NetNS) -> Option<String> {
    const CACHE_TTL: Duration = Duration::from_secs(5);
    static CACHE: RwLock<Option<(Instant, Option<String>)>> = RwLock::new(None);

    if net_ns.name().is_none()
        && let Some((at, iface)) = CACHE.read().ok().and_then(|guard| guard.clone())
        && at.elapsed() < CACHE_TTL
    {
        return iface;
    }

    let resolved = {
        let _g = net_ns.guard();
        detect_proxy_tun_bypass_interface_in_current_namespace()
    };

    if net_ns.name().is_none()
        && let Ok(mut guard) = CACHE.write()
    {
        *guard = Some((Instant::now(), resolved.clone()));
    }
    resolved
}

#[cfg(mobile)]
pub(crate) fn proxy_tun_bypass_interface(_net_ns: &NetNS) -> Option<String> {
    None
}

#[cfg(not(mobile))]
fn default_route_local_ipv4_sync() -> Option<Ipv4Addr> {
    let socket = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

#[cfg(not(mobile))]
fn is_valid_physical_bypass_iface(
    iface: &NetworkInterface,
    states: &HashMap<String, InterfaceState>,
) -> bool {
    let state = interface_state(iface, states);
    if state.is_loopback || state.is_point_to_point || !state.is_up {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        if !state.is_lower_up {
            return false;
        }
        let tun_path = format!("/sys/class/net/{}/tun_flags", iface.name);
        if std::fs::metadata(tun_path).is_ok() {
            return false;
        }
    }
    #[cfg(target_os = "windows")]
    {
        if !has_nonzero_mac(iface) {
            return false;
        }
    }
    iface.addr.iter().any(|addr| match addr.ip() {
        IpAddr::V4(v4) => {
            !v4.is_loopback()
                && !v4.is_unspecified()
                && !v4.is_multicast()
                && !v4.is_link_local()
                && !is_proxy_fake_ipv4(v4)
        }
        IpAddr::V6(_) => false,
    })
}

#[cfg(not(mobile))]
fn detect_proxy_tun_bypass_interface_in_current_namespace() -> Option<String> {
    let default_ip = default_route_local_ipv4_sync()?;
    if !is_proxy_fake_ipv4(default_ip) {
        return None;
    }
    find_physical_default_ipv4_interface()
}

#[cfg(not(mobile))]
fn find_physical_default_ipv4_interface() -> Option<String> {
    #[cfg(target_os = "windows")]
    let ifaces = get_interfaces_cached()?;
    #[cfg(not(target_os = "windows"))]
    let ifaces = NetworkInterface::show().ok()?;

    let states = collect_interface_states();
    let valid_names: std::collections::HashSet<&str> = ifaces
        .iter()
        .filter(|iface| is_valid_physical_bypass_iface(iface, &states))
        .map(|iface| iface.name.as_str())
        .collect();
    if valid_names.is_empty() {
        return None;
    }

    #[cfg(all(target_os = "macos", not(feature = "macos-ne")))]
    {
        for name in macos_default_ipv4_route_interfaces() {
            if valid_names.contains(name.as_str()) {
                return Some(name);
            }
        }
    }

    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    {
        if let Ok(table) = std::fs::read_to_string("/proc/net/route") {
            for name in parse_linux_default_ipv4_routes(&table) {
                if valid_names.contains(name.as_str()) {
                    return Some(name);
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        for if_index in windows_default_ipv4_route_if_indices() {
            if let Some(iface) = ifaces
                .iter()
                .find(|iface| iface.index == if_index && valid_names.contains(iface.name.as_str()))
            {
                return Some(iface.name.clone());
            }
        }
    }

    None
}

#[cfg(all(target_os = "macos", not(feature = "macos-ne")))]
fn macos_default_ipv4_route_interfaces() -> Vec<String> {
    use nix::libc;

    // BSD <net/route.h> sockaddr alignment on macOS (uint32_t / 4 bytes).
    fn roundup_sa(sa_len: usize) -> usize {
        if sa_len == 0 { 4 } else { (sa_len + 3) & !3 }
    }

    fn is_zero_ipv4_sockaddr(slice: &[u8], allow_compact_zero_mask: bool) -> bool {
        let Some(&sa_len) = slice.first() else {
            return false;
        };
        let sa_len = usize::from(sa_len);
        if allow_compact_zero_mask && sa_len <= 4 {
            return true;
        }
        if sa_len < 8 || slice.len() < 8 {
            return false;
        }
        let sa_family = slice[1];
        if !allow_compact_zero_mask && i32::from(sa_family) != libc::AF_INET {
            return false;
        }
        slice[4..8] == [0, 0, 0, 0]
    }

    const RTF_IFSCOPE: libc::c_int = 0x0100_0000;
    let mut mib = [
        libc::CTL_NET,
        libc::PF_ROUTE,
        0,
        libc::AF_INET,
        libc::NET_RT_DUMP,
        0,
    ];
    let mut buf = Vec::new();
    for _ in 0..2 {
        let mut needed: libc::size_t = 0;
        let ret = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                std::ptr::null_mut(),
                &mut needed,
                std::ptr::null_mut(),
                0,
            )
        };
        if ret != 0 || needed == 0 {
            return Vec::new();
        }
        buf.resize(needed, 0u8);
        let ret = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                buf.as_mut_ptr().cast(),
                &mut needed,
                std::ptr::null_mut(),
                0,
            )
        };
        if ret == 0 {
            buf.truncate(needed);
            break;
        }
        buf.clear();
    }

    let hdr_size = std::mem::size_of::<libc::rt_msghdr>();
    let mut candidates: Vec<(bool, String)> = Vec::new();
    let mut offset = 0usize;
    while offset + hdr_size <= buf.len() {
        let hdr =
            unsafe { std::ptr::read_unaligned(buf.as_ptr().add(offset) as *const libc::rt_msghdr) };
        let msglen = usize::from(hdr.rtm_msglen);
        if msglen < hdr_size || offset + msglen > buf.len() {
            break;
        }
        let next_offset = offset + msglen;

        let is_up_gateway = (hdr.rtm_flags & libc::RTF_UP) != 0
            && (hdr.rtm_flags & libc::RTF_GATEWAY) != 0
            && hdr.rtm_index != 0
            && (hdr.rtm_addrs & libc::RTA_DST) != 0
            && (hdr.rtm_addrs & libc::RTA_NETMASK) != 0;

        if is_up_gateway {
            let mut pos = offset + hdr_size;
            let mut dst_is_default = false;
            let mut mask_is_default = false;
            for bit in 0..=2 {
                let flag = 1 << bit;
                if (hdr.rtm_addrs & flag) == 0 {
                    continue;
                }
                if pos >= next_offset {
                    break;
                }
                let slice = &buf[pos..next_offset];
                let sa_len = usize::from(slice[0]);
                if flag == libc::RTA_DST {
                    dst_is_default = is_zero_ipv4_sockaddr(slice, false);
                } else if flag == libc::RTA_NETMASK {
                    mask_is_default = is_zero_ipv4_sockaddr(slice, true);
                }
                pos = pos.saturating_add(roundup_sa(sa_len));
            }
            if dst_is_default && mask_is_default {
                let mut name_buf = [0 as libc::c_char; libc::IFNAMSIZ];
                let name_ptr = unsafe {
                    libc::if_indextoname(u32::from(hdr.rtm_index), name_buf.as_mut_ptr())
                };
                if !name_ptr.is_null()
                    && let Ok(name) = unsafe { std::ffi::CStr::from_ptr(name_ptr) }.to_str()
                {
                    let is_ifscope = (hdr.rtm_flags & RTF_IFSCOPE) != 0;
                    candidates.push((is_ifscope, name.to_owned()));
                }
            }
        }
        offset = next_offset;
    }

    // Prefer global default routes before interface-scoped default routes.
    candidates.sort_by_key(|(is_ifscope, _)| *is_ifscope);
    let mut out = Vec::new();
    for (_, name) in candidates {
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

#[cfg(any(all(target_os = "linux", not(target_env = "ohos")), test))]
fn parse_linux_default_ipv4_routes(proc_net_route: &str) -> Vec<String> {
    let mut entries: Vec<(u32, String)> = Vec::new();
    for line in proc_net_route.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 8 {
            continue;
        }
        let iface = cols[0];
        let dest = cols[1];
        let flags = u32::from_str_radix(cols[3], 16).unwrap_or(0);
        let metric = cols[6].parse::<u32>().unwrap_or(u32::MAX);
        let mask = cols[7];
        // RTF_UP (0x1) | default 0.0.0.0/0
        if (flags & 0x1) != 0 && dest == "00000000" && mask == "00000000" {
            entries.push((metric, iface.to_owned()));
        }
    }
    entries.sort_by_key(|(metric, _)| *metric);
    let mut out = Vec::new();
    for (_, iface) in entries {
        if !out.contains(&iface) {
            out.push(iface);
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn windows_default_ipv4_route_if_indices() -> Vec<u32> {
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows::Win32::NetworkManagement::IpHelper::{GetIpForwardTable, MIB_IPFORWARDTABLE};

    let mut size: u32 = 0;
    let status = unsafe { GetIpForwardTable(None, &mut size, false) };
    if status != ERROR_INSUFFICIENT_BUFFER.0 && status != NO_ERROR.0 || size == 0 {
        return Vec::new();
    }
    let mut buf = vec![0u8; size as usize];
    let status = unsafe { GetIpForwardTable(Some(buf.as_mut_ptr().cast()), &mut size, false) };
    if status != NO_ERROR.0 {
        return Vec::new();
    }
    if (size as usize) < std::mem::size_of::<MIB_IPFORWARDTABLE>() {
        return Vec::new();
    }
    let table = unsafe { &*(buf.as_ptr() as *const MIB_IPFORWARDTABLE) };
    let count = table.dwNumEntries as usize;
    let rows = unsafe { std::slice::from_raw_parts(table.table.as_ptr(), count) };
    let mut entries: Vec<(u32, u32)> = rows
        .iter()
        .filter(|row| row.dwForwardDest == 0 && row.dwForwardMask == 0)
        .map(|row| (row.dwForwardMetric1, row.dwForwardIfIndex))
        .collect();
    entries.sort_by_key(|(metric, _)| *metric);
    let mut out = Vec::new();
    for (_, idx) in entries {
        if !out.contains(&idx) {
            out.push(idx);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_contiguous_ip_masks_to_prefixes() {
        assert_eq!(
            ip_mask_to_prefix(IpAddr::V4("255.255.254.0".parse().unwrap())),
            Ok(23)
        );
        assert_eq!(
            ip_mask_to_prefix(IpAddr::V6("ffff:ffff:ffff:ffff::".parse().unwrap())),
            Ok(64)
        );
        assert_eq!(
            ip_mask_to_prefix(IpAddr::V4("255.0.255.0".parse().unwrap())),
            Err(())
        );
    }

    #[test]
    fn recognizes_proxy_fake_ipv4_range() {
        assert!(is_proxy_fake_ipv4(Ipv4Addr::new(198, 18, 0, 0)));
        assert!(is_proxy_fake_ipv4(Ipv4Addr::new(198, 18, 0, 1)));
        assert!(is_proxy_fake_ipv4(Ipv4Addr::new(198, 19, 255, 255)));
        assert!(!is_proxy_fake_ipv4(Ipv4Addr::new(198, 17, 255, 255)));
        assert!(!is_proxy_fake_ipv4(Ipv4Addr::new(198, 20, 0, 1)));
        assert!(!is_proxy_fake_ipv4(Ipv4Addr::new(192, 168, 1, 79)));
    }

    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    #[test]
    fn parses_linux_default_ipv4_routes_by_metric() {
        let table = "\
Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT
utun0\t00000000\t010012C6\t0003\t0\t0\t5\t00000000\t0\t0\t0
wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0
eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0
eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0
";
        assert_eq!(
            parse_linux_default_ipv4_routes(table),
            vec!["utun0".to_string(), "eth0".to_string(), "wlan0".to_string()]
        );
    }

    #[cfg(all(target_os = "macos", not(feature = "macos-ne")))]
    #[test]
    fn macos_default_ipv4_route_lookup_succeeds_without_panicking() {
        let ifaces = macos_default_ipv4_route_interfaces();
        for name in &ifaces {
            assert!(!name.is_empty());
        }
        // When a proxy fake-IP TUN owns the default route, bypass must pick a
        // non-utun physical interface (or None if offline).
        if let Some(bypass) = proxy_tun_bypass_interface(&NetNS::new(None)) {
            assert!(!bypass.starts_with("utun"), "bypass chose TUN: {bypass}");
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn namespace_operation_does_not_migrate_between_os_threads() {
        let (before, after) = run_in_namespace(NetNS::new(None), || async {
            let before = std::thread::current().id();
            tokio::task::yield_now().await;
            (before, std::thread::current().id())
        })
        .await;

        assert_eq!(before, after);
    }
}

#[cfg(test)]
mod interface_snapshot_tests {
    use super::*;
    use std::sync::{
        Barrier,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn concurrent_refreshes_share_cold_and_expired_snapshots() {
        for initial in [
            None,
            Some((Instant::now() - Duration::from_secs(2), Arc::new(vec![]))),
        ] {
            let snapshot = InterfaceSnapshot::new(initial);
            let calls = AtomicUsize::new(0);
            let barrier = Barrier::new(8);
            let results = std::thread::scope(|scope| {
                let handles: Vec<_> = (0..8)
                    .map(|_| {
                        scope.spawn(|| {
                            barrier.wait();
                            get_or_refresh_interfaces(&snapshot, || {
                                calls.fetch_add(1, Ordering::SeqCst);
                                std::thread::sleep(Duration::from_millis(20));
                                Some(vec![])
                            })
                            .unwrap()
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|h| h.join().unwrap())
                    .collect::<Vec<_>>()
            });
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            for result in &results {
                assert!(Arc::ptr_eq(&results[0], result));
            }
        }
    }

    #[test]
    fn failed_refresh_is_retried_without_serving_expired_snapshot() {
        let snapshot = InterfaceSnapshot::new(Some((
            Instant::now() - Duration::from_secs(2),
            Arc::new(vec![]),
        )));
        assert!(get_or_refresh_interfaces(&snapshot, || None).is_none());
        let refreshed = get_or_refresh_interfaces(&snapshot, || Some(vec![])).unwrap();
        let cached =
            get_or_refresh_interfaces(&snapshot, || panic!("cache should be fresh")).unwrap();
        assert!(Arc::ptr_eq(&refreshed, &cached));
    }
}
