// Transcript reads ask for shortened tool results; opening a card reads its one
// turn whole, shows the result there, and offers a retry when that read fails.
import { expect, open, test } from "nsh/test";
import { Buffer } from "buffer";
import type { TranscriptTurnView } from "../src/api";
import { hasFigureDeclaration } from "../src/ui/figurePreviewDocument";
import { materializeFigureAtlas } from "../src/ui/figureAtlas";
import { buildFigureBindingGuest } from "../src/ui/figureBindingGuest";
import { parseFigureReaderEvent } from "../src/figureReaderStore";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const EDIT_NEW = Array.from({ length: 41 }, (_, i) => `line ${i}`).join("\n");
const FULL = `FULL-OUTPUT ${"line of output ".repeat(40)}END-OF-OUTPUT`;

test("the saved figure chooses the built-in renderer only for a direct declaration", () => {
  const figure = '<figure data-openbitfun-visualize><figcaption>Durations</figcaption><script type="application/json">{}</script></figure>';
  expect(hasFigureDeclaration(figure)).toBe(true);
  expect(hasFigureDeclaration(`<!--${figure}-->`)).toBe(false);
  expect(hasFigureDeclaration(`<template>${figure}</template>`)).toBe(false);
  expect(hasFigureDeclaration('<figure data-openbitfun-visualize><details><summary>Show detail</summary></details></figure>')).toBe(false);
});

test("atlas replay preserves surrounding markup and waits for consent to load a street map", async () => {
  const street = '<script type="application/json" data-visual-atlas="1">{"detail":"street"}</script>';
  expect(await materializeFigureAtlas(`<!--${street}--><template>${street}</template>`)).toBe(null);
  const invalid = '<script type="application/json" data-visual-atlas="1">{</script>';
  const source = `<figure><h2>Route 🌍</h2>${street}<p>Stops</p>${invalid}</figure>`;
  const result = await materializeFigureAtlas(source);
  expect(result?.streetPending).toBe(true);
  expect(result?.streetFailed).toBe(false);
  expect(result?.html).toBe(
    '<figure><h2>Route 🌍</h2><p>Stops</p><p role="alert">The regional map could not be displayed.</p></figure>',
  );
});

test("street maps with bound data cannot send unresolved stop names to a public geocoder", async () => {
  const source = '<!-- vis-bindings\n{"visits":{"type":"json","value":[]}}\n-->\n' +
    '<script type="application/json" data-visual-atlas="1">{"detail":"street","places":["A stop"]}</script>';
  const result = await materializeFigureAtlas(source, { online: new AbortController().signal });
  expect(result?.streetPending).toBe(false);
  expect(result?.html.includes('needs saved stop coordinates')).toBe(true);
});

