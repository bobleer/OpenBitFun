import { expect, open, test } from "nsh/test";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession } from "./support";

const desktop = { width: 1440, height: 900, platform: "macos" as const };
const archive = {
  sessionId: "session-archive", sessionName: "Archive review", workspaceId: "workspace-2",
  workspacePath: "/srv/project", workspaceLabel: "Remote project",
  remoteConnectionId: "example-ssh", remoteSshHost: "example",
};

function referenceBackend() {
  const backend = createBackend({ hostQueue: true });
  const lookups: unknown[] = [];
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: unknown };
    if (args.action === "search_referenceable_sessions") {
      lookups.push(args.request);
      return { ok: true, transport: "dev", value: [
        archive, { ...archive, sessionId: "session-1", sessionName: "Current session" },
      ] };
    }
    return base(data);
  };
  return { backend, lookups };
}

test("session references replace inline queries, queue with their locator and stay in their own pane", async () => {
  const { backend, lookups } = referenceBackend();
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Message");
  await app.type("composer", "Compare @arch");
  await app.waitFor("mention-option-Archive review");
  expect(backend.calls.find(call => call.action === "search_files")?.request).toMatchObject({ pattern: "arch" });
  await app.press("id:mention-source-sessions");
  await app.waitFor("mention-option-Archive review");
  expect(lookups.at(-1)).toMatchObject({ query: "arch", limit: 25 });
  expect(app.shows("mention-option-Current session")).toBe(false);
  await app.submit("composer");
  expect(app.value("composer")).toBe("Compare ");
  await app.waitFor("session-reference-Archive review");
  expect(backend.actions()).not.toContain("submit_user_message");

  backend.setRunningTurn("session-1", "turn-live-ref");
  await app.host.send("openbitfun.event", {
    event: "agentic://dialog-turn-started",
    payload: { sessionId: "session-1", turnId: "turn-live-ref", userInput: "first task" },
  });
  await app.waitFor("first task");
  await app.press("Send");
  await app.waitFor("queued-panel");
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-1", workspaceId: "workspace-1", text: "Compare [session-ref:1]",
    displayText: "Compare @Archive review", sendDuringTurn: "queue",
    userMessageMetadata: {
      sessionReferences: [{ sessionId: archive.sessionId, workspaceId: archive.workspaceId,
        workspacePath: archive.workspacePath, remoteConnectionId: archive.remoteConnectionId }],
      composerPresentation: { version: 1 },
    },
  });
  expect(app.enabled("label:queued-panel >> label:Send now")).toBe(true);
  await app.press("label:queued-panel >> label:Edit");
  await app.waitFor("session-reference-Archive review");
  expect(app.value("composer")).toBe("Compare");

  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("secondary-composer-plus");
  await app.press("secondary-composer-plus");
  await app.press("secondary-reference");
  await app.press("id:mention-source-sessions");
  await app.waitFor("mention-option-Archive review");
  expect(lookups.at(-1)).toMatchObject({ limit: 25 });
  await app.press("mention-option-Archive review");
  await app.waitFor("secondary-session-reference-Archive review");
  await app.press("secondary-send-turn");
  expect(backend.calls.filter(call => call.action === "submit_user_message").at(-1)?.request).toMatchObject({
    sessionId: "session-2", text: "[session-ref:1]",
    userMessageMetadata: { sessionReferences: [{ sessionId: archive.sessionId }] },
  });
  await app.waitFor("session-reference-Archive review");
});

async function openHistoricReference() {
  const { backend } = referenceBackend();
  const base = backend.handlers["openbitfun.invoke"];
  const presentation = { version: 1, segments: [
    { kind: "text", text: "Review the earlier decision " },
    { kind: "context", tag: "[session: Archive review]", context: { type: "session-reference", ...archive } },
  ] };
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: Record<string, unknown> };
    if (args.action === "get_session_transcript_view" && args.request?.session_id === "session-1") {
      return { ok: true, transport: "dev", value: {
        sessionId: "session-1", mode: "full", hasEarlier: false,
        turns: [{
          turnId: "historic-reference", turnIndex: 0, kind: "user_dialog", status: "done", settled: true,
          user: { id: "user-history", text: "Review the earlier decision @Archive review",
            timestampMs: 1763150000000, composerPresentation: presentation },
          items: [], startTimeMs: 1763150000000, assistantTimestampMs: 1763150001000,
        }],
      } };
    }
    return base(data);
  };
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("user-session-reference-Archive review");
  return { app, backend };
}

