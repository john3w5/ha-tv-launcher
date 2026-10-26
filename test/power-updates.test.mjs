import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createPowerUpdates } from '../lib/power-updates.mjs';
import { subscribeHouseEvents } from '../lib/house-events.mjs';
import { createBridge } from '../server.mjs';

const START = Date.parse('2026-10-25T09:00:00Z');
const state = (value = '1.9', attrs = {}, at = START) => ({ entity_id: 'sensor.house', state: value,
  attributes: { unit_of_measurement: 'kW', ...attrs }, last_updated: new Date(at).toISOString() });
function harness() {
  let time = START, next = 0; const timers = new Map(), updates = [], statuses = [];
  const power = createPowerUpdates({ entityId: 'sensor.house', now: () => time, onUpdate: value => updates.push({ at: time, ...value }), onStatus: value => statuses.push(value),
    setTimer(fn, delay) { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; }, clearTimer(id) { timers.delete(id); } });
  const advance = ms => { time += ms; let due; while ((due = [...timers].find(([, timer]) => timer.at <= time))) { timers.delete(due[0]); due[1].fn(); } };
  return { power, updates, statuses, timers, advance };
}

test('power source values are projected truthfully and coalesced to at most one update per second', () => {
  const f = harness(); f.power.ingest(state()); f.power.setStatus({ connected: true });
  assert.equal(f.updates[0].powerW, 1900); assert.equal(f.updates[0].unit, 'kW');
  f.advance(100); f.power.ingest(state('2', {}, START + 100)); f.advance(100); f.power.ingest(state('2.1', {}, START + 200));
  assert.equal(f.updates.length, 1); assert.equal(f.timers.size, 1);
  f.advance(800); assert.equal(f.updates.length, 2); assert.equal(f.updates[1].powerW, 2100); assert.equal(f.timers.size, 0);
  f.advance(2000); f.power.ingest(state('2.2', {}, START + 3000)); assert.equal(f.updates.length, 3);
  assert.ok(f.updates.every((entry, i) => i === 0 || entry.at - f.updates[i - 1].at >= 1000));
});

test('power does not invent updates or units; restored/unavailable/disconnected sources become unknown and close cancels work', () => {
  const f = harness(); f.power.ingest(state()); f.power.setStatus({ connected: true });
  f.advance(1000); f.power.ingest(state()); assert.equal(f.updates.length, 1);
  for (const value of [state('unknown'), state('2', { unit_of_measurement: '%' }), state('2', { restored: true }), state('1e308')]) {
    f.advance(1000); f.power.ingest(value); assert.equal(f.power.getCurrent().available, false); assert.equal(f.power.getCurrent().powerW, null);
  }
  f.advance(1000); f.power.ingest(state('2.3')); f.power.setStatus({ connected: false, state: 'reconnecting' });
  assert.equal(f.power.getCurrent().available, false); f.advance(1000); assert.equal(f.updates.at(-1).available, false);
  f.power.setStatus({ connected: true }); assert.equal(f.power.getCurrent().available, false);
  f.power.ingest(state('2.4')); f.power.close(); assert.equal(f.timers.size, 0); const count = f.updates.length; f.advance(10000); assert.equal(f.updates.length, count);
});

