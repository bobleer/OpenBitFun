import { expect, open, test } from "nsh/test";
import { enUSMessages } from "../src/locales/en-US";
import { createMiniAppMarketBackend, fleetDeviceRow, fleetObpHost } from "./support";

const DESKTOP = { width: 1440, height: 900, platform: "macos" as const };
const ORIGIN_STANDUP = {
  "app-standup": { listingId: "lst-standup", releaseId: "lst-standup-r3", releaseNumber: 3, packageSha256: "sha-lst-standup-3" },
};
const FIRST_SCREENSHOT = "a".repeat(64);
const SECOND_SCREENSHOT = "b".repeat(64);
const PREVIEW_WEBP = "UklGRkIAAABXRUJQVlA4IDYAAAAQAwCdASogABIAPm00lkekIyIhKAgAgA2JZQB2AACKtrAA/vCwN//JHeezEL//wG6+LZfAAAA=";

function withMarketMedia(backend: ReturnType<typeof createMiniAppMarketBackend>, failSecondOnce = false) {
  const i18n = { locales: { "en-US": {
    name: "Standup Planner", description: "Plan your team's standup.", tags: ["Team updates"],
  } } };
  const invoke = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const { action, request } = data as { action: string; request: Record<string, unknown> };
    if (action === "miniapp_market_read_screenshot") {
      backend.calls.push({ action, request, raw: false });
      if (request.sha256 === SECOND_SCREENSHOT && failSecondOnce) {
        failSecondOnce = false;
        return { ok: false, error: "The image temporarily failed to load." };
      }
      return { ok: true, value: PREVIEW_WEBP };
    }
    const reply = invoke(data) as { ok: boolean; value: Record<string, unknown> };
    if (reply.ok && action === "miniapp_market_browse") {
      const items = reply.value.items as Array<Record<string, unknown>>;
      return { ...reply, value: { ...reply.value, items: items.map(item =>
        item.slug === "standup-board" ? { ...item, i18n } : item) } };
    }
    if (reply.ok && action === "miniapp_market_get_listing") {
      const screenshotUrl = (hash: string) => `https://market.example.test/miniapp/api/v1/screenshots/${hash}`;
      return { ...reply, value: {
        ...reply.value,
        ...(reply.value.slug === "standup-board" ? { i18n } : {}),
        screenshotUrls: [screenshotUrl(FIRST_SCREENSHOT), screenshotUrl(FIRST_SCREENSHOT),
          "file:///not-a-market-screenshot.webp", screenshotUrl(SECOND_SCREENSHOT)],
      } };
    }
    return reply;
  };
  return backend;
}

function marketCalls(backend: ReturnType<typeof createMiniAppMarketBackend>, action: string) {
  return backend.calls.filter(call => call.action === action);
}

async function manageFromApps(app: Awaited<ReturnType<typeof open>>, appId: string) {
  await app.waitFor("Most downloaded");
  await app.press(`label:space-more-${appId}`);
  await app.press(`label:space-menu-manage-${appId}`);
  await app.waitFor("label:space-installed-details");
}

/** Spaces is a Library tab (visual spec §4.8): open the Library, then the tab. */
async function openSpaces(app: Awaited<ReturnType<typeof open>>): Promise<void> {
  await app.waitUntil(() => app.shows("toggle-drawer") || app.shows("nav-library") || app.shows("phone-tab-library"));
  // A medium window keeps the sidebar as an overlay drawer: open it first.
  if (!app.shows("nav-library") && !app.shows("phone-tab-library")) await app.press("toggle-drawer");
  if (!app.shows("library-tab-spaces")) await app.press(app.shows("nav-library") ? "nav-library" : "phone-tab-library");
  await app.press("library-tab-spaces");
}

async function openMarket(backend: ReturnType<typeof createMiniAppMarketBackend>) {
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSpaces(app);
  await app.waitFor("label:spaces-view-market");
  await app.press("label:spaces-view-market");
  return app;
}

