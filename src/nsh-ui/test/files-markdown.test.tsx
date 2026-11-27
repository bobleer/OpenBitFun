// Documents in the Files pane: Markdown directly editable Preview | Split | Source
// with lossless YAML frontmatter, workspace images in the visual editor, semantic
// fidelity guard for raw HTML / reference links / footnotes / alerts, save & conflict
// through `write_file_content`, inline AI over `editor_ai_*`, HTML preview, and PDFs.
import { expect, open, test } from "nsh/test";
import { createCodeSnippetContext } from "../src/codeSnippetReference";
import { latexOutline, latexSnippetEdit, moveLatexStops } from "../src/latexSource";
import { parsePdfReview, pdfReviewSidecar } from "../src/pdfReviewData";
import { readPlanDocument } from "../src/planDocument";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession, openToolScene, selectTreeWorkspace, type Backend, type BackendOptions } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const PHONE = { width: 375, height: 812, platform: "web" as const };

const FILES = [
  { name: "README.md", path: "/repo/README.md", isDirectory: false },
  { name: "notes.md", path: "/repo/notes.md", isDirectory: false },
  { name: "guide.md", path: "/repo/guide.md", isDirectory: false },
  { name: "page.md", path: "/repo/page.md", isDirectory: false },
  { name: "logo.png", path: "/repo/logo.png", isDirectory: false },
  { name: "index.html", path: "/repo/index.html", isDirectory: false },
  { name: "manual.pdf", path: "/repo/manual.pdf", isDirectory: false, size: 2048 },
];

const TEXT: Record<string, string> = {
  "/repo/README.md": "# Project\n\nMarkdown preview from the host.",
  // YAML frontmatter is preserved verbatim while the body edits visually.
  "/repo/notes.md": "---\ntitle: Notes\n---\n\n# Notes\n\nKept as written.\n",
  // Common real-world Markdown: `*` bullets, nested lists, `_italic_`, tight table, workspace image.
  "/repo/guide.md": "# Guide\n\n* item one\n  * nested item\n\nUse _italic_ and ![Logo](./logo.png).\n\n|A|B|\n|---|---|\n|1|2|\n",
  // Raw HTML: cannot round-trip visually, so Preview stays read-only with Split/Source editing.
  "/repo/page.md": '<div align="center">Centered</div>\n\nBody text.\n',
  "/repo/logo.png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "/repo/index.html": "<!doctype html><html><body><h1>Hello page</h1></body></html>\n",
  "/repo/manual.pdf": "JVBERi0xLjQK",
};
const IMAGE_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

interface DocHarness extends Backend {
  handlers: Record<string, (data: unknown) => unknown>;
  writes: Array<{ workspaceId?: string; filePath: string; content: string; expectedHash?: string }>;
  calls: Array<Backend["calls"][number] & { payload: Record<string, unknown> }>;
  /** Another writer changes a file on disk. */
  externalWrite(path: string, text: string): void;
}

function documentsBackend(
  options: BackendOptions = {},
  decoded?: { encoding: string; content: string; hasBom: boolean },
): DocHarness {
  const base: Backend = createBackend({ files: FILES, fileContent: TEXT, ...options });
  const text: Record<string, string> = { ...TEXT, ...(options.fileContent ?? {}) };
  const versions: Record<string, number> = {};
  const writes: DocHarness["writes"] = [];
  const calls: DocHarness["calls"] = [];
  const original = base.handlers["openbitfun.invoke"];
  const handlers = {
    ...base.handlers,
    "openbitfun.invoke": (data: unknown) => {
      const args = (data ?? {}) as { action?: string; request?: unknown; raw?: unknown };
      const action = args.action ?? "";
      const payload = ((args.request ?? args.raw) ?? {}) as Record<string, unknown>;
      calls.push({ action, request: args.request ?? args.raw, raw: args.raw !== undefined, payload });
      switch (action) {
        case "read_file_content": {
          const path = String(payload.filePath ?? "");
          if (decoded && payload.textEncoding === decoded.encoding && path in text) {
            return { ok: true, transport: "dev", value: {
              ...decoded, sha256: crypto.createHash("sha256").update(text[path]).digest("hex"),
            } };
          }
          if (path in text) return { ok: true, value: text[path], transport: "dev" };
          return original(data);
        }
        case "get_file_metadata": {
          const path = String(payload.path ?? "");
          if (path in text) {
            return {
              ok: true,
              value: { path, modified: versions[path] ?? 1_700_000_000_000, size: text[path].length },
              transport: "dev",
            };
          }
          return original(data);
        }
        case "write_file_content": {
          const filePath = String(payload.filePath ?? "");
          const content = String(payload.content ?? "");
          if (typeof payload.expectedHash === "string") {
            const actual = crypto.createHash("sha256").update(text[filePath] ?? "").digest("hex");
            if (actual !== payload.expectedHash) {
              return { ok: false, error: "FILE_CONFLICT: File changed after it was read; refresh before saving", transport: "dev" };
            }
          }
          text[filePath] = content;
          versions[filePath] = (versions[filePath] ?? 1_700_000_000_000) + 1;
          writes.push({
            workspaceId: typeof payload.workspaceId === "string" ? payload.workspaceId : undefined,
            filePath,
            content,
            ...(typeof payload.expectedHash === "string" ? { expectedHash: payload.expectedHash } : {}),
          });
          return { ok: true, value: null, transport: "dev" };
        }
        case "editor_ai_stream":
        case "editor_ai_cancel":
        case "open_html_file_in_browser":
          return { ok: true, value: action === "editor_ai_stream" ? { ok: true } : null, transport: "dev" };
        default:
          return original(data);
      }
    },
  };
  return {
    ...base,
    handlers,
    writes,
    calls,
    externalWrite(path, value) {
      text[path] = value;
      versions[path] = (versions[path] ?? 1_700_000_000_000) + 1000;
    },
  };
}

/** The same backend over the native desktop's wire and NSH shell (`fixtures/nativeApp.tsx`). */
function overNativeWire(harness: DocHarness): Record<string, (data: unknown) => unknown> {
  return {
    ...harness.handlers,
    "openbitfun.wireReady": () => JSON.stringify({ version: "9.8.7", platform: "macos", dataDir: "/tmp/openbitfun-test" }),
    "openbitfun.wirePickDirectory": () => "null",
    "openbitfun.wireInvoke": (data: unknown) => {
      const { command, argsJson } = data as { command: string; argsJson: string };
      const args = JSON.parse(argsJson) as Record<string, unknown>;
      if (command === "host_shell_attach" || command === "host_shell_respond") return "null";
      const keys = Object.keys(args);
      const requestShape = keys.length === 0 || (keys.length === 1 && keys[0] === "request");
      const reply = harness.handlers["openbitfun.invoke"](
        requestShape ? { action: command, request: args.request ?? null } : { action: command, raw: args },
      ) as { ok: boolean; value?: unknown; error?: string };
      if (!reply.ok) throw new Error(reply.error ?? `${command} failed`);
      return JSON.stringify(reply.value ?? null);
    },
  };
}

async function openFiles(app: Awaited<ReturnType<typeof open>>): Promise<void> {
  await app.waitFor("nav-library");
  await openToolScene(app, "files");
  await app.waitFor("Explorer");
}

const codePath = "/repo/notes.ts";
const codeText = 'const label = "示例";\r\nconst count = 3;\r\n';
const codeFiles = [{ name: "notes.ts", path: codePath, isDirectory: false }];

test("a reversed snippet selection preserves UTF-16 columns and does not include the next empty line", () => {
  expect(createCodeSnippetContext(codePath, "notes.ts", "typescript", "a😀tail\r\nend\n", {
    anchor: { line: 2, column: 0 }, head: { line: 0, column: 3 },
  })).toMatchObject({ startLine: 1, endLine: 2, selectedText: "tail\r\nend\n" });
});

async function selectCode(app: Awaited<ReturnType<typeof open>>) {
  await openFiles(app);
  await app.press("notes.ts");
  await app.waitFor("file-editor");
  await app.type("file-editor", "");
  await app.keyboard.press("mod+a");
}

test("the editor status bar jumps to a line and column and keeps the document intact", async () => {
  const backend = documentsBackend({ files: codeFiles, fileContent: { [codePath]: codeText } });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("notes.ts");
  await app.waitFor("file-editor");
  const initialText = app.value("file-editor");

  await app.press("file-go-to-line");
  await app.waitFor("file-go-to-line-input");
  expect(app.value("file-go-to-line-input")).toBe("1:1");
  await app.clear("file-go-to-line-input");
  await app.type("file-go-to-line-input", "2:x");
  await app.submit("file-go-to-line-input");
  await app.waitFor("Use positive whole numbers for the line and column.");
  await app.clear("file-go-to-line-input");
  await app.type("file-go-to-line-input", "2:5");
  await app.submit("file-go-to-line-input");
  await app.waitFor("Ln 2, Col 5");

  await app.keyboard.press("mod+g");
  await app.waitFor("file-go-to-line-input");
  expect(app.value("file-go-to-line-input")).toBe("2:5");
  await app.clear("file-go-to-line-input");
  await app.type("file-go-to-line-input", "999:999");
  await app.press("file-go-to-line-confirm");
  await app.waitFor("Ln 3, Col 1");
  expect(app.value("file-editor")).toBe(initialText);
  expect(backend.calls.some(call => call.action === "write_file_content")).toBe(false);
});

