import { z } from 'zod/v4';

const bytes = (value: string) => new TextEncoder().encode(value).length;
const interval = (min: number) => z.number().int().min(min).max(86400);
const spec = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('json'), value: z.json() }),
  z.strictObject({
    type: z.literal('image'),
    url: z
      .string()
      .max(8192)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === 'https:' && !url.username && !url.password && !url.port && !/[#\\\s]/.test(value)
          );
        } catch {
          return false;
        }
      }),
  }),
  z.strictObject({
    type: z.literal('file'),
    path: z
      .string()
      .max(512)
      .regex(/^\.\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/),
  }),
  z.strictObject({
    type: z.literal('library'),
    libraryFileId: z.string().regex(/^libfile_[\w-]{1,128}$/),
    refreshIntervalSeconds: interval(15),
  }),
  z.strictObject({
    type: z.literal('tool'),
    tool: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.json()),
    refreshIntervalSeconds: interval(60),
  }),
]);
export type Binding = z.infer<typeof spec>;
export type RefreshableBinding = Extract<Binding, { type: "tool" | "library" }>;
export type Declarations = Record<string, Binding>;
const name = z
  .string()
  .regex(/^[A-Za-z][\w-]{0,63}$/)
  .refine((k) => !['prototype', 'constructor'].includes(k));
const header = z.record(name, spec);

export function readBindings(html: string): Declarations | null {
  if (!html.startsWith('<!-- vis-bindings')) return {};
  const end = html.indexOf('\n-->\n');
  if (
    !html.startsWith('<!-- vis-bindings\n') ||
    end < 0 ||
    end > 32768 ||
    bytes(html.slice(0, end + 5)) > 32768
  )
    return null;
  const declaration = html.slice('<!-- vis-bindings\n'.length, end);
  if (/[<>]/.test(declaration)) return null;
  try {
    // JSON.parse discards earlier duplicate keys. Check the token stream after
    // parsing so replay agrees with the upstream validator on ambiguous input.
    const parsed = JSON.parse(declaration);
    const objects: (Set<string> | null)[] = [];
    for (const token of declaration.matchAll(/"(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|[[\]{}]/g)) {
      const part = token[0];
      if (part === '{' || part === '[') objects.push(part === '{' ? new Set() : null);
      else if (part === '}' || part === ']') objects.pop();
      else if (part.endsWith(':')) {
        const key = JSON.parse(part.slice(0, -1));
        const keys = objects[objects.length - 1];
        if (keys?.has(key)) return null;
        keys?.add(key);
      }
    }
    const result = header.parse(parsed);
    return Object.keys(result).length <= 8 ? result : null;
  } catch {
    return null;
  }
}
