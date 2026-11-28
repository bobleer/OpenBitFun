import { codeSnippetLabel, readCodeSnippetContext, type CodeSnippetContext } from "./codeSnippetReference";
import { mermaidReferenceLabel, readMermaidContext, type MermaidContext } from "./mermaidReference";
import { readPullRequestContext, type PullRequestContext } from "./pullRequestReference";

interface PromptReferenceRange {
  token: string;
  label: string;
  detail?: string;
  start: number;
  end: number;
}

export type InlinePlainPromptReferenceKind = "mcp" | "workspace" | "device" | "model" | "acp";

export type PromptReference = PromptReferenceRange & (
  | { kind: "skill" | InlinePlainPromptReferenceKind }
  | { kind: "code-snippet"; context: CodeSnippetContext }
  | { kind: "mermaid-diagram" | "mermaid-node"; context: MermaidContext }
  | { kind: "pull-request"; context: PullRequestContext }
);

const INLINE_PLAIN_PROMPT_KINDS = new Set<string>(["mcp", "workspace", "device", "model", "acp"]);

export function isInlinePlainPromptReference(kind: PromptReference["kind"]): boolean {
  return INLINE_PLAIN_PROMPT_KINDS.has(kind);
}

const jsonString = String.raw`"(?:[^"\\\r\n]|\\[^\r\n])*"`;
const promptPattern = new RegExp(
  [
    String.raw`\[\$([^\]\r\n]+)\]`,
    String.raw`\bMCP (${jsonString}) \(server: (${jsonString})\)`,
    String.raw`\bWorkspace (${jsonString}) \(id: (${jsonString})(?:, path: (${jsonString}))?(?:, device: (${jsonString}))?\)`,
    String.raw`\bDevice (${jsonString}) \(id: (${jsonString})\)`,
    String.raw`\bModel (${jsonString}) \(id: (${jsonString})(?:, model: (${jsonString}))?\)`,
    String.raw`\bACP (${jsonString}) \(client: (${jsonString})(?:, tool: (${jsonString}))?\)`,
    String.raw`\bCode snippet (${jsonString})`,
    String.raw`\bMermaid reference (${jsonString})`,
    String.raw`\bPull request reference (${jsonString})`,
  ].join("|"),
  "g",
);

export function skillPromptToken(name: string): string {
  return `[$${name.trim()}]`;
}

export function mcpPromptToken(serverId: string, serverName: string): string {
  return `MCP ${JSON.stringify(serverName)} (server: ${JSON.stringify(serverId)})`;
}

export function workspacePromptToken(
  workspaceId: string,
  workspaceName: string,
  options?: { rootPath?: string; deviceId?: string },
): string {
  const fields = [`id: ${JSON.stringify(workspaceId)}`];
  const rootPath = options?.rootPath?.trim();
  const deviceId = options?.deviceId?.trim();
  if (rootPath) fields.push(`path: ${JSON.stringify(rootPath)}`);
  if (deviceId) fields.push(`device: ${JSON.stringify(deviceId)}`);
  return `Workspace ${JSON.stringify(workspaceName)} (${fields.join(", ")})`;
}

export function devicePromptToken(deviceId: string, deviceName: string): string {
  return `Device ${JSON.stringify(deviceName)} (id: ${JSON.stringify(deviceId)})`;
}

export function modelPromptToken(
  modelRef: string,
  modelLabel: string,
  options?: { modelName?: string },
): string {
  const fields = [`id: ${JSON.stringify(modelRef)}`];
  const modelName = options?.modelName?.trim();
  if (modelName && modelName !== modelRef && modelName !== modelLabel) {
    fields.push(`model: ${JSON.stringify(modelName)}`);
  }
  return `Model ${JSON.stringify(modelLabel)} (${fields.join(", ")})`;
}

export function acpPromptToken(clientId: string, clientName: string, toolName?: string): string {
  const fields = [`client: ${JSON.stringify(clientId)}`];
  const tool = toolName?.trim();
  if (tool) fields.push(`tool: ${JSON.stringify(tool)}`);
  return `ACP ${JSON.stringify(clientName)} (${fields.join(", ")})`;
}