test('the existing HA subscription taps just the configured power source without leaking other attributes or old events', t => {
  let socket; const received = [];
  class FakeSocket {
    constructor() { socket = this; this.listeners = new Map(); this.sent = []; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    receive(value) { this.listeners.get('message')({ data: JSON.stringify(value) }); }
    close() {}
  }
  const feed = subscribeHouseEvents({ url: 'http://ha.invalid', token: 'test-only', config: { enabled: false }, websocketClass: FakeSocket,
    now: () => START, stateEntityIds: ['sensor.house'], onState: value => received.push(value) }); t.after(() => feed.stop());
  socket.receive({ type: 'auth_required' }); socket.receive({ type: 'auth_ok' });
  assert.deepEqual(socket.sent.map(command => command.type), ['auth', 'get_states', 'subscribe_events', 'subscribe_events']);
  socket.receive({ id: 1, type: 'result', success: true, result: [state('1.9', { access_token: 'SECRET', latitude: 49 }), { ...state('100'), entity_id: 'sensor.unrelated' }] });
  socket.receive({ id: 2, type: 'result', success: true }); socket.receive({ id: 3, type: 'result', success: true });
  assert.equal(feed.getStatus().connected, true); assert.equal(received.length, 1); assert.equal(JSON.stringify(received).includes('SECRET'), false); assert.equal(JSON.stringify(received).includes('latitude'), false);
  const change = (at, value) => socket.receive({ id: 2, type: 'event', event: { event_type: 'state_changed', time_fired: new Date(at).toISOString(), data: { entity_id: 'sensor.house', new_state: value } } });
  change(START - 31000, state('2')); assert.equal(received.length, 1);
  change(START, state('2')); assert.equal(received.length, 2); change(START, null); assert.equal(received.at(-1).state, 'unavailable');
});

test('browser applies only the exact power metric, preserves full dashboard timestamps and rejects old/malformed data', async () => {
  const source = await readFile(new URL('../public/power-updates.js', import.meta.url), 'utf8'), sandbox = {};
  vm.runInNewContext(source, sandbox); const api = sandbox.PowerUpdates;
  const data = { updatedAt: 'FULL-DATA-TIMESTAMP', domestic: { energy: { todayKWh: 7, power: { entityId: 'sensor.house', updatedAt: new Date(START).toISOString() }, powerW: 1000 } } };
  const payload = { entityId: 'sensor.house', available: true, value: 1.9, unit: 'kW', powerW: 1900, updatedAt: new Date(START + 1000).toISOString() };
  assert.equal(api.apply(data, payload), true); assert.equal(data.domestic.energy.powerW, 1900); assert.equal(data.domestic.energy.todayKWh, 7); assert.equal(data.updatedAt, 'FULL-DATA-TIMESTAMP');
  for (const bad of [{ ...payload, entityId: 'sensor.other' }, { ...payload, powerW: 1.9 }, { ...payload, unit: '%' }, { ...payload, updatedAt: new Date(START - 1000).toISOString() }]) assert.equal(api.apply(data, bad), false);
  assert.equal(api.apply(data, { entityId: 'sensor.house', available: false, value: null, unit: null, powerW: null, updatedAt: null }), true);
  assert.equal(data.domestic.energy.powerW, null); assert.equal(data.updatedAt, 'FULL-DATA-TIMESTAMP');
});

test('paired SSE replays the latest power value from one existing HA subscription with zero REST polling', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'power-api-'))), sockets = []; let reads = 0;
  class FakeSocket {
    constructor() { sockets.push(this); this.listeners = new Map(); this.sent = []; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    receive(value) { this.listeners.get('message')({ data: JSON.stringify(value) }); }
    close() {}
  }
  const bridge = await createBridge({ root, config: { domesticPanel: { energy: { powerEntityId: 'sensor.house' } } }, powerUpdatesEnabled: true,
    websocketClass: FakeSocket, env: { PORT: '4317', TV_CLIENT_TOKEN: 'power-test-pairing', HA_URL: 'http://ha.invalid', HA_TOKEN: 'test-only' },
    ha: { request() { reads++; throw Error('REST polling is forbidden in this test'); } } });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(sockets.length, 1); const socket = sockets[0]; socket.receive({ type: 'auth_required' }); socket.receive({ type: 'auth_ok' });
  socket.receive({ id: 1, type: 'result', success: true, result: [state()] }); socket.receive({ id: 2, type: 'result', success: true }); socket.receive({ id: 3, type: 'result', success: true });
  const pair = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: '/api/pair', method: 'POST',
      headers: { Host: '127.0.0.1:4317', Origin: 'http://127.0.0.1:4317', 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0])); });
    req.on('error', reject); req.end(JSON.stringify({ code: 'power-test-pairing' }));
  });
  const output = await new Promise((resolve, reject) => {
    let text = '';
    const req = http.get({ host: '127.0.0.1', port: bridge.server.address().port, path: '/api/events', headers: { Host: '127.0.0.1:4317', Cookie: pair } }, res => {
      res.on('data', chunk => { text += chunk; if (text.includes('"powerW":1900')) { req.destroy(); resolve(text); } });
    }); req.on('error', reject);
  });
  assert.match(output, /event: power_status/); assert.match(output, /event: power\n/); assert.equal(reads, 0);
  assert.equal(socket.sent.filter(command => command.type === 'get_states').length, 1);
});

test('browser stream errors and disconnected power status mark only power unknown and clean up listeners', async () => {
  const source = await readFile(new URL('../public/power-updates.js', import.meta.url), 'utf8'), sandbox = {}; vm.runInNewContext(source, sandbox);
  const callbacks = new Map(), changes = [], data = { updatedAt: 'OTHER-DATA', domestic: { energy: { power: { entityId: 'sensor.house', available: true }, powerW: 1800, todayKWh: 7 } } };
  const stream = { addEventListener(type, fn) { callbacks.set(type, fn); }, removeEventListener(type) { callbacks.delete(type); } };
  const cleanup = sandbox.PowerUpdates.connect(stream, { getData: () => data, onChange: value => changes.push(value) });
  callbacks.get('error')(); assert.equal(data.domestic.energy.powerW, null); assert.equal(data.domestic.energy.todayKWh, 7); assert.equal(data.updatedAt, 'OTHER-DATA');
  callbacks.get('error')(); assert.equal(changes.length, 1);
  callbacks.get('power')({ data: JSON.stringify({ entityId: 'sensor.house', available: true, value: 1.9, unit: 'kW', powerW: 1900, updatedAt: new Date(START).toISOString() }) });
  assert.equal(data.domestic.energy.powerW, 1900);
  callbacks.get('power_status')({ data: JSON.stringify({ configured: true, connected: false, state: 'reconnecting' }) }); assert.equal(data.domestic.energy.powerW, null);
  cleanup(); assert.equal(callbacks.size, 0);
});
