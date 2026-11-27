// The OpenBitFun UI loader: runs the exact web UI bundle a device ships, from
// the server's content-addressed pool, after verifying every byte.
//
// Contract: `ui-from-device` v1 (manifest schema 1, handoff v1). Deployed at
// `/ui-loader.js` by `scripts/build-web-controller.mjs`; three roles:
//
// - Service Worker (scope `/b/`). It serves `/b/<bundleId>/<path>`
//   from the bundle the launcher stored. The manifest came over the end-to-end
//   channel from the device, so the device key authenticates it, and the worker
//   recomputes its id. Verified files are cached in a shared content-addressed
//   Cache Storage (`obf-ui-cas-v1`, keyed by verified SHA-256) so identical
//   assets (such as the 11 MB NSH WASM runtime) are reused across bundle
//   updates, or fetched from `/cas/<sha256>?device=<deviceId>` (the `.br` copy
//   first when the manifest has one). The decoded body must match the
//   manifest's size and SHA-256 before anything uses it. A failure never runs
//   anything: the page goes back to the launcher, which names the file.
// - Manifest store. The launcher (`host.js`, `openbitfun.controller.prepareBundle`)
//   posts `{ type: "obf-ui-store", manifest, deviceId }` with a reply port; the
//   worker checks the manifest and recomputes its bundleId (lowercase hex
//   SHA-256 of the canonical JSON: keys sorted, no whitespace, UTF-8). It then
//   stores `{ bundleId, manifest, deviceId }` in IndexedDB `obf-ui-bundles` and
//   answers `{ ok, bundleId }`. A stated id is never trusted.
// - Boot script of `/ui-boot.html`. nginx answers any `/b/...` request
//   that reached the network (a hard reload, or no worker yet) with that page.
//   The script registers the worker and reloads once.
//
// Everything is in this one file, so the worker needs no imports. The Node
// test (`ui-loader.test.mjs`) loads it with fakes through `ObfUiLoader`.

