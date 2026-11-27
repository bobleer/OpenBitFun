const diagramTypes = ["flowchart", "sequence", "class", "state", "er", "gantt", "other"] as const;
type DiagramType = (typeof diagramTypes)[number];

interface MermaidReferenceBase {
  id: string;
  timestamp: number;
  diagramTitle?: string;
}

export type MermaidContext = MermaidReferenceBase & (
  | { type: "mermaid-diagram"; diagramCode: string; diagramType?: DiagramType }
  | { type: "mermaid-node"; nodeId: string; nodeText: string; nodeType: Exclude<DiagramType, "other">; sourceCode?: string }
);

function isDiagramType(value: unknown): value is DiagramType {
  return typeof value === "string" && diagramTypes.some(type => type === value);
}

/** Read the diagram and node shapes stored by the Markdown and composer surfaces. */
export function readMermaidContext(value: unknown): MermaidContext | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) return;
  const base = {
    id: raw.id, timestamp: typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : 0,
    ...(typeof raw.diagramTitle === "string" && raw.diagramTitle.trim() ? { diagramTitle: raw.diagramTitle } : {}),
  };
  if (raw.type === "mermaid-diagram" && typeof raw.diagramCode === "string" && raw.diagramCode.trim()) {
    return { ...base, type: raw.type, diagramCode: raw.diagramCode,
      ...(isDiagramType(raw.diagramType) ? { diagramType: raw.diagramType } : {}) };
  }
  if (raw.type === "mermaid-node" && typeof raw.nodeId === "string" && raw.nodeId &&
    typeof raw.nodeText === "string" && raw.nodeText.trim() && isDiagramType(raw.nodeType) && raw.nodeType !== "other") {
    return { ...base, type: raw.type, nodeId: raw.nodeId, nodeText: raw.nodeText, nodeType: raw.nodeType,
      ...(typeof raw.sourceCode === "string" ? { sourceCode: raw.sourceCode } : {}) };
  }
}

export function mermaidReferenceLabel(context: MermaidContext): string {
  return context.type === "mermaid-node" ? context.nodeText : context.diagramTitle ?? "Mermaid diagram";
}

export function mermaidDraftToken(context: MermaidContext): string {
  return `Mermaid reference ${JSON.stringify(JSON.stringify(context))}`;
}

export function mermaidModelContext(context: MermaidContext): string {
  if (context.type === "mermaid-node") return `[Mermaid Node: ${context.nodeText}]`;
  const title = context.diagramTitle ? `: ${context.diagramTitle}` : "";
  let fenceLength = 3;
  for (const ticks of context.diagramCode.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, ticks[0].length + 1);
  const fence = "`".repeat(fenceLength);
  return `[Mermaid Diagram${title}]\n${fence}mermaid\n${context.diagramCode}\n${fence}`;
}