test("rolling back a saved message restores its session reference without resending", async () => {
  const { app, backend } = await openHistoricReference();
  await app.press("rollback-historic-reference");
  await app.press("text:Roll back to here");
  await app.waitFor("session-reference-Archive review");
  expect(backend.actions()).toContain("rollback_session_to_turn");
  expect(backend.actions()).not.toContain("submit_user_message");
});

test("a persisted transcript reference remains structured when editing and rerunning", async () => {
  const { app, backend } = await openHistoricReference();
  await app.press("edit-rerun-historic-reference");
  await app.waitFor("rerun-session-reference-Archive review");
  await app.press("Roll back and rerun");
  await app.waitUntil(() => backend.actions().includes("submit_user_message"));
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-1", text: "Review the earlier decision [session-ref:1]",
    userMessageMetadata: { sessionReferences: [{ sessionId: archive.sessionId, workspacePath: archive.workspacePath }] },
  });
});

test("a queue hydrated from its owner restores an editable session reference", async () => {
  const { backend } = referenceBackend();
  const base = backend.handlers["openbitfun.invoke"];
  let queued = true;
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: Record<string, unknown> };
    if (args.action === "manage_dialog_queue" && args.request?.sessionId === "session-1") {
      if (args.request.action === "cancel") queued = false;
      return { ok: true, transport: "dev", value: {
        queueEpoch: "owner-queue", revision: queued ? 1 : 2, items: queued ? [{
          turnId: "persisted-followup", status: "queued", displayContent: "Recheck @Archive review",
          composerPresentation: { version: 1, segments: [
            { kind: "text", text: "Recheck " },
            { kind: "context", tag: "[session: Archive review]", context: { type: "session-reference", ...archive } },
          ] },
        }] : [],
      } };
    }
    return base(data);
  };
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("queued-panel");
  await app.press("label:queued-panel >> label:Edit");
  await app.waitFor("session-reference-Archive review");
  expect(app.value("composer")).toBe("Recheck");
  await app.press("remove-session-reference-Archive review");
  await app.press("Send");
  const sent = backend.calls.find(call => call.action === "submit_user_message")?.request as Record<string, unknown>;
  expect(sent.text).toBe("Recheck");
  expect(sent.userMessageMetadata).toBe(undefined);
});

test("a browser controller searches and submits session references on the composing fleet runtime", async () => {
  const { backend } = referenceBackend();
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 2, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Desktop runtime", [{
          workspaceId: "ws-b", name: "Work tree", rootPath: "/home/b/repo",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Composing on B")],
        }], { hostKind: "desktop", state: "online" }),
      ],
    },
  });
  const app = await open("./fixtures/sessionApp.tsx", { ...desktop, host: { handlers: host.handlers } });
  await app.waitFor("text:ready");
  await app.press("harness-open-session");
  await app.waitFor("text:Composing on B");
  await app.press("composer-plus");
  await app.press("Reference");
  await app.type("mention-query", "arch");
  await app.waitFor("mention-option-Archive review");
  await app.press("mention-option-Archive review");
  await app.waitFor("session-reference-Archive review");
  await app.press("Send");
  const relevant = host.fleetCalls.filter(call =>
    ["search_referenceable_sessions", "submit_user_message"].includes(call.command));
  expect(relevant.map(call => [call.command, call.target])).toEqual([
    ["search_referenceable_sessions", "dev-b"], ["submit_user_message", "dev-b"],
  ]);
  expect(relevant[1].args.request).toMatchObject({
    sessionId: "s-b1", workspaceId: "ws-b", text: "[session-ref:1]",
    userMessageMetadata: { sessionReferences: [{ workspacePath: "/srv/project", remoteConnectionId: "example-ssh" }] },
  });
  expect(host.pageHostCalls).toHaveLength(0);
});