(function install(scope) {
  "use strict";

  const BUNDLE_DB = "obf-ui-bundles";
  const BUNDLE_STORE = "bundles";
  const CACHE_PREFIX = "obf-ui-";
  const CAS_CACHE = "obf-ui-cas-v1";
  const PREFETCH_CONCURRENCY = 6;
  const MANIFEST_SCHEMA = 1;
  const MAX_FILE_BYTES = 64 * 1024 * 1024;
  const UNUSED_MS = 30 * 24 * 60 * 60 * 1000;
  const TOUCH_MS = 60 * 60 * 1000;
  const MAX_DEVICES = 8;
  const MAX_CACHED_BUNDLES = 4;
  const HEX64 = /^[0-9a-f]{64}$/;
  const STORE_MESSAGE = "obf-ui-store";
  // The blank page a device UI page runs the NSH realm in (`host.js`,
  // `prepareBundleRealm`). A dot-file, so no manifest can list it.
  const REALM_PAGE = ".obf-realm.html";
  const REALM_HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
  // The only page that can run a self-contained figure. It is opaque even if
  // a caller opens it directly. The figure arrives in a fragment, outside HTTP.
  const FIGURE_PAGE = ".obf-figure.html";
  const FIGURE_CSP =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src data:; " +
    "img-src data: blob:; connect-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";
  const FIGURE_HTML = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">
    <style>html,body,iframe{width:100%;height:100%;margin:0;border:0}iframe{display:block}</style>
    <iframe sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
    <script>
      const frame = document.querySelector('iframe');
      let latest;
      const forward = () => { if (latest) frame.contentWindow?.postMessage(latest, '*'); };
      frame.addEventListener('load', forward);
      addEventListener('message', event => {
        if (event.source !== parent || typeof event.data !== 'string' || event.data.length > 1048576) return;
        try {
          if (JSON.parse(event.data)?.type !== 'openbitfun.figure.bindings.v1') return;
          latest = event.data;
          forward();
        } catch {}
      });
      const source = location.hash.slice(1);
      if (source.length <= 1500000 && /^[A-Za-z0-9+/]+={0,2}$/.test(source)) {
        frame.src = 'data:text/html;base64,' + source;
      }
    </script>`;
  const BOOT_KEY = "obf.ui.boot";

  // The CSP nginx sends for `/`; a worker's own responses carry no
  // server headers, so it repeats them.
  const PAGE_CSP =
    "script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'";

  const MIME = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json",
    webmanifest: "application/manifest+json",
    wasm: "application/wasm",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    txt: "text/plain; charset=utf-8",
    map: "application/json",
    bin: "application/octet-stream",
  };

  // ── Manifest: canonical form, bundleId and checks ──

  /** Whether `text` holds no lone surrogate (it encodes to UTF-8 as it is). */
  function wellFormed(text) {
    if (typeof text.isWellFormed === "function") return text.isWellFormed();
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
  }

  /**
   * The canonical manifest text: keys sorted by UTF-16 code units (the default
   * sort), no whitespace, strings as `JSON.stringify` writes them, numbers only
   * as safe integers. The same rules as `scripts/write-ui-bundle-manifest.mjs`
   * and `openbitfun_obp::ui_bundle`, checked against the shared fixture.
   */
  function canonicalJson(value) {
    if (value === null) return "null";
    switch (typeof value) {
      case "boolean":
        return value ? "true" : "false";
      case "number":
        if (!Number.isSafeInteger(value)) throw new Error(`ui_bundle_invalid: ${value} is not a safe integer`);
        return String(value);
      case "string":
        if (!wellFormed(value)) throw new Error("ui_bundle_invalid: a string holds a lone surrogate");
        return JSON.stringify(value);
      case "object": {
        if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
        const keys = Object.keys(value).sort();
        return `{${keys
          .map(key => {
            if (!wellFormed(key)) throw new Error("ui_bundle_invalid: a key holds a lone surrogate");
            return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
          })
          .join(",")}}`;
      }
      default:
        throw new Error(`ui_bundle_invalid: ${typeof value} is not a JSON value`);
    }
  }

  function hex(bytes) {
    let out = "";
    for (const byte of new Uint8Array(bytes)) out += byte.toString(16).padStart(2, "0");
    return out;
  }

  async function sha256Hex(subtle, bytes) {
    return hex(await subtle.digest("SHA-256", bytes));
  }

  /** The bundleId of `manifest`: SHA-256 of its canonical UTF-8 bytes. */
  async function bundleIdOf(subtle, manifest) {
    return sha256Hex(subtle, new TextEncoder().encode(canonicalJson(manifest)));
  }

  /**
   * A manifest path: POSIX and relative, no `.`/`..`/empty segments, no
   * backslash, colon or control character, at most 1024 UTF-8 bytes.
   */
  function validPath(path) {
    if (typeof path !== "string" || path.length === 0 || !wellFormed(path)) return false;
    if (new TextEncoder().encode(path).length > 1024) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\\:\u0000-\u001f\u007f]/.test(path)) return false;
    return path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
  }

  function validHash(entry) {
    return (
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.sha256 === "string" &&
      HEX64.test(entry.sha256) &&
      Number.isSafeInteger(entry.size) &&
      entry.size >= 0 &&
      entry.size <= MAX_FILE_BYTES
    );
  }

  /** Throws `ui_bundle_schema:` (a newer manifest) or `ui_bundle_invalid:`. */
  function checkManifest(manifest) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error("ui_bundle_invalid: the manifest is not an object");
    }
    if (!Number.isSafeInteger(manifest.schema) || manifest.schema < 1) {
      throw new Error("ui_bundle_invalid: the manifest has no schema");
    }
    if (manifest.schema > MANIFEST_SCHEMA) {
      throw new Error(`ui_bundle_schema: manifest schema ${manifest.schema} is newer than this page reads (${MANIFEST_SCHEMA})`);
    }
    if (!validPath(manifest.entry)) throw new Error("ui_bundle_invalid: the manifest has no valid entry");
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error("ui_bundle_invalid: the manifest lists no files");
    }
    const seen = new Set();
    for (const file of manifest.files) {
      if (!file || !validPath(file.path)) throw new Error("ui_bundle_invalid: a file has an invalid path");
      if (seen.has(file.path)) throw new Error(`ui_bundle_invalid: ${file.path} is listed twice`);
      seen.add(file.path);
      if (!validHash(file)) throw new Error(`ui_bundle_invalid: ${file.path} has no valid sha256 and size`);
      if (file.br !== undefined && !validHash(file.br)) throw new Error(`ui_bundle_invalid: ${file.path} has an invalid br entry`);
    }
    if (!seen.has(manifest.entry)) throw new Error("ui_bundle_invalid: the entry is not one of the files");
  }

  function mimeOf(path) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    return MIME[extension] || "application/octet-stream";
  }

  /** `{ bundleId, path }` of a URL in `scopeUrl` (`…/b/`), or `null`. */
  function parseBundleUrl(url, scopeUrl) {
    const target = new URL(url);
    const base = new URL(scopeUrl);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return null;
    const rest = target.pathname.slice(base.pathname.length);
    const slash = rest.indexOf("/");
    const bundleId = slash < 0 ? rest : rest.slice(0, slash);
    if (!HEX64.test(bundleId)) return null;
    let path = slash < 0 ? "" : rest.slice(slash + 1);
    try {
      path = path
        .split("/")
        .map(segment => decodeURIComponent(segment))
        .join("/");
    } catch {
      return { bundleId, path: null };
    }
    return { bundleId, path };
  }

  /** Whether `path` belongs to the critical startup waterfall (not a lazy vendor/data asset). */
  function isBootFile(path, entry) {
    if (path === entry) return true;
    if (path.startsWith("assets/")) return false;
    if (path.startsWith("facades/")) return /\.js$/i.test(path);
    if (/^browser\.[^/]+\/(?:runtime|page|bootstrap|realm|loader)\.js$/i.test(path)) return true;
    if (path.includes("/")) return false;
    if (/^nsh-math\./i.test(path) || /^nsh-syntaxes\./i.test(path)) return false;
    return /\.(?:js|css|wasm)$/i.test(path);
  }

  /** Priority order for critical boot prefetch: entry, large streaming binaries, then small scripts. */
  function bootFilesOf(manifest) {
    const entry = manifest.entry;
    const files = manifest.files.filter(file => isBootFile(file.path, entry));
    const rank = file => {
      if (file.path === entry) return 0;
      if (/^nsh\.[^/]+\.wasm$/i.test(file.path)) return 1;
      if (/^app\.[^/]+\.js$/i.test(file.path)) return 2;
      return 3;
    };
    files.sort((a, b) => rank(a) - rank(b) || a.size - b.size);
    return files;
  }

  // ── The loader (environment-free; the worker and the test give it one) ──

  /**
   * `env`: `{ subtle, caches, records: { get(id), put(record), remove(id), all() },
   * fetch(url, init), now(), scopeUrl, casUrl, launcherUrl, navigateClient(clientId, url, bundleId),
   * prefetch?: boolean }`.
   */
  function createUiLoader(env) {
    const verified = new Map();
    const inFlight = new Map();

    function casCacheKey(sha256) {
      return `${env.casUrl}verified/${sha256}`;
    }

    function hashFromCasKey(entry) {
      const url = typeof entry === "string" ? entry : entry && typeof entry.url === "string" ? entry.url : "";
      const prefix = `${env.casUrl}verified/`;
      if (!url.startsWith(prefix)) return null;
      const hash = url.slice(prefix.length);
      return HEX64.test(hash) ? hash : null;
    }

    async function sweepUnreferencedBlobs(keepRecords) {
      const activeHashes = new Set();
      for (const record of keepRecords) {
        const files = record && record.manifest && Array.isArray(record.manifest.files) ? record.manifest.files : [];
        for (const file of files) {
          if (file && typeof file.sha256 === "string") activeHashes.add(file.sha256);
        }
      }
      const cache = await env.caches.open(CAS_CACHE).catch(() => null);
      if (!cache || typeof cache.keys !== "function" || typeof cache.delete !== "function") return;
      const keys = await cache.keys().catch(() => []);
      for (const key of keys) {
        const hash = hashFromCasKey(key);
        if (hash && !activeHashes.has(hash)) {
          await cache.delete(key).catch(() => undefined);
        }
      }
    }

    async function sweepLegacyCaches() {
      if (typeof env.caches.keys !== "function") return;
      const names = await env.caches.keys().catch(() => []);
      for (const name of names) {
        if (typeof name === "string" && name.startsWith(CACHE_PREFIX) && name !== CAS_CACHE) {
          await env.caches.delete(name).catch(() => undefined);
        }
      }
    }

    async function storeManifest(message) {
      const manifest = message && message.manifest;
      const deviceId = message && message.deviceId;
      if (typeof deviceId !== "string" || !deviceId) throw new Error("ui_bundle_invalid: no device id");
      checkManifest(manifest);
      const bundleId = await bundleIdOf(env.subtle, manifest);
      const now = env.now();
      const previous = await env.records.get(bundleId);
      const incomingHolders = Array.isArray(message.holders)
        ? message.holders.filter(id => typeof id === "string" && id.length > 0)
        : [];
      const devices = [];
      for (const id of [deviceId, ...incomingHolders, ...((previous && previous.devices) || [])]) {
        if (!devices.includes(id)) devices.push(id);
        if (devices.length >= MAX_DEVICES) break;
      }
      const record = { bundleId, manifest, deviceId, devices, storedAt: now, usedAt: now };
      await env.records.put(record);
      verified.set(bundleId, record);
      await prune(bundleId, now);
      return { bundleId };
    }

    /**
     * Drops bundles unused for 30 days, enforces an LRU cap (`MAX_CACHED_BUNDLES`),
     * sweeps legacy per-bundle caches, and garbage-collects unreferenced CAS blobs.
     */
    async function prune(keep, now) {
      const all = await env.records.all();
      const survivors = [];
      for (const record of all) {
        if (!record || !record.bundleId) continue;
        if (record.bundleId === keep) {
          survivors.push(record);
          continue;
        }
        if (typeof record.usedAt === "number" && now - record.usedAt >= UNUSED_MS) {
          verified.delete(record.bundleId);
          await env.records.remove(record.bundleId);
          continue;
        }
        survivors.push(record);
      }
      // Evict oldest bundles beyond the bounded LRU cap (always preserving `keep`).
      if (survivors.length > MAX_CACHED_BUNDLES) {
        const evictable = survivors
          .filter(record => record.bundleId !== keep)
          .sort((a, b) => (typeof a.usedAt === "number" ? a.usedAt : 0) - (typeof b.usedAt === "number" ? b.usedAt : 0));
        const toDrop = survivors.length - MAX_CACHED_BUNDLES;
        for (let i = 0; i < toDrop && i < evictable.length; i += 1) {
          const record = evictable[i];
          verified.delete(record.bundleId);
          await env.records.remove(record.bundleId);
        }
      }
      await sweepLegacyCaches();
      const remaining = await env.records.all().catch(() => []);
      const kept = remaining.filter(Boolean);
      if (keep && !kept.some(record => record.bundleId === keep) && verified.has(keep)) {
        kept.push(verified.get(keep));
      }
      await sweepUnreferencedBlobs(kept);
    }

    function isQuotaError(error) {
      if (!error) return false;
      if (error.name === "QuotaExceededError" || error.code === 22) return true;
      return /quota/i.test(String(error.message || ""));
    }

    /** Frees space on quota pressure by evicting all bundles except `keep` and sweeping their blobs. */
    async function evictOtherBundleCaches(keep) {
      const all = await env.records.all().catch(() => []);
      const kept = [];
      for (const record of all) {
        if (!record || !record.bundleId) continue;
        if (record.bundleId === keep) {
          kept.push(record);
          continue;
        }
        verified.delete(record.bundleId);
        await env.records.remove(record.bundleId).catch(() => undefined);
      }
      if (keep && kept.length === 0 && verified.has(keep)) {
        kept.push(verified.get(keep));
      }
      await sweepLegacyCaches();
      await sweepUnreferencedBlobs(kept);
    }

    /** Writes verified bytes into the shared CAS Cache Storage; quota failures never brick the load. */
    async function putCached(cache, bundleId, key, body) {
      if (!cache) return;
      const entry = () => new Response(body, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
      try {
        await cache.put(key, entry());
      } catch (error) {
        if (!isQuotaError(error)) return;
        await evictOtherBundleCaches(bundleId);
        try {
          await cache.put(key, entry());
        } catch {
          // Still over quota: serve the verified bytes without caching them.
        }
      }
    }

    /** The stored record of `bundleId`, checked once per worker life. */
    async function recordOf(bundleId) {
      const known = verified.get(bundleId);
      if (known) return known;
      const record = await env.records.get(bundleId);
      if (!record || !record.manifest) return null;
      checkManifest(record.manifest);
      if ((await bundleIdOf(env.subtle, record.manifest)) !== bundleId) return null;
      verified.set(bundleId, record);
      return record;
    }

    async function touch(record) {
      const now = env.now();
      if (typeof record.usedAt === "number" && now - record.usedAt < TOUCH_MS) return;
      record.usedAt = now;
      await env.records.put(record);
    }

    function headersFor(path, size) {
      const headers = { "Content-Type": mimeOf(path), "X-Content-Type-Options": "nosniff" };
      if (typeof size === "number" && Number.isSafeInteger(size) && size >= 0) {
        headers["Content-Length"] = String(size);
      }
      if (/\.html?$/i.test(path)) {
        // The realm page is framed by its own bundle page and sets a same-origin `<base>`.
        headers["Content-Security-Policy"] =
          path === REALM_PAGE
            ? PAGE_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'").replace("base-uri 'none'", "base-uri 'self'")
            : PAGE_CSP;
        headers["Referrer-Policy"] = "no-referrer";
        headers["Cross-Origin-Opener-Policy"] = "same-origin";
        headers["Cache-Control"] = "no-cache";
      }
      return headers;
    }

    class LoadFailure extends Error {
      constructor(reason, path, message) {
        super(message);
        this.reason = reason;
        this.path = path;
      }
    }

    /** The verified bytes of `file`, from the pool. */
    async function pull(record, file) {
      const hashes = file.br ? [file.br.sha256, file.sha256] : [file.sha256];
      const devices = record.devices && record.devices.length ? record.devices : [record.deviceId];
      let lastStatus = "network";
      for (const device of devices) {
        const others = devices.filter(id => id !== device);
        const holdersParam = others.length > 0 ? `&holders=${encodeURIComponent(others.join(","))}` : "";
        for (const hash of hashes) {
          let response;
          try {
            response = await env.fetch(`${env.casUrl}${hash}?device=${encodeURIComponent(device)}${holdersParam}`, {
              credentials: "same-origin",
            });
          } catch {
            lastStatus = "network";
            continue;
          }
          if (response.status === 401) throw new LoadFailure("signed_out", file.path, "the session ended");
          if (!response.ok) {
            lastStatus = `HTTP ${response.status}`;
            continue;
          }
          const body = new Uint8Array(await response.arrayBuffer());
          // The decoded body is the file: a `.br` entry arrives with
          // `Content-Encoding: br` and the browser already decoded it.
          if (body.length !== file.size || (await sha256Hex(env.subtle, body)) !== file.sha256) {
            throw new LoadFailure("verification", file.path, `${file.path} does not match the device's manifest`);
          }
          return body;
        }
      }
      throw new LoadFailure("unavailable", file.path, `${file.path} could not be loaded (${lastStatus})`);
    }

    /** Pulls `file` with in-flight deduplication by verified SHA-256 and stores it in CAS Cache Storage. */
    function pullAndCache(record, file, cache) {
      const existing = inFlight.get(file.sha256);
      if (existing) return existing;
      const promise = (async () => {
        const body = await pull(record, file);
        const targetCache = cache || (await env.caches.open(CAS_CACHE).catch(() => null));
        await putCached(targetCache, record.bundleId, casCacheKey(file.sha256), body);
        return body;
      })();
      inFlight.set(file.sha256, promise);
      promise.then(
        () => inFlight.delete(file.sha256),
        () => inFlight.delete(file.sha256),
      );
      return promise;
    }

    /**
     * Warms the critical boot files of `bundleId` into CAS Cache Storage in parallel
     * so the runtime waterfall (host.js, browser.*, facades/*) hits local cache.
     * Background errors are swallowed; foreground `handle()` still enforces every check.
     */
    async function warmBundle(bundleId) {
      let record;
      try {
        record = await recordOf(bundleId);
      } catch {
        return;
      }
      if (!record) return;
      const cache = await env.caches.open(CAS_CACHE).catch(() => null);
      const queue = bootFilesOf(record.manifest);
      let cursor = 0;
      async function workerLoop() {
        while (cursor < queue.length) {
          const file = queue[cursor];
          cursor += 1;
          const key = casCacheKey(file.sha256);
          const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
          if (hit) continue;
          try {
            await pullAndCache(record, file, cache);
          } catch {
            // Foreground fetch will retry or fail loudly if needed.
          }
        }
      }
      const workers = [];
      const count = Math.min(PREFETCH_CONCURRENCY, queue.length);
      for (let i = 0; i < count; i += 1) workers.push(workerLoop());
      await Promise.all(workers);
    }

    function failureUrl(failure, bundleId) {
      const params = new URLSearchParams({ "ui-error": failure.reason, file: failure.path || "", bundle: bundleId });
      return `${env.launcherUrl}#${params.toString()}`;
    }

    /**
     * Answers `request` when it names a stored bundle's file; `null` lets
     * the request go to the network unchanged.
     */
    async function handle(request, clientId) {
      if (request.method !== "GET") return null;
      const parsed = parseBundleUrl(request.url, env.scopeUrl);
      if (!parsed) return null;
      const navigation = request.mode === "navigate";
      const { bundleId } = parsed;
      let record;
      try {
        record = await recordOf(bundleId);
      } catch {
        record = null;
      }
      if (!record) {
        // Not stored in this browser (cleared, or an old link): connect again.
        return navigation ? Response.redirect(env.launcherUrl, 302) : new Response("Unknown bundle", { status: 404 });
      }
      if (parsed.path === REALM_PAGE) {
        return new Response(REALM_HTML, { status: 200, headers: headersFor(REALM_PAGE) });
      }
      if (parsed.path === FIGURE_PAGE) {
        return new Response(FIGURE_HTML, { headers: {
          ...headersFor(FIGURE_PAGE),
          "Content-Security-Policy": FIGURE_CSP,
          "Cache-Control": "no-store",
          "X-OpenBitFun-Figure-Preview": "1",
          "X-OpenBitFun-Figure-Bindings": "1",
        } });
      }
      const path = parsed.path === "" ? record.manifest.entry : parsed.path;
      const file = path === null ? null : record.manifest.files.find(entry => entry.path === path);
      if (!file) return new Response("Not in this bundle", { status: 404, headers: { "Content-Type": "text/plain" } });
      await touch(record).catch(() => undefined);
      const cache = await env.caches.open(CAS_CACHE).catch(() => null);
      const key = casCacheKey(file.sha256);
      const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
      if (hit) {
        return new Response(hit.body ?? new Uint8Array(0), { status: 200, headers: headersFor(file.path, file.size) });
      }
      try {
        const body = await pullAndCache(record, file, cache);
        return new Response(body, { status: 200, headers: headersFor(file.path, file.size) });
      } catch (error) {
        const failure =
          error instanceof LoadFailure ? error : new LoadFailure("unavailable", file.path, String(error && error.message));
        const target = failureUrl(failure, bundleId);
        if (navigation) return Response.redirect(target, 302);
        // Nothing unverified runs: the page itself leaves for the launcher.
        if (clientId) await Promise.resolve(env.navigateClient(clientId, target, bundleId)).catch(() => undefined);
        return new Response(failure.message, { status: 502, headers: { "Content-Type": "text/plain" } });
      }
    }

    return { storeManifest, handle, prune, warmBundle };
  }

  // ── IndexedDB records (worker) ──

  function idbRecords(indexedDB) {
    function open() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(BUNDLE_DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(BUNDLE_STORE, { keyPath: "bundleId" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB is unavailable"));
      });
    }
    async function run(mode, work) {
      const db = await open();
      try {
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction(BUNDLE_STORE, mode);
          const request = work(transaction.objectStore(BUNDLE_STORE));
          transaction.oncomplete = () => resolve(request ? request.result : undefined);
          transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
          transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
        });
      } finally {
        db.close();
      }
    }
    return {
      get: id => run("readonly", store => store.get(id)),
      put: record => run("readwrite", store => store.put(record)),
      remove: id => run("readwrite", store => store.delete(id)),
      all: () => run("readonly", store => store.getAll()),
    };
  }

  // ── Roles ──

  function installWorker(worker) {
    const scopeUrl = worker.registration.scope;
    const launcherUrl = new URL("..", scopeUrl).href;
    const loader = createUiLoader({
      subtle: worker.crypto.subtle,
      caches: worker.caches,
      records: idbRecords(worker.indexedDB),
      fetch: (url, init) => worker.fetch(url, init),
      now: () => Date.now(),
      scopeUrl,
      casUrl: new URL("cas/", launcherUrl).href,
      launcherUrl,
      // The page itself leaves, also when its NSH realm iframe asked.
      navigateClient: async (clientId, url, bundleId) => {
        const client = await worker.clients.get(clientId);
        let targets = client && client.frameType !== "nested" ? [client] : [];
        if (targets.length === 0) {
          const windows = await worker.clients.matchAll({ type: "window" });
          targets = windows.filter(
            entry => entry.frameType === "top-level" && entry.url.startsWith(`${scopeUrl}${bundleId}/`),
          );
        }
        for (const target of targets) {
          if (typeof target.navigate === "function") await target.navigate(url);
        }
      },
    });
    worker.addEventListener("install", () => worker.skipWaiting());
    worker.addEventListener("activate", event => event.waitUntil(worker.clients.claim()));
    worker.addEventListener("fetch", event => {
      let parsed = null;
      try {
        parsed = event.request.method === "GET" ? parseBundleUrl(event.request.url, scopeUrl) : null;
      } catch {
        parsed = null;
      }
      if (!parsed) return;
      if (event.request.mode === "navigate" && parsed.path !== REALM_PAGE && parsed.path !== FIGURE_PAGE) {
        event.waitUntil(loader.warmBundle(parsed.bundleId).catch(() => undefined));
      }
      event.respondWith(
        loader.handle(event.request, event.clientId).then(
          response => response || worker.fetch(event.request),
          error => new Response(`The UI loader failed: ${error && error.message}`, { status: 500 }),
        ),
      );
    });
    worker.addEventListener("message", event => {
      const data = event.data;
      const port = event.ports && event.ports[0];
      if (!data || data.type !== STORE_MESSAGE || !port) return;
      event.waitUntil(
        loader.storeManifest(data).then(
          answer => {
            port.postMessage({ ok: true, bundleId: answer.bundleId });
            if (data.prefetch !== false) {
              return loader.warmBundle(answer.bundleId).catch(() => undefined);
            }
          },
          error => port.postMessage({ ok: false, error: String((error && error.message) || error) }),
        ),
      );
    });
  }

  /** `/ui-boot.html`: register the worker, then reload into it once. */
  function bootPage(window) {
    const script = window.document.currentScript;
    const loaderUrl = script && script.src ? script.src : new URL("/ui-loader.js", window.location.href).href;
    const launcherUrl = new URL(".", loaderUrl).href;
    const status = window.document.getElementById("status");
    const say = (text, link) => {
      if (!status) return;
      status.textContent = text;
      if (link) {
        const anchor = window.document.createElement("a");
        anchor.href = launcherUrl;
        anchor.textContent = " Open OpenBitFun";
        status.appendChild(anchor);
      }
    };
    const container = window.navigator.serviceWorker;
    if (!container) {
      say("This browser cannot open a device's interface here (Service Workers are unavailable).", true);
      return;
    }
    let last = 0;
    try {
      last = Number(window.sessionStorage.getItem(BOOT_KEY) || 0);
    } catch {
      last = 0;
    }
    if (Date.now() - last < 10000) {
      say("The interface could not start.", true);
      return;
    }
    container
      .register(loaderUrl, { scope: new URL("b/", launcherUrl).href, updateViaCache: "none" })
      .then(registration => activeWorker(registration, 15000))
      .then(() => {
        try {
          window.sessionStorage.setItem(BOOT_KEY, String(Date.now()));
        } catch {
          // Without sessionStorage the reload still works once.
        }
        window.location.reload();
      })
      .catch(error => say(`The interface could not start: ${error && error.message}.`, true));
  }

  /** Resolves with `registration`'s worker once it is activated. */
  function activeWorker(registration, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (registration.active && registration.active.state === "activated") {
        resolve(registration.active);
        return;
      }
      const worker = registration.installing || registration.waiting || registration.active;
      if (!worker) {
        reject(new Error("no worker"));
        return;
      }
      if (worker.state === "activated") {
        resolve(worker);
        return;
      }
      const finish = (err, value) => {
        clearTimeout(timer);
        if (typeof worker.removeEventListener === "function") {
          worker.removeEventListener("statechange", onStateChange);
        }
        if (err) reject(err);
        else resolve(value);
      };
      const onStateChange = () => {
        if (worker.state === "activated") {
          finish(null, worker);
        } else if (worker.state === "redundant") {
          if (registration.active && registration.active.state === "activated") {
            finish(null, registration.active);
          } else {
            finish(new Error("the UI loader was replaced while starting"));
          }
        }
      };
      const timer = setTimeout(() => finish(new Error("the UI loader did not start in time")), timeoutMs);
      worker.addEventListener("statechange", onStateChange);
    });
  }

  const api = {
    MANIFEST_SCHEMA,
    STORE_MESSAGE,
    REALM_PAGE,
    CAS_CACHE,
    canonicalJson,
    bundleIdOf,
    checkManifest,
    validPath,
    mimeOf,
    parseBundleUrl,
    isBootFile,
    bootFilesOf,
    createUiLoader,
    activeWorker,
  };
  scope.ObfUiLoader = api;

  const isWorker =
    typeof scope.ServiceWorkerGlobalScope !== "undefined" && scope instanceof scope.ServiceWorkerGlobalScope;
  if (isWorker) installWorker(scope);
  else if (scope.document && scope.navigator && scope.document.currentScript) bootPage(scope);
})(typeof self !== "undefined" ? self : globalThis);
