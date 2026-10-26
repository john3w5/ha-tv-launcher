import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const ORIGIN = 'http://127.0.0.1:4317', CODE = 'hls-test-only-pair';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(t, fetchImpl, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tv-hls-api-'));
  const bridge = await createBridge({ root, websocketClass: null, fetchImpl, ...options,
    ha: { base: new URL('http://ha.invalid/'), cameraStream: async () => new URL('http://ha.invalid/index.m3u8?token=private-token') },
    env: { PORT: '4317', TV_CLIENT_TOKEN: CODE, HA_URL: 'http://ha.invalid/', HA_TOKEN: 'private-ha-token' },
    config: { entities: { cameras: [{ id: 'front', entityId: 'camera.front' }] } } });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  const request = (route, { headers = {}, method = 'GET', body, signal } = {}) => new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, signal, headers: { Host: '127.0.0.1:4317', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end(body);
  });
  const paired = await request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE }) });
  const headers = { Cookie: paired.headers['set-cookie'][0].split(';')[0] };
  const stream = JSON.parse((await request('/api/cameras/front/stream', { headers })).body).url;
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  return { bridge, base, headers, stream, request };
}

test('oversized HLS playlist fails safely before decoding and cancels upstream', async t => {
  let cancelled = 0;
  const f = await fixture(t, async () => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(1024 * 1024 + 1)); }, cancel() { cancelled++; } }),
    { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }));
  const response = await f.request(f.stream, { headers: f.headers }); assert.equal(response.status, 502); assert.equal(cancelled, 1);
  assert.doesNotMatch(response.body.toString(), /private|token|ha\.invalid/);
});