test("the editor language and indentation are native options of the current file tab", async () => {
  const otherPath = "/repo/other.ts";
  const backend = documentsBackend({
    files: [...codeFiles, { name: "other.ts", path: otherPath, isDirectory: false }],
    fileContent: { [codePath]: codeText, [otherPath]: "const other = true;\n" },
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("notes.ts");
  await app.waitFor("file-editor");
  await app.waitFor("Spaces: 4");
  const initialText = app.value("file-editor");

  await app.press("file-language-menu");
  await app.press("file-language-Python");
  await app.waitFor("Python");
  await app.waitFor("Spaces: 4");
  expect(app.value("file-editor")).toBe(initialText);
  await app.press("file-indent-menu");
  await app.press("file-indent-tabs-3");
  await app.waitFor("Tabs: 3");

  await app.press("other.ts");
  await app.waitFor("TypeScript");
  await app.waitFor("Spaces: 4");
  await app.press("file-tab-notes.ts");
  await app.waitFor("Python");
  await app.waitFor("Tabs: 3");
  await app.type("file-editor", "");
  await app.keyboard.press("mod+home");
  await app.keyboard.press("tab");
  await app.waitUntil(() => (app.value("file-editor") ?? "").startsWith("\tconst label"));
  await app.keyboard.press("mod+/");
  await app.waitUntil(() => (app.value("file-editor") ?? "").startsWith("\t# const label"));

  await app.press("file-language-menu");
  await app.press("file-language-automatic");
  await app.waitFor("TypeScript");
  await app.press("file-indent-menu");
  await app.press("file-indent-automatic");
  await app.waitFor("Spaces: 4");
  expect(backend.calls.some(call => call.action === "write_file_content")).toBe(false);
});

test("decoding is scoped to the file tab and conversion uses the original disk hash", async () => {
  const otherPath = "/repo/other.ts";
  const backend = documentsBackend({
    files: [...codeFiles, { name: "other.ts", path: otherPath, isDirectory: false }],
    fileContent: { [codePath]: codeText, [otherPath]: "const other = true;" },
  }, { encoding: "gbk", content: "const title = '中文';\n", hasBom: false });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("notes.ts");
  await app.waitFor("file-editor");

  await app.press("file-encoding-menu");
  await app.press("file-encoding-gbk");
  await app.waitUntil(() => app.value("file-editor") === "const title = '中文';\n");
  expect(backend.calls.find(call => call.payload.textEncoding === "gbk")?.payload)
    .toMatchObject({ workspaceId: "workspace-1", filePath: codePath });
  expect(backend.writes).toHaveLength(0);

  await app.type("file-editor", "const title = '修改';");
  await app.waitFor("Unsaved changes");
  await app.press("other.ts");
  await app.waitUntil(() => app.value("file-editor") === "const other = true;");
  await app.press("file-tab-notes.ts");
  await app.waitFor("GBK");
  await app.waitFor("Unsaved changes");
  const draft = app.value("file-editor");
  await app.press("file-save");
  await app.waitFor("file-encoding-save-utf8");
  expect(backend.writes).toHaveLength(0);
  await app.press("file-encoding-save-utf8");
  await app.waitUntil(() => backend.writes.length === 1);
  expect(backend.writes[0]).toMatchObject({
    content: draft, expectedHash: crypto.createHash("sha256").update(codeText).digest("hex"),
  });
  await app.waitFor("UTF-8");
});

test("an older host's plain string cannot be mistaken for a decoded snapshot", async () => {
  const backend = documentsBackend({ files: codeFiles, fileContent: { [codePath]: codeText } });
  const app = await open("../App.tsx", { ...PHONE, width: 1440, height: 900, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.setViewport(PHONE.width, PHONE.height);
  await app.press("notes.ts");
  await app.waitFor("file-editor");
  const original = app.value("file-editor");
  await app.press("file-encoding-menu");
  await app.press("file-encoding-utf16le");
  await app.waitFor("The workspace device does not support reopening with an encoding. Update it to use this option.");
  expect(app.value("file-editor")).toBe(original);
  expect(backend.writes).toHaveLength(0);
});

test("a browser reads encoded files and display preferences from the SSH workspace owner", async () => {
  const backend = documentsBackend(
    { files: codeFiles, fileContent: { [codePath]: codeText }, configs: { editor: { line_numbers: "off" } } },
    { encoding: "utf16le", content: "const label = '远程';\n", hasBom: true },
  );
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Owner", [{
          workspaceId: "ws-b", name: "Remote workspace", rootPath: "/repo", kind: "remote_ssh",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Remote session")],
        }], { hostKind: "cli", state: "online", hostCapabilities: ["file_text_encoding_v1"] }),
      ],
    },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-b1");
  await selectCode(app);
  expect(host.fleetCalls.find(call => call.command === "get_config" &&
    (call.args.request as { path?: string })?.path === "editor")).toMatchObject({ target: "dev-b" });
  expect(app.texts()).not.toContain("2");
  await app.press("file-encoding-menu");
  await app.press("file-encoding-utf16le");
  await app.waitUntil(() => app.value("file-editor") === "const label = '远程';\n");
  expect(host.fleetCalls.find(call => call.command === "read_file_content" &&
    (call.args.request as { textEncoding?: string })?.textEncoding === "utf16le")).toMatchObject({
    target: "dev-b", args: { request: { workspaceId: "ws-b", filePath: codePath, textEncoding: "utf16le" } },
  });
  expect(host.pageHostCalls).toHaveLength(0);
});

test("file indentation follows the detected content and the owning editor settings", async () => {
  const spacesPath = "/repo/spaces.rs";
  const tabsPath = "/repo/tabs.rs";
  const backend = documentsBackend({
    files: [
      { name: "spaces.rs", path: spacesPath, isDirectory: false },
      { name: "tabs.rs", path: tabsPath, isDirectory: false },
    ],
    fileContent: {
      [spacesPath]: "fn main() {\r\n  one();\r\n  two();\r\n}\r\n",
      [tabsPath]: "fn main() {\n\tone();\n\ttwo();\n}\n",
    },
    configs: { editor: { tab_size: 6, insert_spaces: true, detect_indentation: true } },
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("spaces.rs");
  await app.waitFor("Spaces: 2");
  await app.type("file-editor", "");
  await app.keyboard.press("mod+home");
  await app.keyboard.press("tab");
  await app.waitUntil(() => (app.value("file-editor") ?? "").startsWith("  fn main()"));

  await app.press("tabs.rs");
  await app.waitFor("Tabs: 6");
  await app.press("file-indent-menu");
  await app.press("file-indent-spaces-3");
  await app.waitFor("Spaces: 3");
  await app.press("Settings");
  await app.press("nav-settings-page-editor");
  await app.press("id:editor-detect-indentation");
  await app.waitUntil(() => backend.calls.some(call =>
    call.action === "set_config" && call.payload.path === "editor.detect_indentation" && call.payload.value === false));

  await openFiles(app);
  await app.waitFor("Spaces: 3");
  await app.press("file-indent-menu");
  await app.press("file-indent-automatic");
  await app.waitFor("Spaces: 6");
  await app.press("file-tab-spaces.rs");
  await app.waitFor("Spaces: 6");
  expect((app.value("file-editor") ?? "").startsWith("  fn main()")).toBe(true);
  expect(backend.writes).toHaveLength(0);
});

test("an older editor host keeps explicit tab settings without automatic detection", async () => {
  const backend = documentsBackend({
    files: codeFiles,
    fileContent: { [codePath]: "function greet() {\n  hi();\n  bye();\n}\n" },
    configs: { editor: { tab_size: 8, insert_spaces: false } },
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("notes.ts");
  await app.waitFor("Tabs: 8");
  expect(backend.writes).toHaveLength(0);
});

test("editor display settings preserve saved legacy choices and refresh the source view without saving the draft", async () => {
  const plainPath = "/repo/notes.txt";
  const backend = documentsBackend({
    files: [...codeFiles, { name: "notes.txt", path: plainPath, isDirectory: false }],
    fileContent: { [codePath]: codeText, [plainPath]: "Plain text in the source viewer.\nSecond line.\n" },
    configs: { editor: { font_size: 16, line_height: 1.5, word_wrap: "bounded", line_numbers: "relative" } },
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("notes.ts");
  await app.waitFor("file-editor");
  expect(app.texts()).toContain("3");
  await app.type("file-editor", "Draft comment");
  const draft = app.value("file-editor");
  expect(draft).toContain("Draft comment");

  await app.press("Settings");
  await app.press("nav-settings-page-editor");
  await app.press("editor-font-size-increase");
  await app.press("editor-line-height-increase");
  await app.press("id:editor-word-wrap");
  await app.waitFor("label:editor-word-wrap-bounded");
  expect(app.enabled("label:editor-word-wrap-bounded")).toBe(false);
  await app.press("label:editor-word-wrap-on");
  await app.press("id:editor-line-numbers");
  await app.waitFor("label:editor-line-numbers-relative");
  expect(app.enabled("label:editor-line-numbers-relative")).toBe(false);
  await app.press("label:editor-line-numbers-off");
  await app.waitUntil(() => backend.settingsWrites.some(write => write.path === "editor.line_numbers"));
  expect(backend.settingsWrites.filter(write => write.path.startsWith("editor."))).toEqual([
    { path: "editor.font_size", value: 17 },
    { path: "editor.line_height", value: 1.6 },
    { path: "editor.word_wrap", value: "on" },
    { path: "editor.line_numbers", value: "off" },
  ]);

  const readsBeforeReopen = backend.calls.filter(call => call.action === "get_config" && call.payload.path === "editor").length;
  await openFiles(app);
  await app.waitUntil(() => backend.calls.filter(call => call.action === "get_config" &&
    call.payload.path === "editor").length > readsBeforeReopen);
  await app.waitUntil(() => !app.texts().includes("3"));
  expect(app.value("file-editor")).toBe(draft);
  await app.press("notes.txt");
  await app.waitUntil(() => app.value("file-editor")?.startsWith("Plain text in the source viewer.") === true);
  expect(app.texts()).not.toContain("3");
  expect(backend.writes).toHaveLength(0);
});

test("a file editor selection enters the composer as a structured code snippet", async () => {
  const backend = documentsBackend({ files: codeFiles, fileContent: { [codePath]: codeText } });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await selectCode(app);
  await app.press("file-add-selection-to-chat");
  await app.waitFor("composer-prompt-reference-code-snippet-notes.ts:1-2");
  expect(backend.calls.some(call => call.action === "submit_user_message")).toBe(false);
  await app.press("Send");
  const request = backend.calls.find(call => call.action === "submit_user_message")?.payload;
  expect(request).toMatchObject({
    sessionId: "session-1", text: "[Code Snippet: /repo/notes.ts:1-2]\n\n#code:notes.ts:1-2",
    displayText: "#code:notes.ts:1-2",
    userMessageMetadata: { composerPresentation: { version: 1, segments: [{
      kind: "context", label: "notes.ts:1-2", tag: "#code:notes.ts:1-2",
      context: { type: "code-snippet", filePath: codePath, fileName: "notes.ts",
        startLine: 1, endLine: 2, selectedText: codeText },
    }] } },
  });
});

test("a remote workspace snippet follows its session's fleet owner", async () => {
  const backend = createBackend({
    files: codeFiles, fileContent: { [codePath]: codeText },
    configs: { editor: { tab_size: 8, insert_spaces: false } },
  });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Owner", [{
          workspaceId: "ws-b", name: "Remote workspace", rootPath: "/repo", kind: "remote_ssh",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Remote session")],
        }], { hostKind: "desktop", state: "online" }),
      ],
    },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-b1");
  await selectCode(app);
  await app.waitFor("Tabs: 8");
  expect(host.fleetCalls.find(call => call.command === "get_config" &&
    (call.args.request as { path?: string } | undefined)?.path === "editor")).toMatchObject({
    target: "dev-b", args: { request: { path: "editor" } },
  });
  await app.press("file-add-selection-to-chat");
  await app.waitFor("composer-prompt-reference-code-snippet-notes.ts:1-2");
  await app.press("Send");
  expect(host.fleetCalls.find(call => call.command === "submit_user_message")).toMatchObject({
    target: "dev-b", args: { request: { sessionId: "s-b1", workspaceId: "ws-b",
      text: "[Code Snippet: /repo/notes.ts:1-2]\n\n#code:notes.ts:1-2",
    } },
  });
  expect(host.pageHostCalls).toHaveLength(0);
});

test("Editable Markdown Preview, Split and Source share the draft copied and saved by the toolbar", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);

  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.waitFor("Markdown preview from the host.");
  // Rendered heading directly in editable Preview (no raw `# ` prefix, clean on open).
  expect(app.texts().join("\n")).not.toContain("# Project");
  expect(app.shows("Unsaved changes")).toBe(false);
  expect(app.shows("doc-source-fallback")).toBe(false);
  expect(app.shows("file-preview")).toBe(true);
  expect(app.shows("file-split")).toBe(true);
  expect(app.shows("file-source")).toBe(true);

  // Type immediately without clicking a separate Edit button.
  await app.type("file-editor", "Intro ");
  await app.waitFor("Unsaved changes");

  // Split shows the source editor and live rendered preview side by side.
  await app.press("file-split");
  await app.waitFor("file-markdown-preview");
  await app.waitFor("Intro Project");
  expect(app.shows("file-editor")).toBe(true);
  expect(app.shows("Unsaved changes")).toBe(true);
  const draft = "# Intro Project\n\nMarkdown preview from the host.\n";
  await app.press("file-copy-markdown");
  await app.waitUntil(() => app.clipboard() === draft);
  expect(backend.writes).toHaveLength(0);
  await app.press("file-source");
  await app.waitUntil(() => app.value("file-editor") === draft);
  await app.press("file-preview");
  await app.waitFor("file-editor");

  await app.press("file-save");
  await app.waitFor("Saved README.md");
  expect(backend.writes).toHaveLength(1);
  expect(backend.writes[0]).toMatchObject({ workspaceId: "workspace-1", filePath: "/repo/README.md" });
  expect(backend.writes[0].content).toBe(draft);
  expect(backend.writes[0].expectedHash).toMatch(/^[0-9a-f]{64}$/);
  // Saving keeps the user right in editable Preview, now clean.
  expect(app.shows("file-editor")).toBe(true);
  expect(app.shows("Unsaved changes")).toBe(false);
});