test("market: browses the host catalogue, filters, pages and marks installed listings", async () => {
  const backend = createMiniAppMarketBackend({}, { origins: ORIGIN_STANDUP, secondPage: true });
  const app = await openMarket(backend);

  await app.waitFor("Standup Board");
  expect(app.texts()).toContain("Weather Glance");
  const first = marketCalls(backend, "miniapp_market_browse").find(call =>
    !(call.request as { listingIds?: string[] }).listingIds);
  expect(first?.raw).toBe(false);
  expect(first?.request).toMatchObject({ query: "", category: "all", sort: "newest", cursor: null, limit: 20 });
  // The installed origins come from the host, read without a request struct.
  const originsCall = marketCalls(backend, "miniapp_market_installed_origins")[0];
  expect(originsCall.raw).toBe(true);
  await app.waitFor("label:market-installed-standup-board");
  expect(app.shows("label:market-installed-weather-glance")).toBe(false);
  // The host's numbers, one quiet line.
  expect(app.texts().some(text => text.includes("1,280 downloads") && text.includes("42 favorites"))).toBe(true);

  // Load more follows the host's cursor and appends.
  await app.press("label:market-load-more");
  await app.waitFor("Later Space");
  expect(marketCalls(backend, "miniapp_market_browse").at(-1)?.request).toMatchObject({ cursor: "page-2" });

  // Typing re-reads with the query after the debounce.
  await app.type("label:market-search", "weather");
  await app.waitUntil(() =>
    marketCalls(backend, "miniapp_market_browse").some(
      call => (call.request as Record<string, unknown>).query === "weather",
    ),
  );
  await app.waitUntil(() => !app.texts().includes("Standup Board"));
  expect(app.texts()).toContain("Weather Glance");

  // Category and sort are host parameters too.
  await app.clear("label:market-search");
  await app.press("label:market-category");
  await app.press("label:market-category-utilities");
  await app.waitUntil(() =>
    marketCalls(backend, "miniapp_market_browse").some(
      call => (call.request as Record<string, unknown>).category === "utilities",
    ),
  );
  await app.press("label:market-sort");
  await app.press("Top rated");
  await app.waitUntil(() =>
    marketCalls(backend, "miniapp_market_browse").some(
      call => (call.request as Record<string, unknown>).sort === "rating",
    ),
  );
});

test("apps: installed listing summaries drive rankings, update badges, and detail navigation", async () => {
  const backend = withMarketMedia(createMiniAppMarketBackend({}, { origins: {
    ...ORIGIN_STANDUP,
    "app-weather": { listingId: "lst-weather", releaseId: "lst-weather-r1", releaseNumber: 1, packageSha256: "sha-lst-weather-1" },
  } }));
  const invoke = backend.handlers["openbitfun.invoke"];
  let invalidPage = true;
  backend.handlers["openbitfun.invoke"] = data => {
    const { action, request } = data as { action: string; request?: { listingIds?: string[] } };
    if (action === "list_miniapps") {
      const reply = invoke(data) as { ok: boolean; value: Array<Record<string, unknown>> };
      return { ...reply, value: [...reply.value, {
        id: "personal-notes", name: "Personal Notes", category: "utilities", created_at: 1_800_000_000_000,
      }] };
    }
    if (action === "miniapp_market_browse" && request?.listingIds) {
      const reply = invoke(data) as { ok: boolean; value: { items: Array<Record<string, unknown>> } };
      if (invalidPage) {
        invalidPage = false;
        return { ...reply, value: { items: [{ ...reply.value.items[0], listingId: "unrelated" }] } };
      }
      return { ...reply, value: { ...reply.value, items: reply.value.items.map(item =>
        item.listingId === "lst-weather" ? { ...item, ratingAverage: 4.9 } : item) } };
    }
    return invoke(data);
  };

  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSpaces(app);
  const cardOrder = () => app.texts().filter(text => ["Standup Board", "Weather Glance", "Personal Notes"].includes(text));
  await app.waitFor("Marketplace rankings are unavailable. Apps are sorted by newest.");
  expect(cardOrder()).toEqual(["Personal Notes", "Standup Board", "Weather Glance"]);
  expect(app.shows("label:space-update-app-standup")).toBe(false);
  await app.press("Retry");
  await app.waitFor("label:space-update-app-standup");
  expect(app.shows("label:space-update-app-weather")).toBe(false);
  expect(app.texts()).toContain("Most downloaded");
  expect(cardOrder()).toEqual(["Standup Board", "Weather Glance", "Personal Notes"]);

  await app.press("label:spaces-sort");
  await app.press("Top rated");
  await app.waitUntil(() => cardOrder().join(",") === "Weather Glance,Standup Board,Personal Notes");
  await app.press("label:spaces-sort");
  await app.press("Newest");
  await app.waitUntil(() => cardOrder().join(",") === "Personal Notes,Standup Board,Weather Glance");

  await app.type("label:spaces-search", "Team updates");
  await app.waitUntil(() => cardOrder().join(",") === "Standup Board");
  await app.press("id:space-details-app-standup");
  await app.waitFor("label:market-install");
  expect(app.texts()).toContain("Standup Planner");
  expect(app.texts()).toContain("Update");
  expect(app.shows("label:spaces-search")).toBe(false);
  await app.press("label:market-manage");
  await app.waitFor("label:space-installed-details");
  expect(app.texts()).toContain("v3");
  await app.press("label:space-detail-back");
  await app.waitFor("label:market-listing");
  await app.press("label:market-close");
  await app.waitFor("id:space-details-app-standup");
  expect(app.value("label:spaces-search")).toBe("Team updates");
  expect(cardOrder()).toEqual(["Standup Board"]);
  expect(marketCalls(backend, "miniapp_market_get_listing").map(call => call.request))
    .toEqual([{ listingId: "lst-standup" }]);
  expect(marketCalls(backend, "miniapp_market_browse").map(call => call.request)).toEqual([
    { listingIds: ["lst-standup", "lst-weather"] },
    { listingIds: ["lst-standup", "lst-weather"] },
  ]);
});

