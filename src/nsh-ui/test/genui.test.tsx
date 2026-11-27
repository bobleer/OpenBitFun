// GenerativeUI answers drawn with NSH components: the OpenUI Lang reader, the
// interactive application in a settled turn, and a source streamed live.
import { expect, open, test } from "nsh/test";
import { Evaluator, initialState, parseOpenUi, type GenElement } from "../src/genui/openuiLang";
import { callBuiltin } from "../src/genui/genuiFunctions";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };

const STEPPER = [
  "root = Col([title, stepper, list, copy, ask])",
  "$guests = 4",
  '$got = []',
  'title = Title("Pasta night for " + @Plural($guests, "guest"), "lg")',
  'stepper = Row([IconButton("minus", @Set($guests, @Clamp($guests - 1, 1, 20)), "Fewer"), Text($guests + "", "lg", null, "semibold"), IconButton("plus", @Set($guests, @Clamp($guests + 1, 1, 20)), "More")], 3)',
  'lines = @Each(base, "i", {name: i.name, qty: @Round(i.qty * $guests / 4) + i.unit})',
  'list = Col(@Each(lines, "l", Checkbox(@Includes($got, l.name), l.qty + " " + l.name)), 1)',
  'copy = Button("Copy list", @CopyToClipboard(@Join(@Each(lines, "l", l.qty + " " + l.name), "\\n")), "outline", null, "sm")',
  'ask = Button("Suggest a wine", @ToAssistant("Suggest a wine", {guests: $guests}))',
  'base = [{name: "spaghetti", qty: 400, unit: " g"}, {name: "tomatoes", qty: 6, unit: ""}]',
].join("\n");

test("OpenUI Lang: positional props, hoisting, state, @Each and builtins", () => {
  const program = parseOpenUi(STEPPER);
  expect(program.errors).toHaveLength(0);
  const state = initialState(program);
  expect(state.guests).toBe(4);
  const evaluation = new Evaluator(program, state).evaluateRoot();
  const root = evaluation.root as GenElement;
  expect(root.component).toBe("Col");
  const [title, stepper, list] = root.props.children as GenElement[];
  expect(title.props.text).toBe("Pasta night for 4 guests");
  expect(title.props.size).toBe("lg");
  expect((stepper.props.children as GenElement[])[1].props.text).toBe("4");
  const items = list.props.children as GenElement[];
  expect(items.map(item => item.props.label)).toEqual(["400 g spaghetti", "6 tomatoes"]);
  expect(evaluation.unknown).toEqual([]);

  // Actions resolve against the state at the moment they run.
  const evaluator = new Evaluator(program, { guests: 6 });
  const next = evaluator.evaluateRoot().root as GenElement;
  const minus = ((next.props.children as GenElement[])[1].props.children as GenElement[])[0];
  expect(evaluator.resolveAction(minus.props.action as never)).toEqual([{ kind: "set", name: "guests", value: 5 }]);
});

test("OpenUI Lang: a streamed source renders what is complete", () => {
  const partial = 'root = Card([head, body])\nhead = Title("Weekly report")\nbody = Text("Revenue is up 12';
  const program = parseOpenUi(partial);
  const evaluation = new Evaluator(program, {}).evaluateRoot();
  const root = evaluation.root as GenElement;
  expect(root.component).toBe("Card");
  expect((root.props.children as Array<GenElement | null>)[0]?.props.text).toBe("Weekly report");
  expect(evaluation.unresolved).toContain("body");
  expect(callBuiltin("Format", [1234.5, "currency"])).toBe("$1,234.50");
  expect(callBuiltin("NoSuchFunction", [])).toBeUndefined();
});

