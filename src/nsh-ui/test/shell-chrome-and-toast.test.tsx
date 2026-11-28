// Bottom-left Settings button toggle/borderless behavior and unified
// bottom-left 6-second auto-dismissing ToastHost.
import { expect, open, test } from "nsh/test";
import { createBackend, fleetDeviceRow, fleetObpHost, openSession } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const PHONE = { width: 375, height: 812, platform: "macos" as const };

test("ToastHost appears at the bottom-left on desktop and auto-dismisses after 6s", async () => {
  const app = await open("./fixtures/toastFixture.tsx", { ...DESKTOP, clock: {} });

  await app.press("label:push-success");
  await app.waitFor("text:Saved settings");
  const pos = app.layout("text:Saved settings");
  expect(pos).not.toBeNull();
  expect(pos!.x).toBeLessThan(DESKTOP.width / 3);
  expect(pos!.y).toBeGreaterThan(DESKTOP.height / 2);

  // Still visible just before 6s, then auto-dismisses once 6s elapses.
  await app.wait(5500);
  expect(app.shows("text:Saved settings")).toBe(true);
  await app.wait(1000);
  expect(app.shows("text:Saved settings")).toBe(false);

  // Error toasts use the same unified 6s auto-dismiss timer.
  await app.press("label:push-error");
  await app.waitFor("text:Action failed");
  await app.wait(5500);
  expect(app.shows("text:Action failed")).toBe(true);
  await app.wait(1000);
  expect(app.shows("text:Action failed")).toBe(false);
});

test("ToastHost stays anchored at the bottom-left on compact viewports too", async () => {
  const app = await open("./fixtures/toastFixture.tsx", { ...PHONE, clock: {} });

  await app.press("label:push-success");
  await app.waitFor("text:Saved settings");
  const pos = app.layout("text:Saved settings");
  expect(pos).not.toBeNull();
  expect(pos!.x).toBeLessThan(PHONE.width / 3);
  expect(pos!.y).toBeGreaterThan(PHONE.height / 2);
});

test("bottom-left Settings button highlights without a border and toggles Settings closed on second press", async () => {
  const host = fleetObpHost(createBackend(), {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1,
      full: true,
      devices: [fleetDeviceRow("dev-a", "MacBook", [], { hostKind: "desktop" })],
      removedDeviceIds: [],
      totals: { running: 0, waiting: 0, unread: 0 },
    },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await app.waitFor("Settings");

  // First click enters Settings; the button highlights with an active background and selected state.
  await app.press("Settings");
  await app.waitFor("Interface language");
  expect(app.accessibility("Settings")?.selected).toBe(true);
  expect(app.viewStyle("Settings")?.backgroundColor).toBeDefined();

  // Second click exits Settings back to the prior scene.
  await app.press("Settings");
  await app.waitUntil(() => !app.shows("Interface language"));
  expect(app.accessibility("Settings")?.selected).toBe(false);
});

test("Windows canvas aligns flush with the frame and avoids fractured top bars across Settings, Library, and Sessions", async () => {
  const backend = createBackend();
  const app = await open("./fixtures/windowsCaptionApp.tsx", {
    platform: "windows",
    width: 1440,
    height: 900,
    host: { handlers: backend.handlers },
  });

  // Sessions: flush canvas, header shares the top row with Windows caption controls and shows the divider.
  await app.waitFor("nav-library");
  await app.waitFor("id:session-header");
  const sessionCanvas = app.layout("id:shell-canvas")!;
  expect(sessionCanvas.y).toBe(0);
  expect(sessionCanvas.x + sessionCanvas.width).toBe(1440);
  expect(sessionCanvas.height).toBe(900);
  expect(app.layout("id:session-header")!.y).toBe(0);
  expect(app.shows("id:scene-top-bar")).toBe(false);
  expect(app.shows("id:window-caption-divider")).toBe(true);

  // Settings: no blank white top bar above the grey settings rail; right column alone reserves the 44 px caption drag strip.
  await app.press("Settings");
  await app.waitFor("nav-settings-page-general");
  expect(app.shows("id:scene-top-bar")).toBe(false);
  expect(app.shows("id:window-caption-divider")).toBe(false);
  const rail = app.layout("settings-scope-list")!;
  expect(rail.y).toBe(0);
  expect(rail.height).toBe(900);
  const dragStrip = app.layout("id:settings-caption-drag-strip")!;
  expect(dragStrip.y).toBe(0);
  expect(dragStrip.height).toBe(44);
  expect(dragStrip.x).toBeGreaterThanOrEqual(rail.x + rail.width);
  const title = app.layout("id:settings-page-title")!;
  expect(title.y).toBeGreaterThanOrEqual(44);
  expect(title.y).toBeLessThan(64);

  // Collapsing the sidebar on Windows fills from x = 0 (no 8 px left gutter), shows SceneTopBar without doubling the drag strip.
  await app.press("toggle-drawer");
  await app.waitFor("id:scene-top-bar");
  const collapsedCanvas = app.layout("id:shell-canvas")!;
  expect(collapsedCanvas.x).toBe(0);
  expect(collapsedCanvas.y).toBe(0);
  expect(collapsedCanvas.width).toBe(1440);
  expect(collapsedCanvas.height).toBe(900);
  expect(app.shows("id:settings-caption-drag-strip")).toBe(false);
  expect(app.shows("id:window-caption-divider")).toBe(false);

  // Restore sidebar and check Library at narrow desktop width (960 px): scope chip stays clear below the 44 px caption strip.
  await app.press("toggle-drawer");
  await app.waitFor("nav-library");
  await app.press("nav-library");
  await app.waitFor("library-scope-chip");
  await app.setViewport(960, 800);
  expect(app.shows("id:scene-top-bar")).toBe(false);
  expect(app.shows("id:window-caption-divider")).toBe(false);
  const libraryStrip = app.layout("id:library-caption-drag-strip")!;
  expect(libraryStrip.y).toBe(0);
  expect(libraryStrip.height).toBe(44);
  expect(app.layout("library-scope-chip")!.y).toBeGreaterThanOrEqual(44);

  // Docking AuxPane on the right while in Settings transfers caption ownership to AuxPane without a redundant Settings drag strip.
  await app.setViewport(1440, 900);
  await openSession(app, "NSH skeleton");
  await app.waitFor("id:session-header");
  await app.press("session-tool-files");
  await app.waitFor("id:aux-pane-header");
  await app.press("Settings");
  await app.waitFor("nav-settings-page-general");
  expect(app.layout("id:aux-pane-header")!.y).toBe(0);
  expect(app.shows("id:window-caption-divider")).toBe(true);
  expect(app.shows("id:settings-caption-drag-strip")).toBe(false);
  expect(app.layout("settings-scope-list")!.y).toBe(0);
});

test("macOS preserves its floating inset canvas without Windows caption drag strips", async () => {
  const backend = createBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await app.waitFor("Settings");
  await app.press("Settings");
  await app.waitFor("nav-settings-page-general");
  const canvas = app.layout("id:shell-canvas")!;
  expect(canvas.y).toBe(8);
  expect(canvas.height).toBe(900 - 16);
  expect(app.shows("id:settings-caption-drag-strip")).toBe(false);
  expect(app.shows("id:window-caption-divider")).toBe(false);
});