test("apps: system launcher actions publish, refresh and remove only the OS entry", async () => {
  const backend = createMiniAppMarketBackend({}, { origins: ORIGIN_STANDUP });
  const invoke = backend.handlers["openbitfun.invoke"];
  const launcherPath = "C:/Apps/Standup Board.lnk";
  let installed = false;
  let failStatus = true;
  let failUpdate = true;
  backend.handlers["openbitfun.invoke"] = data => {
    const { action, request } = data as {
      action: string; request?: { operation?: string; appId?: string; workspacePath?: string; iconSvg?: string };
    };
    if (action !== "miniapp_presentation") return invoke(data);
    backend.calls.push({ action, request, raw: false });
    if (request?.operation === "snapshot") return {
      ok: true, value: { instances: [{ appId: "app-standup", workspacePath: "C:/Existing workspace" }] },
    };
    if (request?.appId !== "app-standup") return { ok: false, error: "Wrong Space" };
    if (request.operation === "installation") {
      if (failStatus) {
        failStatus = false;
        return { ok: false, error: "Cannot read Start Menu" };
      }
      return { ok: true, value: { paths: installed ? [launcherPath] : [] } };
    }
    if (request.operation === "install") {
      if (installed && failUpdate) {
        failUpdate = false;
        return { ok: false, error: "The shortcut is temporarily locked" };
      }
      installed = true;
      return { ok: true, value: { path: launcherPath } };
    }
    if (request.operation === "uninstall") {
      installed = false;
      return { ok: true, value: null };
    }
    return { ok: false, error: "Unknown launcher action" };
  };

  const app = await open("../App.tsx", { ...DESKTOP, platform: "windows", host: { handlers: backend.handlers } });
  await openSpaces(app);
  await app.press("label:space-more-app-standup");
  await app.press("label:space-menu-system-add-app-standup");
  await app.waitFor(`"Standup Board" was added to the system: ${launcherPath}`);

  await manageFromApps(app, "app-standup");
  await app.press("label:space-system-app-retry");
  await app.waitFor("Update system app");
  await app.waitFor("label:space-system-app-remove");
  await app.press("label:space-system-app-install");
  await app.waitFor('Could not update the system app for "Standup Board": The shortcut is temporarily locked');
  await app.waitFor("label:space-system-app-remove");
  await app.press("label:space-system-app-install");
  await app.waitFor(`The system app for "Standup Board" was updated: ${launcherPath}`);
  await app.waitFor("label:space-system-app-remove");
  await app.press("label:space-system-app-remove");
  await app.waitFor('"Standup Board" was removed from the system. App data and running tasks are kept.');
  await app.waitUntil(() => app.texts().includes("Add system app") && !app.shows("label:space-system-app-remove"));
  expect(app.shows("label:space-detail-launch")).toBe(true);

  const calls = marketCalls(backend, "miniapp_presentation").map(call => call.request as Record<string, unknown>);
  const installs = calls.filter(call => call.operation === "install");
  expect(installs).toHaveLength(3);
  for (const install of installs) {
    expect(install).toMatchObject({ appId: "app-standup", workspacePath: "C:/Existing workspace" });
    expect(String(install.iconSvg)).toContain('<path d="M4 3h5');
  }
  expect(calls.filter(call => call.operation === "uninstall")).toEqual([{ operation: "uninstall", appId: "app-standup" }]);
  expect(marketCalls(backend, "delete_miniapp")).toHaveLength(0);
  expect(marketCalls(backend, "miniapp_worker_stop")).toHaveLength(0);
});

