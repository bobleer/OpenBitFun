[中文](AGENTS-CN.md) | **English**

# AGENTS.md

OpenBitFun 2.0 is a Rust workspace plus one shared NSH UI (`src/nsh-ui`), delivered through native desktop (`src/apps/desktop-nsh` over in-process `src/apps/desktop`), CLI/TUI (`src/apps/cli`), native mobile ([`src/apps/mobile-nsh`](src/apps/mobile-nsh/README.md), iOS/Android; legacy 1.x Kotlin/HarmonyOS apps live in [OpenBitFun-Mobile](https://github.com/openBitFun/OpenBitFun-Mobile)), browser (serving the device's NSH web bundle), and server (`src/apps/server`, `src/apps/relay-server`). There is no Tauri desktop runtime or WebView-hosted desktop UI.

Repository rule: **keep product logic platform-agnostic, then expose it through platform adapters**.

## Where rules live

- This file holds cross-cutting rules and stable repository entry points. The nearest `AGENTS.md` to the files you change owns local boundaries, crate tables, surface commands, and focused verification; if it conflicts with this file, the nearer guide wins.
- Keep `AGENTS.md` and `AGENTS-CN.md` in sync in the same change.
- Commit and PR conventions: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Layers

Dependencies point downward: a crate may depend on lower layers, not on higher ones, and same-layer dependencies stay minimal. Layer guides list their crates and exact allowed edges. Physical layout below; conceptual architecture (4+1 views) in [`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md).

| # | Layer | Path | Owns | Must not | Guide |
|---|---|---|---|---|---|
| 1 | Interfaces and entrypoints | `src/apps/*`, `src/nsh-ui`, `src/miniapp-market-web`, `tests/e2e`, `src/crates/interfaces` | Product hosts, commands, UI entrypoints, protocol interfaces, and cross-surface tests | Keep reusable behavior; move it down | nearest local `AGENTS.md`; [interfaces](src/crates/interfaces/AGENTS.md) |
| 2 | Product assembly | `src/crates/assembly` | Compatibility exports, product capability selection, product-full wiring, immutable built-in Agent content, adapter/service registration, and ecosystem-neutral source coordination | Implement concrete adapter, OS, or service details | [AGENTS.md](src/crates/assembly/AGENTS.md) |
| 3 | Adapters | `src/crates/adapters` | Protocol, transport, local IPC, WebDriver, AI-provider, and external AI work-source adapters; external-provider translation | Own product capability selection or reusable OS service behavior | [AGENTS.md](src/crates/adapters/AGENTS.md) |
| 4 | Services | `src/crates/services` | Reusable OS, filesystem, terminal, MCP, remote, git, watch, process, network, session persistence, and MiniApp runtime IO implementations | Own protocol/transport projection or product capability selection | [AGENTS.md](src/crates/services/AGENTS.md) |
| 5 | Execution primitives | `src/crates/execution` | Portable Agent Runtime, named-workflow policy, stream, plugin runtime client, typed-service, tool-contract, tool-group, and tool-execution building blocks | Own host-specific or delivery-profile behavior | [AGENTS.md](src/crates/execution/AGENTS.md) |
| 6 | Stable contracts and product domains | `src/crates/contracts` | Shared DTOs, event shapes, runtime ports, and product-domain contracts/policies | Carry runtime behavior or depend upward | [AGENTS.md](src/crates/contracts/AGENTS.md) |

- Product features only assemble user-facing commands, UI contributions, settings, and default policy. Long-running task, scheduler, permission, session/workspace, memory, DFX, hook, and event facts stay with their existing owners.
- External systems are boundary resources, not layers. Only registered adapters, services, or app-local providers call them; other code consumes ports and stable contracts.

## Frontend–backend separation and NSH discipline

OpenBitFun 2.0 adopted NSH to keep CPU, GPU, and memory usage low, maximize UI responsiveness, share one UI across desktop/mobile/browser, and make remote control "one more frontend" over the same OBP protocol. Architecture: [`docs/architecture/unified-client-architecture.md`](docs/architecture/unified-client-architecture.md), [`docs/architecture/nsh-frontend.md`](docs/architecture/nsh-frontend.md).

- **Strict frontend–backend separation (contract-only boundary)**:
  - The native desktop runner (`src/apps/desktop-nsh`) loads `src/apps/desktop` in-process through the C ABI (`backend_protocol::ffi`) for low latency and memory, not via Cargo coupling or shared internals.
  - `src/nsh-ui` reaches any backend only through `src/nsh-ui/src/bridge.ts` (`BackendConnection`: typed commands + cursor/seq-numbered event stream, identical locally and remotely) and local OS chrome only through `WindowShell` / `nsh/*` APIs. UI code must never touch the filesystem, processes, host environment, or backend internals directly, and UI source must never become a Rust compilation input.
  - Backend code must never manipulate UI widgets or assume an attached local window. Desktop-only host adapters live in `src/apps/desktop` behind typed capability interfaces; window, tray, notification, clipboard, and lifecycle actions travel over `host://shell-request` and refuse loudly when no shell provides them. Shared crates (`src/crates/*`) stay host-agnostic (e.g., `openbitfun_events::EventEmitter`).
- **Display-only frontend; backend owns state and logic**:
  - **Backend owns**: business rules, domain state, persistence, defaults, validation, capability/permission flags, sorting/filtering/counting/grouping projections, multi-step orchestration, file/git/link watchers, reconnect/retry loops, and heavy parsing. Expose ready-to-render view models and typed intents over OBP.
  - **Frontend owns only**: rendering, layout, native shell glue, animations, display formatting, per-frame stream coalescing, and ephemeral interaction state (unsaved drafts, selection, scroll, open/collapsed panels, drag geometry).
  - Never duplicate backend rules as client-side fallbacks (they drift across desktop, mobile, browser, CLI, and IM bots), and never put frame-rate-sensitive UI interactions behind synchronous backend round trips (remote latency makes them janky).
- **Rust-first for core logic and computation; TypeScript strictly for NSH UI**:
  - Implement all domain logic, state machines, protocol/transport/crypto, file/git/search/process IO, data projection, and CPU- or memory-intensive work in Rust backend crates (`src/crates/*`, `src/apps/desktop`, `src/apps/cli`), keeping heavy work off NSH's single-threaded JS runtime.
  - Reserve TypeScript in `src/nsh-ui` for declarative NSH TSX views, signal bindings, view-model rendering, and thin `BackendConnection` / `WindowShell` / `ControllerPort` adapters.
  - Keep NSH native Rust modules (`src/apps/desktop-nsh/native`, `src/apps/mobile-nsh/native`) thin OS/transport bridges only (FFI, native dialogs, keystore, Link controller). Never place product logic there, or native desktop, mobile, CLI, and browser (which cannot load native modules) will diverge.
- **Strict frontend asset and bundle budget**:
  - Assets under `src/nsh-ui/assets` are replicated into desktop packages, mobile packages, the embedded CLI web bundle, and browser remote downloads over Link/CAS — directly affecting install size, remote cold-start latency, and memory.
  - Prefer NSH native primitives, programmatic vectors (`<Canvas>` + `Path2D`), design tokens, and system fonts over adding static files (bitmaps, spritesheets, extra fonts, or vendored JS/CSS runtimes).
  - Never hide binary or large assets as base64/inline literals inside `.ts/.tsx` to avoid adding a file; that worsens JS parse time and heap usage.
  - Add a bundled asset or vendored renderer only when no native NSH or vector alternative exists; load it lazily on demand, minimize byte size, and keep one canonical source synced by script rather than duplicating copies across apps.
- **Protect the NSH render and memory budget**:
  - Read state through fine-grained signals in JSX (NSH components execute once), virtualize long lists (`<List>`), and load heavy payloads on demand (e.g., summarized tool outputs expanded per turn rather than retaining megabytes in UI memory).
  - Avoid spawning embedded `<WebView>`s when native NSH widgets suffice; always release timers, polls, and subscriptions with `cleanup()`.

## Commands

```bash
pnpm install
pnpm run desktop:dev               # primary dev loop: build and run the native NSH desktop app
pnpm run fmt:rs                    # run after Rust edits; formats only changed / staged .rs files
pnpm run check:repo-hygiene        # repository content and filename rules
pnpm run check:github-config       # GitHub workflow / configuration rules
pnpm run check:core-boundaries     # Cargo features, dependency direction, module ownership
```

Use `cargo fmt` only when broader formatting is intended. Surface, packaging, and focused test commands live in the nearest guide; full script registry: [`package.json`](package.json).

## Verification

Verify at the owner, not with a repository-wide matrix:

1. Run the narrowest command from the nearest `AGENTS.md` covering the changed behavior.
2. Prefer one package, one test target or module filter, and the minimum feature set. Do not use `product-full`, `all-features`, or a workspace-wide suite as a shortcut.
3. Run a repository check only when its contract changed (`check:repo-hygiene`, `check:github-config`, `check:core-boundaries`).
4. Leave broad builds, workspace suites, packaging, and platform matrices to CI unless the change affects those paths or reproduces a CI failure.

## Rules for every change

### Bug fixes

Before changing code for a bug, check only the relevant local code and local Git history for an existing fix, using the reported version and reproduction conditions when available. State the result before starting. If a fix already exists, cite the code or commit instead of duplicating it.

### Backend commands

Command names are `snake_case` and take one structured `request`. Register them in `backend_commands!` (`src/apps/desktop/src/lib.rs`), mark the handler `// @backend-command`, run `pnpm run desktop-nsh:generate-dispatch`, and add a Product Operation Registry row (see [Remote scenarios](#remote-scenarios)). TypeScript wrappers may be `camelCase`.

```rust
// @backend-command
pub async fn your_command(
    state: State<'_, AppState>,
    request: YourRequest,
) -> Result<YourResponse, String>
```

```ts
await invokeCommand('your_command', { ... }); // sends { request: { ... } }
```

### Non-interactive child processes

- Any non-interactive child process that may run under a GUI, headless, background, or redirected host (including CLI modes invoked by another host) must not use bare `std::process::Command` or `tokio::process::Command`. Use `openbitfun_services_core::process_manager::{create_command, create_tokio_command}` or the existing facade for that layer.
- If a direct command is unavoidable, Windows code applies `CREATE_NO_WINDOW` explicitly and Node child processes set `windowsHide: true`.
- Test fixtures follow the same policy so tests never flash console windows.

### Rust dependencies

- `[workspace.dependencies]` owns compatible versions, not broad capability unions. Each crate selects only the features it uses, keeps test-only features in `[dev-dependencies]`, and attaches feature-gated service capabilities to the owning crate feature.
- Disable third-party defaults in `[workspace.dependencies]` when they are not part of every consumer's contract; members add only the slices they need.
- For internal crates whose guarded `default` is empty, do not repeat `default-features = false` on every edge. Narrow consumers of an intentional compatibility default (such as ACP) still disable it explicitly.
- Standalone Docker manifests keep explicit versions and default policy because they cannot inherit the workspace root.
- `tokio/full` is forbidden in the root workspace and in workspace members.
- Details: [`docs/architecture/rust-build-dependency-boundaries.md`](docs/architecture/rust-build-dependency-boundaries.md). Verify manifest changes with `pnpm run check:core-boundaries`.

### Logging

Logs are English-only, with no emojis. Frontend (`src/nsh-ui`): [guide](src/nsh-ui/AGENTS.md). Backend: [`src/crates/LOGGING.md`](src/crates/LOGGING.md).

### Internationalization

- `src/shared/i18n/contract/locales.json` owns locale ids, aliases, fallback rules, and surface defaults. Run `pnpm run i18n:generate` after editing it.
- Shared stable labels live in `src/shared/i18n/resources/shared/<locale>/terms.json`; workflow copy stays in the owning surface.
- No surface imports another surface's locale catalog; static self-contained pages use generated page-scoped shared-term files.
- Format user-visible dates, times, and numbers with the shared i18n helpers, not direct `Intl.*` or `toLocale*` calls.
- Run `pnpm run i18n:audit` after changing locale resources or user-visible copy (enforces key/placeholder parity and zero-growth baselines).
- Details: [`docs/architecture/i18n.md`](docs/architecture/i18n.md).

### Theme and color tokens

- Theme and color-token baselines (`scripts/theme-color-governance-baseline*.json`) are ratchet contracts, not editable test expectations. Never fix a failing audit by raising baseline values, loosening counts, adding broad allowlists, or removing CI audit coverage.
- Lower a baseline when measured debt is removed. If a change genuinely needs a new color or key, add the smallest owner contract and document why existing semantic, component, or specialized-domain tokens cannot cover it.
- Run `pnpm run theme:color-audit:all` after changing design tokens, NSH theme projections, web surfaces, MiniApp appearance, or CLI/TUI colors.
- Details: [`docs/architecture/theme-token-optimization.md`](docs/architecture/theme-token-optimization.md).

### Agent loop

Do not add hard-coded limits or pattern checks to the agent loop as a first response to looping behavior (such as blocking repeated tool calls by string or count alone); that turns the loop into a brittle workflow engine. Investigate the root cause first: tool behavior, model interaction, session context packaging, prompt/tool schema design, or state synchronization.

### Docs and process artifacts

- Do not add or update files under `docs/superpowers/**`; `pnpm run check:repo-hygiene` rejects them.
- Keep temporary planning, design, and implementation-process artifacts local. Merge durable architecture or feature facts into existing owning docs, and put user-facing guidance in the owning app README.

## Remote scenarios

The workspace, the executing runtime, and the user driving it can each sit on different machines. Treat all four scenarios below as first-class targets of every change, not later ports.

Product model: OpenBitFun is a distributed Agent runtime with one display-and-control surface.
- **Runtime nodes** (desktop and CLI) run an Agent runtime, execute work, and act as symmetric fleet entries.
- **Frontend-only clients** (browser, NSH phone app, IM bots) own no runtime and operate any runtime of the account through one fleet entry; which device executes is a label, never a mode.
- **Cloud superagent** (`openbitfun-superagent`) is a control-plane node with no workspace runtime (UI entry currently gated off by default in `src/nsh-ui/src/productGates.ts`; per-device `superagent.acceptDispatch` and `superagent.allowAutoApproval` control dispatch/auto-approval). The OpenBitFun server is reachable only through its domain over HTTPS.

| Scenario | Meaning | Design entry point |
|---|---|---|
| Remote workspace | Workspace lives on an SSH host, jump-host chain, or Docker container; files, terminal, search, and Agent subprocesses execute there | [remote-workspace-transport.md](docs/architecture/remote-workspace-transport.md), [remote-workspaces.md](docs/features/remote-workspaces.md) |
| Remote control | Frontend-only client operates all runtimes via one auto-selected/failover fleet entry: phone over OpenBitFun Link, browser via HTTPS gateway (`/app/`, E2E-encrypted, running the device's web UI bundle), IM bots via OBP over Link (`mesh_route`, no relay fallback) | [unified-client-architecture.md](docs/architecture/unified-client-architecture.md), `remote_connect` in [services-integrations](src/crates/services/services-integrations/AGENTS.md) |
| Fleet / device context | Commands travel as `fleet_call {target, command, args}` to the owning device, while window chrome, updater, account identity, and local OS automation stay on the controller | [unified-client-architecture.md](docs/architecture/unified-client-architecture.md#fleet-every-runtime-of-the-account-in-one-surface), [peer-device-mode.md](docs/architecture/peer-device-mode.md) |
| Detached Dispatch | A controller (desktop, CLI, or cloud superagent) submits a durable job to another host and may disconnect; the target owns job, session, worktree, event log, and permission mailbox | [detached-task-dispatch.md](docs/architecture/detached-task-dispatch.md) |

Rules for all four:

- **Design the remote path with the feature.** A capability assuming UI, process, and filesystem share one machine is incomplete.
- **Degrade loudly.** Gate unsupported entries or return a clear unsupported state; silent local fallback, fake success, empty payloads, and generic errors are regressions and can leak local data to a remote controller.
- **Keep blocking interactions remotely answerable.** Permission prompts, dialogs, and pickers must go through the existing dialog / permission-mailbox orchestration so remote control and dispatch jobs never deadlock.
- **Survive disconnect.** Prefer resumable cursors and idempotent mutations over state that exists only while a client stays attached.
- **Remote workspace paths are POSIX on every client OS.** Never split/join them with host `std::path`, and never reuse controller-side paths on a peer host.

Per-scenario obligations:

- **Remote workspace**: every registered backend command has exactly one row in the Product Operation Registry ([`remote_surface/table.rs`](src/crates/contracts/product-domains/src/remote_surface/table.rs)). New rows may not use `Unaudited`; removed commands keep a `retired(...)` row. Run `pnpm run capabilities:generate` after editing. See [remote-surface-contract.md](docs/architecture/remote-surface-contract.md).
- **Fleet & device routing**: forwarded commands carrying a session, workspace, or terminal id need a `ByOwner` row in [`remote_surface/fleet_routing.rs`](src/crates/contracts/product-domains/src/remote_surface/fleet_routing.rs) (checked by `pnpm run desktop-nsh:check-dispatch`). Commands that must stay local declare `ControllerLocal` in the registry row; desktop peer host, CLI peer host, and `src/nsh-ui/src/generated/peerSurface.ts` derive their deny sets from it (`pnpm run check:core-boundaries` rejects hand-written tables). CLI-handled commands require a handler plus `cli_peer: HANDLED` (checked by `src/apps/cli/src/peer_host/commands/mod.rs`). Read [peer-device-mode.md](docs/architecture/peer-device-mode.md) before changing session, account, or hydrate paths.
- **Remote control (IM bots)**: bots reach sessions via `RemoteCommand` (`obp_remote_command` over Link) and the bot router/menu. When adding or moving session-level capabilities, extend those surfaces or return an explicit unsupported reply.
- **Detached Dispatch**: jobs run headless under the CLI delivery profile with no interactive host or live submitter. Negotiate new target requirements via typed capabilities instead of assuming them.

State which remote scenarios a change was exercised in; local-only tests are not evidence of remote behavior.

## Upgrade compatibility

Users upgrade in place, and remote scenarios routinely pair different 2.0 builds on one connection. Keep existing installs working without manual repair.

OpenBitFun 2.0 is compatible with 1.x for **persisted session records and config** only (sessions, transcripts, workspaces, connection profiles, settings). Frontends, remote control, peers, and accounts do not interoperate with 1.x and use no 1.x relay (`remote.openbitfun.com/relay`, `mobile-web`). Cross-version rules below apply between 2.0 builds:

- **Tolerant persisted shapes**: add fields with defaults, deserialize tolerantly, never repurpose/narrow existing on-disk fields, and never make required a field old data cannot supply.
- **Never delete or reset user data to recover from parse/network failures**: keep the record, degrade the feature, and surface a clear state. Destructive removal stays an explicit user action.
- **Negotiate capabilities across versions**: advertise and check capabilities before using them (version equality is not proof of behavior), keeping older peers on a working path.
- **A rename is a migration**: keep reading the old name/id/shape until no supported peer can send it, and migrate referenced data (vault entries, workspace pointers) together.
- **Prove it with tests**: cover legacy deserialization and old-payload round trips, not just data written by current code.

## Read before changing

Read the listed documents before editing in these areas; sub-bullets are hard constraints.

- **`openbitfun-core` decomposition, feature/dependency boundaries, Rust build speed**: [`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md), [`docs/architecture/rust-build-dependency-boundaries.md`](docs/architecture/rust-build-dependency-boundaries.md).
  - Do not confuse DTO/contract extraction with runtime owner migration; moving runtime ownership requires a reviewed port/provider design, old-path compatibility, equivalence tests, and explicit confirmation if behavior boundaries change.
- **Agent Runtime deployment, multi-host/shared Session control, process topology**: [`docs/architecture/agent-runtime-deployment-design.md`](docs/architecture/agent-runtime-deployment-design.md).
  - Do not key Rust Runtime or Node/Bun Plugin Host processes by client, workspace, session, or plugin by default; base topology on state ownership, execution/security boundaries, and measured capacity.
- **CLI/TUI parity, non-interactive output contracts, external config imports, branded CLI**: [`docs/architecture/cli-product-line-design.md`](docs/architecture/cli-product-line-design.md), [`src/apps/cli/AGENTS.md`](src/apps/cli/AGENTS.md).
- **HarmonyOS PC CLI/TUI**: [`docs/architecture/platform-portability-design.md`](docs/architecture/platform-portability-design.md) — future target only (real PC terminal; HAP, `hdc shell`, mobile app, and remote execution are not substitutes).
- **Product definitions, branded distributions, customization build tasks**: [`docs/architecture/product-customization-blueprint.md`](docs/architecture/product-customization-blueprint.md).
  - Keep product customization separate from user runtime configuration and plugins; GUI and TUI share stable product facts only, not layout, component, theme-key, keybinding, or renderer schemas. Assembly results carry only small immutable identity/isolation/recovery/legal IDs, never dynamic plugin state.
- **OpenCode live configuration or plugin execution**: [`docs/architecture/extensions/opencode-extension-compatibility.md`](docs/architecture/extensions/opencode-extension-compatibility.md), [`src/crates/adapters/opencode-adapter/AGENTS.md`](src/crates/adapters/opencode-adapter/AGENTS.md).
  - Do not treat compatibility targets as implemented capabilities or extend the legacy P0 static-preview managed-package path.
- **Agent hooks**: [`docs/features/agent-hooks.md`](docs/features/agent-hooks.md) ([中文](docs/features/agent-hooks.zh-CN.md)); engine/dispatch ownership in [`agent-runtime`](src/crates/execution/agent-runtime/AGENTS.md) and [`core`](src/crates/assembly/core/AGENTS.md).
  - Native user hooks follow the Codex hook contract (<https://learn.chatgpt.com/docs/hooks>); do not fork it, and update the deviations table whenever a deviation changes.
- **SDLC harness (lifecycle evidence, gates, Artifact Graph, Project Profile, Deep Review, target-project governance)**: [`docs/sdlc-harness/README.md`](docs/sdlc-harness/README.md), [`docs/sdlc-harness/design.md`](docs/sdlc-harness/design.md).
  - Never hard-code OpenBitFun repository assumptions as target-project rules; keep quality protection target-aware, evidence-backed, risk-tiered, cost-aware, and auditable.
