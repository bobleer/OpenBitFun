// Wave 22 P5: session goal, side questions, background commands and MCP
// prompts, each against the backend command that owns it.
import { expect, open, test } from "nsh/test";
import { createBackend, openSession } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };

type Handler = (request: Record<string, unknown>) => unknown;

/** Answers the named commands itself and records what each was sent. */
function withCommands(backend: ReturnType<typeof createBackend>, handlers: Record<string, Handler>) {
  const sent: Record<string, Array<Record<string, unknown>>> = {};
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const args = (data ?? {}) as { action?: string; request?: Record<string, unknown>; raw?: Record<string, unknown> };
    const action = args.action ?? "";
    const handler = handlers[action];
    if (!handler) return base(data);
    const request = (args.request ?? args.raw ?? {}) as Record<string, unknown>;
    (sent[action] ??= []).push(request);
    try {
      return { ok: true, value: handler(request), transport: "dev" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), transport: "dev" };
    }
  };
  return sent;
}

test("a session goal is set, follows the runtime's updates and clears", async () => {
  const backend = createBackend();
  const sent = withCommands(backend, {
    get_session_thread_goal: () => ({ goal: null }),
    activate_session_goal: request => ({
      success: true,
      goal: { goalId: "g-1", sessionId: request.sessionId, objective: request.userHint, status: "active", tokensUsed: 0 },
    }),
    set_session_thread_goal_status: request => ({
      goalId: "g-1",
      sessionId: request.sessionId,
      objective: "Ship the release notes",
      status: request.status,
    }),
    clear_session_thread_goal: () => null,
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitUntil(() => (sent.get_session_thread_goal ?? []).length > 0);
  expect(sent.get_session_thread_goal?.[0]).toMatchObject({ sessionId: "session-1", workspaceId: "workspace-1" });
  expect(app.shows("session-goal-strip")).toBe(false);

  await app.press("thread-actions-trigger");
  // Goal and side questions live as `/goal` and `/btw` slash commands rather than cluttering `...`.
  expect(app.shows("session-goal-open")).toBe(false);
  expect(app.shows("side-question-open")).toBe(false);
  await app.keyboard.press("escape");

  await app.type("composer", "/goal");
  await app.press("Send");
  await app.waitFor("session-goal-dialog");
  await app.type("session-goal-input", "Ship the release notes");
  await app.press("session-goal-save");
  await app.waitFor("session-goal-strip");
  expect(sent.activate_session_goal?.[0]).toMatchObject({
    sessionId: "session-1",
    workspaceId: "workspace-1",
    userHint: "Ship the release notes",
  });
  expect(app.texts()).toContain("Ship the release notes");
  expect(app.texts()).toContain("Working toward it");

  // The runtime pauses it (a budget, a block): the strip follows the event.
  await app.host.send("openbitfun.event", {
    event: "agentic://thread-goal-updated",
    payload: { sessionId: "session-1", goal: { objective: "Ship the release notes", status: "budgetLimited" } },
  });
  await app.waitFor("Budget reached");

  await app.press("session-goal-menu");
  await app.press("goal-menu-pause");
  await app.waitUntil(() => (sent.set_session_thread_goal_status ?? []).length === 1);
  expect(sent.set_session_thread_goal_status?.[0]).toMatchObject({ sessionId: "session-1", status: "paused" });
  await app.waitFor("Paused");

  await app.press("session-goal-menu");
  await app.press("goal-menu-clear");
  await app.waitUntil(() => !app.shows("session-goal-strip"));
  expect(sent.clear_session_thread_goal?.[0]).toMatchObject({ sessionId: "session-1" });
});

test("`/goal <objective>` in the composer sets the goal instead of sending a turn", async () => {
  const backend = createBackend();
  const sent = withCommands(backend, {
    get_session_thread_goal: () => ({ goal: null }),
    activate_session_goal: request => ({ success: true, goal: { objective: request.userHint, status: "active" } }),
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.type("composer", "/goal Make the build green");
  await app.press("Send");
  await app.waitFor("session-goal-strip");
  expect(sent.activate_session_goal?.[0]).toMatchObject({ sessionId: "session-1", userHint: "Make the build green" });
  expect(backend.actions()).not.toContain("submit_user_message");
});

test("a side question streams its child session's answer and can be stopped", async () => {
  const backend = createBackend();
  const sent = withCommands(backend, {
    get_session_thread_goal: () => ({ goal: null }),
    btw_ask_stream: () => ({ ok: true }),
    btw_cancel: () => null,
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.type("composer", "/btw");
  await app.press("Send");
  await app.waitFor("side-question-sheet");
  await app.type("side-question-input", "Which file holds the router?");
  await app.press("side-question-ask");
  await app.waitUntil(() => (sent.btw_ask_stream ?? []).length === 1);
  const asked = sent.btw_ask_stream![0]!;
  expect(asked).toMatchObject({ sessionId: "session-1", question: "Which file holds the router?" });
  expect(String(asked.requestId)).toMatch(/^btw_/);
  expect(String(asked.childSessionId)).toMatch(/^btw_session_/);

  // The answer arrives as the child session's own text chunks; the parent's transcript is untouched.
  await app.host.send("openbitfun.event", {
    event: "agentic://text-chunk",
    payload: { sessionId: asked.childSessionId, turnId: "btw-turn", roundId: "r1", text: "It is `src/router.ts`." },
  });
  await app.waitFor("side-question-answer");
  expect(backend.actions()).not.toContain("submit_user_message");

  await app.press("side-question-stop");
  await app.waitUntil(() => (sent.btw_cancel ?? []).length === 1);
  expect(sent.btw_cancel?.[0]).toEqual({ requestId: asked.requestId });
  await app.waitFor("Stopped.");
});

test("closing a side conversation keeps the draft on cancel or refusal and persists the confirmed opt-out", async () => {
  const skipKey = "openbitfun:preferences:skip-btw-close-confirmation:v1";
  const backend = createBackend();
  let refuseStop = true;
  const sent = withCommands(backend, {
    btw_ask_stream: () => ({ ok: true }),
    btw_cancel: () => {
      if (refuseStop) throw new Error("Runtime is offline");
      return null;
    },
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.type("composer", "/btw What is still running?");
  await app.press("Send");
  await app.waitFor("id:side-question-pane");
  await app.waitUntil(() => (sent.btw_ask_stream ?? []).length === 1);
  await app.type("side-question-input", "Follow-up draft");

  const dialog = "side-question-close-dialog";
  await app.press("side-question-close");
  await app.waitFor(dialog);
  await app.press("id:side-question-skip-close");
  await app.press("side-question-close-cancel");
  await app.waitFor(dialog, { state: "gone" });
  expect(app.value("side-question-input")).toBe("Follow-up draft");
  expect(sent.btw_cancel).toBeUndefined();
  expect(app.storage()[skipKey]).toBeUndefined();

  await app.press("side-question-close");
  await app.press("id:side-question-skip-close");
  await app.press("side-question-close-confirm");
  await app.waitFor("Could not stop the side conversation: Runtime is offline");
  expect(app.shows(dialog)).toBe(true);
  expect(app.storage()[skipKey]).toBeUndefined();
  refuseStop = false;
  await app.press("side-question-close-confirm");
  await app.waitFor("id:side-question-pane", { state: "gone" });
  await app.waitUntil(() => app.storage()[skipKey] === "true");
  const cancel = { requestId: sent.btw_ask_stream![0]!.requestId };
  expect(sent.btw_cancel).toEqual([cancel, cancel]);

  await app.type("composer", "/btw");
  await app.press("Send");
  await app.waitFor("id:side-question-pane");
  expect(app.value("side-question-input")).toBe("");
  await app.press("side-question-close");
  await app.waitFor("id:side-question-pane", { state: "gone" });
  expect(app.shows(dialog)).toBe(false);

  await app.press("Settings");
  await app.press("nav-settings-page-input");
  await app.press("id:btw-confirm-close-setting");
  await app.waitUntil(() => app.storage()[skipKey] === undefined);
  await openSession(app, "NSH skeleton");
  await app.type("composer", "/btw");
  await app.press("Send");
  await app.press("side-question-close");
  await app.waitFor(dialog);
});

test("compact side conversation honors the saved close preference", async () => {
  const backend = createBackend();
  const app = await open("../App.tsx", {
    width: 390, height: 844, platform: "ios",
    storage: { "openbitfun:preferences:skip-btw-close-confirmation:v1": "true" },
    host: { handlers: backend.handlers },
  });
  await openSession(app, "NSH skeleton");
  await app.type("composer", "/btw");
  await app.press("Send");
  await app.waitFor("side-question-compact-sheet");
  await app.type("side-question-input", "Temporary draft");
  await app.press("modal-close");
  await app.waitFor("side-question-compact-sheet", { state: "gone" });
  expect(app.shows("side-question-close-dialog")).toBe(false);
});

test("background commands show their output, take input and can be interrupted", async () => {
  const backend = createBackend();
  const running = {
    agentSessionId: "session-1",
    execSessionId: 7,
    command: "pnpm run dev",
    workdir: "/repo",
    remote: false,
    tty: true,
    status: "running",
    exitCode: null,
    startedAt: 1763000000,
    endedAt: null,
    retainedBytes: 12,
    retainedLimitBytes: 1000,
    truncatedFromStart: false,
  };
  const sent = withCommands(backend, {
    get_session_thread_goal: () => ({ goal: null }),
    list_background_command_activities: () => ({ activities: [running] }),
    read_background_command_output: request => ({
      metadata: running,
      cursor: 2,
      reset: request.cursor === null,
      snapshot: request.cursor === null ? "ready on :5173\n" : null,
      chunks: [],
    }),
    send_background_command_input: () => null,
    control_background_command: () => null,
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("background-commands-strip");
  expect(sent.list_background_command_activities?.[0]).toEqual({ agentSessionId: "session-1" });
  expect(app.texts()).toContain("1 command running");

  await app.press("background-commands-strip");
  await app.press("background-command-7");
  await app.waitFor("background-output-text");
  expect(sent.read_background_command_output?.[0]).toEqual({ execSessionId: 7, remote: false, cursor: null });
  await app.waitFor("ready on :5173\n");

  await app.type("background-output-input", "rs");
  await app.submit("background-output-input");
  await app.waitUntil(() => (sent.send_background_command_input ?? []).length === 1);
  expect(sent.send_background_command_input?.[0]).toEqual({ execSessionId: 7, remote: false, chars: "rs", appendEnter: true });

  await app.press("background-output-interrupt");
  await app.waitUntil(() => (sent.control_background_command ?? []).length === 1);
  expect(sent.control_background_command?.[0]).toEqual({ execSessionId: 7, action: "interrupt", remote: false });
});

test("a side question launched from the split keeps that parent across follow-ups", async () => {
  const backend = createBackend();
  const sent = withCommands(backend, { btw_ask_stream: () => ({ ok: true }) });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  await app.type("composer", "Primary draft");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("Port the terminal.");
  await app.type("secondary-composer", "/btw Inspect the terminal");
  await app.submit("secondary-composer");
  await app.waitFor("id:side-question-pane");
  await app.waitUntil(() => sent.btw_ask_stream?.length === 1);
  const original = sent.btw_ask_stream?.[0];
  expect(original).toMatchObject({ sessionId: "session-2", workspaceId: "workspace-1", question: "Inspect the terminal" });
  await app.host.send("openbitfun.event", {
    event: "agentic://dialog-turn-completed", payload: { sessionId: original?.childSessionId },
  });
  await app.type("side-question-input", "Follow up");
  await app.press("side-question-ask");
  await app.waitUntil(() => sent.btw_ask_stream?.length === 2);
  expect(sent.btw_ask_stream?.[1]).toMatchObject({
    sessionId: "session-2", childSessionId: original?.childSessionId, question: "Follow up",
  });
  expect(app.value("composer")).toBe("Primary draft");
});

test("an MCP prompt form fills the composer it was opened from", async () => {
  const backend = createBackend();
  const sent = withCommands(backend, {
    list_mcp_prompts: request => request.serverId === "fs-server" ? [{
      name: "explain", description: "Explain a file",
      arguments: [{ name: "path", required: true }],
    }] : [],
    get_mcp_prompt: request => ({
      messages: [{ role: "user", content: { type: "text", text: "Explain " + String((request.arguments as Record<string, string>).path) } }],
    }),
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  await app.type("composer", "Main draft");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("Port the terminal.");
  await app.type("secondary-composer", "/explain");
  await app.press("secondary-mcp-prompt-fs-server-explain");
  await app.waitFor("mcp-prompt-dialog");
  await app.type("mcp-prompt-arg-path", "src/lib.rs");
  await app.press("mcp-prompt-insert");
  await app.waitUntil(() => app.value("secondary-composer") === "Explain src/lib.rs");
  expect(sent.get_mcp_prompt?.[0]).toMatchObject({ serverId: "fs-server", promptName: "explain", arguments: { path: "src/lib.rs" } });
  expect(app.value("composer")).toBe("Main draft");
});

test("MCP prompts of the device's running servers are offered under `/` and fill the composer", async () => {
  const backend = createBackend();
  const sent = withCommands(backend, {
    get_session_thread_goal: () => ({ goal: null }),
    list_mcp_prompts: request =>
      request.serverId === "fs-server"
        ? [
            { name: "summarize", title: "Summarize folder", description: "Summarize a folder", arguments: [] },
            {
              name: "explain",
              description: "Explain a file",
              arguments: [{ name: "path", description: "File to explain", required: true }],
            },
          ]
        : [],
    get_mcp_prompt: request => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              request.promptName === "explain"
                ? `Explain ${(request.arguments as Record<string, string>).path}`
                : "Summarize the workspace folder.",
          },
        },
      ],
    }),
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitUntil(() => (sent.list_mcp_prompts ?? []).length > 0);
  // Only the running server is asked; the stopped one publishes nothing.
  expect((sent.list_mcp_prompts ?? []).map(request => request.serverId)).toEqual(["fs-server"]);

  await app.type("composer", "/");
  await app.waitFor("mcp-prompt-fs-server-summarize");
  await app.press("mcp-prompt-fs-server-summarize");
  await app.waitUntil(() => app.value("composer") === "Summarize the workspace folder.");
  expect(sent.get_mcp_prompt?.[0]).toEqual({ serverId: "fs-server", promptName: "summarize" });

  // A prompt with arguments asks for them first.
  await app.clear("composer");
  await app.type("composer", "/expl");
  await app.press("mcp-prompt-fs-server-explain");
  await app.waitFor("mcp-prompt-dialog");
  await app.type("mcp-prompt-arg-path", "src/main.rs");
  await app.press("mcp-prompt-insert");
  await app.waitUntil(() => app.value("composer") === "Explain src/main.rs");
  expect(sent.get_mcp_prompt?.[1]).toEqual({ serverId: "fs-server", promptName: "explain", arguments: { path: "src/main.rs" } });
  expect(backend.actions()).not.toContain("submit_user_message");
});

test("a finished MCP tool with a UI opens its app from the session's device", async () => {
  const backend = createBackend();
  const sent = withCommands(backend, {
    get_session_thread_goal: () => ({ goal: null }),
    load_session_turns: request =>
      request.session_id === "session-1"
        ? [
            {
              turnId: "turn-mcp",
              userMessage: { id: "u1", content: "Chart the sales" },
              modelRounds: [
                {
                  toolItems: [
                    {
                      id: "mcp-1",
                      toolName: "mcp__fs-server__chart",
                      toolCall: { input: { metric: "sales" } },
                      toolResult: { success: true, result: { content: [{ type: "text", text: "rendered" }] } },
                      status: "completed",
                    },
                  ],
                  textItems: [{ id: "after", content: "Here is the chart." }],
                },
              ],
            },
          ]
        : [],
    get_tool_info: request =>
      request.toolName === "mcp__fs-server__chart"
        ? { name: request.toolName, dynamic_info: { providerId: "mcp", mcp: { serverId: "fs-server", serverName: "Filesystem", toolName: "chart" } } }
        : null,
    get_mcp_tool_ui_uri: () => "ui://fs-server/chart",
    fetch_mcp_app_resource: request => ({
      contents: [{ uri: request.resourceUri, content: "<html><head></head><body>chart</body></html>", mimeType: "text/html" }],
    }),
  });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("tool-card-mcp__fs-server__chart");
  await app.press("tool-card-mcp__fs-server__chart");
  await app.waitUntil(() => (sent.get_mcp_tool_ui_uri ?? []).length === 1);
  expect(sent.get_tool_info?.[0]).toEqual({ toolName: "mcp__fs-server__chart" });
  // The tool's metadata names the UI (positional `toolName`), asked on the session's device.
  expect(sent.get_mcp_tool_ui_uri?.[0]).toEqual({ toolName: "mcp__fs-server__chart" });
  await app.waitFor("text:Open app");
  await app.press("text:Open app");
  await app.waitFor("mcp-app-panel");
  await app.waitUntil(() => (sent.fetch_mcp_app_resource ?? []).length === 1);
  expect(sent.fetch_mcp_app_resource?.[0]).toEqual({ serverId: "fs-server", resourceUri: "ui://fs-server/chart" });
  await app.waitFor("mcp-app-frame");
});