test("apps: browser controllers cannot publish a runtime's system launcher", async () => {
  const backend = createMiniAppMarketBackend({}, { origins: ORIGIN_STANDUP });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "desk" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("desk", "Desk", [], { hostKind: "desktop" }),
      fleetDeviceRow("laptop", "Laptop", [], { hostKind: "desktop" }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSpaces(app);
  await app.press("label:library-scope-chip");
  await app.press("label:library-scope-laptop");
  await app.waitFor("id:space-details-app-standup");
  await app.press("label:space-more-app-standup");
  await app.waitFor("System apps require a local workspace in the desktop app.");
  await app.keyboard.press("Escape");
  await app.press("id:space-details-app-standup");
  await app.waitFor("label:space-installed-details");
  expect(app.shows("label:space-system-app-install")).toBe(false);
  expect(host.calls.filter(call => call.command === "miniapp_presentation")).toHaveLength(0);
  expect(host.fleetCalls.filter(call => call.command === "miniapp_presentation")).toHaveLength(0);
});

test("market: listing detail shows host permissions and releases, favorites and rates", async () => {
  const backend = createMiniAppMarketBackend({}, { origins: ORIGIN_STANDUP });
  const app = await openMarket(backend);

  await app.waitFor("id:market-card-standup-board");
  await app.press("id:market-card-standup-board");
  await app.waitFor("Drafts your daily update from yesterday's commits.");
  expect(marketCalls(backend, "miniapp_market_get_listing")[0].request).toMatchObject({ slug: "standup-board" });
  await app.waitUntil(() => marketCalls(backend, "miniapp_market_installed_status").length > 0);
  expect(marketCalls(backend, "miniapp_market_installed_status")[0].request).toMatchObject({ listingId: "lst-standup" });

  expect(app.texts()).toContain("Read files: {workspace}");
  expect(app.texts()).toContain("Use AI models");
  expect(app.texts()).toContain("License: MIT");
  // Releases newest first, three shown, the rest behind a toggle; the yanked one is marked.
  await app.waitFor("label:market-release-4");
  expect(app.shows("label:market-release-1")).toBe(false);
  expect(app.texts()).toContain("Withdrawn");
  await app.press("label:market-releases-toggle");
  await app.waitFor("label:market-release-1");

  // Installed at release 3, the listing is at 4: Update leads, Open is secondary.
  await app.waitFor("label:market-install");
  expect(app.texts()).toContain("Update");
  expect(app.shows("label:market-open")).toBe(true);

  await app.press("label:market-favorite");
  await app.waitUntil(() => marketCalls(backend, "miniapp_market_set_favorite").length === 1);
  expect(marketCalls(backend, "miniapp_market_set_favorite")[0].request).toMatchObject({
    slug: "standup-board",
    enabled: true,
  });
  await app.waitFor("43");

  await app.press("label:market-rate-4");
  await app.waitUntil(() => marketCalls(backend, "miniapp_market_set_rating").length === 1);
  expect(marketCalls(backend, "miniapp_market_set_rating")[0].request).toMatchObject({
    slug: "standup-board",
    value: 4,
  });
  await app.waitFor("4.5 · 19 ratings");
});

test("market: install repeats the request with the confirmation the host asked for", async () => {
  const backend = createMiniAppMarketBackend();
  const app = await openMarket(backend);

  await app.waitFor("id:market-card-weather-glance");
  await app.press("id:market-card-weather-glance");
  await app.waitFor("label:market-install");
  await app.press("label:market-install");
  // The host refuses until the user allows the release's permissions.
  await app.waitFor("label:market-install-prompt");
  expect(backend.marketInstalls[0]).toMatchObject({
    slug: "weather-glance",
    releaseNumber: 1,
    existingAppId: null,
    confirmPermissions: false,
    confirmOverwrite: false,
  });
  expect(app.texts().some(text => text.includes("net.allow:api.open-meteo.com"))).toBe(true);
  await app.press("Allow and install");
  await app.waitFor("Installed Weather Glance.");
  expect(backend.marketInstalls).toHaveLength(2);
  expect(backend.marketInstalls[1]).toMatchObject({ confirmPermissions: true, confirmOverwrite: false });
  // Installed and current: Open leads, no install button.
  await app.waitFor("label:market-detail-installed");
  expect(app.shows("label:market-install")).toBe(false);
  expect(app.shows("label:market-open")).toBe(true);

  // The library re-reads and installed details show the marketplace origin.
  await app.press("label:market-close");
  await app.press("label:spaces-view-library");
  await manageFromApps(app, "market-weather-glance");
  expect(app.texts()).toContain("Marketplace");
  expect(app.texts()).toContain("v1");
});

test("market: localized cards and details show the gallery and retry an unavailable screenshot", async () => {
  const backend = withMarketMedia(createMiniAppMarketBackend(), true);
  const app = await openMarket(backend);
  await app.waitFor("Standup Planner");
  expect(app.texts()).toContain("Plan your team's standup.");
  expect(marketCalls(backend, "miniapp_market_read_screenshot")).toHaveLength(0);
  await app.press("id:market-card-standup-board");
  await app.waitFor("label:market-preview");
  await app.waitFor("label:Preview of Standup Planner");
  expect(app.texts()).toContain("Team updates");
  expect(app.texts()).toContain("Reviewed");
  expect(app.texts()).toContain("Author");
  expect(app.texts()).toContain("1 of 2");
  await app.press("id:market-preview-next");
  await app.waitFor("Couldn't load this screenshot.");
  await app.press("Retry");
  await app.waitFor("label:Preview of Standup Planner");
  expect(app.texts()).toContain("2 of 2");
  await app.press("id:market-preview-previous");
  await app.waitFor("label:Preview of Standup Planner");
  expect(app.texts()).toContain("1 of 2");
  expect(marketCalls(backend, "miniapp_market_read_screenshot").map(call => call.request)).toEqual([
    { sha256: FIRST_SCREENSHOT }, { sha256: SECOND_SCREENSHOT }, { sha256: SECOND_SCREENSHOT },
  ]);
});

test("market: an update over local changes asks before it overwrites", async () => {
  const backend = createMiniAppMarketBackend({}, { origins: ORIGIN_STANDUP, localOverrides: ["app-standup"] });
  const app = await openMarket(backend);

  await app.waitFor("id:market-card-standup-board");
  await app.press("id:market-card-standup-board");
  await app.waitFor("The installed copy has local changes.");
  await app.press("label:market-install");
  await app.waitFor("Replace local changes");
  expect(backend.marketInstalls[0]).toMatchObject({ existingAppId: "app-standup", confirmOverwrite: false });
  await app.press("Replace local changes");
  await app.waitFor("Updated Standup Board.");
  expect(backend.marketInstalls[1]).toMatchObject({
    existingAppId: "app-standup",
    releaseNumber: 4,
    confirmOverwrite: true,
  });
  await app.press("label:market-close");
  await app.press("label:spaces-view-library");
  await manageFromApps(app, "app-standup");
  expect(app.texts()).toContain("Marketplace");
  expect(app.texts()).toContain("v4");
});

test("market: an installed Space follows its listing ID and returns with the updated release", async () => {
  const backend = withMarketMedia(createMiniAppMarketBackend({}, { origins: ORIGIN_STANDUP }));
  const invoke = backend.handlers["openbitfun.invoke"];
  let wrongListing = true;
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action: string; request: Record<string, unknown> };
    if (args.action === "miniapp_market_get_listing" && args.request.listingId && wrongListing) {
      wrongListing = false;
      backend.calls.push({ ...args, raw: false });
      const reply = invoke({ ...args, request: { slug: "weather-glance" } });
      return reply;
    }
    return invoke(data);
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "desk" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("desk", "Desk", [], { hostKind: "desktop" }),
      fleetDeviceRow("laptop", "Laptop", [], { hostKind: "desktop", hostCapabilities: ["fleet_v1", "miniapp_market_listing_id_v1"] }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSpaces(app);
  await app.press("label:library-scope-chip");
  await app.press("label:library-scope-laptop");
  await app.press("id:space-details-app-standup");
  await app.waitFor("label:space-detail-market-listing");
  expect(app.texts()).toContain("v3");
  expect(marketCalls(backend, "miniapp_market_browse")).toHaveLength(0);
  await app.press("label:space-detail-market-listing");
  await app.waitFor("This marketplace listing is unavailable.");
  expect(app.shows("label:market-install")).toBe(false);
  expect(app.texts()).not.toContain("Weather Glance");
  await app.press("Retry");
  await app.waitFor("label:market-install");
  expect(app.texts()).toContain("Standup Planner");
  expect(app.texts()).toContain("Update");
  expect(marketCalls(backend, "miniapp_market_get_listing").at(-1)?.request).toEqual({ listingId: "lst-standup" });
  await app.press("label:market-install");
  await app.waitFor("Updated Standup Planner.");
  expect(backend.marketInstalls.at(-1)).toMatchObject({ slug: "standup-board", existingAppId: "app-standup", releaseNumber: 4 });
  expect(host.fleetCalls.filter(call => ["miniapp_market_get_listing", "miniapp_market_install"].includes(call.command))
    .map(call => call.target)).toEqual(["laptop", "laptop", "laptop"]);
  await app.press("label:market-close");
  await app.waitFor("label:space-installed-details");
  expect(app.texts()).toContain("v4");
  expect(app.shows("label:market-listing")).toBe(false);
});

test("market: a slug-only host can reopen the already browsed listing for an installed Space", async () => {
  const backend = createMiniAppMarketBackend({}, { origins: ORIGIN_STANDUP });
  const invoke = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const args = data as { action: string; request: Record<string, unknown> };
    if (args.action === "miniapp_market_get_listing" && args.request.listingId) {
      backend.calls.push({ ...args, raw: false });
      return { ok: false, error: "Invalid request: missing field `slug`" };
    }
    return invoke(data);
  };
  const app = await openMarket(backend);
  await app.waitFor("id:market-card-standup-board");
  await app.press("label:spaces-view-library");
  await manageFromApps(app, "app-standup");
  await app.press("label:space-detail-market-listing");
  await app.waitFor("label:market-install");
  expect(marketCalls(backend, "miniapp_market_get_listing").map(call => call.request)).toEqual([
    { listingId: "lst-standup" }, { slug: "standup-board" },
  ]);
  expect(app.texts()).toContain("Standup Board");
});