test("regional atlas previews fetch only the fixed public map layers", async () => {
  const requests: string[] = [];
  const empty = { type: "FeatureCollection", features: [] };
  const app = await open("./fixtures/figureAtlasApp.tsx", {
    ...DESKTOP,
    network: {
      "https://raw.githubusercontent.com/figure-test/map.css": { body: "" },
      "https://raw.githubusercontent.com/openBitFun/OpenBitFun/*/third_party/visualize/atlas/*.json": request => {
        const url = new URL(request.url);
        requests.push(url.href);
        if (!url.pathname.endsWith("/land.json")) return { body: empty };
        return { body: {
          type: "Polygon",
          coordinates: [[[119, 29], [119, 31], [121, 31], [121, 29], [119, 29]]],
        } };
      },
    },
  });
  await app.waitFor("map rendered");
  expect(requests.map(url => new URL(url).pathname.split("/").pop()).sort()).toEqual([
    "borders.json", "lakes.json", "land.json", "provinces.json", "rivers.json", "seas.json",
  ]);
  expect(requests.every(url => !new URL(url).search && /OpenBitFun\/[a-f0-9]{40}\//.test(url))).toBe(true);
});

test("bound figure guests receive only compatible, declared saved values", () => {
  const source = '<!-- vis-bindings\n' + JSON.stringify({
    title: { type: "json", value: "Report" },
    toolData: { type: "tool", tool: "GetThings", arguments: {}, refreshIntervalSeconds: 60 },
    fileData: { type: "file", path: "./source.csv" },
    image: { type: "image", url: "https://example.com/report.png" },
  }) + '\n-->\n<output></output>';
  const raw = {
    toolData: { kind: "json", value: "</script><script>unexpected()</script>" },
    fileData: { kind: "image", value: "data:image/png;base64,AA==" },
    image: { kind: "image", value: "https://example.com/report.png" },
    unlisted: { kind: "json", value: "unlisted private result" },
  };
  const guest = buildFigureBindingGuest(source, raw, 100);
  expect(guest.sources.map(row => [row.name, row.available])).toEqual([
    ["title", true], ["toolData", true], ["fileData", false], ["image", false],
  ]);
  expect(guest.prefix.includes("<script>unexpected()")).toBe(false);
  expect(guest.prefix.includes("https://example.com")).toBe(false);
  expect(guest.prefix.includes("unlisted private result")).toBe(false);
  expect(buildFigureBindingGuest(source, raw, 1024 * 1024).sources.some(row => row.available)).toBe(false);
});

test("figure reading events accept only the current document and bounded state", () => {
  const state = { group: "Windows", charts: [["duration", { hidden: ["P95", "P95"], row: 1 }]] };
  const event = { figureReader: "current", type: "state", state };
  expect(parseFigureReaderEvent(JSON.stringify(event), "previous")).toBe(null);
  expect(parseFigureReaderEvent(JSON.stringify(event), "current")).toEqual({
    type: "state", state: { group: "Windows", charts: [["duration", { hidden: ["P95"], row: 1 }]] },
  });
  expect(parseFigureReaderEvent(JSON.stringify({ ...event, state: { group: null, charts: [["duration", { hidden: [], row: -1 }]] } }), "current")).toBe(null);
  expect(parseFigureReaderEvent(JSON.stringify({ figureReader: "current", type: "followUp", message: "根".repeat(6000) }), "current")).toBe(null);
  const widget = { group: null, charts: [], widget: { view: "week", event: "0" } };
  expect(parseFigureReaderEvent(JSON.stringify({ ...event, state: widget }), "current")).toEqual({ type: "state", state: widget });
  expect(parseFigureReaderEvent(JSON.stringify({ ...event, state: { ...widget, widget: { view: ["week"] } } }), "current")).toBe(null);
});

test("published figures read and refresh the exact owning turn even when two turns reused the URI", async () => {
  const uri = "openbitfun://current-session/artifacts/visualizations/v2/release-totals.html";
  const source = '<!-- vis-bindings\n{"totals":{"type":"tool","tool":"GetTotals","arguments":{},"refreshIntervalSeconds":60}}\n-->\n<h2>发布统计</h2>';
  const figure = { uri, contentBytes: Buffer.byteLength(source, "utf8") };
  const turns: TranscriptTurnView[] = [
    { ...turn("", false), turnId: "figure-original", turnIndex: 3, publishedFigures: [figure], items: [{
      kind: "text", id: "original", roundIndex: 0,
      text: `First totals\n\uE200visualize\uE202${JSON.stringify({ path: uri, title: "Original totals" })}\uE201`,
    }] },
    { ...turn("", false), turnId: "figure-revised", turnIndex: 4, publishedFigures: [figure], items: [{
      kind: "text", id: "revised", roundIndex: 0, text: "Revised totals",
    }] },
  ];
  const backend = createBackend();
  const base = backend.handlers["openbitfun.invoke"];
  let wrongTurn = true;
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const args = data as { action: string; request?: Record<string, unknown> };
    if (args.action === "get_mcp_servers") return {
      ok: true, value: [{ id: "metrics", name: "Fixture Metrics", enabled: true, status: "connected" }],
    };
    if (args.action === "list_mcp_resources" && args.request?.serverId === "metrics") return {
      ok: true, value: [{ uri: "metrics://releases", name: "Release totals stream" }],
    };
    if (args.action === "read_mcp_resource" && args.request?.resourceUri === "metrics://releases") return {
      ok: true, value: { contents: [{ uri: "metrics://releases", content: "[3,4]" }] },
    };
    if (args.action !== "get_session_transcript_view" || args.request?.session_id !== "figure-session") return base(data);
    const selected = args.request.figure_source as {
      bindingRefresh?: { name: string; turnId: string; requestToken?: string };
    } | undefined;
    const refresh = selected?.bindingRefresh;
    const origin = turns[wrongTurn ? 0 : 1];
    return { ok: true, transport: "dev", value: {
      sessionId: "figure-session", mode: selected ? "before" : "full", cursor: null, hasEarlier: false,
      turns: selected ? [{ ...origin, publishedFigures: [{
        ...figure, bindingRefreshSupported: true, ...(refresh
          ? { bindingRefresh: { name: refresh.name, turnId: refresh.turnId, value: { kind: "json", value: [5, 6] } } }
          : { source, bindings: { totals: { kind: "json", value: [1, 2] } } }),
      }] }] : turns,
    } };
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "entry" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("entry", "Controller", [], { isClientDevice: true }),
      fleetDeviceRow("figure-owner", "Figure owner", [{
        workspaceId: "figure-workspace", name: "Figure workspace", rootPath: "/owner/figures", kind: "local",
        sessions: [
          fleetSessionRow("figure-owner", "figure-workspace", "figure-session", "Saved figures"),
          fleetSessionRow("figure-owner", "figure-workspace", "other-session", "Other session"),
        ],
      }], { hostKind: "desktop", state: "online" }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSession(app, "Saved figures", { deviceId: "figure-owner" });
  await app.type("composer", "Existing draft");
  const preview = "label:preview-figure-release-totals";
  await app.waitFor(`${preview} >> nth=1`);
  expect(app.shows(`${preview} >> nth=2`)).toBe(false);
  expect(app.shows("id:inline-figure-release-totals >> text:Original totals")).toBe(true);
  const sourceReads = () => host.fleetCalls.flatMap(call => {
    const request = call.args.request as Record<string, unknown> | undefined;
    return call.command === "get_session_transcript_view" && request?.figure_source ? [[call.target, request]] : [];
  });
  expect(sourceReads()).toHaveLength(0);

  await app.press(`${preview} >> nth=1`);
  await app.waitFor("The saved figure could not be displayed.");
  wrongTurn = false;
  await app.press("Try again");
  await app.waitFor("label:inline-figure-document");
  await app.press("label:figure-data-sources");
  await app.waitFor("text:Saved");
  expect(sourceReads()).toEqual(Array(2).fill(["figure-owner", {
    session_id: "figure-session", workspace_id: "figure-workspace", limit: 1, before_turn_index: 5,
    figure_source: { turnId: "figure-revised", uri },
  }]));
  const resourceCalls = () => host.fleetCalls.filter(call => /^(list_mcp_resources|read_mcp_resource)$/.test(call.command));
  expect(resourceCalls()).toHaveLength(0);
  await app.press("label:figure-resource-connect-totals");
  await app.waitFor("label:figure-resource-server-totals");
  await app.press("label:figure-resource-server-totals");
  await app.press("text:Fixture Metrics");
  await app.waitFor("label:figure-resource-select-totals");
  await app.press("label:figure-resource-select-totals");
  await app.press("text:Release totals stream");
  await app.waitFor("text:Updated");
  expect(resourceCalls().map(call => [call.target, call.command, call.args.request])).toEqual([
    ["figure-owner", "list_mcp_resources", { serverId: "metrics", refresh: true }],
    ["figure-owner", "read_mcp_resource", { serverId: "metrics", resourceUri: "metrics://releases" }],
  ]);
  await app.press("label:figure-resource-disconnect-totals");
  await app.press("label:figure-refresh-source-totals");
  await app.waitUntil(() => !app.shows("label:inline-figure-document"));
  const draft = app.value("composer") as string;
  const token = draft.match(/\[visualize:[a-f0-9]{32}\]/)?.[0];
  expect(Boolean(token)).toBe(true);
  expect(draft.startsWith("Existing draft\n\nRefresh totals using this source")).toBe(true);
  expect(host.fleetCalls.some(call => call.command === "submit_user_message")).toBe(false);
  await app.press("Send");
  await app.waitUntil(() => host.fleetCalls.some(call => call.command === "submit_user_message"));

  const receipt = (turnId: string, turnIndex: number, text: string): TranscriptTurnView => ({
    ...turn("", false), turnId, turnIndex,
    user: { id: `user-${turnId}`, text, timestampMs: 1 },
    items: [{ kind: "tool", roundIndex: 0, tool: {
      id: `tool-${turnId}`, name: "GetTotals", status: "completed", success: true, result: [5, 6],
    } }],
  });
  turns.push(
    receipt("requested-refresh", 5, draft),
    receipt("later-result", 6, "A later request"),
  );
  await openSession(app, "Other session", { deviceId: "figure-owner" });
  await openSession(app, "Saved figures", { deviceId: "figure-owner" });
  await app.waitFor("text:A later request");
  await app.press(`${preview} >> nth=1`);
  await app.waitFor("label:inline-figure-document");
  await app.press("label:figure-data-sources");
  await app.waitFor("text:Updated");
  const refreshReads = () => sourceReads().flatMap(([target, request]) => {
    const figureSource = (request as Record<string, unknown>).figure_source as { bindingRefresh?: unknown };
    return figureSource.bindingRefresh ? [[target, figureSource]] : [];
  });
  expect(refreshReads()).toEqual([["figure-owner", { turnId: "figure-revised", uri,
    bindingRefresh: { name: "totals", turnId: "requested-refresh", turnIndex: 5, requestToken: token },
  }]]);
  await app.press("label:figure-watch-session-totals");
  await app.waitUntil(() => refreshReads().length === 2);
  expect(refreshReads()[1]).toEqual(["figure-owner", { turnId: "figure-revised", uri,
    bindingRefresh: { name: "totals", turnId: "later-result", turnIndex: 6 },
  }]);
  expect(host.pageHostCalls).toHaveLength(0);
});

function turn(output: string, omitted: boolean) {
  return {
    turnId: "turn-1",
    turnIndex: 3,
    kind: "user_dialog",
    status: "done",
    settled: true,
    user: { id: "u-1", text: "Run the build", displayText: "Run the build", timestampMs: 1, images: [] },
    items: [
      {
        kind: "tool",
        roundIndex: 0,
        tool: {
          id: "call-1",
          name: "GetThings",
          input: { what: "build" },
          status: "completed",
          success: false,
          result: { output },
          startMs: 1,
          ...(omitted ? { detailOmitted: true } : {}),
        },
      },
      {
        kind: "tool",
        roundIndex: 0,
        tool: {
          id: "call-2",
          name: "CallDeferredTool",
          // A summary read sends a preview of the edit and the host's line counts.
          input: { tool_name: "Edit", args: {
            file_path: "/repo/src/main.rs", old_string: "a", new_string: omitted ? "b\nc\n…" : EDIT_NEW,
          } },
          status: "completed",
          success: true,
          startMs: 2,
          ...(omitted ? { detailOmitted: true, diffStats: { added: 41, removed: 1 } } : {}),
        },
      },
      { kind: "text", id: "t-1", roundIndex: 0, text: "Build finished" },
    ],
    startTimeMs: 1,
    assistantTimestampMs: 2,
  };
}

test("an opened card reads its turn whole once, and a failed read is said and retried", async () => {
  const backend = createBackend({
    sessions: [
      { sessionId: "session-detail", sessionName: "Summarized", lastUpdated: 1763100000000, messageCount: 2, turnCount: 1, agentType: "Standard" } as never,
    ],
  });
  const reads: Array<Record<string, unknown>> = [];
  let failNext = true;
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const args = (data ?? {}) as { action?: string; request?: Record<string, unknown> };
    if (args.action !== "get_session_transcript_view" || args.request?.session_id !== "session-detail") return base(data);
    reads.push(args.request);
    const summary = args.request.tool_detail === "summary";
    if (!summary && args.request.before_turn_index !== undefined && failNext) {
      failNext = false;
      return { ok: false, error: "the device is offline", transport: "dev" };
    }
    return {
      ok: true,
      transport: "dev",
      value: {
        sessionId: "session-detail",
        mode: args.request.before_turn_index !== undefined ? "before" : "full",
        turns: [turn(summary ? "FULL-OUTPUT\n…" : FULL, summary)],
        cursor: null,
        hasEarlier: false,
      },
    };
  };
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "Summarized");
  await app.waitFor("Build finished", { timeout: 20_000 });
  await app.waitFor("id:ambient-tool-card >> label:tool-card-GetThings");
  await app.waitFor("id:prominent-tool-card >> label:tool-card-Edit");
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every(read => read.tool_detail === "summary")).toBe(true);
  // The collapsed edit shows the host's counts, not ones taken from its preview.
  expect(app.texts()).toContain("+41");
  expect(app.texts()).toContain("−1");

  await app.press("label:tool-card-GetThings");
  await app.waitFor("Only a preview is available; the full result could not be read.");
  const wholeReads = () => reads.filter(read => read.tool_detail === undefined);
  expect(wholeReads()).toEqual([
    { session_id: "session-detail", workspace_id: wholeReads()[0]!.workspace_id, limit: 1, before_turn_index: 4 },
  ]);

  await app.press("Retry");
  await app.waitFor(`text:${FULL}`);
  expect(app.shows("Only a preview is available; the full result could not be read.")).toBe(false);
  expect(wholeReads().length).toBe(2);

  // Closing and opening it again uses what was read.
  await app.press("label:tool-card-GetThings");
  await app.press("label:tool-card-GetThings");
  await app.waitFor(`text:${FULL}`);
  expect(wholeReads().length).toBe(2);
});

