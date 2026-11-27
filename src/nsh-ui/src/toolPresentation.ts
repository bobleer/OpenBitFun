import type { ToolCallView } from "./format";

export const normalizeToolName = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, "");

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function toolInputRecord(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      return record(JSON.parse(input)) ?? {};
    } catch {
      return {};
    }
  }
  return record(input) ?? {};
}

/** The gateway's target is a display identity. Keep the original call id for detail reads. */
export function effectiveToolInvocation(name: string, input: unknown): { name: string; input: unknown } {
  if (name === "CallDeferredTool") {
    const request = record(input);
    if (request && typeof request.tool_name === "string" && request.tool_name.trim()) {
      const { tool_name, args, ...outer } = request;
      const nested = Object.hasOwn(request, "args") ? record(args) : {};
      if (nested) return { name: tool_name.trim(), input: { ...outer, ...nested } };
    }
  }
  return { name, input };
}

const prominentTools = new Set([
  "write", "writefile", "createfile", "edit", "editfile", "multiedit", "strreplace",
  "strreplaceeditor", "searchreplace", "applypatch", "delete", "deletefile",
  "todo", "todowrite", "createplan", "task", "agentspawn", "agentfork", "askuserquestion",
  "launchreviewagent", "submitcodereview", "contextcompression", "reviewsessionsummary",
  "git", "getfilediff", "initminiapp", "pagemanage", "pagedeploy", "pagepublish",
  "generativeui", "genui", "creategoal", "updategoal", "agentdelete", "finalizeminiapp", "publishminiapp",
]);

const quietActions: Readonly<Record<string, readonly string[]>> = {
  openbitfuncontrol: ["list", "search", "get"],
  worktree: ["list"],
  portforward: ["targets", "detect", "list"],
  reviewplatform: ["get_workspace_snapshot", "list_remotes", "list_pull_requests", "count_pull_requests",
    "get_pull_request", "get_pull_request_detail_page", "get_pull_request_ci_log"],
  frontendworkbench: ["prepare", "status", "inspect"],
  desktopcard: ["presets", "list", "get", "refresh"],
};

const browserObservations = new Set([
  "snapshot", "get", "get_text", "get_url", "get_title", "get_html",
  "list_pages", "tab_query", "list_sessions", "hover", "scroll", "auto_scroll",
]);
const shellTools = new Set(["bash", "execcommand", "writestdin", "execcontrol"]);
const cancelled = new Set(["cancelled", "rejected", "interrupted"]);

export function toolAwaitsApproval(status: string): boolean {
  return status === "confirmation" || status === "awaiting_confirmation" || status === "pending_confirmation";
}

/** Attention selects presentation only. It leaves tool execution and permission to the host. */
export function isProminentToolCall(call: Pick<ToolCallView, "name" | "input" | "status">): boolean {
  if (call.name.startsWith("mcp__")) return true;
  const name = normalizeToolName(call.name);
  const status = call.status?.toLowerCase() ?? "";
  if (name === "task" && cancelled.has(status)) return false;
  if (prominentTools.has(name) || (status === "rejected" && shellTools.has(name))) return true;

  const quiet = Object.hasOwn(quietActions, name) ? quietActions[name] : undefined;
  if (quiet) {
    const input = toolInputRecord(call.input);
    const action = name === "worktree" || name === "portforward" ? input.operation : input.action;
    return typeof action !== "string" || !quiet.includes(action.trim());
  }
  if (name === "controlhub") {
    const { domain, action } = toolInputRecord(call.input);
    if (domain === "meta") return action !== "capabilities" && action !== "route_hint";
    if (domain === "terminal") return action !== "list_sessions";
    return domain !== "browser" || typeof action !== "string" || !browserObservations.has(action);
  }
  return false;
}