test("market: the legacy fleet route uses a known slug after negotiation", async () => {
  const backend = createMiniAppMarketBackend({}, { origins: ORIGIN_STANDUP });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "desk" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("desk", "Desk", [], { hostKind: "desktop" }),
      fleetDeviceRow("laptop", "Laptop", [], { hostKind: "desktop" }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSpaces(app);
  await app.press("label:library-scope-chip");
  await app.press("label:library-scope-laptop");
  await app.press("id:space-details-app-standup");
  await app.press("label:space-detail-market-listing");
  await app.waitFor("Update OpenBitFun on this device to open listings from installed Spaces.");
  expect(marketCalls(backend, "miniapp_market_get_listing")).toHaveLength(0);
  await app.press("label:market-close");
  await app.press("label:space-detail-back");
  await app.press("label:spaces-view-market");
  await app.waitFor("id:market-card-standup-board");
  await app.press("label:spaces-view-library");
  await app.press("id:space-details-app-standup");
  await app.press("label:space-detail-market-listing");
  await app.waitFor("label:market-install");
  expect(marketCalls(backend, "miniapp_market_get_listing").map(call => call.request)).toEqual([{ slug: "standup-board" }]);
});

test("market: managing the installed copy keeps the listing and shares its pin and removal state", async () => {
  const backend = withMarketMedia(createMiniAppMarketBackend({}, { origins: ORIGIN_STANDUP }));
  const invoke = backend.handlers["openbitfun.invoke"];
  let refuseDeletion = true;
  backend.handlers["openbitfun.invoke"] = data => {
    if (refuseDeletion && (data as { action?: string }).action === "delete_miniapp") {
      refuseDeletion = false;
      return { ok: false, error: "The host refused to remove this Space." };
    }
    return invoke(data);
  };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "desk" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("desk", "Desk", [], { hostKind: "desktop" }),
      fleetDeviceRow("laptop", "Laptop", [], { hostKind: "desktop" }),
    ] },
  });
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSpaces(app);
  await app.press("label:library-scope-chip");
  await app.press("label:library-scope-laptop");
  await app.press("label:spaces-view-market");
  await app.press("id:market-card-standup-board");
  await app.waitFor("label:market-manage");
  await app.waitFor("label:Preview of Standup Planner");
  await app.press("id:market-preview-next");
  await app.waitFor("2 of 2");
  expect(app.shows("label:market-open-window")).toBe(false);
  await app.press("label:market-pin");
  await app.waitFor("Unpin from sidebar");
  await app.press("label:market-manage");
  await app.waitFor("label:space-installed-details");
  expect(app.shows("label:market-listing")).toBe(false);
  expect(app.texts()).toContain("v3");
  expect(app.texts()).toContain("Unpin from sidebar");
  await app.press("label:space-detail-pin");
  await app.waitFor("Pin to sidebar");
  await app.press("label:space-detail-back");
  await app.waitFor("label:market-listing");
  expect(app.texts()).toContain("2 of 2");
  expect(app.texts()).toContain("Pin to sidebar");
  expect(marketCalls(backend, "miniapp_market_get_listing")).toHaveLength(1);

  const storedPins = () => JSON.parse(app.storage()["openbitfun-miniapp-navigation"] ?? "{}")
    .state?.pinnedAppIdsBySurface?.laptop ?? [];
  await app.press("label:market-pin");
  await app.waitUntil(() => storedPins().includes("app-standup"));
  await app.press("label:market-manage");
  await app.press("label:space-detail-delete");
  expect(host.fleetCalls.filter(call => call.command === "delete_miniapp")).toHaveLength(0);
  await app.press("label:space-detail-delete-confirm");
  await app.waitFor("The host refused to remove this Space.");
  expect(storedPins()).toEqual(["app-standup"]);
  await app.press("label:space-detail-delete");
  await app.press("label:space-detail-delete-confirm");
  await app.waitFor("label:market-install");
  await app.waitUntil(() => storedPins().length === 0);
  expect(app.shows("label:space-installed-details")).toBe(false);
  expect(app.shows("label:market-manage")).toBe(false);
  expect(app.texts()).toContain("2 of 2");
  expect(app.texts()).toContain("Install");
  expect(host.fleetCalls.filter(call => call.command === "delete_miniapp")).toMatchObject([
    { target: "laptop", args: { appId: "app-standup" } },
    { target: "laptop", args: { appId: "app-standup" } },
  ]);
});