function genuiTurn(source: string, values: Record<string, unknown> = {}) {
  return [
    {
      turnId: "turn-genui",
      userMessage: { id: "u1", content: "Plan pasta night" },
      modelRounds: [
        {
          toolItems: [
            {
              id: "genui-1",
              toolName: "GenerativeUI",
              toolCall: { input: { protocol: "openbitfun.genui.v1", messages: [] } },
              toolResult: {
                success: true,
                result: {
                  success: true,
                  widget_id: "pasta",
                  title: "Pasta night",
                  app: {
                    id: "pasta",
                    title: "Pasta night",
                    template: "openbitfun.app",
                    libraryId: "openbitfun.composable.v1",
                    libraryRevision: 2,
                    source: { kind: "openui-lang", content: source },
                    state: {},
                  },
                  app_state: values,
                },
              },
            },
          ],
          textItems: [{ id: "after", content: "Here is a planner." }],
        },
      ],
    },
  ];
}

function withTurns(backend: ReturnType<typeof createBackend>, turns: unknown[], sessionId = "session-1"): void {
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const args = (data ?? {}) as { action?: string; request?: Record<string, unknown> };
    if (args.action === "load_session_turns" && args.request?.session_id === sessionId) {
      return { ok: true, value: turns, transport: "dev" };
    }
    return base(data);
  };
}

test("a settled GenerativeUI answer is an interactive interface in the transcript", async () => {
  const backend = createBackend();
  withTurns(backend, genuiTurn([
    STEPPER.replace("title, stepper, list, copy, ask", "title, stepper, list, copy, ask, equation, decoration"),
    'equation = Math("E = mc^2")',
    'decoration = IconButton("dot", null, "Decoration")',
  ].join("\n")));
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Pasta night for 4 guests");
  expect(app.texts()).toContain("400 g spaghetti");
  // Not drawn as a generic tool row.
  expect(app.shows("label:tool-card-GenerativeUI")).toBe(false);

  await app.press("genui-icon-More");
  await app.waitFor("Pasta night for 5 guests");
  expect(app.texts()).toContain("500 g spaghetti");

  await app.press("genui-check-500 g spaghetti");
  await app.press("genui-button-Copy list");
  await app.waitUntil(() => app.clipboard() === "500 g spaghetti\n8 tomatoes");

  await app.waitFor("genui-math");
  await app.press("genui-icon-Decoration");
  expect(backend.actions()).not.toContain("submit_user_message");
  await app.type("composer", "Keep this private draft");
  await app.paste("composer", { uris: ["file:///tmp/draft-only.png"] });
  await app.waitFor("attachment-preview-attachment-drop-1");
  await app.press("genui-button-Suggest a wine");
  await app.waitUntil(() => backend.actions().includes("submit_user_message"));
  const sent = backend.calls.find(call => call.action === "submit_user_message")?.request as {
    sessionId: string; text: string; attachments?: unknown[];
  };
  expect(sent.sessionId).toBe("session-1");
  expect(sent.text).toContain("Suggest a wine");
  expect(sent.text).toContain('"guests":5');
  expect(sent.attachments).toBeUndefined();
  expect(app.value("composer")).toBe("Keep this private draft");
  expect(app.shows("attachment-preview-attachment-drop-1")).toBe(true);
});

