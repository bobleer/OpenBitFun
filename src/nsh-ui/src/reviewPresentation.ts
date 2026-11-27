import { reviewRecommendationLabel, reviewSeverityLabel } from "./codeReviewReport";
import { formatCount, formatPlural, formatTimestamp } from "./format";
import { tr, type MessageKey } from "./i18n";
import type { PullRequestReviewFreshness, PullRequestReviewPhase, PullRequestReviewRun } from "./pullRequestReviewHistory";

const REVIEW_PHASE: Record<PullRequestReviewPhase, MessageKey> = {
  running: "pullRequests.history.running", completed: "pullRequests.history.completed",
  failed: "pullRequests.history.failed", stopped: "pullRequests.history.stopped",
  interrupted: "pullRequests.history.interrupted", pending: "pullRequests.history.pending",
  unknown: "pullRequests.history.unknownPhase",
};

const REVIEW_FRESHNESS: Record<PullRequestReviewFreshness, MessageKey> = {
  current: "pullRequests.history.current", stale: "pullRequests.history.stale",
  unknown: "pullRequests.history.unknownFreshness",
};

export function reviewPhaseLabel(phase: PullRequestReviewPhase): string {
  return tr(REVIEW_PHASE[phase] ?? REVIEW_PHASE.unknown);
}

export function reviewRunSummary(run: PullRequestReviewRun, showFreshness = true): string {
  return [
    run.revision ? tr("pullRequests.history.revision", { number: formatCount(run.revision.number) }) : "",
    reviewPhaseLabel(run.phase),
    showFreshness ? tr(REVIEW_FRESHNESS[run.freshness] ?? REVIEW_FRESHNESS.unknown) : "",
    run.preparedEvidenceLimited && !(run.outcome?.state === "available" && run.outcome.evidenceCoverage === "limited")
      ? tr("pullRequests.history.limited") : "",
    formatTimestamp(run.finishedAt ?? run.createdAt),
  ].filter(Boolean).join(" · ");
}

const REVIEW_COVERAGE: Readonly<Record<string, MessageKey>> = {
  complete: "pullRequests.history.coverageComplete", limited: "pullRequests.history.coverageLimited",
  failed: "pullRequests.history.coverageFailed", unknown: "pullRequests.history.coverageUnknown",
};

export function reviewOutcomeDescription(run: PullRequestReviewRun): string {
  const outcome = run.outcome;
  if (outcome?.state === "missing") return tr("pullRequests.history.reportMissing");
  if (outcome?.state === "invalid") return tr("chat.review.unavailable");
  if (outcome?.state !== "available") return run.phase === "completed" ? tr("pullRequests.history.openForReport") : "";
  const risk = reviewSeverityLabel(outcome.riskLevel);
  const recommendation = reviewRecommendationLabel(outcome.recommendedAction);
  const coverage = outcome.evidenceCoverage ?? "unknown";
  const coverageLabel = Object.hasOwn(REVIEW_COVERAGE, coverage) ? REVIEW_COVERAGE[coverage] : REVIEW_COVERAGE.unknown;
  const facts = [
    typeof outcome.findingCount === "number"
      ? formatPlural(outcome.findingCount, "chat.review.findingOne", "chat.review.findingOther") : "",
    risk ? tr("chat.review.risk", { level: risk }) : "",
    coverage === "complete" && run.preparedEvidenceLimited ? "" : tr(coverageLabel),
    outcome.targetChangedDuringReview ? tr("pullRequests.history.targetMoved") : "",
  ].filter(Boolean).join(" · ");
  return [facts, recommendation ? tr("chat.review.recommendation", { action: recommendation }) : "", outcome.assessment]
    .filter(Boolean).join("\n");
}