/** Read exactly the prompt that is sent to the runtime, including older saved drafts. */
export function promptReferencesIn(text: string): PromptReference[] {
  const references: PromptReference[] = [];
  for (const match of text.matchAll(promptPattern)) {
    const [
      token,
      skill,
      mcpName,
      mcpId,
      wsName,
      wsId,
      wsPath,
      wsDevice,
      deviceName,
      deviceId,
      modelLabel,
      modelRef,
      modelName,
      acpName,
      acpClientId,
      acpTool,
      snippet,
      diagram,
      pullRequest,
    ] = match;
    const start = match.index;
    const end = start + token.length;
    if (skill !== undefined) {
      const value = skill.trim();
      if (!value) continue;
      const qualified = /^(?:user|project)::[^:]+::(.+)$/.exec(value)?.[1];
      const label = qualified ? qualified.split("/").pop() || qualified : value;
      references.push({ kind: "skill", token, label, start, end });
      continue;
    }
    try {
      if (mcpName !== undefined && mcpId !== undefined) {
        const label = JSON.parse(mcpName) as string;
        const id = JSON.parse(mcpId) as string;
        if (label.trim() && id.trim()) {
          references.push({ kind: "mcp", token, label, detail: id, start, end });
        }
        continue;
      }
      if (wsName !== undefined && wsId !== undefined) {
        const label = JSON.parse(wsName) as string;
        const id = JSON.parse(wsId) as string;
        const path = wsPath !== undefined ? (JSON.parse(wsPath) as string) : "";
        const device = wsDevice !== undefined ? (JSON.parse(wsDevice) as string) : "";
        if (label.trim() && id.trim()) {
          const detail = [path, device].filter(Boolean).join(" · ") || id;
          references.push({ kind: "workspace", token, label, detail, start, end });
        }
        continue;
      }
      if (deviceName !== undefined && deviceId !== undefined) {
        const label = JSON.parse(deviceName) as string;
        const id = JSON.parse(deviceId) as string;
        if (label.trim() && id.trim()) {
          references.push({ kind: "device", token, label, detail: id, start, end });
        }
        continue;
      }
      if (modelLabel !== undefined && modelRef !== undefined) {
        const label = JSON.parse(modelLabel) as string;
        const id = JSON.parse(modelRef) as string;
        const upstream = modelName !== undefined ? (JSON.parse(modelName) as string) : "";
        if (label.trim() && id.trim()) {
          const detail = [upstream, id].filter((value, index, list) => value && list.indexOf(value) === index).join(" · ");
          references.push({ kind: "model", token, label, detail, start, end });
        }
        continue;
      }
      if (acpName !== undefined && acpClientId !== undefined) {
        const label = JSON.parse(acpName) as string;
        const client = JSON.parse(acpClientId) as string;
        const tool = acpTool !== undefined ? (JSON.parse(acpTool) as string) : "";
        if (label.trim() && client.trim()) {
          references.push({ kind: "acp", token, label, detail: tool || client, start, end });
        }
        continue;
      }
      if (snippet !== undefined) {
        const context = readCodeSnippetContext(JSON.parse(JSON.parse(snippet)));
        if (context) references.push({ kind: "code-snippet", context, token, label: codeSnippetLabel(context), start, end });
        continue;
      }
      if (diagram !== undefined) {
        const context = readMermaidContext(JSON.parse(JSON.parse(diagram)));
        if (context) references.push({ kind: context.type, context, token, label: mermaidReferenceLabel(context), start, end });
        continue;
      }
      if (pullRequest !== undefined) {
        const context = readPullRequestContext(JSON.parse(JSON.parse(pullRequest)));
        if (context) references.push({ kind: context.type, context, token, label: context.label, start, end });
        continue;
      }
    } catch {
      // Keep malformed tokens in the surrounding text.
    }
  }
  return references;
}

export type PromptReferencePart =
  | { kind: "text"; text: string; start: number }
  | PromptReference;

export function promptReferenceParts(text: string): PromptReferencePart[] {
  const parts: PromptReferencePart[] = [];
  let start = 0;
  for (const reference of promptReferencesIn(text)) {
    if (reference.start > start) parts.push({ kind: "text", text: text.slice(start, reference.start), start });
    parts.push(reference);
    start = reference.end;
  }
  if (start < text.length) parts.push({ kind: "text", text: text.slice(start), start });
  return parts;
}
