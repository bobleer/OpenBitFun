import { cleanup, effect, signal, untracked } from "nsh";
import { isCommandMissing } from "../externalImportStore";
import { tr } from "../i18n";
import { readSubscriptionProviders, type SubscriptionAccountSummary } from "../modelDiscoveryStore";
import { currentDeviceScopeKey } from "../shared/deviceScope";
import { isRemoteWorkspace } from "../shared/workspaceUtils";
import { activeWorkspace } from "../state";
import { Badge, Button, ConfigRow, ConfigSection } from "../ui/primitives";

export type ExternalSubscriptionProvider = "codex" | "opencode";
type Account = Omit<SubscriptionAccountSummary, "account_id">;
type AccountState =
  | { kind: "ready"; accounts: Account[] }
  | { kind: "loading" | "unsupported" | "failed" };

export function ExternalAppAccount(props: {
  provider: ExternalSubscriptionProvider;
  refreshVersion: number;
  onManage: () => void;
}) {
  const result = signal<{ device: string; state: AccountState } | null>(null);
  let loadTicket = 0;
  async function load() {
    if (isRemoteWorkspace(activeWorkspace())) return;
    const device = currentDeviceScopeKey();
    const ticket = ++loadTicket;
    const publish = (state: AccountState) => {
      if (ticket === loadTicket && device === currentDeviceScopeKey() && !isRemoteWorkspace(activeWorkspace())) {
        result.set({ device, state });
      }
    };
    publish({ kind: "loading" });
    try {
      const accounts = await readSubscriptionProviders();
      publish({ kind: "ready", accounts: accounts.filter(account => account && typeof account.provider === "string"
        && typeof account.connected === "boolean") });
    } catch (error) {
      publish({ kind: isCommandMissing("list_subscription_accounts", error) ? "unsupported" : "failed" });
    }
  }
  effect(() => {
    currentDeviceScopeKey();
    void props.refreshVersion;
    untracked(() => void load());
  });
  cleanup(() => { loadTicket += 1; });

  const state = () => {
    const current = result();
    return current?.device === currentDeviceScopeKey() ? current.state : null;
  };
  const account = () => {
    const current = state();
    return current?.kind === "ready" ? current.accounts.find(account => account.provider === props.provider) : undefined;
  };
  const connected = () => Boolean(account()?.connected && !account()?.vault_unavailable && !account()?.reauthentication_required);
  const label = () => props.provider === "codex" ? tr("settings.externalImports.accounts.codex") : tr("settings.externalImports.accounts.opencode");
  const description = () => {
    if (!state() || state()?.kind === "loading") return tr("common.loading");
    if (state()?.kind === "failed") return tr("settings.externalImports.accounts.failed");
    if (!account()) return tr("settings.externalImports.accounts.unavailable");
    if (account()?.vault_unavailable) return tr("settings.externalImports.accounts.vaultUnavailable");
    if (account()?.reauthentication_required) return tr("settings.subscriptions.reauthNeeded");
    if (connected()) return typeof account()?.account === "string" ? account()?.account ?? "" : "";
    return tr(props.provider === "codex" ? "settings.externalImports.accounts.codexHint" : "settings.externalImports.accounts.opencodeHint");
  };
  return (
    <ConfigSection title={tr("settings.externalImports.accounts.title")} flush
      extra={<Button variant="ghost" size="sm" label={tr("common.refresh")} leadingIcon="refresh"
        accessibilityLabel="external-account-refresh" disabled={!state() || state()?.kind === "loading"}
        onPress={() => void load()} />}>
      <ConfigRow label={label()} description={description()} wrap divider={false}>
        <If when={connected()}><Badge tone="success" label={tr("settings.externalImports.accounts.connected")} /></If>
        <If when={account()}>
          <Button label={tr(connected() ? "settings.externalImports.accounts.manage" : "settings.subscriptions.signIn")}
            variant="secondary" size="sm" accessibilityLabel="external-account-models" onPress={props.onManage} />
        </If>
      </ConfigRow>
    </ConfigSection>
  );
}
