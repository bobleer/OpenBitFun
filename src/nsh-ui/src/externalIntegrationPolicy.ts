/** Settings and effective values projected by the device that owns the policy. */
export type ExternalPolicyScope = "user" | "workspace";
export type ExternalPolicyMode = "recommended" | "discover_only" | "disabled";
export type ExternalPolicyAccess = "disabled" | "discover_only" | "ask_before_use" | "auto";

export type ExternalPolicyChange =
  | { operation: "set_enabled"; enabled: boolean }
  | { operation: "set_ecosystem_mode"; ecosystemId: string; mode: ExternalPolicyMode }
  | { operation: "set_capability_access"; ecosystemId: string; capabilityId: string; access: ExternalPolicyAccess }
  | { operation: "reset_workspace" | "reset_incompatible_policy" };

interface EcosystemSettings {
  mode?: string;
  capabilityOverrides?: Record<string, string>;
}

interface PolicySettings {
  enabled?: boolean;
  ecosystems?: Record<string, EcosystemSettings>;
}

interface EffectivePolicy {
  enabled: boolean;
  ecosystems: Record<string, {
    capabilities: Record<string, string>;
    policyLimitedCapabilities?: string[];
  }>;
}

interface PolicyCapability {
  capabilityId: string;
  safetyCeiling: string;
}

interface PolicyEcosystem {
  ecosystemId: string;
  displayName: string;
  capabilities: PolicyCapability[];
}

export interface ExternalIntegrationPolicy {
  status: string;
  userDefaults: PolicySettings & { enabled: boolean };
  workspaceOverride?: PolicySettings;
  globalEffective?: EffectivePolicy;
  effective?: EffectivePolicy;
  registeredEcosystems: PolicyEcosystem[];
}

export const policyModes = ["recommended", "discover_only", "disabled"] as const;
export const policyAccessLevels = ["disabled", "discover_only", "ask_before_use", "auto"] as const;

export function isExternalPolicyMode(value: string): value is ExternalPolicyMode {
  return policyModes.some(mode => mode === value);
}

export function isExternalPolicyAccess(value: string): value is ExternalPolicyAccess {
  return policyAccessLevels.some(access => access === value);
}

export function readExternalIntegrationPolicy(raw: unknown): ExternalIntegrationPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const policy = raw as Partial<ExternalIntegrationPolicy>;
  if (typeof policy.status !== "string" || typeof policy.userDefaults?.enabled !== "boolean"
    || !Array.isArray(policy.registeredEcosystems)) return null;
  return policy as ExternalIntegrationPolicy;
}

/** The workspace scope inherits each setting the host did not override. */
export function externalPolicySelection(policy: ExternalIntegrationPolicy, scope: ExternalPolicyScope, ecosystemId: string) {
  const global = policy.userDefaults;
  const override = scope === "workspace" ? policy.workspaceOverride : undefined;
  const effective = scope === "workspace" ? policy.effective : policy.globalEffective;
  const ecosystem = policy.registeredEcosystems.find(candidate => candidate.ecosystemId === ecosystemId);
  const userApp = global.ecosystems?.[ecosystemId];
  const workspaceApp = override?.ecosystems?.[ecosystemId];
  const mode = workspaceApp?.mode ?? userApp?.mode ?? "recommended";
  const enabled = override?.enabled ?? global.enabled;
  return {
    enabled,
    mode: enabled ? mode : "disabled",
    ecosystem,
    effective: effective?.ecosystems?.[ecosystemId],
    configuredAccess: { ...userApp?.capabilityOverrides, ...workspaceApp?.capabilityOverrides },
    workspaceHasOverride: Boolean(override && (typeof override.enabled === "boolean"
      || Object.values(override.ecosystems ?? {}).some(app => app.mode || Object.keys(app.capabilityOverrides ?? {}).length))),
  };
}
