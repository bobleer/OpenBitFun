// The one line that says how OpenBitFun Link reaches a device or a signed-in
// phone (`meshPath.ts`).

import { expect, test } from "nsh/test";
import { meshPathLabel, type MeshPathFacts } from "../src/meshPath";

test("path label: one short line per mesh route", () => {
  const names: Record<string, string> = { "device-mac": "Studio" };
  const label = (entry: Partial<MeshPathFacts>) =>
    meshPathLabel({ reachable: true, ...entry }, id => names[id] ?? null);
  expect(label({ route: "direct_lan" })).toBe("Direct · same network");
  expect(label({ route: "direct_ipv6" })).toBe("Direct · IPv6");
  expect(label({ route: "direct_ipv4" })).toBe("Direct");
  expect(label({ route: "relayed_peer", relayVia: "device-mac" })).toBe("Relayed via Studio");
  expect(label({ route: "relayed_peer", relayVia: "device-unknown" })).toBe("Relayed via another device");
  expect(label({ route: "relayed_peer" })).toBe("Relayed via another device");
  expect(label({ route: "relayed_server" })).toBe("Relayed via OpenBitFun server");
  // Latency is a short suffix on the same line.
  expect(label({ route: "direct_lan", latencyMs: 0.3 })).toBe("Direct · same network · 1 ms");
  expect(label({ route: "direct_ipv4", latencyMs: 12.4 })).toBe("Direct · 12 ms");
  // Nothing to say: no route, unknown route, or a device the mesh cannot reach.
  expect(label({})).toBe("");
  expect(label({ route: "satellite" })).toBe("");
  expect(meshPathLabel({ reachable: false, route: "direct_lan" })).toBe("");
});
