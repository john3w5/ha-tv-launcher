import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const CODE = 'snapshot-test-pair';
const ORIGIN = 'http://127.0.0.1:4317';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const image = () => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(t, snapshot) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tv-snapshot-api-'));
  const ha = { base: new URL('http://private-ha.invalid/'), snapshot };
  const bridge = await createBridge({ root, ha, websocketClass: null,
    env: { PORT: '4317', TV_CLIENT_TOKEN: CODE, HA_URL: 'http://private-ha.invalid/', HA_TOKEN: 'not-a-real-token' },
    config: { entities: { cameras: [{ id: 'front', name: 'Front', entityId: 'camera.main', streamEntityId: 'camera.low' }, { id: 'alias', entityId: 'camera.main', streamEntityId: 'camera.low' }] } } });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  const request = (route, { headers = {}, signal, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, signal, headers: { Host: '127.0.0.1:4317', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end(body);
  });
  const paired = await request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE }) });
  const cookie = paired.headers['set-cookie'][0].split(';')[0];
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  return { bridge, request, headers: { Cookie: cookie } };
}

test('snapshot auth and quality validation run before cache, smooth uses configured low and timestamp queries do not reach HA', async t => {
  const calls = []; const f = await fixture(t, async entityId => { calls.push(entityId); return image(); });
  assert.equal((await f.request('/api/cameras/front/snapshot')).status, 401);
  assert.equal((await f.request('/api/cameras/unknown/snapshot', { headers: f.headers })).status, 404);
  for (const query of ['quality=', 'quality=invalid', 'quality=hd&quality=smooth']) assert.equal((await f.request('/api/cameras/front/snapshot?' + query, { headers: f.headers })).status, 400);
  assert.equal(calls.length, 0);
  const first = await f.request('/api/cameras/front/snapshot?t=1', { headers: f.headers });
  assert.equal(first.status, 200); assert.equal(first.headers['x-camera-quality'], 'smooth'); assert.deepEqual(first.body, jpeg);
  await f.request('/api/cameras/alias/snapshot?t=2', { headers: f.headers }); assert.deepEqual(calls, ['camera.low']);
  const hd = await f.request('/api/cameras/front/snapshot?quality=hd', { headers: f.headers });
  assert.equal(hd.headers['x-camera-quality'], 'hd'); assert.deepEqual(calls, ['camera.low', 'camera.main']);
  assert.equal((await f.request('/api/cameras/front/snapshot')).status, 401, 'cached image never bypasses pairing');
});

test('two HTTP clients share one load and one disconnect leaves the other response intact', { timeout: 3000 }, async t => {
  const entered = deferred(), release = deferred(); let signal, calls = 0;
  const f = await fixture(t, async (_entity, input) => { calls++; signal = input.signal; entered.resolve(); await release.promise; return image(); });
  const controller = new AbortController(), a = f.request('/api/cameras/front/snapshot', { headers: f.headers, signal: controller.signal });
  const cancelled = assert.rejects(a, { name: 'AbortError' });
  const b = f.request('/api/cameras/front/snapshot', { headers: f.headers });
  await entered.promise; await new Promise(resolve => setImmediate(resolve)); controller.abort(); await cancelled;
  assert.equal(signal.aborted, false); release.resolve(); assert.equal((await b).status, 200); assert.equal(calls, 1);
});

test('last HTTP client disconnect aborts the actual HA snapshot fetch', { timeout: 3000 }, async t => {
  const entered = deferred(), wasAborted = deferred();
  const f = await fixture(t, (_entity, { signal }) => new Promise((resolve, reject) => {
    entered.resolve(); signal.addEventListener('abort', () => { wasAborted.resolve(); reject(signal.reason); }, { once: true });
  }));
  const controller = new AbortController(), pending = f.request('/api/cameras/front/snapshot', { headers: f.headers, signal: controller.signal });
  const cancelled = assert.rejects(pending, { name: 'AbortError' }); await entered.promise; controller.abort(); await cancelled; await wasAborted.promise;
});

test('upstream errors remain safe at the image API and a later request can recover', async t => {
  let calls = 0; const f = await fixture(t, async () => { if (++calls === 1) throw Error('http://private-ha.invalid/?token=not-a-real-token'); return image(); });
  const failed = await f.request('/api/cameras/front/snapshot', { headers: f.headers }); assert.equal(failed.status, 502);
  assert.doesNotMatch(failed.body.toString(), /private-ha|token|http:/);
  assert.equal((await f.request('/api/cameras/front/snapshot', { headers: f.headers })).status, 200);
});
