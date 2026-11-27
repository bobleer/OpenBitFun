// Workspace-scoped session cleanup. The owner supplies the catalogue and applies
// each mutation; selection and confirmation stay in this driving surface.
import { signal, Text, View, type JSX } from "nsh";
import { normalizeSessionSummary, type SessionPage, type SessionSummary } from "../api";
import { backendConnection, fleetActive, invokeCommand } from "../bridge";
import { forgetComposerDraft } from "../composerDraftStore";
import { loadWorkspaceSessions, SESSION_PAGE } from "../deviceTree";
import { refreshFleetNavigator } from "../fleetStore";
import { formatRelativeTime } from "../format";
import { localizeHostError, tr } from "../i18n";
import {
  activeWorkspaceId, activeWorkspaceKey, refreshSessionsSilently, removeSessionFromEvent, sessionKey,
} from "../state";
import { layout, palette, radii, space, textStyle } from "../theme";
import { Icon } from "./icons";
import { ModalDialog, pushToast } from "./overlays";
import { Button, focusRingStyle, InlineBanner, InlineDeleteConfirm, SkeletonBlock } from "./primitives";
import type { WorkspaceActionTarget } from "./workspaceActions";

const target = signal<WorkspaceActionTarget | null>(null);
const rows = signal<SessionSummary[]>([]);
const selected = signal<Set<string>>(new Set());
const loading = signal(false);
const action = signal<"archive" | "delete" | null>(null);
const notice = signal("");
const confirming = signal(false);
let readTicket = 0;

const busy = () => loading() || action() !== null;
const route = (workspace: WorkspaceActionTarget) =>
  fleetActive() && workspace.deviceId ? { target: workspace.deviceId } : undefined;
const errorText = (error: unknown) => localizeHostError(error instanceof Error ? error.message : String(error));