function promptReferenceBackend() {
  const { backend } = referenceBackend();
  const base = backend.handlers["openbitfun.invoke"];
  let catalog: "ready" | "failed" | "unsupported" = "ready";
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string };
    if (args.action === "get_mode_skill_configs") {
      return { ok: true, value: { skills: [
        { name: "release-notes", description: "Build a changelog", selectedForRuntime: true },
        { name: "private-notes", description: "Build a changelog", selectedForRuntime: false },
      ] } };
    }
    if (args.action === "get_chat_mcp_catalog") {
      if (catalog !== "ready") {
        return { ok: false, error: catalog === "unsupported" ? "unknown command: get_chat_mcp_catalog" : "MCP temporarily unavailable" };
      }
      return { ok: true, value: { modeRestricted: false, tools: [
        { name: "docs_manual", serverId: "docs", serverName: 'Team "Docs"', toolName: "manual", description: "Read manuals" },
        { name: "docs_search", serverId: "docs", serverName: 'Team "Docs"', toolName: "search", description: "Search documentation" },
        { name: "build_status", serverId: "build", serverName: "Build service", toolName: "status", description: "Read build results" },
      ] } };
    }
    return base(data);
  };
  return { backend, setCatalog: (value: typeof catalog) => { catalog = value; } };
}

const docsToken = 'MCP "Team \\"Docs\\"" (server: "docs")';

test("the plus-menu reference picker browses sources and searches all four together", async () => {
  const { backend } = promptReferenceBackend();
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: Record<string, unknown> };
    if (args.action === "search_files" && args.request?.pattern === "build") {
      return { ok: true, value: [{ path: "/repo/build.yml", name: "build.yml" }] };
    }
    if (args.action === "search_referenceable_sessions" && args.request?.query === "build") {
      return { ok: true, value: [{ ...archive, sessionName: "Build notes" }] };
    }
    return base(data);
  };
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Message");
  const directoryReads = () => backend.calls.filter(call => call.action === "explorer_get_children").length;
  const baseline = directoryReads();
  await app.press("composer-plus");
  await app.press("Reference");
  await app.waitFor("id:mention-source-images");
  expect(directoryReads()).toBe(baseline);

  await app.submit("mention-query");
  await app.waitFor("mention-source-back");
  await app.waitUntil(() => directoryReads() > baseline);
  await app.press("mention-source-back");
  await app.press("id:mention-source-skills");
  await app.waitFor("mention-option-release-notes");
  await app.type("mention-query", "build");
  for (const item of ["build.yml", "Build notes", "release-notes", "Build service"]) {
    await app.waitFor(`mention-option-${item}`);
  }
  expect(app.shows("mention-option-private-notes")).toBe(false);

  await app.clear("mention-query");
  await app.waitFor("mention-option-release-notes");
  expect(app.shows("mention-option-Build service")).toBe(false);
  await app.press("mention-source-back");
  await app.type("mention-query", "build");
  await app.waitFor("mention-option-Build notes");
  await app.press("mention-option-Build notes");
  await app.waitFor("session-reference-Build notes");
  expect(backend.actions()).not.toContain("submit_user_message");

  let pickedImages = false;
  app.onPick(request => {
    pickedImages = request.kind === "images";
    return [{
      name: "build.png", type: "image/png",
      data: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64")),
    }];
  });
  await app.press("composer-plus");
  await app.press("Reference");
  await app.press("id:mention-source-images");
  await app.waitFor("attachment-thumb-attachment-1");
  expect(pickedImages).toBe(true);
  await app.press("Send");
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-1", text: "[session-ref:1]",
    attachments: [{ mime_type: "image/png", image_name: "build.png" }],
  });
});

test("the composer references an available skill and finds an MCP server by its tool description", async () => {
  const { backend } = promptReferenceBackend();
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Message");
  await app.type("composer", "Summarize @changelog");
  await app.waitFor("mention-option-release-notes");
  expect(app.shows("mention-option-private-notes")).toBe(false);
  await app.press("id:mention-source-skills");
  await app.waitFor("mention-option-release-notes");
  await app.submit("composer");
  await app.waitFor("composer-prompt-reference-skill-release-notes");
  await app.type("composer", "using @manuals");
  await app.waitFor('mention-option-Team "Docs"');
  expect(app.shows("mention-option-Build service")).toBe(false);
  await app.press('mention-option-Team "Docs"');
  await app.waitFor('composer-prompt-reference-mcp-Team "Docs"');
  await app.keyboard.press("shift+enter");
  await app.keyboard.press("o");
  await app.keyboard.press("k");
  await app.keyboard.press("enter");
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-1", text: `Summarize [$release-notes] using ${docsToken} \nok`,
    userMessageMetadata: { composerPresentation: { version: 1, segments: [
      { kind: "text", text: "Summarize " },
      { kind: "inline-token", tokenType: "skill", token: "[$release-notes]", label: "release-notes" },
      { kind: "text", text: ` using ${docsToken} \nok` },
    ] } },
  });
  await app.waitFor('user-prompt-reference-mcp-Team "Docs"');
  await app.waitFor("user-prompt-reference-skill-release-notes");

  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("secondary-composer-plus");
  await app.press("secondary-composer-plus");
  await app.press("secondary-reference");
  await app.press("id:mention-source-mcp");
  await app.waitFor("mention-option-Build service");
  await app.press("mention-option-Build service");
  await app.waitFor("secondary-composer-prompt-reference-mcp-Build service");
  expect(app.value("composer")).toBe("");
  await app.press("secondary-send-turn");
  expect(backend.calls.filter(call => call.action === "submit_user_message").at(-1)?.request).toMatchObject({
    sessionId: "session-2", text: 'MCP "Build service" (server: "build")',
  });
});