test("a Markdown content hit opens rich text at the selected occurrence without changing the draft", async () => {
  const path = "/repo/README.md";
  const paragraphs = Array.from({ length: 36 }, (_, index) => `Paragraph ${index + 1}.`);
  const lines = ["# Start", "", "Repeated match", "", ...paragraphs.flatMap(line => [line, ""]),
    "## Repeated match", "", "Closing text.", ""];
  const markdown = lines.join("\n");
  const line = lines.indexOf("## Repeated match") + 1;
  const backend = documentsBackend({ fileContent: { [path]: markdown } });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("search-mode-content");
  await app.type("file-search", "Repeated match");
  const result = `search-hit-README.md:${line}`;
  await app.waitFor(result);
  await app.press(result);
  await app.waitFor("file-editor");
  expect(app.shows("doc-source-fallback")).toBe(false);
  expect(app.shows("Unsaved changes")).toBe(false);

  await app.type("file-editor", "Found ");
  await app.waitFor("Unsaved changes");
  await app.press("file-copy-markdown");
  const expected = markdown.replace("## Repeated match", "## Found Repeated match");
  await app.waitUntil(() => app.clipboard() === expected);
  expect(backend.writes).toHaveLength(0);
});

test("a source-only Markdown hit reveals the physical line and reopens the stacked file detail", async () => {
  const markdown = TEXT["/repo/notes.md"].replace("# Notes", "<div>Notes</div>");
  const backend = documentsBackend({ fileContent: { "/repo/notes.md": markdown } });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("search-mode-content");
  await app.type("file-search", "Kept as written");
  await app.waitFor("search-hit-notes.md:7");
  await app.press("search-hit-notes.md:7");
  await app.waitFor("doc-source-fallback");
  await app.waitFor("Ln 7, Col 1");

  await app.setViewport(560, 900);
  await app.press("files-stack-back");
  await app.press("search-hit-notes.md:7");
  await app.waitFor("files-stack-back");
  await app.waitFor("Ln 7, Col 1");
  expect(app.value("file-editor")).toBe(markdown);
  expect(app.shows("Unsaved changes")).toBe(false);
  expect(backend.writes).toHaveLength(0);
});

test("a remote Markdown image is rendered and edited without replacing its relative source with image bytes", async () => {
  const backend = documentsBackend({
    openedWorkspaces: [{ id: "ws-remote", name: "Docs", rootPath: "/repo", workspaceKind: "remote" }],
    currentWorkspaceId: "ws-remote",
    fileContent: {
      "/repo/README.md": '# Project\n\n![Release diagram](./release%20chart.png "Overview")\n',
      "/repo/release chart.png": IMAGE_PIXEL,
      "/repo/updated.png": IMAGE_PIXEL,
    },
  });
  const app = await open("../App.tsx", { ...DESKTOP, platform: "windows", host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.waitUntil(() => backend.calls.some(call => call.action === "read_file_content" && call.payload.encoding === "base64"));
  expect(backend.calls.find(call => call.payload.encoding === "base64")?.payload.filePath).toBe("/repo/release chart.png");
  await app.waitFor("doc-edit-image");
  expect(app.shows("Unsaved changes")).toBe(false);

  await app.press("doc-edit-image");
  await app.waitFor("doc-edit-image-dialog");
  expect(app.value("doc-image-source")).toBe("./release%20chart.png");
  expect(app.value("doc-image-title")).toBe("Overview");
  await app.clear("doc-image-source");
  await app.type("doc-image-source", "./updated.png");
  await app.clear("doc-image-alt");
  await app.type("doc-image-alt", "Revised diagram");
  await app.press("Apply");
  await app.waitFor("doc-edit-image-dialog", { state: "gone" });
  await app.waitUntil(() => backend.calls.some(call => call.payload.filePath === "/repo/updated.png" && call.payload.encoding === "base64"));
  await app.waitFor("Unsaved changes");
  expect(backend.writes).toHaveLength(0);

  await app.press("file-save");
  await app.waitFor("Saved README.md");
  expect(backend.writes[0]).toMatchObject({ workspaceId: "ws-remote", filePath: "/repo/README.md" });
  expect(backend.writes[0].content).toContain('![Revised diagram](./updated.png "Overview")');
  expect(backend.writes[0].content).not.toContain("data:image");
  const images = backend.calls.filter(call => call.action === "read_file_content" && call.payload.encoding === "base64");
  expect(images.map(call => call.payload.filePath)).toContain("/repo/release chart.png");
  expect(images.map(call => call.payload.filePath)).toContain("/repo/updated.png");
  expect(images.every(call => call.payload.workspaceId === "ws-remote")).toBe(true);
});

test("a browser controller reads the same Markdown image path from each owning device", async () => {
  const backend = createBackend({ files: FILES, fileContent: {
    "/repo/README.md": "# Project\n\n![Diagram](./diagram.png)\n",
    "/repo/diagram.png": IMAGE_PIXEL,
  } });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [{
          workspaceId: "ws-a", name: "Local docs", rootPath: "/repo", kind: "local",
          sessions: [fleetSessionRow("dev-a", "ws-a", "s-a1", "Local docs session")],
        }], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Owner", [{
          workspaceId: "ws-b", name: "Remote docs", rootPath: "/repo", kind: "remote_ssh",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Remote docs session")],
        }], { hostKind: "desktop", state: "online" }),
      ],
    },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  for (const [device, workspace, session] of [["dev-a", "ws-a", "s-a1"], ["dev-b", "ws-b", "s-b1"]]) {
    await app.press(`id:sidebar-session-${session}`);
    await openFiles(app);
    await app.press("README.md");
    await app.waitFor("file-editor");
    const readForDevice = () => host.fleetCalls.find(call => call.target === device && call.command === "read_file_content"
      && (call.args.request as Record<string, unknown>)?.filePath === "/repo/diagram.png");
    await app.waitUntil(() => Boolean(readForDevice()));
    expect(readForDevice()?.args.request).toMatchObject({ workspaceId: workspace, encoding: "base64" });
  }
  expect(host.pageHostCalls).toHaveLength(0);
});

const PLAN_PATH = "/repo/ship.plan.md";
const PLAN_TEXT = '\uFEFF---\r\nname: Release plan\r\noverview: "**Ship safely**"\r\n' +
  "custom: keep\r\ntodos:\r\n  - id: t1\r\n    content: Check release\r\n    status: in_progress\r\n    owner: release\r\n" +
  "  - id: t2\r\n    content: Old task\r\n    status: completed\r\n---\r\n\r\n# Rollout\r\n\r\nReview the draft.\r\n";

function planBackend(text = PLAN_TEXT) {
  return documentsBackend({
    files: [...FILES, { name: "ship.plan.md", path: PLAN_PATH, isDirectory: false }],
    fileContent: { [PLAN_PATH]: text },
  });
}