test("market: personal actions ask for sign-in instead of calling the market", async () => {
  const backend = createMiniAppMarketBackend({}, { signedIn: false });
  const app = await openMarket(backend);

  await app.waitFor("id:market-card-standup-board");
  await app.press("id:market-card-standup-board");
  await app.waitFor("label:market-favorite");
  await app.press("label:market-favorite");
  await app.waitFor("label:market-sign-in");
  expect(marketCalls(backend, "miniapp_market_set_favorite")).toHaveLength(0);
});

test("market: the market's own 401 envelope becomes the sign-in prompt", async () => {
  const backend = createMiniAppMarketBackend({}, { favoriteUnauthorized: true });
  const app = await openMarket(backend);

  await app.waitFor("id:market-card-standup-board");
  await app.press("id:market-card-standup-board");
  await app.waitFor("label:market-favorite");
  await app.press("label:market-favorite");
  await app.waitFor("label:market-sign-in");
  expect(marketCalls(backend, "miniapp_market_set_favorite")).toHaveLength(1);
});

test("market: a host without the market says so instead of showing an empty catalogue", async () => {
  const backend = createMiniAppMarketBackend({}, { marketMissing: true });
  const app = await openMarket(backend);

  await app.waitFor("label:market-unsupported");
  expect(app.texts()).toContain("This device has no Space market");
  expect(app.texts().some(text => text.includes("Update OpenBitFun on that device"))).toBe(true);
  expect(app.shows("label:market-empty")).toBe(false);
});

