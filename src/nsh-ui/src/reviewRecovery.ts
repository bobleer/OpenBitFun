import type { TurnFailure } from "./format";
import { tr, type MessageKey } from "./i18n";

const REASONS: Readonly<Record<string, MessageKey>> = {
  auth: "review.recovery.auth",
  permission: "review.recovery.permission",
  provider_quota: "review.recovery.quota",
  provider_billing: "review.recovery.billing",
  provider_unavailable: "review.recovery.unavailable",
  rate_limit: "error.rateLimited",
  network: "error.networkError",
  timeout: "review.recovery.timeout",
  context_overflow: "review.recovery.context",
  invalid_request: "review.recovery.invalidRequest",
  content_policy: "review.recovery.contentPolicy",
  model_error: "review.recovery.modelError",
};

const CONSTRAINTS: Readonly<Record<string, MessageKey>> = {
  account_bound_replay: "review.recovery.accountBound",
  channel_bound_replay: "review.recovery.channelBound",
  model_delivery_uncertain: "review.recovery.deliveryUncertain",
};

function field(detail: Record<string, unknown>, key: string, alias = key): string {
  const value = detail[key] ?? detail[alias];
  return typeof value === "string" ? value.trim() : "";
}

/** Presents the owning runtime's error category, hints and replay constraint. */
export function reviewRecoveryPresentation(failure: TurnFailure) {
  const detail = failure.detail;
  if (!detail) return null;
  const category = field(detail, "category");
  const constraint = field(detail, "recoveryConstraint", "recovery_constraint");
  const hints = detail.actionHints ?? detail.action_hints;
  const actions = Array.isArray(hints) ? hints : [];
  const bound = constraint === "account_bound_replay" || constraint === "channel_bound_replay";
  const modelAction = !bound && actions.includes("switch_model") ? "review.recovery.switchModel"
    : actions.includes("open_model_settings") ? "review.recovery.modelSettings" : null;
  const diagnostic = actions.includes("copy_diagnostics") ? {
    category,
    provider: field(detail, "provider"),
    providerCode: field(detail, "providerCode", "provider_code"),
    requestId: field(detail, "requestId", "request_id"),
    httpStatus: detail.httpStatus ?? detail.http_status,
    retryable: detail.retryable,
    recoveryConstraint: constraint,
  } : null;
  const lines = Object.entries(diagnostic ?? {}).flatMap(([name, value]) =>
    typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value) ? [`${name}: ${String(value).slice(0, 500)}`] : []);
  return {
    reason: Object.hasOwn(REASONS, category) ? tr(REASONS[category]) : "",
    constraint: Object.hasOwn(CONSTRAINTS, constraint) ? tr(CONSTRAINTS[constraint]) : "",
    modelAction,
    diagnostic: lines.length ? [tr("review.recovery.diagnosticsTitle"), ...lines].join("\n") : "",
  } as const;
}