test("an expanded WebFetch shows the fetched title and a single URL", async () => {
  const backend = createBackend({
    sessions: [{ sessionId: "session-webfetch", sessionName: "Fetched pages", lastUpdated: 1763100000000,
      messageCount: 2, agentType: "Standard" }],
  });
  const url = "https://example.com/article";
  const untitledUrl = "https://example.com/data.json";
  const title = "Article title from WebFetch";
  const base = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = (data: unknown) => {
    const args = (data ?? {}) as { action?: string; request?: Record<string, unknown> };
    if (args.action !== "get_session_transcript_view" || args.request?.session_id !== "session-webfetch") return base(data);
    const summary = args.request.tool_detail === "summary";
    const fetchedTurn: TranscriptTurnView = {
      ...turn("", false),
      items: [
        { kind: "tool", roundIndex: 0, tool: {
          id: "web-page", name: "WebFetch", input: { url }, status: "completed", success: true,
          result: summary ? { url, content: "Article preview…" } : { url, title, content: "Article body" },
          detailOmitted: summary,
        } },
        { kind: "text", id: "between-fetches", roundIndex: 0, text: "The article is ready." },
        { kind: "tool", roundIndex: 0, tool: {
          id: "web-data", name: "WebFetch", input: { url: untitledUrl, format: "json" }, status: "completed", success: true,
          result: { url: untitledUrl, title: null, content: '{"ready":true}' },
        } },
      ],
    };
    return { ok: true, transport: "dev", value: {
      sessionId: "session-webfetch", mode: summary ? "full" : "before", turns: [fetchedTurn], cursor: null, hasEarlier: false,
    } };
  };
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "Fetched pages");
  await app.waitFor(`text:${url}`);
  expect(app.shows(`label:web-result-${url}`)).toBe(false);
  await app.press("label:tool-card-WebFetch >> nth=0");
  await app.waitFor(`text:${title}`);
  await app.waitFor(`label:web-result-${url}`);
  const texts = app.texts();
  expect(texts.filter(text => text === url)).toHaveLength(1);
  expect(texts.indexOf(title)).toBeLessThan(texts.indexOf(url));
  expect(texts.indexOf(url)).toBeLessThan(texts.indexOf("Article body"));

  await app.press("label:tool-card-WebFetch >> nth=1");
  await app.waitFor(`label:web-result-${untitledUrl}`);
  expect(app.texts().filter(text => text === untitledUrl)).toHaveLength(1);
});

