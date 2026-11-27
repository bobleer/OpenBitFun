// The installed NSH 0.7 editor's built-in LanguageConfig names and indentation
// defaults. Its TypeScript Editor API accepts these names but does not list them.
export const editorLanguages = [
  "Plain Text", "C", "C#", "C++", "Clojure", "CMake", "CSS", "Dart", "Diff", "Dockerfile", "Elixir",
  "Erlang", "F#", "Fish", "Go", "GraphQL", "Haskell", "HTML", "INI", "Java", "JavaScript", "JSON",
  "JSX", "Julia", "Kotlin", "Less", "Lua", "Makefile", "Markdown", "Nix", "Objective-C", "Objective-C++",
  "OCaml", "Perl", "PHP", "PowerShell", "Protocol Buffers", "Python", "R", "Ruby", "Rust", "Sass",
  "Scala", "SCSS", "Shell", "SQL", "Svelte", "Swift", "Terraform", "TOML", "TSX", "TypeScript",
  "Vue", "XML", "YAML", "Zig",
] as const;

const twoSpaceLanguages: ReadonlySet<string> = new Set([
  "Clojure", "CSS", "Dart", "Elixir", "F#", "GraphQL", "Haskell", "HTML", "JavaScript", "JSON", "JSX",
  "Less", "Lua", "Markdown", "Nix", "OCaml", "Protocol Buffers", "R", "Ruby", "Sass", "Scala", "SCSS",
  "Shell", "Svelte", "Terraform", "TSX", "TypeScript", "Vue", "XML", "YAML",
]);

const languageAliases: Readonly<Record<string, string>> = {
  bash: "Shell", csharp: "C#", cpp: "C++", fsharp: "F#", hcl: "Terraform", jsonc: "JSON",
  objc: "Objective-C", objcpp: "Objective-C++", protobuf: "Protocol Buffers",
  text: "Plain Text", plaintext: "Plain Text",
};

export function resolveEditorLanguage(id: string): string | undefined {
  const lower = id.toLowerCase();
  return editorLanguages.find(language => language.toLowerCase() === lower) ?? languageAliases[lower];
}

export function defaultEditorIndentation(language: string): { tabSize: number; hardTabs: boolean } {
  return { tabSize: twoSpaceLanguages.has(language) ? 2 : 4, hardTabs: language === "Go" || language === "Makefile" };
}
