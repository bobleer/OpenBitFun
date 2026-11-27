import { cleanup, Clipboard, signal, Text, View } from "nsh";
import { entryDeviceId, fleetActive, invokeCommand, transportKind } from "../bridge";
import { fleetDeviceById } from "../fleetStore";
import { isCommandUnavailable } from "../hostCommands";
import { tr, type MessageKey } from "../i18n";
import type { ReviewPlatformAuthProvider } from "../reviewPlatform";
import { openInAuxPane } from "../state";
import { openTerminal } from "../terminalStore";
import { palette, space, textStyle } from "../theme";
import { ModalDialog, pushToast } from "../ui/overlays";
import { Button, InlineBanner, InlineDeleteConfirm, InputBox } from "../ui/primitives";

export interface ReviewPlatformAuthTarget {
  platform: ReviewPlatformAuthProvider;
  host: string;
  projectPath: string;
  authSource?: string;
  authState?: string;
  requiredScopes?: string[];
  deviceId: string;
  workspaceId: string;
  rootPath: string;
  connectionId?: string;
  remoteWorkspace: boolean;
}

const SAVE_TOKEN = "review_platform_update_auth_token";
const CLEAR_TOKEN = "review_platform_clear_auth_token";
const HOST_TERMINAL = "host_terminal_workspace_v1";

const STATE_LABELS: Record<string, MessageKey> = {
  connected: "pullRequests.auth.connected", not_connected: "pullRequests.auth.disconnected",
  expired: "pullRequests.auth.expired", error: "pullRequests.auth.error",
  invalid: "pullRequests.auth.invalid", insufficient_scope: "pullRequests.auth.scope",
  missing: "pullRequests.auth.disconnected",
};
const PROVIDER_NAMES = { github: "GitHub", gitlab: "GitLab", gitcode: "GitCode", gitee: "Gitee" } as const;