test("review reports render structured findings after hydration and preserve legacy results", async () => {
  const backend = createBackend({
    sessions: [
      { sessionId: "session-review-report", sessionName: "Saved review", lastUpdated: 1763100000000,
        messageCount: 2, turnCount: 1, agentType: "Standard" } as never,
    ],
  });
  const assessment = {
    overall_assessment: "The exceptional write path needs attention.",
    risk_level: "high",
    recommended_action: "request_changes",
    confidence_note: "Only the submitted diff was considered.",
  };
  const data = {
    summary: assessment, review_mode: "deep", evidence_status: "stale", evidence_coverage: "limited",
    target_changed_during_review: true,
    issues: [{ severity: "high", certainty: "confirmed", file: "src/store.rs", line: 42,
      title: "Write failure leaves stale metadata", description: "The history index is updated first.",
      suggestion: "Update the history index after the write." }],
    report_sections: {
      remediation_groups: { must_fix: ["Make the save atomic."] },
      strength_groups: { tests: ["The happy path is covered."] },
      coverage_notes: ["The binary asset was outside scope."],
    },
  };
  const base = backend.handlers["openbitfun.invoke"];
  let wholeReads = 0;
  backend.handlers["openbitfun.invoke"] = (payload: unknown) => {
    const args = (payload ?? {}) as { action?: string; request?: Record<string, unknown> };
    if (args.action !== "get_session_transcript_view" || args.request?.session_id !== "session-review-report") return base(payload);
    const summary = args.request.tool_detail === "summary";
    if (!summary) wholeReads += 1;
    const tools = [
      { id: "report", name: "CallDeferredTool", input: { tool_name: "submit_code_review", args: {} },
        result: summary ? '{ "summary": …' : data, ...(summary ? { detailOmitted: true } : {}) },
      { id: "legacy", name: "submit_code_review",
        result: JSON.stringify({ summary: { overall_assessment: "Legacy assessment retained." }, issues: [],
          remediation_plan: ["Follow the earlier plan."], positive_points: ["The fallback is covered."] }) },
      { id: "invalid", name: "submit_code_review", result: { summary: {}, issues: [{ unexpected: true }] } },
    ];
    return {
      ok: true,
      transport: "dev",
      value: {
        sessionId: "session-review-report", mode: summary ? "full" : "before", cursor: null, hasEarlier: false,
        turns: [{ ...turn("", false), items: tools.map(tool => ({ kind: "tool", roundIndex: 0,
          tool: { status: "completed", success: true, startMs: 1, ...tool } })) }],
      },
    };
  };
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "Saved review");
  const cards = "id:prominent-tool-card >> label:tool-card-submit_code_review";
  await app.waitFor(cards);
  expect(wholeReads).toBe(0);
  expect(app.shows("id:code-review-report")).toBe(false);
  expect(app.shows("label:review-copy-markdown")).toBe(false);
  await app.press(`${cards} >> nth=0`);
  await app.waitFor("Write failure leaves stale metadata");
  expect(wholeReads).toBe(1);
  expect(app.texts()).toContain("Deep review assessment");
  expect(app.texts()).toContain("Risk level High");
  expect(app.texts()).toContain("1 finding");
  expect(app.texts()).toContain("src/store.rs:42");
  expect(app.texts()).toContain("This review covered only part of the available evidence.");
  expect(app.texts()).toContain("The target changed while evidence was being collected.");
  expect(app.texts()).toContain("Make the save atomic.");
  expect(app.texts()).toContain("The happy path is covered.");
  expect(app.texts()).toContain("The binary asset was outside scope.");

  await app.press("label:review-copy-markdown");
  await app.waitUntil(() => (app.clipboard() ?? "").startsWith("# Review report\n"));
  const markdown = app.clipboard() ?? "";
  expect(markdown).toContain("## Deep review assessment");
  expect(markdown).toContain("### Write failure leaves stale metadata");
  expect(markdown).toContain("src/store.rs:42");
  expect(markdown).toContain("### Must fix\n\n- Make the save atomic.");
  expect(markdown).toContain("The target changed while evidence was being collected.");

  await app.press("label:review-open-markdown");
  await app.waitFor("label:review-markdown-editor");
  await app.press("label:review-editor-source");
  expect(app.value("label:review-editor-text")).toBe(markdown);
  await app.clear("label:review-editor-text");
  await app.type("label:review-editor-text", "# Draft for sharing");
  await app.press("label:review-editor-copy");
  await app.waitUntil(() => app.clipboard() === "# Draft for sharing");
  await app.press("label:review-editor-close");
  await app.waitFor("Discard changes");
  await app.press("Confirm");
  await app.waitUntil(() => !app.shows("label:review-markdown-editor"));
  await app.press("label:review-copy-markdown");
  await app.waitUntil(() => app.clipboard() === markdown);

  await app.press(`${cards} >> nth=1`);
  await app.waitFor("Legacy assessment retained.");
  expect(app.texts()).toContain("0 findings");
  expect(app.texts()).toContain("Follow the earlier plan.");
  expect(app.texts()).toContain("The fallback is covered.");
  expect(wholeReads).toBe(1);
  await app.press(`${cards} >> nth=1`);
  await app.press(`${cards} >> nth=2`);
  await app.waitFor("The structured review report could not be read.");
  expect(app.shows("0 findings")).toBe(false);
});