test("a plan renders its metadata and saves visual body edits with byte-for-byte front matter", async () => {
  const backend = planBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("ship.plan.md");
  await app.waitFor("Release plan");
  await app.waitFor("Ship safely");
  await app.waitFor("1 of 2 remaining");
  await app.waitFor("Review the draft.");
  await app.press("file-edit");
  await app.waitFor("file-editor");
  expect(app.shows("doc-source-fallback")).toBe(false);
  await app.type("file-editor", "Step: ");
  await app.press("file-save");
  await app.waitFor("Saved ship.plan.md");
  expect(backend.writes[0]).toMatchObject({ workspaceId: "workspace-1", filePath: PLAN_PATH });
  expect(backend.writes[0].content).toBe(PLAN_TEXT.replace("# Rollout", "# Step: Rollout"));
});

test("a plan edits, removes and adds to-dos through the same file draft and save", async () => {
  const backend = planBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("ship.plan.md");
  await app.press("plan-edit-todos");
  await app.clear("plan-todo-input-0");
  await app.type("plan-todo-input-0", "Verify the release");
  await app.press("plan-remove-todo-1");
  await app.press("plan-add-todo");
  await app.type("plan-todo-input-1", "Notify the team");
  await app.press("plan-apply-todos");
  await app.waitFor("Verify the release");
  await app.waitFor("Notify the team");
  expect(backend.writes).toHaveLength(0);
  await app.press("file-save");
  await app.waitFor("Saved ship.plan.md");
  const written = backend.writes[0].content;
  const plan = readPlanDocument(written);
  expect(plan.kind).toBe("plan");
  if (plan.kind !== "plan") throw new Error("The saved plan is invalid");
  expect(plan.todos.map(({ content, status }) => [content, status])).toEqual([
    ["Verify the release", "in_progress"], ["Notify the team", "pending"],
  ]);
  expect(written).toContain("custom: keep\r\n");
  expect(written).toContain("    owner: release\r\n");
  expect(plan.body).toBe("# Rollout\r\n\r\nReview the draft.\r\n");
});

test("an invalid plan still opens its original metadata in source mode", async () => {
  const original = "---\nname: [Unclosed\n---\n\n# Recoverable body\n";
  const backend = planBackend(original);
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("ship.plan.md");
  await app.waitFor("The plan metadata could not be read. Open the source to edit it.");
  await app.waitFor("Recoverable body");
  await app.press("file-source");
  await app.waitFor("file-editor");
  expect(app.value("file-editor")).toBe(original);
  expect(backend.writes).toHaveLength(0);
});

test("a saved plan builds in its workspace session and follows the submitted turn", async () => {
  const backend = planBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await app.waitFor("Port the session list.");
  await openFiles(app);
  await app.press("ship.plan.md");

  await app.press("plan-edit-todos");
  await app.waitFor("Finish editing the to-dos before building.");
  expect(app.accessibility("plan-build")?.disabled).toBe(true);
  await app.clear("plan-todo-input-0");
  await app.type("plan-todo-input-0", "Verify the release first");
  await app.press("plan-apply-todos");
  await app.waitFor("Save the latest version of the plan before building.");
  expect(backend.calls.some(call => call.action === "submit_user_message")).toBe(false);
  await app.press("file-save");
  await app.waitFor("Saved ship.plan.md");

  await app.press("plan-build");
  await app.waitFor("Building…");
  const calls = backend.calls.filter(call => call.action === "submit_user_message");
  expect(calls).toHaveLength(1);
  expect(calls[0].payload).toMatchObject({ sessionId: "session-1", workspaceId: "workspace-1", sendDuringTurn: "queue" });
  expect(calls[0].payload.text).toContain(`Implement the plan at "${PLAN_PATH}".`);
  expect(calls[0].payload.attachments).toBeUndefined();
  const turnId = String(calls[0].payload.turnId);
  expect(turnId).toMatch(/^dialog_/);
  await app.host.send("openbitfun.event", {
    event: "agentic://dialog-turn-completed", payload: { sessionId: "session-2", turnId },
  });
  expect(app.shows("Built")).toBe(false);
  await app.host.send("openbitfun.event", {
    event: "agentic://dialog-turn-completed", payload: { sessionId: "session-1", turnId },
  });
  await app.waitFor("Built");
});

test("a browser controller reads and builds a plan on the device that owns the workspace", async () => {
  const backend = createBackend({
    files: [{ name: "ship.plan.md", path: PLAN_PATH, isDirectory: false }],
    fileContent: { [PLAN_PATH]: PLAN_TEXT },
  });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Owner", [{
          workspaceId: "ws-b", name: "Release project", rootPath: "/repo", kind: "remote_ssh",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Release session")],
        }], { hostKind: "desktop", state: "online" }),
      ],
    },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-b1");
  await openFiles(app);
  await app.press("ship.plan.md");
  await app.waitFor("Release plan");
  await app.press("plan-build");
  await app.waitFor("Building…");

  const reads = host.fleetCalls.filter(call => call.command === "read_file_content");
  expect(reads.length).toBeGreaterThanOrEqual(2);
  expect(reads.every(call => call.target === "dev-b")).toBe(true);
  expect(reads.at(-1)?.args.request).toMatchObject({ workspaceId: "ws-b", filePath: PLAN_PATH });
  const builds = host.fleetCalls.filter(call => call.command === "submit_user_message");
  expect(builds).toHaveLength(1);
  expect(builds[0].target).toBe("dev-b");
  expect(builds[0].args.request).toMatchObject({ sessionId: "s-b1", workspaceId: "ws-b" });
  expect(host.pageHostCalls).toHaveLength(0);
});

test("Mermaid blocks and display formulas render from bundled renderers in a web view island and fall back to source", async () => {
  const markdown = [
    "# Diagram",
    "",
    "```mermaid",
    "graph TD; A-->B",
    "```",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    "Inline $a+b$ here.",
    "",
    "> $$",
    "> x^2 + y^2",
    "> $$",
    "",
  ].join("\n");
  const backend = documentsBackend({
    fileContent: {
      ...TEXT,
      "/repo/README.md": markdown,
    },
  });
  const app = await open("../WebApp.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("README.md");
  await app.waitFor("file-markdown-preview");
  await app.waitFor("doc-rich-preview-hint");
  // `WebApp.tsx` registers the renderers this directory ships; they are read on demand.
  await app.waitFor("doc-mermaid-view");
  await app.waitFor("doc-math-view");
  // This headless host has no math typesetter, so the inline fallback stays in the paragraph.
  await app.waitFor("a+b");
  await app.press("file-copy-markdown");
  expect(app.clipboard()).toBe(markdown);
  await app.press("doc-mermaid-toggle-source");
  await app.waitFor("doc-mermaid-source");
  expect(app.shows("doc-mermaid-view")).toBe(true);
  await app.press("doc-mermaid-copy-source");
  expect(app.clipboard()?.trim()).toBe("graph TD; A-->B");
  await app.press("doc-mermaid-toggle-source");
  expect(app.shows("doc-mermaid-source")).toBe(false);
  // The headless host runs no page, so nothing draws: after the timeout the source shows.
  await app.wait(8500);
  await app.waitFor("doc-mermaid-source");
  await app.waitFor("doc-math-source");
  await app.waitFor("doc-mermaid-render-failed");
  expect(app.shows("doc-mermaid-view")).toBe(false);
  expect(app.texts().join("\n")).toContain("graph TD; A-->B");
  // One press on the quiet preview bar enters Split view to edit alongside live preview.
  await app.press("file-preview-edit");
  await app.waitFor("file-editor");
  expect(app.shows("file-markdown-preview")).toBe(true);
  expect(app.texts().join("\n")).toContain("x^2 + y^2");
}, 30000);

test("a slow bundled Mermaid asset gets a drawing window after it finishes loading", async () => {
  const app = await open("./fixtures/slowMermaidApp.tsx", DESKTOP);
  await app.waitFor("doc-mermaid-source");
  await app.waitFor("doc-mermaid-view", { timeout: 15_000 });
  expect(app.shows("doc-mermaid-render-failed")).toBe(false);
}, 20000);

test("an entry that registered no renderers shows diagrams and formulas as their source", async () => {
  const backend = documentsBackend({
    fileContent: { ...TEXT, "/repo/README.md": "# Diagram\n\n```mermaid\ngraph TD; A-->B\n```\n" },
  });
  // `App.tsx` alone: the native and web entries register their own copies.
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("README.md");
  await app.waitFor("doc-mermaid-source");
  expect(app.shows("doc-mermaid-view")).toBe(false);
});

test("YAML frontmatter and common Markdown lists/tables/images edit visually without losing metadata", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);

  // YAML frontmatter: body opens directly in editable visual Preview with collapsible Frontmatter bar.
  await app.press("notes.md");
  await app.waitFor("file-tab-notes.md");
  await app.waitFor("file-editor");
  await app.waitFor("doc-frontmatter-toggle");
  expect(app.shows("doc-source-fallback")).toBe(false);
  expect(app.shows("Unsaved changes")).toBe(false);
  await app.type("file-editor", "Draft ");
  await app.press("file-save");
  await app.waitFor("Saved notes.md");
  expect(backend.writes[0].content).toBe("---\ntitle: Notes\n---\n\n# Draft Notes\n\nKept as written.\n");

  // Expanding Frontmatter edits YAML metadata cleanly in place.
  await app.press("doc-frontmatter-toggle");
  await app.waitFor("doc-frontmatter-input");
  await app.clear("doc-frontmatter-input");
  await app.type("doc-frontmatter-input", "title: Updated Notes");
  await app.press("file-save");
  await app.waitFor("Saved notes.md");
  expect(backend.writes[1].content).toContain("---\ntitle: Updated Notes\n---");
  expect(backend.writes[1].content).toContain("# Draft Notes");

  // Common Markdown with `*` bullets, nested lists, `_italic_`, tight tables, and workspace images edits visually.
  await app.press("guide.md");
  await app.waitFor("file-tab-guide.md");
  await app.waitFor("file-editor");
  expect(app.shows("doc-source-fallback")).toBe(false);
  expect(app.shows("Unsaved changes")).toBe(false);
  // Workspace-relative image is read through the host inside the visual editor too.
  await app.waitUntil(() =>
    backend.calls.some(call => call.action === "read_file_content" && call.payload.filePath === "/repo/logo.png" && call.payload.encoding === "base64"),
  );
  await app.type("file-editor", "Quick ");
  await app.press("file-save");
  await app.waitFor("Saved guide.md");
  expect(backend.writes[2].content).toContain("# Quick Guide");
  expect(backend.writes[2].content).toContain("![Logo](./logo.png)");
});