test("the MCP source distinguishes a retryable read from an older host", async () => {
  const { backend, setCatalog } = promptReferenceBackend();
  setCatalog("failed");
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.type("composer", "@");
  await app.press("id:mention-source-mcp");
  await app.waitFor("Could not load MCP servers.");
  setCatalog("ready");
  await app.press("mention-retry-catalog");
  await app.waitFor('mention-option-Team "Docs"');
  await app.press("mention-option-Build service");
  await app.waitFor("composer-prompt-reference-mcp-Build service");

  setCatalog("unsupported");
  await app.type("composer", "@");
  await app.press("id:mention-source-mcp");
  await app.waitFor("This device does not provide an MCP catalog.");
  expect(app.shows("mention-retry-catalog")).toBe(false);
});

test("prompt capsules copy and paste their original references and can be deleted with the keyboard", async () => {
  const { backend } = promptReferenceBackend();
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.type("composer", "检查 @changelog");
  await app.waitFor("mention-option-release-notes");
  await app.press("mention-option-release-notes");
  await app.waitFor("composer-prompt-reference-skill-release-notes");
  await app.type("composer", "again");
  await app.keyboard.press("mod+a");
  await app.keyboard.press("mod+c");
  expect(app.clipboard()).toBe("检查 [$release-notes] again");
  await app.keyboard.press("mod+x");
  expect(app.shows("composer-prompt-reference-skill-release-notes")).toBe(false);
  await app.paste("composer", { text: `检查 ${docsToken}` });
  await app.waitFor('composer-prompt-reference-mcp-Team "Docs"');
  await app.keyboard.press("end");
  await app.keyboard.press("shift+left");
  await app.keyboard.press("mod+c");
  expect(app.clipboard()).toBe(docsToken);
  await app.keyboard.press("backspace");
  expect(app.shows('composer-prompt-reference-mcp-Team "Docs"')).toBe(false);
  await app.press("Send");
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-1", text: "检查",
  });
});

test("the plus menu inserts a capsule at the current draft selection", async () => {
  const { backend } = promptReferenceBackend();
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.paste("composer", { text: "First [$release-notes] last" });
  await app.waitFor("composer-prompt-reference-skill-release-notes");
  await app.keyboard.press("end");
  await app.keyboard.press("left");
  await app.keyboard.press("left");
  await app.keyboard.press("left");
  await app.keyboard.press("left");
  await app.press("composer-plus");
  await app.press("Reference");
  await app.press("id:mention-source-mcp");
  await app.press("mention-option-Build service");
  await app.waitFor("composer-prompt-reference-mcp-Build service");
  await app.keyboard.press("enter");
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-1", text: 'First [$release-notes] MCP "Build service" (server: "build") last',
  });
});

test("a main-format skill capsule survives owner queue hydration with a shortened display label", async () => {
  const { backend } = promptReferenceBackend();
  const base = backend.handlers["openbitfun.invoke"];
  let queued = true;
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: Record<string, unknown> };
    if (args.action === "manage_dialog_queue" && args.request?.sessionId === "session-1") {
      if (args.request.action === "cancel") queued = false;
      return { ok: true, value: {
        queueEpoch: "prompt-queue", revision: queued ? 1 : 2, items: queued ? [{
          turnId: "queued-prompt", status: "queued", displayContent: "Check [Skill: Release notes]",
          composerPresentation: { version: 1, segments: [
            { kind: "text", text: "Check " },
            { kind: "inline-token", tokenType: "skill", token: "[$release-notes]", label: "Release notes" },
          ] },
        }] : [],
      } };
    }
    return base(data);
  };
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("queued-prompt-reference-skill-release-notes");
  await app.press("label:queued-panel >> label:Edit");
  await app.waitFor("composer-prompt-reference-skill-release-notes");
  await app.press("Send");
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-1", text: "Check [$release-notes]",
  });
});

