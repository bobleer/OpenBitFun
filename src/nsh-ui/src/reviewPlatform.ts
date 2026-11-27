import type { PullRequestContext, PullRequestSection } from "./pullRequestReference";

export type ReviewPlatformListState = "all" | "open" | "draft" | "merged" | "closed";
export type ReviewPlatformDetailSection = "overview" | "files" | "ci" | "commits" | "reviews";
export type ReviewPlatformAuthProvider = "github" | "gitlab" | "gitcode" | "gitee";

interface ReviewPlatformPagination {
  page: number;
  hasNext: boolean;
}

export interface ReviewPlatformRemote {
  id: string;
  name: string;
  projectPath: string;
  platform?: string;
  host?: string;
  webUrl?: string;
  supported: boolean;
  message?: string | null;
  authState?: string;
  authSource?: string;
}

export interface ReviewPlatformPullRequest {
  id: string;
  providerId?: string | null;
  number: number;
  title: string;
  state: Exclude<ReviewPlatformListState, "all">;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  baseRevision?: string | null;
  headRevision?: string | null;
  webUrl: string;
  changedFiles: number;
  changedFileCountKnown?: boolean;
  comments: number;
  reviewDecision: string;
  checks: { total: number; passed: number; failed: number; pending: number };
}

export interface ReviewPlatformSnapshot {
  remotes: ReviewPlatformRemote[];
  selectedRemoteId?: string | null;
  repository?: { projectPath: string } | null;
  pullRequests: ReviewPlatformPullRequest[];
  pagination: ReviewPlatformPagination;
  capabilities?: { supportedPullRequestStates?: ReviewPlatformListState[] };
  message?: string | null;
  authChallenge?: { remoteId?: string; state?: string; message: string; requiredScopes?: string[] } | null;
}

export function reviewAuthProvider(value?: string): ReviewPlatformAuthProvider | undefined {
  if (value === "github" || value === "gitlab" || value === "gitcode" || value === "gitee") return value;
}

export interface ReviewPlatformFile {
  path: string;
  oldPath?: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch?: string | null;
}

export interface ReviewPlatformCheck {
  id: string;
  name: string;
  status: string;
  conclusion?: string | null;
  detail?: string | null;
  stage?: string | null;
  webUrl?: string | null;
  log?: string | null;
  logTruncated?: boolean;
}

export interface ReviewPlatformLog {
  log?: string | null;
  truncated: boolean;
  message?: string | null;
}

export interface ReviewPlatformDetail extends ReviewPlatformPullRequest {
  body: string;
  files: ReviewPlatformFile[];
  ci: ReviewPlatformCheck[];
  commits: Array<{ hash: string; shortHash: string; title: string; author: string; committedAt: string }>;
  threads: Array<{ id: string; author: string; body: string; filePath?: string | null; line?: number | null;
    providerCommentId?: string | null; replyToProviderCommentId?: string | null; kind: string; resolved: boolean; updatedAt: string }>;
  pagination: ReviewPlatformPagination;
  limitations?: string[];
}

/** Resolve a number against the selection, or a link against a known workspace remote. */
export function resolvePullRequestInput(
  input: string, remotes: ReviewPlatformRemote[], selectedRemoteId: string | null | undefined,
): { remoteId: string; id: string } | undefined {
  const text = input.trim();
  const number = /^#?([1-9]\d*)$/.exec(text)?.[1];
  if (number) {
    const remote = remotes.find(item => item.id === selectedRemoteId && item.supported);
    return remote && Number.isSafeInteger(Number(number)) ? { remoteId: remote.id, id: number } : undefined;
  }
  try {
    const url = new URL(text);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return;
    const match = /^(.*?)\/(?:-\/merge_requests|merge_requests|pulls?)\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (!match || !Number.isSafeInteger(Number(match[2]))) return;
    for (const remote of remotes) {
      if (!remote.supported || !remote.webUrl) continue;
      const expected = new URL(remote.webUrl);
      if (expected.origin !== url.origin) continue;
      const candidate = decodeURIComponent(match[1]);
      const repository = decodeURIComponent(expected.pathname).replace(/\/$/, "");
      const matches = remote.platform === "github"
        ? candidate.toLowerCase() === repository.toLowerCase() : candidate === repository;
      if (matches) return { remoteId: remote.id, id: match[2] };
    }
  } catch {
    // An invalid URL is not a repository locator.
  }
}