test("raw HTML stays read-only in Preview and edits safely via Split or Source without corruption", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);

  await app.press("page.md");
  await app.waitFor("file-tab-page.md");
  await app.waitFor("file-markdown-preview");
  await app.waitFor("doc-readonly-hint");

  // One click opens live Split mode (source + preview) without corrupting raw HTML.
  await app.press("file-preview-edit");
  await app.waitFor("file-editor");
  expect(app.shows("file-markdown-preview")).toBe(true);
  expect(app.value("file-editor")).toBe(TEXT["/repo/page.md"]);
  await app.type("file-editor", " ");
  await app.keyboard.press("mod+a");
  await app.paste("file-editor", { text: "# Plain heading" });
  expect(app.value("file-editor")).toBe("# Plain heading");
  await app.press("file-preview");
  await app.waitFor("doc-source-fallback", { state: "gone" });
  await app.waitUntil(() => app.value("file-editor") !== "# Plain heading");
  await app.press("file-discard");

  // Source mode shows the fidelity notice and saves raw HTML verbatim.
  await app.press("file-source");
  await app.waitFor("doc-source-fallback");
  await app.type("file-editor", "<!-- note -->\n");
  await app.press("file-save");
  await app.waitFor("Saved page.md");
  expect(backend.writes[0].content).toContain('<div align="center">Centered</div>');

  // A visually editable file can still switch between visual and source via the document menu.
  await app.press("README.md");
  await app.waitFor("file-tab-README.md");
  await app.waitFor("file-doc-menu");
  await app.press("file-doc-menu");
  await app.press("doc-edit-source");
  await app.waitUntil(() => app.value("file-editor") === TEXT["/repo/README.md"]);
  expect(app.shows("doc-source-fallback")).toBe(false);
  await app.press("file-doc-menu");
  await app.press("doc-edit-visual");
  await app.waitUntil(() => app.value("file-editor") !== TEXT["/repo/README.md"]);
});

test("a visual save that finds a newer disk copy still stops at the conflict banner", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);

  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.type("file-editor", "Mine ");
  backend.externalWrite("/repo/README.md", "# Agent rewrote this\n");
  await app.press("file-save");
  await app.waitFor("file-conflict-overwrite");
  expect(backend.writes).toHaveLength(0);
  await app.press("file-conflict-overwrite");
  await app.waitFor("Saved README.md");
  expect(backend.writes).toHaveLength(1);
  expect(backend.writes[0].content).toContain("Mine Project");
  expect(backend.writes[0].expectedHash).toBeUndefined();
});

test("inline AI asks the document's device and inserts the answer as Markdown", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);

  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.press("file-doc-menu");
  await app.press("doc-ask-ai");
  await app.waitFor("doc-ai-input");
  await app.type("doc-ai-input", "Add a one-line summary");
  await app.press("doc-ai-send");

  await app.waitUntil(() => backend.calls.some(call => call.action === "editor_ai_stream"));
  const stream = backend.calls.find(call => call.action === "editor_ai_stream")!.payload;
  const requestId = String(stream.requestId ?? "");
  expect(requestId).toMatch(/^editor-ai-/);
  expect(String(stream.prompt)).toContain("Request: Add a one-line summary");
  expect(String(stream.prompt)).toContain("Markdown preview from the host.");

  // An answer for another request is not this one's.
  await app.host.send("openbitfun.event", {
    event: "editor-ai://text-chunk",
    payload: { requestId: "editor-ai-other", text: "Not mine" },
  });
  await app.host.send("openbitfun.event", {
    event: "editor-ai://text-chunk",
    payload: { requestId, text: "**Summary:** " },
  });
  await app.host.send("openbitfun.event", {
    event: "editor-ai://completed",
    payload: { requestId, fullText: "**Summary:** a tidy project.", finishReason: "stop" },
  });
  await app.waitFor("doc-ai-answer");
  expect(app.texts().join("\n")).not.toContain("Not mine");
  await app.type("file-editor", "");
  await app.keyboard.press("mod+end");
  await app.press("doc-ai-insert");
  await app.waitFor("Unsaved changes");
  await app.press("file-save");
  await app.waitFor("Saved README.md");
  // Inserted at the caret (the start of the document), as Markdown.
  expect(backend.writes[0].content).toMatch(/\*\*Summary:\*\* a tidy project\.[\s\S]*Markdown preview from the host\./);

  // A failed answer says why, in the panel, and inserts nothing (still in visual Preview after save).
  await app.waitFor("file-editor");
  await app.press("file-doc-menu");
  await app.press("doc-ask-ai");
  await app.type("doc-ai-input", "Again");
  await app.press("doc-ai-send");
  await app.waitUntil(() => backend.calls.filter(call => call.action === "editor_ai_stream").length === 2);
  const second = String(backend.calls.filter(call => call.action === "editor_ai_stream")[1].payload.requestId);
  await app.host.send("openbitfun.event", {
    event: "editor-ai://error",
    payload: { requestId: second, error: "AI call failed: no model" },
  });
  await app.waitFor("doc-ai-error");
  expect(app.enabled("doc-ai-insert")).toBe(false);
});

test("inline AI opens from a blank paragraph and retries the same quick action", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.type("file-editor", "");
  await app.keyboard.press("mod+end");
  await app.keyboard.press("Return");
  await app.keyboard.press("space");
  await app.waitFor("doc-ai-input");
  expect(app.enabled("doc-ai-quick-continue")).toBe(true);
  expect(app.enabled("doc-ai-quick-todo")).toBe(true);
  await app.press("doc-ai-quick-summary");

  const streams = () => backend.calls.filter(call => call.action === "editor_ai_stream");
  await app.waitUntil(() => streams().length === 1);
  const first = streams()[0].payload;
  expect(String(first.prompt)).toContain("Insert a short summary of the key points above");
  expect(String(first.prompt)).toContain("Immediately before the target:");
  await app.host.send("openbitfun.event", { event: "editor-ai://error",
    payload: { requestId: first.requestId, error: "AI call failed: no model" } });
  await app.press("doc-ai-retry");
  await app.waitUntil(() => streams().length === 2);
  const second = streams()[1].payload;
  expect(second.prompt).toBe(first.prompt);
  expect(second.requestId).not.toBe(first.requestId);

  // Editing another block shifts all positions after it. The answer still
  // belongs to the original paragraph, where the request was opened.
  await app.type("file-editor", "");
  await app.keyboard.press("mod+home");
  await app.type("file-editor", "Edited ");
  await app.host.send("openbitfun.event", { event: "editor-ai://completed",
    payload: { requestId: second.requestId, fullText: "```markdown\n**Summary:** Short and useful.\n```" } });
  await app.waitFor("doc-ai-answer");
  await app.press("doc-ai-insert");
  await app.waitFor("doc-ai-panel", { state: "gone" });
  await app.press("file-copy-markdown");
  await app.waitUntil(() => app.clipboard()?.includes("**Summary:** Short and useful.") === true);
  expect(app.clipboard()).toMatch(/^# Edited Project\n\nMarkdown preview from the host\.\n\n\*\*Summary:\*\* Short and useful\./);
  expect(app.clipboard()).not.toContain("```");
  expect(backend.writes).toHaveLength(0);
});

test("inline AI opens next to its paragraph and follows it as the document scrolls", async () => {
  const lines = ["# Project", "",
    ...Array.from({ length: 8 }, (_, index) => [`Opening paragraph ${index + 1}.`, ""]).flat(),
    "## Inline draft position", "",
    ...Array.from({ length: 30 }, (_, index) => [`Later paragraph ${index + 1}.`, ""]).flat()];
  const target = "text:Inline draft position";
  const hit = `search-hit-README.md:${lines.indexOf("## Inline draft position") + 1}`;
  const backend = documentsBackend({ fileContent: { "/repo/README.md": lines.join("\n") } });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("search-mode-content");
  await app.type("file-search", "Inline draft");
  await app.waitFor(hit);
  await app.press(hit);
  await app.waitFor(target);
  const original = app.layout(target)!;
  await app.press("file-doc-menu");
  await app.press("doc-ask-ai");
  await app.waitFor("doc-ai-panel");
  await app.waitUntil(() => {
    const panel = app.layout("doc-ai-panel");
    return !!panel && panel.y >= original.y + original.height && panel.y - original.y < original.height + 24;
  });
  const panel = app.layout("doc-ai-panel")!;
  expect(app.layout(target)?.y).toBe(original.y);
  expect(Math.abs(panel.x - original.x)).toBeLessThan(8);
  expect(panel.width).toBeLessThan(450);

  await app.scroll(target, 120);
  await app.waitUntil(() => {
    const movedTarget = app.layout(target);
    const movedPanel = app.layout("doc-ai-panel");
    return !!movedTarget && !!movedPanel && movedTarget.y < original.y - 20 &&
      Math.abs((movedPanel.y - panel.y) - (movedTarget.y - original.y)) < 8;
  });
  await app.type("doc-ai-input", "Draft at this heading");
  expect(app.value("doc-ai-input")).toBe("Draft at this heading");
  await app.keyboard.press("Escape");
  await app.waitFor("doc-ai-panel", { state: "gone" });
  expect(backend.writes).toHaveLength(0);
});

test("inline AI keeps the insert action visible while a narrow panel scrolls a long answer", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.setViewport(500, 640);
  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.press("file-doc-menu");
  await app.press("doc-ask-ai");
  await app.press("doc-ai-quick-todo");
  await app.waitUntil(() => backend.calls.some(call => call.action === "editor_ai_stream"));
  const stream = backend.calls.find(call => call.action === "editor_ai_stream")!.payload;
  const fullText = Array.from({ length: 28 }, (_, index) => `- [ ] Checklist step ${index + 1}`).join("\n");
  await app.host.send("openbitfun.event", { event: "editor-ai://completed", payload: { requestId: stream.requestId, fullText } });
  await app.waitFor("doc-ai-answer");
  await app.waitUntil(() => {
    const panel = app.layout("doc-ai-panel");
    return !!panel && !panel.clipped && panel.x >= 0 && panel.x + panel.width <= 500 &&
      panel.y >= 0 && panel.y + panel.height <= 640 && app.layout("doc-ai-insert")?.clipped === false;
  });
  const button = app.layout("doc-ai-insert")!;
  const first = app.layout("text:Checklist step 1")!;
  await app.scroll("doc-ai-body", 380);
  await app.waitUntil(() => {
    const step = app.layout("text:Checklist step 1");
    return !!step && step.y < first.y - 40 && step.clipped;
  });
  expect(app.layout("doc-ai-insert")?.y).toBe(button.y);
  await app.press("doc-ai-insert");
  await app.waitFor("doc-ai-panel", { state: "gone" });
  await app.waitFor("Unsaved changes");
  expect(backend.writes).toHaveLength(0);
});

