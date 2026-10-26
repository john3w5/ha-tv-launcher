import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const SECRET = 'never-forward-upstream-secret';

async function fixture(t, { mapEntityId = 'camera.sample_037', snapshot = async () => new Response(JPEG, { headers: { 'Content-Type': 'image/jpeg', 'X-Private': SECRET, 'Set-Cookie': SECRET } }) } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tv-vacuum-map-'));
  const calls = [], bridge = await createBridge({ root, readOnlyPreview: true,
    env: { PORT: '4318', HA_URL: 'http://ha.invalid', HA_TOKEN: SECRET, TV_CLIENT_TOKEN: 'map-test-code' },
    config: { domesticPanel: { vacuum: { mapEntityId } } },
    ha: { snapshot: async entityId => { calls.push(entityId); return snapshot(); } } });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  const request = (route, { cookie, method = 'GET', body, origin = 'http://127.0.0.1:4318' } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: route, method,
      headers: { Host: '127.0.0.1:4318', Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const pair = await request('/api/pair', { method: 'POST', body: { code: 'map-test-code' } });
  const cookie = pair.headers['set-cookie'][0].split(';')[0];
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  return { request, cookie, calls };
}

test('vacuum map is cookie-authorized, fixed-source and safe in read-only preview', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/vacuum/map')).status, 401);
  const response = await f.request('/api/vacuum/map', { cookie: f.cookie });
  assert.equal(response.status, 200); assert.deepEqual(response.body, JPEG); assert.deepEqual(f.calls, ['camera.sample_037']);
  assert.equal(response.headers['content-type'], 'image/jpeg'); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-private'], undefined); assert.equal(response.headers['set-cookie'], undefined);
  assert.ok(!JSON.stringify(response.headers).includes(SECRET));
  assert.equal((await f.request('/api/vacuum/map?entity_id=camera.private', { cookie: f.cookie })).status, 400);
  assert.equal((await f.request('/api/vacuum/map', { cookie: f.cookie, origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await f.request('/api/vacuum/map', { cookie: f.cookie, method: 'POST' })).status, 403);
  assert.deepEqual(f.calls, ['camera.sample_037']);
});

test('unconfigured or arbitrary map cameras cannot be used as a proxy', async t => {
  for (const mapEntityId of [undefined, 'camera.private', 'http://ha.invalid/private']) {
    const f = await fixture(t, { mapEntityId: mapEntityId ?? null });
    assert.equal((await f.request('/api/vacuum/map', { cookie: f.cookie })).status, 503);
    assert.deepEqual(f.calls, []);
  }
});

test('map proxy rejects wrong MIME, format mismatch and private upstream errors without leaking details', async t => {
  const snapshots = [
    () => new Response('private body', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(JPEG, { headers: { 'Content-Type': 'image/png' } }),
    () => new Response('not a valid image', { headers: { 'Content-Type': 'image/jpeg' } }),
    () => { throw new Error(SECRET); },
  ];
  for (const snapshot of snapshots) {
    const f = await fixture(t, { snapshot }), response = await f.request('/api/vacuum/map', { cookie: f.cookie });
    assert.equal(response.status, 502); assert.ok(!response.body.toString().includes(SECRET)); assert.ok(!response.body.toString().includes('private body'));
  }
});

test('map size bound applies both to Content-Length and an unannounced oversized stream', async t => {
  let cancelled = false;
  const declared = await fixture(t, { snapshot: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(8 * 1024 * 1024 + 1) } }) });
  assert.equal((await declared.request('/api/vacuum/map', { cookie: declared.cookie })).status, 502); assert.equal(cancelled, true);
  const streamed = await fixture(t, { snapshot: () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/jpeg' } }) });
  assert.equal((await streamed.request('/api/vacuum/map', { cookie: streamed.cookie })).status, 502);
});
