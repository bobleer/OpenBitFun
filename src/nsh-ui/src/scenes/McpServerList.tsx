import { signal, Text, View, type ViewRef } from "nsh";
import { mcpSecretsNote } from "../accountRecordsStore";
import { EXTERNAL_SESSION_NAMES } from "../externalImportStore";
import { localizeHostError, tr, type MessageKey } from "../i18n";
import { openMcpResources } from "../mcpResourcesStore";
import {
  deleteMcpServer, enableMcpServer, isRemoteMcpServer, mcpBusy, mcpEntryOf, mcpListError, mcpOAuthBusy, mcpServerRows,
  openMcpAuth, openMcpDraft, refreshMcpServers, restartMcpServer, startMcpServer, stopMcpServer, type McpServerRow,
} from "../mcpStore";
import { space, textStyle } from "../theme";
import { DropdownMenu } from "../ui/overlays";
import { Badge, Button, ConfigRow, IconButton, InlineBanner, type BadgeTone } from "../ui/primitives";

const statuses: Readonly<Record<string, { label: MessageKey; tone: BadgeTone }>> = {
  uninitialized: { label: "settings.mcp.status.uninitialized", tone: "neutral" },
  starting: { label: "settings.mcp.status.starting", tone: "accent" },
  connected: { label: "common.connected", tone: "success" },
  healthy: { label: "settings.mcp.status.healthy", tone: "success" },
  needsauth: { label: "settings.mcp.status.needsAuth", tone: "warning" },
  reconnecting: { label: "settings.mcp.status.reconnecting", tone: "accent" },
  failed: { label: "common.failed", tone: "danger" },
  stopping: { label: "settings.mcp.status.stopping", tone: "accent" },
  stopped: { label: "settings.mcp.status.stopped", tone: "neutral" },
};

const authSources: Readonly<Record<string, MessageKey>> = {
  headers: "settings.mcp.headers",
  env: "settings.mcp.env",
  oauth: "settings.mcp.browserOAuth",
};

interface McpServerDetail { label: MessageKey; value: string; mono?: boolean }

function serverDetails(row: McpServerRow, remote: boolean): McpServerDetail[] {
  const details: McpServerDetail[] = [{ label: "settings.mcp.transport", value: row.transport || tr("settings.mcp.unknownTransport"), mono: true }];
  if (row.transport?.toLowerCase() === "stdio") {
    if (row.command) details.push({ label: "settings.mcp.command", value: row.command, mono: true });
    details.push({ label: "settings.mcp.runtimeSource", value: tr(row.commandSource === "managed"
      ? "settings.mcp.runtimeManaged" : row.commandSource === "system" ? "settings.mcp.runtimeSystem" : "common.unknown") });
    if (row.commandResolvedPath) details.push({ label: "settings.mcp.runtimePath", value: row.commandResolvedPath, mono: true });
  }
  if (remote) {
    if (row.url) details.push({ label: "settings.mcp.serverUrl", value: row.url, mono: true });
    const source = row.authSource && Object.hasOwn(authSources, row.authSource) ? tr(authSources[row.authSource]!) : row.authSource;
    const auth = row.authConfigured === true ? tr("settings.mcp.authConfigured")
      : row.authConfigured === false ? tr("settings.mcp.authMissing") : tr("common.unknown");
    details.push({ label: "settings.mcp.authStatus", value: [auth, source].filter(Boolean).join(" · ") });
    const methods = [row.oauthEnabled ? tr("settings.mcp.browserOAuth") : "", row.xaaEnabled ? "XAA" : ""].filter(Boolean);
    if (methods.length) details.push({ label: "settings.mcp.authMethods", value: methods.join(" · ") });
  }
  return details;
}

