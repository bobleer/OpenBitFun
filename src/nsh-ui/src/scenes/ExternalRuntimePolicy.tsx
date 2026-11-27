import { computed, effect, signal, untracked, View } from "nsh";
import {
  changeExternalRuntimePolicy, externalDiscoverySaving, externalLoadState, externalSourceControl,
  externalSourceControlBusy, type ExternalSourceControlState,
} from "../externalImportStore";
import {
  externalPolicySelection, isExternalPolicyAccess, isExternalPolicyMode, policyAccessLevels, policyModes,
  type ExternalPolicyChange, type ExternalPolicyScope,
} from "../externalIntegrationPolicy";
import { tr, type MessageKey } from "../i18n";
import { activeWorkspace, deviceContext } from "../state";
import { space } from "../theme";
import { ModalDialog, SelectDropdown } from "../ui/overlays";
import { Badge, Button, ConfigRow, ConfigSection, InlineBanner, ToggleSwitch } from "../ui/primitives";
import { TabGroup } from "../ui/TabGroup";

const modeNames: Readonly<Record<string, MessageKey>> = {
  recommended: "settings.externalImports.policy.recommended",
  discover_only: "settings.externalImports.policy.discoverOnly",
  disabled: "common.disabled",
  custom: "settings.externalImports.policy.custom",
};
const accessNames: Readonly<Record<string, MessageKey>> = {
  disabled: "common.disabled",
  discover_only: "settings.externalImports.policy.discoverOnly",
  ask_before_use: "settings.externalImports.policy.askBeforeUse",
  auto: "settings.externalImports.policy.automatic",
};
const capabilityNames: Readonly<Record<string, MessageKey>> = {
  command: "settings.externalImports.catalog.commands",
  tool: "settings.externalImports.catalog.tools",
  subagent: "settings.externalImports.catalog.subagents",
  mcp: "settings.externalImports.mcpTitle",
  reference: "settings.externalImports.policy.references",
};

function choices(values: readonly string[], selected: string, labels: Readonly<Record<string, MessageKey>>) {
  const options: { value: string; label: string; disabled?: boolean }[] = values.map(value => ({
    value, label: tr(labels[value]!),
  }));
  if (selected && !values.includes(selected)) {
    options.push({
      value: selected, label: tr(Object.hasOwn(labels, selected) ? labels[selected]! : "settings.externalImports.policy.unknownValue"), disabled: true,
    });
  }
  return options;
}

