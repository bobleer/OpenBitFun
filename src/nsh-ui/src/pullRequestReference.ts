const SECTIONS = ["overview", "ci", "file-diff", "commits", "reviews", "summary"] as const;

export type PullRequestSection = typeof SECTIONS[number];

export interface PullRequestContext {
  type: "pull-request";
  id: string;
  timestamp: number;
  label: string;
  section: PullRequestSection;
  content: string;
  sourceUrl?: string;
  remoteId?: string;
  repository?: string;
  pullRequestNumber?: number;
  pullRequestTitle?: string;
  metadata?: Record<string, unknown>;
}

export function readPullRequestContext(value: unknown): PullRequestContext | undefined {
  const context = value as Partial<PullRequestContext> | undefined;
  if (context?.type !== "pull-request" || typeof context.id !== "string" || !context.id ||
      typeof context.label !== "string" || !context.label.trim() ||
      !context.section || !SECTIONS.includes(context.section) || typeof context.content !== "string") return undefined;
  const { id, label, section, content, timestamp, sourceUrl, remoteId, repository, pullRequestNumber, pullRequestTitle, metadata } = context;
  return {
    type: "pull-request", id, label, section, content,
    timestamp: typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : 0,
    ...(typeof sourceUrl === "string" ? { sourceUrl } : {}),
    ...(typeof remoteId === "string" ? { remoteId } : {}),
    ...(typeof repository === "string" ? { repository } : {}),
    ...(typeof pullRequestNumber === "number" && Number.isSafeInteger(pullRequestNumber) ? { pullRequestNumber } : {}),
    ...(typeof pullRequestTitle === "string" ? { pullRequestTitle } : {}),
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { metadata } : {}),
  };
}

export function pullRequestDraftToken(context: PullRequestContext): string {
  return `Pull request reference ${JSON.stringify(JSON.stringify(context))}`;
}

export function pullRequestModelContext(context: PullRequestContext): string {
  return [
    `[Pull Request Context: ${context.label}]`,
    context.repository && `Repository: ${context.repository}`,
    context.remoteId && `Remote ID: ${context.remoteId}`,
    context.pullRequestNumber && `Pull Request: #${context.pullRequestNumber}${context.pullRequestTitle ? ` ${context.pullRequestTitle}` : ""}`,
    context.sourceUrl && `URL: ${context.sourceUrl}`,
    `Section: ${context.section}`,
    context.content,
  ].filter(Boolean).join("\n");
}