function McpServerItem(props: { row: McpServerRow; first: boolean }) {
  const row = () => props.row;
  const id = () => row().id;
  const status = () => row().status.trim().toLowerCase();
  const knownStatus = () => Object.hasOwn(statuses, status()) ? statuses[status()] : undefined;
  const connected = () => row().enabled && (status() === "connected" || status() === "healthy");
  const stopped = () => !row().enabled || ["uninitialized", "stopped", "failed", "needsauth"].includes(status());
  const remote = () => isRemoteMcpServer(row());
  const needsOAuth = () => remote() && row().oauthEnabled === true && row().authConfigured === false;
  const canStart = () => row().startSupported !== false && row().commandAvailable !== false;
  const locked = () => Boolean(mcpBusy() || mcpListError() || mcpOAuthBusy());
  const canEdit = () => Boolean(mcpEntryOf(id()));
  const menuOpen = signal(false);
  const menuAnchor = signal<ViewRef | null>(null);
  const statusLabel = () => !row().enabled ? tr("common.disabled") : knownStatus() ? tr(knownStatus()!.label) : row().status;
  const startLabel = () => !canStart() ? tr("common.unavailable") : needsOAuth() ? tr("settings.mcp.authorizeInBrowser")
    : row().enabled ? tr("common.start") : tr("settings.mcp.enableAndStart");
  const authorizingLabel = () => tr(row().authConfigured === true ? "settings.mcp.reauthorize" : "settings.mcp.authorize");
  const importLabel = () => {
    const source = row().importOrigin?.sourceId;
    return source && Object.hasOwn(EXTERNAL_SESSION_NAMES, source) ? EXTERNAL_SESSION_NAMES[source]! : source || tr("settings.mcp.importedServer");
  };

  function start() {
    if (!canStart()) return;
    if (needsOAuth()) openMcpAuth(id(), { start: true });
    else if (row().enabled) void startMcpServer(id());
    else void enableMcpServer(id(), { start: true });
  }

  return <View>
    <ConfigRow label={row().name} description={row().name !== id() ? id() : undefined} topDivider={!props.first} divider={false} wrap
      style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }} controlStyle={{ gap: space.xs }}>
      <Badge accessibilityLabel={`mcp-row-status-${id()}`} label={statusLabel()} size="xs" pill
        tone={row().enabled ? knownStatus()?.tone : "neutral"} />
      <If when={row().importOrigin}><Badge label={importLabel()} size="xs" pill /></If>
      <If when={canEdit()}><Button label={tr("common.edit")} variant="secondary" size="sm"
        accessibilityLabel={`mcp-edit-${id()}`} disabled={locked()} onPress={() => openMcpDraft(id())} /></If>
      <If when={remote()}><IconButton icon="key" size="sm" tooltip={authorizingLabel()}
        accessibilityLabel={`mcp-auth-${id()}`} disabled={locked()} onPress={() => openMcpAuth(id())} /></If>
      <If when={connected()}><Button label={tr("settings.mcp.resources")} variant="ghost" size="sm"
        accessibilityLabel={`mcp-resources-${id()}`} disabled={locked()} onPress={() => void openMcpResources(id())} /></If>
      <If when={stopped()} else={<IconButton icon="stop" tone="danger" size="sm" tooltip={tr("common.stop")}
        accessibilityLabel={`mcp-stop-${id()}`} disabled={locked() || status() === "stopping"} onPress={() => void stopMcpServer(id())} />}>
        <IconButton icon="play" size="sm" tooltip={startLabel()} accessibilityLabel={`mcp-start-${id()}`}
          disabled={locked() || !canStart()} onPress={start} />
      </If>
      <If when={row().enabled}><IconButton icon="refresh" size="sm" tooltip={tr("common.restart")}
        accessibilityLabel={`mcp-restart-${id()}`} disabled={locked() || !canStart() || status() === "stopping"}
        onPress={() => needsOAuth() ? openMcpAuth(id(), { start: true }) : void restartMcpServer(id())} /></If>
      <View ref={menuAnchor.set} style={{ flexShrink: 0 }}>
        <IconButton icon="more" size="sm" tooltip={tr("settings.mcp.serverActions")} accessibilityLabel={`mcp-actions-${id()}`}
          active={menuOpen()} disabled={locked()} onPress={() => menuOpen.set(!menuOpen())} />
      </View>
    </ConfigRow>
    <View style={{ paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.xs }}>
      <Each of={serverDetails(row(), remote())} key={item => item.label}>{item =>
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space.sm }}>
          <Text style={textStyle("caption")}>{tr(item().label)}</Text>
          <Text style={item().mono ? textStyle("mono") : textStyle("label")}>{item().value}</Text>
        </View>
      }</Each>
      <If when={row().statusMessage}>{message => <Text style={textStyle("caption")}>{localizeHostError(message())}</Text>}</If>
      <If when={row().startDisabledReason || (row().commandAvailable === false ? tr("settings.mcp.commandUnavailable") : "")}>
        {message => <Text style={textStyle("caption")}>{localizeHostError(message())}</Text>}
      </If>
      <If when={mcpSecretsNote(id())}>{note => <Text style={textStyle("caption")} accessibilityLabel={`mcp-needs-secret-${id()}`}>{note()}</Text>}</If>
    </View>
    <DropdownMenu open={menuOpen() && !locked()} anchor={menuAnchor()} align="end" onClose={() => menuOpen.set(false)}
      items={[
        ...(!row().enabled && canEdit() ? [{ id: "enable", label: tr("common.enable"), icon: "check" as const,
          accessibilityLabel: `mcp-enable-${id()}`, onSelect: () => void enableMcpServer(id()) }] : []),
        { id: "status", label: tr("settings.mcp.refreshStatus"), icon: "info", accessibilityLabel: `mcp-status-${id()}`,
          onSelect: () => void refreshMcpServers() },
        { id: "delete", label: tr("common.delete"), icon: "trash", danger: true, confirmDelete: true,
          accessibilityLabel: `mcp-delete-${id()}`, confirmAccessibilityLabel: `mcp-delete-confirm-${id()}`,
          onSelect: () => void deleteMcpServer(id()) },
      ]} />
  </View>;
}

export function McpServerList() {
  return <>
    <If when={mcpListError()}>{error => <View style={{ padding: space.lg }}>
      <InlineBanner tone="warning" message={tr(mcpServerRows().length ? "settings.mcp.staleList" : "settings.mcp.listFailed")}
        actionLabel={tr("common.retry")} onAction={() => void refreshMcpServers()} />
      <Text style={textStyle("caption")}>{localizeHostError(error())}</Text>
    </View>}</If>
    <Each of={mcpServerRows()} key={row => row.id}>
      {(row, index) => <McpServerItem row={row()} first={index() === 0} />}
    </Each>
  </>;
}