test("submissions: lists the account's submissions and withdraws one after confirmation", async () => {
  const backend = createMiniAppMarketBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSpaces(app);
  await app.press("label:spaces-view-submissions");

  await app.waitFor("Focus Timer");
  expect(marketCalls(backend, "miniapp_market_list_submissions")[0].raw).toBe(true);
  expect(app.texts()).toContain("In review");
  expect(app.texts()).toContain("Rejected");
  expect(app.texts()).toContain("Reason: Asks for shell access it does not use.");
  // Only drafts and submissions under review can be withdrawn.
  expect(app.shows("label:submission-withdraw-sub-2")).toBe(false);
  expect(app.texts()).toContain(enUSMessages["market.submissions.publishNote"]);

  await app.press("label:submission-withdraw-sub-1");
  await app.waitFor("label:submission-withdraw-confirm-sub-1");
  expect(marketCalls(backend, "miniapp_market_withdraw_submission")).toHaveLength(0);
  await app.press("label:submission-withdraw-confirm-sub-1");
  await app.waitUntil(() => marketCalls(backend, "miniapp_market_withdraw_submission").length === 1);
  expect(marketCalls(backend, "miniapp_market_withdraw_submission")[0].request).toMatchObject({
    submissionId: "sub-1",
  });
  await app.waitFor("label:submission-status-sub-1");
  await app.waitUntil(() => !app.shows("label:submission-withdraw-sub-1"));
});

test("submissions: signed out shows a sign-in state and reads nothing", async () => {
  const backend = createMiniAppMarketBackend({}, { signedIn: false });
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSpaces(app);
  await app.press("label:spaces-view-submissions");
  await app.waitFor("label:submissions-sign-in");
  expect(marketCalls(backend, "miniapp_market_list_submissions")).toHaveLength(0);
});

test("package import: the host inspects the package before it installs it", async () => {
  const backend = createMiniAppMarketBackend();
  const app = await open("../App.tsx", { ...DESKTOP, host: { handlers: backend.handlers } });
  await openSpaces(app);
  await app.waitFor("label:spaces-import-package");
  await app.press("label:spaces-import-package");
  await app.waitFor("label:package-import-path");

  await app.type("label:package-import-path", "/tmp/pocket.zip");
  await app.press("label:package-import-inspect");
  await app.waitFor("Select a .bfminiapp package.");

  await app.clear("label:package-import-path");
  await app.type("label:package-import-path", "/tmp/pocket.bfminiapp");
  await app.press("label:package-import-inspect");
  await app.waitFor("Pocket Notes");
  expect(marketCalls(backend, "miniapp_market_inspect_package").at(-1)?.request).toMatchObject({
    path: "/tmp/pocket.bfminiapp",
  });
  expect(app.texts()).toContain("System notifications");
  expect(app.texts()).toContain("Grants: notifications.system");
  expect(marketCalls(backend, "miniapp_market_import_package")).toHaveLength(0);

  await app.press("label:package-import-confirm");
  await app.waitFor("Imported Pocket Notes.");
  expect(marketCalls(backend, "miniapp_market_import_package")[0].request).toMatchObject({
    path: "/tmp/pocket.bfminiapp",
    confirmPermissions: true,
  });
});

test("market: the compact page launches an installed Space inline and returns through the matching catalog state", async () => {
  const backend = createMiniAppMarketBackend({}, { origins: ORIGIN_STANDUP });
  const invoke = backend.handlers["openbitfun.invoke"];
  backend.handlers["openbitfun.invoke"] = data => {
    const { action, request } = data as { action: string; request: Record<string, unknown> };
    if (action !== "miniapp_inline") return invoke(data);
    backend.calls.push({ action, request, raw: false });
    const value = request.method === "open" ? {
      instance: { instanceId: "market-instance" },
      view: { viewId: "market-view", kind: "tab" },
      app: { id: "app-standup", name: "Standup Board", compiled_html: "<main>Standup</main>", runtime_profile: "compatibility" },
      locale: "en-US",
      appearanceMode: "dark",
    } : request.method === "poll" ? { events: [], cursor: 0 } : null;
    return { ok: true, value, transport: "dev" };
  };
  const app = await open("../App.tsx", { width: 375, height: 812, platform: "macos" as const, host: { handlers: backend.handlers } });
  await openSpaces(app);
  await app.press("label:spaces-view-market");
  await app.waitFor("id:market-card-standup-board");
  await app.type("label:market-search", "standup");
  await app.waitUntil(() => !app.shows("id:market-card-weather-glance"));
  await app.press("id:market-card-standup-board");
  await app.waitFor("label:market-listing");
  await app.waitFor("label:market-install");
  expect(app.shows("label:market-search")).toBe(false);
  await app.press("label:market-open");
  await app.waitFor("label:space-page");
  await app.waitUntil(() => marketCalls(backend, "miniapp_inline").some(call =>
    (call.request as { method?: string }).method === "open"));
  expect(marketCalls(backend, "miniapp_inline")[0]?.request).toMatchObject({
    method: "open", params: { appId: "app-standup" },
  });
  await app.press("label:space-page-back");
  await app.waitFor("label:market-listing");
  await app.press("label:market-close");
  await app.waitFor("id:market-card-standup-board");
  expect(app.value("label:market-search")).toBe("standup");
  expect(app.shows("id:market-card-weather-glance")).toBe(false);
});

