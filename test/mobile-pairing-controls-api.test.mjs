import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const ORIGIN = 'http://127.0.0.1:4317', CODE = 'long-private-tv-pairing-test-token';
async function fixture(t, { readOnlyPreview = false, failService = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mobile-controls-api-')));
  let time = Date.now(); const calls = [];
  const states = new Map([
    ['light.living', { entity_id: 'light.living', state: 'off', attributes: {} }],
    ['climate.bedroom', { entity_id: 'climate.bedroom', state: 'auto', attributes: { temperature: 20, min_temp: 5, max_temp: 30, target_temp_step: .5, supported_features: 1 } }],
  ]);
  const bridge = await createBridge({ root, readOnlyPreview, mobilePairingNow: () => time,
    config: { entities: { lights: [{ entityId: 'light.living', name: 'Obývák' }, { entityId: 'light.controller', name: 'Stav', role: 'controller-status' }] },
      domesticPanel: { rooms: [{ id: 'bedroom', name: 'Ložnice', entityId: 'climate.bedroom' }] } },
    env: { PORT: '4317', TV_CLIENT_TOKEN: CODE, HA_URL: 'http://ha.invalid', HA_TOKEN: 'test-only-token' },
    ha: { request: async (route, options) => { calls.push({ route, ...options });
      if (!options?.method) return states.get(route.replace('api/states/', ''));
      if (failService) throw Error('UPSTREAM-PRIVATE-TOKEN'); return [];
    } } });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const request = (route, { method = 'GET', body, cookie, origin = ORIGIN } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: route, method,
      headers: { Host: '127.0.0.1:4317', Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)), headers: res.headers }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const pair = code => request('/api/pair', { method: 'POST', body: { code: code || CODE } });
  return { request, pair, calls, advance(ms) { time += ms; } };
}
const cookieOf = response => response.headers['set-cookie']?.[0].split(';')[0];

test('paired TV issues a short mobile code without revealing its long token; mobile uses the existing pair endpoint once', async t => {
  const f = await fixture(t), cookie = cookieOf(await f.pair());
  assert.equal((await f.request('/api/mobile/pairing', { method: 'POST', body: {} })).status, 401);
  assert.equal((await f.request('/api/mobile/pairing', { method: 'POST', body: {}, cookie, origin: 'http://evil.invalid' })).status, 403);
  const enrollment = await f.request('/api/mobile/pairing', { method: 'POST', body: {}, cookie });
  assert.equal(enrollment.status, 200); assert.match(enrollment.body.code, /^\d{8}$/); assert.equal(enrollment.body.url, '/manage.html');
  assert.equal(JSON.stringify(enrollment.body).includes(CODE), false);
  const mobile = await f.pair(enrollment.body.code); assert.equal(mobile.status, 200); const mobileCookie = cookieOf(mobile); assert.ok(mobileCookie);
  assert.equal((await f.pair(enrollment.body.code)).status, 401);
  const bootstrap = await f.request('/api/bootstrap', { cookie: mobileCookie });
  assert.equal(bootstrap.body.authenticated, true); assert.ok(bootstrap.body.clientSettings); assert.equal(bootstrap.body.mobilePairingAvailable, true);
  assert.equal(f.calls.length, 0);
});

test('expired/replaced codes and codes owned by a logged-out TV cannot pair a phone', async t => {
  const f = await fixture(t), cookie = cookieOf(await f.pair());
  const issue = () => f.request('/api/mobile/pairing', { method: 'POST', body: {}, cookie }).then(response => response.body.code);
  const old = await issue(), current = await issue(); assert.equal((await f.pair(old)).status, 401);
  f.advance(60000); assert.equal((await f.pair(current)).status, 401);
  const revoked = await issue(); await f.request('/api/logout', { method: 'POST', body: {}, cookie }); assert.equal((await f.pair(revoked)).status, 401);
});

test('mobile enrollment does not bypass the existing five-attempt IP pairing limit', async t => {
  const f = await fixture(t), cookie = cookieOf(await f.pair());
  const enrollment = await f.request('/api/mobile/pairing', { method: 'POST', body: {}, cookie });
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await f.pair('0000')).status, 401);
  assert.equal((await f.pair(enrollment.body.code)).status, 429); assert.equal(f.calls.length, 0);
});

test('control API checks auth/origin/exact schema then emits only fixed services to the exact allowed sources', async t => {
  const f = await fixture(t), cookie = cookieOf(await f.pair());
  const command = { type: 'temperature', id: 'bedroom', delta: .5 };
  assert.equal((await f.request('/api/control', { method: 'POST', body: command })).status, 401);
  assert.equal((await f.request('/api/control', { method: 'POST', body: command, cookie, origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await f.request('/api/control', { method: 'POST', body: { ...command, hvac_mode: 'heat' }, cookie })).status, 400);
  assert.equal((await f.request('/api/control', { method: 'POST', body: { type: 'light', id: 'light.controller', on: true }, cookie })).status, 400);
  assert.deepEqual(f.calls, []);
  const accepted = await f.request('/api/control', { method: 'POST', body: command, cookie });
  assert.equal(accepted.body.accepted, true); assert.equal(accepted.body.verified, false); assert.equal(accepted.body.requested.temperature, 20.5);
  assert.deepEqual(f.calls, [{ route: 'api/states/climate.bedroom' }, { route: 'api/services/climate/set_temperature', method: 'POST', body: { entity_id: 'climate.bedroom', temperature: 20.5 } }]);
  const bootstrap = await f.request('/api/bootstrap', { cookie });
  assert.deepEqual(bootstrap.body.controls.lights, [{ id: 'light.living', name: 'Obývák' }]);
  assert.equal(bootstrap.body.controls.freshValidation, true);
});

test('HA service errors are neither accepted nor leaked, and preview rejects both enrollment and control writes', async t => {
  const failed = await fixture(t, { failService: true }), cookie = cookieOf(await failed.pair());
  const response = await failed.request('/api/control', { method: 'POST', body: { type: 'light', id: 'light.living', on: true }, cookie });
  assert.equal(response.status, 502); assert.equal(response.body.accepted, undefined); assert.equal(JSON.stringify(response.body).includes('UPSTREAM-PRIVATE'), false);
  const preview = await fixture(t, { readOnlyPreview: true }), previewCookie = cookieOf(await preview.pair());
  for (const route of ['/api/mobile/pairing', '/api/control']) assert.equal((await preview.request(route, { method: 'POST', body: {}, cookie: previewCookie })).status, 403);
  assert.equal((await preview.request('/api/bootstrap', { cookie: previewCookie })).body.controls.available, false); assert.equal(preview.calls.length, 0);
});
