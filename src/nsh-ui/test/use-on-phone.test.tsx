// Devices › Use on phone or in a browser: the panel points at the web
// controller (address and its QR only). Nothing is paired and no network value
// is shown; the retired EasyTier-app route and the mesh pairing QR are gone.

import { expect, open, test } from "nsh/test";
import { createDeviceBackend, withMeshDevices, withPhoneFixtures } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };

test("the web controller address and its QR, no join values or pairing", async () => {
  const { backend, phoneCalls } = withPhoneFixtures(createDeviceBackend());
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  // Settings › Account › Devices and chat apps › Open on your phone.
  await app.press("Settings");
  await app.press("Devices and chat apps");
  await app.press("label:account-open-on-phone");
  await app.waitFor("label:use-on-phone");
  await app.waitFor("label:phone-qr");
  await app.waitFor("text:https://super.openbitfun.com/");
  await app.waitFor("text:Scan with your phone, or open super.openbitfun.com");
  await app.waitFor("text:End-to-end encrypted to this computer");
  expect(app.shows("label:phone-controllers")).toBe(false);
  // No EasyTier steps, network values or pairing offer any more.
  expect(app.shows("text:obf-0123456789abcdef")).toBe(false);
  expect(app.shows("label:phone-secret-toggle")).toBe(false);
  expect(app.shows("label:phone-pair-mesh")).toBe(false);
  expect(app.shows("label:phone-route-lan")).toBe(false);
  expect(phoneCalls.some(call => call.command === "mesh_phone_join_info")).toBe(false);
  expect(phoneCalls.some(call => call.command === "obp_create_pairing")).toBe(false);

  await app.press("label:phone-copy-url");
  await app.waitUntil(() => app.clipboard() === "https://super.openbitfun.com/");
  await app.press("label:phone-open-url");
  await app.waitUntil(() => app.openedUrls().includes("https://super.openbitfun.com/"));

  // At phone width the same sheet keeps the QR, the address and its two actions.
  await app.setViewport(390, 844);
  await app.waitFor("label:phone-qr");
  expect(app.shows("label:phone-copy-url")).toBe(true);
  expect(app.shows("label:phone-open-url")).toBe(true);
});

test("the open-on-phone sheet omits signed-in controller status rows", async () => {
  const { backend } = withPhoneFixtures(createDeviceBackend());
  withMeshDevices(backend, [
    { deviceId: "phone-1", name: "Alice's iPhone", role: "controller", reachable: false, path: "relayed", route: "relayed_server", hops: 2, capabilities: [] },
    { deviceId: "obf-gateway-lwb", name: null, role: "controller", reachable: false, path: "relayed", hops: 2, capabilities: [] },
    { deviceId: "desk-2", name: "Studio Mac", role: "device", reachable: true, path: "p2p", route: "direct_lan", hops: 1, capabilities: ["obp_v1", "mesh_v1"] },
  ]);
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await app.press("Settings");
  await app.press("Devices and chat apps");
  await app.press("label:account-open-on-phone");
  await app.waitFor("label:use-on-phone");
  expect(app.shows("label:phone-controllers")).toBe(false);
  expect(app.shows("label:phone-controller-phone-1")).toBe(false);
  expect(app.shows("text:Signed in now:")).toBe(false);
});
