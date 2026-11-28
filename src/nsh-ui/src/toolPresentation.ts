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

const reviewWorkerTools = new Set(["task", "agentspawn", "agentfork"]);

export function reviewProgressTool(name: string, input: unknown): { kind: "report" } | { kind: "check"; label: string } | null {
  const tool = normalizeToolName(name);
  if (tool === "submitcodereview") return { kind: "report" };
  if (tool !== "launchreviewagent" && !reviewWorkerTools.has(tool)) return null;
  const args = toolInputRecord(input);
  const role = args.subagent_type ?? args.subagentType ?? args.agent_type ?? args.agentType;
  const reviewer = typeof role === "string" ? role.trim() : "";
  if (tool !== "launchreviewagent" && !reviewer.startsWith("Review")) return null;
  const description = typeof args.description === "string" ? args.description.trim() : "";
  return { kind: "check", label: description || reviewer };
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

export function toolAwaitsApproval(status: string): boolean {
  return status === "confirmation" || status === "awaiting_confirmation" || status === "pending_confirmation";
}
