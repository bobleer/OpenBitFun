// Tests for the lightweight web launcher (`launcher.js`): device ranking,
// handoff v1 compatibility, disclaimer storage compatibility, fragment parsing,
// locale resolution, and full `obp-e2e-v1` manifest fetch (`fleet_ui_bundle`
// with fallback to `ui_bundle_manifest`).
//
//   node --test src/nsh-ui/web/launcher.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'launcher.js'), 'utf8');

function loadLauncher() {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    crypto: globalThis.crypto,
    MessageChannel,
  });
  vm.runInContext(source, context, { filename: 'launcher.js' });
  return context.ObfWebLauncher;
}

const launcher = loadLauncher();
const subtle = globalThis.crypto.subtle;

test('pickUiSourceDevice respects backend-ranked entryCandidates and falls back to version/route', () => {
  const devices = [
    { deviceId: 'old', clientVersion: '1.0.9', online: true, connectable: true, unavailable: null, route: null },
    { deviceId: 'relayed', clientVersion: '1.0.12', online: true, connectable: true, unavailable: null, route: 'relayed_server' },
    { deviceId: 'lan', clientVersion: '1.0.12', online: true, connectable: true, unavailable: null, route: 'direct_lan' },
    { deviceId: 'offline', clientVersion: '9.0.0', online: false, connectable: false, unavailable: { code: 'offline', message: 'offline' }, route: null },
  ];
  assert.equal(launcher.pickUiSourceDevice(devices).deviceId, 'lan');
  assert.equal(launcher.pickUiSourceDevice(devices, new Set(['lan'])).deviceId, 'relayed');
  assert.equal(launcher.pickUiSourceDevice(devices, new Set(), ['relayed', 'old', 'lan']).deviceId, 'relayed');
  assert.equal(launcher.pickUiSourceDevice(devices, new Set(['relayed']), ['relayed', 'old', 'lan']).deviceId, 'old');
});

test('writeHandoff writes frozen handoff v1 shape and fragment parsing maps errors', () => {
  const map = new Map();
  const storage = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
  };
  launcher.writeHandoff(storage, 'desk-1', 1700000000123);
  assert.equal(map.get(launcher.HANDOFF_KEY), '{"v":1,"deviceId":"desk-1","at":1700000000123}');

  const ver = launcher.parseLauncherFragment({ hash: '#ui-error=verification&file=app.js&bundle=' + 'a'.repeat(64) });
  assert.equal(ver.showDevices, true);
  assert.equal(ver.failure.code, 'ui_verification_failed');
  assert.equal(ver.failure.detail, 'app.js');

  const sw = launcher.parseLauncherFragment({ hash: '#switch=1' });
  assert.equal(sw.showDevices, true);
  assert.equal(sw.failure, null);
});

test('hasAgreedDisclaimer recognizes both direct and NSH-prefixed storage keys', () => {
  const makeStorage = entries => {
    const map = new Map(Object.entries(entries));
    return {
      get length() {
        return map.size;
      },
      key: i => [...map.keys()][i] ?? null,
      getItem: k => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, String(v)),
    };
  };
  assert.equal(launcher.hasAgreedDisclaimer(makeStorage({})), false);
  assert.equal(launcher.hasAgreedDisclaimer(makeStorage({ [launcher.DISCLAIMER_KEY]: 'true' })), true);
  assert.equal(
    launcher.hasAgreedDisclaimer(makeStorage({ [`nsh:com.openbitfun.nshui:${launcher.DISCLAIMER_KEY}`]: 'true' })),
    true,
  );
  const store = makeStorage({});
  launcher.recordDisclaimerAgreed(store);
  assert.equal(launcher.hasAgreedDisclaimer(store), true);
});

test('resolveLocale matches zh-CN, zh-TW, and en-US cleanly', () => {
  const catalog = { 'en-US': { a: 'en' }, 'zh-CN': { a: 'cn' }, 'zh-TW': { a: 'tw' } };
  assert.equal(launcher.resolveLocale(['zh-Hans-CN', 'en-US'], catalog), 'zh-CN');
  assert.equal(launcher.resolveLocale(['zh-Hant-TW'], catalog), 'zh-TW');
  assert.equal(launcher.resolveLocale(['fr-FR'], catalog), 'en-US');
  const tr = launcher.createTranslator(catalog, ['zh-CN']);
  assert.equal(tr('a'), 'cn');
  assert.equal(tr.locale, 'zh-CN');
});

