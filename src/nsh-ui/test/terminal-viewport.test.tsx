import { expect, open, test } from "nsh/test";
import { createLightTerminalOutput } from "../src/ui/terminalLightColors";
import { createBackend, openSession } from "./support";

test("the right terminal header leaves room for Windows caption controls", async () => {
  const backend = createBackend();
  const app = await open("./fixtures/windowsCaptionApp.tsx", {
    platform: "windows", width: 1440, height: 900, host: { handlers: backend.handlers },
  });
  await openSession(app, "NSH skeleton");
  await app.press("session-tool-terminal");
  await app.waitFor("aux-split-handle-right");
  const rightEdge = () => {
    const close = app.layout("aux-close")!;
    return close.x + close.width;
  };
  expect(rightEdge()).toBeLessThanOrEqual(1440 - 160);

  await app.press("aux-dock-toggle");
  await app.waitFor("aux-split-handle-bottom");
  expect(rightEdge()).toBeGreaterThan(1440 - 160);
  await app.press("aux-dock-toggle");
  await app.waitFor("aux-split-handle-right");
  expect(rightEdge()).toBeLessThanOrEqual(1440 - 160);
});

test("light terminals darken PowerShell foregrounds across output chunks", () => {
  const project = createLightTerminalOutput();
  expect(project("PS> \x1b[9")).toBe("PS> ");
  expect(project("3mWrite-Output")).toBe("\x1b[93m\x1b[38;5;94mWrite-Output");
  expect(project("\x1b[97m42\x1b[0m")).toBe("\x1b[97m\x1b[38;5;236m42\x1b[0m");
  expect(project("\x1b[38;5;7marg")).toBe("\x1b[38;5;7m\x1b[38;5;240marg");
  expect(project("\x1b[44mstatus")).toBe("\x1b[44m\x1b[38;5;7mstatus");
  expect(project("\x1b[49mplain")).toBe("\x1b[49m\x1b[38;5;240mplain");
});

test("terminal color projection preserves explicit RGB, inverse and control strings", () => {
  const project = createLightTerminalOutput();
  expect(project("\x1b]2;A\x1b[93m title\x1b")).toBe("\x1b]2;A\x1b[93m title");
  expect(project("\\\x1b[38;2;93;97;37mRGB")).toBe("\x1b\\\x1b[38;2;93;97;37mRGB");
  expect(project("\x1b[7;97mSelected")).toBe("\x1b[7;97mSelected");
  expect(project("\x1b[27mPlain")).toBe("\x1b[27m\x1b[38;5;236mPlain");
  expect(project("\x1b[39m\x1b[2K\x1b[2;1H")).toBe("\x1b[39m\x1b[2K\x1b[2;1H");
});

test("a new terminal keeps the whole first prompt visible", async () => {
  const app = await open("./fixtures/terminalScene.tsx", { platform: "windows", width: 800, height: 850 });
  async function checkFirstRow(prompt: string) {
    await app.waitFor(prompt);
    expect(app.layout(prompt)?.clipped).toBe(false);
    await app.drag(prompt, { y: 80 });
    await app.drag(prompt, { y: -80 });
    expect(app.layout(prompt)?.clipped).toBe(false);
  }
  await checkFirstRow("terminal-1 %");
  await app.press("New shell");
  await checkFirstRow("terminal-2 %");
});
