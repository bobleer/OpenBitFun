// Runs inside the PDF preview's isolated WebView. No PDF action, link, or form
// script is executed. The controller supplies bytes and receives only view state.
import { getDocument, PermissionFlag, TextLayer } from 'pdfjs-dist/build/pdf.min.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.min.mjs';
import { createPdfReviewLayer } from './nsh-pdf-review-layer.js';
import { exportReviewedPdf, inspectReviewedPdf } from './nsh-pdf-review-file.js';
import { MAX_REVIEW_JSON, MAX_REVIEW_PDF, PDF_REVIEW_CHUNK, parsePdfReview } from '../src/nsh-ui/src/pdfReviewData.ts';

// Use PDF.js's own local worker transport. Both native HTML and the sandboxed
// browser frame run with network access disabled.
globalThis.pdfjsWorker = { WorkerMessageHandler };

const stack = document.getElementById('pdf-pages');
const maxDocumentBytes = MAX_REVIEW_PDF;
const bytesPerExportChunk = PDF_REVIEW_CHUNK / 4 * 3;
const maxCanvasPixels = 8 * 1024 * 1024;
const rendering = new Map();
const painted = new Set();
const pages = [];
const chunks = [];
const reviewLayer = createPdfReviewLayer(stack, pages, report);
let receivedBytes = 0;
let loadingTask;
let opening = false;
let documentProxy;
let providePassword;
let canCopy = false;
let rotation = 0;
let zoom = null;
let effectiveScale = 1;
let fittedViewportWidth = 0;
let layoutRevision = 0;
let pageNumber = 1;
let jumpAnchor = null;
let wheelRemainder = 0;
let frame = 0;
let copyBlock;
let copyInput;
let exporting = false;

function report(type, fields = {}) {
  window.nsh?.postMessage(JSON.stringify({ type, ...fields }));
}

function bundledBytes(directory, filename) {
  const path = `${directory}/${filename}`;
  const resource = Object.hasOwn(PDF_READER_RESOURCES, path) ? PDF_READER_RESOURCES[path] : null;
  if (!resource) throw new Error('PDF renderer resource unavailable');
  return Uint8Array.from(atob(resource), character => character.charCodeAt(0));
}

class BundledCMaps {
  async fetch({ name }) {
    return { cMapData: bundledBytes('cmaps', `${name}.bcmap`), isCompressed: true };
  }
}

class BundledStandardFonts {
  async fetch({ filename }) {
    return bundledBytes('standard_fonts', filename);
  }
}

class BundledDecoders {
  async fetch({ filename }) {
    return bundledBytes('wasm', filename);
  }
}

function copyViewState() {
  return { page: pageNumber, scale: effectiveScale, zoom, pages: pages.length };
}

function pageAt(y) {
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (pages[middle].node.offsetTop <= y) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function rotated(page) {
  return rotation % 180 ? [page.height, page.width] : [page.width, page.height];
}

function cancelPage(index) {
  const job = rendering.get(index);
  job?.raster?.cancel();
  job?.text?.cancel();
  rendering.delete(index);
  reviewLayer.detach(pages[index]);
  if (painted.delete(index) || job) pages[index].node.replaceChildren();
}

function applyLayout(pivot) {
  const anchor = pages[pageNumber - 1]?.node;
  const offset = anchor ? (window.scrollY - anchor.offsetTop) / Math.max(1, anchor.offsetHeight) : 0;
  const widest = pages.reduce((width, page) => Math.max(width, rotated(page)[0]), 1);
  fittedViewportWidth = document.documentElement.clientWidth;
  effectiveScale = zoom ?? Math.min(4, Math.max(1, fittedViewportWidth - 32) / widest);
  layoutRevision += 1;
  for (const index of new Set([...rendering.keys(), ...painted])) cancelPage(index);
  for (const page of pages) {
    const [w, h] = rotated(page);
    page.node.style.width = `${w * effectiveScale}px`;
    page.node.style.height = `${h * effectiveScale}px`;
  }
  if (pivot) {
    const bounds = pivot.node.getBoundingClientRect();
    window.scrollTo(
      window.scrollX + bounds.left + bounds.width * pivot.xRatio - pivot.x,
      window.scrollY + bounds.top + bounds.height * pivot.yRatio - pivot.y,
    );
    jumpAnchor = null;
  } else if (anchor) {
    window.scrollTo(Math.max(0, (stack.scrollWidth - window.innerWidth) / 2),
      Math.max(0, anchor.offsetTop + offset * anchor.offsetHeight));
    if (jumpAnchor) jumpAnchor = { page: pageNumber, top: window.scrollY };
  }
  report('position', copyViewState());
  schedulePaint();
}

async function paintPage(index) {
  const record = pages[index];
  const revision = layoutRevision;
  const job = {};
  rendering.set(index, job);
  const current = () => rendering.get(index) === job && revision === layoutRevision;
  let page;
  try {
    page = await documentProxy.getPage(index + 1);
    if (!current()) return;
    const viewport = page.getViewport({ scale: effectiveScale, rotation: (page.rotate + rotation) % 360 });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2,
      Math.sqrt(maxCanvasPixels / (viewport.width * viewport.height)), 8192 / Math.max(viewport.width, viewport.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas unavailable');
    job.raster = page.render({ canvas, canvasContext: context, viewport,
      transform: [outputScale, 0, 0, outputScale, 0, 0] });
    await job.raster.promise;
    if (!current()) return;
    record.node.replaceChildren(canvas);
    if (canCopy) {
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      layer.style.setProperty('--total-scale-factor', String(viewport.scale * page.userUnit));
      record.node.append(layer);
      job.text = new TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
      try {
        await job.text.render();
      } catch {
        layer.remove();
      }
    }
    if (current()) {
      reviewLayer.attach(record, viewport);
      painted.add(index);
      report('painted', { page: index + 1 });
    }
  } catch {
    if (current()) {
      painted.add(index);
      report('page-error', { page: index + 1 });
    }
  } finally {
    if (current()) rendering.delete(index);
    page?.cleanup();
    schedulePaint();
  }
}

function schedulePaint() {
  if (frame || !pages.length) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const top = window.scrollY;
    const height = window.innerHeight;
    if (jumpAnchor && Math.abs(top - jumpAnchor.top) > 1) jumpAnchor = null;
    const current = jumpAnchor?.page ?? pageAt(top + Math.min(48, height / 3));
    if (current !== pageNumber) {
      pageNumber = current;
      report('position', copyViewState());
    }
    const start = pageAt(top - height / 2) - 1;
    const end = pageAt(top + height * 1.5) - 1;
    for (const index of new Set([...rendering.keys(), ...painted])) {
      if (index < start || index > end) cancelPage(index);
    }
    for (let index = start; index <= end && rendering.size < 2; index += 1) {
      if (!painted.has(index) && !rendering.has(index)) void paintPage(index);
    }
  });
}