test('fetchManifestOverE2e completes obp-e2e-v1 handshake and prefers fleet_ui_bundle with fallback', async () => {
  const browserPair = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const browserPubB64 = Buffer.from(await subtle.exportKey('raw', browserPair.publicKey)).toString('base64');
  const devicePair = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const devicePubB64 = Buffer.from(await subtle.exportKey('raw', devicePair.publicKey)).toString('base64');

  const manifest = {
    schema: 1,
    product: 'openbitfun',
    version: '2.0.0',
    entry: 'index.html',
    files: [{ path: 'index.html', sha256: 'a'.repeat(64), size: 10 }],
  };

  async function runScenario({ supportFleet }) {
    const deviceKey = { deviceId: 'web-browser-1', privateKey: browserPair.privateKey, publicKey: browserPubB64 };
    const calls = [];
    let sendKey;
    let recvKey;
    let serverSendCounter = 0;
    let serverRecvCounter = 0;
    let handshakeDone = false;
    let buf = Buffer.alloc(0);

    const createSocket = () => {
      const ws = {
        readyState: 0,
        binaryType: 'arraybuffer',
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close() {
          ws.readyState = 3;
        },
        send(chunk) {
          buf = Buffer.concat([buf, Buffer.from(chunk)]);
          void pump();
        },
      };

      async function serverSendRecord(type, payload) {
        const pt = Buffer.concat([Buffer.from([type]), Buffer.from(payload)]);
        const nonce = launcher.e2eNonce(serverSendCounter);
        serverSendCounter += 1;
        const ct = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, sendKey, pt));
        const framed = Buffer.from(launcher.lengthPrefixed(ct));
        ws.onmessage?.({ data: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) });
      }

      async function pump() {
        if (!handshakeDone) {
          if (buf.length < 12) return;
          assert.equal(buf.subarray(0, 8).toString('utf8'), 'OBPE2E1\n');
          const len = buf.readUInt32BE(8);
          if (buf.length < 12 + len) return;
          const hello = JSON.parse(buf.subarray(12, 12 + len).toString('utf8'));
          buf = buf.subarray(12 + len);
          handshakeDone = true;

          const pairKey = await launcher.devicePairKey(
            subtle,
            { deviceId: 'desk-1', privateKey: devicePair.privateKey, publicKey: devicePubB64 },
            browserPubB64,
          );
          const hmacKey = await subtle.importKey('raw', pairKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const handshakeKey = new Uint8Array(
            await subtle.sign('HMAC', hmacKey, new TextEncoder().encode('OpenBitFun OBP mesh v1 handshake key')),
          );
          const claims = {
            client: hello.device,
            server: hello.target,
            fingerprint: `obp-e2e-v1:${hello.eph}`,
            time: hello.time,
            nonce: hello.nonce,
          };
          const expectedClientProof = await launcher.meshProof(subtle, handshakeKey, 'client', claims);
          assert.equal(hello.proof, expectedClientProof);

          const serverEph = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
          const serverEphB64Url = Buffer.from(await subtle.exportKey('raw', serverEph.publicKey)).toString('base64url');
          const serverClaims = { ...claims, fingerprint: `obp-e2e-v1:${hello.eph}:${serverEphB64Url}` };
          const serverProof = await launcher.meshProof(subtle, handshakeKey, 'server', serverClaims);

          const clientEphRaw = Buffer.from(hello.eph, 'base64url');
          const clientEphPub = await subtle.importKey('raw', clientEphRaw, { name: 'X25519' }, true, []);
          const shared = new Uint8Array(
            await subtle.deriveBits({ name: 'X25519', public: clientEphPub }, serverEph.privateKey, 256),
          );
          const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
          const okm = new Uint8Array(
            await subtle.deriveBits(
              {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: handshakeKey,
                info: new TextEncoder().encode(`obp-e2e-v1 keys\n${hello.proof}\n${serverProof}`),
              },
              hkdf,
              512,
            ),
          );
          recvKey = await subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['decrypt']);
          sendKey = await subtle.importKey('raw', okm.slice(32, 64), 'AES-GCM', false, ['encrypt']);

          const reply = Buffer.from(
            JSON.stringify({ v: 1, eph: serverEphB64Url, proof: serverProof, protocol: 1, capabilities: ['obp_v1', 'fleet_v1'] }),
          );
          const framed = Buffer.from(launcher.lengthPrefixed(reply));
          ws.onmessage?.({ data: framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) });
        }

        while (handshakeDone && buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 4 + len) return;
          const ct = buf.subarray(4, 4 + len);
          buf = buf.subarray(4 + len);
          const nonce = launcher.e2eNonce(serverRecvCounter);
          serverRecvCounter += 1;
          const pt = Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, recvKey, ct));
          if (pt[0] !== 1) continue;
          const req = JSON.parse(pt.subarray(1).toString('utf8'));
          if (req.method === 'hello') {
            await serverSendRecord(
              1,
              JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                result: {
                  protocol: 1,
                  scope: 'account-device',
                  fleet: supportFleet ? { protocol: 1, deviceId: 'desk-1' } : undefined,
                },
              }),
            );
          } else if (req.method === 'call') {
            calls.push(req.params.command);
            if (req.params.command === 'fleet_ui_bundle') {
              await serverSendRecord(
                1,
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  result: { manifest, ownerDeviceId: 'cli-2', holders: ['cli-2', 'desk-1'], bundleId: 'f'.repeat(64) },
                }),
              );
            } else if (req.params.command === 'ui_bundle_manifest') {
              await serverSendRecord(
                1,
                JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { manifest, bundleId: 'f'.repeat(64) } }),
              );
            }
          }
        }
      }

      setTimeout(() => {
        ws.readyState = 1;
        ws.onopen?.();
      }, 0);
      return ws;
    };

    const resolved = await launcher.fetchManifestOverE2e({
      url: 'wss://super.openbitfun.com/obp/desk-1',
      deviceId: 'desk-1',
      devicePublicKey: devicePubB64,
      key: deviceKey,
      subtle,
      createSocket,
    });
    return { resolved, calls };
  }

  const fleet = await runScenario({ supportFleet: true });
  assert.deepEqual(fleet.calls, ['fleet_ui_bundle']);
  assert.equal(fleet.resolved.ownerDeviceId, 'cli-2');
  assert.deepEqual([...fleet.resolved.holders], ['cli-2', 'desk-1']);

  const direct = await runScenario({ supportFleet: false });
  assert.deepEqual(direct.calls, ['ui_bundle_manifest']);
  assert.equal(direct.resolved.ownerDeviceId, 'desk-1');
  assert.deepEqual([...direct.resolved.holders], ['desk-1']);
});
