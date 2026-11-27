import { toolInputRecord } from "./toolPresentation";
import { tr, type MessageKey } from "./i18n";
import { formatCount, formatPlural } from "./format";

const RISKS = ["critical", "high", "medium", "low"] as const;
const SEVERITIES = [...RISKS, "info"] as const;
const ACTIONS = ["approve", "approve_with_suggestions", "request_changes", "block"] as const;
const EVIDENCE_STATES = ["complete", "limited", "failed", "unknown"] as const;
const CERTAINTIES = ["confirmed", "likely", "possible"] as const;
const REMEDIATION = ["must_fix", "should_improve", "needs_decision", "verification"] as const;
const STRENGTHS = ["architecture", "maintainability", "tests", "security", "performance", "user_experience", "other"] as const;

function option<T extends string>(choices: readonly T[], value: unknown): T | undefined {
  return choices.find(choice => choice === value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
}

function groups<T extends string>(keys: readonly T[], input: Record<string, unknown>, read = strings) {
  return keys.flatMap(key => {
    const items = read(input[key]);
    return items.length ? [{ key, items }] : [];
  });
}

function remediationItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return strings(value.map(entry => {
    if (typeof entry === "string") return entry;
    const decision = toolInputRecord(entry);
    return [...new Set([text(decision.question), text(decision.plan)].filter(Boolean)),
      ...strings(decision.options), text(decision.tradeoffs)].filter(Boolean).join("\n");
  }));
}

function finding(value: unknown) {
  const issue = toolInputRecord(value);
  const title = text(issue.title);
  const description = text(issue.description);
  if (!title && !description) return null;
  return {
    title, description,
    severity: option(SEVERITIES, issue.severity),
    certainty: option(CERTAINTIES, issue.certainty),
    category: text(issue.category),
    file: text(issue.file),
    line: typeof issue.line === "number" && Number.isSafeInteger(issue.line) && issue.line > 0 ? issue.line : null,
    suggestion: text(issue.suggestion),
    validationNote: text(issue.validation_note),
  };
}

/** Interpret the host's accepted report for presentation, including historical JSON strings. */
export function codeReviewReport(value: unknown) {
  const input = toolInputRecord(value);
  const summary = toolInputRecord(input.summary);
  const assessment = text(summary.overall_assessment);
  const risk = option(RISKS, summary.risk_level);
  const action = option(ACTIONS, summary.recommended_action);
  if (!assessment && !risk && !action) return null;

  const findings = Array.isArray(input.issues) ? input.issues.map(finding) : null;
  const sections = toolInputRecord(input.report_sections);
  const remediation = groups(REMEDIATION, toolInputRecord(sections.remediation_groups), remediationItems);
  const strengths = groups(STRENGTHS, toolInputRecord(sections.strength_groups));
  const reviewers = Array.isArray(input.reviewers) ? input.reviewers.map(toolInputRecord) : [];
  const partialReviewers = reviewers.map(reviewer => text(reviewer.partial_output));
  const reliability = Array.isArray(input.reliability_signals)
    ? input.reliability_signals.map(signal => text(toolInputRecord(signal).detail)) : [];
  return {
    assessment, risk, action,
    evidence: option(EVIDENCE_STATES, input.evidence_coverage) ?? option(EVIDENCE_STATES, input.evidence_status),
    targetChangedDuringReview: input.target_changed_during_review === true || input.evidence_status === "stale",
    confidence: text(summary.confidence_note),
    scope: text(input.review_scope),
    deep: input.review_mode === "deep",
    hasIncompleteChecks: reviewers.some(reviewer =>
      (reviewer.status === "partial_timeout" || reviewer.status === "capacity_skipped") &&
      Boolean(text(reviewer.packet_id ?? reviewer.packetId))),
    findings: findings?.filter(issue => issue !== null) ?? [],
    findingsComplete: input.finding_count_available !== false && findings !== null && findings.every(issue => issue !== null),
    executiveSummary: strings(sections.executive_summary),
    remediation,
    legacyRemediation: remediation.length ? [] : strings(input.remediation_plan),
    strengths,
    legacyStrengths: strengths.length ? [] : strings(input.positive_points).filter(point => point.toLowerCase() !== "none"),
    coverageNotes: strings([...strings(sections.coverage_notes), ...partialReviewers, ...reliability]),
  };
}

export type CodeReviewReport = NonNullable<ReturnType<typeof codeReviewReport>>;

export const reviewGroupLabels: Record<
  CodeReviewReport["remediation"][number]["key"] | CodeReviewReport["strengths"][number]["key"], MessageKey
> = {
  must_fix: "chat.review.mustFix", should_improve: "chat.review.shouldImprove",
  needs_decision: "chat.review.needsDecision", verification: "chat.review.verification",
  architecture: "chat.review.architecture", maintainability: "chat.review.maintainability",
  tests: "chat.review.tests", security: "chat.review.security", performance: "chat.review.performance",
  user_experience: "chat.review.userExperience", other: "chat.review.other",
};