test("inline AI rewrites its original selection after the editor caret moves", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.type("file-editor", "");
  await app.keyboard.press("mod+end");
  await app.keyboard.press("shift+home");
  await app.waitFor("doc-ask-ai-selection");
  await app.press("doc-ask-ai-selection");
  expect(app.shows("doc-ai-quick-summary")).toBe(false);
  await app.type("doc-ai-input", "Rewrite this paragraph");
  await app.press("doc-ai-send");
  await app.waitUntil(() => backend.calls.some(call => call.action === "editor_ai_stream"));
  const stream = backend.calls.find(call => call.action === "editor_ai_stream")!.payload;
  expect(String(stream.prompt)).toContain("Selected passage:\n<<<\nMarkdown preview from the host.\n>>>");
  await app.type("file-editor", "");
  await app.keyboard.press("mod+home");
  await app.host.send("openbitfun.event", { event: "editor-ai://completed",
    payload: { requestId: stream.requestId, fullText: "A polished paragraph." } });
  await app.waitFor("doc-ai-answer");
  await app.press("doc-ai-insert");
  await app.waitFor("doc-ai-panel", { state: "gone" });
  await app.press("file-copy-markdown");
  await app.waitUntil(() => app.clipboard()?.includes("A polished paragraph.") === true);
  expect(app.clipboard()).toMatch(/^# Project\n\nA polished paragraph\./);
  expect(app.clipboard()).not.toContain("Markdown preview from the host.");
  expect(backend.writes).toHaveLength(0);
});

test("inline AI can replace the whole document selected with Select All", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.type("file-editor", "");
  await app.keyboard.press("mod+a");
  await app.press("file-doc-menu");
  await app.press("doc-ask-ai");
  await app.type("doc-ai-input", "Replace the document");
  await app.press("doc-ai-send");
  await app.waitUntil(() => backend.calls.some(call => call.action === "editor_ai_stream"));
  const stream = backend.calls.find(call => call.action === "editor_ai_stream")!.payload;
  expect(String(stream.prompt)).toContain("Selected passage:\n<<<\nProject\nMarkdown preview from the host.");
  await app.host.send("openbitfun.event", { event: "editor-ai://completed",
    payload: { requestId: stream.requestId, fullText: "# A new version" } });
  await app.waitFor("doc-ai-answer");
  await app.press("doc-ai-insert");
  await app.waitFor("doc-ai-panel", { state: "gone" });
  await app.press("file-copy-markdown");
  await app.waitUntil(() => app.clipboard()?.trim() === "# A new version");
  expect(backend.writes).toHaveLength(0);
});

test("inline AI preserves its answer without overwriting a changed target block", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.press("file-doc-menu");
  await app.press("doc-ask-ai");
  await app.press("doc-ai-quick-todo");
  await app.waitUntil(() => backend.calls.some(call => call.action === "editor_ai_stream"));
  const stream = backend.calls.find(call => call.action === "editor_ai_stream")!.payload;
  expect(String(stream.prompt)).toContain("Insert a concise Markdown todo list");
  await app.type("file-editor", "Edited ");
  await app.host.send("openbitfun.event", { event: "editor-ai://completed",
    payload: { requestId: stream.requestId, fullText: "- [ ] Review the draft" } });
  await app.waitFor("doc-ai-answer");
  await app.press("doc-ai-insert");
  await app.waitFor("doc-ai-placement-error");
  expect(app.shows("doc-ai-answer")).toBe(true);
  expect(app.enabled("doc-ai-insert")).toBe(false);
  await app.press("file-copy-markdown");
  await app.waitUntil(() => app.clipboard()?.startsWith("# Edited Project") === true);
  expect(app.clipboard()).not.toContain("Review the draft");
  expect(backend.writes).toHaveLength(0);
});

test("inline AI streams from the document's fleet owner and stops on that same device", async () => {
  const backend = documentsBackend();
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Owner", [{
          workspaceId: "ws-b", name: "Remote workspace", rootPath: "/repo", kind: "remote_ssh",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Remote session")],
        }], { hostKind: "desktop", state: "online" }),
      ],
    },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-b1");
  await openFiles(app);
  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.press("file-doc-menu");
  await app.press("doc-ask-ai");
  await app.press("doc-ai-quick-continue");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "editor_ai_stream"));
  const stream = host.fleetCalls.find(call => call.command === "editor_ai_stream")!;
  const request = stream.args.request as { requestId: string; prompt: string };
  expect(stream.target).toBe("dev-b");
  expect(request.prompt).toContain("Continue writing from the insertion point");

  const publish = (origin: string, seq: number, event: string, body: Record<string, string>) =>
    app.host.send("openbitfun.obpFrames", [JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
      seq, origin, originInstance: `${origin}-test`, event, payload: { requestId: request.requestId, ...body },
    } })]);
  await publish("dev-a", 1, "editor-ai://completed", { fullText: "From the wrong device" });
  expect(app.enabled("doc-ai-stop")).toBe(true);
  expect(app.shows("doc-ai-answer")).toBe(false);
  await publish("dev-b", 1, "editor-ai://text-chunk", { text: "Owner's partial response" });
  await app.waitFor("doc-ai-answer");
  await app.press("doc-ai-stop");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "editor_ai_cancel"));
  expect(host.fleetCalls.find(call => call.command === "editor_ai_cancel")).toMatchObject({
    target: "dev-b", args: { request: { requestId: request.requestId } },
  });
  await publish("dev-b", 2, "editor-ai://completed", { fullText: "Late response" });
  expect(app.shows("doc-ai-answer")).toBe(false);
  expect(host.pageHostCalls).toHaveLength(0);
});

test("HTML previews in a script-free web view; a browser tab is not offered the device's system browser", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);

  await app.press("index.html");
  await app.waitFor("file-tab-index.html");
  await app.waitUntil(() => app.texts().some(text => text.includes("Hello page")));
  // The source is the default; the preview is one tab away.
  await app.waitFor("file-html-preview");
  expect(app.shows("file-html-view")).toBe(false);
  await app.press("file-html-preview");
  await app.waitFor("file-html-view");
  await app.press("file-html-source");
  await app.waitFor("file-html-view", { state: "gone" });
  // This page is not the desktop app: opening the OS browser of the device is not its to offer.
  expect(app.shows("file-open-in-browser")).toBe(false);
});

test("a PDF is a web view in the desktop app, read from its device as base64", async () => {
  const backend = documentsBackend();
  const app = await open("./fixtures/nativeApp.tsx", { ...DESKTOP, host: { handlers: overNativeWire(backend) } });
  await openFiles(app);

  await app.press("manual.pdf");
  await app.waitFor("file-pdf-view");
  const read = backend.calls.find(call => call.action === "read_file_content" && call.payload.filePath === "/repo/manual.pdf");
  expect(read?.payload).toMatchObject({ workspaceId: "workspace-1", encoding: "base64" });

  // The desktop app offers the system browser for a local HTML file of this device.
  await app.press("index.html");
  await app.waitFor("file-open-in-browser");
  await app.press("file-open-in-browser");
  await app.waitUntil(() => backend.calls.some(call => call.action === "open_html_file_in_browser"));
  expect(backend.calls.find(call => call.action === "open_html_file_in_browser")?.payload).toEqual({
    path: "/repo/index.html",
  });
});

test("a standalone browser preview without PDF assets says where to open the file and reads no bytes", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);

  await app.press("manual.pdf");
  await app.waitFor("PDFs preview in the desktop app. Open this one there or in another PDF viewer.");
  expect(app.shows("file-pdf-view")).toBe(false);
  expect(
    backend.calls.some(call => call.action === "read_file_content" && call.payload.filePath === "/repo/manual.pdf"),
  ).toBe(false);
});

test("the bundled PDF reader asks the owning runtime for the original bytes", async () => {
  const backend = documentsBackend();
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Owner", [{
          workspaceId: "ws-b", name: "Remote workspace", rootPath: "/repo", kind: "remote_ssh",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Remote session")],
        }], { hostKind: "cli", state: "online" }),
      ],
    },
  });
  const app = await open("./fixtures/pdfControllerApp.tsx", {
    ...DESKTOP, platform: "web",
    host: { handlers: { ...host.handlers, "openbitfun.documentRendererAsset": () => "https://fixture.invalid/pdf-reader.js" } },
  });
  await selectTreeWorkspace(app, "ws-b");
  await app.press("explorer-row-manual.pdf");
  await app.waitFor("file-pdf-page");
  expect(host.fleetCalls.find(call => call.command === "read_file_content")).toMatchObject({
    target: "dev-b", args: { request: { workspaceId: "ws-b", filePath: "/repo/manual.pdf", encoding: "base64" } },
  });
  expect(host.pageHostCalls).toHaveLength(0);
});

