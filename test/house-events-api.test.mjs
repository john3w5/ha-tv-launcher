import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const CODE = 'house-api-pair-code';
const TOKEN = 'house-api-webhook-secret';
const ORIGIN = 'http://127.0.0.1:4317';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tv-house-api-'));
  const sockets = [];
  class FakeWebSocket {
    constructor() { this.listeners = new Map(); this.sent = []; this.closed = false; sockets.push(this); }
    addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); }
    send(value) { this.sent.push(JSON.parse(value)); }
    receive(value) { for (const callback of this.listeners.get('message') || []) callback({ data: JSON.stringify(value) }); }
    close() { if (this.closed) return; this.closed = true; for (const callback of this.listeners.get('close') || []) callback(); }
  }
  let notificationStopped = false;
  const bridge = await createBridge({ root, env: { PORT: '4317', TV_CLIENT_TOKEN: CODE, TV_WEBHOOK_TOKEN: TOKEN, HA_URL: 'http://ha.invalid', HA_TOKEN: 'HA-PRIVATE' },
    config: { entities: { cameras: ['entrance', 'cars', 'yard'].map(id => ({ id, entityId: `camera.${id}` })) }, houseEvents: { enabled: true,
      doorbells: [{ id: 'door', source: 'automation', entityId: 'automation.door', requiredSource: 'webhook', cameraId: 'entrance', title: 'U dveří', cooldownSeconds: 8 },
        { id: 'gate', source: 'event_entity', entityId: 'event.gate', eventTypes: ['btn_down'], cameraId: 'cars' }],
      alerts: [{ id: 'leak', type: 'binary_on', entityId: 'binary_sensor.leak', title: 'Voda', message: 'Čidlo hlásí vodu.', tone: 'warning' }] } },
    ha: { base: new URL('http://ha.invalid'), subscribePersistentNotifications: () => ({ getStatus: () => ({ connected: true }),
      getCurrent: () => [{ id: 'ha-opaque', title: 'Připomínka', message: 'Ověřená trvalá zpráva', type: 'info', source: 'home_assistant', raw: 'HA-PRIVATE' }], stop() { notificationStopped = true; } }) },
    websocketClass: FakeWebSocket });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  const request = (route, { method = 'GET', body, cookie, origin = ORIGIN, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: route, method,
      headers: { Host: '127.0.0.1:4317', ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers } }, response => {
      resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const post = (route, body, options = {}) => request(route, { ...options, method: 'POST', body });
  const paired = await post('/api/pair', { code: CODE });
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const connectHouse = (state = 'off') => {
    const socket = sockets[0]; socket.receive({ type: 'auth_required' }); socket.receive({ type: 'auth_ok' });
    socket.receive({ type: 'result', id: 1, success: true, result: [{ entity_id: 'binary_sensor.leak', state, attributes: {} }] });
    socket.receive({ type: 'result', id: 2, success: true }); socket.receive({ type: 'result', id: 3, success: true });
    return socket;
  };
  t.after(async () => { await bridge.close(); assert.equal(notificationStopped, true); assert.equal(sockets[0].closed, true); await rm(root, { recursive: true, force: true }); });
  return { request, post, cookie, connectHouse, sockets };
}

test('authenticated reminders project current native and active house notes with truthful connection state', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/notifications')).status, 401);
  const before = await (await f.request('/api/notifications', { cookie: f.cookie })).json();
  assert.equal(before.connected, true); assert.equal(before.houseConnected, false); assert.equal(before.notifications.length, 1);
  const socket = f.connectHouse('on');
  const response = await f.request('/api/notifications', { cookie: f.cookie });
  const text = await response.text(), data = JSON.parse(text);
  assert.equal(data.houseConnected, true); assert.equal(data.notifications.length, 2);
  assert.ok(data.notifications.some(note => note.id === 'house-leak' && note.type === 'warning'));
  assert.equal(text.includes('HA-PRIVATE'), false); assert.equal(text.includes('binary_sensor'), false);
  socket.close();
  const disconnected = await (await f.request('/api/notifications', { cookie: f.cookie })).json();
  assert.equal(disconnected.houseConnected, false); assert.equal(disconnected.notifications.length, 1);
});

test('manual doorbell requires authorization/origin and exact configured bell-camera mapping', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/doorbell', { cameraId: 'entrance' })).status, 401);
  assert.equal((await f.post('/api/doorbell', { cameraId: 'entrance' }, { cookie: f.cookie, origin: 'http://evil.invalid' })).status, 403);
  for (const body of [{ cameraId: 'yard' }, { cameraId: '../entrance' }, { cameraId: 'camera.entrance' }, { cameraId: 'entrance', durationSeconds: 999 }, { cameraId: 'entrance', title: {} }]) {
    assert.equal((await f.post('/api/doorbell', body, { cookie: f.cookie })).status, 400);
  }
  assert.equal((await f.post('/api/doorbell', { cameraId: 'entrance' }, { cookie: f.cookie })).status, 202);
  assert.equal((await f.post('/api/doorbell', { cameraId: 'entrance' }, { cookie: f.cookie })).status, 429);
  assert.equal((await f.post('/api/doorbell', { cameraId: 'cars' }, { origin: null, headers: { Authorization: `Bearer ${TOKEN}` } })).status, 202);
});

test('manual doorbell and genuine house transition use existing SSE; initial states do not toast', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const socket = f.connectHouse();
  const response = await f.request('/api/events', { cookie: f.cookie });
  const reader = response.body.getReader();
  const readUntil = async pattern => {
    let text = '';
    for (let count = 0; count < 10; count++) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); if (pattern.test(text)) return text; }
    assert.fail('Expected SSE event did not arrive');
  };
  const initial = await readUntil(/event: ha_house_status/);
  assert.equal(initial.includes('event: notification\n'), false); assert.equal(initial.includes('event: doorbell\n'), false);
  assert.equal((await f.post('/api/doorbell', { cameraId: 'entrance', title: 'Pouze TV test' }, { cookie: f.cookie })).status, 202);
  const bell = await readUntil(/event: doorbell/);
  assert.match(bell, /"cameraId":"entrance"/); assert.match(bell, /"durationSeconds":15/);
  socket.receive({ type: 'event', id: 2, event: { event_type: 'state_changed', time_fired: new Date().toISOString(),
    data: { entity_id: 'binary_sensor.leak', old_state: { state: 'off', attributes: {} }, new_state: { state: 'on', attributes: {} } } } });
  const notice = await readUntil(/event: notification/);
  assert.match(notice, /Čidlo hlásí vodu/);
});
