# Relay, accounts, and remote connections

[中文](FAQ.zh-CN.md) · [Operator guide](README.md)

## Do I need to deploy a server?

No. OpenBitFun 2.0 clients use the official service host
`https://super.openbitfun.com` (account directory at
`https://super.openbitfun.com/directory`, see
[`deploy/super/README.md`](../../../deploy/super/README.md)). Sign in on each
host and client with the same OpenBitFun account and keep the host running and
reachable.

| Connection | What you need |
| --- | --- |
| Official 2.0 services (OpenBitFun Link) | Internet access for sign-in and the same OpenBitFun account on each device; no server deployment or URL configuration. Devices on the same network automatically use a direct LAN P2P route through Link, and otherwise use hole punching or peer/server relay fallback |
| Self-hosted / fork | Your own 2.0 service stack (`deploy/super` and `deploy/easytier`) and matching client builds; see the [fork guide](README.md#for-community-developers-and-forks) |
| SSH / Docker workspace | Access to the target environment; independent of account sign-in |

OpenBitFun 2.0 retired the 1.x **Same network** embedded Desktop LAN Relay, the
standalone LAN listener and LAN pairing QR codes, and 1.x Relay pairing
invitations. All signed-in runtime hosts (Desktop and CLI) join the account's
OpenBitFun Link device network automatically while remote control is enabled,
and devices on the same network connect directly over LAN without switching
modes. Messaging bots keep their own provider configuration and pairing flow.

## Is GitHub required?

Current clients offer GitHub and email verification-code sign-in when enabled
by the shared identity service. Email sign-in needs no password. The two login
methods create independent accounts; matching email addresses do not merge them.
Use the same method and account on each device to see the same devices.

Older clients and services can offer GitHub only. If an expected login option is
missing, check the installed client and service support. Local work and SSH /
Docker workspace connections do not require an OpenBitFun account; model and
external service credentials are separate.

1.x Relay pairing invitations are retired in 2.0: phones (the OpenBitFun mobile
app) and browsers (`https://super.openbitfun.com/`) sign in with the same
OpenBitFun account and connect to online devices listed in the account
directory over OpenBitFun Link.

## Can devices on the same network connect without internet access?

OpenBitFun 2.0 no longer has a separate LAN mode or embedded LAN Relay. Once
signed in, devices on the same network automatically take a direct LAN P2P path
through OpenBitFun Link without routing payloads through the server relay.
However, account sign-in still verifies identity through `auth.openbitfun.com`
and obtains account directory and Link credentials online, so there is no
offline account-setup or sign-in flow. An existing authenticated session is not
a guarantee that a new login or credential renewal will work during an outage.

For an isolated environment, local work and SSH / Docker remain separate
options, subject to their own connectivity and model requirements. Self-hosting
the directory and Link services alone does not remove the online identity
dependency: an independent deployment must also adapt the identity service and
clients. The shipped product does not provide a turnkey air-gapped identity
mode.

## What can the services see?

Device-control payloads are encrypted end to end. Devices generate X25519
private keys locally, retrieve peer public keys from the authenticated account
directory, and authenticate / encrypt OBP sessions over OpenBitFun Link (and
the browser gateway's `obp-e2e-v1` channel) using keys derived from those
device keys. The directory, Link relay node, and browser gateway do not receive
device private keys. Session history and workspace files are read from the
owning online host on demand, rather than stored as a server-hosted backup.

The hosted services still process account IDs, device registrations, public
keys, and routing/relay metadata. The identity service processes sign-in; the
identity service and authenticated public-key directory remain part of the
trust boundary. Payload encryption does not mean that no data reaches an
operated service, nor does it protect a compromised endpoint.

Published Pages, Page data/functions, marketplaces, model-provider requests, and
messaging-bot traffic have separate data flows. Publishing a Page uploads its
content to the publishing service under the selected visibility rules. Do not
apply the device-control encryption claim to all OpenBitFun network traffic.

## Is the official Relay free? What are the quotas and SLA?

This repository documents technical resource controls, but does not publish a
pricing schedule, monthly traffic allowance, or service-level agreement (SLA).
Check current service announcements or ask the maintainers through the
[repository](https://github.com/GCWing/OpenBitFun) before relying on specific
commercial or availability terms. Open-source licensing does not establish
hosted-service terms.

The [resource-control table](README.md#public-service-resource-controls)
documents enforced device, connection, request, and payload limits. These are
technical limits, not a subscription quota or an unlimited-use promise; the
deployment and reverse proxy may enforce tighter limits. Historical 0.2.x
“Beta free” descriptions do not establish permanent free service or current
limits. Legacy anonymous pairing, password provisioning, and deployment-wizard
instructions do not describe the current account-based connection flow.

## What happens if a service or device is unavailable?

New sign-ins require the identity service. Remote control requires the target
host to be running and reachable over OpenBitFun Link (directly or via relay).
If the host is offline, its session history and files are unavailable. A
controller disconnect does not cancel work already running on the host, but the
host must stay running and tasks waiting for approval still need an answer.

Devices that are already signed in and on the same network can exchange traffic
directly over LAN P2P through OpenBitFun Link, but new sign-ins, browser
gateway sessions, and directory or Link-credential refreshes still depend on
the hosted services. Local work and independently configured SSH / Docker
access do not depend on account services. Reconnect and inspect the existing
task before submitting it again.

## What does self-hosting actually involve?

The public mode has a fixed official endpoint (`https://super.openbitfun.com`),
with no editable custom-server field or deployment wizard. Self-hosting 2.0
requires coordinated client endpoint changes, deploying the 2.0 services
(account directory, Link credential issuer, Link relay node, browser gateway,
and web controller), persistent storage, TLS and reverse-proxy configuration,
and ongoing backups, upgrades, monitoring, and capacity planning. If you also
operate identity, configure the supported login providers and their callbacks
or email delivery. A VPS alone does not complete this setup; there is no
universal monthly-cost estimate.

Start with the [fork guide](README.md#for-community-developers-and-forks),
[`deploy/super`](../../../deploy/super/README.md), and
[`deploy/easytier`](../../../deploy/easytier/README.md) (for legacy 1.x Relay
deployments only, see the [v1 deployment guide](../../../deploy/relay-v1/README.md)).
Changing server environment variables does not redirect already released clients.

## Implementation references

- [Unified client architecture (OpenBitFun Link & LAN sunset)](../../../docs/architecture/unified-client-architecture.md#mesh-only-lan-sunset-and-a-domain-only-server)
- [Official endpoint and account identities](../../crates/contracts/product-domains/src/account.rs)
- [Shared sign-in and older-client compatibility](../../crates/services/miniapp-market-service/README.md#邮箱验证码登录)
- [Desktop connection lifecycle](../desktop/README.md#remote-connect)
- [Device key derivation](../../crates/services/services-integrations/src/remote_connect/device_crypto.rs) and [Relay identity verification](../../crates/services/relay-service/src/identity.rs)
- [Remote workspace ownership](../../../docs/architecture/remote-workspace-transport.md#controller-and-runtime-ownership)