test("PDF review keeps main's sidecar fields and stops on changes from the workspace owner", async () => {
  const path = "/repo/manual.pdf";
  const sidecar = pdfReviewSidecar(path);
  const createdAt = "2026-01-02T12:00:00.000Z";
  const original = {
    version: 1, fingerprint: "main-build", retained: { author: "main" },
    annotations: [{ id: "existing", kind: "highlight", page: 1, rect: [10, 20, 30, 40],
      color: "yellow", quote: "Original passage", createdAt, retainedFlag: true,
      quads: [10, 40, 30, 40, 10, 20, 30, 20], comments: [{ id: "first", body: "Existing review", createdAt }] }],
  };
  const originalText = JSON.stringify(original);
  const backend = documentsBackend({ fileContent: { [sidecar]: originalText } });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Owner", [{
          workspaceId: "ws-b", name: "Remote workspace", rootPath: "/repo", kind: "remote_ssh",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Remote session")],
        }], { hostKind: "cli", state: "online" }),
      ],
    },
  });
  const app = await open("./fixtures/pdfControllerApp.tsx", {
    ...DESKTOP, platform: "web",
    host: { handlers: { ...host.handlers, "openbitfun.documentRendererAsset": () => "https://fixture.invalid/pdf.js" } },
  });
  await selectTreeWorkspace(app, "ws-b");
  await app.press("explorer-row-manual.pdf");
  await app.press("pdf-review-toggle");
  await app.waitFor("Existing review");
  await app.press("pdf-review-thread-existing");
  await app.type("pdf-review-comment", "Local reply");
  await app.press("pdf-review-reply");
  await app.waitUntil(() => backend.writes.length === 1);
  expect(host.fleetCalls.find(call => call.command === "write_file_content")).toMatchObject({
    target: "dev-b",
    args: { request: {
      workspaceId: "ws-b", filePath: sidecar, expectedHash: crypto.createHash("sha256").update(originalText).digest("hex"),
    } },
  });
  expect(parsePdfReview(backend.writes[0].content)).toMatchObject({
    retained: original.retained,
    annotations: [{ retainedFlag: true, comments: [{ body: "Existing review" }, { body: "Local reply" }] }],
  });
  backend.externalWrite(sidecar, JSON.stringify({
    ...original, annotations: [{ ...original.annotations[0], comments: [{ id: "updated", body: "Remote reply", createdAt }] }],
  }));
  await app.press("pdf-review-resolve");
  await app.waitFor("pdf-review-reload");
  expect(backend.writes).toHaveLength(1);
  await app.press("pdf-review-reload");
  await app.waitFor("Remote reply");
  expect(app.shows("Local reply")).toBe(false);
  await app.press("close-file-tab-manual.pdf");
  await app.waitFor("Choose a file to preview");
  await app.press("explorer-row-manual.pdf");
  await app.waitFor("pdf-review-toggle");
  await app.press("pdf-review-toggle");
  await app.press("pdf-review-edit-comment-updated");
  await app.clear("pdf-review-comment");
  await app.type("pdf-review-comment", "Edited reply");
  await app.press("pdf-review-reply");
  await app.waitUntil(() => backend.writes.length === 2);
  expect(parsePdfReview(backend.writes[1].content).annotations[0].comments)
    .toEqual([{ id: "updated", body: "Edited reply", createdAt }]);
  expect(host.pageHostCalls).toHaveLength(0);
});

test("PDF review rejects malformed sidecars without normalizing unknown versions", () => {
  expect(() => parsePdfReview('{"version":2,"fingerprint":"pdf","annotations":[]}')).toThrow("Unsupported PDF review format");
  expect(() => parsePdfReview('{"version":1,"fingerprint":"pdf","annotations":[{"id":"x","kind":"note"}]}'))
    .toThrow("Invalid PDF review annotation");
});

test("LaTeX saves its source before compiling the hinted root on the workspace owner", async () => {
  const chapterPath = "/repo/chapters/results.tex";
  const backend = documentsBackend({
    files: [
      { name: "results.tex", path: chapterPath, isDirectory: false },
      { name: "notes.md", path: "/repo/notes.md", isDirectory: false },
    ],
    fileContent: { [chapterPath]: "% !TeX root = ../paper.tex\nResults\n" },
  });
  const invoke = backend.handlers["openbitfun.invoke"];
  let fail = false;
  backend.handlers["openbitfun.invoke"] = data => {
    if ((data as { action?: string }).action !== "compile_workspace_latex") return invoke(data);
    return fail
      ? { ok: false, error: "Example LaTeX error\nUnclosed group at line 4" }
      : { ok: true, value: { pdfBase64: TEXT["/repo/manual.pdf"], log: "Build complete" } };
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Owner", [{
          workspaceId: "ws-b", name: "Remote workspace", rootPath: "/repo", kind: "remote_ssh",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Remote session")],
        }], { hostKind: "desktop", state: "online", hostCapabilities: ["workspace_latex_preview_v1"] }),
      ],
    },
  });
  const app = await open("./fixtures/pdfControllerApp.tsx", {
    ...DESKTOP, platform: "web",
    host: { handlers: { ...host.handlers, "openbitfun.documentRendererAsset": () => "https://fixture.invalid/pdf-reader.js" } },
  });
  await selectTreeWorkspace(app, "ws-b");
  await app.press("explorer-row-results.tex");
  await app.type("file-editor", "% Updated\n");
  await app.press("file-tex-engine-xe");
  await app.press("file-tex-build");
  await app.waitFor("file-pdf-page");

  const saved = host.fleetCalls.findIndex(call => call.command === "write_file_content");
  const compiled = host.fleetCalls.findIndex(call => call.command === "compile_workspace_latex");
  expect(saved).toBeGreaterThanOrEqual(0);
  expect(compiled).toBeGreaterThan(saved);
  expect(backend.writes[0]?.content).toContain("% Updated");
  expect(host.fleetCalls[compiled]).toMatchObject({
    target: "dev-b",
    args: { request: { workspaceId: "ws-b", filePath: "/repo/paper.tex", engine: "xelatex" } },
  });

  fail = true;
  await app.press("file-tex-build");
  await app.waitUntil(() => app.texts().some(text => text.includes("Showing the previous PDF.")));
  expect(app.shows("file-pdf-page")).toBe(true);
  await app.press("file-tex-log");
  await app.waitUntil(() => app.texts().some(text => text.includes("Unclosed group at line 4")));
  await app.press("explorer-row-notes.md");
  await app.waitFor("file-editor");
  await app.press("file-tab-results.tex");
  await app.waitFor("file-pdf-page");
  await app.waitUntil(() => app.texts().some(text => text.includes("Unclosed group at line 4")));
  expect(host.fleetCalls.filter(call => call.command === "compile_workspace_latex")).toHaveLength(2);

  fail = false;
  await app.press("file-tex-auto");
  await app.type("file-editor", "% Auto-compile this edit\n");
  await app.waitUntil(() => host.fleetCalls.filter(call => call.command === "compile_workspace_latex").length === 3);
  await app.waitUntil(() => app.texts().some(text => text.includes("Build complete")));
  expect(backend.writes.at(-1)?.content).toContain("% Auto-compile this edit");
  expect(host.pageHostCalls).toHaveLength(0);
});

test("LaTeX outline and snippet geometry ignore comments and escaped commands", () => {
  const source = [
    "% \\begin{document} \\section{Hidden}",
    "\\\\section{Escaped}",
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section[Short]{A \\textbf{result}}",
    "\\subsection*{80\\% complete}",
  ].join("\n");
  expect(latexOutline(source.replaceAll("\n", "\r\n"))).toEqual([
    { line: 4, level: 2, title: "A result" },
    { line: 5, level: 3, title: "80\\% complete" },
  ]);
  const result = latexSnippetEdit(source, { anchor: { line: 2, column: 8 }, head: { line: 2, column: 0 } }, "equation");
  expect(result.edit.range).toEqual({ start: { line: 3, column: 16 }, end: { line: 3, column: 16 } });
  expect(result.text).toContain("\\documentclass{article}\n\\begin{document}\n\\begin{equation}");
  const edited = result.text.replace("E = mc^2", "x");
  const moved = moveLatexStops(result.text, edited, result.stops, 0);
  expect(edited.slice(moved![1].start, moved![1].end)).toBe("energy");
  expect(moveLatexStops(result.text, source, result.stops, 0)).toBeNull();
});