test("a saved prompt capsule is restored in Edit and rerun and reuses the owner's prompt", async () => {
  const { backend } = promptReferenceBackend();
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: Record<string, unknown> };
    if (args.action === "get_session_transcript_view" && args.request?.session_id === "session-1") {
      return { ok: true, value: {
        sessionId: "session-1", mode: "full", hasEarlier: false,
        turns: [{ turnId: "prompt-history", turnIndex: 0, kind: "user_dialog", status: "done", settled: true,
          user: { id: "prompt-author", text: `Check [Skill: Release notes] with ${docsToken}`, timestampMs: 1763150000000,
            composerPresentation: { version: 1, segments: [
              { kind: "text", text: "Check " },
              { kind: "inline-token", tokenType: "skill", token: "[$release-notes]", label: "Release notes" },
              { kind: "text", text: ` with ${docsToken}` },
            ] } },
          items: [], startTimeMs: 1763150000000, assistantTimestampMs: 1763150001000,
        }],
      } };
    }
    return base(data);
  };
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor('user-prompt-reference-mcp-Team "Docs"');
  await app.waitFor("user-prompt-reference-skill-release-notes");
  await app.press("edit-rerun-prompt-history");
  await app.waitFor("rerun-prompt-reference-skill-release-notes");
  await app.waitFor('rerun-prompt-reference-mcp-Team "Docs"');
  await app.type("rerun-input", " today");
  await app.press("Roll back and rerun");
  await app.waitUntil(() => backend.actions().includes("submit_user_message"));
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-1", text: `Check [$release-notes] with ${docsToken} today`,
  });
});

test("a main-format code snippet is restored from the host queue and retains the frozen selection", async () => {
  const backend = createBackend({ hostQueue: true });
  const base = backend.handlers["openbitfun.invoke"];
  const context = {
    type: "code-snippet", id: "code-from-editor", timestamp: 1763150000000,
    filePath: "/repo/example.ts", fileName: "example.ts", startLine: 4, endLine: 5,
    selectedText: 'const flag = "#file:keep-this-literal";\r\nconst enabled = true;',
    language: "typescript",
  };
  const tag = "#code:example.ts:4-5";
  const presentation = { version: 1, segments: [
    { kind: "text", text: "Review " },
    { kind: "context", context, tag, label: "example.ts:4-5", title: "/repo/example.ts:4-5" },
  ] };
  let queued = true;
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: Record<string, unknown> };
    if (args.action === "manage_dialog_queue" && args.request?.sessionId === "session-1") {
      if (args.request.action === "cancel") queued = false;
      return { ok: true, value: {
        queueEpoch: "snippet-queue", revision: queued ? 1 : 2, items: queued ? [{
          turnId: "queued-snippet", status: "queued", displayContent: `Review ${tag}`, composerPresentation: presentation,
        }] : [],
      } };
    }
    if (args.action === "get_session_transcript_view" && args.request?.session_id === "session-1") {
      return { ok: true, value: {
        sessionId: "session-1", mode: "full", hasEarlier: false,
        turns: [{ turnId: "snippet-history", turnIndex: 0, kind: "user_dialog", status: "done", settled: true,
          user: { id: "snippet-user", text: `Review ${tag}`, composerPresentation: presentation, timestampMs: 1763150000000 },
          items: [], startTimeMs: 1763150000000, assistantTimestampMs: 1763150001000,
        }],
      } };
    }
    return base(data);
  };
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("user-prompt-reference-code-snippet-example.ts:4-5");
  expect(app.shows("user-file-ref-keep-this-literal")).toBe(false);
  await app.waitFor("queued-prompt-reference-code-snippet-example.ts:4-5");
  await app.press("label:queued-panel >> label:Edit");
  await app.waitFor("composer-prompt-reference-code-snippet-example.ts:4-5");
  await app.press("Send");
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-1", text: `[Code Snippet: /repo/example.ts:4-5]\n\nReview ${tag}`,
    userMessageMetadata: { composerPresentation: presentation },
  });
});

