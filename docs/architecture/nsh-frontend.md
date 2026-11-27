# NSH frontend

`src/nsh-ui` is the OpenBitFun desktop UI. It is a Native Shell (NSH) app built as a
12-scene **Personal Agent Studio** (`Home`, `Sessions`, `Assistants`, `Agents`,
`Skills`, `Routines`, `Files`, `Git`, `Terminal`, `Spaces`, `Devices`, and
`Settings`). The same TSX code renders the native desktop app
(`src/apps/desktop-nsh`: AppKit, Win32, GTK runners with the backend library loaded
in-process) and, as the NSH web target, browsers and phones that connect to a
backend over OBP. Architecture owner: [unified-client-architecture.md](unified-client-architecture.md).

The React desktop UI (`src/web-ui`) and the Tauri desktop shell were retired
(wave 4 sunset); this document's history sections below still mention the Tauri
window the NSH web target ran in during the migration.

## Current shape

- **Native desktop.** `src/apps/desktop-nsh/App.tsx` installs the in-process
  connection (`src/jsonWireConnection.ts` over the `openbitfun/native` module) and
  the native window shell (`src/nshDesktopShell.ts`), then mounts this app.
  Windows and Linux builds enter through `BundledFontsApp.tsx` to register the
  bundled HarmonyOS Sans fonts before mount. The UI uses the SC face for Simplified
  Chinese, the base face for English and system fonts for Traditional Chinese.
  That entry also registers Fira Code (400/500/600), retained from the former React
  UI. Code blocks, inline code, editors and terminals share the mono stack: Latin
  uses Fira Code, and missing glyphs follow the active locale's UI font. Cached
  widget styles include that family so changing the display language updates code too.
- **Browser / phone.** `servedBackend.ts` installs `webSocketConnection.ts` when the
  page was served by a backend's OBP listener (`#nsh-params`).
- **Other devices.** Every 2.0 backend is a fleet entry: the bridge sends each
  command as `fleet_call` to its owner device, and registry `ControllerLocal`
  commands stay plain (`src/generated/peerSurface.ts`). The 1.x Peer Device Mode
  (relay HostInvoke and the non-fleet mesh path) was removed in 2.0
  ([peer-device-mode.md](peer-device-mode.md)).
- **Page host (`host.js`).** The legacy page-host wire (`tauri` transport when a
  host page exposes `window.__TAURI__`, `dev` fixtures otherwise) remains for
  `nsh run --target web` development and the headless tests; nothing ships it as
  the desktop transport.
- Capabilities without an NSH implementation degrade loudly: browser screenshots,
  and in-place updates on Windows/Linux.
- Spaces everywhere (wave 22): a Space opens inside the app on every client
  (`src/ui/miniAppFrame.tsx`, Library › Spaces). Its document runs in a `WebView`
  (an iframe on the web target) and `src/spaceFrame.ts` speaks the MiniApp Shell
  protocol to the Space's device over the proxied `miniapp_inline` command, so the
  worker, storage, versions, drafts and grants stay on that device and a remote
  workspace grant is refused. Desktop keeps "Open in window" (the sidecar Shell).
  Dialogs and the Shell's chat composer need that window and are refused inline.
  The agent's MiniApp surface attaches on a desktop over its own backend and
  relays through the in-product view's Shell bridge (observe/act/key; DOM and
  pixel actions report the capability gap). The account's Space list comes from
  `miniapp_account_catalog` (per-device install records in the account replica,
  collection `miniapps.installs`); packages stay in each device's MiniApp store.
  Library › Spaces has "Apps | Cards | Market | Submissions"; there is no
  "Published" tab because 2.0 keeps no Pages on the server.
- Desktop presence (wave 22): desktop cards and the companion pet are floating
  NSH windows of the desktop app (`src/desktopPresence.tsx`, started by
  `nshDesktopShell.ts`; `"windows"` capability). The cards are backend facts of
  the device that made them (`src/apps/desktop/src/desktop_cards`: definitions
  behind `CardDefinitionStore` in `cards.json`, window geometry and visibility in
  `local-state.json`); every client lists them inline (Library › Spaces, the
  OpenBitFun page on phones and browsers) through the proxied `desktop_card_*`
  commands. The pet animates the fleet's attention (`fleet_attention`) with the
  built-in sprite sets in the backend's resources (`builtin:<id>` paths); a
  press opens the Inbox. Phones and browsers show the Pet page as "Desktop only".

## Transport

The NSH engine runs in its own JavaScript realm inside the page, so it cannot see
`window.__TAURI__`. `host.js` is the page-side host module NSH loads
(`nsh.json` → `web.host`), and it is the only code that touches the desktop IPC:

| App side (`src/bridge.ts`) | Host function | Desktop |
|---|---|---|
| `invokeCommand(action, request)` | `openbitfun.invoke` → `core.invoke(action, { request })` | one Tauri command |
| `invokeRawCommand(action, params)` | `openbitfun.invoke` with `raw` → `core.invoke(action, params)` | commands with positional arguments (`account_*`, `remote_connect_*`) |
| `listenEvent(event, cb)` | `openbitfun.listen` → `event.listen(event)` then `player.hostEvent("openbitfun.event")` | backend events |

`host.js` answers from fixtures when `window.__TAURI__` is absent, so the shell
runs in a plain browser during `nsh run --target web` and under `nsh test`
without the desktop binary. `transportKind()` reads `tauri`, `dev` or `native`;
it is no longer drawn in the chrome, so check it from a scene or the logs.

Request shapes follow the backend command signatures (the wire the retired React
UI also used), mixed casing included:
sessions use `workspace_id`, workspace and file commands use `workspaceId`, and
positional commands use Tauri v2's default camelCase wire names — e.g.
`account_delete_device` takes `targetDeviceId`, and
`terminal_get_history` / `save_mcp_json_config` pass camelCase positional args
unwrapped via `invokeRawCommand` directly to `core.invoke`.

On a fleet entry a command goes to the device that owns it (`fleet_call`); the
commands that stay on this machine — account, window, updater — are read from
`src/nsh-ui/src/generated/peerSurface.ts`, a projection of the Product Operation
Registry, so the UI and every host agree on which command is controller-local.

## Backend connection and window shell

The table above is the legacy page host. `src/bridge.ts` no longer talks to
`host` itself; two things are injected before the app mounts:

- A **backend connection** (`src/backendConnection.ts`): `invoke(command, args)`
  where `args` is exactly the Tauri args object (`{ request }` or the positional
  arguments), `subscribe(onEvents)` for seq-numbered event batches, `ready()`,
  and a connection state (`connecting` / `connected` / `reconnecting` /
  `failed`, drawn as a banner when it is not answering). The default is the page
  host (`src/hostPageConnection.ts`, which keeps the `{ action, request }` /
  `{ action, raw }` envelopes above); the native desktop installs a JSON-string
  wire (`src/jsonWireConnection.ts`) over the in-process `openbitfun/native`
  module, and browsers/phones use the OBP WebSocket connection
  (`src/webSocketConnection.ts`) with the same interface: every client is the
  same UI over one protocol.
- A **window shell** (`src/windowShell.ts`): the window, title bar, application
  menu, tray, OS notifications and the local folder picker — the client's own
  machine, never the backend's. The default (`host.js` page host) is for
  development and tests; `src/nshDesktopShell.ts`
  drives a native NSH window with `nsh/desktop` (system traffic lights in a
  hidden title bar, `desktop={{ windowDrag }}` regions, `Menu` with the editing
  roles so text fields get Command-C / Command-V, `Tray`, `Notifications`,
  `Application.quit`).

Fleet routing lives in `src/peerRouting.ts` and is applied by the bridge over
any connection. `agentic://text-chunk` is merged per frame by
`host.js` for the page host and by `src/textChunkCoalescer.ts` for every other
wire, with the same algorithm (a test holds the two to the same output).

The native desktop app is `src/apps/desktop-nsh` (`nsh.json`, `App.tsx` that
installs the native connection and shell and then imports this app); its Rust
side is the `native/` crate (`openbitfun/native`) and the `openbitfun-nsh`
runner that loads the backend library (`libopenbitfun_desktop_lib`) into the same
process.

## Rendering model notes

- NSH components run once. State lives in signals (`src/state.ts`), and JSX reads
  them; there is no re-render and no virtual DOM.
- `<If>` and `<Each>` are globals; `<List>` virtualizes and recycles rows.
- `nsh/base` supplies the heavy widgets this product needs: `Tree`, `TextView`
  (Markdown, streaming), `Editor`, `DiffView`, `Terminal`, `DataTable`, `Input`.
- The app owns its look: `src/theme.ts` holds the palette as a `computed` signal
  (dark and light), so a scheme change repaints every binding that reads it. NSH
  provides primitives and an unstyled base layer, not a styled product library.
- Default light and dark colors, semantic typography, spacing, and control
  sizes come from the design-system token sources in `design-system/packages`.
  After changing a shared token, run `node scripts/generate-nsh-design-tokens.mjs`.
  The frontend color audit checks the generated NSH projection. The native
  desktop entry registers the bundled HarmonyOS Sans families before mounting.
- The shared desktop modal, dropdown menu, and Select use the design system's
  sizing, insets, and surfaces. Menus opened at a trigger or pointer use the same
  keyboard navigation and in-place confirmation. Escape cancels an in-place
  confirmation before dismissing the menu. Form dialogs protect unsaved input.
- Text and search fields, Select triggers, and switches use the shared form
  colors and control dimensions. Checkboxes and radio marks share their paint
  across conversation questions, generated forms, review, and working-copy rows.
- The global search dialog and Git use the shared toolbar, with the same
  separator also used in Terminal. Search and Files use the shared tab group.
- Primary sessions, split sessions, and side questions use the same native
  `src/ui/ChatComposer.tsx` layout. It takes `main`'s composer dimensions from
  the shared tokens and keeps the editor mounted as the actions move between
  the single-line and expanded layouts. New sessions, drafts with attachments,
  and drafts that wrap open expanded. Touch layouts keep the larger hit targets.
- The canvas reserves the top-bar row when the desktop shell reports trailing
  native window controls. Scene toolbars then start below the system caption,
  including when the sidebar is docked.
- Transcript tools use the shared `ToolCardFrame` for ambient rows and
  prominent cards, with the same geometry and semantic colors as the design
  system. Prominent actions and approval states remain visible between folded
  activity groups. Opening a shortened result still reads its turn from the
  original runtime. Deferred calls display their effective tool in both the
  live and persisted transcript. Inline diffs fit their rendered rows within a
  bounded scrolling viewport.

## Personal Agent Studio design system and UX architecture

The NSH frontend carried over the retired React UI's **OpenBitFun 5-Plane Desktop
Shell**, motion system, Layer-4 overlays, and Remote SSH capabilities across
all 12 scenes:

1. **5-Plane Surface Hierarchy & 9 Built-In Appearances (`src/theme.ts`), Motion (`src/ui/motion.tsx`), Overlays (`src/ui/overlays.tsx`), Icons (`src/ui/icons.tsx`), and Primitives (`src/ui/primitives.tsx`)**:
   - **5-Plane Elevation & 9 Built-In `APPEARANCE_PRESETS`**: separates `NavPanel`
     chrome tokens (`chromeBg`, `chromeText`, `chromeTextMuted`, `chromeHover`,
     `chromeActive`, `chromeBorder`, `chromeInputBg`, `chromeAccent`) from inset
     `SceneSurface` tokens (`canvas`, `canvasSubtle`, `panelRaised`,
     `surfaceElevated`, `popoverBg`, `inputBg`, `shadowScene`, semantic badges)
     across all 9 built-in appearances (`Dark`, `Light`, `Monochrome`, `Slate`,
     `Midnight`, `Ink & Paper`, `Night Ink`, `Cyber`, `Tokyo Night`) via
     `selectAppearancePreset`. Separating `chrome*` tokens keeps split themes
     like `Monochrome` (dark `#1c1c1f` `NavPanel` paired with `#ffffff`
     `SceneSurface`) legible across active rows. Every `fontSize` scales via
     `textSize(base)`.
   - `src/ui/motion.tsx` provides `animateLayout`, `enterMotion`, `Spinner`, and
     `<SceneTransition>` (`<ShaderTransition>` with `fallback="fade"`).
   - `src/ui/overlays.tsx` provides centered `ModalDialog` (`ModalHeader`,
     bounded `ModalBody` `<Scroll>` `maxHeight: 540`, `ModalFooter` inside a
     full-bleed `<Overlay>`), anchored `DropdownMenu`, `ContextMenuOverlay`,
     searchable `SelectDropdown`, and `ToastHost` / `pushToast`. A focused
     select opens with the arrow keys, jumps to the first or last available
     choice with Home or End, and matches an option by its initial letter. The
     popup exposes a listbox and its highlighted option. With a filter open,
     Home, End and text editing stay in the field, and Return picks a match.
   - `src/ui/icons.tsx` and `src/ui/primitives.tsx` supply native `<Canvas>` +
     `Path2D` icons, 5-variant `BotCharacter` faces, and Tauri controls
     (`Button`, `IconButton`, `ConfigSection`, `ConfigRow`, `Badge`, `KbdHint`,
     `SplitHandle`, `SegmentedTabs`, `ToggleSwitch`, `SectionCard`,
     `StatusDot`, `StatusPill`, `AgentAvatar`, `TapOptionRow`,
     `InlineConfirmBar`, `EmptyStateCard`), avoiding `nsh/base`'s `Switch`,
     `Select`, and `AlertDialog` and explicitly setting `color: palette().text`
     on `<Input>` and `itemStyle` on `<Tree>`.
2. **Collapsible + Resizable `NavPanel`, `SceneTopBar`, `SceneBar`, & Right `AuxPane` (`App.tsx`, `state.ts`)**:
   - Left `NavPanel` (`drawerOpen()` + draggable `SplitHandle`) houses history
     navigation (`Back`/`Forward`), `Search everything… ⌘K`, primary links
     (`Home`, `Sessions`, `Assistants`), collapsible `STUDIO & WORKBENCH`
     (`Agents`, `Skills`, `Routines`, `Spaces`, `Files`, `Git`, `Terminal`),
     unified `Workspaces` + grouped/flat `Sessions` + `SSH HOSTS` tree,
     `SettingsNavBlock`, and persistent footer (`Devices`, `Settings`, Appearance
     preset picker, Remote/SSH menu, and `{transportKind()}` indicator).
   - `SceneTopBar` + `SceneBar` manage open scene tabs, active workspace pill /
     port-forwarding badge, and `AuxPane` workbench toggles (`Files`, `Git`,
     `Terminal`) flanking the inset rounded `SceneSurface`. `AuxPane` supports
     side swapping, maximize/restore, and compact layouts (`compact?: boolean`)
     for `FilesScene`, `GitScene`, and `TerminalScene`. Global `keymap.bind`
     wires `mod+k`, `mod+b`, `mod+j`, `mod+,`, and `mod+n`.
3. **FlowChat Progressive Disclosure, OpenBitFun, & Spaces (`SessionsScene.tsx`, `OpenBitFunScene.tsx`, `AssistantsScene.tsx`, `SpacesScene.tsx`)**:
   - `ConversationHeader` offers transcript search (`transcript-search-toggle`),
     copy, `AuxPane` toggle (`aux-pane-toggle`), and `thread-actions-trigger`
     `DropdownMenu` (`New session`, `Open tabs` switcher, `Rename`,
     `Duplicate`, `Fork`, `Archive`/`Restore`, `Delete`).
   - Empty threads show the Welcome Studio (`BotCharacter`, `"How can I help
     today?"`, 2×2 starter cards); active transcripts render progressive
     disclosure (`THINKING` collapse, `ToolCard` items with `AuxPane` file links,
     checklists, unified `DiffView`, `TextView` Markdown, `TapOptionRow` user
     questions), and the 3-band `ChatInput` dock (`Agent` / `Model` / `Reasoning`
     anchored `<Overlay>` popovers, `Attach`, `Reference` / `@`, `Actions`,
     `Send` / `Steer` / `Queue` / `Stop`).
   - `OpenBitFunScene` (wave 15) replaced the Personal Hub Home: one composer
     to the cloud OpenBitFun agent (no device picker), the backend's suggestions
     and Working now, and the conversation with live job cards
     (`src/superagentStore.ts`, `src/ui/jobs.tsx`). The usage totals, heatmap and
     AI Insights stay in `src/homeStore.ts` for Settings › Account › Activity.
