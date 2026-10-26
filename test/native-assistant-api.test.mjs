import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const ORIGIN = 'http://127.0.0.1:4317', CODE = 'native-assistant-test-code';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-assistant-api-'));
  let commands = 0;
  const bridge = await createBridge({ root, config: {}, env: { PORT: '4317', TV_CLIENT_TOKEN: CODE, HA_URL: 'http://ha.invalid', HA_TOKEN: 'test-only-token' },
    ha: { request() { commands++; throw Error('No physical command allowed'); } } });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const request = (route, body, cookie, origin = ORIGIN) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: route, method: body ? 'POST' : 'GET',
      headers: { Host: '127.0.0.1:4317', Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)), headers: res.headers }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const pair = () => request('/api/pair', { code: CODE }).then(res => res.headers['set-cookie'][0].split(';')[0]);
  return { request, pair, commandCount: () => commands };
}

test('HA-host assistant is available without server ADB/CLI and native plan is authenticated and inert', async t => {
  const f = await fixture(t), cookie = await f.pair();
  const bootstrap = await f.request('/api/bootstrap', null, cookie);
  assert.deepEqual(bootstrap.body.assistant, { available: true, provider: 'ha-native', tvControl: false, nativeCommands: true });
  const body = { text: 'Otevři Netflix', installedApps: ['com.netflix.ninja'] };
  assert.equal((await f.request('/api/assistant', body)).status, 401);
  assert.equal((await f.request('/api/assistant', body, cookie, 'http://evil.invalid')).status, 403);
  assert.equal((await f.request('/api/assistant', { ...body, nativeAction: { type: 'raw_service' } }, cookie)).status, 400);
  const prepared = await f.request('/api/assistant', body, cookie);
  assert.equal(prepared.status, 200); assert.equal(prepared.body.status, 'confirmation'); assert.equal(f.commandCount(), 0);
  const result = await f.request('/api/assistant/confirm', { confirmationId: prepared.body.confirmationId }, cookie);
  assert.equal(result.status, 200); assert.deepEqual(result.body.nativeAction, { type: 'launch_app', appId: 'com.netflix.ninja' });
  assert.equal(f.commandCount(), 0);
  assert.equal((await f.request('/api/assistant/confirm', { confirmationId: prepared.body.confirmationId }, cookie)).status, 409);
});

test('native API rejects a different paired session and extra confirm fields without consuming owner plan', async t => {
  const f = await fixture(t), owner = await f.pair(), other = await f.pair();
  const prepared = await f.request('/api/assistant', { text: 'Zesil' }, owner);
  assert.equal((await f.request('/api/assistant/confirm', { confirmationId: prepared.body.confirmationId }, other)).status, 409);
  assert.equal((await f.request('/api/assistant/confirm', { confirmationId: prepared.body.confirmationId, url: 'intent://evil' }, owner)).status, 400);
  const result = await f.request('/api/assistant/confirm', { confirmationId: prepared.body.confirmationId }, owner);
  assert.deepEqual(result.body.nativeAction, { type: 'key', key: 'volume_up' }); assert.equal(f.commandCount(), 0);
});
