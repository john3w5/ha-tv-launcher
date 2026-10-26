import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const ORIGIN = 'http://127.0.0.1:4317', CODE = 'phone-settings-test-code';
async function fixture(t, { readOnlyPreview = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'phone-settings-api-')));
  const state = path.join(root, 'private', 'state'), env = { PORT: '4317', TV_CLIENT_TOKEN: CODE, TV_SESSION_STORE: path.join(state, 'sessions.json') };
  let bridge;
  async function start() {
    bridge = await createBridge({ root, config: { photos: { intervalSeconds: 40 } }, env, readOnlyPreview });
    await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  }
  await start(); t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const request = (route, { method = 'GET', body, cookie, origin = ORIGIN } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: route, method,
      headers: { Host: '127.0.0.1:4317', Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)), headers: res.headers }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const pair = () => request('/api/pair', { method: 'POST', body: { code: CODE } }).then(res => res.headers['set-cookie'][0].split(';')[0]);
  return { request, pair, broadcast: (...args) => bridge.broadcast(...args), restart: async () => { await bridge.close(); await start(); } };
}

test('phone preferences and timeline require pairing; only allowed display preferences may be written from the same origin', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/client-settings')).status, 401); assert.equal((await f.request('/api/timeline')).status, 401);
  const cookie = await f.pair();
  const initial = await f.request('/api/client-settings', { cookie }); assert.equal(initial.body.settings.photoIntervalSeconds, 40);
  const mutation = body => ({ method: 'PUT', cookie, body });
  assert.equal((await f.request('/api/client-settings', { ...mutation({ theme: 'dark' }), origin: 'http://evil.invalid' })).status, 403);
  for (const body of [{ HA_TOKEN: 'secret' }, { appOrder: ['com.netflix.ninja'] }, { safeScenes: ['scene.lock'] }, { theme: 'dark', haUrl: 'http://evil' }]) {
    assert.equal((await f.request('/api/client-settings', mutation(body))).status, 400);
  }
  const changed = await f.request('/api/client-settings', mutation({ theme: 'dark', navigationSounds: false, saverMinutes: 0, photoIntervalSeconds: 55 }));
  assert.equal(changed.status, 200); assert.equal(changed.body.settings.navigationSounds, false); assert.equal(changed.body.scope, 'household');
  const bootstrap = await f.request('/api/bootstrap', { cookie }); assert.equal(bootstrap.body.clientSettings.settings.theme, 'dark');
  await f.restart();
  const after = await f.request('/api/client-settings', { cookie }); assert.deepEqual(after.body, changed.body);
  assert.equal((await f.request('/api/timeline?limit=101', { cookie })).status, 400);
  assert.equal((await f.request('/api/timeline?limit=5.1', { cookie })).status, 400);
});

test('notification broadcast records a bounded summary once across bridge restart, removal permits a new reminder', async t => {
  const f = await fixture(t), cookie = await f.pair();
  const note = { id: 'ha-aaaaaaaaaaaaaaaaaaaaaaaa', source: 'home_assistant', title: 'Vysavač', message: 'Vyprázdni nádobu', type: 'warning', latitude: 49, privateToken: 'exclude-me' };
  assert.equal(f.broadcast('notification', note), true); assert.equal(f.broadcast('notification', note), false);
  let result = await f.request('/api/timeline', { cookie }); assert.equal(result.body.events.length, 1); assert.equal(JSON.stringify(result.body).includes('exclude-me'), false);
  await f.restart(); assert.equal(f.broadcast('notification', note), false);
  f.broadcast('notification_remove', { id: note.id }); assert.equal(f.broadcast('notification', note), true);
  result = await f.request('/api/timeline?limit=1', { cookie }); assert.equal(result.body.events.length, 1); assert.equal(result.body.events[0].source, 'home_assistant');
  assert.equal(result.body.persistent, true);
});

test('read-only preview can inspect preferences but cannot mutate household display settings', async t => {
  const f = await fixture(t, { readOnlyPreview: true }), cookie = await f.pair();
  assert.equal((await f.request('/api/client-settings', { cookie })).status, 200);
  assert.equal((await f.request('/api/client-settings', { method: 'PUT', body: { theme: 'dark' }, cookie })).status, 403);
});
