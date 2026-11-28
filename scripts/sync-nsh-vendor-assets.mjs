#!/usr/bin/env node
// Copies the NSH UI's vendored document renderers and model pool artwork into
// the native apps that ship the shared UI.
//
// nsh ships only files inside an app's own directory and resolves symlinks
// before it checks, so `src/apps/desktop-nsh` and `src/apps/mobile-nsh` each
// need real copies under `assets`. The repository keeps one copy (the
// nsh-ui one); the app copies are gitignored and written here, before every
// native build (`desktop-nsh:bundle`, `desktop-nsh-package-common.mjs`,
// `package-mobile-nsh.mjs`) and after `pnpm install`. Each app registers its
// copy's URLs in its `src/documentRenderers.ts`.
//
//   node scripts/sync-nsh-vendor-assets.mjs [--check]
//
// `--check` writes nothing and fails when an app copy is missing or differs.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { compileString } from 'sass';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const require = createRequire(import.meta.url);
export const VENDOR_SOURCE = join(root, 'src', 'nsh-ui', 'assets', 'vendor');
export const VENDOR_TARGETS = [
  join(root, 'src', 'apps', 'desktop-nsh', 'assets', 'vendor'),
  join(root, 'src', 'apps', 'mobile-nsh', 'assets', 'vendor'),
];

/** The pinned PDF.js dependency and its renderer are compiled as a classic script. */
export function preparePdfRendererAsset({ check = false } = {}) {
  const distribution = dirname(require.resolve('pdfjs-dist/package.json'));
  const directories = ['cmaps', 'standard_fonts', 'wasm'];
  const licenses = [join(distribution, 'LICENSE')];
  const writer = createRequire(require.resolve('pdf-lib/package.json'));
  for (const [pkg, license] of [
    ['pdf-lib', 'LICENSE.md'], ['@pdf-lib/standard-fonts', 'LICENSE.md'],
    ['@pdf-lib/upng', 'LICENSE'], ['pako', 'LICENSE'],
  ]) {
    licenses.push(join(dirname(writer.resolve(pkg + '/package.json')), license));
  }
  for (const notice of ['LICENSE.txt', 'CopyrightNotice.txt']) {
    licenses.push(join(dirname(writer.resolve('tslib')), notice));
  }
  const assets = {};
  for (const directory of directories) {
    const source = join(distribution, directory);
    for (const name of readdirSync(source).sort()) {
      const file = join(source, name);
      if (name.startsWith('LICENSE')) {
        licenses.push(file);
      } else if (/\.(bcmap|pfb|ttf|wasm)$/i.test(name)) {
        assets[`${directory}/${name}`] = readFileSync(file).toString('base64');
      }
    }
  }
  const output = buildSync({
    absWorkingDir: root,
    entryPoints: ['scripts/nsh-pdf-reader.js'],
    platform: 'browser',
    format: 'iife',
    bundle: true,
    minify: true,
    legalComments: 'inline',
    define: { 'import.meta.url': '""', PDF_READER_RESOURCES: JSON.stringify(assets) },
    banner: { js: licenses.map(file =>
      `/*! ${relative(distribution, file).replaceAll('\\', '/')}\n${readFileSync(file, 'utf8').replaceAll('*/', '* /')}\n*/`,
    ).join('\n') },
    write: false,
  }).outputFiles[0].contents;
  const target = join(VENDOR_SOURCE, 'pdf-reader.js');
  if (existsSync(target) && readFileSync(target).equals(output)) return [];
  if (!check) writeFileSync(target, output);
  return [relative(root, target)];
}

/** Compiles the built-in chart renderer and its pinned dependencies for the isolated document. */
export function prepareFigureRendererAsset({ check = false } = {}) {
  const chartDir = dirname(require.resolve('echarts/package.json'));
  const chartRequire = createRequire(join(chartDir, 'package.json'));
  const reactDomDir = dirname(require.resolve('react-dom/package.json'));
  const reactDomRequire = createRequire(join(reactDomDir, 'package.json'));
  const licenses = [join(chartDir, 'LICENSE'), join(chartDir, 'NOTICE'),
    join(dirname(chartRequire.resolve('zrender/package.json')), 'LICENSE'),
    join(dirname(require.resolve('zod/package.json')), 'LICENSE'),
    join(dirname(dirname(require.resolve('parse5'))), 'LICENSE'),
    join(dirname(require.resolve('react/package.json')), 'LICENSE'),
    join(reactDomDir, 'LICENSE'),
    join(dirname(reactDomRequire.resolve('scheduler/package.json')), 'LICENSE')];
  const rendererDir = join(root, 'src', 'nsh-ui', 'assets', 'figure-renderer');
  const styles = ['VisualAnswer.scss', 'LayerDiagram.scss', 'IllustratedPanel.scss']
    .map(name => readFileSync(join(rendererDir, name), 'utf8')).join('\n');
  const [bundle] = buildSync({
    absWorkingDir: root,
    entryPoints: ['src/nsh-ui/assets/figure-renderer/main.ts'],
    tsconfig: join(rendererDir, 'tsconfig.json'),
    platform: 'browser', format: 'iife', bundle: true, minify: true,
    define: {
      'process.env.NODE_ENV': '"production"',
      FIGURE_WIDGET_STYLE: JSON.stringify(compileString(styles, { style: 'compressed' }).css),
    },
    legalComments: 'inline',
    banner: { js: licenses.map(file => `/*!\n${readFileSync(file, 'utf8').replaceAll('*/', '* /')}\n*/`).join('\n') },
    write: false,
  }).outputFiles;
  const target = join(VENDOR_SOURCE, 'figure-renderer.js');
  if (existsSync(target) && readFileSync(target).equals(bundle.contents)) return [];
  if (!check) writeFileSync(target, bundle.contents);
  return [relative(root, target)];
}