export function ReviewPlatformAuthDialog(props: {
  target: ReviewPlatformAuthTarget;
  isCurrent: () => boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const target = props.target;
  const github = target.platform === "github";
  const token = signal("");
  const busy = signal(false);
  const error = signal("");
  let disposed = false;
  cleanup(() => { disposed = true; });
  const current = () => !disposed && props.isCurrent();
  const owner = () => fleetDeviceById(target.deviceId);
  const ownerLabel = () => owner()?.name || target.deviceId ||
    tr(transportKind() === "native" ? "device.thisDevice" : "pullRequests.auth.runtime");
  const localNativeOwner = () => transportKind() === "native" &&
    (!target.deviceId || target.deviceId === entryDeviceId());
  const canOpenTerminal = () => (!target.remoteWorkspace || Boolean(target.connectionId)) &&
    (localNativeOwner() || owner()?.hostCapabilities?.includes(HOST_TERMINAL) === true);
  const command = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(target.host)
    ? `gh auth login --hostname ${target.host}` : "";
  const stateKey = target.authState && Object.hasOwn(STATE_LABELS, target.authState) ? STATE_LABELS[target.authState] : undefined;

  function close(): void {
    if (busy()) return;
    token.set("");
    props.onClose();
  }

  async function changeToken(clear: boolean): Promise<void> {
    if (github || !current() || busy() || (fleetActive() && !target.deviceId)) return;
    const value = token().trim();
    if (clear ? target.authSource !== "stored" : !value) return;
    const action = clear ? CLEAR_TOKEN : SAVE_TOKEN;
    error.set("");
    busy.set(true);
    try {
      await invokeCommand<unknown>(action, {
        platform: target.platform, host: target.host,
        ...(!clear ? { token: value } : {}),
      }, { target: target.deviceId });
    } catch (reason) {
      if (current()) error.set(tr(isCommandUnavailable(reason, action)
        ? "pullRequests.auth.unsupported" : clear ? "pullRequests.auth.clearFailed" : "pullRequests.auth.saveFailed"));
      return;
    } finally {
      if (current()) busy.set(false);
    }
    if (!current()) return;
    token.set("");
    pushToast(tr(clear ? "pullRequests.auth.cleared" : "pullRequests.auth.saved"), "success");
    props.onChanged();
  }

  async function copyCommand(open: boolean): Promise<void> {
    if (!command || !current() || busy() || (open && !canOpenTerminal())) return;
    error.set("");
    busy.set(true);
    try {
      await Clipboard.writeText(command);
      if (!current()) return;
      if (!open) {
        pushToast(tr("pullRequests.auth.commandCopied"), "success");
        return;
      }
      const id = await openTerminal(target.workspaceId, "", {
        title: tr("pullRequests.auth.github"),
        hostWorkspace: {
          rootPath: target.rootPath, connectionId: target.connectionId, deviceId: target.deviceId,
          isCurrent: current,
        },
      });
      if (!current()) return;
      if (!id) {
        error.set(tr("pullRequests.auth.terminalFailed"));
        return;
      }
      props.onClose();
      openInAuxPane("terminal");
      pushToast(tr("pullRequests.auth.pasteCommand"), "success");
    } catch {
      if (current()) error.set(tr("pullRequests.auth.copyFailed"));
    } finally {
      if (current()) busy.set(false);
    }
  }

  return (
    <ModalDialog open title={tr(github ? "pullRequests.auth.github" : "pullRequests.auth.providerToken", {
      provider: PROVIDER_NAMES[target.platform],
    })} subtitle={target.projectPath} size="sm" accessibilityLabel="pr-auth-dialog"
      closeOnEscape={!busy()} closeOnBackdropPress={!busy()} onClose={close}
      onSubmit={() => { if (!github) void changeToken(false); }}
      footer={<View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center",
        justifyContent: "flex-end", gap: space.sm }}>
        <Button size="sm" variant="ghost" label={tr("common.cancel")} disabled={busy()}
          accessibilityLabel="pr-auth-cancel" onPress={close} />
        <If when={github}>
          <Button size="sm" variant="secondary" leadingIcon="copy" label={tr("common.copy")}
            accessibilityLabel="pr-auth-copy-command" disabled={busy() || !command} onPress={() => void copyCommand(false)} />
          <Button size="sm" variant="primary" leadingIcon="terminal" label={tr("pullRequests.auth.openTerminal")}
            accessibilityLabel="pr-auth-terminal" disabled={busy() || !command || !canOpenTerminal()}
            onPress={() => void copyCommand(true)} />
        </If>
        <If when={!github}>
          <Button size="sm" variant="primary" label={tr("common.save")} loading={busy()}
            accessibilityLabel="pr-auth-save" disabled={busy() || !token().trim()} onPress={() => void changeToken(false)} />
        </If>
      </View>}>
      <View style={{ gap: space.md }}>
        <Text style={textStyle("caption", { color: palette().textSecondary })}>
          {[target.host, ownerLabel(), stateKey ? tr(stateKey) : ""].filter(Boolean).join(" · ")}
        </Text>
        <If when={github} else={<>
          <InputBox size="sm" masked label={tr("pullRequests.auth.token")} value={token()} disabled={busy()}
            accessibilityLabel="pr-auth-token" onChange={value => { token.set(value); error.set(""); }} />
          <If when={Boolean(target.requiredScopes?.length)}>
            <Text style={textStyle("caption", { color: palette().textSecondary })}>
              {tr("pullRequests.auth.requiredScopes", { scopes: (target.requiredScopes ?? []).join(", ") })}
            </Text>
          </If>
          <If when={target.authSource === "stored"}>
            <View style={{ alignItems: "flex-start" }}>
              <InlineDeleteConfirm size="sm" disabled={busy()} label={tr("pullRequests.auth.clear")}
                confirmLabel={tr("pullRequests.auth.confirmClear")} accessibilityLabel="pr-auth-clear"
                confirmAccessibilityLabel="pr-auth-confirm-clear" onConfirm={() => void changeToken(true)} />
            </View>
          </If>
        </>}>
          <Text style={textStyle("body")}>{tr(target.authState === "connected"
            ? "pullRequests.auth.githubSwitch" : "pullRequests.auth.githubHint", { device: ownerLabel() })}</Text>
          <If when={command}>
            <Text style={{ ...textStyle("monoBlock"), padding: space.sm, backgroundColor: palette().surfaceTertiary,
              userSelect: "text" }}>{command}</Text>
          </If>
          <If when={!canOpenTerminal() || !command}>
            <InlineBanner tone="info" message={tr("pullRequests.auth.terminalUnavailable", { device: ownerLabel() })} />
          </If>
        </If>
        <If when={error()}><InlineBanner tone="danger" message={error()} /></If>
      </View>
    </ModalDialog>
  );
}