4. **Remote SSH, Capabilities, Workbench & Settings (`SshWorkspaceModals.tsx`, `AgentsScene.tsx`, `SkillsScene.tsx`, `RoutinesScene.tsx`, `FilesScene.tsx`, `GitScene.tsx`, `TerminalScene.tsx`, `deviceActions.tsx` (a device's ⋯ in the session tree) + `AccountDevicesPage.tsx`, `SettingsScene.tsx`)**:
   - `SshWorkspaceModals` mounts `NewWorkspaceModal` (Assistant vs Local/SSH/Docker/WSL
     Project), `SshConnectionModal` (`~/.ssh/config` import, hop test stages,
     Docker/WSL, saved profiles), `SshAuthPromptModal`,
     `RemoteFileBrowserModal` (POSIX navigation, mkdir, rename, delete, rebind),
     and `PortForwardModal` (listening port scan + forward rules).
   - `AgentsScene` & `SkillsScene` use `ModalDialog` builders and `DropdownMenu`
     overflow actions; `RoutinesScene` pairs a 24 h feed with an interactive
     Mon–Sun calendar; `FilesScene` stacks vertically in compact `AuxPane` mode
     with open-file tabs; `GitScene` supports Working Copy Discard (`git_reset_files`
     + `delete_file`), Worktrees tab (`git_list_worktrees`, `git_add_worktree`,
     `git_remove_worktree`), and 2-row compact `AuxPane` tabs; `SettingsScene`
     binds its categories to `App.tsx`'s `NavPanel` (`nav-settings-cat-*`) and
     adds live URL projection, `/models` discovery (`list_ai_models_by_config`),
     `test_ai_config_connection`, AI subscriptions & quotas, and 9 appearances.

## Parity matrix

Status: **ported** means the scene calls the same host commands as the React
surface for that feature; **partial** means the scene exists with a subset of the
feature's states; **not started** means the React surface still owns it;
**blocked by the widget** means the NSH component cannot report the event the
feature is built on, and **blocked by the surface** means the product operation
is not scriptable or needs assets this surface does not have, so those rows say
what the surface does show instead of claiming a behavior it does not have.

### Home

| Feature point | React owner | NSH status |
|---|---|---|
| Hero Launchpad and quick prompt | `scenes/personal-overview`, `scenes/profile` | replaced (wave 15: the OpenBitFun conversation, `OpenBitFunScene` + `src/superagentStore.ts`; one composer to the cloud agent instead of a local quick prompt) |
| Overview layout | `scenes/personal-overview` (`PersonalOverviewScene.scss`, config-page frame) | replaced (wave 15: the activity totals and heatmap move to Settings › Account › Activity, read by `loadAccountActivity` in `src/homeStore.ts`; the KPI tiles and "Your studio" list are retired) |
| Account identity and sign-in | `AccountIdentityAPI`, `RemoteConnectAPI` | ported: in-app email code (`account_email_start`, `account_email_verify`), GitHub in the browser as the secondary option (`account_github_start` + `openUrl`, `account_github_poll`), `account_status`, `account_logout`; every surface shows the backend's identity projection (`account_identity`, `AccountIdentityView`: the email or the GitHub login). Controller-local; `account_github_info` is retired |
| Live Attention & Activity Feed | `flow_chat`, `scenes/cron` | ported (aggregates `pendingPermissions()`, active `runningTurns()`, and routines due within 24 h from `list_cron_jobs` with one-click jumps to `Sessions` or `Routines`) |
| Ecosystem Grid, 6-month Heatmap & SSH Pulse | `NavPanel`, `UsageStatistics` | ported (5-metric telemetry bar, 27-week `<Canvas>` 6-month activity heatmap via `get_token_usage_statistics` `custom`, cards for `Assistants`, `Agents`, `Workspace & Remote SSH`, `Skills`, `Routines`, and `Spaces`; each pulse call fails independently so older hosts degrade gracefully) |
| AI Insights Studio | `scenes/insights`, `insightsApi` | ported (`get_latest_insights`, `load_insights_report` opening Markdown `<ModalDialog>` with `TextView`, `generate_insights`, `cancel_insights_generation`; controller-local) |

### Sessions

| Feature point | React owner | NSH status |
|---|---|---|
| Session goal, side questions, background commands, MCP prompts and MCP App panels (wave 22) | `flow_chat/components/thread-goal`, `btw`, `background-command`, `tool-cards/MCPToolDisplay` | ported (`src/ui/sessionExtras.tsx` over one store each: `goalStore.ts` reads `get_session_thread_goal`, sets it with `activate_session_goal` (the `/goal <objective>` path, also typed in the composer), edits, pauses and clears it, and follows `agentic://thread-goal-updated`; `btwStore.ts` asks `btw_ask_stream` under a child session id it names and draws that child's `agentic://text-chunk` stream in a sheet, never in the transcript, with `btw_cancel`; `backgroundCommandsStore.ts` lists `list_background_command_activities`, pages `read_background_command_output` by cursor while its sheet is open, and sends `send_background_command_input` / `control_background_command`; `mcpPromptsStore.ts` lists the running servers' `list_mcp_prompts` under a typed `/` and puts `get_mcp_prompt`'s text in the composer; `mcpAppStore.ts` opens a finished MCP tool's `ui://` resource (`get_tool_info` + `get_mcp_tool_ui_uri`, `fetch_mcp_app_resource`) in a web view and pipes its JSON-RPC to `send_mcp_app_message`. Every call goes to the session's device) |
| Slash command sources | `flow_chat/components/ChatInput.tsx` | ported for the main and split session composers. Both panes use the same picker, keyboard navigation and source review. Command and skill reads follow each pane's session owner. MCP arguments fill the originating draft, Review leaves a result card in the originating pane on capable hosts, and side-question follow-ups keep their parent session. The runtime provides collision candidates and saves the choice. Expansion uses the candidate and content version, plus the host conflict key and revision when required. Shell expansion needs explicit approval of the host plan. The runtime receives the expanded prompt and the transcript shows the original invocation. Fresh external Agents start through a typed idle turn request. A fleet controller routes to the session owner, and SSH workspaces retain literal input handling for external commands. |
| Personal Agent Welcome Studio | `flow_chat` empty state | ported (renders `"How can I help today?"` with `BotCharacter` and 4 `TapOptionRow` starter options on empty or zero-session views, populating `composerText` without auto-sending) |
| Workspace list and switching | `NavPanel/sections/workspaces` | ported (`NavPanel` Workspaces/Sessions/`SSH HOSTS` tree + `NewWorkspaceModal` / `SshConnectionModal`: `get_opened_workspaces`, `get_recent_workspaces`, `set_active_workspace`, `close_workspace`, and `open_workspace` / `open_remote_workspace`) |
| Session catalog with paging | `sections/sessions` | ported (`list_persisted_sessions_page` + cursor "Load older sessions") |
| Session row actions (rename, archive, delete, fork, copy) | `sections/sessions` | ported (`save_session_metadata`, `archive_session`, `delete_persisted_session`, `fork_session` from the last loaded turn, `copy_session` which selects the copy) |
| New session | `sections/sessions` | ported (`create_session` with `agentType: "Standard"`) |
| Transcript rendering (Muse 3-layer progressive disclosure, turns, tool cards, streaming) | `flow_chat` | ported (`SessionsScene.tsx` renders user bubbles separately from Muse 3-layer assistant turns: Layer 1 ambient status banner above the composer while running, Layer 2 vertical process timeline rail grouping `THINKING` / `THINKING SUMMARY` blocks and tool cards, Layer 3 checklists with progress bar, `DiffView` patches, monospace command/path callouts, and `TextView` Markdown with per-block `Copy` / `Copied` and streaming `agentic://text-chunk` / `agentic://dialog-turn-completed`) |
| Mermaid replies | `infrastructure/markdown/MermaidBlock` | Streaming replies show the code as it arrives. Settled replies and Markdown document previews share the themed diagram block. Show source reveals the code below the diagram, and Copy code copies the original source. The sandboxed renderer uses the app bundle and keeps source available on unsupported surfaces or renderer failure. |
| Published figures | `flow_chat`, `tools/visualize/CodexFigure` | Partial. Preview reads the sealed snapshot from the original turn on the session's owning device. Self-contained HTML and SVG use the chat palette in an isolated web view. The browser gateway serves a dedicated sandbox page for those fragments. Declarative version 1 charts and named chart configurations use `main`'s schema, calculations and ECharts options. Version 1 calendars support day, week and month navigation, and stack traces show the selected frame and source. Version 2 calendars, request waterfalls, flame charts, stack traces, illustrated tabs and layer diagrams reuse `main`'s widget components inside the shipped figure renderer. Filters, selected stack frames and supported chart and widget choices restore from controller-local storage scoped to the source device, workspace, session, original turn and URI. A declared follow-up appends selected data or form values to the originating pane's draft. Regional map declarations use `main`'s projection and bundled Natural Earth layers. Street-map declarations load public tiles and unbound stop names only after a reader chooses to load the map. The resulting SVG is cached on that controller for the source revision and replayed in the same sandbox. The Sources panel shows declarations and snapshot availability. The guest exposes literal JSON, recorded tool and file values, and saved raster images through `openai.visualization.onData`. The exact figure read carries checked bindings and can recover missing tool and file values from successful records before the verified producing Write or Edit. On a capable preview, readers can choose an advertised MCP resource from the session owner's desktop when the workspace is local. The Sources panel uses the standard NSH controls. A tool binding accepts JSON and a library binding accepts file content at its declared refresh interval. Updates reach the open figure and preserve its document state. Closing Sources keeps the subscription active. Disconnecting the resource or closing the figure stops it. SSH workspaces and older browser shells show an unavailable state. For bound HTML previews on hosts advertising figure binding refresh, Refresh in chat appends a tagged request to the originating composer and closes the preview for review and submission. Reopening the preview reads the checked binding from the corresponding settled turn. The optional session watcher follows later settled results from the same session at the declared interval. Desktop and CLI resolve both turns through the same scoped transcript read, verify the original declaration and match the corresponding successful receipt. Opening a bound HTML preview localizes missing HTTPS raster images before the authored scripts render. A dedicated browser worker or a short-lived native WebView reads bounded CORS responses on the controller with credentials and referrers omitted. The sandbox receives embedded image data, and sealed images preserve their original bytes. Repeated declarations for the same address share a download. Failed images remain unavailable in Sources and can be retried while successfully loaded images are retained for that preview. |
| Reasoning notes (thinking) | `flow_chat` (`ThinkingDetailPanel`, `FlowThinkingItem`) | ported (`src/agentEvents.ts` keeps the two streams apart — the host sends a reasoning model's notes on the *same* `agentic://text-chunk` event with `contentType: "thinking"`, so a chunk that says so goes to `thinkingText` and only the rest becomes the answer; before that they were concatenated into the reply and the model's working showed up as its answer. A persisted turn carries the same notes in `modelRounds[].thinkingItems`, which `turnParts` turns into a `thinking` part drawn before that round's text, since the round does not record the order the two streams interleaved in. The block is collapsed like the desktop's: its header names `THINKING` (or `THINKING SUMMARY` for a provider's summary) and the size or `streaming`, and a press shows the notes. A thinking part is not part of `turnToText`, so a session row or a search hit never shows the model's working as what the turn said) |
| Following the newest reply | `ScrollToBottomButton`, `ScrollToLatestBar` | done for the transcript (`src/scenes/SessionsScene.tsx`: `onScroll` decides whether the reader is within 32 px of the end, and while they are, a zero-height view at the bottom of the content is `reveal`ed after each change — a new turn, a streamed chunk, a thinking chunk, an opened session — so a growing reply stays in view with no measurement of the content's height. Scrolling up stops the following immediately, because a reply must not pull the text the reader is reading away, and a `Latest` chip then returns to the end and resumes it. `reveal` is applied after layout, which is why the follow lands on the content just added) |
| Composer, sending, queue, model selector | `flow_chat` | partial (`submit_user_message` sends every message — the host decides start / steer / queue from `app.flow_chat.send_during_turn`, mobile and IM bots go through the same host function — and `Stop` is the host's `stop_dialog_turn`, which interrupts and falls back to cancellation itself; a host older than those commands still starts idle turns through `start_dialog_turn` and stops through `interrupt_dialog_turn` / `cancel_dialog_turn`; `Model: <name>` opens the catalog's chat models — `get_ai_model_catalog` filtered to chat-capable entries — and `Model: <name>` opens the catalog's chat models — `get_ai_model_catalog` filtered to chat-capable entries — and binds one with `update_session_model`, together with the reasoning the model can be set to: `project_ai_model_reasoning_catalog` projects that model's presets from its own `ai.models` entry (endpoint, limits and reasoning block, forwarded unchanged), `get_session_model_target` reports the preset the session currently runs at — an older host omits the field, which is not the same as `null`, so nothing is written for it — and `Reasoning: <label>` offers the model's default plus those presets. The two are written as one pair because the host validates them together: pressing a preset sends the preset alone, and switching model carries the current preset only when the new model declares it, since a preset the new model does not know would fail the whole change. A model whose provider declares no presets draws no control at all rather than an empty list. The main and split composers share an expandable Reasoning row and segmented choices in the model picker. The reasoning shortcut uses the same choices. Auto follows the advertised automatic preset when the provider declares one, or resets to the model default. The session owner acknowledges changes before the selected value moves, and a refusal keeps the options open for retry. Presets are read for the model's owning device, including qualified fleet references. The Context window row displays the saved capacity and edits it inline. It sends one context-only `ai_model_upsert` to the model owner, retains the draft if that device refuses the patch, and reports any output cap the host adjusted. The picker reads the owner's reasoning presets again because their availability can depend on the output cap. The model settings do not change limits already reported by the runtime for its last context sample. The model menu can expand a search field and filter by provider. Search matches model names, configuration names, IDs, and fleet device labels while preserving the catalog order and disabled rows. Arrow keys and Enter can select eligible matches. A split session on another device asks for the catalog relative to that device before showing any choices. An ambiguous `/model` query opens the same search with its text filled in. `submit_user_message` has only the session-level reasoning binding, so this surface offers no independent per-turn override; `Attach` reads the clipboard's image through `Clipboard.readImage`, chips it above the input while it can still be removed, and sends it as `imageContexts` — by `image_path` for a `file:` URL the host opens itself, by `data_url` for bytes that only exist in the clipboard; a message sent while a turn is running reaches that turn as `steer_dialog_turn` and the composer reads `Steer` for it, which is the desktop surface's default immediate-steering policy; the other policy is `Queue`, which hands the message to the host's own queue: `manage_dialog_queue` with a turn id this surface chooses, `agentType`, no attachments yet, and `displayContent` for the row's text; what the panel lists is the host's `list` snapshot, `Send now` sends `promote` with the running turn as `expectedActiveTurnId`, `Delete` sends `cancel` with an operation id, and the host does the draining, so a queued message survives a reload of this surface and keeps its place beside what another surface queued — a host that does not answer that command gets an explicit "update the host" line instead of a local list (rows older builds stored under `openbitfun.nsh.pending-queue.v1` are submitted to the host queue once); a host row moves through `reorder` against the `revision` of a snapshot read first, and a row the host reports as `steering_pending` or `blocked` is labelled with the host's own status and reason instead of reading as idle, and the desktop's mid-turn policy setting is read from `app.flow_chat.send_during_turn`, so `Queue` there makes queueing the composer's primary action while `Steer now` (the host's default) keeps steering it; the other route stays one press away either way. `Return` sends, as the desktop's composer does: the field is `submitBehavior: "submit"`, which the widget documents as leaving `Shift+Return` (and `Option`/`Alt+Return`) as line breaks, so a multi-line message is still possible, and while the reference panel is offering a row `Return` takes the tag instead of sending) |
| Composer draft recovery | `flow_chat/store/sessionComposerStore.ts` | Text, images, file references, saved long pastes and session references follow the originating runtime and session across the primary and split composers. Pane switches, swaps, and closing a split retain the draft in memory. A send clears the submitted fields together, and a refusal restores that snapshot even after navigation if it has seen no newer edit. Delayed image reads and long-paste writes retain their captured owner. Long paste writes run on the owning workspace's device, and a controller connection replacement separates drafts from the previous connection. |
| Session agent (harness profile / agent) | `HarnessProfileSelector`, `ChatInputModePreferenceService` | ported (`src/agentModeStore.ts`; since logic batch 3 the order, eligibility, aliases, per-session `switchable` and the resolved default come from the host's `get_session_mode_catalog`, `update_session_mode` refuses to rebind a started session (`session_mode_locked`) and records `last_mode_id`, and the text below describes the rules the host now applies; `get_available_modes` is the catalogue the panel draws for the active workspace — the four harness profiles `Minimal` / `Standard` / `Ultimate` / `Creative` first, then the agents and external ACP agents the host resolves, minus the modes the desktop keeps out of a session's agent list: `claw`, `multitask`, `plan`. A session that has not started a turn takes the press and is rebound with `update_session_mode`; a session whose `messageCount` is above zero keeps the agent it started with, because the runtime would accept the rebind silently and change what a running session's next turn is — so the press offers a new session in that agent instead, created by `create_session` with the name and agent, which is what the desktop's own lock does. The agent a new session starts as follows the preference both surfaces share, `app.flow_chat`: `default_mode_strategy: "fixed"` reads `default_mode_id`, anything else reads `last_mode_id`, and every choice is remembered by writing the `last_mode_id` leaf, so the object's other keys survive and the React surface reads the same value back. The session header names the agent of the session it opens, and the header of a row without a recorded agent shows the one this surface would send. A host without the command — an older build, or a Peer that does not answer it — leaves the composer on the agent it already had and says so in the panel rather than drawing an empty list) |
| Composer references | `flow_chat` (`ChatContextPicker`, `RichTextInput`) | Partial. Both session panes share a reference picker through the plus menu and `@query`. The plus-menu picker opens on a source list for files, skills, MCP, sessions, and image attachments. Its search field queries all four reference sources on the composing runtime. Clearing the query restores the prior source or directory. Inline `@query` retains the source tabs and replaces the typed query with the chosen reference. Files and directories use removable chips and serialize as `#file:` and `#dir:`. The Sessions source calls `search_referenceable_sessions` on the owning runtime, preserves host workspace locators, and sends `sessionReferences` and `composerPresentation` with the message. A running session queues a session-reference message for a formal turn, and Send now promotes it through the host queue. The Skills source reads `get_mode_skill_configs` for the composing mode and workspace. MCP reads `get_chat_mcp_catalog` on the composing runtime, groups tools by server and matches server and tool text. The MCP tab distinguishes restricted modes, unsupported remote workspaces and older hosts from an empty catalog or a retryable failure. The Files editor exposes Add to chat for a nonempty source selection, in its context menu and status bar. It targets the focused session pane in that workspace and keeps the selected text, path and line range in `main`'s `code-snippet` presentation segment. The model prompt receives the same location header and `#code:` tag as `main`. Drafts with Skill, MCP or code snippet references use NSH's inline editor atoms on clients that support them. Arrow keys and deletion operate on the capsule, and clipboard text retains the reference at its original position. Enter sends or takes the selected reference. Shift+Enter inserts a line break. User messages, queued messages and Edit and rerun render the same capsules. Skill tokens use `main`'s `inline-token` presentation segment, and older saved prompt text is also recognized. Saved Mermaid diagram and node contexts are restored as inline capsules with their source or node details, and resend with the same Mermaid prompt sections as `main`. Pull request context is added from Git > Pull requests and retains the provider, section content, and check-log metadata through edit and rerun. |
| Permission prompts | `flow_chat`, `ConfigAPI` | ported (`subscribe_permission_requests` + `list_pending_permission_requests` seed the prompt, `permission://event` keeps it current, `respond_permission` answers once / always / reject; drawn in the scene so a remote controller can answer) |
| User questions (`AskUserQuestion`) | `@openbitfun/ui/flow-chat` `AskUser` | Sessions, Inbox and job cards use the shared NSH form with design-system metrics, radio and checkbox rows, option descriptions, custom answers, and one explicit submission. Session drafts are scoped to the runtime, session and tool. The session mailbox recovers pending prompts, confirms a paused countdown, and reports an explicitly unlimited wait. Runtime answers use positional `submit_user_answers`. Detached Dispatch uses its own mailbox. Live and saved transcript items show the host’s settled answers in a right-aligned reply. A shortened record reads its complete turn from the owner on demand. Cancelled questions can be reviewed, and a timed-out question can be answered through the same form. The follow-up sends a new message with immediate delivery to the source session, with an independent draft that survives split swaps and stays editable on failure. |
| Session tabs / scene bar | `app/components/SceneBar` | ported for the session canvas (an `openSessionIds` strip above the transcript: a pressed session joins it, a tab press reloads that session's turns, a tab close falls back to the last tab, and archiving or deleting a session removes its tab) |
| Global search | `app/global-search` | `GlobalSearchPanel` uses the shared Toolbar, TabGroup and ActionCard, with six frequent actions, workspace/assistant previews and All / Actions / Content scopes. All and Actions index the bilingual product capability catalog generated from the manual's source, including item-level settings destinations. Results use the same navigation as product control and require a destination this surface can show. Actions and `>` queries run locally. Content searches session names, message hits and workspace files from the host. Input and scope changes invalidate pending replies before debounce. A source failure is reported alongside other results. |
| Archived and background sessions | `sections/devices`, `sections/sessions` | ported for archive and restore (`Active` / `Archived n` chips split the one catalog the host returns by `persistedStatus`, the archived row's header action restores it through `unarchive_session`, and archiving keeps its row instead of dropping it); a row also states what its session is doing, derived from this surface's own events rather than stored per session: `Running` (a turn event that names the session — including a session the user is not looking at), `Waiting for approval` (a permission prompt carrying that session), `Queued` (the host queue reported rows for it), `Last turn failed`, and `Not read yet` / `Last turn failed` from the host's unread receipt (`unread` / `failed` in the session page's activities; opening a session acknowledges it with `mark_session_seen`, and stamps older builds kept in `openbitfun.nsh.session-seen.v1` are handed to the host once). Sessions another device owns are reached through the fleet device context, and a background session whose turn this surface never saw an event for shows no mark) |
| Task card subagent steps (wave 5) | `tool-cards/TaskToolDisplay` | ported (`src/ui/toolCards.tsx` lists the subagent's tool calls and replies from the transcript view's nested `subagentItems` under an opened Task card, the latest eight first and the rest behind `Show n earlier steps`; nothing is re-derived from records) |
| Structured Review report | `tool-cards/CodeReviewToolCard` | Partial. The shared transcript card renders completed `submit_code_review` reports with assessment, risk, AI recommendation, individual findings, remediation, strengths, and evidence coverage. It reads omitted detail on demand from the transcript owner, accepts older JSON-string reports, and shows an explicit fallback for unreadable results. PR history and the parent-session card use the stored per-run outcome. The parent card uses the shared `ActionCard` and opens the latest saved report on request. The report and the shared editor export Markdown on the controller using the desktop save dialog, browser download, or phone share sheet. On the phone, the shell writes a temporary file inside the app's private export directory. It removes a cancelled share's file and prunes files over a day old when the shell starts or a new share begins. For a workspace Review, the report opens a shared selection dialog and sends approved findings and decisions to the owning runtime, which starts a separate fix session. The dialog reloads saved per-item progress from that runtime, refreshes while the fix is active, and opens the linked fixer session. Items reported complete are excluded from the next selection. The run ending and an individual item being reported complete remain separate states. The same dialog can start a read-only re-review at the original strength and reopen its saved child. The runtime remeasures the original paths and paths named by successful fixer receipts. When the scope cannot be reconstructed, the dialog shows the current-workspace fallback before confirmation. The parent card keeps one Review record across revisions. |
| Joining a turn that is already running (wave 5) | `restore_session_view` `runtimeEventSnapshot` replay | ported (`get_session_transcript_view` now carries `runningTurn`: the runtime journal's projection of the running turn as the live `agentic://*` events plus the delivery cursor they reached; `src/agentEvents.ts` replays them through its own live handlers and drops live events at or below that cursor — a text chunk merged across it keeps only the newer text, using the `__openbitfunChunkSpans` the per-frame merge records — so a surface that connects, reopens the session or lost events mid-turn shows the turn exactly as an attached one does. A turn this surface followed from its start is not replayed again. An older host omits the field and the turn appears when it settles, as before) |
| GenUI answers (wave 5) | `GenerativeWidgetInline`, `tools/generative-ui`, `@openuidev/react-lang` | ported for the transient inline answer (`src/genui/`: an OpenUI Lang reader for the same language — statements, positional component calls whose argument order `scripts/generate-genui-contract.mjs` generates from the product library, `$state`, hoisting, `@Each` and the library's builtins, `@ToAssistant` / `@OpenUrl` / `@Set` / `@Reset` / `@CopyToClipboard` actions — and NSH drawings for all 55 components, rendered as the source streams in through `GenUIStream` deltas and from the call's result once settled; a failed candidate leaves no card, as on the desktop. Card state is keyed by runtime, session, turn, and tool. Assistant actions submit through the source session's composer driver, including after swapping a split pane. The submitted message consists of the widget action and its explicit context. Buttons use the shared primary, outline, soft, ghost, and danger treatments. Inline math uses NSH's typesetter and shared prose color. Display math uses the same KaTeX renderer as Markdown. Shown differently and said so: images, maps and YouTube are captions with an Open link because this window has no network grant, and HtmlView and free `html-document` answers render as static pages with scripts off. Not ported: the owner/CAS persistence the desktop also did not have, host `Query`/`Mutation` providers, the repair request after a render diagnostic) |
| Composer voice input and voice calls (wave 5) | `flow_chat/components/voice` | not ported: both need microphone capture, which NSH does not give an app ([longbridge/nsh#1059](https://github.com/longbridge/nsh/issues/1059), not planned), so the UI offers no dictation, voice call or voice settings. The host speech service (`speech_*`) is unchanged; voice returns by capturing audio outside NSH (desktop backend, phone app crate, web page host) and streaming it to that service |
| Agent navigation requests (wave 5) | `global-search/openBitFunControlBridge` | ported (`src/controlPresenter.ts`: the window marks itself the presentation surface with `mark_openbitfun_control_surface_ready`, answers `agentic://openbitfun-control-request` by opening the screen behind the catalog `destination` the host now resolves into the request (settings page and section, scene, product action, surface event) and reports through `report_openbitfun_control_result`; a destination this UI has no screen for, or a host that sends none, is reported as a failure naming it. Persisted language and appearance effects are applied and acknowledged. Pages served to phones or browsers never declare themselves the presenter) |

### Assistants

| Feature point | React owner | NSH status |
|---|---|---|
| Assistant gallery & primary designation | `scenes/profile/views/NurseryGallery`, `AssistantCard` | ported (`AssistantsScene` opens on a card gallery, primary first and large, with open/close workspace, set-primary and delete per card and a create card below three assistants; `src/assistantStore.ts`: `get_assistant_workspaces`, `get_primary_assistant_workspace`, `create_assistant_workspace` (which opens the new assistant's page), `set_primary_assistant_workspace`, `reset_assistant_workspace`, `delete_assistant_workspace` behind `InlineConfirmBar` with primary-delete guard) |
| Assistant config page | `scenes/profile/views/AssistantConfigPage`, `AssistantAvatarPicker`, `ScheduledJobsView` | Ported. The name and avatar use the assistant identity commands, and the Sessions tab opens that assistant's sessions. Scheduled sessions below the list use the same rows, scheduler previews and editor as Library › Routines. `list_cron_jobs { workspaceId }` scopes the list to the assistant's workspace on its runtime. Users can create, edit, pause, resume and delete routines there. Each run can start a session with the assistant or use one of its existing sessions. An unrelated edit preserves the saved target and schedule. |
| Persona & Soul Studio (`IDENTITY.md`, `SOUL.md`, `USER.md`) | `scenes/profile/views/AssistantConfigPage` | ported (the page's three persona links open an editor dialog with `SegmentedTabs` across the POSIX-joined files via `read_file_content`, treating missing files as empty drafts, the shared visual Markdown editor (source `Input` on request or when the fidelity guard needs it) with a live Markdown preview, `write_file_content` save, `reset_workspace_persona_files` behind `InlineConfirmBar`, and quick message launch via `startQuickPromptInSession(..., "Claw")`) |

### Agents

| Feature point | React owner | NSH status |
|---|---|---|
| Multi-Agent Team catalog (modes, profiles, subagents, external ACP) | `scenes/agents` | ported (`AgentsScene` + `src/agentsCatalogStore.ts`: `get_available_modes`, `list_subagents`, `list_agent_tool_names`, `get_agent_profile_configs`, `SegmentedTabs` for `All Bots` / `Primary Agents` / `Subagents`, scope & text filters, and one-click `Start Thread` launching `startQuickPromptInSession`) |
| Catalog cards and skill selection | `AgentCatalogCard`, `AgentCapabilityCards`, `SkillGroupPicker` | Agent cards use the shared Card tokens and open details from the card body, with independent Start Thread and menu actions. The Skills capability opens a summary of saved skills and a Manage view for individual and group selection. Save re-reads the target runtime and applies the draft in one `replace_mode_skill_selection` call. Cancel can discard the draft and a failed save keeps it open. |
| Tool and subagent selection | `AgentCapabilityCards`, `ToolGroupPicker` | Built-in profile tools and per-parent subagents use the shared capability summary, Manage, draft, and Save workflow. The profile and custom definition editors share a tool picker with built-in, extension, and personal groups. Personal group definitions are saved separately to the target runtime's `app.user_tool_groups` preference and retain tools that are currently unavailable. Profile tool writes merge the draft into the current profile on that runtime. Subagent saves use the parent's existing per-item commands and retain pending edits when one write fails. External subagents are shown read-only. |
| Custom bot builder, profile tools & subagent config | `scenes/agents`, `SubagentAPI` | ported (`create_custom_agent`, `update_custom_agent`, `delete_custom_agent`, `get_custom_agent_detail`, `reload_custom_agents`, `create_subagent`, `update_subagent`, `delete_subagent`, `get_subagent_detail`, `reload_subagents`, `set_agent_profile_config` / `reset_agent_profile_config`, `update_subagent_config` with `parentAgentType`, interactive tool multi-select `PillChip`s; explicitly disabled on remote workspaces) |

### Skills

| Feature point | React owner | NSH status |
|---|---|---|
| Installed skills, global toggles & `SKILL.md` inspection | `scenes/skills` | ported (`SkillsScene` + `src/skillsCatalogStore.ts`: `get_skill_configs` normalizing array and `{ skills, diagnostics }`, `get_global_skill_settings`, `set_global_skill_disabled`, `ToggleSwitch`, `SKILL.md` inspection via POSIX `${skill.path}/SKILL.md`, and `delete_skill` behind `InlineConfirmBar`) |
| Personal and built-in Skill Groups | `scenes/skills/components/SkillGroupsView`, `features/skill-groups` | ported for group management and selection. `SkillGroupsView` reads and writes the version-one `app.user_skill_groups` config on the scoped runtime. The catalog supplies built-in grouping metadata. Users can create, copy, rename, reorder, and delete personal groups, including ones with temporarily unavailable members. The editor checks the saved group before applying a draft. `AgentSkillGroups` expands a pick into the agent's existing skill keys, with globally disabled skills left as they were. Edits in the Library affect group definitions alone. |
| Local folder install & Skill Marketplace | `scenes/skills`, `skill_api` | ported (`validate_skill_path` + `add_skill` for user/project scope, `list_skill_market` / `search_skill_market` / `download_skill_market` with `Installed` matching; local folder installs and project-level remote installs degrade loudly with explicit warnings on remote workspaces) |

### Routines

| Feature point | React owner | NSH status |
|---|---|---|
| Scheduled Cron Jobs & 24 h feed | `scenes/cron`, `CronAPI` | ported (`RoutinesScene` + `src/routinesStore.ts`: `notify_cron_host_ready`, `cron://jobs-changed` subscription with `cleanup()`, `list_cron_jobs`, `create_cron_job`, `update_cron_job`, `delete_cron_job`, `ToggleSwitch` enable/pause, `All` / `Active` / `Paused` filter, Due in Next 24 Hours cards, preserving existing `"session"` targets) |
| Interactive Month Calendar & Routine Editor | `scenes/cron` | ported (7-column Mon–Sun month calendar highlighting today and scheduled dates with day-click occurrence filter, alongside `Every` / `Cron` / `At` schedule editor with workspace and agent selection) |

### Devices & Connectors

| Feature point | React owner | NSH status |
|---|---|---|
| Account device inventory | `NavPanel/sections/devices` | ported (`account_list_devices`) |
| Online presence | `DeviceStatusControl` | from the fleet navigator; the 1.x `account_online_devices` relay presence was retired in 2.0 |
| Device alias / visibility / ordering | `deviceVisibilityPreferences`, `deviceOrderPreferences` | ported (an alias writes `account_update_device_alias`; `Hide` / `Show` per row and `Up` / `Down` arrangement persist in this app's `Storage` under the React stores' own keys — `openbitfun.sidebar-device-visibility.v1`, `openbitfun.device-order.v1` — with the same `{ state, version }` envelope, so both surfaces read one set of preferences and a file either wrote still parses; the default order is this machine (`remote_connect_get_device_info`) first, then online, then alias or name, and `Hidden n` reveals the hidden rows. Arrangement is buttons rather than drag, which keeps it usable from a keyboard and from a remote controller) |
| Rendering another device's sessions and workspaces | `infrastructure/peer-device` | replaced by the fleet device context (picking a device moves `{deviceId, workspaceId}`; commands go out as `fleet_call`). The 1.x relay HostInvoke path and the non-fleet mesh path were removed in 2.0 ([peer-device-mode.md](peer-device-mode.md)) |
| Peer reconnection and capability gating | `infrastructure/peer-device` | retired in 2.0 with Peer Device Mode (no per-peer handshake, capability map or Reconnect line) |
| Detached dispatch entry points | `features/dispatch` | ported (`dispatch_list_targets` fills a target row — the first remote target is preselected so a job never defaults to this machine — and `New job` sends `dispatch_submit` with the ids this surface mints (`job-…`, `session-…`), the session's own `agentType`, the prompt, and an approval policy the user picks from the three the host accepts (`auto`, `reject-and-report`, `remote`), because the request is refused without one; the target's `workspacePath` is required for a remote target and is prefilled from this workspace. The list below it is `dispatch_list_jobs` with no target, i.e. the controller's own index, read as `lastState` / `promptPreview` / `target.displayName`, and `Cancel` sends `dispatch_cancel`. A host without these commands hides the panel instead of showing an error. Not drawn: the CLI install / probe / model-sync preflight and result navigation) |
| Detached dispatch observation | `features/dispatch/DispatchJobObserver`, `flow_chat` transcript | ported as a reduced projection (`Observe` on a job opens `src/dispatchObserver.ts`: `dispatch_status` is polled every 1.8 s while the job is alive, and the cursor sent is always the one the target handed back for a page this surface already rendered, so a page that failed to render is re-read instead of skipped; `cursorReset` means the target rewrote its log, which drops the transcript and replays from zero. The fold keeps what a reader needs — `jobState` rows, assistant text with consecutive chunks merged into one row, thinking kept distinct, tool rows for `Queued` / `Waiting` / `Started` / `ConfirmationNeeded` / `Confirmed` / `Rejected` / `Completed` / `Failed` / `Cancelled` and not for the assembly frames, turn failures and `permissionRejected` as errors — and drops what only a full dialog-turn store can carry: per-round metrics, subagent nesting, image analysis, deep-review queues, `ThinkingChunk` merge order. A permission the target waits on is answered in place with `dispatch_answer` (`once` / `always` / `reject`), and the composer means one of two commands depending on the state: `dispatch_append` while the turn runs, `dispatch_continue` with a freshly minted `turnId` once it has finished, so a repeated press cannot start the same turn twice. `Sync result` runs `dispatch_sync_result` for a finished job and `Cancel job` runs `dispatch_cancel`. The poll is released when the panel closes or the scene unmounts, and a terminal job releases it once the log is drained. Not ported: the controller-side transcript cache (`dispatch_load_transcript` / `dispatch_save_transcript`), so a reopened job replays the target's log again) |
| Messaging Bots & Mobile Relay Connectors | `scenes/remote-connect`, `RemoteConnectAPI` | ported for bots (Settings › Account › Devices and chat apps, `AccountDevicesPage` + `src/connectorsStore.ts`: `remote_connect_status`, `remote_connect_get_methods`, `remote_connect_get_form_state`, `remote_connect_set_form_state`, `remote_connect_start`, `remote_connect_configure_bot`, `remote_connect_stop_bot`, `remote_connect_weixin_qr_start`, `remote_connect_weixin_qr_poll`, `remote_connect_get_bot_verbose_mode`, `remote_connect_set_bot_verbose_mode` for Telegram, Feishu and WeChat iLink QR; degrades cleanly when unsupported). The LAN relay and the OpenBitFun Server relay ("Mobile Web Relay") were retired in 2.0 and have no UI |

### Settings

Settings and the Library use the same NSH `ConfigSection` and `ConfigRow`
components for section surfaces, headings, and field rows. Settings follows the
`ConfigPageLayout` content-panel breakpoint from `main`. Ordinary text, number,
and select fields share the design-system field width on wide panels and fill
the row below their label on narrow panels. The field controls expose the
localized label and supporting description to assistive technologies.

| Feature point | React owner | NSH status |
|---|---|---|
| Shortcuts, desktop-control permissions, settings backup (wave 22) | `KeyboardShortcutsSection`, `ComputerUse*`, config import/export | ported (`src/shortcutsStore.ts`: Settings › Shortcuts lists the shell's shortcuts by registry id, records a key and writes `app.keybindings` as `{ __version__: 1, overrides }` (legacy entries kept), and the shell rebinds on the write. Device › Browser and desktop control draws the scope device's own `computer_use_get_status` rows with `computer_use_request_permission` / `computer_use_open_system_settings`; a device that refuses the command shows `settings.unsupported`. Device › Diagnostics copies `export_config` to the clipboard and sends a picked or pasted export to `import_config`) |
| Settings navigation and search | `settings/SettingsNav` | ported (the desktop has a navigation rail and the phone pushes a page from the same list. The rail uses the shared navigation and search tokens, with a pinned search field, keyboard selection, and page-level draft indicators. Both settings search and global search use the same index and can open the matching section. The existing Preferences, Account, and Device scopes determine visibility and ownership. Settings restores each page's scroll offset in the current device scope. An explicit section destination takes precedence.) |
| Config sections read | `scenes/settings` | ported for the paths it draws (`get_config` per path, so one missing path cannot fail the batch: `app`, `app.ai_experience`, `app.logging.level`, `editor`, `terminal` and the two `app.notifications` flags; a path a host lacks is shown as `unavailable` instead of breaking the page. `AI execution` draws the `ai.*` scalars the desktop page reconciles — `enable_deferred_tool_loading`, `subagent_max_concurrency`, `swarm_max_concurrency`, `subagent_batch_execution_policy`, `tool_execution_timeout_secs`, `user_question_timeout_secs`, `tool_presentation_mode` — as ordinary fields, with `native` / `ptc` / `ptc_python` as the values `ToolPresentationMode` deserializes. `ai.task_models` has its own section rather than a field table, because `TaskModelSelection` is a serde enum (`"Inherit"` or `{"Fixed":{"model_id":…}}`), so the whole object is written back with each task set to a model id from `ai.models` shown by name. `Permissions` reads `tool_permissions`, resolves it to Ask / Auto / Full access the way the desktop does, and writes the mode back by rewriting `policy.preset`, `interaction.auto_approve_ask` and `approval.strategy` while keeping the rule list and any other field; full access takes a second press. The rule list is edited as its own draft: `Edit rules` opens it, `Add rule` seeds an empty row, each row is an effect chip — `Allow` / `Ask` / `Deny` — over an `action` and a `resource`, plus `Up` / `Down` / `Remove`, and `Save rules` writes the whole `tool_permissions` document once, so the drawn order becomes the evaluation order the host applies; `Discard changes` drops the draft and says nothing was written. A row whose action or resource is blank is refused instead of being stored as a rule that matches everything. Automatic approval is drawn from the same document: `Chat model` / `Decision model` pick the `model_kind` that answers, the chat route lists the `fast` / `primary` roles beside the `ai.models` entries and writes `approval.chat_model_id` with `model_kind: "chat"`, the decision route edits `ai.decision_model` (name and endpoint) and keeps its key in the vault through `save_decision_model_credential` / `clear_decision_model_credential`, so the secret never enters the config, `Approval timeout` clamps the seconds it accepts, and the `When it is unsure` / `When it fails` chips write `on_ask` and `on_error`. Those writes never move the permission mode: saving approval rewrites `approval` alone. Driven in the real window: `Auto` wrote `approval` as `strategy: "model"`, `model_kind: "chat"`, `chat_model_id: "fast"`, `on_ask: "user"`, `on_error: "ask"`, `timeout_ms: 30000` together with `interaction.auto_approve_ask: true`; a rule added as `*` / `workspace/*` / `Deny` reached `policy.rules` and the section then read `1 rule in force`; removing it and saving cleared the list to `0 rules in force`; and `Full access` behind its confirmation wrote `preset: "full_access"` and dropped the approval block again. `Tools` and `Agent hooks` draw the switches the desktop keeps for Computer Use, browser reattachment and native hooks (`ai.computer_use_enabled`, `ai.browser_control_auto_connect_on_startup`, `ai.browser_control_preferred_browser`, `app.hooks.enabled`, `app.hooks.project_hooks_enabled`), plus `app.prevent_sleep` under `Application` and `app.logging.include_sensitive_diagnostics` under `Diagnostics`; those are written as leaf paths, so `ai` (models and keys) and `app.hooks` are never replaced wholesale. `Session memory` draws the user-facing `memories.*` switches (extraction, prompt inclusion, background sessions, the `MemoryExternalContextPolicy` enum, how long an unused memory stays, and the consolidation batch), again as leaf paths. `AI experience` also draws `app.ai_experience.enable_git_commit_coauthor` — the desktop's commit-attribution switch — as its own leaf path rather than through the `app.ai_experience` object the quick-action list is merged into, so a press cannot rewrite a list it does not own. `application.input`, `development.*` and the memory scheduler's lease and retry timings are not drawn) |
| Scalar field editing (toggles, choices, numbers, text) | `scenes/settings` | ported (`set_config` one path at a time; numbers clamp to the field's range; an empty field leaves the value alone) |
| Section forms and validation | `scenes/settings` | partial (bounds, numeric parsing, and three checks the host also makes. A model's limit pair above the host's 40% ceiling is refused; a memory extraction window longer than the retention it runs inside is refused with the reason instead of being silently shrunk, read from the stored document at write time so raising the retention first is what makes a larger window legal; and a `model` field writes a configured model id, one of the product's two roles, or `null` — a stored id the host no longer configures keeps its own chip marked `(not configured)` rather than reading as "follow", because silently forgetting a reference is worse than showing it is gone. `Session memory` therefore draws the fields the desktop keeps inside that document rather than at a leaf path: the extraction and consolidation models, the idle window, the rollout window, sessions per startup, the scan limit and the extraction concurrency, with the desktop's own ranges. One Enable memory switch updates `generate_memories` and `use_memories` together through the selected device's existing product-control option. A mixed legacy configuration is read without rewriting it. Model parameters and collapsible advanced settings follow `main`'s groups, and search opens the advanced section. The Manage menu opens the local memory folder and provides separate confirmed actions for restoring settings and clearing stored memories. Other sections still have no per-field validation) |
| Secret, model discovery, testing & subscriptions | `ConfigAPI`, `modelDiscovery` | ported for custom/catalog/remote model config (`AI models` reads `ai.models`, previews live resolved endpoint URLs across `openai`, `response`, `anthropic`, `gemini` including trailing `#` verbatim suffix, detects models via `list_ai_models_by_config`, merges `get_local_models_dev_catalogs` in `ModelDiscoveryPicker` with 40% `max_tokens` batch save, tests endpoints via `test_ai_config_connection`, and displays `list_subscription_accounts` / `get_subscription_account_quota` usage windows) |
| Model pools | `ModelPoolsSection`, `ModelPoolAPI` | The selected device supplies the stored pools, member availability and failure reasons. The editor uses main's original artwork for Ordered failover and Balanced assignment. Its searchable model picker adds enabled chat models and keeps saved member IDs visible when a model is unavailable. The member menu moves a model, or retries one the host reports as cooling down or needing attention. Retry re-reads the pool health from the same device. Editing a stored pool checks the current health automatically. A settings transition protects a changed draft with Save, Discard or Keep editing. Deletion requires confirmation. The host assigns new pool IDs and applies mutations, and an older host without the collection command hides the tab. A transient list failure offers a retry. |
| Input, workspace and the mid-turn send policy | `settings/pages/application`, `settings/pages/development` | ported for the stored values (`Input` draws the selection-toolbar switch and the local voice-input preferences — on/off, language, longest recording, microphone — from `app.flow_chat.auto_show_selection_toolbar` and `app.ai_experience.voice_input.*`; `Workspace` draws the worktree folder, branch prefix, copy-local-changes and the auto-delete policy from `app.worktrees.*`, in the camelCase keys the worktree service stores. `Message sending` is a two-chip switch over `app.flow_chat.send_during_turn` — `Steer now` or `Queue` — and the composer's primary action follows it: with `Queue` a message written during a turn goes to the queue instead of into that turn, with `Steer now` it steers, and the other route stays one press away either way. Every one of these is a leaf write, so `app.flow_chat`, `app.ai_experience` and `app.worktrees` are never replaced. Not ported: the local-model download/selection and the microphone test, which are host probes rather than stored values, and the suggestion fields the desktop groups with them) |
| Web search provider and key | `tools/WebSearchConfig`, `ai/web_search` | ported (`ai.web_search` is read as one document and written back whole, so a provider this surface does not draw and any unknown field of a drawn one survive the write; the six providers the desktop offers are `exa_mcp_free`, `exa_search_api`, `tavily`, `deepseek`, `keenable` and the self-hosted `openbitfun_search_http`, and choosing one writes `provider` plus that provider's `credential_id` / endpoint / auth fields. The key never enters the config: `get_web_search_credential_status` states whether one is stored, `save_web_search_credential` / `clear_web_search_credential` move it through the vault, and the note above the row is what the host answered last. A provider that needs no key, such as Exa's free MCP, says so instead of showing the credential rows) |
| Composer quick actions | `ChatInput/quickActions` | ported (`app.ai_experience.quick_actions` — `{ id, label, prompt, enabled }` — is drawn as an editable list: `Show` / `Hide` per row, `Up` / `Down` for order, `Edit` for label and prompt, `Delete`, and `Add`; the host's defaults (`commit`, `create_pr`) appear when it stores nothing. Every write re-reads `app.ai_experience` and merges, because `voice_input` and the other switches in that object are written by other sections of the same page. The composer's `Actions` menu lists the enabled rows and sends the row's prompt as a turn; a hidden row stays out of the menu but stays in the stored list) |
| Theme and appearance application | `infrastructure/appearance`, `FontPreferencePanel`, `FlowChatWidthSettingsSection` | The nine built-in themes use a swatch gallery with a follow-system toggle. The separate text-size section uses the `main` preset list in a shared select, an editable 12–20 px custom stepper, and an editable preview at the applied size. The preview stays in the panel. Font changes repaint immediately and persist as `font.uiSize`. The conversation-width section has a typed pixel stepper, 10 px buttons and Reset. It retains NSH’s 760 px default, 600 px minimum and the shared `openbitfun:appearance:flowChatWidth` storage key. Theme, font and width read and save through the controller’s entry. Custom appearance asset packs are still owned by the retired React frontend. |
| Session panel layout | `SessionPanelSettingsSection`, `SplitView` | Appearance offers Side by side and Overlay. Overlay floats the side inspector within the session canvas and keeps the header, prompts and composer beside it. Two-session and side-question layouts reserve room for their controls. Side-by-side and overlay widths are independent. The display preference and overlay width use `openbitfun:sessionPaneDisplayMode` and `openbitfun:sessionOverlayWidth`. The shell keeps the bottom dock, compact full-width view and adaptive sheet for tight windows. |
| Side conversation closing | `BtwCloseConfirmationSettingsSection`, `useTabLifecycle` | Input preferences and the close dialog share main's controller-local skip key. Closing, starting a fresh side conversation or replacing the pane with a split session requires confirmation by default. Cancel keeps the draft and transcript. The owning runtime acknowledges cancellation of a running question before the pane releases its content. Save as fork in main depends on a persisted turn, while NSH side questions run as ephemeral children. |
| File editor appearance and behavior | `EditorSettingsPage`, `tools/editor/config` | The Editor page groups appearance, editing behavior and display. The workspace device's existing `editor` document supplies font, row height, indentation, viewport wrapping, line numbers, active-row highlight, whitespace marks and end-of-file scrolling for the shared source editor. Settings changes keep unsaved buffers intact. Saved column-wrap modes fall back to viewport wrapping, and relative or interval line numbers use absolute numbers. Those modes and the other Monaco-specific display modes remain visible in the settings menu as unavailable choices. The native editor exposes no minimap. |
| Language selection | `LanguageSettingsSection`, design-system `Select` | Ported. General → Interface uses the shared NSH select with native locale names. A selection repaints the UI immediately and stores the preference locally. The controller-local language command saves it on the connected entry. While the write is pending the select is disabled. A refusal keeps the chosen language with a retry notice. An account language update reloads from the fleet entry even while another device's settings are open. Older hosts can supply the current language through config. |
| MCP servers | `infrastructure/config/components/McpToolsConfig` | partial (`get_mcp_servers` supplies the shared settings rows with localized status badges, import origin, transport, host-reported command availability and resolved runtime path, and remote authorization state. Edit, authorization, start, stop, and restart are available on the server row. A refresh failure marks retained rows stale and disables server actions until a fresh list arrives. List, config, authorization, and resource responses are scoped to the selected device. Configuration is edited as the stored document, not as a rebuilt one: `load_mcp_json_config` returns the Cursor-format text and its fingerprint, `save_mcp_json_config` writes with that fingerprint, and the inline JSON editor keeps the fingerprint of the document the draft was based on. The shared Settings exit dialog offers Save, Discard, or Keep editing for a dirty draft when returning to the server list, switching Settings pages or devices, or navigating out of Settings. A stale write retains the draft and makes reloading the stored document an explicit choice. Successful saves return to the server list. An acknowledgement that the data persisted but runtime reconciliation failed is shown there as a warning. The form writes only the fields it draws into a copy of the stored entry, so a field this surface does not show survives an edit, and a new entry is stored `enabled: false` whatever the form said, so a server never starts behind the user's back. The server editor switches between the field form and JSON for that one server while keeping the same draft and original document fingerprint. It opens in server JSON for an entry the form cannot represent. The form retains existing arguments and masked environment and header values, groups advanced fields under a disclosure, and offers the desktop authorization choices. Cancel and Escape route dirty drafts through Settings Save, Discard, or Keep editing. A fingerprint conflict keeps the form open with its draft and an explicit reload choice. Start and Restart open authorization before attempting to connect an OAuth-enabled server with missing credentials. If either operation receives an authentication error for a remote server, it opens authorization and starts a browser flow when the host advertises OAuth. The authorization panel polls a pending OAuth session on the selected device, including one it finds when reopened. Successful OAuth or token updates close the panel and refresh the server list. Cancel authorization stops the pending session and keeps the panel open. Closing the panel cancels a pending session before dismissing it. The address the host hands back is opened with the surface's own `openUrl`, and when that fails the panel shows the address with `Copy address` instead of dropping it. The token route is the same panel: `update_mcp_remote_auth` stores an authorization value and `clear_mcp_remote_auth` removes it, so a server without OAuth discovery still takes one. Import accepts pasted JSON or a JSON file picked on the controller. Preview validates each entry, shows ID conflicts, and lets the user select eligible servers and rename their target IDs. Canceling the file picker preserves the existing draft; changing the input clears its preview. The import uses the fingerprint captured when the draft opens. If the target changes, explicitly refreshing the target retains the reviewed selection and revalidates its IDs. The shared Settings exit dialog protects the import draft. A single `save_mcp_json_config` adds only the selected entries as `enabled: false` and removes any import origin metadata supplied by the source file. The host still merges identical connections in the runtime list, which can display only one of two IDs retained in the stored JSON. What a running server publishes is browsed from the row's `Resources` entry: `list_mcp_resources` fills the list (the first read is the cached list, `Refresh` asks the server again with `refresh: true`), a filter narrows it by name, URI or description without another read, and `read_mcp_resource` renders the contents — one block prints its media type, several name themselves so they stay distinguishable, a `blob` is reported as binary instead of being decoded, and a read that fails says so under the row it belongs to. `list_mcp_prompts` / `get_mcp_prompt` are not drawn because the desktop's own surface does not call them either: there is no prompts UI to port) |
| Token usage | `UsageStatisticsSettingsPage`, `UsageActivityHeatmap` | The six-month activity heatmap sits above Selected period, using the day-keyed grid from `get_token_usage_activity` in the request’s IANA zone. The small shared `SelectDropdown` offers the same five presets as `main`. Selecting a range reloads `get_token_usage_statistics` with hourly buckets for Today and Last 24 hours and daily buckets for the other presets. Refresh reloads both panels. The overview uses labeled rows for total, input, output and requests. It distinguishes an empty period, an empty history and a host without statistics. Distribution uses the shared section, filter row and Model / Group tabs, with the five-row cap and an explicit empty filter result. The details show the latest 90 trend buckets, the recent bucket rows, cache read and write totals, and endpoint rows. Cache hit rate uses only requests with cache telemetry. A device switch discards delayed responses from the previous device, and an older host can report totals with an update notice for the activity panel. |
| Log files and diagnostics bundle | `data/DiagnosticsSettingsPage`, `crash_diagnostics` | ported for the runtime half (`src/diagnosticsStore.ts`: `get_runtime_logging_info` answers the effective level, the folder this run writes to, the `app.log` path and, when the host detected one, the previous run's ending — the category is shown as words, and the folder that still holds that run's log is named beside it, so a crash is visible instead of being a file nobody opens. `Open log folder` and `Export diagnostics bundle` run `reveal_in_explorer` and `export_diagnostics_bundle`, and the exported path is revealed and stated. Field names are read in both camelCase and snake_case because this command's shape comes from a Rust struct rather than a hand-written payload. The level and the sensitive-payload switch stay config and live in the `Diagnostics` group above; a host without the command renders the section as "reports no log location" instead of an error) |
| External import | `scenes/ecosystem-compatibility` | partial (`src/externalImportStore.ts`: `get_external_source_discovery_snapshot` with the `get_external_source_control_snapshot` → `get_external_source_snapshot` fallback for older hosts, the automatic-discovery switch through `update_external_integration_policy_command` (`set_automatic_discovery` against the read `preferenceRevision`), the source list with scope and health and the command/tool/subagent/MCP counts, MCP import through `plan_external_mcp_import_command` / `apply_external_mcp_import_command` per item or all ready items with the `stale` outcome replacing the preview, and removed source sessions through `list_removed_external_sessions` / `restore_removed_external_session`. A remote workspace sends none of the workspace-scoped commands and says why; an older host is told apart from an empty one. The application selector uses the shared tab controls and main's offline product marks. Each app shows its own catalog based on host source keys, session discovery preference and removed sessions. Single and batch MCP imports require confirmation, including plans from older hosts without source attribution. The review shows the proposed native destination and safe catalog details. An invalidated plan refreshes the review and requires a new confirmation. Batch results show the native IDs the host acknowledged. Manage copy opens the MCP settings page. Undo matches each copy by its persisted source candidate, requires exactly one match, and removes only checked copies with a single fingerprint-checked write on the owning device. A changed document requires a new review. The source configuration is untouched. Candidates without source attribution stay in a separate group when the host also reports attributed candidates. Discovered skills use the host’s direct availability contract, matching `main`. Claude Code and Codex Hook copies use exact command and dependency review, refreshed plans after a stale fingerprint, and revision-checked enable/disable and removal. Hook batches review checked sources together, display each outcome, and require a fresh confirmation for changed commands. Batch removals use successive revisions returned by the host and stop if the revision changes independently. The instruction source catalog lists app-specific and shared files with scope and conditional path patterns. Older hosts distinguish read-only Hook discovery and unavailable instruction catalogs. The host control snapshot gates per-source enablement, Safe Mode, and local location reveal. Runtime policy uses the same settings rows, tabs, toggles and selects for device defaults and workspace overrides, app mode, capability access and host-reported safety limits. Policy writes carry the owning device's preference revision. A compatible host can reset workspace overrides, and a device reporting an incompatible schema can back up and reset its policy after confirmation. Runtime sources and read-only discoveries share the source list. Mutations use that scope's preference revision and reload after conflicts. On the local native desktop, Codex's bundled and custom pets show previews, copy against a reviewed fingerprint, and activate an independently selected managed copy. Codex and OpenCode show subscription status from their owning device and link to Models → AI subscriptions. Capable hosts expose pending tool, subagent and MCP approvals and external command, tool, subagent and MCP conflict choices. Each review uses the host's preference revision and capability generation where provided. The main and split composers arbitrate native and external prompt commands through the owning host. The runtime inventory shows tool exports, subagents and external MCP servers with their host-reported status. Single-item changes and app-scoped batches carry the reviewed decision keys and the current generation when the host supplies one. Subagent model bindings list host-provided targets and display unavailable saved choices) |

The selected external application's heading includes its source locations and
the shared refresh, import, and undo actions. App-level review groups attributed
MCP entries and Hook commands into one checklist. Each store verifies its own
fingerprint or revision, and the dialog keeps each result visible. A changed
import preview requires a fresh selection. A stale removal requires reopening
the review.

Execution settings follow the tool schema loading, tool calls, timeouts and
subagent groups in `main`. A subagent's default or forked model can inherit the
parent, use a role or configured model, or use a pool advertised by the selected
device. The typed selection is written to one host-owned leaf. A host predating
model routing uses its legacy fixed or inherit shape, and a stored selection
with a missing target remains visible. Model override permission follows the
host capability, and malformed tool argument repair uses the runtime's Boolean
preference. The adaptive review launch owns its concurrency bounds. The current
runtime uses verified inline figures and retains historical GenUI rendering.

`get_configs` is all-or-nothing: one unknown path fails the whole call. The NSH
scene therefore reads each path on its own and treats the paths the React
preload marks optional as optional, so a backend that lacks one of them still
renders the rest of the page.

`Keyboard shortcuts` edits `app.keybindings` (wave 22): the shell binds its
shortcuts by the desktop registry's ids (`SHELL_SHORTCUTS` in `App.tsx`,
listed in `src/shortcutsStore.ts`), so an override written here rebinds the same
action in every front end that reads the document. The background-session close
confirmation is a `localStorage` preference of the desktop's own panel, which has
no counterpart here at all.

### Terminal

The terminal takes its font, cursor shape and scrollback limit from the workspace
device's saved settings. A scrollback limit change rebuilds the renderer and
replays its buffered output over the same shell session. The buffer and the host's
history retention still bound replay. A discovered shell matching the device's
saved default is selected for new local shells, with explicit toolbar selections
and profiles taking precedence. SSH workspaces use the remote login shell.

| Feature point | React owner | NSH status |
|---|---|---|
| Shell session lifecycle | `tools/terminal` | ported (`terminal_create`, `terminal_write`, `terminal_resize`, `terminal_close`) |
| Output streaming | `tools/terminal` | ported (`terminal_event` with `Data` / `Exit`, plus a `terminal_get_history` replay on attach. `terminal-output` is a different, remote-stream notification that carries no bytes: subscribing to it left the widget blank) |
| Tabs and multiple terminals | `content-canvas` | ported (`terminalStore` keeps one tab per host session with its own scrollback, so a background shell's bytes are kept but not drawn; `New shell` opens another, a tab press redraws its own buffer, a tab close closes the host session and falls back to the last remaining shell). Driven in the real window: `New shell` moved the header to `2 shells`, the tab strip listed both, and `Close` removed one |
| Shell profiles and detection | `tools/terminal` | done (`terminal_get_shells` fills a `Shell: <name>` picker with the shells the host reports and skips the ones it marks unavailable; the choice is what `New shell` starts — `shellId` when the host names one, plus `shellType` for a plain enum name, because a `Custom("...")` debug name cannot deserialize back — and it persists in this app's `Storage` so the next launch starts the same shell. The `Profiles` panel keeps named profiles per workspace root: a shell plus an optional startup command, saved in this surface's own `openbitfun.nsh.terminal-profiles.v1`. Opening one starts that shell under the profile's name and types the command into it. The desktop's `manualTerminalProfileService` entries are **not** reused, because they bind a profile to a chat session and this surface's tabs are host terminal sessions; writing there would hand the desktop records it cannot resolve). Round-tripped in the real window: `Save profile` reported `Saved Terminal 1`, the profile was still listed after the app restarted, and `Open Terminal 1` started a third shell whose tab reads `Terminal 1` and whose startup command ran (`echo profile-ok` printed `profile-ok`), so the write path reaches the PTY with its newline. Pressing Return inside the widget itself is the part automation cannot drive; see the verification note below | |
| Shell title | `tools/terminal` | ported (the host's `terminal_event` `TitleChanged` and the widget's own `onTitleChange` both reach `applyTerminalTitle`: a tab started without a name follows the title the program sets — `vim notes.md`, an ssh host — and a tab a profile named keeps that name, so a saved profile is not renamed by whatever runs inside it) |
| Command links and decorations | `tools/terminal` | blocked by the widget (ANSI colors, bold and reverse video come from xterm's own parser behind `Terminal`, so the decorations a shell emits are drawn; a press on a link in the output is not reportable: `Terminal` exposes `onData` / `onResize` / `onTitleChange` and write/reset/focus methods, and `onLinkPress` belongs to `TextView`, not to the terminal. The desktop surface resolves output links itself — an `https:` URL opens externally, a workspace path opens in the editor, and `ssh://` / port-forward URIs consult saved connections — so its behavior cannot be reproduced without a link hook, and inventing a side list of scraped URLs would not be the same interaction. Re-checked at build 76: the widget gained `onTitleChange` in the meantime but still has no link hook, so this stays blocked until it offers one) |

### Files (management & live preview/editing)

| Feature point | React owner | NSH status |
|---|---|---|
| File tree & breadcrumb bar | `tools/file-explorer` | ported (`explorer_get_children` at the workspace root with interactive breadcrumb folder navigation) |
| Lazy directory loading | `tools/file-explorer` | ported (a directory is read the first time it expands; children are cached per path and dropped after a mutation there) |
| Create / rename / delete / paste | `WorkspaceAPI` commands | ported (`create_file`, `create_directory`, `rename_file`, `delete_file`, `delete_directory` with recursive delete behind `InlineConfirmBar`, and `paste_files` for the clipboard's files) |
| Search (files, contents) | `search_*` commands | ported (`search_files`; `Names` matches file names, `Contents` greps inside files and lists one row per matching line with its preview, and a hit opens in the preview) |
| Git decorations | `tools/git` | ported (`git_get_status` on the workspace root: a `Changes n` strip over the tree names the branch, lists each changed path with its porcelain letter and opens that file's diff; a workspace that is not a repository simply stays undecorated) |
| Pull request review panel | `app/components/panels/review-platform` | Partial. Git > Pull requests uses the workspace owner's existing review-platform snapshot, detail-page, and check-log commands. The panel shows repository remotes, supported state filters, pagination, overview, file diffs, checks, commits, and comments in both full-width and inspector layouts. A number targets the current remote, and a PR or merge request link resolves only against a known workspace remote, so a pull request can open outside the provider's default list. Add to chat keeps the main-format capsule and evidence in the focused chat on that workspace and runtime. The authentication dialog reads the selected remote's reported credential state and permissions, saves or explicitly clears a non-GitHub token on the owning runtime, then refreshes the list and previous detail. GitHub uses CLI sign-in on the owning runtime. The in-process owner or a runtime advertising the host-terminal workspace capability opens its own terminal even when the workspace is on SSH. The command is copied for the user to paste. Clients use the copy path when that capability is unavailable. Review starts an ordinary read-only child from the focused chat in that workspace. The owning desktop revalidates the selected provider and revisions using the registered workspace root, refuses stale selections, and keeps retries bound to the same child. The frontend opens the review beside its parent when there is an available split pane. Fleet controllers require the advertised launch capability. SSH launches are explicitly unavailable. Review history reads the owning runtime's saved runs for the exact provider repository and PR. It displays execution state, match with the loaded commits, and the stored report outcome, including finding count, risk, coverage, and an assessment excerpt. It opens a run without relaunching it, and offers the active Review of the current commits for reopening. The latest completed or interrupted run of a complete record offers re-review against the freshly validated PR, with older revisions reopenable directly. Older runtimes keep ordinary Review until they advertise linked revisions in the history response. |
| Paste from the clipboard | `pasteClipboardFilesToWorkspaceDirectory` | ported (`Clipboard.readFiles` gives the OS file list as `file:` URLs, `paste_files` copies them into the selected directory and the tree refreshes; the host refuses a remote workspace because the remote provider has no copy primitive, and that message reaches the notice instead of a silent no-op) |
| Plain text & code preview + live editing | `tools/editor`, `Editor` | ported (syntax-highlighted `Editor`, `Edit file` / `Save file` / `Discard edit` for `"code" | "text"` files persisting through `write_file_content` with `expectedHash` via `src/fileStore.ts`) The source editor's line and column status opens Go to line in wide and compact panes. A line or line:column moves the native caret without writing the file, and the editor's Mod+G opens the same control. The status bar selects a native language mode and one to eight spaces or tabs per indentation level. The controller keeps those overrides with the open tab and isolates them by workspace. Resetting indentation uses the owning device's Editor settings. When enabled, the same Monaco 0.52.2 indentation heuristic as main samples the loaded file. It preserves explicit settings on older hosts that omit the switch, and typing in the draft never overrides the detected mode. |
| Markdown documents (`MarkdownEditor`, meditor IR/Source) | `tools/editor/meditor` | partial (`src/ui/markdownEditor.tsx`, shared by the Files pane, the persona documents and the SKILL.md preview. The Files pane and persona documents share a `Toolbar` with Preview, Rich text, Source and Copy Markdown. Copy uses the current Markdown draft. Rich text uses NSH's native `RichEditor` (StarterKit + tables), parsed from the file's Markdown and serialized back on every change, saved through the same `write_file_content` path with its conflict and changed-on-disk banners; Preview keeps an unsaved draft. A workspace content search result scrolls to and briefly highlights the matching rich text block, or reveals the physical source line if the region cannot be located in the rich document. A fidelity guard opens a file the visual editor cannot write back unchanged (front matter, raw HTML, reference links, `*` bullets) as source with a notice. Selecting Rich text from Source checks the current draft again before entering the rich editor. Inline AI opens from Space in an empty top-level paragraph, the file menu, or a selection. The floating panel is anchored in the rich editor's scrolling content layer and shares the menu surface style. It follows the original paragraph without moving the document. The viewport constrains the panel, and insert and discard stay visible while a long response scrolls. Continue writing, Add summary, and Add to-do list use `editor_ai_stream` on the document's device. Stop calls `editor_ai_cancel` there. Insert and Replace selection apply at the original anchor. A changed or ambiguous anchor keeps the suggestion available without writing it into the document. Mermaid blocks and `$$` formulas render in a web view island where the client shows web views. The renderers are the app's own assets (`src/nsh-ui/assets/vendor`: Mermaid 10.9.1 and KaTeX 0.16.11 byte for byte from their npm packages, KaTeX's woff2 fonts inlined into its stylesheet), read through `?url` + `fetch` only when a document has a diagram or a formula, and used in an isolated document page. The native page disallows network access. On Windows the bundled Mermaid script is injected after the in-memory page loads so the HTML stays below the WebView2 size limit. The browser loads the renderer and its drawing entry point from the same-origin UI bundle. The sandbox receives the diagram as data and works with the browser gateway's strict content security policy. nsh ships only files inside an app's directory (symlinks are resolved and refused), so each entry registers its own copy in `src/documentRenderers.ts`: the web build from the thin entry `src/nsh-ui/WebApp.tsx` (every `nsh package … --target web` path uses it), and `src/apps/desktop-nsh` / `src/apps/mobile-nsh` from gitignored copies that `scripts/sync-nsh-vendor-assets.mjs` writes before every native build and after `pnpm install`; `App.tsx` alone registers none and shows the source. A browser gets the files from the device's UI bundle and the content-addressed pool. They add 3.98 MB raw to the native UI and 6.40 MB to the web bundle with its `.br`/`.gz` siblings (1.08 MB over the wire with brotli); the main JS bundle is unchanged. Source is visible while the bundle assets load. The 8 s drawing timeout starts when those assets are ready, and the source stays available on failure. Inline `$…$` uses NSH's built-in typesetter, follows the shared prose color, wraps with the paragraph, and keeps its TeX when copied. An unsupported expression stays readable as code. Display formulas retain their KaTeX island, including in nested blocks. The source editor handles formula edits. The Files and persona editors resolve relative images through the document workspace and its owning device in both Preview and Rich text. The view fits images to the reading column and keeps the decoded bytes separate from the Markdown source. Rich text can change an image's path, alternative text, and title in one edit. The workspace watcher covers changes on disk between saves) |
| Plan documents (`.plan.md`) | `tools/editor/components/PlanViewer` | Files preview shows the plan name, Markdown overview and to-do status. To-do edits join the same file draft as visual body edits. Visual edits preserve YAML front matter and malformed metadata can be repaired in Source. Build rereads the saved plan on its owner and submits to the open session of that workspace. It follows the host turn on that device. Transcript plan cards use the same UI components and Build state for streamed `Write`, saved plans, and legacy `CreatePlan`. They reveal the overview and to-dos, open or refresh the saved file on its owner, and copy runtime plans into the project through a create-only write. Build submits to the transcript's own session, including when it is in the secondary pane. |
| HTML preview | `HtmlPreviewPanel` | ported in the Files pane (Preview \| Source: a script-free, incognito `WebView html` of the file's text where the client shows web views; "Open in browser" runs `open_html_file_in_browser` only in the desktop app for a local workspace of the same device) |
| Reopen a text file with an encoding | Editor status bar | The same seven choices as main are available through a shared menu in both pane sizes. The workspace owner decodes the file and returns its original byte hash through `read_file_content` with `textEncoding`. Older runtimes still return the legacy string. A confirmed conversion to UTF-8 keeps the checked-write guard, and an existing UTF-8 BOM is preserved. |
| Image preview | `ImageViewer` | Files and its full-screen lightbox share the design-system toolbar. It shows the filename and, when there is room, the original dimensions and size. The preview uses a theme-aware transparency grid, steps zoom by 25%, rotates in 90° steps, and takes the current zoom and rotation into full screen and back. `read_file_content` fetches the image bytes once from the workspace owner. Download uses those original bytes on the viewing desktop or browser. The phone shares them through the system share sheet, with an 8 MiB staging limit from the mobile filesystem bridge. |
| Video preview | `Video` | ported (same base64 data URL, native controls, muted start; verified in the real window) |
| PDF preview | `PdfViewer` | The packaged desktop, browser and phone share the design-system reading toolbar and PDF.js renderer. The workspace owner sends the original bytes through `read_file_content` in base64. An isolated page receives those bytes in chunks and uses packaged character maps, fonts and image decoders. It sizes pages individually, rasterizes near the viewport, and exposes text selection when the PDF permits copying. The toolbar jumps to a page, steps or presets zoom, fits the width and rotates the view. Password prompts and errors stay in the viewer. |
| LaTeX editor and PDF review | `LatexEditor`, `pdf-review` | Partial. `.tex` tabs reuse the Files editor and show the generated PDF beside the source or in a separate pane on compact screens. Compile saves pending edits and uses the selected engine and root file (including a `% !TeX root` hint). `compile_workspace_latex` runs on the workspace owner with its installed `latexmk`; fleet clients require the advertised capability. The tab retains its options, build log and in-memory PDF while switching documents. Auto-compile saves changes before building. A failed rebuild keeps the last PDF. The source toolbar jumps to LaTeX headings and inserts the eight writing templates with native undo and keyboard navigation between fields. When a selection starts in the preamble, the template goes at the start of the document body. PDF files and compiled LaTeX previews share the review toolbar and thread panel. The Windows comment dialog suspends the PDF WebView while it owns keyboard focus. The original v1 sidecar format stores geometry in PDF page coordinates, keeps additive fields, and uses checked writes on the workspace owner. Workspace revisions require an explicit reload or replacement. Compiled previews use the root `.tex` path for the sidecar and prompt for layout confirmation when the PDF fingerprint changes. Annotated copies use standard PDF annotations and the compatible embedded thread data. Reopening a copy restores editable threads and removes prior OpenBitFun appearances from the rendering copy, preserving unrelated annotations and form fields. Save to workspace uploads to the owning runtime and replaces only the checked destination version. Controller export uses the native save dialog, browser download, or phone share sheet. Encrypted PDFs keep sidecar editing and expose a disabled copy action. |
| Built-in browser (wave 22 P2) | `app/scenes/browser` (`BrowserPanel`, `browserInspectorScript`, `HtmlPreviewPanel`) | ported: `src/scenes/BrowserScene.tsx` full width and as the inspector's fourth tab (Changes, Files, Terminal, Browser); a page the open session's agent opens presents there (`src/browserSession.ts`). ⋯ "Pick element" runs a picker in the page through the `browser.evaluate` result channel and puts `#element \`path\` “text” (url)` into the composer, nothing sent. A local `.html` path or `file:` URL in the address field previews through `read_file_content` (remote workspaces route there) in its own incognito web view, with "Open in default browser" only for a file on this desktop. A phone, a browser or another desktop gets a read-only live view: `browser_webview_capture_preview {conversationId}` (now `Proxied`) answers a script-free copy of the page's document (`status: "snapshot"`; also `noPage`, `tooLarge`, `unsupported`), drawn with scripts off and presses blocked, read about every 2 s only while the view is on screen and the app is in the foreground; an older desktop (label-only request) gets an update sentence. Settings › Device › Browser and desktop control shows the user's own Chrome or Edge (`browser_control_get_status` / `enable_default_cdp` / `launch` / `disconnect` / `restart_with_cdp`, `src/browserControlStore.ts`, `src/ui/externalBrowser.tsx`). Not ported: pixel screenshots (NSH has no web view snapshot API), occlusion handling beyond the menus |
| Oversized media & binary files | `file-viewer` | files over 32 MB are not read into base64; binary files state that the format has no preview |
| Diff review | `DiffView` | ported (`git_get_diff` for one path, rendered by `DiffView` from its unified patch) |
| Workspace Review launch | `flow_chat/services/ReviewService` | The session action and composer commands use `launch_review`. Ordinary Review uses one read-only reviewer for up to 80 files and bounded read-only batches above that size. The shared launcher displays the host's file list and reports planned and deferred coverage before start. Strict Review stays an explicit choice. The Review session shows live reviewer waits above the composer in either pane. It restores queue state from the session owner's active-turn snapshot and offers pause, continue, skip optional and cancel queued reviewers while the owner reports live controls. An older host can still refuse an oversized ordinary target and let the user narrow it. The composer accepts `/review BASE..HEAD` and `/review commit REF`, including strict Review. Both phases route to the session owner, which resolves the refs to commit IDs and refuses changed refs, three-dot ranges and mixed file scopes. Historical or dirty checkouts use the immutable diff with limited workspace context. The saved chat Review card displays both commit IDs. Refused commands stay editable in the originating composer. An older owner prompts for a host update when a range is requested. SSH workspaces return an explicit unsupported response. |
| Review progress and checkpoint recovery | `flow_chat/deep-review/action-bar` | Both session panes show the current review turn's launched checks with their recorded outcomes. The progress dialog reads a shortened tool result whole from its owning device when opened, including saved partial results after a timeout. The submitted report takes over once accepted. Recovery uses the interrupted turn's saved execution generation and routes to the pane's session owner. Structured provider failures show localized reasons, replay constraints and copyable diagnostics. The runtime's model recovery hint opens Models settings on the owning device. A report with confirmed incomplete packet coverage can prepare a scoped Review for workspace changes or the original Git commit pair. The owning device revalidates the displayed scope on confirmation and opens a child Review linked to the original result. Provider pull requests use full re-review. |

### Git

| Feature point | React owner | NSH status |
|---|---|---|
| Repository probe, trust recovery & agent init | `tools/git`, `git_api` | ported (`GitScene` + `src/gitWorkbenchStore.ts`: `effect`-gated `git_is_repository` and `git_get_repository_trust`; handles `trust_required` with `git_trust_repository` + manual command fallback, and `not_a_repository` with `Initialize with Agent`) |
| Working copy, AI commit message, Discard & unified diff | `tools/git`, `git_agent_api` | ported (`git_get_status` split into `Staged`, `Unstaged`, `Untracked`, `Conflicts`; `git_add_files`, flat `git_reset_files` (`staged: true` unstages; `staged: false` discards tracked/conflict edits, with `delete_file` for untracked), `git_commit` with `Amend` toggle, `git_pull`, `git_push`, `quick_commit_message` with `generate_commit_message` fallback, and `<DiffView>` per file) |
| Branches, commit history graph & Worktrees | `tools/git` | ported (`git_get_enhanced_branches` with `git_get_branches` fallback, `git_checkout_branch`, `git_create_branch`, `git_delete_branch`, `git_get_commits`, plus `git_get_graph` and `Worktrees` tab (`git_list_worktrees`, `git_add_worktree`, `git_remove_worktree`) on local workspaces — skipped with an explicit notice on remote workspaces; supports `{ compact?: boolean }` `AuxPane` layout) |

### Remote Workspaces & SSH

| Feature point | React owner | NSH status |
|---|---|---|
| Workspace icon and file transfer (wave 22) | `WorkspaceIcon/*`, remote transfer | ported (`src/ui/workspaceActions.tsx`: the workspace ⋯ menu's Change icon… offers the glyphs `get_workspace_icon` lists in `supportedGlyphs` and saves with `set_workspace_icon` against the revision read (colors are not drawn, so the record keeps its own; a device without `supportedGlyphs` says to update). Upload/Download for an SSH workspace call `remote_upload_from_local_path` / `remote_download_to_local_path` with `upload_progress` / `download_progress` and `cancel_transfer`, offered only where the connection's machine is this window's (a local path means nothing elsewhere)) |
| New Workspace Wizard | `app/components/NewProjectDialog` | ported (`NewWorkspaceModal` in `src/ui/SshWorkspaceModals.tsx` + `src/sshRemoteStore.ts`: Personal Assistant creation via `create_assistant_workspace` and Local/SSH/Docker/WSL Project Workspace creation via `create_directory` + `open_workspace` or `remote_create_dir` + `open_remote_workspace`) |
| SSH Connection Manager, `~/.ssh/config`, Docker & WSL | `features/ssh-remote` | ported (`SshConnectionModal`: saved profiles, `ssh_list_saved_connections`, `ssh_save_connection`, `ssh_delete_connection`, `ssh_has_stored_password`, `ssh_connect`, `ssh_disconnect`, `ssh_is_connected`, `ssh_get_server_info`, `ssh_test_connection` stage reports, `~/.ssh/config` `ssh_list_config_hosts` / `ssh_get_config`, `ssh_list_docker_containers`, `ssh_list_wsl_distributions`, and `SshAuthPromptModal`) |
| Remote File Browser & Port Forwarding | `features/ssh-remote` | ported (`RemoteFileBrowserModal`: POSIX `remote_read_dir`, `remote_exists`, `remote_create_dir`, `remote_rename`, `remote_remove`, `open_remote_workspace` / `remote_open_workspace`, rebind conflict handling, `remote_close_workspace`, `remote_remove_workspace`; `PortForwardModal`: `ssh_list_port_forwards`, `ssh_list_remote_listening_ports`, `ssh_start_port_forward`, `ssh_stop_port_forward`) |

### Spaces

| Feature point | React owner | NSH status |
|---|---|---|
| Space catalog, worker lifecycle & source inspection | `scenes/miniapps`, `MiniAppAPI`, `MiniAppShortcuts` | Partial. `SpacesScene` loads the scoped `list_miniapps` catalog and `miniapp_worker_list_running` status. Apps and Market share a responsive search, category and sort toolbar and the catalog card. Apps joins installed records to published summaries by their recorded listing IDs in batches independent of the Market page and its filters. Apps searches local and marketplace names, descriptions and tags, including localized copy. The other devices' catalog entries remain searchable by their available names and descriptions. Apps defaults to download order when marketplace rankings are available and also supports rating and newest. Ranking orders put cards with published summaries first. Newest uses each listing's publication date or the local app's creation date. On an older runtime or unavailable market service, installed apps remain accessible in newest order. Fleet clients check `miniapp_market_summaries_v1` on the selected runtime. Apps marks an update when the summary's latest release exceeds the installed release. Cards with a summary open the listing. The card menu opens the installed details, and its play button launches the installed copy. Other cards open installed details. Search, category and sort survive detail navigation and reset on device or backend change. Market sorting uses the host's catalog query. Installed details show the localized manifest, version, source, permissions and status, plus the original showcase artwork for supported built-ins. It offers launch, pin, source inspection and supported window and worker actions. The installed card menu adds the app to the OS. The installed detail reads its system launcher status and offers add, update, remove or retry using the existing `miniapp_presentation` command. Exports reuse the catalog glyph and the running instance's workspace when present. Removing an export keeps the Space, its data and running work. The command stays on the local desktop. The UI gates it in a remote workspace, while viewing another runtime, or in a browser or phone. The desktop development build stages the lightweight MiniApp shell beside the runner. Market listings use the same in-pane detail layout, use the manifest locale fallback for card and detail copy, and show category, review status, version, author and source access. The screenshot gallery loads one WebP at a time. `miniapp_market_read_screenshot` takes the digest and reads only the configured market through the runtime’s existing public image cache. The controller renders the received bytes and reuses them while the listing is open. Missing host support and download failures have explicit states. Market details preserve the existing account, permission and overwrite confirmation flows. Open starts the installed copy on the selected device through the inline Space route, and leaving the running app returns to the listing. An installed listing offers the same pin and supported desktop-window actions as the installed page. Manage opens the current runtime's installed record. Conversely, a marketplace install can open its listing by its recorded listing ID and return to the same installed details after updating. Fleet clients check the selected runtime's `miniapp_market_listing_id_v1` capability. The slug route remains available for older clients and market servers. A controller can use that route when this runtime already browsed a listing with the same ID, and it checks the returned ID before showing any actions. Back to listing retains the selected screenshot and listing state and restores keyboard focus to Manage. A successful uninstall returns to the listing, reconciles install and catalog marks, and removes that device's pin. A refused uninstall leaves the pin and installed record in place. Back restores the originating catalog position and card focus. Market pages, installed origins and detail receipts are scoped to the selected device and backend. Installed and account catalog reads and worker and delete receipts apply only to the captured device and backend connection. Spaces can open a separate window through the desktop shell. The inspector reads `get_miniapp` and `get_miniapp_versions`, and the menu can stop the worker or confirm `delete_miniapp`. Create with Agent starts a Creative session. Installed Spaces can be pinned from their card or page menu. The sidebar and the phone's Sessions list show the current runtime's shortcuts in pin order and use the same inline Space route as the cards. Unpinning changes the controller's navigation preference, using the main navigation's persisted shape. Empty or failed reads leave the pins intact. |

## Capabilities outside the NSH UI

All 12 primary scenes are implemented in `src/nsh-ui`. What the native desktop does
not offer, and how it says so:

| Capability | State in the native desktop |
|---|---|
| Interactive MiniApp windows & hosted `pages` | Independent windows through the `openbitfun-miniapp-shell` sidecar; in-product tabs are refused (`kind: tab`) |
| Desktop cards & companion pet window | The desktop opens native floating windows (`desktopPresence.tsx`). Cards also render inline on every client. Both placements use the same bar, column, line, donut and stacked chart renderer, with localized labels and values, legends and totals from the saved template, and Canvas for line and donut shapes. The pet is "Desktop only" on phones and browsers. The pet's look-at-pointer frames remain pending. |
| `ecosystem-compatibility` account capture, pets and per-application pages | Discovery snapshot, MCP import and removed-session restore are in `Settings → External import`; account capture and pet handling use desktop-only adapters |
| In-place updates on Windows/Linux | The updater reports that in-place install is not available yet; macOS installs in place |

## Toolchain & setup

The native desktop runner (`src/apps/desktop-nsh/native/Cargo.toml`) pins the
`nsh-*` crates to `=0.7.1` and declares `rust-version = "1.97"`. The matching
pinned NSH CLI (`v0.7.1`, SHA-256 verified against `scripts/ci/install-nsh.mjs`)
is installed automatically by `pnpm install`:

- `pnpm install` runs `node scripts/ci/install-nsh.mjs --postinstall`, which
  reuses an existing matching `v0.7.1` installation if present or downloads the
  pinned release archive into `~/.nsh/bin`, then links/shims it into
  `node_modules/.bin/nsh`.
- All `pnpm run ...` scripts (`desktop:dev`, `desktop:build`, `e2e:ui`,
  `desktop-nsh:*`, `mobile-nsh:check`) and `pnpm exec nsh ...` resolve
  `node_modules/.bin/nsh` automatically without editing your shell `PATH`. To
  run bare `nsh` commands directly inside `src/nsh-ui`, add `~/.nsh/bin` to
  `PATH` (`export PATH="$HOME/.nsh/bin:$PATH"`).
- To install or repair the pinned CLI manually, run `pnpm run nsh:install` (or
  `node scripts/ci/install-nsh.mjs`). Set `OPENBITFUN_SKIP_NSH_INSTALL=1` to
  opt out during `pnpm install` (for offline or non-NSH work); CI postinstall
  skips downloading automatically because CI jobs that need NSH invoke
  `node scripts/ci/install-nsh.mjs` in their own step.
- Development and packaging use the active Rust toolchain. Cargo enforces the
  minimum version declared in the native crate manifests. To update an older
  stable toolchain, run `rustup update stable`.

## Verification

Two headless layers plus the desktop-window smoke path are runnable from a
checkout:

```bash
# Using the repo-linked nsh binary installed by `pnpm install` (or export PATH="$HOME/.nsh/bin:$PATH" to invoke `nsh` directly)
pnpm exec nsh check src/nsh-ui
(cd src/nsh-ui && pnpm exec nsh test App.test.tsx)
pnpm run e2e:ui                             # runs App.test.tsx + all test/*.test.tsx suites
(cd src/nsh-ui && pnpm exec nsh package . --target web)
```

The headless suites play the embedding host (`test/support.ts` and local
`openbitfun.invoke` wrappers inside each scene suite), asserting real request
shapes (`{ request }` vs `raw: true`), theme reactivity, remote/Peer degradation,
and UI state without starting the desktop binary. The Personal Agent Studio
Tauri 1:1 migration (`sessions-ux`, `personal-hub`, `agents-skills`,
`routines-git-spaces`, `workbench-connectors`, `ssh-remote`) is verified across
`nsh check`, `App.test.tsx`, all six scene suites, `nsh package . --target web`,
`pnpm run capabilities:check`, and `pnpm run check:repo-hygiene`; real-window
interactive observation notes below reflect the prior MVP desktop-window runs.

Real-host smoke (the native app on a real backend):

```bash
pnpm run desktop:dev                     # build and run the native app
node tests/e2e/native/smoke.mjs --profile desktop-dev # package-free smoke over the loopback OBP owner connection
pnpm run desktop-nsh:package:mac -- --profile release-fast && pnpm run e2e:smoke:packaged
```

History (migration period): the steps below drove the NSH web target inside the
retired Tauri window (`transport: tauri`); they are kept as the record of those
observations and no longer apply.

The dev server is not the only way, and here it stopped being a reliable one: in
this environment the page `nsh run` serves did not load in the desktop webview (the
window kept whatever bundle it had, and a `nsh.json` build bump plus a reload did not
replace it). The channel that does work is the packaged site over plain HTTP. The
desktop build from `tauri.nsh.conf.json` loads `devUrl`, so pointing that port at
`frontendDist` serves the packaged output to the real host, which is closer to what
ships:

```bash
cd src/nsh-ui && nsh package . --target web
cd src/nsh-ui/.nsh/out/OpenBitFun && python3 -m http.server 8790
# then start the desktop build against it, with its own profile so the user's
# installed app and its data are untouched
OPENBITFUN_NONINTERACTIVE=1 \
OPENBITFUN_HOME="$PWD/.openbitfun/desktop-nsh/home" \
OPENBITFUN_USER_ROOT="$PWD/.openbitfun/desktop-nsh/user" \
  ./target/debug/openbitfun-desktop
```

The badge reads `transport: tauri` there too, so it is the real host, and a rebuild
is `nsh package` plus a window restart rather than a hot reload.

Scenes driven in that real window so far (macOS, desktop channel `development`):
sessions and their turns, the workspace chips, the file tree with Markdown and
plain-text preview, the Settings values (`editor`, `terminal`, agent execution,
tool permissions, logging level) with a `set_config` round trip verified on disk,
the lazy explorer over a real workspace directory, a real `.rs` file opened in the
code editor, a terminal session the host created whose prompt now renders
(`terminal_create` returned an id, the status line reads `running`, and the widget
shows `user@host workspace %`), an image preview (a workspace PNG
rendered through `read_file_content` with `encoding: "base64"`), and a video
preview (a workspace MP4 playing in `<Video>` with the platform's own controls, and
its duration read from the data URL), the Settings `AI models` section (the host
reported `ai.models = []`, so the section said so), and one `ai.models` write
round trip performed by temporarily driving the store from the app: the host
stored the appended entry, normalized it (`provider`, `model_name`, its resolved
`request_url` and its key all came back intact), and the removal left
`config/app.json` byte-identical to before. Driving a button inside the webview is
still unreliable: AX presses reached the sidebar but not the in-scene controls, so
the model form, clipboard paste and clipboard attachments were exercised headless.

The light scheme was driven in that window: `Settings → Appearance` renders the
`System` / `Light` / `Dark` chips and the scheme line under them
(`Showing the dark scheme` on this dark host), and because a press on an in-scene
view does not land in this capture session, the switch itself was applied by a
temporary startup call — every panel, the sidebar, the chips and the composer
repainted light. Removing that call and reloading kept the light scheme, which is
the persisted `openbitfun.nsh.appearance.v1` being read back at launch.

The font baseline was driven there the same way, and it is the one appearance
setting that reaches the host (build 56): pressing `Large 16` on the Appearance
section's size chips repainted the whole surface at the larger size in place — the
Settings page's own rows, the sidebar, and after switching scenes the session list
and composer — and `config/app.json` then held `"font": {"uiSize": {"level":
"large"}}`, the document and shape the desktop writes, with the neighbouring
`app.flow_chat` keys intact. A restart drew at 16 px from the first frame, because
the document is read before the first scene renders. The chips, the `−1` / `+1`
stepper and `Reset` write the same shapes the headless tests pin; a press at 12 or
20 px is refused by the surface rather than sent as a no-op write.

The content width row was checked in the real window in build 59: `Settings` drew
`Content width` with `900px · the transcript column, shared with the desktop
surface`, the `-` / `900 px` / `+` stepper, `Reset` and `Narrowest 600px`, and the
session scene's transcript and composer both sat in a 900 px column centred in the
wider right pane instead of stretching to its full width. The stepper, the floor and
the persistence are headless-verified — a fixture preloads `1100` and `120` under the
desktop's key, so one run opens at the stored width and steps it to `Reset`, and the
other proves a value below the floor reads as unset.

The packaged site in that window is the run where the in-scene presses do land, and
it settled the terminal end to end:

- The prompt was invisible at first: `Terminal` draws its cells in the view's
  foreground and paints **no** background of its own, and the scene had a fixed
  `#101214` panel behind it, so in the light scheme every glyph was dark on dark.
  The panel is now the theme's canvas, which is the rule for any widget that leaves
  its background to the host.
- Typed text reaches the shell (`onData` → `terminal_write` → PTY → `terminal_event`
  → `Terminal.write`) and the shell's echo comes back in the same widget.
- `New shell` moved the header to `2 shells` and added a tab; pressing a tab
  redrew that shell's own buffer; `Close` removed one.
- A profile survives a restart of the app, and `Open Terminal 1` starts a shell
  named after it and writes its startup command: the shell ran `echo profile-ok`
  and printed `profile-ok`, so the write path reaches the PTY with its newline.
- Only the widget's own key handling is unverified by automation: synthesized
  `Return`, `Backspace` and arrow keys — foreground `key_chord` and window-directed
  `app_key_chord` alike — never produced an `onData` event, so "press Return to run
  what I typed" could not be observed here. The bytes path behind it is proven by
  the profile command above, so what remains is whether `Terminal` translates those
  keys, which needs a human at the keyboard.
- The shell title (build 76) is headless-verified: a `TitleChanged` event renames a
  tab that nobody named, and a tab opened from a profile keeps the profile's name.
  Which of the two paths a real shell uses — the host's `TitleChanged` or the
  widget's `onTitleChange` — was not driven in the window, because no automation
  step can make `vim` set the title from outside the widget. Build 77 was booted in
  the packaged window and drew its scenes, so the change is compiled into what the
  host loads; only the event's arrival is unobserved there.

Clipboard reads have a platform limit worth knowing before debugging them. NSH's
web target implements `Clipboard.readFiles` / `Clipboard.readImage` on top of
`navigator.clipboard.read()` (`~/.nsh/runtime/web/nsh.js`), and the Tauri webview
does not answer that call even when the system pasteboard holds a converted PNG or
a `file:` URL (measured: a temporary probe inside the window reported
`files=0 image=none` while `osascript -e 'clipboard info'` listed `PNGf`, `TIFF`,
`BMP` and `JPEG` for the same clipboard). Both paths therefore say so in the
composer or file notice instead of failing silently, and their request shapes are
what the headless tests pin. They need a real browser tab, not the desktop shell,
to be observed end to end.

The session marks are headless-verified as a transition, not as a drawing: two rows
start `Not read yet` because the host reports messages for both and neither was
opened, `Waiting for approval` rides on the one session the seeded prompt names,
opening a session removes its own mark, a `dialog-turn-started` for the *other*
session marks that row `Running` while the open transcript keeps its own turns, and
a failed event replaces that mark with `Last turn failed`.

Model pools are headless-verified against a fixture that holds them: the section
starts at `No pool yet.`, `Add pool` + a member press + `Create pool` arrives as one
`save_model_pool` with an empty id, an ordered strategy and the configured model's
id, the row that appears is the host's document (its `Ordered · 1 members` line, not
the draft), `Edit` reopens the draft from that document, `Check` prints the status
and reason `get_model_pool_status` returned, and `Delete` sends the pool's id.

One NSH rule surfaced while building that section and applies to every scene: an
NSH component body runs once, so a signal read into a `const` there is a snapshot.
The pool row and its editor therefore read `poolStatuses()` / `poolDraft()` inside
the bindings (`when`, `of`, style values), which is what makes a member press or a
status reply show up without a reload.

The queued-message path is headless-verified. Every composer send is
`submit_user_message`; the host applies `app.flow_chat.send_during_turn` and answers
`started`, `steered` or `queued`, and the composer's secondary mid-turn button sends
an explicit `sendDuringTurn` for that one message. A queued message is a row of the
host queue, so nothing is written to local storage, the row the panel shows comes
back from the host's snapshot, and `Send now` is a `promote` addressed to that turn.
A host without the queue or the command gets an explicit "update the host" state;
there is no local list that drains only while this window is open. Moving a row is the host's too: `Up` /
`Down` re-reads a snapshot first — `supportsReorder` is answered per reply, so
capability is never inferred from a version or remembered from an older one — and
sends `reorder` naming that read's `revision` and the row it must precede (`null`
for last), which the fixture refuses when the revision is stale; a row this surface
holds is swapped in place and persisted. A row the host is holding back keeps the
host's `status` and `reason`, so `Steering` and `Blocked · Waiting: <reason>` are
drawn instead of a row that merely looks idle.

The agent picker is headless-verified on the request shapes, and one press of it was
driven in the packaged window. Headless: the composer's chip reads the agent the
shared preference names (`app.flow_chat` with
`{default_mode_strategy: "follow_last", last_mode_id: "Creative"}` renders
`Agent: Creative`), the catalogue read is `get_available_modes` with the active
workspace's id and path, the panel draws the host's order with the chosen entry
marked and leaves `Claw` out, `New` creates a session with that `agentType`, a
session with no messages takes a press as one `update_session_mode` plus a
`last_mode_id` write and sends its next turn as that agent, a started session draws
the new-session confirmation and writes nothing until it is answered, and a host
without `get_available_modes` shows the notice with `Reload` and still sends a turn.
Real window (build 53, `transport: tauri`): `get_available_modes` answered the four
profiles plus `Cowork` / `Deep Research` / `Claw` / `Paper Writing`, pressing the
chip and then `Ultimate` rebound the session (`update_session_mode`), the header and
chip both repainted to `Ultimate`, `app.flow_chat.last_mode_id = "Ultimate"` landed
in `config/app.json` with the sibling `auto_show_selection_toolbar` intact, and a
restart of the app read it back into the chip. The next packaged build (54) did not
accept any press at the chip in this capture session — the same webview press that
comes and goes elsewhere in this document — so the `Claw` filter in the real window
is unconfirmed and stands on its headless test.

The reference picker was driven end to end in build 55, and it settled a better way
to press a row than a pointer: after a physical press on `Reference` opened the panel,
typing `notes` into it made the host search the active workspace root and answer the
real path (`<workspace>/notes.md`), a second press on the
row did not land, and `Tab` + `Return` did — the focused row reported itself as
`[focused]` in the accessibility tree first, and the press then put
`#file:notes.md ` into the composer with the panel closed, which the composer's AX
value and its own change event both show. That is the route to take for an in-scene
view in this webview: `role="button"` views take keyboard focus where Tab stops, so a
press that a pointer cannot deliver is `Tab` to the row and `Return` on it.

The three settings blocks added with the port are headless-verified through the
`set_config` call each one makes, not only through the text they draw: `AI
execution` writes a boolean, a number and the enum value `ptc_python` that
`ToolPresentationMode` deserializes; `Task models` starts from a fixture holding
`{"Fixed":{"model_id":"model-1"}}` and writes the whole object back, so choosing a
model for the commit task produces both tasks in the host's shape and choosing
`Inherit` produces the unit variant; `Permissions` starts from a policy with one
allow rule, and `Auto` produces `strategy: "model"` with the `fast` approval model
while `Full access` withholds the write until the confirmation is pressed and keeps
the rule list. The rule editor and the approval block are covered by their own
tests: a draft written but not saved leaves `tool_permissions` untouched, saving it
writes the rows in the order they were drawn, a blank resource is refused, the
approval timeout is clamped, and a decision-model key goes to the vault while the
config keeps only the model name and endpoint. Terminal profiles are verified as a
round trip: a profile saved in one run is listed and opened in the next, with the
startup command arriving as `terminal_write`, and a malformed record in the stored
list is skipped.

Detached dispatch is headless-verified for its write path: this capture session has
one machine, so the submit request and the cancel call are checked against a
fixture that answers the three commands, not against a second host that actually
took the job. The read path was seen in the real window — `dispatch_list_targets`
returned this machine as `Local (local)` beside two real SSH hosts (`host-a`,
`host-b`), the first remote target came preselected, and with an empty controller index
the list said `No job in this controller's index yet.` instead of showing a fake
row.

Detached dispatch observation is headless-verified, for the same reason: no second
host can take a job here. What the fixture proves is the read/write contract of the
observer — a page of the target's log folds `jobState` and `TextChunk` events into a
state row and one assistant line, a `ToolEvent` becomes its own row, a pending
`PermissionRequest` is drawn with its action and resources and answered with the
reply kind the protocol expects, a message while the turn runs leaves as
`dispatch_append` and never as `dispatch_continue`, a finished job takes the next
turn with a minted `turnId`, and `Sync result` reaches `dispatch_sync_result`.

Two real command signatures were corrected against the Rust side during that pass,
and both had been hidden by a fixture that accepted either shape: the MCP lifecycle
commands (`start_mcp_server`, `stop_mcp_server`, `restart_mcp_server`) take the
server id as a positional argument rather than a `request` struct, so they now go
through the raw path, while `delete_mcp_server` takes `{ request: { serverId } }` and
`invokeCommand` already wraps its body in `request` — it had been wrapped twice. The
fixture now rejects the wrong shape for each command, so this class of mistake fails a
test instead of silently failing on a device.

The remote OAuth panel was driven in the real window (build 60). One remote server
(`streamable-http`, `oauthEnabled`, no stored authorization) was written into that
profile's `config/app.json` under `mcp_servers.mcpServers` — the value the host reads,
a Cursor-format document rather than a bare map, since a bare map is logged as
`Invalid MCP config format` and rendered as no server at all. With it the row drew
`verify-oauth · streamable-http · https://…` and an `Authorize` chip; the chip's panel
opened at `OAuth status: not started` with `Authorize in browser`, `Cancel
authorization`, the masked authorization field and `Save value` / `Clear stored
authorization`. `Authorize in browser` against a host that cannot answer put the
host's own sentence in the panel — `MCP error: OAuth error: No authorization support
detected` — while the section, the row and the other buttons stayed usable, which is
the degradation this panel exists for. Typing a value and pressing `Save value`
reached `mcpServers.verify-oauth.headers.Authorization` as `Bearer <value>` on disk
and the row's chip then read `Reauthorize`, so `update_mcp_remote_auth` goes through
the bridge with the shape the host expects. The profile was restored afterwards. What
this run did not observe: a successful browser round trip (it needs a host that
advertises OAuth metadata), and `clear_mcp_remote_auth` on the real host — the clear
button and both poll outcomes are headless-verified in the two tests that cover the
panel, including the `failed` outcome and the `Clipboard` fallback when `openUrl`
cannot open the address.

The pasted-configuration import (build 61) is headless-verified only, and the reason
is this session rather than the code: every packaged build after the OAuth run came
up with another application holding the system foreground, so `activate_app` was
refused and no pointer input could be delivered to this window. The test that covers
it pastes a document holding three entries — one this form draws, one whose `args`
are not strings, and one whose id the document already holds — and asserts that
preview reports `3 servers read; 1 cannot be imported by this form`, that only the
drawable and unused entry is written, that it lands `enabled: false`, that the
refused entry never reaches the document, and that the colliding id keeps the
document's own fields (`keepMe`) instead of being rewritten.

The search field (build 67) is headless-verified only, for the same reason. One test
opens it from the sidebar, asserts an empty field lists the commands, types
`terminal` and asserts the three kinds arrive together — the session-name hit, the
host's message hit through `search_session_content` (with the request's
`workspaceId` and `query` checked) — then runs a session hit and asserts the panel
closed and that session opened, and finally runs `>files` and asserts the scene
switched. A second test runs the same query against a host that answers
`Command not found` for the message search and asserts the session hits still
arrive, the refusal is stated, and no message group is drawn. What it does not
cover is the desktop's own federation: the providers for workspaces, assistants,
agents, skills and interactive capabilities are not ported, so a test asserting
those groups would be asserting a feature this surface does not have.

The panel also ran in the real window (build 71), which settled how it is opened.
Typing into the sidebar field is what opens it, so the field is an `Input` whose
focus and first character both open the panel with the caret already in the panel's
field — a button would leave the user to press a second time inside the overlay, and
a `readonly` input collapses to a `button` in the accessibility tree, which is both
unpressable there and unusable as a focus target. Driven that way against a real
host: `notes` typed into the sidebar field opened the panel with `notes` in its own
field, `Files` appeared as a group with the workspace's `notes.md` and its full
path (that file existed only because this run created it, so the row came from
`search_files` and not from anything cached), and the same query in an empty
workspace read `Nothing matches that text in this workspace.` instead of an empty
list. Running a row is the part no automation reaches here: presses into this
webview are dropped and the panel's rows are not keyboard-reachable without a
global shortcut, so that half is covered by the headless tests above.

The transcript copy (build 77) is headless-verified: the test spies the surface's
`Clipboard.writeText`, presses the first block's `Copy` and asserts the clipboard
received exactly the user's message text, then sees the label read `Copied`. The
Markdown body (build 78) is headless-verified the same way: a reply written with a
heading, inline code, a fenced block and a link draws its text and none of its
markers, so the source never reaches the transcript. The
shell title (build 76) is headless-verified in the same document.

The reasoning block (build 79) was a bug a window with a reasoning model would have
shown: notes and answer chunks arrive on the same event, and the surface appended
both to the reply. Two tests hold the fix — a streamed turn whose notes are marked
`contentType: "thinking"` ends with the answer as the only visible text plus a
`THINKING` block that says `streaming`, and a persisted turn's `thinkingItems` draw
a collapsed block with its size that shows its text only when opened.

Following the newest reply (build 80) is **not** verified by either route: the
headless harness has no layout and dispatches no scroll events, and no automation
step can scroll a webview, so `onScroll`, the 32 px end test and the `Latest` chip
have only been reasoned about, not observed. Build 80 was booted in the packaged
window: the transcript drew its column and empty state with no `Latest` chip, so the
effect and the end sentinel run without breaking the layout — which is all that
observation can say.

The inline `@` trigger (build 81) is headless-verified: typing `Explain @readme` in
the message opens the panel with no query field, searches the workspace for
`readme`, and a pressed row leaves the sent message as `Explain #file:README.md` —
the typed token gone rather than left in front of the tag. That test also corrected
an earlier claim in this document: the surface does have a caret, and the note that
said it did not has been removed. It was also typed into the packaged window: the
message read `@readme`, the panel opened under the composer with its inline hint,
the composer kept the focus, and the panel drew no field of its own. That home's
workspace matched no name, so the row press — the step automation cannot deliver to
a webview — is what the headless test stands in for.

`Return` sending (build 82) is headless-verified through the harness's own submit
step, which is what a Return on the field does: with a reference row on offer the
first Return leaves the composer holding `Explain #file:README.md ` and sends
nothing, and the second sends exactly that trimmed. It was also observed in the
packaged window: typed text plus a synthesized Return moved the message into the
transcript's turn error — that install has no model configured, so the host answered
`Failed to start dialog turn: AI client error: Dialog turn model could not resolve a
concrete primary model`, which is proof the turn was submitted rather than that a
line break was inserted. `Shift+Return` staying a line break still rests on the
widget's documented behaviour; the automation route has no chord to hold Shift with
the composer focused.

The reasoning control (build 73) is headless-verified only, for the same reason. One test asserts the
chip reads the session's own default, that pressing a preset sends `update_session_model` with the
pair the host validates (`gpt-4.1-mini` with `reasoningPreset: "high"`, plus the workspace), that the
chip then reads the preset the host accepted, and that pressing `Default` writes an explicit `null`
rather than dropping the field — the host reads those as two different things. A second test runs a
host that refuses `project_ai_model_reasoning_catalog` and asserts no reasoning control is drawn, so an
older host shows the composer it had instead of an empty picker.

The control itself was seen in the real window (build 74), which also settled how the chip
finds its model. That install had no `ai.models` entry at all and the session recorded the
role `primary`, so the panel had nothing to project until it resolved the role through
`ai.default_models` first — the same resolution the desktop's own `normalizeModelSelection`
does. With one model configured under that role (`gpt-5`, whose provider declares reasoning
efforts) the composer drew `Reasoning: Default` between the model and the agent, the host's
catalog command answered with presets, and `get_session_model_target` answered with no preset
for that session, which is why the chip reads `Default` rather than a level.

The shortcut editor (wave 22) is headless-verified (`test/settings-parity.test.tsx`:
a stored override rebinds the shell, Reset writes the document without it and the
default key works again) and was driven on the web target: Change → ⇧⌘P stored the
override and ⇧⌘P then opened Search.

The memory model and window fields (build 65) are headless-verified only, for the
same reason. One test writes a configured model onto the stored `memories`
document and asserts the fields this page does not draw survive the write, then
presses `Follow the primary model` and asserts the stored value is `null` rather
than an empty string the host would read as a model id. It then refuses a
retention drop that would put the extraction window outside the retention and
asserts nothing was written, and finally types a window above the retention and
asserts it was clamped to it. What that leaves unobserved is the live host's own
memory pipeline: the fixture only stores the document, so whether an extraction
really runs with the chosen model is the host's behavior, not this page's.

The MCP resource browser (build 64) is headless-verified only, for the same reason.
One test opens `Resources` on the connected server, asserts the first list is read
with `refresh: false` and that `Refresh` asks again with `refresh: true`, then reads
three entries: a text resource (drawn with its media type), one that answers two
contents (both blocks kept, each naming its URI), and one that answers a `blob`
(reported as binary, not decoded). A filter then narrows the list by URI without a
third read. `list_mcp_prompts` is not covered because no test asserts it: this
surface does not call it, matching the desktop, whose prompts API has no page.

The per-row `enabled` and `Limits` controls (build 62) are headless-verified for
the same reason: one test disables a stored model and asserts the whole-list write
keeps the fields the page does not draw (`api_key`), then refuses a `90000` output
limit against a `200000` context window with the host's own 40% wording and asserts
nothing was written, and finally reopens the form and saves `32000`, so a refused
value cannot survive in the field it was typed in.

The model picker (build 63) is headless-verified only, for the same reason: the
window could not be activated in this session. One test opens `Add model`, asserts
`get_local_models_dev_catalogs` was read exactly once, narrows the list with the
filter, picks `Anthropic` and then `Claude Sonnet 4`, and checks the stored entry
carries the endpoint format, the model id, the base URL and both limits; a second
test runs the same form against a host that answers `Command not found` for that
command and asserts the picker is absent while a hand-typed model still saves with
`context_window` / `max_tokens` as `null`. What that leaves unobserved is the real
catalog's own projection: the fixture is a two-provider document, so a host whose
catalog nests its models or endpoints differently would fail in the picker rather
than in the form.

The usage section was checked in the real window: `Settings` drew `Usage` with the
range chips and the totals the host answered (`0 requests · 0 tokens` in this
scratch profile, which holds no sessions — the point of the check is that the
command was answered at all, since a wrong name or argument shape arrives as an
error line under the heading instead of a figure). The heatmap and the trend chart
are headless-verified: the fixture answers the six-month `custom` read with two
busy days inside any window and one bucket from 2020 outside it, so a projection
that ignored the window boundary would report the wrong total, and a second test
makes that read fail while the range read still answers, which must leave the
totals and the chart in place with one sentence about the window.

The distribution block was then driven in the real window against a scratch
`token_usage` record set (build 58, `transport: tauri`): the section drew
`Model` / `Group`, `Filter these rows`, five model rows with `cache N%` and
`Show all 6`, `By endpoint` listing six `/unknown` rows — the duplicate labels the
positional row keys exist for, all six rendered — and `By day`. `Show all` expanded
the sixth model and turned into `Show less`; typing `gem` collapsed the list to
`gemini-3-pro` and dropped the expand control; switching to `Group` cleared the
filter and restored the full list. The seed records were deleted afterwards, which
is the expected reason the block is absent in an empty profile: it is drawn only
when the host reports a model or a group row.

The Devices scene was reloaded
after the observer landed and still rendered with the real transport
(`transport: tauri`), its real SSH targets and an empty job index, so the panel's
poll and its `cleanup` did not disturb the scene.

User questions are headless-verified only: answering one needs a
model turn that calls `AskUserQuestion`, and this scratch profile has no session to
run. What the fixtures prove is the contract — a question restored from the mailbox
is answered once in the shape the Runtime expects (`{"0": "label"}`), a typed
`Other` answer replaces that label, a multi-select takes several labels, and an
incomplete answer is refused in the panel instead of being sent. One real-host fact
does reach this path: the desktop surface has no command for cancelling a question,
so the panel offers none rather than a press that would do nothing.

A terminal shell picker reads the host's own
`terminal_get_shells` (`Bash`, `Zsh`, `Sh` with their paths on this machine), and a
`terminal_create` carrying `shellType: "Zsh"` came back as a session the host
reports with that shell, so the enum round-trips. The session delete path was
driven in the window as well (`Delete` → in-scene `Delete NSH verify? This cannot
be undone.` → `Confirm delete`), which is how the stale count above turned up.

Reloading the page is enough to re-exercise a scene end to end (`nsh run`'s
server reloads the window when `nsh.json` changes), which is how a scene was
driven without pointer input. Model pools were added after that route stopped
working in this capture session — the window kept its old bundle through a
`nsh.json` build bump and a `Cmd+R` — so the pool commands are covered headless
only; they sit in the same command family as the `ai.models` edits that did
round-trip against a live desktop. A change to `host.js` is the exception: the dev
server compiles the host module when it starts and only rebuilds the app bundle
afterwards, so a renamed or added host function needs the dev server restarted
before the window can call it. Renaming the host namespace to `openbitfun.*`
(the repository rejects the retired short product name) first showed up as
`no host function openbitfun.invoke` for exactly that reason; after restarting
`nsh run` and the window, the badge reads `transport: tauri` and the scenes load
the host's own workspace again.

Bugs this smoke found, all fixed in the code they belong to:

- the transport badge was assigned once instead of read from a signal;
- `get_file_tree` was called with an empty `path`, which the backend rejects;
- `get_configs` failed the whole Settings page when one guessed path was absent;
- the file explorer and the terminal both ran their first load before the
  workspace list arrived, so the explorer showed an empty tree and the host
  rejected the terminal with `Terminal workspace ID is unavailable`. Both now
  wait for the active workspace in an effect instead of loading once at mount;
- the composer and the delete confirmation were built from values read once
  (a non-reactive `disabled`) and from a native `AlertDialog` that leaves the
  UI untestable and unreachable from a remote controller. The composer now reads
  signals inside its bindings, and delete confirms in-scene.
- `nsh/base`'s `Switch` and `Select` lay out at their intrinsic size on
  the web target, so a settings row showed an 8×5 hit area for a toggle and nothing
  at all for a choice list. `SettingsScene` now draws the toggle and the choice chips
  from plain views; `Input` is used for text and secret fields inside a visible box,
  and `Switch` / `Select` stay unused there until upstream sizing is fixed.
- deleting a session left the catalog count in the header unchanged: the row went
  away and the number stayed. The real window showed it after a delete, and the
  row action now lowers the count it already knows instead of waiting for a
  reload.
- `open_workspace` takes `{ path }`, not a root path under another name: the first
  probe sent `rootPath`, the host ignored it, and no workspace was opened.
- a model picker that asked for the catalog with `reportError` raised a failure
  banner on a host that has no catalog to give; the picker now stays on its
  default model silently, which is what an unconfigured workspace looks like.
- an image preview was first drawn with the default `objectFit` (cover), which
  cropped a square PNG top and bottom; the panel now asks for `contain`.
- the terminal subscribed to `terminal-output`, which is the remote-stream
  notification (session id and cursor, no bytes), so the widget stayed blank while
  the shell was running. The bytes travel in `terminal_event` as
  `{ type: "Data", payload: { session_id, data } }`; with that channel the prompt
  (`user@host workspace %`) renders, and `terminal_get_history` covers
  what was printed before the view attached. This one only appeared on the real
  host: a fixture cannot tell a wrong event name from a silent shell.
- the terminal scene had a fixed dark panel behind a widget that paints no
  background, so the light scheme drew dark glyphs on it and the prompt disappeared
  entirely. The panel now follows `palette().canvas`.
- a settings field whose path the host stores nothing for drew an empty control and
  could not be written, and a section whose object was absent read as a failure
  rather than as "the host keeps its defaults". `FieldSpec.defaultValue` now supplies
  the value the host would use, the row says
  `The host stores no value yet; these are its defaults.`, and the first edit
  creates the path.

The Settings round trip is proven against the host, not just the fixtures:
loading the scene wrote `terminal.scrollback` back through `set_config` and the
on-disk `config/app.json` moved 1000 → 1001, which the scene then read back.

The `Input` and `Workspace` groups and the mid-turn policy were read and one of
them written in the real window: the host reported
`app.flow_chat.auto_show_selection_toolbar = true`,
`app.ai_experience.voice_input.{enabled,default_language,max_recording_seconds}`
as `true` / `auto` / `60`, and every `app.worktrees.*` value the worktree service
stores (`rootPath`, `branchPrefix`, `copyLocalChanges`, `autoDeleteEnabled`,
`autoDeleteLimit`), while `Message sending` started on `Steer now` because the host
stores nothing for `app.flow_chat.send_during_turn`. Pressing `Queue` wrote that
leaf (`app.flow_chat.send_during_turn = "queue"` appeared in the file, with the rest
of `app` untouched) and the section redrew with the queue hint; pressing `Steer now`
put it back and the host dropped the key again, because `immediate` is the value its
own serializer omits. That round trip also shows the write goes through the host's
typed config service rather than a raw file edit.

Web search and quick actions were driven the same way. The host stored no
`ai.web_search`, so the section drew its default (`Exa (free MCP)`, "works without a
key"); pressing `Tavily` wrote `{"provider":"tavily"}` into `config/app.json` and the
credential rows appeared. Typing a key and pressing `Save key` created
`data/web-search/credentials.json` with one entry under the default id
`tavily-search-api` and a separate `credentials.key`; the config file still contained
no secret, and the row switched to `A key is stored for this provider`. `Remove`
deleted the entry and the file, and the row went back to `No key is stored`. The
composer's `Actions` menu listed the host's two stored quick actions (`Commit`,
`Create PR`) with their prompts.

Two MCP entries were written into the scratch profile's `config/app.json` under the
key the host actually reads (`mcp_servers`, holding a Cursor-format `{"mcpServers":
{…}}` document — a top-level `mcpServers` key is ignored, which the first attempt
proved by rendering an empty list) and the window was restarted. `MCP servers` then
listed both from the host: `probe-local · probe-local` with `stdio · /bin/echo` and
`probe-remote · probe-remote` with `streamable-http · https://example.invalid/mcp`,
each `Disabled` with `Enable` / `Edit` / `Enable and start` / `Restart` / `Delete`;
`Edit` opened the form prefilled from the stored entry (name and id, `Local command`
selected, `/bin/echo`, the `probe` argument, `Disabled` + `Started by hand`). Pressing
`Save` with unchanged values did not reach the host — `config/app.json` kept its
previous mtime — so the write path for this section is covered by the fixtures and by
the command shapes read from the host code, not by a real press; the physical click
that drives the rest of this surface was swallowed at that point, which is the same
limitation the terminal's Return key has.

That same session found a real layout defect: `Settings` did not scroll. Its
`<Scroll style={{ flex: 1 }}>` grew to its content's height (the AX tree reported a
3862-tall child inside a 977-tall pane) because a flex item keeps its content size
unless `minHeight` lets it shrink, so every section below `MCP servers` — the
`Application`, `Editor`, `Terminal`, `Workspace`, `AI execution`, `Diagnostics`,
`Session memory`, `Tools` and `Agent hooks` groups, and the second MCP row — was
unreachable in the real window while the fixture tests were happy. The five
full-height `Scroll`s (`Settings`, `Devices`, both `Files` panes, the session
transcript) now carry `minHeight: 0`, and the wheel scrolls the settings page in the
window.

`Log files` was then driven against the real host. `get_runtime_logging_info` answered
`Effective level debug` with the session folder
`…/.openbitfun/desktop-nsh/user/logs/20261118T070635` and its `app.log`, and the
previous run — killed with `SIGTERM` to restart the window on the new build — was
reported as `The previous run ended without shutting down (unclean shutdown)` with the
folder that still holds that run's log. `Export diagnostics bundle` wrote
`logs/diagnostics/openbitfun-diagnostics-20261118T070812.zip` (25 KB), the section
stated `Exported …` with that path, and `reveal_in_explorer` brought Finder forward on
it, which is the same command `Open log folder` uses. Both commands take a `request`
body, so they go through `invokeCommand` like the rest of the settings surface.

## Risks and open decisions

- NSH is at 0.6.x: APIs move, and `.nsh/types` is generated truth. Re-run
  `nsh check` after toolchain updates. Since 0.6 an app that declares
  `capabilities` must list `application` (main window, menus, tray, quit) and
  `homeDir` explicitly; `nsh.json` grants `application`.
- The web runtime is about 1 MB compressed; acceptable for a desktop window that
  loads from local files, and a cost to review before any web distribution.
- The native NSH host (`src/apps/desktop-nsh`) is the desktop client; the Tauri
  window that hosted the web target during the migration was retired. Capabilities
  it does not offer are listed above and refuse with an explicit state.