test("GenUI controls keep their card state and send to their session across a fleet split and swap", async () => {
  const backend = createBackend();
  withTurns(backend, genuiTurn(STEPPER.replace("Pasta night for", "Entry menu for"), { guests: 2 }), "s-a1");
  withTurns(backend, genuiTurn(STEPPER
    .replace("Pasta night for", "Owner menu for")
    .replace('"More"', '"More for owner"')
    .replaceAll("Suggest a wine", "Suggest a wine for owner")), "s-b1");
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], devices: [
      fleetDeviceRow("dev-a", "Entry", [{ workspaceId: "ws-a", name: "Entry project", rootPath: "/entry",
        sessions: [fleetSessionRow("dev-a", "ws-a", "s-a1", "Entry session")] }], { isClientDevice: true }),
      fleetDeviceRow("dev-b", "Session owner", [{ workspaceId: "ws-b", name: "Owner project", rootPath: "/owner",
        sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Owner session")] }]),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  await app.press("id:sidebar-session-s-a1");
  await app.waitFor("Entry menu for 2 guests");
  await app.type("composer", "Entry draft");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("id:secondary-session-pane");
  await app.press("id:sidebar-session-s-b1");
  await app.waitFor("Owner menu for 4 guests");
  await app.type("secondary-composer", "Owner draft");
  await app.press("genui-icon-More for owner");
  await app.waitFor("Owner menu for 5 guests");
  expect(app.shows("Entry menu for 2 guests")).toBe(true);

  await app.press("genui-button-Suggest a wine for owner");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "submit_user_message"));
  const sent = () => host.fleetCalls.filter(call => call.command === "submit_user_message");
  expect(sent()[0]).toMatchObject({ target: "dev-b", args: {
    request: { sessionId: "s-b1", workspaceId: "ws-b", text: 'Suggest a wine for owner\n\nContext: {"guests":5}' },
  } });
  expect(app.value("composer")).toBe("Entry draft");
  expect(app.value("secondary-composer")).toBe("Owner draft");

  await app.hover("id:split-divider-proximity-left");
  await app.press("split-divider-swap");
  await app.waitFor("Owner menu for 5 guests");
  await app.waitFor("Entry menu for 2 guests");
  await app.press("genui-button-Suggest a wine");
  await app.waitUntil(() => sent().length === 2);
  expect(sent()[1]).toMatchObject({ target: "dev-a", args: {
    request: { sessionId: "s-a1", workspaceId: "ws-a", text: 'Suggest a wine\n\nContext: {"guests":2}' },
  } });
});

test("a GenerativeUI source streamed live renders as it arrives", async () => {
  const backend = createBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Port the session list.");
  const send = (event: string, payload: Record<string, unknown>) =>
    app.host.send("openbitfun.event", { event, payload: { sessionId: "session-1", turnId: "turn-gen", ...payload } });
  await send("agentic://dialog-turn-started", { userInput: "Show the report" });
  await send("agentic://tool-event", {
    roundId: "r1",
    toolEvent: { event_type: "EarlyDetected", tool_id: "gen-live", tool_name: "GenerativeUI" },
  });
  await app.waitFor("label:genui-generating");
  const delta = (seq: number, text: string, reset = false) =>
    send("agentic://tool-event", {
      roundId: "r1",
      toolEvent: { event_type: "GenUIStream", tool_id: "gen-live", tool_name: "GenerativeUI", message_id: "m", seq, format: "openui-lang", text, reset, title: "Report" },
    });
  await delta(0, 'root = Card([head, chart])\nhead = Title("Weekly report")\n', true);
  await app.waitFor("Weekly report");
  // A repeated delta is ignored; the next one completes the chart.
  await delta(0, 'root = Card([head, chart])\nhead = Title("Weekly report")\n');
  await delta(1, 'chart = Chart("bar", [{day: "Mon", sales: 3}, {day: "Tue", sales: 5}], "day", ["sales"])\n');
  await app.waitFor("label:genui-chart-bar");
  expect(app.texts().filter(text => text === "Weekly report")).toHaveLength(1);
});

test("a failed GenerativeUI candidate leaves no card; an unknown component is named", async () => {
  const backend = createBackend();
  const turns = genuiTurn('root = Col([title, odd])\ntitle = Title("Mostly works")\nodd = Hologram("x")');
  withTurns(backend, [
    ...turns,
    {
      turnId: "turn-fail",
      userMessage: { id: "u2", content: "Again" },
      modelRounds: [
        {
          toolItems: [
            {
              id: "genui-bad",
              toolName: "GenerativeUI",
              toolCall: { input: { protocol: "openbitfun.genui.v1" } },
              toolResult: { success: false, error: "invalid source" },
            },
          ],
          textItems: [{ id: "fail-text", content: "Let me fix that." }],
        },
      ],
    },
  ]);
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.waitFor("Mostly works");
  await app.waitFor("Let me fix that.");
  expect(app.texts().join("\n")).toContain("Not drawn in this view: Hologram");
  expect(app.texts().join("\n")).not.toContain("invalid source");
});
