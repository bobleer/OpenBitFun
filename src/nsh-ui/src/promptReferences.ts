import { codeSnippetLabel, readCodeSnippetContext, type CodeSnippetContext } from "./codeSnippetReference";
import { mermaidReferenceLabel, readMermaidContext, type MermaidContext } from "./mermaidReference";
import { readPullRequestContext, type PullRequestContext } from "./pullRequestReference";

interface PromptReferenceRange {
  token: string;
  label: string;
  start: number;
  end: number;
}

export type PromptReference = PromptReferenceRange & (
  | { kind: "skill" | "mcp" }
  | { kind: "code-snippet"; context: CodeSnippetContext }
  | { kind: "mermaid-diagram" | "mermaid-node"; context: MermaidContext }
  | { kind: "pull-request"; context: PullRequestContext }
);

const jsonString = String.raw`"(?:[^"\\\r\n]|\\[^\r\n])*"`;
const promptPattern = new RegExp(String.raw`\[\$([^\]\r\n]+)\]|\bMCP (${jsonString}) \(server: (${jsonString})\)|\bCode snippet (${jsonString})|\bMermaid reference (${jsonString})|\bPull request reference (${jsonString})`, "g");

export function skillPromptToken(name: string): string {
  return `[$${name.trim()}]`;
}

export function mcpPromptToken(serverId: string, serverName: string): string {
  return `MCP ${JSON.stringify(serverName)} (server: ${JSON.stringify(serverId)})`;
}

/** Read exactly the prompt that is sent to the runtime, including older saved drafts. */
export function promptReferencesIn(text: string): PromptReference[] {
  const references: PromptReference[] = [];
  for (const match of text.matchAll(promptPattern)) {
    const [token, skill, mcpName, mcpId, snippet, diagram, pullRequest] = match;
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
      const label = JSON.parse(mcpName) as string;
      const id = JSON.parse(mcpId) as string;
      if (label.trim() && id.trim()) references.push({ kind: "mcp", token, label, start, end });
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