test("LaTeX outline jumps in the source and snippet fields use the native editor", async () => {
  const path = "/repo/paper.tex";
  const source = "% \\section{Hidden}\n\\documentclass{article}\n\\begin{document}\n\\section{Visible}\nText";
  const backend = documentsBackend({
    files: [{ name: "paper.tex", path, isDirectory: false }],
    fileContent: { [path]: source },
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.press("explorer-row-paper.tex");
  await app.press("file-tex-outline");
  expect(app.shows("file-tex-heading-1")).toBe(false);
  await app.press("file-tex-heading-4");
  await app.waitFor("Ln 4, Col 1");

  await app.press("file-tex-insert");
  await app.press("file-tex-snippet-equation");
  await app.waitUntil(() => app.texts().some(text => text.includes("E = mc^2")));
  await app.keyboard.press("x");
  await app.waitUntil(() => !app.texts().some(text => text.includes("E = mc^2")));
  await app.keyboard.press("tab");
  await app.keyboard.press("y");
  await app.waitUntil(() => app.texts().some(text => text.includes("\\label{eq:y}")));
  await app.keyboard.press("tab");
  await app.press("file-save");
  expect(backend.writes[0]?.content).toBe(
    source.replace("\\section{Visible}", "\\begin{equation}\n  x\n  \\label{eq:y}\n\\end{equation}\n\\section{Visible}"),
  );

  await app.press("file-tex-undo");
  await app.waitUntil(() => app.texts().some(text => text.includes("\\label{eq:energy}")));
  await app.press("file-tex-redo");
  await app.waitUntil(() => app.texts().some(text => text.includes("\\label{eq:y}")));
});

test("a remote workspace's document saves through its own workspace id", async () => {
  const backend = documentsBackend({
    openedWorkspaces: [
      { id: "ws-remote", name: "prod", rootPath: "/repo", workspaceKind: "remote" },
    ],
    currentWorkspaceId: "ws-remote",
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);

  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.type("file-editor", "Remote ");
  await app.press("file-save");
  await app.waitFor("Saved README.md");
  expect(backend.writes[0]).toMatchObject({ workspaceId: "ws-remote", filePath: "/repo/README.md" });
  expect(backend.writes[0].content).toContain("Remote Project");
  const reads = backend.calls.filter(call => call.action === "read_file_content");
  expect(reads.every(call => call.payload.workspaceId === "ws-remote")).toBe(true);
});

test("phone: the document pane opens directly editable in Preview with Preview | Source", async () => {
  const backend = documentsBackend();
  const app = await open("../App.tsx", { ...PHONE, width: 1440, height: 900, host: { handlers: backend.handlers } });
  await openFiles(app);
  await app.setViewport(PHONE.width, PHONE.height);
  await app.waitFor("README.md");
  await app.press("README.md");
  await app.waitFor("file-editor");
  await app.waitFor("file-source");
  expect(app.shows("file-split")).toBe(false);
  await app.type("file-editor", "Phone ");
  await app.press("file-source");
  await app.waitUntil(() => app.value("file-editor")?.startsWith("# Phone Project") === true);
  await app.press("file-save");
  await app.waitUntil(() => backend.writes.length === 1);
  expect(backend.writes[0].content).toContain("Phone Project");
  expect(app.shows("file-editor")).toBe(true);
});

test("workspaceUtils handles POSIX roots, Windows drives, remote backslashes, prefix boundaries, and markdown links", async () => {
  const {
    dirnameOfPath,
    fileUrlToPath,
    isPathAtOrUnder,
    isRemoteWorkspace,
    joinWorkspacePath,
    resolveWorkspaceMarkdownLink,
  } = await import("../src/shared/workspaceUtils");

  expect(dirnameOfPath("/README.md")).toBe("/");
  expect(dirnameOfPath("/")).toBe("/");
  expect(dirnameOfPath("C:\\foo")).toBe("C:\\");
  expect(dirnameOfPath("C:\\")).toBe("C:\\");
  // Remote POSIX workspaces treat `\` as a literal filename character, never a separator.
  expect(dirnameOfPath("/srv/app/a\\b.txt", true)).toBe("/srv/app");
  expect(joinWorkspacePath("C:\\repo", "src/main.rs", false)).toBe("C:\\repo\\src\\main.rs");
  // Prefix matching requires a separator boundary.
  expect(isPathAtOrUnder("/srv/app-v2", "/srv/app", true)).toBe(false);
  expect(isPathAtOrUnder("/srv/app/src", "/srv/app", true)).toBe(true);
  // Windows file:// URLs drop the leading slash before the drive letter.
  expect(fileUrlToPath("file:///C:/Users/me/my%20doc.md")).toBe("C:/Users/me/my doc.md");
  // Markdown links resolve mailto:, file://, computer://, and relative paths with line suffixes.
  expect(resolveWorkspaceMarkdownLink("mailto:ops@example.com", "/repo", false)).toEqual({
    kind: "external",
    target: "mailto:ops@example.com",
  });
  expect(resolveWorkspaceMarkdownLink("file:///repo/docs/guide.md#L12", "/repo", false)).toEqual({
    kind: "workspace",
    target: "/repo/docs/guide.md",
  });
  expect(resolveWorkspaceMarkdownLink("../src/app.ts:42", "/repo/docs", true)).toEqual({
    kind: "workspace",
    target: "/repo/src/app.ts",
  });
  // Unified remote workspace classification across remote, remote_ssh, docker, wsl, assistant.
  expect(isRemoteWorkspace({ id: "1", rootPath: "/srv", workspaceKind: "remote_ssh" })).toBe(true);
  expect(isRemoteWorkspace({ id: "2", rootPath: "/srv", workspaceKind: "docker" })).toBe(true);
  expect(isRemoteWorkspace({ id: "3", rootPath: "/srv", workspaceKind: "wsl" })).toBe(true);
  expect(isRemoteWorkspace({ id: "4", rootPath: "/home/a", workspaceKind: "assistant" })).toBe(false);
});

/** Makes a minimal valid PNG header (24 bytes) with the requested natural width × height. */
function makePngHeaderBase64(width: number, height: number): string {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return Buffer.from(bytes).toString("base64");
}

test("Markdown preview sizes workspace images, percentage rows, SVGs, missing fallbacks, and embedded videos without collapsing to 0px", async () => {
  const wordmarkB64 = makePngHeaderBase64(2172, 724); // 3:1
  const shotB64 = makePngHeaderBase64(1920, 1138);
  const qrB64 = makePngHeaderBase64(588, 588); // 1:1
  const svgB64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>').toString("base64");
  const richReadme = [
    '<div align="center">',
    '<img src="./png/wordmark.png" alt="Wordmark" width="520" />',
    '<a href="./png/qr.png"><img src="./png/qr.png" alt="WeChat QR" width="147" /></a>',
    "</div>",
    "",
    '<div align="center">',
    '  <video src="https://example.com/demo.mp4" controls width="640"></video>',
    "</div>",
    "",
    '<p align="center">',
    '  <img src="./png/shot-a.png" alt="Desktop A" width="49%" />',
    '  <img src="./png/shot-b.png" alt="Desktop B" width="49%" />',
    "</p>",
    "",
    "![Vector badge](/png/badge.svg)",
    "![Missing pic](./png/missing.png)",
    "",
    "```html",
    '<video src="https://example.com/literal-code.mp4"></video>',
    "```",
  ].join("\n");

  const backend = documentsBackend({
    fileContent: {
      ...TEXT,
      "/repo/README.md": richReadme,
      "/repo/png/wordmark.png": wordmarkB64,
      "/repo/png/qr.png": qrB64,
      "/repo/png/shot-a.png": shotB64,
      "/repo/png/shot-b.png": shotB64,
      "/repo/png/badge.svg": svgB64,
    },
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openFiles(app);

  await app.press("README.md");
  await app.waitFor("file-markdown-preview");

  // All local images (relative and repo-root-relative `/png/badge.svg`) load via base64 read_file_content.
  await app.waitUntil(() =>
    backend.calls.some(call => call.action === "read_file_content" && call.payload.filePath === "/repo/png/wordmark.png" && call.payload.encoding === "base64") &&
    backend.calls.some(call => call.action === "read_file_content" && call.payload.filePath === "/repo/png/badge.svg" && call.payload.encoding === "base64"),
  );

  // Every loaded image has non-zero width AND height matching its natural aspect ratio
  // (TextView wraps `renderImage` in a pressable container with the same alt label, so `nth=1` is the `<Image>` itself).
  await app.waitFor("label:Wordmark >> nth=1");
  const wordmarkLayout = app.layout("label:Wordmark >> nth=1");
  expect(wordmarkLayout).not.toBeNull();
  expect(wordmarkLayout!.width).toBe(520);
  expect(wordmarkLayout!.height).toBeGreaterThan(150);
  expect(wordmarkLayout!.height).toBeLessThan(190);

  const qrLayout = app.layout("label:WeChat QR >> nth=1");
  expect(qrLayout).not.toBeNull();
  expect(qrLayout!.width).toBe(147);
  expect(qrLayout!.height).toBe(147);

  const shotALayout = app.layout("label:Desktop A >> nth=1");
  expect(shotALayout).not.toBeNull();
  expect(shotALayout!.width).toBeGreaterThan(200);
  expect(shotALayout!.height).toBeGreaterThan(100);

  const badgeLayout = app.layout("label:Vector badge >> nth=1");
  expect(badgeLayout).not.toBeNull();
  expect(badgeLayout!.width).toBe(200);
  expect(badgeLayout!.height).toBe(100);

  // Missing image surfaces a clear unavailable caption instead of silently collapsing.
  await app.waitFor("Image not found: Missing pic");

  // Embedded `<video>` renders as a native media view (not dropped), while fenced HTML code stays literal.
  await app.waitFor("label:doc-video-view");
  const videoLayout = app.layout("label:doc-video-view");
  expect(videoLayout).not.toBeNull();
  expect(videoLayout!.width).toBeGreaterThan(300);
  expect(videoLayout!.height).toBeGreaterThan(150);
  expect(app.texts().join("\n")).toContain("literal-code.mp4");
});

test("markdownMedia helpers compute sizes, sniff headers, resolve paths, and preprocess HTML media safely", async () => {
  const {
    computeMarkdownImageBox,
    resolveMarkdownMediaTarget,
    sniffBase64ImageDimensions,
    transformEmbeddedMediaMarkdown,
  } = await import("../src/ui/markdownMedia");

  expect(sniffBase64ImageDimensions(makePngHeaderBase64(1672, 941), "image/png")).toEqual({ width: 1672, height: 941 });
  expect(
    sniffBase64ImageDimensions(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 172 20"></svg>').toString("base64"),
      "image/svg+xml",
    ),
  ).toEqual({ width: 172, height: 20 });

  // Natural badge keeps its small intrinsic size; large image clamps to column; 49% pairs fit side-by-side.
  expect(computeMarkdownImageBox({ natural: { width: 172, height: 20 }, containerWidth: 760 })).toEqual({ width: 172, height: 20 });
  expect(computeMarkdownImageBox({ natural: { width: 1672, height: 941 }, containerWidth: 760 })).toEqual({ width: 760, height: 428 });
  const half = computeMarkdownImageBox({ width: "49%", natural: { width: 1920, height: 1138 }, containerWidth: 760 });
  expect(half.width * 2).toBeLessThan(760);
  expect(half.height).toBeGreaterThan(150);

  // Path resolution covers relative, repo-root, file://, and remote POSIX workspaces.
  expect(resolveMarkdownMediaTarget("./png/a.png", { documentPath: "/srv/repo/docs/guide.md", workspaceRoot: "/srv/repo", isRemote: true })).toEqual({
    kind: "workspace",
    paths: ["/srv/repo/docs/png/a.png", "/srv/repo/png/a.png"],
  });
  expect(resolveMarkdownMediaTarget("/png/a.png", { documentPath: "/srv/repo/README.md", workspaceRoot: "/srv/repo", isRemote: true })).toEqual({
    kind: "workspace",
    paths: ["/srv/repo/png/a.png", "/png/a.png"],
  });
  expect(resolveMarkdownMediaTarget("file:///Users/me/out.png", { workspaceRoot: "/repo", isRemote: false })).toEqual({
    kind: "workspace",
    paths: ["/Users/me/out.png"],
  });

  // Fenced code blocks are untouched while real `<video>` / `<audio>` tags become `openbitfun-media` blocks.
  const input = [
    '<video controls width="800"><source src="./clip.mp4" type="video/mp4"></video>',
    "```html",
    '<video src="./untouched.mp4"></video>',
    "```",
  ].join("\n");
  const transformed = transformEmbeddedMediaMarkdown(input);
  expect(transformed).toContain("```openbitfun-media");
  expect(transformed).toContain('"src":"./clip.mp4"');
  expect(transformed).toContain('<video src="./untouched.mp4"></video>');
});