test("main-format Mermaid diagram and node references survive transcript re-editing", async () => {
  const backend = createBackend({ hostQueue: true });
  const base = backend.handlers["openbitfun.invoke"];
  const diagramCode = 'flowchart LR\n  A["\`\`\`"] --> Check';
  const diagram = { id: "diagram-1", timestamp: 1763150000000, type: "mermaid-diagram",
    diagramCode, diagramTitle: "Delivery", diagramType: "flowchart" };
  const node = { id: "node-1", timestamp: 1763150000000, type: "mermaid-node",
    nodeId: "Check", nodeText: "Check", nodeType: "flowchart", diagramTitle: "Delivery", sourceCode: diagramCode };
  const presentation = { version: 1, segments: [
    { kind: "text", text: "Review " },
    { kind: "context", context: diagram, tag: "#mermaid:Delivery", label: "Delivery", title: "Delivery" },
    { kind: "text", text: " at " },
    { kind: "context", context: node, tag: "#chart:Check", label: "Check", title: "Delivery" },
  ] };
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action?: string; request?: Record<string, unknown> };
    if (args.action === "get_session_transcript_view" && args.request?.session_id === "session-1") {
      return { ok: true, value: { sessionId: "session-1", mode: "full", hasEarlier: false,
        turns: [{ turnId: "mermaid-history", turnIndex: 0, kind: "user_dialog", status: "done", settled: true,
          user: { id: "mermaid-user", text: "Review #mermaid:Delivery at #chart:Check",
            composerPresentation: presentation, timestampMs: 1763150000000 },
          items: [], startTimeMs: 1763150000000, assistantTimestampMs: 1763150001000 }] } };
    }
    return base(data);
  };
  const app = await open("../App.tsx", { ...desktop, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("user-prompt-reference-mermaid-diagram-Delivery");
  await app.waitFor("user-prompt-reference-mermaid-node-Check");
  await app.press("edit-rerun-mermaid-history");
  await app.waitFor("rerun-prompt-reference-mermaid-diagram-Delivery");
  await app.waitFor("rerun-prompt-reference-mermaid-node-Check");
  await app.press("Roll back and rerun");
  await app.waitUntil(() => backend.actions().includes("submit_user_message"));
  expect(backend.calls.find(call => call.action === "submit_user_message")?.request).toMatchObject({
    sessionId: "session-1",
    text: "[Mermaid Diagram: Delivery]\n" + "\`\`\`\`mermaid\n" + diagramCode + "\n\`\`\`\`\n" +
      "[Mermaid Node: Check]\n\nReview #mermaid:Delivery at #chart:Check",
    userMessageMetadata: { composerPresentation: presentation },
  });
});

for (const remote of [false, true]) {
  test(`the fleet composer scopes its MCP source to the ${remote ? "remote workspace" : "session owner"}`, async () => {
    const { backend } = promptReferenceBackend();
    const host = fleetObpHost(backend, {
      fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
      navigator: {
        revision: 2, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
        devices: [
          fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
          fleetDeviceRow("dev-b", "Desktop runtime", [{
            workspaceId: "ws-b", name: "Work tree", rootPath: "/home/b/repo",
            kind: remote ? "remote_ssh" : "local",
            sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Composing on B")],
          }], { hostKind: "desktop", state: "online" }),
        ],
      },
    });
    const app = await open("./fixtures/sessionApp.tsx", { ...desktop, host: { handlers: host.handlers } });
    await app.waitFor("text:ready");
    await app.press("harness-open-session");
    await app.waitFor("text:Composing on B");
    await app.type("composer", "@");
    await app.press("id:mention-source-mcp");
    if (remote) {
      await app.waitFor("MCP references are unavailable in remote workspaces.");
      expect(host.fleetCalls.filter(call => call.command === "get_chat_mcp_catalog")).toHaveLength(0);
      return;
    }
    await app.waitFor('mention-option-Team "Docs"');
    expect(host.fleetCalls.find(call => call.command === "get_chat_mcp_catalog")).toMatchObject({
      target: "dev-b", args: { request: { modeId: "Standard", workspaceId: "ws-b" } },
    });
    await app.press('mention-option-Team "Docs"');
    await app.press("Send");
    expect(host.fleetCalls.find(call => call.command === "submit_user_message")).toMatchObject({
      target: "dev-b", args: { request: { sessionId: "s-b1", text: docsToken } },
    });
    expect(host.pageHostCalls).toHaveLength(0);
  });
}