async function openDocument(inspectReview) {
  const data = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  chunks.length = 0;
  let source = {};
  if (inspectReview === true) {
    try {
      source = await inspectReviewedPdf(data);
      copyBlock = source.blocked;
    } catch {
      copyBlock = 'unreadable';
    }
  }
  loadingTask = getDocument({
    data: source.bytes ?? data, useWorkerFetch: false, isEvalSupported: false,
    CMapReaderFactory: BundledCMaps, StandardFontDataFactory: BundledStandardFonts, WasmFactory: BundledDecoders,
  });
  loadingTask.onPassword = (provide, reason) => {
    copyBlock = 'encrypted';
    providePassword = provide;
    report('password', { incorrect: reason === 2 });
  };
  documentProxy = await loadingTask.promise;
  const permissions = await documentProxy.getPermissions();
  canCopy = permissions === null || permissions.includes(PermissionFlag.COPY);
  const sizes = new Array(documentProxy.numPages);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, sizes.length) }, async () => {
    while (next < sizes.length) {
      const index = next++;
      const page = await documentProxy.getPage(index + 1);
      try {
        const { width, height } = page.getViewport({ scale: 1 });
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new Error('Invalid page size');
        }
        sizes[index] = { width, height };
      } finally {
        page.cleanup();
      }
    }
  }));
  const fragment = document.createDocumentFragment();
  for (const [index, size] of sizes.entries()) {
    const node = document.createElement('section');
    node.className = 'pdf-page';
    node.dataset.page = String(index + 1);
    pages.push({ ...size, node });
    fragment.append(node);
  }
  stack.replaceChildren(fragment);
  applyLayout();
  if (source.data) {
    const text = JSON.stringify(source.data);
    for (let index = 0; index < text.length; index += PDF_REVIEW_CHUNK) {
      report('review-embedded', { chunk: text.slice(index, index + PDF_REVIEW_CHUNK) });
    }
  }
  report('loaded', { ...copyViewState(), fingerprint: source.data?.fingerprint || documentProxy.fingerprints[0] || '',
    canCopy, copyBlock });
}

function collectCopyChunk(input) {
  if (exporting || !Number.isSafeInteger(input.id) || typeof input.chunk !== 'string' || input.chunk.length > PDF_REVIEW_CHUNK) return;
  if (copyInput?.id !== input.id) copyInput = { id: input.id, size: 0, chunks: [] };
  copyInput.size += input.chunk.length;
  if (copyInput.size > MAX_REVIEW_JSON) {
    report('review-copy-error', { id: input.id, reason: 'review-too-large' });
    copyInput = undefined;
  } else {
    copyInput.chunks.push(input.chunk);
  }
}

