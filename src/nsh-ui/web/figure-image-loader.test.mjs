import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/vendor/figure-image-loader.js', import.meta.url), 'utf8');
const url = 'https://images.example/figure.png';
const nonce = 'fixture';

function workerRead(fetch, link = url) {
  return new Promise(resolve => {
    let listener;
    class FileReader {
      async readAsDataURL(blob) {
        this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
        this.onload();
      }
    }
    const self = {
      addEventListener: (event, callback) => {
        assert.equal(event, 'message');
        listener = callback;
      },
      postMessage: resolve,
    };
    vm.runInNewContext(source, { self, fetch, URL, Blob, FileReader, AbortController, setTimeout, clearTimeout });
    listener({ data: { nonce, url: link } });
  });
}

test('the figure loader returns an anonymous CORS raster for the requested URL', async () => {
  const reply = await workerRead(async (target, options) => {
    assert.equal(target.href, url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.mode, 'cors');
    assert.equal(options.redirect, 'error');
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
  });
  assert.equal(reply.nonce, nonce);
  assert.equal(reply.url, url);
  assert.equal(reply.value, 'data:image/png;base64,iVBORw==');
});

test('the figure loader rejects unsafe URL forms, unsupported types and oversized streams', async () => {
  let attempted = false;
  const unsafe = await workerRead(async () => { attempted = true; }, 'https://user@images.example/figure.png');
  assert.equal(unsafe.value, undefined);
  assert.equal(attempted, false);
  const svg = await workerRead(async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }));
  assert.equal(svg.value, undefined);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const oversized = await workerRead(async () => new Response(stream, { headers: { 'Content-Type': 'image/png' } }));
  assert.equal(oversized.value, undefined);
});