test("saved fix progress comes from the Review owner and only unfinished items can be started", async () => {
  const sessionId = "session-progress-source";
  const reportToolId = "saved-review-progress";
  const backend = createBackend({ sessions: [{
    sessionId, sessionName: "Review with fixes", workspaceId: "workspace-1",
    lastUpdated: 1763100000000, messageCount: 2, turnCount: 1, agentType: "CodeReview",
  } as never] });
  const base = backend.handlers["openbitfun.invoke"];
  const requests: Array<Record<string, unknown>> = [];
  let running = true;
  backend.handlers["openbitfun.invoke"] = payload => {
    const { action, request } = (payload ?? {}) as { action?: string; request?: Record<string, unknown> };
    if (action === "get_session_transcript_view" && request?.session_id === sessionId) {
      return { ok: true, value: {
        sessionId, mode: "full", cursor: null, hasEarlier: false,
        turns: [{ ...turn("", false), items: [{ kind: "tool", roundIndex: 0, tool: {
          id: reportToolId, name: "submit_code_review", status: "completed", success: true, startMs: 1,
          result: { summary: { overall_assessment: "Two findings need follow-up." }, issues: [] },
        } }] }],
      } };
    }
    if (action !== "launch_review_remediation" || !request) return base(payload);
    requests.push(request);
    if (request.approved) return { ok: true, value: {
      status: "started", childSessionId: "remaining-fix-child", childSessionName: "Review fixes",
    } };
    return { ok: true, value: { status: "prepared", plan: {
      reportRevision: "version-two",
      items: [
        { id: "must_fix:0", group: "must_fix", title: "Repair the write path", selectedByDefault: true },
        { id: "should_improve:0", group: "should_improve", title: "Cover the edge case", selectedByDefault: false },
      ],
    }, progress: {
      running,
      latestRun: { sessionId: "existing-fix-child", sessionName: "Existing fix", state: running ? "running" : "completed" },
      items: { "must_fix:0": "completed", "should_improve:0": running ? "in_progress" : "pending" },
    } } };
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "entry" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("entry", "Controller", [], { isClientDevice: true }),
      fleetDeviceRow("owner", "Owner", [{
        workspaceId: "workspace-1", name: "Reviewed workspace", rootPath: "/owner/repo", kind: "local",
        sessions: [{ ...fleetSessionRow("owner", "workspace-1", sessionId, "Review with fixes"), agentType: "CodeReview" }],
      }], { hostKind: "desktop", hostCapabilities: ["review_remediation_v1"], state: "online" }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSession(app, "Review with fixes", { deviceId: "owner" });
  await app.press("label:tool-card-submit_code_review");
  await app.press("label:review-select-fixes");
  await app.waitFor("Fix in progress");
  expect(app.texts()).toContain("Reported complete");
  expect(app.texts()).toContain("Fixing");
  expect(app.enabled("label:review-start-fixes")).toBe(false);
  expect(app.enabled("id:review-fix-item-must_fix:0")).toBe(false);

  running = false;
  await app.waitFor("Fix session finished");
  expect(app.texts()).toContain("Pending");
  expect(requests.every(request => !request.approved)).toBe(true);

  await app.press("Cancel");
  await app.press("label:review-select-fixes");
  await app.waitFor("Fix session finished");
  expect(app.shows("label:review-fix-open-session")).toBe(true);
  expect(app.enabled("id:review-fix-item-must_fix:0")).toBe(false);
  await app.press("label:review-start-fixes");
  await app.waitFor("Review fixes");
  const starts = requests.filter(request => request.approved);
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ workspaceId: "workspace-1", sessionId, reportToolId,
    approved: { reportRevision: "version-two", selection: [{ id: "should_improve:0" }] },
  });
  expect(host.fleetCalls.filter(call => call.command === "launch_review_remediation").every(call => call.target === "owner")).toBe(true);
  expect(host.pageHostCalls).toHaveLength(0);
});