test("apps: the selected runtime owns installed rankings and late replies cannot change them", async () => {
  const backend = createMiniAppMarketBackend({}, { origins: ORIGIN_STANDUP });
  const hostCapabilities = ["fleet_v1", "miniapp_market_listing_id_v1", "miniapp_market_summaries_v1"];
  const navigator = { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
    fleetDeviceRow("desk", "Desk", [], { hostKind: "desktop" }),
    fleetDeviceRow("laptop", "Laptop", [], { hostKind: "desktop", hostCapabilities }),
  ] };
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "desk" }, navigator,
  });
  const send = host.handlers["openbitfun.obpSend"];
  let heldSummaries: string[] | undefined;
  host.handlers["openbitfun.obpSend"] = data => {
    const answer = send(data) as string[];
    const call = JSON.parse((data as { frame: string }).frame).params?.args?.request;
    if (call?.command !== "miniapp_market_browse" || !call.args.request.listingIds) return answer;
    if (call.target === "desk") {
      heldSummaries = answer;
      return [];
    }
    const reply = JSON.parse(answer[0]);
    reply.result.items[0].latestRelease = 3;
    return [JSON.stringify(reply)];
  };
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSpaces(app);
  await app.waitFor("This device needs an update to show marketplace rankings for installed Spaces.");
  expect(marketCalls(backend, "miniapp_market_browse")).toHaveLength(0);
  navigator.revision = 2;
  navigator.devices[0] = fleetDeviceRow("desk", "Desk", [], { hostKind: "desktop", hostCapabilities });
  await app.host.send("openbitfun.obpFrames", [JSON.stringify({
    jsonrpc: "2.0", method: "event",
    params: { event: "fleet://index-changed", payload: { revision: 2, deviceIds: ["desk"] }, seq: 1, origin: "desk" },
  })]);
  await app.waitUntil(() => heldSummaries !== undefined);
  await app.press("label:library-scope-chip");
  await app.press("label:library-scope-laptop");
  await app.waitFor("Most downloaded");
  expect(app.shows("label:space-update-app-standup")).toBe(false);
  await app.host.send("openbitfun.obpFrames", heldSummaries);
  await app.press("label:spaces-sort");
  await app.press("Top rated");
  await app.waitFor("Top rated");
  expect(app.shows("label:space-update-app-standup")).toBe(false);
  expect(host.fleetCalls.filter(call => call.command === "miniapp_market_browse").map(call => [call.target, call.args]))
    .toEqual([
      ["desk", { request: { listingIds: ["lst-standup"] } }],
      ["laptop", { request: { listingIds: ["lst-standup"] } }],
    ]);
  expect(host.pageHostCalls).toHaveLength(0);
});

test("market: switching fleet device closes the open listing and ignores its delayed detail", async () => {
  const backend = withMarketMedia(createMiniAppMarketBackend());
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "desk" },
    navigator: { revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, unread: 0, waiting: 0 }, devices: [
      fleetDeviceRow("desk", "Desk", [], { hostKind: "desktop" }),
      fleetDeviceRow("laptop", "Laptop", [], { hostKind: "desktop" }),
    ] },
  });
  const send = host.handlers["openbitfun.obpSend"];
  let heldDetail: unknown;
  host.handlers["openbitfun.obpSend"] = data => {
    const answer = send(data);
    const frame = JSON.parse((data as { frame: string }).frame);
    const call = frame.params?.args?.request;
    if (call?.target === "desk" && call.command === "miniapp_market_get_listing") {
      heldDetail = answer;
      return [];
    }
    return answer;
  };
  const app = await open("./fixtures/obpApp.tsx", { ...DESKTOP, host: { handlers: host.handlers } });
  await openSpaces(app);
  await app.press("label:spaces-view-market");
  await app.press("id:market-card-standup-board");
  await app.waitUntil(() => heldDetail !== undefined);
  await app.press("label:library-scope-chip");
  await app.press("label:library-scope-laptop");
  await app.waitFor("id:market-card-weather-glance");
  expect(app.shows("label:market-listing")).toBe(false);
  await app.press("id:market-card-weather-glance");
  await app.waitFor("label:market-install");
  await app.waitFor("label:Preview of Weather Glance");
  await app.host.send("openbitfun.obpFrames", heldDetail);
  expect(app.texts()).toContain("Weather Glance");
  expect(app.texts()).not.toContain("Standup Planner");
  expect(host.fleetCalls.filter(call => call.command === "miniapp_market_get_listing").map(call => call.target))
    .toEqual(["desk", "laptop"]);
  expect(host.fleetCalls.filter(call => call.command === "miniapp_market_read_screenshot").map(call => call.target))
    .toEqual(["laptop"]);
});
