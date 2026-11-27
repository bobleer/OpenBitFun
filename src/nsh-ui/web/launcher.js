// Lightweight OpenBitFun web launcher (`/` on `https://<domain>/`).
//
// Signs in with the email code, discovers the best online device, fetches its
// web UI manifest over the end-to-end encrypted channel (`obp-e2e-v1`), stores
// the manifest in the UI loader Service Worker (`/ui-loader.js`), and hands off
// directly to `/b/<bundleId>/index.html#device=<deviceId>`.
//
// Running sign-in and manifest resolution without downloading the full NSH WASM
// bundle first avoids downloading and compiling the runtime twice whenever the
// target device ships a different bundle than the server's static root.
//
// Contracts preserved:
// - IndexedDB device key: DB `openbitfun-controller`, store `keys`, key `device`
//   (identical to `src/nsh-ui/host.js`, so existing browser sign-ins carry over).
// - End-to-end channel: `obp-e2e-v1` (identical to `host.js` and `obp::e2e`).
// - Frozen handoff v1: sessionStorage `obf.controller.handoff.v1`
//   `{ v: 1, deviceId, at }`.
// - Remote Connect disclaimer key: `openbitfun:remote-connect:disclaimer-agreed:v1`.
//
// Everything is in this one file with no imports, compatible with strict CSP
// (`script-src 'self'`). Unit tests load it via `ObfWebLauncher`.

