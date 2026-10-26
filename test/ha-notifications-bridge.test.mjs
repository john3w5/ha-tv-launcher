import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from '../server.mjs';
import { TvControl } from '../lib/tv-control.mjs';

const ORIGIN = 'http://127.0.0.1:4317';
async function fixture(t, { ha, live = false, control } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'domov-native-bridge-'));
  const bridge = await createBridge({ root, config: { apps: [], entities: {} }, websocketClass: null, ...(ha ? { ha } : {}),
    ...(control ? { tvControl: control } : {}), env: { PORT: '4317', TV_CLIENT_TOKEN: 'pairing-test-only',
      ...(live ? { HA_URL: 'http://ha.example.test', HA_TOKEN: 'private-ha-test-token' } : {}),
      ...(control ? { TV_CONTROL_ENABLED: '1', TV_ADB_SERIAL: 'mock-device', ADB_PATH: '/mock/adb' } : {}) } });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const options = (path, cookie, origin = ORIGIN) => ({ host: '127.0.0.1', port: bridge.server.address().port, path,
    agent: false, headers: { Host: '127.0.0.1:4317', Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } });
  const request = (path, { method = 'GET', cookie, origin, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ ...options(path, cookie, origin), method }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
      });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const pair = async () => (await request('/api/pair', { method: 'POST', body: { code: 'pairing-test-only' } })).cookie;
  return { bridge, request, pair, options };
}
async function until(predicate) {
  const end = Date.now() + 1000;
  while (!predicate()) { if (Date.now() > end) assert.fail('Expected bridge event did not arrive'); await delay(2); }
}

test('native launch route checks auth+Origin and launches only a current installed app through strict TvControl', async t => {
  const commands = [];
  const control = new TvControl({ adbPath: '/mock/adb', serial: 'mock-device', runner: async (_path, args) => {
    const command = args.slice(3); commands.push(command);
    if (command.join(' ') === 'am get-current-user') return { code: 0, stdout: '0', stderr: '' };
    if (command.slice(0, 3).join(' ') === 'pm list packages') return { code: 0, stdout: 'package:cz.iprima.app', stderr: '' };
    if (command.slice(0, 3).join(' ') === 'cmd package query-activities') return { code: 0, stdout: command.at(-1) === 'android.intent.category.LEANBACK_LAUNCHER' ? 'cz.iprima.app/.MainActivity' : '', stderr: '' };
    if (command.slice(0, 2).join(' ') === 'am start') return { code: 0, stdout: 'Starting activity', stderr: '' };
    assert.fail('Unexpected mock ADB command');
  } });
  const f = await fixture(t, { control });
  assert.equal((await f.request('/api/tv/launch', { method: 'POST', body: { appId: 'cz.iprima.app' } })).status, 401);
  const cookie = await f.pair();
  assert.equal((await f.request('/api/tv/launch', { method: 'POST', cookie, origin: 'https://evil.example', body: { appId: 'cz.iprima.app' } })).status, 403);
  assert.equal(commands.length, 0);
  const launched = await f.request('/api/tv/launch', { method: 'POST', cookie, body: { appId: 'cz.iprima.app' } });
  assert.equal(launched.status, 200); assert.equal(launched.body.accepted, true); assert.equal(launched.body.verifiedForeground, false);
  assert.equal(commands.filter(command => command[0] === 'am' && command[1] === 'start').length, 1);
  const afterSuccess = commands.length;
  for (const body of [{ appId: 'intent://unsafe' }, { appId: 'cz.iprima.app', command: 'shell' }]) {
    assert.ok((await f.request('/api/tv/launch', { method: 'POST', cookie, body })).status >= 400);
    assert.equal(commands.length, afterSuccess);
  }
  assert.ok((await f.request('/api/tv/launch', { method: 'POST', cookie, body: { appId: 'not.installed.app' } })).status >= 400);
  assert.equal(commands.filter(command => command[0] === 'am' && command[1] === 'start').length, 1);
});

test('disabled native control returns unavailable after successful pairing', async t => {
  const f = await fixture(t), cookie = await f.pair();
  assert.equal((await f.request('/api/tv/launch', { method: 'POST', cookie, body: { appId: 'cz.iprima.app' } })).status, 503);
});

test('HA notification feed status and notices reach paired SSE clients and subscription stops on shutdown', async t => {
  let handlers, stopped = false;
  let status = { source: 'home_assistant', configured: true, connected: true, state: 'connected', lastEventAt: null };
  const ha = { subscribePersistentNotifications(callbacks) {
    handlers = callbacks; callbacks.onStatus({ ...status });
    return { getStatus: () => ({ ...status }), stop() { stopped = true; } };
  } };
  const f = await fixture(t, { ha, live: true });
  const bootstrap = await f.request('/api/bootstrap');
  assert.equal(bootstrap.body.notifications.connected, true);
  assert.ok(!JSON.stringify(bootstrap.body).includes('private-ha-test-token'));
  assert.equal((await f.request('/api/events')).status, 401);
  const cookie = await f.pair();
  let stream, wire = '';
  await new Promise((resolve, reject) => {
    stream = http.request(f.options('/api/events', cookie), res => { res.on('data', chunk => { wire += chunk.toString(); }); resolve(); });
    stream.on('error', reject); stream.end();
  });
  t.after(() => stream.destroy());
  await until(() => wire.includes('event: ha_notification_status'));
  handlers.onNotification({ id: 'ha-test-opaque', source: 'home_assistant', title: 'Domov', message: 'Harmless test', type: 'info' });
  await until(() => wire.includes('Harmless test'));
  assert.match(wire, /event: notification\n/);
  handlers.onRemove({ id: 'ha-test-opaque', source: 'home_assistant' });
  await until(() => wire.includes('event: notification_remove'));
  status = { ...status, connected: false, state: 'reconnecting' }; handlers.onStatus(status);
  await until(() => wire.includes('reconnecting'));
  assert.equal((await f.request('/api/bootstrap')).body.notifications.connected, false);
  assert.ok(!wire.includes('private-ha-test-token'));
  stream.destroy(); await f.bridge.close();
  assert.equal(stopped, true);
});