async function readSessions(workspace: WorkspaceActionTarget): Promise<void> {
  const ticket = ++readTicket;
  loading.set(true);
  notice.set("");
  rows.set([]);
  selected.set(new Set());
  confirming.set(false);
  try {
    const loaded: SessionSummary[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await invokeCommand<SessionPage & { catalogReset?: boolean }>(
        "list_persisted_sessions_page",
        {
          workspace_id: workspace.workspaceId,
          limit: 100,
          query: { workspaceId: workspace.workspaceId, ordering: "updated", source: "all" },
          ...(cursor ? { cursor } : {}),
        },
        route(workspace),
      );
      if (ticket !== readTicket) return;
      // Never expose a partial/stale catalogue as a successful "Select all".
      if ((cursor && page.catalogReset) || (page.hasMore && (!page.nextCursor || cursors.has(page.nextCursor)))) {
        throw new Error(tr("sessionBatch.catalogChanged"));
      }
      loaded.push(...page.sessions.map(normalizeSessionSummary));
      cursor = page.hasMore ? page.nextCursor : undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    rows.set(loaded);
  } catch (error) {
    if (ticket === readTicket) notice.set(tr("sessionBatch.loadFailed", { error: errorText(error) }));
  } finally {
    if (ticket === readTicket) loading.set(false);
  }
}

export async function openWorkspaceSessionBatch(workspace: WorkspaceActionTarget): Promise<void> {
  if (action()) return;
  target.set(workspace);
  await readSessions(workspace);
}

function close(): void {
  if (action()) return;
  ++readTicket;
  target.set(null);
  rows.set([]);
  selected.set(new Set());
  confirming.set(false);
  loading.set(false);
}

function toggle(id: string): void {
  if (busy()) return;
  confirming.set(false);
  selected.update(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

async function run(kind: "archive" | "delete"): Promise<void> {
  const workspace = target();
  if (!workspace || busy() || !selected().size) return;
  const connection = backendConnection();
  const ids = [...selected()];
  action.set(kind);
  confirming.set(false);
  notice.set("");
  const succeeded = new Set<string>();
  const failures: string[] = [];
  try {
    for (const id of ids) {
      try {
        await invokeCommand<unknown>(
          kind === "archive" ? "archive_session" : "delete_persisted_session",
          { workspace_id: workspace.workspaceId, session_id: id },
          route(workspace),
        );
        succeeded.add(id);
        if (kind === "delete") forgetComposerDraft(sessionKey(id, workspace.deviceId), connection);
        if (activeWorkspaceId() === workspace.workspaceId &&
            (!fleetActive() || activeWorkspaceKey()?.deviceId === workspace.deviceId)) {
          removeSessionFromEvent(id, workspace.deviceId);
        }
      } catch (error) {
        failures.push(errorText(error));
      }
    }
    rows.update(current => current.filter(row => !succeeded.has(row.sessionId)));
    selected.update(current => new Set([...current].filter(id => !succeeded.has(id))));
    if (succeeded.size) {
      pushToast(tr("sessionBatch.completed", { count: succeeded.size }), "success");
      if (fleetActive()) await refreshFleetNavigator();
      else if (activeWorkspaceId() === workspace.workspaceId) await refreshSessionsSilently();
      await loadWorkspaceSessions(workspace.deviceId, workspace.workspaceId, Math.max(SESSION_PAGE, rows().length));
    }
    if (failures.length) {
      notice.set(tr("sessionBatch.failed", { count: failures.length, error: failures[0] }));
    }
  } catch (error) {
    notice.set(errorText(error));
  } finally {
    action.set(null);
  }
}

function SessionRow(props: { row: SessionSummary }): JSX.Element {
  const checked = () => selected().has(props.row.sessionId);
  return (
    <View
      role="checkbox"
      accessibilityLabel={`session-batch-row-${props.row.sessionId}`}
      accessibilityState={{ checked: checked(), disabled: busy() }}
      onPress={() => toggle(props.row.sessionId)}
      focusVisibleStyle={focusRingStyle()}
      hoverStyle={{ backgroundColor: palette().panelHover }}
      style={{
        flexDirection: "row", alignItems: "center", gap: space.sm,
        minHeight: layout.touchTarget, padding: space.sm, borderRadius: radii.md,
        backgroundColor: checked() ? palette().panelHover : "transparent",
        opacity: busy() ? 0.6 : 1, cursor: busy() ? "default" : "pointer",
      }}
    >
      <View style={{
        width: space.lg, height: space.lg, borderRadius: radii.xs,
        borderWidth: 1, borderColor: palette().borderStrong,
        alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}>
        <If when={checked()}><Icon name="check" size={12} color={palette().text} /></If>
      </View>
      <Text style={{ ...textStyle("body", { color: palette().text }), flex: 1, minWidth: 0, numberOfLines: 1 }}>
        {props.row.sessionName || tr("allSessions.untitled")}
      </Text>
      <Text style={textStyle("caption", { color: palette().textMuted })}>
        {formatRelativeTime(props.row.lastActiveAt ?? props.row.lastUpdated)}
      </Text>
    </View>
  );
}

export function WorkspaceSessionBatchDialog(): JSX.Element {
  return (
    <ModalDialog
      open={target() !== null}
      title={tr("sessionBatch.manage")}
      size="lg"
      accessibilityLabel="workspace-session-batch-modal"
      closeOnBackdropPress={!busy()}
      onClose={close}
      footer={
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
          <Button label={tr("common.close")} variant="secondary" disabled={action() !== null} onPress={close} />
          <Button
            label={tr("sessionBatch.archive")} variant="secondary"
            accessibilityLabel="session-batch-archive"
            disabled={busy() || !selected().size} loading={action() === "archive"}
            onPress={() => void run("archive")}
          />
          <InlineDeleteConfirm
            label={tr("sessionBatch.delete")} variant="danger"
            size="md"
            accessibilityLabel="session-batch-delete"
            confirmAccessibilityLabel="session-batch-delete-confirm"
            cancelAccessibilityLabel="session-batch-delete-cancel"
            disabled={busy() || !selected().size} loading={action() === "delete"}
            confirming={confirming()} onConfirmingChange={value => confirming.set(value)}
            onConfirm={() => void run("delete")}
          />
        </View>
      }
    >
      <View style={{ gap: space.md }}>
        <Text style={textStyle("sectionTitle", { color: palette().text })}>{target()?.name ?? ""}</Text>
        <Text style={textStyle("caption", { color: palette().textSecondary })}>{tr("sessionBatch.description")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
          <Button
            label={selected().size === rows().length && rows().length > 0 ? tr("sessionBatch.deselectAll") : tr("sessionBatch.selectAll")}
            variant="ghost" size="sm" accessibilityLabel="session-batch-select-all"
            disabled={busy() || !rows().length}
            onPress={() => {
              confirming.set(false);
              selected.set(selected().size === rows().length ? new Set() : new Set(rows().map(row => row.sessionId)));
            }}
          />
          <Button
            label={tr("sessionBatch.invert")} variant="ghost" size="sm"
            accessibilityLabel="session-batch-invert" disabled={busy() || !rows().length}
            onPress={() => {
              confirming.set(false);
              selected.set(new Set(rows().filter(row => !selected().has(row.sessionId)).map(row => row.sessionId)));
            }}
          />
          <Text style={textStyle("caption", { color: palette().textMuted, tabular: true })}>
            {tr("sessionBatch.selection", { count: selected().size, total: rows().length })}
          </Text>
        </View>
        <If when={loading()}><SkeletonBlock height={layout.touchTarget} /></If>
        <If when={notice()}>
          {message => <InlineBanner tone="danger" message={message()} />}
        </If>
        <If when={!busy() && notice() !== ""}>
          <Button label={tr("common.retry")} variant="secondary" accessibilityLabel="session-batch-retry"
            onPress={() => { const workspace = target(); if (workspace) void readSessions(workspace); }} />
        </If>
        <If when={!loading() && !notice() && rows().length === 0}>
          <Text style={textStyle("body", { color: palette().textSecondary })}>{tr("sessionBatch.empty")}</Text>
        </If>
        <Each of={rows()} key={row => row.sessionId}>{row => <SessionRow row={row()} />}</Each>
      </View>
    </ModalDialog>
  );
}
