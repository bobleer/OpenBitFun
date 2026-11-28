// The account's runtime devices → their workspaces → their sessions, as the
// sidebar (and, on a phone, the session list) draws them. Display only: rows,
// their order (each device's assistant workspace first, then current / newest),
// states and the action gates come from the backend — the fleet navigator on a
// fleet entry, the host's own catalogue without the fleet layer. The only local
// state is the extra session pages a workspace was asked to show ("Show more").

import { batch, computed, signal } from "nsh";
import { listSessions, type SessionSummary } from "./api";
import { fleetActive } from "./bridge";
import { localDeviceId } from "./devicePrefsStore";
import { fleetDevices } from "./fleetStore";
import type { FleetDevice, FleetRouteKind } from "./fleetTypes";
import { tr } from "./i18n";
import { loadAgentModes } from "./agentModeStore";
import { reuseRows, sameRecord } from "./rowReuse";
import { isSessionAcknowledged, statusOfSession } from "./sessionStatusStore";
import { createSecondarySession, selectSecondarySession } from "./splitSessionStore";
import { remoteWorkspaceAliasOf } from "./sshRemoteStore";
import {
  activeSessionDevice,
  activeSessionId,
  activeWorkspaceId,
  collapsedWorkspaces,
  createSessionInWorkspace,
  focusPane,
  focusedPane,
  isSessionArchived,
  navigateScene,
  secondarySessionDevice,
  secondarySessionId,
  selectSession,
  selectWorkspace,
  sessionLastActivityMs,
  sessions,
  splitPaneOpen,
  workspaces,
} from "./state";
import { deviceException, localSessionMarkState, rollupMarkState, sessionMarkState, type MarkState } from "./ui/fleet";
import type { SessionActionTarget } from "./ui/sessionActions";
import type { WorkspaceActionTarget } from "./ui/workspaceActions";

/** A session row of the device tree. */
export interface DeviceTreeSession {
  sessionId: string;
  title: string;
  mark: MarkState;
  ageMs?: number;
}

/** A workspace of the device tree, with the sessions it lists. */
export interface DeviceTreeWorkspace {
  workspaceId: string;
  name: string;
  rootPath: string;
  kind?: string;
  sshHost?: string;
  connectionId?: string;
  connectionName?: string;
  iconGlyph?: string;
  sessions: DeviceTreeSession[];
  /** Sessions the workspace holds in all; more than `sessions` when the rest is a page away. */
  total: number;
}

export interface DeviceTreeNode {
  deviceId: string;
  name: string;
  kind: string;
  isClient: boolean;
  state: string;
  asOfMs?: number;
  version?: string;
  // TEMPORARY (dev diagnostics): Link route kind & latency for the sidebar header tag; remove/comment out before release.
  routeKind?: FleetRouteKind;
  routeLatencyMs?: number;
  rollup: MarkState | null;
  expandedHint: boolean;
  workspaces: DeviceTreeWorkspace[];
}

const NON_RUNTIME_HOST_KINDS = new Set(["cloud", "mobile", "phone", "browser", "web"]);

/** Runtime devices (this desktop included); the cloud node and frontend-only phones and browsers are not. */
export function isRuntimeFleetDevice(device: FleetDevice): boolean {
  return !NON_RUNTIME_HOST_KINDS.has(device.hostKind.toLowerCase());
}

/**
 * Devices listed in the session tree (sidebar and phone Sessions tab): runtime
 * devices that are not offline/unreachable/stale, plus this client device.
 * Offline devices remain in `fleetDevices()` for Settings › Account › Devices
 * and open-session offline notices.
 */
export function isSidebarFleetDevice(device: FleetDevice): boolean {
  return isRuntimeFleetDevice(device) && (device.isClientDevice || deviceException(device.state) !== "offline");
}

/**
 * Displayable remote SSH alias (or host fallback) for a workspace: the
 * connection alias over the raw `sshHost`, nothing for assistant or local ones.
 */
