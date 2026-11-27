import { expect, open, test } from "nsh/test";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, openSession } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };

test("composer drafts move with text and attachments through swap, close and reopen", async () => {
  const backend = createBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.type("composer", "First session draft");
  await app.paste("composer", { uris: ["file:///tmp/first.png", "file:///tmp/first.txt"] });
  await app.waitFor("file-attachment-first.txt");
  await app.waitFor("attachment-preview-attachment-drop-1");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("secondary-composer");
  expect(app.value("secondary-composer")).toBe("");
  await app.type("secondary-composer", "Second session draft");
  await app.paste("secondary-composer", { uris: ["file:///tmp/second.txt"] });
  await app.waitFor("secondary-file-attachment-second.txt");

  await app.hover("id:split-divider-proximity-left");
  await app.press("split-divider-swap");
  expect(app.value("composer")).toBe("Second session draft");
  expect(app.value("secondary-composer")).toBe("First session draft");
  await app.waitFor("file-attachment-second.txt");
  await app.waitFor("secondary-file-attachment-first.txt");
  await app.waitFor("secondary-attachment-preview-attachment-drop-1");
  expect(app.shows("secondary-file-attachment-second.txt")).toBe(false);

  await app.press("thread-actions-trigger");
  await app.press("session-split-close");
  expect(app.shows("secondary-composer")).toBe(false);
  await openSession(app, "NSH skeleton");
  expect(app.value("composer")).toBe("First session draft");
  await app.waitFor("file-attachment-first.txt");
  await app.waitFor("attachment-preview-attachment-drop-1");
  expect(app.shows("file-attachment-second.txt")).toBe(false);
});

test("a late send refusal restores its original draft once, without replacing newer edits", async () => {
  const backend = createBackend();
  const invoke = backend.handlers["openbitfun.invoke"];
  const respond: Array<(reply: unknown) => void> = [];
  backend.handlers["openbitfun.invoke"] = data => {
    if ((data as { action?: string }).action === "submit_user_message") {
      return new Promise(resolve => respond.push(resolve));
    }
    return invoke(data);
  };
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSession(app, "NSH skeleton");
  await app.type("composer", "Original text");
  await app.paste("composer", { uris: ["file:///tmp/original.txt"] });
  await app.waitFor("file-attachment-original.txt");
  const firstSend = app.press("Send");
  await app.waitUntil(() => respond.length === 1 && app.value("composer") === "");
  await openSession(app, "Terminal migration");
  await app.type("composer", "Other session draft");
  respond[0]!({ ok: false, error: "The original runtime refused the message." });
  await firstSend;
  expect(app.value("composer")).toBe("Other session draft");
  expect(app.shows("file-attachment-original.txt")).toBe(false);
  await openSession(app, "NSH skeleton");
  expect(app.value("composer")).toBe("Original text");
  await app.waitFor("file-attachment-original.txt");

  const retry = app.press("Send");
  await app.waitUntil(() => respond.length === 2 && app.value("composer") === "");
  await app.type("composer", "Newer draft after the retry");
  respond[1]!({ ok: false, error: "The retry was refused." });
  await retry;
  expect(app.value("composer")).toBe("Newer draft after the retry");
  expect(app.shows("file-attachment-original.txt")).toBe(false);
});

test("a delayed long paste stays with its fleet device and workspace when split sessions share an id", async () => {
  const backend = createBackend();
  const invoke = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = payload => {
    const action = (payload as { action?: string }).action;
    if (action === "create_directory" || action === "write_file_content") return { ok: true, value: null };
    return invoke(payload);
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], devices: [
      fleetDeviceRow("dev-a", "Entry", [{ workspaceId: "ws-a", name: "Entry project", rootPath: "/entry",
        sessions: [fleetSessionRow("dev-a", "ws-a", "shared-id", "Entry session")] }], { isClientDevice: true }),
      fleetDeviceRow("dev-b", "Owner", [{ workspaceId: "ws-b", name: "Owner project", rootPath: "/srv/owner",
        sessions: [fleetSessionRow("dev-b", "ws-b", "shared-id", "Owner session")] }]),
    ] },
  });
  const send = host.handlers["openbitfun.obpSend"];
  let heldWrite: unknown;
  host.handlers["openbitfun.obpSend"] = (data: unknown) => {
    const reply = send!(data);
    const frame = JSON.parse((data as { frame: string }).frame);
    const command = frame.params?.args?.request?.command;
    if (command === "write_file_content") {
      heldWrite = reply;
      return [];
    }
    return reply;
  };
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, platform: "web", host: { handlers: host.handlers } });
  await app.press("label:Entry session");
  await app.type("composer", "Entry draft");
  await app.press("thread-actions-trigger");
  await app.press("session-split-open");
  await app.waitFor("id:secondary-session-pane");
  await app.press("label:Owner session");
  await app.type("secondary-composer", "Owner draft");
  const longText = "paste from owner\n".repeat(80);
  const pending = app.paste("secondary-composer", { text: longText });
  await app.waitUntil(() => heldWrite !== undefined);
  const writes = host.fleetCalls.filter(call => ["create_directory", "write_file_content"].includes(call.command));
  expect(writes.map(call => call.target)).toEqual(["dev-b", "dev-b"]);
  expect(writes[1]?.args).toMatchObject({ request: { workspaceId: "ws-b", workspacePath: "/srv/owner", content: longText } });
  await app.hover("id:split-divider-proximity-left");
  await app.press("split-divider-swap");
  await app.host.send("openbitfun.obpFrames", heldWrite);
  await pending;
  expect(app.value("composer")).toBe("Owner draft");
  expect(app.value("secondary-composer")).toBe("Entry draft");
  const path = (writes[1]!.args.request as { filePath: string }).filePath;
  const name = path.split("/").at(-1)!;
  await app.waitFor(`file-attachment-${name}`);
  expect(app.shows(`secondary-file-attachment-${name}`)).toBe(false);
});