async function makeCopy(id) {
  if (exporting || copyInput?.id !== id || !documentProxy) return;
  const input = copyInput;
  copyInput = undefined;
  exporting = true;
  try {
    if (copyBlock) throw new Error(copyBlock);
    const review = parsePdfReview(input.chunks.join(''));
    const bytes = await exportReviewedPdf(await documentProxy.getData(), review);
    for (let offset = 0; offset < bytes.length; offset += bytesPerExportChunk) {
      report('review-copy-chunk', { id, chunk: btoa(String.fromCharCode(...bytes.subarray(offset, offset + bytesPerExportChunk))) });
    }
    report('review-copy-done', { id, byteLength: bytes.length });
  } catch (error) {
    report('review-copy-error', { id, reason: error instanceof Error ? error.message : 'unreadable' });
  } finally {
    exporting = false;
  }
}

function readMessage(event) {
  if (window.parent !== window && event.source !== window.parent) return;
  if (typeof event.data !== 'string') return;
  let input;
  try { input = JSON.parse(event.data); } catch { return; }
  if (input?.channel !== 'openbitfun-pdf') return;
  try {
    if (input.type === 'data' && !opening && typeof input.chunk === 'string') {
      if (input.chunk.length > 192 * 1024) throw new Error('PDF chunk too large');
      const bytes = Uint8Array.from(atob(input.chunk), character => character.charCodeAt(0));
      receivedBytes += bytes.length;
      if (receivedBytes > maxDocumentBytes) throw new Error('PDF too large');
      chunks.push(bytes);
    } else if (input.type === 'open' && !opening) {
      opening = true;
      void openDocument(input.inspectReview).catch(error => report('error', {
        reason: error instanceof Error ? error.name : 'Document open failed',
      }));
    } else if (input.type === 'password' && typeof input.value === 'string' && providePassword) {
      const submit = providePassword;
      providePassword = undefined;
      submit(input.value);
    } else if (input.type === 'review' && Array.isArray(input.annotations)) {
      reviewLayer.update(input, canCopy);
    } else if (input.type === 'review-copy-data') {
      collectCopyChunk(input);
    } else if (input.type === 'review-copy') {
      void makeCopy(input.id);
    } else if (input.type === 'view' && pages.length) {
      const nextZoom = Number.isFinite(input.zoom) ? Math.min(4, Math.max(0.25, input.zoom)) : null;
      const nextRotation = [0, 90, 180, 270].includes(input.rotation) ? input.rotation : 0;
      if (zoom !== nextZoom || rotation !== nextRotation) {
        zoom = nextZoom;
        rotation = nextRotation;
        applyLayout();
      }
      if (Number.isInteger(input.page) && input.page >= 1 && input.page <= pages.length) {
        pageNumber = input.page;
        pages[pageNumber - 1].node.scrollIntoView({ block: 'start', inline: 'nearest' });
        jumpAnchor = { page: pageNumber, top: window.scrollY };
        report('position', copyViewState());
        schedulePaint();
      }
    }
  } catch {
    report('error');
  }
}

window.addEventListener('message', readMessage);
window.addEventListener('scroll', schedulePaint, { passive: true });
window.addEventListener('wheel', event => {
  if ((!event.ctrlKey && !event.metaKey) || !pages.length) return;
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === 1 ? 100 / 3 : event.deltaMode === 2 ? 100 : 1);
  if (Math.sign(wheelRemainder) !== Math.sign(delta)) wheelRemainder = 0;
  wheelRemainder += delta;
  if (Math.abs(wheelRemainder) < 100) return;
  const steps = Math.trunc(wheelRemainder / 100);
  wheelRemainder -= steps * 100;
  const next = Math.min(4, Math.max(0.25, Math.round(effectiveScale * 100 - steps * 10) / 100));
  if (next === effectiveScale) return;
  const node = pages[pageAt(window.scrollY + event.clientY) - 1].node;
  const bounds = node.getBoundingClientRect();
  const clamp = value => Math.min(1, Math.max(0, value));
  zoom = next;
  applyLayout({
    node, x: event.clientX, y: event.clientY,
    xRatio: clamp((event.clientX - bounds.left) / bounds.width),
    yRatio: clamp((event.clientY - bounds.top) / bounds.height),
  });
}, { passive: false });
function onViewportResize() {
  if (pages.length && zoom === null && document.documentElement.clientWidth !== fittedViewportWidth) applyLayout();
  else schedulePaint();
}

// Classic scrollbars reserve width when pages first appear, without a window resize.
const viewportObserver = new ResizeObserver(onViewportResize);
viewportObserver.observe(document.documentElement);
window.addEventListener('resize', onViewportResize);
window.addEventListener('pagehide', () => {
  viewportObserver.disconnect();
  cancelAnimationFrame(frame);
  for (const index of [...rendering.keys()]) cancelPage(index);
  void loadingTask?.destroy().catch(() => undefined);
});
report('ready');