for (const workspaceFallback of [false, true]) {
  test(workspaceFallback
    ? "post-fix review confirms the workspace fallback and reopens a saved revision on its owner"
    : "post-fix review starts the exact strict scope and reopens a saved revision on its owner", async () => {
    const sessionId = "post-fix-source";
    const reportToolId = "post-fix-report";
    const fixerId = "completed-fixer";
    const childId = "existing-post-fix-review";
    const backend = createBackend({ sessions: [{
      sessionId, sessionName: "Original strict review", workspaceId: "workspace-1",
      lastUpdated: 1763100000000, messageCount: 2, turnCount: 1, agentType: "DeepReview",
    } as never] });
    const base = backend.handlers["openbitfun.invoke"];
    const requests: Array<Record<string, unknown>> = [];
    let launched = false;
    backend.handlers["openbitfun.invoke"] = payload => {
      const { action, request } = (payload ?? {}) as { action?: string; request?: Record<string, unknown> };
      if (action === "get_session_transcript_view" && request?.session_id === sessionId) {
        return { ok: true, value: {
          sessionId, mode: "full", cursor: null, hasEarlier: false,
          turns: [{ ...turn("", false), items: [{ kind: "tool", roundIndex: 0, tool: {
            id: reportToolId, name: "submit_code_review", status: "completed", success: true, startMs: 1,
            result: { summary: { overall_assessment: "One finding needs review after repair." }, issues: [] },
          } }] }],
        } };
      }
      if (action !== "launch_review_remediation" || !request) return base(payload);
      const followUp = request.reviewFixes as Record<string, unknown> | undefined;
      if (followUp) {
        requests.push(request);
        if (followUp.scopeFingerprint) {
          launched = true;
          return { ok: false, error: "The reply was lost after launch" };
        }
        return { ok: true, value: { status: "review", workspaceFallback, scopeFingerprint: "current-scope",
          review: { status: "prepared", intent: "strict", fileCount: 3 },
        } };
      }
      return { ok: true, value: {
        status: "prepared",
        plan: { reportRevision: "report-version", items: [
          { id: "must_fix:0", group: "must_fix", title: "Repair the case", selectedByDefault: true },
        ] },
        progress: { running: false, items: { "must_fix:0": "completed" },
          latestRun: { sessionId: fixerId, sessionName: "Applied fix", state: "completed" } },
        postFixReview: launched
          ? { existing: { sessionId: childId, sessionName: "Saved follow-up", agentType: "DeepReview", phase: "completed" } }
          : { selection: { fixSessionId: fixerId, previousReviewSessionId: sessionId } },
      } };
    };
    const host = fleetObpHost(backend, {
      fleet: { protocol: 1, cursorState: {}, deviceId: "entry" },
      navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
        fleetDeviceRow("entry", "Controller", [], { isClientDevice: true }),
        fleetDeviceRow("review-owner", "Owner", [{
          workspaceId: "workspace-1", name: "Reviewed workspace", rootPath: "/owner/repo", kind: "local",
          sessions: [{ ...fleetSessionRow("review-owner", "workspace-1", sessionId, "Original strict review"), agentType: "DeepReview" }],
        }], { hostKind: "desktop", hostCapabilities: ["review_remediation_v1"], state: "online" }),
      ] },
    });
    const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
    await openSession(app, "Original strict review", { deviceId: "review-owner" });
    await app.press("label:tool-card-submit_code_review");
    await app.press("label:review-select-fixes");
    await app.waitFor("Fix session finished");
    expect(requests).toHaveLength(0);

    await app.press("label:review-start-follow-up");
    if (workspaceFallback) {
      await app.waitFor("The fix session did not identify every changed file. This review will cover the current workspace diff.");
      expect(app.texts()).toContain("3 files");
      expect(launched).toBe(false);
      expect(requests).toHaveLength(1);
      await app.press("label:review-confirm-follow-up");
    }
    await app.waitFor("The reply was lost after launch");
    expect(requests[0]).toMatchObject({ workspaceId: "workspace-1", sessionId, reportToolId, reviewFixes: {
      fixSessionId: fixerId, previousReviewSessionId: sessionId, reportRevision: "report-version",
    } });
    expect((requests[1].reviewFixes as Record<string, unknown>).scopeFingerprint).toBe("current-scope");

    await app.press("Cancel");
    await app.press("label:review-select-fixes");
    await app.waitFor("Open follow-up review");
    expect(app.shows("label:review-start-follow-up")).toBe(false);
    await app.press("label:review-open-follow-up");
    await app.waitFor("Saved follow-up");
    expect(requests).toHaveLength(2);
    expect(host.fleetCalls.filter(call => call.command === "launch_review_remediation").every(call => call.target === "review-owner")).toBe(true);
    expect(host.pageHostCalls).toHaveLength(0);
  });
}