test('native HLS playlists retain .m3u8 aliases through the master and variant without exposing upstream URLs', async t => {
  const f = await fixture(t, async url => {
    if (url.pathname === '/index.m3u8') return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvariant.m3u8?token=private-token\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    if (url.pathname === '/variant.m3u8') return new Response('#EXTM3U\n#EXTINF:2,\nsegment.ts?token=private-token\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    return new Response(Buffer.from([0x47, 1, 2, 3]), { headers: { 'Content-Type': 'video/mp2t' } });
  });
  assert.match(f.stream, /\.m3u8$/);
  assert.equal((await f.request(f.stream)).status, 401);
  assert.equal((await f.request(f.stream.replace(/\.m3u8$/, ''), { headers: f.headers })).status, 200);
  const master = await f.request(f.stream, { headers: f.headers });
  const variant = master.body.toString().split('\n').find(line => line.startsWith('/api/streams/'));
  assert.match(variant, /\.m3u8$/);
  assert.doesNotMatch(master.body.toString(), /private-token|ha\.invalid/);
  const playlist = await f.request(variant, { headers: f.headers });
  const segment = playlist.body.toString().split('\n').find(line => line.startsWith('/api/streams/'));
  assert.equal((await f.request(segment, { headers: f.headers })).status, 200);
  assert.equal((await f.request(f.stream + '.mp4', { headers: f.headers })).status, 404);
});

test('HLS resources rotate under a bounded LRU; evicted/forged URLs fail before an upstream request', async t => {
  let sequence = 0, calls = 0;
  const f = await fixture(t, async url => {
    calls++;
    return url.pathname.endsWith('.m3u8') ? new Response(`#EXTM3U\n#EXTINF:2,\n${++sequence}.ts?token=private-token\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
      : new Response(Buffer.from([1, 2]), { headers: { 'Content-Type': 'video/mp2t' } });
  }, { hlsResourceOptions: { maxEntries: 3 } });
  const resources = [];
  for (let i = 0; i < 6; i++) {
    const playlist = await f.request(f.stream, { headers: f.headers }); assert.equal(playlist.status, 200);
    const text = playlist.body.toString(); assert.doesNotMatch(text, /private-token|ha\.invalid/);
    resources.push(text.split('\n').find(line => line.startsWith('/api/streams/')));
  }
  const before = calls; assert.equal((await f.request(resources[0], { headers: f.headers })).status, 404); assert.equal(calls, before);
  assert.equal((await f.request(resources.at(-1))).status, 401); assert.equal(calls, before);
  assert.equal((await f.request(resources.at(-1), { headers: f.headers })).status, 200);
});

test('native LL-HLS reloads forward bounded protocol fields while preserving the private registered upstream', async t => {
  let received, calls = 0;
  const f = await fixture(t, async url => { calls++; received = url; return new Response('#EXTM3U\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }); });
  assert.equal((await f.request(f.stream + '?_HLS_msn=19&_HLS_part=3&_HLS_skip=YES', { headers: f.headers })).status, 200);
  assert.equal(received.searchParams.get('_HLS_msn'), '19');
  assert.equal(received.searchParams.get('_HLS_part'), '3');
  assert.equal(received.searchParams.get('_HLS_skip'), 'YES');
  assert.equal(received.searchParams.get('token'), 'private-token');
  const before = calls;
  for (const query of ['_HLS_msn=2147483648', '_HLS_part=10001', '_HLS_skip=no', '_HLS_msn=1&_HLS_msn=2', 'url=https://other.invalid/', 'token=forged']) {
    assert.equal((await f.request(f.stream + '?' + query, { headers: f.headers })).status, 400);
  }
  assert.equal(calls, before);
});

test('client disconnect during HLS headers aborts the upstream fetch', { timeout: 3000 }, async t => {
  const entered = deferred(), cancelled = deferred();
  const f = await fixture(t, (_url, { signal }) => new Promise((resolve, reject) => {
    entered.resolve(); signal.addEventListener('abort', () => { cancelled.resolve(); reject(signal.reason); }, { once: true });
  }));
  const controller = new AbortController(), pending = f.request(f.stream, { headers: f.headers, signal: controller.signal });
  const checked = assert.rejects(pending, { name: 'AbortError' }); await entered.promise; controller.abort(); await checked; await cancelled.promise;
});

test('client disconnect while a media body is flowing cancels its source and fetch signal', { timeout: 3000 }, async t => {
  const cancelled = deferred(), signalAborted = deferred();
  const f = await fixture(t, async (url, { signal }) => {
    if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\npart.ts\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    signal.addEventListener('abort', () => signalAborted.resolve(), { once: true });
    return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from([1, 2, 3])); }, cancel() { cancelled.resolve(); } }), { headers: { 'Content-Type': 'video/mp2t' } });
  });
  const playlist = await f.request(f.stream, { headers: f.headers }), resource = playlist.body.toString().split('\n').find(line => line.startsWith('/api/streams/'));
  await new Promise((resolve, reject) => {
    const req = http.get(f.base + resource, { headers: { Host: '127.0.0.1:4317', ...f.headers } }, res => { res.once('data', () => { res.destroy(); req.destroy(); resolve(); }); res.on('error', () => {}); });
    req.on('error', reject);
  });
  await cancelled.promise; await signalAborted.promise;
});

test('HLS header deadline returns a typed safe 504 rather than keeping a pending connection', { timeout: 3000 }, async t => {
  const f = await fixture(t, (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), { hlsTimeoutMs: 10 });
  const result = await f.request(f.stream, { headers: f.headers }); assert.equal(result.status, 504); assert.doesNotMatch(result.body.toString(), /token|ha\.invalid/);
});

test('bridge shutdown cancels an in-flight HLS fetch instead of leaving its deadline alive', { timeout: 3000 }, async t => {
  const entered = deferred(), cancelled = deferred();
  const f = await fixture(t, (_url, { signal }) => new Promise((resolve, reject) => {
    entered.resolve(); signal.addEventListener('abort', () => { cancelled.resolve(); reject(signal.reason); }, { once: true });
  }));
  const pending = f.request(f.stream, { headers: f.headers });
  const checked = assert.rejects(pending, error => ['ECONNRESET', 'ABORT_ERR'].includes(error.code));
  await entered.promise; await f.bridge.close(); await checked; await cancelled.promise;
});
