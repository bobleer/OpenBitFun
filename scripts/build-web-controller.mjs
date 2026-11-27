#!/usr/bin/env node
// Builds the OpenBitFun web controller (the lightweight root launcher at
// `https://<domain>/`): signs in with the email code, discovers the best online
// device, fetches its web UI manifest over `obp-e2e-v1`, stores it in the UI
// loader Service Worker (`/ui-loader.js`), and hands off directly to
// `/b/<bundleId>/index.html#device=<deviceId>`.
//
// Serving a ~15 KB launcher at `/` instead of a full NSH WASM bundle eliminates
// downloading and compiling the ~11 MB WASM runtime twice on cold open whenever
// the target device ships a different bundle than the server's static root.
//
// Deploy the output at the root of `https://<domain>/`
// (`deploy/easytier/README.md`, "Web controller").
//
//   node scripts/build-web-controller.mjs [--domain super.openbitfun.com] [--out target/web-controller/app]

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LAUNCHER_LOCALE_KEYS = [
  'common.close',
  'signin.title',
  'signin.body',
  'signin.email',
  'signin.emailPlaceholder',
  'signin.continue',
  'signin.codeNote',
  'signin.codeTitle',
  'signin.codeBody',
  'signin.signIn',
  'signin.resend',
  'signin.resendIn',
  'signin.otherEmail',
  'signin.errCode',
  'signin.errRate',
  'signin.errNetwork',
  'signin.errEmail',
  'state.offline',
  'launcher.checking',
  'launcher.opening',
  'launcher.noneTitle',
  'launcher.noneBody',
  'launcher.needsUpdate',
  'launcher.offline',
  'launcher.pageOutdated',
  'launcher.verifyFailed',
  'launcher.encrypted',
  'launcher.signOut',
  'launcher.tryAgain',
  'controller.error.rateLimited',
  'controller.error.signedOut',
  'controller.error.deviceUiUnavailable',
  'controller.error.devicesUiUnavailable',
  'controller.error.uiLoad',
  'devices.remote.disclaimerTitle',
  'devices.remote.disclaimerIntro',
  'devices.remote.disclaimerKeyRisks',
  'devices.remote.disclaimerFullDetails',
  'devices.remote.disclaimerDecline',
  'devices.remote.disclaimerAgree',
  'devices.remote.disclaimerItemGeneralRisk',
  'devices.remote.disclaimerItemSecurity',
  'devices.remote.disclaimerItemEncryption',
  'devices.remote.disclaimerItemPrivacy',
  'devices.remote.disclaimerItemOpenSource',
  'devices.remote.disclaimerItemDataUsage',
  'devices.remote.disclaimerItemCredentials',
  'devices.remote.disclaimerItemQrCode',
  'devices.remote.disclaimerItemRelay',
  'devices.remote.disclaimerItemNetwork',
  'devices.remote.disclaimerItemBot',
  'devices.remote.disclaimerItemBotPersistence',
  'devices.remote.disclaimerItemMobileBrowser',
  'devices.remote.disclaimerItemCompliance',
  'devices.remote.disclaimerItemLiability',
];

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hash10(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 10);
}

function writeCompressed(targetPath, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  fs.writeFileSync(targetPath, buf);
  fs.writeFileSync(`${targetPath}.gz`, zlib.gzipSync(buf, { level: 9 }));
  fs.writeFileSync(
    `${targetPath}.br`,
    zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
  );
}

/** Extracts string literal entries for `LAUNCHER_LOCALE_KEYS` from a TS locale catalog. */
function extractLocaleStrings(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const wanted = new Set(LAUNCHER_LOCALE_KEYS);
  const out = {};
  // Matches `"key": "value"` lines in `src/nsh-ui/src/locales/*.ts`.
  const lineRe = /^\s*"([^"]+)":\s*("(?:\\.|[^"\\])*")\s*,?\s*$/gm;
  let match;
  while ((match = lineRe.exec(text)) !== null) {
    const [, key, rawJson] = match;
    if (!wanted.has(key)) continue;
    out[key] = JSON.parse(rawJson);
  }
  return out;
}

const domain = option('domain', 'super.openbitfun.com');
if (!/^[a-z0-9.-]+(:[0-9]+)?$/i.test(domain)) {
  console.error(`Invalid --domain ${domain}`);
  process.exit(2);
}

const out = path.resolve(root, option('out', 'target/web-controller/app'));
const staging = `${out}.staging-${process.pid}-${Date.now()}`;
const webDir = path.join(root, 'src/nsh-ui/web');
const localesDir = path.join(root, 'src/nsh-ui/src/locales');

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

try {
  const launcherJs = fs.readFileSync(path.join(webDir, 'launcher.js'));
  const launcherCss = fs.readFileSync(path.join(webDir, 'launcher.css'));
  const launcherJsName = `launcher.${hash10(launcherJs)}.js`;
  const launcherCssName = `launcher.${hash10(launcherCss)}.css`;
  writeCompressed(path.join(staging, launcherJsName), launcherJs);
  writeCompressed(path.join(staging, launcherCssName), launcherCss);

  const i18nCatalog = {};
  for (const locale of ['en-US', 'zh-CN', 'zh-TW']) {
    const localePath = path.join(localesDir, `${locale}.ts`);
    if (fs.existsSync(localePath)) {
      i18nCatalog[locale] = extractLocaleStrings(localePath);
    }
  }

  const params = {
    controller: {
      api: `https://${domain}/obp/api/v1`,
      gateway: `wss://${domain}/obp`,
    },
  };
  // `<` cannot occur in a script's JSON text without ending it early.
  const escapeJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const paramsScript = `<script type="application/json" id="nsh-params">${escapeJson(params)}</script>`;
  const i18nScript = `<script type="application/json" id="obf-launcher-i18n">${escapeJson(i18nCatalog)}</script>`;

  const template = fs.readFileSync(path.join(webDir, 'launcher.html'), 'utf8');
  const html = template
    .replace('__LAUNCHER_CSS__', launcherCssName)
    .replace('__LAUNCHER_JS__', launcherJsName)
    .replace('__LAUNCHER_PARAMS__', paramsScript)
    .replace('__LAUNCHER_I18N__', i18nScript);
  writeCompressed(path.join(staging, 'index.html'), html);

  for (const name of ['ui-loader.js', 'ui-boot.html', 'favicon.svg']) {
    const bytes = fs.readFileSync(path.join(webDir, name));
    writeCompressed(path.join(staging, name), bytes);
  }

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.renameSync(staging, out);
  console.log(
    `Web controller (lightweight launcher) for https://${domain}/ in ${path.relative(root, out)} (${launcherJsName}, ${launcherCssName})`,
  );
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