test("fixes require explicit selections and retry on the runtime that owns the Review", async () => {
  const backend = createBackend({ sessions: [{
    sessionId: "session-fix-source", sessionName: "Fixable review", workspaceId: "workspace-1",
    lastUpdated: 1763100000000, messageCount: 2, turnCount: 1, agentType: "CodeReview",
  } as never] });
  const base = backend.handlers["openbitfun.invoke"];
  const requests: Array<Record<string, unknown>> = [];
  let rejectStart = true;
  backend.handlers["openbitfun.invoke"] = (payload: unknown) => {
    const args = (payload ?? {}) as { action?: string; request?: Record<string, unknown> };
    if (args.action === "get_session_transcript_view" && args.request?.session_id === "session-fix-source") {
      return { ok: true, transport: "dev", value: {
        sessionId: "session-fix-source", mode: "full", cursor: null, hasEarlier: false,
        turns: [{ ...turn("", false), items: [{ kind: "tool", roundIndex: 0, tool: {
          id: "saved-review-tool", name: "submit_code_review", status: "completed", success: true, startMs: 1,
          result: { summary: { overall_assessment: "The write path needs a correction." }, issues: [] },
        } }] }],
      } };
    }
    if (args.action !== "launch_review_remediation" || !args.request) return base(payload);
    requests.push(args.request);
    if (!args.request.approved) return { ok: true, transport: "dev", value: { status: "prepared", plan: {
      reportRevision: "saved-version",
      items: [
        { id: "must_fix:0", group: "must_fix", title: "Fix the write path", selectedByDefault: true },
        { id: "should_improve:0", group: "should_improve", title: "Add telemetry", selectedByDefault: false },
        { id: "needs_decision:0", group: "needs_decision", title: "Choose a format",
          choices: ["Keep JSON", "Use SQLite"], selectedByDefault: false },
      ],
    } } };
    if (rejectStart) {
      rejectStart = false;
      return { ok: false, transport: "dev", error: "Reply lost before acknowledgement" };
    }
    return { ok: true, transport: "dev", value: {
      status: "started", childSessionId: "review-fix-child", childSessionName: "Review fixes",
    } };
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "entry" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("entry", "Controller entry", [], { isClientDevice: true }),
      fleetDeviceRow("review-owner", "Review owner", [{
        workspaceId: "workspace-1", name: "Reviewed workspace", rootPath: "/owner/repo", kind: "local",
        sessions: [{ ...fleetSessionRow("review-owner", "workspace-1", "session-fix-source", "Fixable review"),
          agentType: "CodeReview" }],
      }], { hostKind: "desktop", hostCapabilities: ["review_remediation_v1"], state: "online" }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSession(app, "Fixable review", { deviceId: "review-owner" });
  await app.press("label:tool-card-submit_code_review");
  await app.press("label:review-select-fixes");
  await app.waitFor("Fix the write path");
  expect(requests).toEqual([{
    workspaceId: "workspace-1", sessionId: "session-fix-source", reportToolId: "saved-review-tool",
  }]);
  await app.press("id:review-fix-item-needs_decision:0");
  await app.waitFor("Choose an option for each selected decision");
  expect(requests).toHaveLength(1);
  await app.press("label:review-fix-decision-needs_decision:0");
  await app.press("label:Use SQLite");
  await app.type("label:review-fix-instructions", "Run the write-path test.");
  await app.press("label:review-start-fixes");
  await app.waitFor("Reply lost before acknowledgement");
  expect(requests[1]).toMatchObject({
    ...requests[0], approved: { reportRevision: "saved-version",
      selection: [{ id: "must_fix:0" }, { id: "needs_decision:0", choice: 1 }],
      instructions: "Run the write-path test.",
    },
  });
  await app.press("label:review-start-fixes");
  await app.waitFor("Review fixes");
  expect(requests[2]).toEqual(requests[1]);
  const launches = host.fleetCalls.filter(call => call.command === "launch_review_remediation");
  expect(launches.map(call => call.target)).toEqual(["review-owner", "review-owner", "review-owner"]);
  expect(host.pageHostCalls).toHaveLength(0);
  expect(backend.actions()).not.toContain("submit_user_message");
});