export function ExternalRuntimePolicySection(props: { ecosystemId: string }) {
  const workspace = computed(() => activeWorkspace()?.id ?? null);
  const selectedScope = signal<ExternalPolicyScope>("user");
  const expandedApp = signal("");
  const expanded = () => expandedApp() === props.ecosystemId;
  const recovery = signal<ExternalSourceControlState | null>(null);
  effect(() => {
    const id = workspace();
    deviceContext();
    untracked(() => {
      selectedScope.set(id ? "workspace" : "user");
      recovery.set(null);
      expandedApp.set("");
    });
  });
  const scope = () => workspace() ? selectedScope() : "user";
  const control = () => externalSourceControl();
  const policy = () => control()?.policy;
  const selected = computed(() => {
    const value = policy();
    return value ? externalPolicySelection(value, scope(), props.ecosystemId) : null;
  });
  const locked = () => !control()?.canMutatePolicy || externalLoadState() !== "ready"
    || externalDiscoverySaving() || Boolean(externalSourceControlBusy());
  const recoveryStale = () => {
    const saved = recovery();
    return !saved || saved.scope !== control()?.scope || saved.preferenceRevision !== control()?.preferenceRevision
      || policy()?.status !== "incompatible_schema";
  };
  const submit = (change: ExternalPolicyChange) => {
    const snapshot = control();
    if (snapshot && !locked()) void changeExternalRuntimePolicy(snapshot, scope(), change);
  };
  async function resetPolicy() {
    const snapshot = recovery();
    if (!snapshot || recoveryStale() || locked()) return;
    await changeExternalRuntimePolicy(snapshot, "user", { operation: "reset_incompatible_policy" });
    if (recovery() === snapshot) recovery.set(null);
  }
  function capabilityAccess(id: string): string {
    const selection = selected();
    if (!selection?.enabled) return "disabled";
    const configured = selection.configuredAccess[id];
    if (selection.mode === "custom" && configured && !isExternalPolicyAccess(configured)) return configured;
    return selection.effective?.capabilities?.[id] ?? "";
  }

  return <If when={policy()}>
    {current => <ConfigSection title={tr("settings.externalImports.policy.title")} flush>
      <If when={current().status === "compatible"} else={
        <View style={{ padding: space.md }}>
          <InlineBanner tone="warning"
            message={tr(current().status === "incompatible_schema"
              ? "settings.externalImports.policy.recoveryRequired" : "settings.externalImports.policy.unknownStatus")}
            actionLabel={current().status === "incompatible_schema" && !locked()
              ? tr("settings.externalImports.policy.recover") : undefined}
            onAction={() => { if (!locked()) recovery.set(control() ?? null); }} />
        </View>
      }>
        <If when={workspace()}>
          <ConfigRow label={tr("settings.externalImports.policy.scope")} wrap divider={false}>
            <TabGroup value={scope()} size="sm" accessibilityLabel={tr("settings.externalImports.policy.scope")}
              items={[
                { value: "user", label: tr("settings.externalImports.policy.deviceDefault"), testID: "external-policy-scope-user" },
                { value: "workspace", label: tr("settings.externalImports.policy.workspace"), testID: "external-policy-scope-workspace" },
              ]}
              onChange={value => selectedScope.set(value)} />
          </ConfigRow>
        </If>
        <ConfigRow label={tr("settings.externalImports.policy.enabled")}
          description={tr("settings.externalImports.policy.description")} wrap divider={false} topDivider={Boolean(workspace())}>
          <ToggleSwitch value={selected()?.enabled === true} accessibilityLabel="external-policy-enabled"
            disabled={locked()} onChange={enabled => submit({ operation: "set_enabled", enabled })} />
        </ConfigRow>
        <If when={scope() === "workspace"}>
          <ConfigRow label={tr(selected()?.workspaceHasOverride
            ? "settings.externalImports.policy.overrides" : "settings.externalImports.policy.inherited")} topDivider divider={false}>
            <If when={current().workspaceOverride}>
              <Button label={tr("settings.externalImports.policy.resetWorkspace")} accessibilityLabel="external-policy-reset-workspace"
                variant="secondary" size="sm" disabled={locked()}
                onPress={() => submit({ operation: "reset_workspace" })} />
            </If>
          </ConfigRow>
        </If>
        <If when={selected()?.ecosystem}>
          {app => <>
            <ConfigRow label={app().displayName} description={tr("settings.externalImports.policy.mode")} topDivider divider={false} wrap>
              <SelectDropdown size="sm" align="end" minWidth={160} accessibilityLabel="external-policy-app-mode"
                value={selected()?.mode} options={choices(policyModes, selected()?.mode ?? "", modeNames)}
                disabled={locked() || !selected()?.enabled}
                onChange={mode => {
                  if (isExternalPolicyMode(mode)) submit({ operation: "set_ecosystem_mode", ecosystemId: app().ecosystemId, mode });
                }} />
            </ConfigRow>
            <If when={(app().capabilities ?? []).length > 0}>
              <ConfigRow label={tr("settings.externalImports.policy.capabilities")} topDivider divider={false}>
                <Button label={tr(expanded() ? "settings.externalImports.policy.hide" : "common.details")} variant="secondary" size="sm"
                  accessibilityLabel="external-policy-capabilities" onPress={() => expandedApp.set(expanded() ? "" : app().ecosystemId)} />
              </ConfigRow>
              <If when={expanded()}>
                <Each of={app().capabilities} key={capability => capability.capabilityId}>
                  {capability => {
                    const id = () => capability().capabilityId;
                    const effective = () => selected()?.effective;
                    const limited = () => effective()?.policyLimitedCapabilities?.includes(id()) === true;
                    const label = () => Object.hasOwn(capabilityNames, id()) ? tr(capabilityNames[id()]!) : id();
                    const levels = () => capability().safetyCeiling === "auto" ? policyAccessLevels : policyAccessLevels.slice(0, -1);
                    return <ConfigRow label={label()} wrap topDivider divider={false}>
                      <If when={limited()}>
                        <Badge label={tr("settings.externalImports.policy.safetyLimited")} />
                      </If>
                      <SelectDropdown size="sm" align="end" minWidth={160} accessibilityLabel={`external-policy-capability-${id()}`}
                        value={capabilityAccess(id())} options={choices(levels(), capabilityAccess(id()), accessNames)}
                        disabled={locked() || !selected()?.enabled}
                        onChange={access => {
                          if (isExternalPolicyAccess(access)) submit({
                            operation: "set_capability_access", ecosystemId: app().ecosystemId, capabilityId: id(), access,
                          });
                        }} />
                    </ConfigRow>;
                  }}
                </Each>
              </If>
            </If>
          </>}
        </If>
      </If>
      <If when={recovery()}>
        <ModalDialog open size="md" title={tr("settings.externalImports.policy.recoveryTitle")}
          subtitle={tr("settings.externalImports.policy.recoveryBody")} accessibilityLabel="external-policy-recovery"
          onClose={() => { if (!externalSourceControlBusy()) recovery.set(null); }}
          closeOnEscape={!externalSourceControlBusy()} closeOnBackdropPress={!externalSourceControlBusy()}
          footer={<>
            <Button label={tr("common.cancel")} variant="secondary" disabled={Boolean(externalSourceControlBusy())}
              onPress={() => recovery.set(null)} />
            <Button label={tr("settings.externalImports.policy.recover")} variant="primary" accessibilityLabel="external-policy-confirm-recovery"
              disabled={locked() || recoveryStale()} onPress={() => void resetPolicy()} />
          </>}>
          <If when={recoveryStale()}>
            <InlineBanner tone="warning" message={tr("settings.externalImports.sourceControls.changed")} />
          </If>
        </ModalDialog>
      </If>
    </ConfigSection>}
  </If>;
}
