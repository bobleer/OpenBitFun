import { isMap, isSeq, parseDocument } from "yaml";

export interface PlanTodo {
  id: string;
  content: string;
  status: string;
  sourceIndex: number | null;
}

export function isPlanDocument(path: string): boolean {
  return /\.plan\.md$/i.test(path);
}

export function readPlanDocument(markdown: string) {
  const opening = /^\uFEFF?---[ \t]*(\r?\n)/.exec(markdown);
  if (!opening) return { kind: "plain" as const, body: markdown };
  const rest = markdown.slice(opening[0].length);
  const closing = /^---[ \t]*(\r?\n|$)/m.exec(rest);
  if (!closing) return { kind: "invalid" as const, body: markdown };

  const body = rest.slice(closing.index + closing[0].length);
  const metadata = rest.slice(0, closing.index);
  const yaml = parseDocument(metadata);
  if (yaml.errors.length || !isMap(yaml.contents)) return { kind: "invalid" as const, body };
  const list = yaml.get("todos", true);
  if (list !== undefined && !isSeq(list)) return { kind: "invalid" as const, body };
  const todos: PlanTodo[] = [];
  for (const [sourceIndex, item] of (list?.items ?? []).entries()) {
    if (!isMap(item) || typeof item.get("content") !== "string") return { kind: "invalid" as const, body };
    todos.push({ sourceIndex, id: String(item.get("id") ?? ""), content: String(item.get("content")),
      status: String(item.get("status") ?? "pending") });
  }

  const name = yaml.get("name");
  const overview = yaml.get("overview");
  const lineEnding = opening[1];
  const gap = /^(?:[ \t]*\r?\n)*/.exec(body)?.[0] ?? "";
  const assemble = (nextMetadata: string, nextBody: string) =>
    opening[0] + nextMetadata + closing[0] + (!closing[1] && nextBody ? lineEnding : "") + gap + nextBody;
  return {
    kind: "plan" as const,
    name: typeof name === "string" ? name : "",
    overview: typeof overview === "string" ? overview : "",
    body: body.slice(gap.length),
    todos,
    withBody: (nextBody: string) => assemble(metadata, nextBody.replace(/\r?\n/g, lineEnding)),
    withTodos: (rows: readonly PlanTodo[]) => {
      const document = yaml.clone();
      const previous = document.get("todos", true);
      const sequence = isSeq(previous) ? previous : document.createNode([]);
      if (!isSeq(sequence)) return markdown;
      const existing = sequence.items;
      sequence.items = rows.map(row => {
        const item = row.sourceIndex === null ? null : existing[row.sourceIndex];
        if (!isMap(item)) return document.createNode({ id: row.id, content: row.content, status: row.status });
        if (item.get("content") !== row.content) item.set("content", row.content);
        return item;
      });
      if (!isSeq(previous)) document.set("todos", sequence);
      return assemble(document.toString().replace(/\n/g, lineEnding), body.slice(gap.length));
    },
  };
}