/** Stages the shared map styling and notices for the online map renderer. */
export function prepareFigureMapAssets({ check = false } = {}) {
  const target = join(VENDOR_SOURCE, 'figure-atlas');
  const stale = [];
  const stylesheet = join(root, 'src/shared/visualize/regional-map.css');
  const outputStyle = join(target, 'regional-map.css');
  if (!sameFile(stylesheet, outputStyle)) {
    stale.push(relative(root, outputStyle));
    if (!check) {
      mkdirSync(target, { recursive: true });
      copyFileSync(stylesheet, outputStyle);
    }
  }
  // Remove the generated map copies left by older builds.
  for (const layer of ['borders', 'lakes', 'land', 'places', 'provinces', 'rivers', 'seas']) {
    const oldLayer = join(target, layer + '.json');
    if (!existsSync(oldLayer)) continue;
    stale.push(relative(root, oldLayer));
    if (!check) rmSync(oldLayer);
  }
  const d3Geo = require.resolve('d3-geo');
  const d3Array = createRequire(d3Geo).resolve('d3-array');
  const internmap = createRequire(d3Array).resolve('internmap');
  const vectorTile = require.resolve('@mapbox/vector-tile');
  const pointGeometry = createRequire(vectorTile).resolve('@mapbox/point-geometry');
  const licenses = [
    ['d3-geo', join(dirname(dirname(d3Geo)), 'LICENSE')],
    ['d3-array', join(dirname(dirname(d3Array)), 'LICENSE')],
    ['internmap', join(dirname(dirname(internmap)), 'LICENSE')],
    ['topojson-client', join(dirname(dirname(require.resolve('topojson-client'))), 'LICENSE')],
    ['@mapbox/vector-tile', join(dirname(vectorTile), 'LICENSE.txt')],
    ['@mapbox/point-geometry', join(dirname(pointGeometry), 'LICENSE')],
    ['pbf', join(dirname(require.resolve('pbf')), 'LICENSE')],
  ];
  const notices = licenses.map(([name, license]) =>
    `${name}\n${readFileSync(license, 'utf8').trimEnd()}`,
  ).join('\n\n') + '\n';
  const noticeFile = join(target, 'NOTICES.txt');
  if (!existsSync(noticeFile) || readFileSync(noticeFile, 'utf8') !== notices) {
    stale.push(relative(root, noticeFile));
    if (!check) writeFileSync(noticeFile, notices);
  }
  return stale;
}

function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out.sort();
}

function sameFile(left, right) {
  if (!existsSync(right)) return false;
  if (statSync(left).size !== statSync(right).size) return false;
  return readFileSync(left).equals(readFileSync(right));
}

/** Brings every app copy in line with the source; returns the paths that differed. */
export function syncVendorAssets({ check = false } = {}) {
  const stale = [
    ...preparePdfRendererAsset({ check }), ...prepareFigureRendererAsset({ check }), ...prepareFigureMapAssets({ check }),
  ];
  const syncDirectory = (source, target) => {
    const sourceFiles = listFiles(source);
    if (sourceFiles.length === 0) throw new Error(`no shared UI files under ${source}`);
    for (const file of sourceFiles) {
      const from = join(source, file);
      const to = join(target, file);
      if (sameFile(from, to)) continue;
      stale.push(relative(root, to));
      if (!check) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
    }
    // Drop a former asset when it is no longer in its source directory.
    for (const file of listFiles(target)) {
      if (sourceFiles.includes(file)) continue;
      stale.push(relative(root, join(target, file)));
      if (!check) rmSync(join(target, file));
    }
  };
  for (const target of VENDOR_TARGETS) {
    syncDirectory(VENDOR_SOURCE, target);
    syncDirectory(join(dirname(VENDOR_SOURCE), 'model-pools'), join(dirname(target), 'model-pools'));
  }
  return stale;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const stale = syncVendorAssets({ check });
  if (check && stale.length > 0) {
    console.error(`[nsh-vendor] app copies are out of date (run node scripts/sync-nsh-vendor-assets.mjs):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`[nsh-vendor] ${check ? 'checked' : 'synced'} ${VENDOR_TARGETS.length} app copies (${stale.length} files ${check ? 'stale' : 'written or removed'})`);
}