export const reviewCertaintyLabels: Record<NonNullable<CodeReviewReport["findings"][number]["certainty"]>, MessageKey> = {
  confirmed: "chat.review.confirmed", likely: "chat.review.likely", possible: "chat.review.possible",
};

export function reviewFindingsTitle(report: CodeReviewReport): string {
  return report.findingsComplete
    ? formatPlural(report.findings.length, "chat.review.findingOne", "chat.review.findingOther")
    : tr("chat.review.findings");
}

export function reviewFindingLocation(issue: CodeReviewReport["findings"][number]): string {
  if (!issue.file) return "";
  return issue.line === null ? issue.file : `${issue.file}:${formatCount(issue.line)}`;
}

export function reviewFindingMetadata(issue: CodeReviewReport["findings"][number]): string {
  return [
    reviewSeverityLabel(issue.severity),
    issue.certainty ? tr(reviewCertaintyLabels[issue.certainty]) : "",
    issue.category,
  ].filter(Boolean).join(" · ");
}

const severityLabels = {
  critical: "chat.review.critical", high: "chat.review.high", medium: "chat.review.medium",
  low: "chat.review.low", info: "chat.review.info",
} as const satisfies Record<typeof SEVERITIES[number], MessageKey>;

const actionLabels = {
  approve: "chat.review.approve", approve_with_suggestions: "chat.review.approveWithSuggestions",
  request_changes: "chat.review.requestChanges", block: "chat.review.block",
} as const satisfies Record<typeof ACTIONS[number], MessageKey>;

export function reviewSeverityLabel(value: unknown): string {
  const severity = option(SEVERITIES, value);
  return severity ? tr(severityLabels[severity]) : "";
}

export function reviewRecommendationLabel(value: unknown): string {
  const action = option(ACTIONS, value);
  return action ? tr(actionLabels[action]) : "";
}

function markdownList(items: readonly string[]): string {
  return items.map(item => `- ${item.replace(/\r?\n/g, "\n  ")}`).join("\n");
}

function markdownHeading(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function markdownLocation(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const ticks = "`".repeat(runs.reduce((max, run) => Math.max(max, run.length), 0) + 1);
  return `${ticks} ${text.replace(/\r?\n/g, " ")} ${ticks}`;
}

/** One localized document for the clipboard, editor and export. */
export function formatReviewMarkdown(report: CodeReviewReport): string {
  const findingsTitle = reviewFindingsTitle(report);
  const location = (issue: CodeReviewReport["findings"][number]) => {
    const value = reviewFindingLocation(issue);
    return value ? markdownLocation(value) : "";
  };
  const renderGroup = (group: { key: keyof typeof reviewGroupLabels; items: string[] }) =>
    `### ${tr(reviewGroupLabels[group.key])}\n\n${markdownList(group.items)}`;
  const findings = report.findings.map(issue => [
    issue.title ? `### ${markdownHeading(issue.title)}` : "",
    [reviewFindingMetadata(issue), location(issue)].filter(Boolean).join(" · "),
    issue.description,
    issue.suggestion ? tr("chat.review.suggestion", { text: issue.suggestion }) : "",
    issue.validationNote,
  ].filter(Boolean).join("\n\n"));
  const sections = [
    [tr(report.deep ? "chat.review.deepAssessment" : "chat.review.assessment"), [
      report.assessment,
      report.risk ? tr("chat.review.risk", { level: reviewSeverityLabel(report.risk) }) : "",
      report.action ? tr("chat.review.recommendation", { action: reviewRecommendationLabel(report.action) }) : "",
      markdownList(report.executiveSummary),
    ]],
    [findingsTitle, [
      report.findingsComplete ? "" : tr("chat.review.findingsUnavailable"),
      ...findings,
    ]],
    [tr("chat.review.remediation"), [...report.remediation.map(renderGroup), markdownList(report.legacyRemediation)]],
    [tr("chat.review.strengths"), [...report.strengths.map(renderGroup), markdownList(report.legacyStrengths)]],
    [tr("chat.review.coverage"), [
      report.evidence === "complete" ? tr("pullRequests.history.coverageComplete") : "",
      report.evidence === "unknown" ? tr("pullRequests.history.coverageUnknown") : "",
      report.evidence === "limited" ? tr("chat.review.evidenceLimited") : "",
      report.evidence === "failed" ? tr("chat.review.evidenceFailed") : "",
      report.targetChangedDuringReview ? tr("chat.review.evidenceStale") : "",
      report.scope, report.confidence, markdownList(report.coverageNotes),
    ]],
  ] as const;
  return [
    `# ${tr("chat.review.report")}`,
    ...sections.flatMap(([title, content]) => {
      const body = content.filter(Boolean).join("\n\n");
      return body || title === findingsTitle ? [`## ${title}`, body] : [];
    }),
  ].filter(Boolean).join("\n\n") + "\n";
}
