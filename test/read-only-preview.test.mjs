import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const CODE = 'preview-test-pair';
const OFFER = 'v=0\r\na=recvonly\r\n';
const CANDIDATE = { candidate: 'candidate:1 1 UDP 1 192.168.50.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };

async function fixture(t, { preview = true, apps = [{ appId: 'com.netflix.ninja', name: 'Netflix' }], root, persistent = false } = {}) {
  const directory = root || await realpath(await mkdtemp(path.join(os.tmpdir(), 'tv-preview-')));
  const calls = [], signaling = [];
  const env = { PORT: preview ? '4318' : '4317', TV_CLIENT_TOKEN: CODE, TV_WEBHOOK_TOKEN: 'mock-webhook-token', HA_URL: 'http://ha.invalid', HA_TOKEN: 'mock-ha-token',
    TV_CONTROL_ENABLED: '1', NIGHT_CONTROL_ENABLED: '1', ADB_PATH: '/never-use-adb', TV_ADB_SERIAL: 'must-not-connect', CODEX_PATH: '/never-use-codex',
    TV_SESSION_STORE: path.join(directory, 'private', 'production-sessions.json') };
  const forbid = async () => { calls.push('DEVICE-WRITE'); assert.fail('Preview must not invoke device control'); };
  const bridge = await createBridge({ root: directory, env, config: { entities: { cameras: [{ id: 'entrance', entityId: 'camera.entrance' }] } },
    readOnlyPreview: preview, previewApps: apps,
    ...(persistent ? { sessionStorePath: path.join(directory, 'private', preview ? 'preview-sessions.json' : 'production-sessions.json') } : {}),
    ha: { states: async () => { calls.push('read-states'); return []; }, scene: forbid, request: forbid },
    tvControl: { listApps: forbid, launchApp: forbid }, nightService: { prepare: forbid, commit: forbid },
    createWebRtcSession: async options => { signaling.push(options); return { answer: 'v=0\r\na=sendonly\r\n', candidates: [], sendCandidate: async () => {}, close() {} }; },
  });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  const request = (route, { method = 'GET', body, cookie } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: route, method,
      headers: { Host: `127.0.0.1:${env.PORT}`, Origin: `http://127.0.0.1:${env.PORT}`, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const pair = async () => { const response = await request('/api/pair', { method: 'POST', body: { code: CODE } }); assert.equal(response.status, 200); return response.headers['set-cookie'][0].split(';')[0]; };
  t.after(async () => { await bridge.close(); if (!root) await rm(directory, { recursive: true, force: true }); });
  return { request, pair, calls, signaling, directory };
}

test('read-only preview disables all device mutations even with enabled env flags and valid cookie', async t => {
  const f = await fixture(t);
  const cookie = await f.pair();
  const bootstrap = (await f.request('/api/bootstrap', { cookie })).body;
  assert.deepEqual(bootstrap.preview, { live: true, readOnly: true });
  assert.deepEqual(bootstrap.assistant, { available: false, provider: null, tvControl: false });
  for (const route of ['/api/notify', '/api/media', '/api/doorbell', '/api/night/prepare', '/api/night/commit', '/api/action', '/api/tv/launch', '/api/assistant', '/api/assistant/confirm', '/api/photos/upload']) {
    assert.equal((await f.request(route, { method: 'POST', body: {}, cookie })).status, 403, route);
  }
  assert.equal((await f.request('/api/pair', { method: 'PUT', body: {}, cookie })).status, 403);
  assert.equal((await f.request('/api/dashboard', { cookie })).status, 200);
  assert.deepEqual(f.calls, ['read-states']);
});

test('preview app list is a detached approved snapshot and never queries ADB', async t => {
  const apps = [{ appId: 'com.netflix.ninja', name: 'Netflix' }, { appId: 'javascript:bad', name: 'bad' }];
  const f = await fixture(t, { apps });
  const cookie = await f.pair(); apps[0].name = 'edited later';
  const response = await f.request('/api/tv/apps', { cookie });
  assert.equal(response.status, 200); assert.equal(response.body.source, 'approved_snapshot'); assert.equal(response.body.queriedAt, null);
  assert.deepEqual(response.body.apps, [{ appId: 'com.netflix.ninja', name: 'Netflix' }]); assert.deepEqual(f.calls, []);
  const empty = await fixture(t, { apps: [] });
  assert.equal((await empty.request('/api/tv/apps', { cookie: await empty.pair() })).status, 503);
});

test('preview permits only owner-bound camera signaling and auth cleanup mutations', async t => {
  const f = await fixture(t);
  const cookie = await f.pair();
  const created = await f.request('/api/cameras/entrance/webrtc', { method: 'POST', body: { offer: OFFER }, cookie });
  assert.equal(created.status, 200); assert.equal(f.signaling[0].entityId, 'camera.entrance');
  const route = `/api/webrtc/${created.body.sessionId}`;
  assert.equal((await f.request(route + '/candidate', { method: 'POST', body: { candidate: CANDIDATE }, cookie })).status, 200);
  assert.equal((await f.request(route, { method: 'DELETE', cookie })).status, 200);
  assert.equal((await f.request('/api/logout', { method: 'POST', body: {}, cookie })).status, 200);
  assert.deepEqual(f.calls, []);
});

test('preview and production cookie names and stores are isolated across two ports', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tv-two-port-preview-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const production = await fixture(t, { preview: false, root, persistent: true });
  const preview = await fixture(t, { root, persistent: true });
  const prodCookie = await production.pair(), previewCookie = await preview.pair();
  assert.match(prodCookie, /^tv_session=/); assert.match(previewCookie, /^tv_preview_session=/);
  assert.equal((await preview.request('/api/bootstrap', { cookie: prodCookie })).body.authenticated, false);
  assert.equal((await production.request('/api/bootstrap', { cookie: previewCookie })).body.authenticated, false);
  const bothCookies = `${prodCookie}; ${previewCookie}`;
  assert.equal((await production.request('/api/bootstrap', { cookie: bothCookies })).body.authenticated, true);
  assert.equal((await preview.request('/api/bootstrap', { cookie: bothCookies })).body.authenticated, true);
  const logout = await preview.request('/api/logout', { method: 'POST', body: {}, cookie: bothCookies });
  assert.match(logout.headers['set-cookie'][0], /^tv_preview_session=;/);
  assert.equal((await production.request('/api/bootstrap', { cookie: bothCookies })).body.authenticated, true);
  assert.equal((await preview.request('/api/bootstrap', { cookie: bothCookies })).body.authenticated, false);
});