(function install(scope) {
  "use strict";

  const CONTROLLER_DB = "openbitfun-controller";
  const CONTROLLER_STORE = "keys";
  const CONTROLLER_KEY_ID = "device";
  const HANDOFF_KEY = "obf.controller.handoff.v1";
  const DISCLAIMER_KEY = "openbitfun:remote-connect:disclaimer-agreed:v1";
  const UI_LOADER_STORE_MESSAGE = "obf-ui-store";
  const UI_LOADER_LOOKUP_MESSAGE = "obf-ui-lookup";
  const UI_LOADER_TIMEOUT_MS = 15000;
  // Fast-path cache lookup should resolve locally in a few ms; a short cap avoids
  // stalling when an older Service Worker ignores `obf-ui-lookup` during upgrades.
  const UI_LOADER_LOOKUP_TIMEOUT_MS = 250;
  const CONNECT_TIMEOUT_MS = 45000;
  const E2E_HANDSHAKE_TIMEOUT_MS = 30000;
  const E2E_MAGIC = "OBPE2E1\n";
  const E2E_FINGERPRINT_PREFIX = "obp-e2e-v1:";
  const E2E_KEYS_INFO = "obp-e2e-v1 keys";
  const DEVICE_KDF_SALT = "OpenBitFun Relay v1.0.0 device key";
  const HANDSHAKE_KEY_DOMAIN = "OpenBitFun OBP mesh v1 handshake key";
  const E2E_RECORD_MAX = 34 * 1024 * 1024;
  const E2E_WS_CHUNK = 256 * 1024;
  const BUNDLE_ID_RE = /^[0-9a-f]{64}$/;

  const DEFAULT_STRINGS = {
    "common.close": "Close",
    "signin.title": "Your agents, on every device",
    "signin.body": "Sign in to talk to Super Agent and reach all your devices from here.",
    "signin.email": "Email",
    "signin.emailPlaceholder": "you@example.com",
    "signin.continue": "Continue",
    "signin.codeNote": "We'll email you an 8-digit code.",
    "signin.codeTitle": "Check your email",
    "signin.codeBody": "Enter the code we sent to {{email}}.",
    "signin.signIn": "Sign in",
    "signin.resend": "Send a new code",
    "signin.resendIn": "Send a new code in {{seconds}} s",
    "signin.otherEmail": "Use another email",
    "signin.errCode": "That code didn't work. Check it or send a new one.",
    "signin.errRate": "Too many tries. Try again in {{seconds}} seconds.",
    "signin.errNetwork": "Can't reach OpenBitFun. Check your connection and try again.",
    "signin.errEmail": "Enter a valid email address.",
    "state.offline": "Offline",
    "launcher.checking": "Checking your sign-in…",
    "launcher.opening": "Opening OpenBitFun…",
    "launcher.noneTitle": "None of your devices can open right now",
    "launcher.noneBody": "Open OpenBitFun on a computer signed in with this email, then try again.",
    "launcher.needsUpdate": "Needs an update",
    "launcher.offline": "Offline · {{ago}}",
    "launcher.pageOutdated": "This page is older than your device. Reload to continue.",
    "launcher.verifyFailed": "Something from your device didn't pass a safety check, so nothing ran. Try again.",
    "launcher.encrypted": "End-to-end encrypted",
    "launcher.signOut": "Sign out",
    "launcher.tryAgain": "Try again",
    "controller.error.rateLimited": "Too many attempts. Wait a minute and try again.",
    "controller.error.signedOut": "You were signed out. Sign in again.",
    "controller.error.deviceUiUnavailable": "This device can't be opened in a browser; update OpenBitFun on it.",
    "controller.error.devicesUiUnavailable": "None of your online devices can be opened in a browser yet; update OpenBitFun on them.",
    "controller.error.uiLoad": "{{file}} of your device's interface could not be loaded. Check that the device is online, then try again.",
    "devices.remote.disclaimerTitle": "Remote Connect Disclaimer",
    "devices.remote.disclaimerIntro": "Remote Connect lets you control OpenBitFun on other devices remotely or send tasks from a phone, browser, or chat app. Read and understand the following before enabling it:",
    "devices.remote.disclaimerKeyRisks": "Key risks",
    "devices.remote.disclaimerFullDetails": "View complete security, privacy, network, and compliance details",
    "devices.remote.disclaimerDecline": "Decline",
    "devices.remote.disclaimerAgree": "Agree and Continue",
  };

  const DISCLAIMER_KEY_ITEMS = [
    "devices.remote.disclaimerItemGeneralRisk",
    "devices.remote.disclaimerItemSecurity",
    "devices.remote.disclaimerItemEncryption",
    "devices.remote.disclaimerItemPrivacy",
  ];

  const DISCLAIMER_DETAIL_ITEMS = [
    "devices.remote.disclaimerItemOpenSource",
    "devices.remote.disclaimerItemDataUsage",
    "devices.remote.disclaimerItemCredentials",
    "devices.remote.disclaimerItemQrCode",
    "devices.remote.disclaimerItemRelay",
    "devices.remote.disclaimerItemNetwork",
    "devices.remote.disclaimerItemBot",
    "devices.remote.disclaimerItemBotPersistence",
    "devices.remote.disclaimerItemMobileBrowser",
    "devices.remote.disclaimerItemCompliance",
    "devices.remote.disclaimerItemLiability",
  ];

  const API_CODES = {
    invalid_email: "invalid_email",
    invalid_code: "invalid_code",
    rate_limited: "rate_limited",
    signed_out: "signed_out",
    not_found: "unreachable",
    unavailable: "unavailable",
    bad_origin: "unavailable",
  };

  const ROUTE_RANK = {
    direct_lan: 0,
    direct_ipv6: 1,
    direct_ipv4: 1,
    relayed_peer: 2,
    relayed_server: 3,
  };

  class LauncherError extends Error {
    constructor(code, message, retryAfterSeconds = null, detail = null) {
      super(message);
      this.name = "LauncherError";
      this.code = code;
      this.retryAfterSeconds = retryAfterSeconds;
      this.detail = detail;
    }
  }

  // ── Pure helpers (tested directly in launcher.test.mjs) ──

  function resolveLocale(languages, catalog) {
    const available = catalog && typeof catalog === "object" ? catalog : {};
    const list = Array.isArray(languages) ? languages : [];
    for (const raw of list) {
      const tag = String(raw || "").trim();
      if (!tag) continue;
      if (available[tag]) return tag;
      const lower = tag.toLowerCase();
      if (lower.startsWith("zh")) {
        if (lower.includes("hant") || lower.includes("tw") || lower.includes("hk") || lower.includes("mo")) {
          if (available["zh-TW"]) return "zh-TW";
        }
        if (available["zh-CN"]) return "zh-CN";
      }
      if (lower.startsWith("en") && available["en-US"]) return "en-US";
    }
    return available["en-US"] ? "en-US" : "en-US";
  }

  function createTranslator(catalog, languages) {
    const locale = resolveLocale(languages, catalog);
    const active = (catalog && catalog[locale]) || {};
    const fallback = (catalog && catalog["en-US"]) || DEFAULT_STRINGS;
    function tr(key, vars) {
      let text = active[key] || fallback[key] || DEFAULT_STRINGS[key] || key;
      if (vars && typeof vars === "object") {
        for (const [name, value] of Object.entries(vars)) {
          text = text.replaceAll(`{{${name}}}`, String(value ?? ""));
        }
      }
      return text;
    }
    tr.locale = locale;
    return tr;
  }

  function compareVersions(a, b) {
    if (a === b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    const left = String(a).split(/[.+-]/);
    const right = String(b).split(/[.+-]/);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const x = Number.parseInt(left[i] ?? "0", 10);
      const y = Number.parseInt(right[i] ?? "0", 10);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        const x2 = left[i] ?? "";
        const y2 = right[i] ?? "";
        if (x2 !== y2) return x2 < y2 ? -1 : 1;
      } else if (x !== y) {
        return x - y;
      }
    }
    return 0;
  }

  function routeRank(device) {
    return device && device.route && Object.prototype.hasOwnProperty.call(ROUTE_RANK, device.route)
      ? ROUTE_RANK[device.route]
      : 5;
  }

  function pickUiSourceDevice(devices, tried = new Set(), rankedIds = null) {
    const candidates = (Array.isArray(devices) ? devices : []).filter(
      device => device && device.connectable && !device.unavailable && !tried.has(device.deviceId),
    );
    if (Array.isArray(rankedIds) && rankedIds.length > 0) {
      const byId = new Map(candidates.map(device => [device.deviceId, device]));
      for (const id of rankedIds) {
        const match = byId.get(id);
        if (match) return match;
      }
    }
    candidates.sort(
      (a, b) =>
        compareVersions(b.clientVersion, a.clientVersion) ||
        routeRank(a) - routeRank(b) ||
        Number(Boolean(b.online)) - Number(Boolean(a.online)),
    );
    return candidates[0] || null;
  }

  function parseLauncherFragment(location) {
    const hash = location && typeof location.hash === "string" ? location.hash.replace(/^#/, "") : "";
    let params;
    try {
      params = new URLSearchParams(hash);
    } catch {
      params = new URLSearchParams();
    }
    const reason = params.get("ui-error");
    const file = params.get("file") || null;
    const bundleId = params.get("bundle") || null;
    let failure = null;
    if (reason === "verification") {
      failure = new LauncherError("ui_verification_failed", `${file || "A file"} failed verification`, null, file);
    } else if (reason === "signed_out") {
      failure = new LauncherError("signed_out", "The session ended");
    } else if (reason) {
      failure = new LauncherError("ui_load_failed", `${file || "A file"} could not be loaded`, null, file);
    }
    return {
      showDevices: params.get("switch") === "1" || failure !== null,
      failure,
      uiError: reason ? { reason, file, bundleId } : null,
    };
  }

  function writeHandoff(storage, deviceId, now = Date.now()) {
    const handoff = { v: 1, deviceId, at: now };
    storage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
    return handoff;
  }

  function hasAgreedDisclaimer(storage) {
    if (!storage) return false;
    try {
      if (storage.getItem(DISCLAIMER_KEY) === "true") return true;
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key && key.endsWith(`:${DISCLAIMER_KEY}`) && storage.getItem(key) === "true") {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  function recordDisclaimerAgreed(storage) {
    if (!storage) return;
    try {
      storage.setItem(DISCLAIMER_KEY, "true");
    } catch {
      // Ignore storage quota / privacy mode failures.
    }
  }

  function refusalError(code, reason) {
    const message = String(reason || "").replace(/^[a-z_]+:\s*/, "") || "The device connection closed";
    switch (code) {
      case 4401:
        return new LauncherError("signed_out", message);
      case 4403:
      case 4404:
      case 4408:
        return new LauncherError("unreachable", message);
      case 4426:
        return new LauncherError("unsupported", message);
      case 4429:
      case 4503:
      case 4500:
        return new LauncherError("unavailable", message);
      default:
        return new LauncherError("network", message);
    }
  }

  function uiManifestError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ui_bundle_unavailable|unknown to this OpenBitFun|unsupported|unknown (command|method)|not found/i.test(message)) {
      return new LauncherError("device_ui_unavailable", message.replace(/^[a-z_]+:\s*/, ""));
    }
    return new LauncherError("unavailable", message);
  }

  function uiPrepareError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = message.replace(/^[a-z_]+:\s*/, "");
    if (message.startsWith("ui_bundle_schema:")) return new LauncherError("page_outdated", text);
    if (message.startsWith("controller_unsupported:")) return new LauncherError("unsupported", text);
    if (message.startsWith("ui_bundle_invalid:")) return new LauncherError("device_ui_unavailable", text);
    return new LauncherError("unavailable", text);
  }

  function formatRelativeAgo(epochMs) {
    if (!epochMs || epochMs <= 0) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function validHolders(raw, fallbackDeviceId) {
    const out = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === "string" && item.length > 0 && !out.includes(item)) out.push(item);
      }
    }
    if (out.length === 0 && fallbackDeviceId) out.push(fallbackDeviceId);
    return out;
  }

  // ── WebCrypto & IndexedDB device key (`obp-e2e-v1`, identical to host.js) ──

  const utf8Encode = text => new TextEncoder().encode(text);
  const utf8Decode = bytes => new TextDecoder().decode(bytes);

  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(text) {
    const normalized = String(text).trim().replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function concatBytes(...parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function compareBytes(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  }

  function e2eNonce(counter) {
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, BigInt(counter));
    return nonce;
  }

  function lengthPrefixed(body) {
    const framed = new Uint8Array(4 + body.length);
    new DataView(framed.buffer).setUint32(0, body.length);
    framed.set(body, 4);
    return framed;
  }

  async function hmacSha256(subtle, key, message) {
    const imported = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await subtle.sign("HMAC", imported, message));
  }

  async function hkdfSha256(subtle, ikm, salt, info, bits) {
    const imported = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, imported, bits));
  }

  async function x25519Shared(subtle, privateKey, publicRaw) {
    const peer = await subtle.importKey("raw", publicRaw, { name: "X25519" }, true, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: peer }, privateKey, 256));
    if (shared.every(byte => byte === 0)) throw new Error("the device key is invalid");
    return shared;
  }

  async function devicePairKey(subtle, key, targetPublicKey) {
    const peer = base64ToBytes(targetPublicKey);
    if (peer.length !== 32) throw new Error("the device key is invalid");
    const local = base64ToBytes(key.publicKey);
    const shared = await x25519Shared(subtle, key.privateKey, peer);
    const ordered = compareBytes(local, peer) < 0 ? concatBytes(local, peer) : concatBytes(peer, local);
    return hkdfSha256(subtle, shared, utf8Encode(DEVICE_KDF_SALT), ordered, 256);
  }

  async function meshProof(subtle, handshakeKey, role, claims) {
    const message = [
      "obp-mesh-v1",
      role,
      claims.client,
      claims.server,
      claims.fingerprint,
      String(claims.time),
      claims.nonce,
    ].join("\n");
    return bytesToBase64Url(await hmacSha256(subtle, handshakeKey, utf8Encode(message)));
  }

  function requireSubtle() {
    const subtle = scope.crypto && scope.crypto.subtle;
    if (!subtle || typeof scope.indexedDB === "undefined") {
      throw new LauncherError(
        "unsupported",
        "This browser cannot keep a device key (a secure page with WebCrypto and IndexedDB is required).",
      );
    }
    return subtle;
  }

  function openControllerDb() {
    return new Promise((resolve, reject) => {
      const request = scope.indexedDB.open(CONTROLLER_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(CONTROLLER_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB is unavailable"));
    });
  }

  async function controllerDbRun(mode, run) {
    const db = await openControllerDb();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(CONTROLLER_STORE, mode);
        const request = run(transaction.objectStore(CONTROLLER_STORE));
        transaction.oncomplete = () => resolve(request ? request.result : undefined);
        transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
      });
    } finally {
      db.close();
    }
  }

  let deviceKeyPromise = null;

  function getDeviceKey() {
    if (!deviceKeyPromise) {
      deviceKeyPromise = (async () => {
        const subtle = requireSubtle();
        const stored = await controllerDbRun("readonly", store => store.get(CONTROLLER_KEY_ID));
        if (stored && stored.privateKey && stored.publicKey && stored.deviceId) return stored;
        let pair;
        try {
          pair = await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
        } catch {
          throw new LauncherError("unsupported", "This browser has no X25519 key support; update it.");
        }
        const id = new Uint8Array(16);
        scope.crypto.getRandomValues(id);
        const record = {
          deviceId: `web-${Array.from(id, byte => byte.toString(16).padStart(2, "0")).join("")}`,
          privateKey: pair.privateKey,
          publicKey: bytesToBase64(new Uint8Array(await subtle.exportKey("raw", pair.publicKey))),
          createdAt: Date.now(),
        };
        try {
          await controllerDbRun("readwrite", store => store.add(record, CONTROLLER_KEY_ID));
          return record;
        } catch {
          const winner = await controllerDbRun("readonly", store => store.get(CONTROLLER_KEY_ID));
          if (winner && winner.privateKey) return winner;
          throw new LauncherError("unsupported", "This browser could not store its device key.");
        }
      })();
      deviceKeyPromise.catch(() => {
        deviceKeyPromise = null;
      });
    }
    return deviceKeyPromise;
  }

  async function forgetDeviceKey() {
    deviceKeyPromise = null;
    try {
      await controllerDbRun("readwrite", store => store.delete(CONTROLLER_KEY_ID));
    } catch {
      // Ignore cleanup failure on sign-out.
    }
  }

  // ── One-shot E2EE manifest fetch (`fleet_ui_bundle` -> `ui_bundle_manifest`) ──

  function fetchManifestOverE2e({
    url,
    deviceId,
    devicePublicKey,
    key,
    subtle,
    createSocket,
    timeoutMs = CONNECT_TIMEOUT_MS,
  }) {
    // Prepare X25519 handshake material in parallel with opening the WebSocket.
    const handshakeReady = (async () => {
      const pair = await devicePairKey(subtle, key, devicePublicKey);
      const handshakeKey = await hmacSha256(subtle, pair, utf8Encode(HANDSHAKE_KEY_DOMAIN));
      pair.fill(0);
      const ephemeral = await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
      const eph = bytesToBase64Url(new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey)));
      const nonceBytes = new Uint8Array(16);
      scope.crypto.getRandomValues(nonceBytes);
      const claims = {
        client: key.deviceId,
        server: deviceId,
        fingerprint: `${E2E_FINGERPRINT_PREFIX}${eph}`,
        time: Date.now(),
        nonce: bytesToBase64Url(nonceBytes),
      };
      const proof = await meshProof(subtle, handshakeKey, "client", claims);
      return { handshakeKey, ephemeral, eph, claims, proof };
    })();

    return new Promise((resolve, reject) => {
      let settled = false;
      let ready = false;
      let sendCounter = 0;
      let receiveCounter = 0;
      let sendKey = null;
      let receiveKey = null;
      let handshakeState = null;
      let inbound = Promise.resolve();
      let outbound = Promise.resolve();
      let chunks = [];
      let chunkOffset = 0;
      let bufferedBytes = 0;
      let nextCallId = 1;
      const pendingCalls = new Map();

      const ws = createSocket ? createSocket(url) : new WebSocket(url);
      ws.binaryType = "arraybuffer";

      const timer = setTimeout(() => {
        fail(new LauncherError("unreachable", "The device did not answer in time"));
      }, Math.min(timeoutMs, E2E_HANDSHAKE_TIMEOUT_MS + 15000));

      function sendBytes(bytes) {
        for (let offset = 0; offset < bytes.length; offset += E2E_WS_CHUNK) {
          ws.send(bytes.subarray(offset, Math.min(bytes.length, offset + E2E_WS_CHUNK)));
        }
      }

      function queueRecord(type, payload) {
        outbound = outbound
          .then(async () => {
            if (settled || !sendKey) return;
            const plaintext = concatBytes(new Uint8Array([type]), payload);
            const nonce = e2eNonce(sendCounter);
            sendCounter += 1;
            const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, sendKey, plaintext));
            if (!settled) sendBytes(lengthPrefixed(sealed));
          })
          .catch(err => fail(new LauncherError("unavailable", String(err && err.message ? err.message : err))));
      }

      function sendJson(frame) {
        queueRecord(1, utf8Encode(JSON.stringify({ jsonrpc: "2.0", ...frame })));
      }

      function closeCleanly() {
        const wsRef = ws;
        wsRef.onopen = null;
        wsRef.onmessage = null;
        wsRef.onerror = null;
        wsRef.onclose = null;
        if (ready && sendKey && wsRef.readyState === 1) {
          const reason = utf8Encode("closed");
          const payload = new Uint8Array(2 + reason.length);
          new DataView(payload.buffer).setUint16(0, 1000);
          payload.set(reason, 2);
          const nonce = e2eNonce(sendCounter);
          sendCounter += 1;
          outbound
            .then(() => subtle.encrypt({ name: "AES-GCM", iv: nonce }, sendKey, concatBytes(new Uint8Array([5]), payload)))
            .then(sealed => {
              if (wsRef.readyState === 1) sendBytes(lengthPrefixed(new Uint8Array(sealed)));
            })
            .catch(() => undefined)
            .finally(() => {
              try {
                if (wsRef.readyState <= 1) wsRef.close(1000, "closed");
              } catch {}
            });
        } else {
          try {
            if (wsRef.readyState <= 1) wsRef.close(1000, "closed");
          } catch {}
        }
      }

      function cleanup() {
        clearTimeout(timer);
        chunks = [];
        chunkOffset = 0;
        bufferedBytes = 0;
        pendingCalls.clear();
      }

      function succeed(value) {
        if (settled) return;
        settled = true;
        closeCleanly();
        cleanup();
        resolve(value);
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        closeCleanly();
        cleanup();
        reject(error instanceof LauncherError ? error : new LauncherError("unavailable", String(error && error.message ? error.message : error)));
      }

      function callCommand(command, args) {
        return new Promise((res, rej) => {
          const id = nextCallId;
          nextCallId += 1;
          pendingCalls.set(id, { resolve: res, reject: rej });
          sendJson({ id, method: "call", params: { command, args } });
        });
      }

      async function onHelloResult(result) {
        const hasFleet = Boolean(result && result.fleet && typeof result.fleet === "object");
        if (hasFleet) {
          try {
            const fleetAnswer = await callCommand("fleet_ui_bundle", { request: {} });
            if (fleetAnswer && typeof fleetAnswer.manifest === "object" && fleetAnswer.manifest !== null) {
              const ownerDeviceId =
                typeof fleetAnswer.ownerDeviceId === "string" && fleetAnswer.ownerDeviceId
                  ? fleetAnswer.ownerDeviceId
                  : deviceId;
              succeed({
                manifest: fleetAnswer.manifest,
                statedBundleId: typeof fleetAnswer.bundleId === "string" ? fleetAnswer.bundleId : null,
                ownerDeviceId,
                holders: validHolders(fleetAnswer.holders, ownerDeviceId),
              });
              return;
            }
          } catch {
            // Fall back to direct `ui_bundle_manifest`.
          }
        }
        try {
          const answer = await callCommand("ui_bundle_manifest", { request: {} });
          if (!answer || typeof answer.manifest !== "object" || answer.manifest === null) {
            fail(new LauncherError("device_ui_unavailable", "The device answered no web UI manifest"));
            return;
          }
          succeed({
            manifest: answer.manifest,
            statedBundleId: typeof answer.bundleId === "string" ? answer.bundleId : null,
            ownerDeviceId: deviceId,
            holders: [deviceId],
          });
        } catch (err) {
          fail(uiManifestError(err));
        }
      }

      function handleRpcText(text) {
        let frame;
        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }
        if (frame.method === "event") return;
        if (frame.id === 0) {
          if (frame.error) {
            fail(new LauncherError("unavailable", String(frame.error.message || "hello failed")));
            return;
          }
          void onHelloResult(frame.result || {});
          return;
        }
        if (typeof frame.id === "number" && pendingCalls.has(frame.id)) {
          const waiter = pendingCalls.get(frame.id);
          pendingCalls.delete(frame.id);
          if (frame.error) waiter.reject(new Error(String(frame.error.message || "command failed")));
          else waiter.resolve(frame.result);
        }
      }

      async function handleServerHello(body) {
        let answer;
        try {
          answer = JSON.parse(utf8Decode(body));
        } catch {
          fail(new LauncherError("unsupported", "OpenBitFun on that device is too old for browser control; update it"));
          return;
        }
        if (answer && typeof answer.error === "string") {
          const code = answer.error === "not_account_device" ? 4403 : answer.error === "mesh_signed_out" ? 4404 : 4401;
          fail(refusalError(code, `${answer.error}: ${answer.message || "the device refused the connection"}`));
          return;
        }
        const { handshakeKey, ephemeral, eph, claims, proof } = handshakeState || (await handshakeReady);
        const serverClaims = { ...claims, fingerprint: `${E2E_FINGERPRINT_PREFIX}${eph}:${answer.eph}` };
        const expected = await meshProof(subtle, handshakeKey, "server", serverClaims);
        if (typeof answer.proof !== "string" || answer.proof !== expected) {
          fail(refusalError(4403, "impostor: the device could not prove it is your device"));
          return;
        }
        const shared = await x25519Shared(subtle, ephemeral.privateKey, base64ToBytes(answer.eph));
        const okm = await hkdfSha256(
          subtle,
          shared,
          handshakeKey,
          utf8Encode(`${E2E_KEYS_INFO}\n${proof}\n${answer.proof}`),
          512,
        );
        sendKey = await subtle.importKey("raw", okm.slice(0, 32), "AES-GCM", false, ["encrypt"]);
        receiveKey = await subtle.importKey("raw", okm.slice(32, 64), "AES-GCM", false, ["decrypt"]);
        okm.fill(0);
        shared.fill(0);
        ready = true;
        sendJson({
          id: 0,
          method: "hello",
          params: {
            protocol: 1,
            client: "openbitfun-web-controller",
            ack: true,
            creditBytes: 1024 * 1024,
            fleet: { protocol: 1, cursor: {} },
          },
        });
      }

      async function handleRecord(body) {
        if (!ready) {
          await handleServerHello(body);
          return;
        }
        const nonce = e2eNonce(receiveCounter);
        receiveCounter += 1;
        const plaintext = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, receiveKey, body));
        const type = plaintext[0];
        const payload = plaintext.subarray(1);
        if (type === 1) {
          handleRpcText(utf8Decode(payload));
        } else if (type === 3) {
          queueRecord(4, payload.slice());
        } else if (type === 5) {
          const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          const code = payload.length >= 2 ? view.getUint16(0) : 1000;
          const reason = payload.length > 2 ? utf8Decode(payload.subarray(2)) : "closed by the device";
          fail(refusalError(code, reason));
        }
      }

      function peekRecordLength() {
        const first = chunks[0];
        if (first && first.length - chunkOffset >= 4) {
          return new DataView(first.buffer, first.byteOffset + chunkOffset, 4).getUint32(0);
        }
        const header = new Uint8Array(4);
        let written = 0;
        let idx = 0;
        let off = chunkOffset;
        while (written < 4 && idx < chunks.length) {
          const c = chunks[idx];
          const take = Math.min(4 - written, c.length - off);
          header.set(c.subarray(off, off + take), written);
          written += take;
          idx += 1;
          off = 0;
        }
        return new DataView(header.buffer).getUint32(0);
      }

      function takeBytes(skip, length) {
        let rem = skip;
        while (rem > 0 && chunks.length > 0) {
          const head = chunks[0];
          const avail = head.length - chunkOffset;
          if (rem < avail) {
            chunkOffset += rem;
            bufferedBytes -= rem;
            rem = 0;
          } else {
            chunks.shift();
            chunkOffset = 0;
            bufferedBytes -= avail;
            rem -= avail;
          }
        }
        const out = new Uint8Array(length);
        let written = 0;
        while (written < length && chunks.length > 0) {
          const head = chunks[0];
          const avail = head.length - chunkOffset;
          const take = Math.min(length - written, avail);
          out.set(head.subarray(chunkOffset, chunkOffset + take), written);
          written += take;
          bufferedBytes -= take;
          if (take === avail) {
            chunks.shift();
            chunkOffset = 0;
          } else {
            chunkOffset += take;
          }
        }
        if (bufferedBytes === 0) {
          chunks = [];
          chunkOffset = 0;
        }
        return out;
      }

      function receiveBytes(chunk) {
        if (chunk.length > 0) {
          chunks.push(chunk);
          bufferedBytes += chunk.length;
        }
        for (;;) {
          if (bufferedBytes < 4) return;
          const length = peekRecordLength();
          if (length > E2E_RECORD_MAX) {
            fail(new LauncherError("unavailable", "An oversized record was received"));
            return;
          }
          if (bufferedBytes < 4 + length) return;
          const body = takeBytes(4, length);
          inbound = inbound
            .then(() => (settled ? undefined : handleRecord(body)))
            .catch(err => fail(new LauncherError("unavailable", String(err && err.message ? err.message : err))));
        }
      }

      handshakeReady.catch(err =>
        fail(err instanceof LauncherError ? err : new LauncherError("unavailable", String(err && err.message ? err.message : err))),
      );

      ws.onopen = () => {
        if (settled) return;
        handshakeReady
          .then(state => {
            if (settled) return;
            handshakeState = state;
            const { claims, eph, proof } = state;
            const hello = utf8Encode(
              JSON.stringify({
                v: 1,
                device: claims.client,
                target: claims.server,
                time: claims.time,
                nonce: claims.nonce,
                eph,
                proof,
              }),
            );
            sendBytes(concatBytes(utf8Encode(E2E_MAGIC), lengthPrefixed(hello)));
          })
          .catch(err =>
            fail(err instanceof LauncherError ? err : new LauncherError("unavailable", String(err && err.message ? err.message : err))),
          );
      };
      ws.onmessage = event => {
        if (settled) return;
        const data = event && event.data;
        if (ArrayBuffer.isView(data)) {
          receiveBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        } else if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
          receiveBytes(new Uint8Array(data));
        }
      };
      ws.onerror = () => undefined;
      ws.onclose = event => {
        if (settled) return;
        if (!ready && event.code === 1000) {
          fail(new LauncherError("unsupported", "OpenBitFun on that device is too old for browser control; update it"));
          return;
        }
        fail(refusalError(event.code || 1006, event.reason || "The connection to the gateway closed"));
      };
    });
  }

  // ── Service Worker registration and manifest handoff ──

  function waitForActiveWorker(registration) {
    return new Promise((resolve, reject) => {
      if (registration.active && registration.active.state === "activated") {
        resolve(registration.active);
        return;
      }
      const worker = registration.installing || registration.waiting || registration.active;
      if (!worker) {
        reject(new Error("the UI loader did not install"));
        return;
      }
      if (worker.state === "activated") {
        resolve(worker);
        return;
      }
      const finish = (err, value) => {
        clearTimeout(timer);
        if (typeof worker.removeEventListener === "function") worker.removeEventListener("statechange", onStateChange);
        if (err) reject(err);
        else resolve(value);
      };
      const onStateChange = () => {
        if (worker.state === "activated") finish(null, worker);
        else if (worker.state === "redundant") {
          if (registration.active && registration.active.state === "activated") finish(null, registration.active);
          else finish(new Error("the UI loader was replaced while starting"));
        }
      };
      const timer = setTimeout(() => finish(new Error("the UI loader did not start in time")), UI_LOADER_TIMEOUT_MS);
      worker.addEventListener("statechange", onStateChange);
    });
  }

  function askWorker(worker, message, timeoutMs = UI_LOADER_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error("the UI loader did not answer"));
      }, timeoutMs);
      channel.port1.onmessage = event => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(event.data || { ok: false, error: "the UI loader answered nothing" });
      };
      worker.postMessage(message, [channel.port2]);
    });
  }

  // ── Browser runtime controller UI ──

  function startApp(window) {
    const doc = window.document;
    const root = doc.getElementById("root");
    if (!root) return;

    const paramsEl = doc.getElementById("nsh-params");
    const i18nEl = doc.getElementById("obf-launcher-i18n");
    const params = paramsEl ? JSON.parse(paramsEl.textContent || "{}") : {};
    const catalog = i18nEl ? JSON.parse(i18nEl.textContent || "{}") : {};
    const controller = params.controller || {};
    const baseHref = new URL(".", doc.baseURI || window.location.href).href;
    const apiBase = new URL(controller.api || "/obp/api/v1", baseHref).href.replace(/\/$/, "");
    const gatewayUrl = new URL(controller.gateway || "/obp", baseHref);
    if (gatewayUrl.protocol === "https:") gatewayUrl.protocol = "wss:";
    else if (gatewayUrl.protocol === "http:") gatewayUrl.protocol = "ws:";
    const gatewayBase = gatewayUrl.href.replace(/\/$/, "");

    const tr = createTranslator(catalog, window.navigator.languages || [window.navigator.language || "en-US"]);

    // Register the UI loader Service Worker immediately in parallel with auth/devices.
    let swPromise = null;
    function ensureUiWorker() {
      if (!swPromise) {
        swPromise = (async () => {
          const container = window.navigator && window.navigator.serviceWorker;
          if (!container) {
            throw new LauncherError(
              "unsupported",
              "This browser cannot open a device's interface here (Service Workers are off, for example in a private window).",
            );
          }
          const registration = await container.register(new URL("ui-loader.js", baseHref).href, {
            scope: new URL("b/", baseHref).href,
            updateViaCache: "none",
          });
          return waitForActiveWorker(registration);
        })();
        swPromise.catch(() => {
          swPromise = null;
        });
      }
      return swPromise;
    }
    if (window.navigator && window.navigator.serviceWorker) {
      void ensureUiWorker().catch(() => undefined);
    }

    const state = {
      phase: "starting", // starting | email | code | opening | devices
      account: null,
      email: "",
      code: "",
      challenge: null,
      resendAt: null,
      devices: [],
      entryCandidates: [],
      connectingId: null,
      busy: false,
      failure: null,
      disclaimerOpen: false,
      disclaimerDetails: false,
      pendingDisclaimerAction: null,
    };

    let resendTimer = null;

    function failureMessage(failure) {
      if (!failure) return "";
      switch (failure.code) {
        case "invalid_email":
          return tr("signin.errEmail");
        case "invalid_code":
          return tr("signin.errCode");
        case "rate_limited":
          return failure.retryAfterSeconds
            ? tr("signin.errRate", { seconds: String(failure.retryAfterSeconds) })
            : tr("controller.error.rateLimited");
        case "signed_out":
          return tr("controller.error.signedOut");
        case "network":
          return tr("signin.errNetwork");
        case "device_ui_unavailable":
          return failure.detail === "all"
            ? tr("controller.error.devicesUiUnavailable")
            : tr("controller.error.deviceUiUnavailable");
        case "page_outdated":
          return tr("launcher.pageOutdated");
        case "ui_verification_failed":
          return tr("launcher.verifyFailed");
        case "ui_load_failed":
          return tr("controller.error.uiLoad", { file: failure.detail || "" });
        default:
          return failure.message || "";
      }
    }

    async function apiRequest(path, init = {}) {
      let response;
      try {
        response = await window.fetch(`${apiBase}${path}`, {
          method: init.method || "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers:
            init.body === undefined
              ? { Accept: "application/json" }
              : { "Content-Type": "application/json", Accept: "application/json" },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
      } catch {
        throw new LauncherError("network", "Could not reach OpenBitFun; check the connection");
      }
      let parsed = {};
      try {
        const text = await response.text();
        parsed = text ? JSON.parse(text) : {};
      } catch {
        // Non-JSON proxy error page.
      }
      if (!response.ok) {
        const code = API_CODES[String(parsed.error || "")] || (response.status === 401 ? "signed_out" : "unavailable");
        const message =
          typeof parsed.message === "string" && parsed.message
            ? parsed.message
            : `The server answered HTTP ${response.status}`;
        const retry = typeof parsed.retryAfterSeconds === "number" ? parsed.retryAfterSeconds : null;
        throw new LauncherError(code, message, retry);
      }
      return parsed;
    }

    async function openDeviceBundle(device) {
      state.connectingId = device.deviceId;
      render();
      const inlineKey = typeof device.publicKey === "string" && device.publicKey.length > 0 ? device.publicKey : null;
      const [keyAnswer, key, worker] = await Promise.all([
        inlineKey ? Promise.resolve({ publicKey: inlineKey }) : apiRequest(`/devices/${encodeURIComponent(device.deviceId)}/key`),
        getDeviceKey(),
        ensureUiWorker().catch(err => {
          throw uiPrepareError(err);
        }),
      ]);
      const devicePublicKey = typeof keyAnswer.publicKey === "string" ? keyAnswer.publicKey : "";
      if (!devicePublicKey) throw new LauncherError("unreachable", "This device has no key in your account");

      const resolved = await fetchManifestOverE2e({
        url: `${gatewayBase}/${encodeURIComponent(device.deviceId)}`,
        deviceId: device.deviceId,
        devicePublicKey,
        key,
        subtle: requireSubtle(),
      });

      const extraHolders = resolved.holders.filter(id => id !== resolved.ownerDeviceId);
      const payload = {
        type: UI_LOADER_STORE_MESSAGE,
        manifest: resolved.manifest,
        deviceId: resolved.ownerDeviceId,
        entryDeviceId: device.deviceId,
        ...(extraHolders.length > 0 ? { holders: resolved.holders } : {}),
      };

      let answer;
      try {
        answer = await askWorker(worker, payload);
      } catch (err) {
        throw uiPrepareError(err);
      }
      if (!answer.ok || typeof answer.bundleId !== "string" || !BUNDLE_ID_RE.test(answer.bundleId)) {
        throw uiPrepareError(new Error(answer.error || "ui_bundle_invalid: no bundle id"));
      }

      try {
        writeHandoff(window.sessionStorage, device.deviceId);
      } catch {
        throw new LauncherError(
          "unsupported",
          "This browser cannot hand the device over to its interface (sessionStorage is off).",
        );
      }

      const target = new URL(`b/${answer.bundleId}/index.html`, baseHref);
      target.hash = `device=${encodeURIComponent(device.deviceId)}`;
      window.location.replace(target.href);
    }

    async function tryFastPathBundle(device) {
      let worker;
      try {
        worker = await ensureUiWorker();
      } catch {
        return false;
      }
      let lookup;
      try {
        lookup = await askWorker(
          worker,
          { type: UI_LOADER_LOOKUP_MESSAGE, deviceId: device.deviceId },
          UI_LOADER_LOOKUP_TIMEOUT_MS,
        );
      } catch {
        return false;
      }
      if (!lookup || !lookup.ok || typeof lookup.bundleId !== "string" || !BUNDLE_ID_RE.test(lookup.bundleId)) {
        return false;
      }
      if (device.clientVersion && lookup.version && compareVersions(device.clientVersion, lookup.version) > 0) {
        return false;
      }
      try {
        writeHandoff(window.sessionStorage, device.deviceId);
      } catch {
        return false;
      }
      const target = new URL(`b/${lookup.bundleId}/index.html`, baseHref);
      target.hash = `device=${encodeURIComponent(device.deviceId)}`;
      window.location.replace(target.href);
      return true;
    }

    async function loadDevicesAndConnect(showListOnly, initialFailure, preloadedPayload = null) {
      state.phase = "opening";
      state.failure = null;
      state.connectingId = null;
      render();
      let payload = preloadedPayload;
      if (!payload) {
        try {
          payload = await apiRequest("/devices");
        } catch (err) {
          const failure = err instanceof LauncherError ? err : new LauncherError("unavailable", String(err));
          state.failure = failure;
          if (failure.code === "signed_out") {
            state.account = null;
            state.phase = "email";
          } else {
            state.phase = "devices";
          }
          render();
          return;
        }
      }

      state.devices = Array.isArray(payload.devices) ? payload.devices : [];
      state.entryCandidates = Array.isArray(payload.entryCandidates)
        ? payload.entryCandidates.filter(id => typeof id === "string" && id.length > 0)
        : [];

      if (showListOnly) {
        state.failure = initialFailure || null;
        state.phase = "devices";
        render();
        return;
      }

      const tried = new Set();
      let next = pickUiSourceDevice(state.devices, tried, state.entryCandidates);
      if (next && !initialFailure && (await tryFastPathBundle(next))) {
        return;
      }
      let tooOld = 0;
      while (next) {
        tried.add(next.deviceId);
        try {
          await openDeviceBundle(next);
          return;
        } catch (err) {
          const failure = err instanceof LauncherError ? err : new LauncherError("unavailable", String(err));
          state.failure = failure;
          state.connectingId = null;
          if (failure.code === "signed_out") {
            state.account = null;
            state.phase = "email";
            render();
            return;
          }
          if (failure.code === "page_outdated") break;
          if (failure.code === "device_ui_unavailable") tooOld += 1;
        }
        next = pickUiSourceDevice(state.devices, tried, state.entryCandidates);
      }

      if (tried.size > 1 && tooOld === tried.size) {
        state.failure = new LauncherError(
          "device_ui_unavailable",
          "Every online device is too old to open in a browser",
          null,
          "all",
        );
      }
      state.phase = state.account ? "devices" : "email";
      render();
    }

    async function connectFromList(device) {
      if (state.connectingId || !device.connectable) return;
      state.failure = null;
      try {
        await openDeviceBundle(device);
      } catch (err) {
        const failure = err instanceof LauncherError ? err : new LauncherError("unavailable", String(err));
        state.failure = failure;
        state.connectingId = null;
        if (failure.code === "signed_out") {
          state.account = null;
          state.phase = "email";
        }
        render();
      }
    }

    async function requestCode(email) {
      const trimmed = String(email || "").trim();
      if (!trimmed || state.busy) return;
      if (!hasAgreedDisclaimer(window.localStorage)) {
        state.disclaimerOpen = true;
        state.disclaimerDetails = false;
        state.pendingDisclaimerAction = () => requestCode(trimmed);
        render();
        return;
      }
      state.busy = true;
      state.failure = null;
      render();
      try {
        const answer = await apiRequest("/auth/code", {
          method: "POST",
          body: { email: trimmed, locale: tr.locale },
        });
        const retrySeconds = typeof answer.retryAfterSeconds === "number" ? answer.retryAfterSeconds : 60;
        state.challenge = {
          challengeId: String(answer.challengeId || ""),
          email: String(answer.email || trimmed),
          codeLength: typeof answer.codeLength === "number" ? answer.codeLength : 8,
          retryAfterSeconds: retrySeconds,
        };
        state.resendAt = Date.now() + retrySeconds * 1000;
        state.code = "";
        state.phase = "code";
        startResendTicker();
      } catch (err) {
        state.failure = err instanceof LauncherError ? err : new LauncherError("unavailable", String(err));
      } finally {
        state.busy = false;
        render();
      }
    }

    async function verifyCode(code) {
      const normalized = String(code || "").replace(/\s+/g, "");
      if (!state.challenge || !normalized || state.busy) return;
      state.busy = true;
      state.failure = null;
      render();
      try {
        const key = await getDeviceKey();
        const answer = await apiRequest("/auth/verify", {
          method: "POST",
          body: {
            challengeId: state.challenge.challengeId,
            code: normalized,
            device: { deviceId: key.deviceId, publicKey: key.publicKey },
          },
        });
        state.account = answer.account || { signedIn: true };
        state.challenge = null;
        state.code = "";
        state.busy = false;
        stopResendTicker();
        await loadDevicesAndConnect(false, null);
        return;
      } catch (err) {
        state.failure = err instanceof LauncherError ? err : new LauncherError("unavailable", String(err));
        state.busy = false;
        render();
      }
    }

    async function signOut() {
      if (state.busy) return;
      state.busy = true;
      state.failure = null;
      render();
      try {
        await apiRequest("/auth/sign-out", { method: "POST" });
      } catch {
        // Proceed to local cleanup even if network failed.
      } finally {
        await forgetDeviceKey();
        state.account = null;
        state.devices = [];
        state.entryCandidates = [];
        state.challenge = null;
        state.code = "";
        state.connectingId = null;
        state.busy = false;
        state.phase = "email";
        render();
      }
    }

    function stopResendTicker() {
      if (resendTimer !== null) {
        clearInterval(resendTimer);
        resendTimer = null;
      }
    }

    function startResendTicker() {
      stopResendTicker();
      resendTimer = setInterval(() => {
        if (!state.resendAt || Date.now() >= state.resendAt) {
          state.resendAt = null;
          stopResendTicker();
        }
        const btn = doc.getElementById("launcher-resend-btn");
        if (btn) {
          const left = state.resendAt ? Math.max(0, Math.ceil((state.resendAt - Date.now()) / 1000)) : 0;
          btn.disabled = state.busy || left > 0;
          btn.textContent = left > 0 ? tr("signin.resendIn", { seconds: String(left) }) : tr("signin.resend");
        }
      }, 1000);
    }

    // ── DOM rendering ──

    function el(tag, attrs, ...children) {
      const node = doc.createElement(tag);
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          if (v === undefined || v === null || v === false) continue;
          if (k === "className") node.className = v;
          else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
          else if (v === true) node.setAttribute(k, "");
          else node.setAttribute(k, String(v));
        }
      }
      for (const child of children) {
        if (child === undefined || child === null || child === false) continue;
        node.append(typeof child === "string" ? doc.createTextNode(child) : child);
      }
      return node;
    }

    function lockIcon() {
      const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "1.8");
      const rect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", "5");
      rect.setAttribute("y", "11");
      rect.setAttribute("width", "14");
      rect.setAttribute("height", "10");
      rect.setAttribute("rx", "2");
      const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M8 11V7a4 4 0 0 1 8 0v4");
      svg.append(rect, path);
      return svg;
    }

    function brandHeader() {
      const img = el("img", { className: "brand-mark", src: "/favicon.svg", alt: "" });
      return el("div", { className: "brand" }, img, el("span", { className: "brand-name" }, "OpenBitFun"));
    }

    function renderDisclaimerModal() {
      if (!state.disclaimerOpen) return null;
      const keyItems = DISCLAIMER_KEY_ITEMS.map(k => tr(k)).filter(Boolean);
      const detailItems = DISCLAIMER_DETAIL_ITEMS.map(k => tr(k)).filter(Boolean);
      const detailsList = state.disclaimerDetails
        ? el(
            "ol",
            { className: "disclaimer-list", start: String(keyItems.length + 1) },
            ...detailItems.map(item => el("li", null, item)),
          )
        : null;
      const backdrop = el(
        "div",
        {
          className: "modal-backdrop",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "remote-disclaimer-modal",
        },
        el(
          "div",
          { className: "modal" },
          el("div", { className: "modal-header" }, tr("devices.remote.disclaimerTitle")),
          el(
            "div",
            { className: "modal-body" },
            el("p", { style: "margin:0" }, tr("devices.remote.disclaimerIntro")),
            el("p", { className: "modal-section-title" }, tr("devices.remote.disclaimerKeyRisks")),
            el("ol", { className: "disclaimer-list" }, ...keyItems.map(item => el("li", null, item))),
            detailItems.length > 0
              ? el(
                  "button",
                  {
                    type: "button",
                    className: "btn-link",
                    style: "align-self:flex-start;padding-left:0",
                    onClick: () => {
                      state.disclaimerDetails = !state.disclaimerDetails;
                      render();
                    },
                  },
                  `${state.disclaimerDetails ? "▾" : "▸"} ${tr("devices.remote.disclaimerFullDetails")}`,
                )
              : null,
            detailsList,
          ),
          el(
            "div",
            { className: "modal-footer" },
            el(
              "button",
              {
                type: "button",
                className: "btn btn-secondary",
                "aria-label": "remote-disclaimer-decline",
                onClick: () => {
                  state.disclaimerOpen = false;
                  state.pendingDisclaimerAction = null;
                  render();
                },
              },
              tr("devices.remote.disclaimerDecline"),
            ),
            el(
              "button",
              {
                type: "button",
                className: "btn btn-primary",
                "aria-label": "remote-disclaimer-agree",
                onClick: () => {
                  recordDisclaimerAgreed(window.localStorage);
                  const nextAction = state.pendingDisclaimerAction;
                  state.disclaimerOpen = false;
                  state.pendingDisclaimerAction = null;
                  render();
                  if (nextAction) void nextAction();
                },
              },
              tr("devices.remote.disclaimerAgree"),
            ),
          ),
        ),
      );
      return backdrop;
    }

    function renderMain() {
      if (state.phase === "starting" || state.phase === "opening") {
        const label = state.phase === "starting" ? tr("launcher.checking") : tr("launcher.opening");
        return el(
          "div",
          {
            className: "opening",
            role: "status",
            "aria-live": "polite",
            "aria-label": state.phase === "starting" ? "controller-starting" : "controller-opening",
          },
          el("div", { className: "spinner", "aria-label": "Loading" }),
          el("div", { className: "opening-label" }, label),
        );
      }

      if (state.phase === "email") {
        const input = el("input", {
          id: "controller-email-input",
          className: "input",
          type: "email",
          autocomplete: "email",
          placeholder: tr("signin.emailPlaceholder"),
          value: state.email,
          disabled: state.busy,
          "aria-label": "controller-email-input",
        });
        input.value = state.email;
        input.addEventListener("input", () => {
          state.email = input.value;
          if (state.failure) {
            state.failure = null;
            const errEl = doc.getElementById("launcher-error");
            if (errEl) errEl.textContent = "";
          }
        });
        const form = el(
          "form",
          {
            "aria-label": "controller-email",
            onSubmit: event => {
              event.preventDefault();
              void requestCode(state.email);
            },
          },
          brandHeader(),
          el("h1", null, tr("signin.title")),
          el("p", { className: "subtitle" }, tr("signin.body")),
          el("div", { className: "field" }, el("label", { for: "controller-email-input" }, tr("signin.email")), input),
          el("p", { className: "note" }, tr("signin.codeNote")),
          state.failure ? el("p", { id: "launcher-error", className: "error", role: "alert" }, failureMessage(state.failure)) : null,
          el(
            "button",
            {
              type: "submit",
              className: "btn btn-primary",
              disabled: state.busy,
              "aria-label": "controller-continue",
            },
            state.busy ? el("span", { className: "spinner sm" }) : null,
            tr("signin.continue"),
          ),
        );
        return form;
      }

      if (state.phase === "code") {
        const expectedLen = (state.challenge && state.challenge.codeLength) || 8;
        const input = el("input", {
          id: "controller-code-input",
          className: "input code",
          type: "text",
          inputmode: "numeric",
          autocomplete: "one-time-code",
          placeholder: "0".repeat(expectedLen),
          disabled: state.busy,
          "aria-label": "controller-code-input",
        });
        input.value = state.code;
        input.addEventListener("input", () => {
          state.code = input.value;
          const digits = input.value.replace(/\s+/g, "");
          if (digits.length === expectedLen && /^\d+$/.test(digits) && !state.busy) {
            void verifyCode(digits);
          }
        });
        const left = state.resendAt ? Math.max(0, Math.ceil((state.resendAt - Date.now()) / 1000)) : 0;
        const form = el(
          "form",
          {
            "aria-label": "controller-code",
            onSubmit: event => {
              event.preventDefault();
              void verifyCode(state.code);
            },
          },
          brandHeader(),
          el("h1", null, tr("signin.codeTitle")),
          el("p", { className: "subtitle" }, tr("signin.codeBody", { email: (state.challenge && state.challenge.email) || state.email })),
          el("div", { className: "field" }, input),
          state.failure ? el("p", { id: "launcher-error", className: "error", role: "alert" }, failureMessage(state.failure)) : null,
          el(
            "button",
            {
              type: "submit",
              className: "btn btn-primary",
              disabled: state.busy,
              "aria-label": "controller-sign-in",
            },
            state.busy ? el("span", { className: "spinner sm" }) : null,
            tr("signin.signIn"),
          ),
          el(
            "div",
            { className: "code-actions" },
            el(
              "button",
              {
                id: "launcher-resend-btn",
                type: "button",
                className: "btn-link",
                disabled: state.busy || left > 0,
                onClick: () => {
                  state.code = "";
                  void requestCode((state.challenge && state.challenge.email) || state.email);
                },
              },
              left > 0 ? tr("signin.resendIn", { seconds: String(left) }) : tr("signin.resend"),
            ),
            el(
              "button",
              {
                type: "button",
                className: "btn-link",
                disabled: state.busy,
                onClick: () => {
                  stopResendTicker();
                  state.challenge = null;
                  state.code = "";
                  state.failure = null;
                  state.phase = "email";
                  render();
                },
              },
              tr("signin.otherEmail"),
            ),
          ),
        );
        return form;
      }

      // Devices / failure state
      const rows = state.devices.map(device => {
        const usable = Boolean(device.connectable) && !state.connectingId;
        let statusText = "";
        let warn = false;
        if (device.unavailable) {
          if (device.unavailable.code === "offline" || !device.online) {
            const ago = formatRelativeAgo(device.lastSeenAt);
            statusText = ago ? tr("launcher.offline", { ago }) : tr("state.offline");
          } else if (device.unavailable.code === "update_required" || device.unavailable.code === "unsupported") {
            statusText = tr("launcher.needsUpdate");
            warn = true;
          } else {
            statusText = device.unavailable.message || "";
          }
        }
        return el(
          "button",
          {
            type: "button",
            className: "device-row",
            disabled: !usable,
            "aria-label": `controller-connect-${device.deviceId}`,
            onClick: () => void connectFromList(device),
          },
          el("span", { className: "device-name" }, device.name || device.deviceId),
          statusText ? el("span", { className: `device-status${warn ? " warn" : ""}` }, statusText) : null,
          state.connectingId === device.deviceId
            ? el("span", { className: "spinner sm" })
            : device.connectable
              ? el("span", { className: "chevron" }, "›")
              : null,
        );
      });

      return el(
        "div",
        { "aria-label": "controller-devices" },
        brandHeader(),
        el("h1", null, tr("launcher.noneTitle")),
        el("p", { className: "subtitle" }, state.failure ? failureMessage(state.failure) : tr("launcher.noneBody")),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-primary",
            disabled: Boolean(state.connectingId),
            onClick: () => void boot(false),
          },
          tr("launcher.tryAgain"),
        ),
        rows.length > 0 ? el("div", { className: "devices-list" }, ...rows) : null,
      );
    }

    function renderFooter() {
      return el(
        "footer",
        { className: "footer" },
        lockIcon(),
        el("span", null, tr("launcher.encrypted")),
        state.account ? el("span", null, "·") : null,
        state.account
          ? el(
              "button",
              {
                type: "button",
                className: "btn-link",
                "aria-label": "controller-sign-out",
                onClick: () => void signOut(),
              },
              tr("launcher.signOut"),
            )
          : null,
      );
    }

    function render() {
      const centered = state.phase === "starting" || state.phase === "opening";
      const main = el("main", { className: "main" }, renderMain());
      const modal = renderDisclaimerModal();
      root.replaceChildren(
        el("div", { className: `spacer-top${centered ? " centered" : ""}` }),
        main,
        el("div", { className: `spacer-bottom${centered ? " centered" : ""}` }),
        renderFooter(),
      );
      if (modal) root.append(modal);
      if (state.phase === "email" && !state.disclaimerOpen) {
        const input = doc.getElementById("controller-email-input");
        if (input && doc.activeElement !== input) input.focus();
      } else if (state.phase === "code") {
        const input = doc.getElementById("controller-code-input");
        if (input && doc.activeElement !== input) input.focus();
      }
    }

    async function boot(readFragment) {
      state.phase = "starting";
      state.failure = null;
      render();
      const fragment = readFragment ? parseLauncherFragment(window.location) : { showDevices: false, failure: null };
      if (readFragment && (fragment.uiError || fragment.showDevices)) {
        try {
          window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
        } catch {}
      }
      try {
        const session = await apiRequest("/session?include=devices");
        if (session.signedIn === true) {
          state.account = session.account || { signedIn: true };
          const preloaded = Array.isArray(session.devices)
            ? { devices: session.devices, entryCandidates: session.entryCandidates, cloudNode: session.cloudNode }
            : null;
          await loadDevicesAndConnect(fragment.showDevices, fragment.failure, preloaded);
          return;
        }
        state.account = null;
        if (fragment.failure) state.failure = fragment.failure;
        state.phase = "email";
        render();
      } catch (err) {
        state.failure = err instanceof LauncherError ? err : new LauncherError("network", String(err));
        state.phase = "email";
        render();
      }
    }

    void boot(true);
  }

  scope.ObfWebLauncher = {
    HANDOFF_KEY,
    DISCLAIMER_KEY,
    LauncherError,
    resolveLocale,
    createTranslator,
    compareVersions,
    pickUiSourceDevice,
    parseLauncherFragment,
    writeHandoff,
    hasAgreedDisclaimer,
    recordDisclaimerAgreed,
    refusalError,
    uiManifestError,
    uiPrepareError,
    devicePairKey,
    meshProof,
    e2eNonce,
    lengthPrefixed,
    fetchManifestOverE2e,
    waitForActiveWorker,
    askWorker,
  };

  if (scope.document && scope.window === scope) {
    if (scope.document.readyState === "loading") {
      scope.document.addEventListener("DOMContentLoaded", () => startApp(scope), { once: true });
    } else {
      startApp(scope);
    }
  }
})(typeof self !== "undefined" ? self : globalThis);