export function reviewCheckStatus(check: ReviewPlatformCheck): string {
  return check.conclusion && check.conclusion !== check.status ? `${check.status} · ${check.conclusion}` : check.status;
}

export function reviewThreadLocation(thread: ReviewPlatformDetail["threads"][number]): string {
  return thread.filePath ? `${thread.filePath}${thread.line ? `:${thread.line}` : ""}` : "";
}

export function reviewFileContext(pr: ReviewPlatformDetail, file: ReviewPlatformFile): string {
  return [
    `Pull request file diff: PR #${pr.number} ${pr.title}`,
    `File: ${file.path}`,
    file.oldPath && file.oldPath !== file.path ? `Old path: ${file.oldPath}` : "",
    `Status: ${file.status}`,
    `Delta: +${file.additions} -${file.deletions}`,
    "Diff:",
    file.patch?.trim() || "No inline diff is available for this file.",
  ].filter(Boolean).join("\n");
}

function checkContext(check: ReviewPlatformCheck): string {
  return [`- ${check.name}`, `  Status: ${reviewCheckStatus(check)}`,
    check.stage && `  Stage: ${check.stage}`, check.detail && `  Detail: ${check.detail}`,
    check.webUrl && `  URL: ${check.webUrl}`].filter(Boolean).join("\n");
}

export function reviewCheckContext(pr: ReviewPlatformDetail, check: ReviewPlatformCheck, log?: ReviewPlatformLog): string {
  return [
    `Pull request CI result: PR #${pr.number} ${pr.title}`,
    checkContext(check),
    log?.log && `Log${log.truncated ? " (truncated)" : ""}:\n${log.log}`,
    log?.message,
  ].filter(Boolean).join("\n\n");
}

export function reviewSectionContext(pr: ReviewPlatformDetail, section: Exclude<ReviewPlatformDetailSection, "files">): string {
  const title = `PR #${pr.number} ${pr.title}`;
  if (section === "ci") return [`Pull request CI page: ${title}`, ...pr.ci.map(checkContext)].join("\n");
  if (section === "commits") return [
    `Pull request commits: ${title}`,
    ...pr.commits.map(commit => `- ${commit.shortHash} ${commit.title}\n  Author: ${commit.author}\n  Committed: ${commit.committedAt}\n  Hash: ${commit.hash}`),
  ].join("\n");
  if (section === "reviews") return [
    `Pull request reviews: ${title}`,
    ...pr.threads.map(thread => [
      `- [${thread.kind}] ${thread.resolved ? "Resolved" : "Open"} thread by ${thread.author}`,
      thread.replyToProviderCommentId && `  Reply to: ${thread.replyToProviderCommentId}`,
      reviewThreadLocation(thread) && `  Location: ${reviewThreadLocation(thread)}`,
      `  Updated: ${thread.updatedAt}`, `  Body: ${thread.body}`,
    ].filter(Boolean).join("\n")),
  ].join("\n");
  return [
    title, `Author: ${pr.author}`, `Branches: ${pr.sourceBranch} → ${pr.targetBranch}`,
    `Overview:\n${pr.body.trim() || "No pull request description was returned by the provider."}`,
    `State: ${pr.state}`, `Review decision: ${pr.reviewDecision}`,
    `Checks: ${pr.checks.passed}/${pr.checks.total} passed, ${pr.checks.failed} failed, ${pr.checks.pending} pending`,
    `Comments: ${pr.comments}`,
  ].join("\n");
}

export function createPullRequestContext(
  pr: ReviewPlatformPullRequest, remoteId: string, repository: string | undefined,
  section: PullRequestSection, label: string, content: string, metadata?: Record<string, unknown>,
): PullRequestContext {
  const timestamp = Date.now();
  return {
    type: "pull-request",
    id: globalThis.crypto?.randomUUID?.() ?? `pr-${timestamp}-${Math.random().toString(36).slice(2)}`,
    timestamp, label, section, content, metadata, repository, remoteId,
    sourceUrl: pr.webUrl, pullRequestNumber: pr.number, pullRequestTitle: pr.title,
  };
}