export function remoteWorkspaceHost(workspace: {
  kind?: string;
  workspaceKind?: string;
  sshHost?: string;
  connectionId?: string;
  remoteConnectionId?: string;
  connectionName?: string;
}): string | undefined {
  return remoteWorkspaceAliasOf(workspace);
}

function workspaceLabel(workspace: { name?: string; rootPath?: string }): string {
  if (workspace.name) return workspace.name;
  const path = workspace.rootPath ?? "";
  // Remote roots are POSIX on every client; local roots may be Windows paths.
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// ── Session pages beyond what the navigator lists ───────────────────────────

interface WorkspacePage {
  rows: SessionSummary[];
  total: number;
}

/** Pages a workspace was asked for, by `deviceId/workspaceId`. */
const workspacePages = signal<Record<string, WorkspacePage>>({});
const pageLoads = new Map<string, Promise<void>>();
/** Sessions a "Show more" asks the owning device for at a time. */
export const SESSION_PAGE = 20;

function pageKey(deviceId: string, workspaceId: string): string {
  return `${deviceId}/${workspaceId}`;
}

/**
 * Reads the workspace's newest `count` sessions from the device that owns it
 * (`list_persisted_sessions_page` is routed to the workspace's owner), so the
 * tree lists more than the navigator's preview without leaving the sidebar.
 */
export function loadWorkspaceSessions(deviceId: string, workspaceId: string, count: number): Promise<void> {
  const key = pageKey(deviceId, workspaceId);
  const running = pageLoads.get(key);
  if (running) return running;
  const load = (async () => {
    try {
      const target = fleetActive() && deviceId ? { target: deviceId } : undefined;
      const page = await listSessions(workspaceId, count, undefined, target);
      const rows = (page.sessions ?? []).filter(row => !isSessionArchived(row));
      const total = Math.max(rows.length, page.totalTopLevelCount ?? 0);
      workspacePages.update(all => ({ ...all, [key]: { rows, total } }));
    } catch (error) {
      console.warn(`list sessions for ${workspaceId} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      pageLoads.delete(key);
    }
  })();
  pageLoads.set(key, load);
  return load;
}

/** Without the fleet layer: a workspace other than the open one reads its own catalogue when unfolded. */
export function loadLocalWorkspace(workspaceId: string): Promise<void> {
  return loadWorkspaceSessions(localDeviceId() ?? "", workspaceId, SESSION_PAGE);
}

// ── The tree ─────────────────────────────────────────────────────────────────

function deviceUiHint(device: FleetDevice): { expanded?: boolean; rollup?: string } {
  const ui = (device as unknown as { ui?: { expanded?: boolean; rollup?: string } }).ui;
  return ui ?? {};
}

function pagedRow(
  row: SessionSummary,
  untitled: string,
  status: ReturnType<typeof statusOfSession>,
  deviceId: string,
): DeviceTreeSession {
  const activityMs = sessionLastActivityMs(row);
  const live = status(row.sessionId, activityMs, row.messageCount, deviceId);
  let mark = localSessionMarkState(live?.kind);
  if (mark === "idle" && !isSessionAcknowledged(row.sessionId, activityMs, deviceId)) {
    if (row.failed) mark = "failed";
    else if (row.unread) mark = "done";
  }
  return {
    sessionId: row.sessionId,
    title: row.sessionName || untitled,
    mark,
    ageMs: activityMs,
  };
}

function fleetPreviewMark(
  row: FleetDevice["workspaces"][number]["sessions"][number],
  deviceId: string,
  status: ReturnType<typeof statusOfSession>,
): MarkState {
  const live = status(row.sessionId, row.lastActivityMs, undefined, deviceId);
  if (live?.kind === "approval") return "needs_you";
  if (row.status === "waiting" || (row.needsAttention && !row.failed && row.status !== "error")) {
    return "needs_you";
  }
  if (live?.kind === "running" || row.status === "running") return "working";
  if (live?.kind === "queued") return "queued";
  const acked = isSessionAcknowledged(row.sessionId, row.lastActivityMs, deviceId);
  if (live?.kind === "failed") return "failed";
  if (acked) return "idle";
  return sessionMarkState(row);
}

/**
 * The navigator's preview rows, then any further rows a page read: the preview
 * keeps its live states, the page only adds what the preview did not list.
 */
function withPage(
  preview: DeviceTreeSession[],
  page: WorkspacePage | undefined,
  untitled: string,
  status: ReturnType<typeof statusOfSession>,
  deviceId: string,
): DeviceTreeSession[] {
  if (!page || page.rows.length <= preview.length) return preview;
  const listed = new Set(preview.map(row => row.sessionId));
  return [
    ...preview,
    ...page.rows.filter(row => !listed.has(row.sessionId)).map(row => pagedRow(row, untitled, status, deviceId)),
  ];
}

function buildDeviceTree(): DeviceTreeNode[] {
  const untitled = tr("allSessions.untitled");
  const pages = workspacePages();
  const status = statusOfSession();
  if (fleetActive()) {
    return fleetDevices()
      .filter(isSidebarFleetDevice)
      .map(device => {
        const hint = deviceUiHint(device);
        return {
          deviceId: device.deviceId,
          name: device.name,
          kind: device.hostKind,
          isClient: device.isClientDevice,
          state: device.state,
          asOfMs: device.asOfMs,
          version: device.version,
          // TEMPORARY (dev diagnostics): Link route kind & latency for the sidebar header tag.
          routeKind: device.route?.kind,
          routeLatencyMs: device.route?.latencyMs,
          rollup: rollupMarkState(hint.rollup),
          // Devices fold except this one and those the backend flags expanded.
          expandedHint: hint.expanded ?? device.isClientDevice,
          workspaces: device.workspaces.map(workspace => {
            const page = pages[pageKey(device.deviceId, workspace.workspaceId)];
            const preview = workspace.sessions.map(row => ({
              sessionId: row.sessionId,
              title: row.title || untitled,
              mark: fleetPreviewMark(row, device.deviceId, status),
              ageMs: row.lastActivityMs,
            }));
            return {
              workspaceId: workspace.workspaceId,
              name: workspaceLabel(workspace),
              rootPath: workspace.rootPath,
              kind: workspace.kind,
              sshHost: workspace.sshHost,
              connectionId: workspace.connectionId,
              connectionName: workspace.connectionName,
              iconGlyph: workspace.iconGlyph,
              total: Math.max(workspace.sessionTotal, page?.total ?? 0),
              sessions: withPage(preview, page, untitled, status, device.deviceId),
            };
          }),
        };
      });
  }
  // One host, one device: this machine.
  const deviceId = localDeviceId() ?? "";
  return [
    {
      deviceId,
      name: tr("device.thisDevice"),
      kind: "laptop",
      isClient: false,
      state: "online",
      rollup: null,
      expandedHint: true,
      workspaces: workspaces().map(workspace => {
        const page = pages[pageKey(deviceId, workspace.id)];
        const open = workspace.id === activeWorkspaceId();
        const rows = open ? sessions().filter(row => !isSessionArchived(row)) : page?.rows ?? [];
        const preview = rows.map(row => pagedRow(row, untitled, status, ""));
        return {
          workspaceId: workspace.id,
          name: workspaceLabel(workspace),
          rootPath: workspace.rootPath,
          kind: workspace.workspaceKind,
          sshHost: workspace.sshHost,
          connectionId: workspace.connectionId ?? (workspace as { remoteConnectionId?: string }).remoteConnectionId,
          connectionName: workspace.connectionName,
          iconGlyph: workspace.iconGlyph,
          total: Math.max(rows.length, page?.total ?? 0),
          sessions: open ? withPage(preview, page, untitled, status, "") : preview,
        };
      }),
    },
  ];
}

function reuseTreeWorkspace(held: DeviceTreeWorkspace, fresh: DeviceTreeWorkspace): DeviceTreeWorkspace {
  const sessionRows = reuseRows(held.sessions, fresh.sessions, row => row.sessionId);
  const next = sessionRows === fresh.sessions ? fresh : { ...fresh, sessions: sessionRows };
  return sameRecord(held, next) ? held : next;
}

function reuseTreeNode(held: DeviceTreeNode, fresh: DeviceTreeNode): DeviceTreeNode {
  const workspaceRows = reuseRows(held.workspaces, fresh.workspaces, workspace => workspace.workspaceId, reuseTreeWorkspace);
  const next = workspaceRows === fresh.workspaces ? fresh : { ...fresh, workspaces: workspaceRows };
  return sameRecord(held, next) ? held : next;
}

/**
 * The device tree. Built once per change of what it reads; every device,
 * workspace and session row whose fields did not change stays the same object
 * (and so does the list), so a status change on one session rebuilds that row
 * and its parents only.
 */
export const deviceTree = computed<DeviceTreeNode[]>(previous =>
  reuseRows(previous, buildDeviceTree(), node => node.deviceId, reuseTreeNode),
);

// ── Row actions ──────────────────────────────────────────────────────────────

/** Opens a session of the tree (in the focused pane while the split view is open). */
export function openSessionRow(sessionId: string, deviceId: string, workspaceId: string): void {
  const effectiveDevice = fleetActive() ? deviceId : "";
  batch(() => {
    if (splitPaneOpen()) {
      if (activeSessionId() === sessionId && (!fleetActive() || activeSessionDevice() === effectiveDevice)) {
        focusPane(0);
        navigateScene("sessions");
        return;
      }
      if (secondarySessionId() === sessionId && (!fleetActive() || secondarySessionDevice() === effectiveDevice)) {
        focusPane(1);
        navigateScene("sessions");
        return;
      }
      if (focusedPane() === 1) {
        selectSecondarySession(sessionId, effectiveDevice, workspaceId || undefined);
        navigateScene("sessions");
        return;
      }
    }
    if (fleetActive()) {
      selectSession(sessionId, deviceId, workspaceId || undefined);
    } else {
      if (workspaceId && workspaceId !== activeWorkspaceId()) selectWorkspace(workspaceId);
      selectSession(sessionId);
    }
    navigateScene("sessions");
  });
}

/** Starts a session in a workspace of the tree (in the focused pane while the split view is open). */
export async function newSessionHere(workspaceId: string, deviceId: string): Promise<void> {
  const branchDeviceId = fleetActive() ? deviceId : (deviceId || localDeviceId() || "");
  const branchKey = `${branchDeviceId}/${workspaceId}`;
  if (collapsedWorkspaces()[branchKey] === true) {
    collapsedWorkspaces.update(current => {
      const next = { ...current };
      delete next[branchKey];
      return next;
    });
  }
  if (splitPaneOpen() && focusedPane() === 1) {
    const defaultMode = await loadAgentModes(workspaceId);
    await createSecondarySession(workspaceId, fleetActive() ? deviceId : null, defaultMode ?? undefined);
    navigateScene("sessions");
    return;
  }
  selectWorkspace(workspaceId, {
    ...(fleetActive() ? { deviceId } : {}),
    loadSessions: false,
  });
  // backend-owned: `create_session` requires an agent type, and the host's
  // default (`default_mode_strategy` / `last_mode_id`, or `Claw` for assistant
  // workspaces) arrives with its mode catalogue, so that is read first.
  const defaultMode = await loadAgentModes(workspaceId);
  await createSessionInWorkspace(tr("nav.newSession"), defaultMode ?? undefined);
  navigateScene("sessions");
}

/** The session ⋯ target of a row. */
export function sessionTarget(row: { sessionId: string; title: string }, deviceId: string, workspaceId: string): SessionActionTarget {
  return { sessionId: row.sessionId, deviceId, workspaceId, title: row.title, archived: false };
}

/** The workspace ⋯ target of a row. */
export function workspaceTarget(node: DeviceTreeNode, workspace: DeviceTreeWorkspace): WorkspaceActionTarget {
  return {
    workspaceId: workspace.workspaceId,
    deviceId: node.deviceId,
    name: workspace.name,
    rootPath: workspace.rootPath,
    kind: workspace.kind,
    sshHost: workspace.sshHost,
    connectionId: workspace.connectionId,
    connectionName: workspace.connectionName,
  };
}
