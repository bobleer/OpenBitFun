import { isInlinePlainPromptReference, promptReferenceParts, promptReferencesIn } from "./promptReferences";
import {
  codeSnippetLabel, codeSnippetLocation, codeSnippetPromptToken, readCodeSnippetContext, type CodeSnippetContext,
} from "./codeSnippetReference";
import { mermaidDraftToken, mermaidModelContext, readMermaidContext, type MermaidContext } from "./mermaidReference";
import { pullRequestDraftToken, pullRequestModelContext, readPullRequestContext, type PullRequestContext } from "./pullRequestReference";

export interface SessionReferenceCandidate {
  sessionId: string;
  sessionName: string;
  workspaceId: string;
  workspacePath: string;
  workspaceLabel: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export interface SessionReferenceDraft {
  text: string;
  references: SessionReferenceCandidate[];
}

export function sessionReferenceKey(reference: SessionReferenceCandidate): string {
  return JSON.stringify([reference.workspaceId, reference.sessionId]);
}

export function readSessionReference(value: unknown): SessionReferenceCandidate | undefined {
  const record = value as Partial<SessionReferenceCandidate> | undefined;
  if (!record || typeof record.sessionId !== "string" || !record.sessionId ||
    typeof record.sessionName !== "string" || !record.sessionName ||
    typeof record.workspaceId !== "string" || !record.workspaceId ||
    typeof record.workspacePath !== "string" || !record.workspacePath) return undefined;
  return {
    sessionId: record.sessionId, sessionName: record.sessionName,
    workspaceId: record.workspaceId, workspacePath: record.workspacePath,
    workspaceLabel: typeof record.workspaceLabel === "string" ? record.workspaceLabel : record.workspacePath,
    remoteConnectionId: typeof record.remoteConnectionId === "string" ? record.remoteConnectionId : undefined,
    remoteSshHost: typeof record.remoteSshHost === "string" ? record.remoteSshHost : undefined,
  };
}

export function mergeSessionReferences(
  current: readonly SessionReferenceCandidate[], added: readonly SessionReferenceCandidate[],
): SessionReferenceCandidate[] {
  return [...new Map([...current, ...added].map(reference => [sessionReferenceKey(reference), reference])).values()];
}

function sessionReferenceDisplayText(text: string, references: readonly SessionReferenceCandidate[]): string {
  return [text, ...references.map(reference => `@${reference.sessionName}`)].filter(Boolean).join(" ");
}

export function composerReferenceDisplayText(draft: SessionReferenceDraft | undefined, fallback: string): string {
  return draft ? sessionReferenceDisplayText(draft.text, draft.references) : fallback;
}

/** Read the same presentation from an owner queue snapshot after reconnecting. */
export function sessionReferenceDraft(presentation: unknown): SessionReferenceDraft | undefined {
  const value = presentation as { version?: unknown; segments?: unknown } | null | undefined;
  if (value?.version !== 1 || !Array.isArray(value.segments)) return undefined;
  const references = new Map<string, SessionReferenceCandidate>();
  let hasPromptReference = false;
  const text = value.segments.map(segment => {
    if (segment?.kind === "text") return typeof segment.text === "string" ? segment.text : "";
    if (segment?.kind === "inline-token") {
      const token = typeof segment.token === "string" ? segment.token : "";
      if (segment.tokenType === "skill" && promptReferencesIn(token).some(ref => ref.kind === "skill" && ref.token === token)) {
        hasPromptReference = true;
      }
      return token;
    }
    if (segment?.kind !== "context") return "";
    const tag = typeof segment.tag === "string" ? segment.tag : "";
    const context = segment.context;
    if (context?.type === "code-snippet") {
      const snippet = readCodeSnippetContext(context);
      if (!snippet) return tag;
      hasPromptReference = true;
      return codeSnippetPromptToken(snippet);
    }
    if (context?.type === "mermaid-diagram" || context?.type === "mermaid-node") {
      const mermaid = readMermaidContext(context);
      if (!mermaid) return tag;
      hasPromptReference = true;
      return mermaidDraftToken(mermaid);
    }
    if (context?.type === "pull-request") {
      const pullRequest = readPullRequestContext(context);
      if (!pullRequest) return tag;
      hasPromptReference = true;
      return pullRequestDraftToken(pullRequest);
    }
    if (context?.type !== "session-reference") return tag;
    const reference = readSessionReference(context);
    if (!reference) return tag;
    references.set(sessionReferenceKey(reference), reference);
    return "";
  }).join("").trim();
  return references.size || hasPromptReference ? { text, references: [...references.values()] } : undefined;
}

/** Preserve the locator and the readable presentation each host already accepts. */
export function messageWithSessionReferences(text: string, references: readonly SessionReferenceCandidate[]) {
  const parts = promptReferenceParts(text);
  const hasPresentation = parts.some(part => part.kind !== "text" && !isInlinePlainPromptReference(part.kind));
  if (references.length === 0 && !hasPresentation) return { text, displayText: text };
  const promptContexts = new Map<string, string>();
  const segments = parts.reduce<Array<
    { kind: "text"; text: string } | { kind: "inline-token"; tokenType: "skill"; token: string; label: string } |
    { kind: "context"; context: CodeSnippetContext | MermaidContext | PullRequestContext; tag: string; label: string; title: string }
  >>((result, part) => {
    if (part.kind === "skill") {
      result.push({ kind: "inline-token", tokenType: "skill", token: part.token, label: part.label });
    } else if (part.kind === "code-snippet") {
      promptContexts.set(part.context.id, `[Code Snippet: ${codeSnippetLocation(part.context)}]`);
      result.push({
        kind: "context", context: part.context, tag: `#code:${codeSnippetLabel(part.context)}`,
        label: part.label, title: codeSnippetLocation(part.context),
      });
    } else if (part.kind === "mermaid-diagram" || part.kind === "mermaid-node") {
      promptContexts.set(part.context.id, mermaidModelContext(part.context));
      const prefix = part.kind === "mermaid-diagram" ? "#mermaid:" : "#chart:";
      result.push({ kind: "context", context: part.context, tag: prefix + part.label,
        label: part.label, title: part.context.diagramTitle ?? part.label });
    } else if (part.kind === "pull-request") {
      promptContexts.set(part.context.id, pullRequestModelContext(part.context));
      result.push({
        kind: "context", context: part.context, tag: `#pr:${part.label.replace(/\s+/g, "_")}`,
        label: part.label, title: part.label,
      });
    } else {
      const chunk = part.kind === "text" ? part.text : part.token;
      const previous = result.at(-1);
      if (previous?.kind === "text") previous.text += chunk;
      else result.push({ kind: "text", text: chunk });
    }
    return result;
  }, []);
  const contextHeader = [...promptContexts.values()].join("\n");
  const body = segments.map(segment => segment.kind === "text" ? segment.text
    : segment.kind === "context" ? segment.tag : segment.token).join("");
  const prompt = [body, ...references.map((_, index) => `[session-ref:${index + 1}]`)].filter(Boolean).join(" ");
  return {
    text: contextHeader ? `${contextHeader}\n\n${prompt}` : prompt,
    displayText: sessionReferenceDisplayText(body, references),
    userMessageMetadata: {
      ...(references.length ? { sessionReferences: references.map(({ sessionId, workspaceId, workspacePath, remoteConnectionId, remoteSshHost }) => ({
        sessionId, workspaceId, workspacePath, remoteConnectionId, remoteSshHost,
      })) } : {}),
      composerPresentation: {
        version: 1,
        segments: [
          ...segments,
          ...references.flatMap(reference => [
            { kind: "text", text: " " },
            {
              kind: "context",
              context: { ...reference, id: sessionReferenceKey(reference), type: "session-reference", timestamp: Date.now() },
              tag: `[session: ${reference.sessionName}]`,
              label: reference.sessionName,
              title: reference.workspaceLabel,
            },
          ]),
        ],
      },
    },
  };
}
