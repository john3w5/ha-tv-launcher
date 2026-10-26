import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeHouseEvents, createHouseEventProcessor, subscribeHouseEvents } from '../lib/house-events.mjs';

const initialNow = Date.parse('2026-10-23T18:00:00Z');
const config = { enabled: true, doorbells: [
  { id: 'door', source: 'automation', entityId: 'automation.door_bell', requiredSource: 'webhook', cameraId: 'entrance', cooldownSeconds: 8 },
  { id: 'gate', source: 'event_entity', entityId: 'event.gate_bell', eventTypes: ['btn_down'], cameraId: 'cars', cooldownSeconds: 8 },
], alerts: [
  { id: 'leak', type: 'binary_on', entityId: 'binary_sensor.leak', tone: 'warning' },
  { id: 'washer', type: 'washer_finished', entityId: 'sensor.washer_job', activeStates: ['wash', 'rinse', 'spin'], finishedState: 'finish' },
  { id: 'window', type: 'window_hvac', windowEntityId: 'binary_sensor.long_open_window', climateEntityId: 'climate.living', activeModes: ['cool', 'heat'] },
  { id: 'battery', type: 'battery_low', entityId: 'sensor.lock_battery', threshold: 20 },
] };
const state = (entity_id, value, attributes = {}) => ({ entity_id, state: value, attributes });
function fixture() {
  let time = initialNow;
  const doorbells = [], notifications = [];
  const processor = createHouseEventProcessor(config, { now: () => time, onDoorbell: value => doorbells.push(value), onNotification: value => notifications.push(value) });
  const changed = (entityId, previous, next, attributes = {}, options = {}) => processor.handle({ event_type: 'state_changed',
    time_fired: new Date(time).toISOString(), data: { entity_id: entityId, old_state: previous === null ? null : state(entityId, previous, options.oldAttributes), new_state: next === null ? null : state(entityId, next, attributes) } });
  const automation = (source = 'webhook', entityId = 'automation.door_bell', userId = null) => processor.handle({ event_type: 'automation_triggered', time_fired: new Date(time).toISOString(), data: { entity_id: entityId, source }, context: { user_id: userId } });
  return { processor, changed, automation, doorbells, notifications, advance: ms => { time += ms; }, iso: offset => new Date(time + offset).toISOString() };
}

test('initial snapshots, restored states and unknown recovery cannot become home alerts', () => {
  const f = fixture();
  f.processor.seed([state('binary_sensor.leak', 'on'), state('sensor.washer_job', 'finish'), state('sensor.lock_battery', '10'), state('binary_sensor.long_open_window', 'on'), state('climate.living', 'cool')]);
  assert.equal(f.notifications.length, 0);
  for (const previous of [null, 'unknown', 'unavailable']) {
    f.changed('binary_sensor.leak', previous, 'on'); f.changed('sensor.lock_battery', previous, '10');
    f.changed('sensor.washer_job', previous, 'finish');
  }
  f.changed('binary_sensor.leak', 'off', 'on', { restored: true });
  f.changed('binary_sensor.leak', 'off', 'on', {}, { oldAttributes: { restored: true } });
  assert.equal(f.notifications.length, 0);
});

test('leak fires only on off-to-on and battery only on a valid numeric threshold crossing', () => {
  const f = fixture();
  f.changed('binary_sensor.leak', 'off', 'on'); f.changed('binary_sensor.leak', 'on', 'on');
  f.changed('sensor.lock_battery', '82', '20'); f.changed('sensor.lock_battery', '20', '19');
  for (const [previous, next] of [['unknown', '2'], ['', '2'], ['101', '2'], ['30', '-1'], ['30', 'unavailable']]) f.changed('sensor.lock_battery', previous, next);
  assert.deepEqual(f.notifications.map(n => n.id), ['house-leak', 'house-battery']);
  assert.equal(f.notifications[0].type, 'warning');
  assert.ok(Date.parse(f.notifications[0].expiresAt) > initialNow);
});

test('washer requires an observed active program before explicit finish and discards interrupted state knowledge', () => {
  const f = fixture();
  f.processor.seed([state('sensor.washer_job', 'none')]);
  f.changed('sensor.washer_job', 'none', 'finish'); assert.equal(f.notifications.length, 0);
  f.changed('sensor.washer_job', 'none', 'wash'); f.changed('sensor.washer_job', 'wash', 'rinse');
  f.changed('sensor.washer_job', 'rinse', 'finish'); f.changed('sensor.washer_job', 'finish', 'finish');
  assert.deepEqual(f.notifications.map(n => n.id), ['house-washer']);
  f.advance(61000); f.changed('sensor.washer_job', 'finish', 'wash'); f.changed('sensor.washer_job', 'wash', 'unavailable');
  f.changed('sensor.washer_job', 'unavailable', 'finish'); assert.equal(f.notifications.length, 1);
  f.processor.seed([state('sensor.washer_job', 'wash')]);
  f.changed('sensor.washer_job', 'wash', 'finish'); assert.equal(f.notifications.length, 2);
});

test('long-open window alert evaluates both actual window and HVAC and avoids active-mode churn', () => {
  const f = fixture();
  f.processor.seed([state('binary_sensor.long_open_window', 'off'), state('climate.living', 'off')]);
  f.changed('binary_sensor.long_open_window', 'off', 'on'); assert.equal(f.notifications.length, 0);
  f.changed('climate.living', 'off', 'cool'); f.changed('climate.living', 'cool', 'heat');
  assert.equal(f.notifications.length, 1);
  f.advance(61000); f.changed('climate.living', 'heat', 'off'); f.changed('climate.living', 'off', 'unknown');
  f.changed('climate.living', 'unknown', 'cool'); assert.equal(f.notifications.length, 1);
  f.changed('binary_sensor.long_open_window', 'on', 'off'); f.changed('binary_sensor.long_open_window', 'off', 'on');
  assert.equal(f.notifications.length, 2);
});

test('gate button accepts only a fresh btn_down timestamp transition and door uses the exact genuine webhook source', () => {
  const f = fixture();
  const old = f.iso(-60000), next = f.iso(0);
  f.changed('event.gate_bell', 'unknown', next, { event_type: 'btn_down' });
  f.changed('event.gate_bell', old, next, { event_type: 'btn_up' });
  f.changed('event.gate_bell', old, f.iso(-40000), { event_type: 'btn_down' });
  f.changed('event.gate_bell', old, next, { event_type: 'btn_down', restored: true });
  assert.equal(f.doorbells.length, 0);
  f.changed('event.gate_bell', old, next, { event_type: 'btn_down' });
  f.changed('event.gate_bell', old, next, { event_type: 'single_push' });
  f.automation(null); f.automation('manual'); f.automation('webhook', 'automation.other'); f.automation('webhook', 'automation.door_bell', 'manual-user');
  assert.equal(f.doorbells.length, 1);
  f.automation(); assert.deepEqual(f.doorbells.map(n => n.cameraId), ['cars', 'entrance']);
  f.automation(); assert.equal(f.doorbells.length, 2);
  f.advance(9000); f.automation(); assert.equal(f.doorbells.length, 3);
  assert.ok(f.doorbells.every(n => Object.keys(n).sort().join(',') === 'cameraId,durationSeconds,id,message,title'));
});

test('house event normalization constrains camera membership, entity domains and supported read-only rule types', () => {
  const result = normalizeHouseEvents({ ...config, doorbells: [...config.doorbells, { id: 'bad', source: 'event_entity', entityId: 'binary_sensor.front_door', eventTypes: ['on'], cameraId: 'entrance' }], alerts: [...config.alerts, { id: 'bad-action', type: 'call_service', entityId: 'lock.front', service: 'unlock' }] }, { cameraIds: ['cars'] });
  assert.deepEqual(result.doorbells.map(rule => rule.id), ['gate']);
  assert.equal(result.alerts.length, 4);
  assert.ok(!JSON.stringify(result).includes('unlock'));
  assert.deepEqual(normalizeHouseEvents({ ...config, enabled: false }), { enabled: false, doorbells: [], alerts: [] });
});

test('current home reminders reflect active real states without toasts, doorbell history or raw attributes', () => {
  const f = fixture();
  f.processor.seed([state('binary_sensor.leak', 'on', { access_token: 'never-return' }), state('sensor.lock_battery', '10'),
    state('binary_sensor.long_open_window', 'on'), state('climate.living', 'cool'), state('sensor.washer_job', 'finish')]);
  assert.equal(f.notifications.length, 0);
  assert.deepEqual(f.processor.getCurrent().map(n => n.id), ['house-leak', 'house-window', 'house-battery']);
  assert.ok(!JSON.stringify(f.processor.getCurrent()).includes('never-return'));
  const current = f.processor.getCurrent(); current[0].title = 'edited';
  assert.notEqual(f.processor.getCurrent()[0].title, 'edited');
  f.automation(); assert.equal(f.processor.getCurrent().length, 3);
  f.changed('binary_sensor.leak', 'on', 'off'); f.changed('sensor.lock_battery', '10', '90'); f.changed('climate.living', 'cool', 'off');
  assert.deepEqual(f.processor.getCurrent(), []);
  f.changed('sensor.lock_battery', '90', 'unavailable'); assert.deepEqual(f.processor.getCurrent(), []);
});

test('washer reminder exists only after a witnessed finish and is cleared by the next state or resynchronization', () => {
  const f = fixture(); f.processor.seed([state('sensor.washer_job', 'wash')]);
  f.changed('sensor.washer_job', 'wash', 'finish');
  assert.deepEqual(f.processor.getCurrent().map(n => n.id), ['house-washer']);
  f.changed('sensor.washer_job', 'finish', 'none'); assert.deepEqual(f.processor.getCurrent(), []);
  f.processor.seed([state('sensor.washer_job', 'finish')]); assert.deepEqual(f.processor.getCurrent(), []);
});

test('the real washer none enum can start a short observed job without being confused with unknown', () => {
  const f = fixture(); f.processor.seed([state('sensor.washer_job', 'none')]);
  f.changed('sensor.washer_job', 'none', 'wash'); f.changed('sensor.washer_job', 'wash', 'finish');
  assert.deepEqual(f.notifications.map(n => n.id), ['house-washer']);
  assert.deepEqual(f.processor.getCurrent().map(n => n.id), ['house-washer']);
});

function transport(t, options = {}) {
  const sockets = [], notices = [], statuses = [];
  class FakeWebSocket {
    constructor() { this.listeners = new Map(); this.sent = []; this.closed = false; sockets.push(this); }
    addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); }
    send(value) { this.sent.push(JSON.parse(value)); }
    emit(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback(event); }
    receive(value) { this.emit('message', { data: JSON.stringify(value) }); }
    close() { if (this.closed) return; this.closed = true; this.emit('close'); }
  }
  const feed = subscribeHouseEvents({ url: 'http://ha.test', token: 'house-test-token', config, websocketClass: FakeWebSocket,
    now: () => initialNow, reconnectMs: 5, maxReconnectMs: 5, timeoutMs: 1000, heartbeatMs: 1000,
    onNotification: value => notices.push(value), onStatus: value => statuses.push(value), ...options });
  t.after(() => feed.stop());
  const authenticate = socket => { socket.receive({ type: 'auth_required' }); socket.receive({ type: 'auth_ok' }); };
  const ready = socket => {
    authenticate(socket);
    socket.receive({ id: 1, type: 'result', success: true, result: [state('binary_sensor.leak', 'on', { access_token: 'never-expose' })] });
    socket.receive({ id: 2, type: 'result', success: true }); socket.receive({ id: 3, type: 'result', success: true });
  };
  const change = socket => socket.receive({ id: 2, type: 'event', event: { event_type: 'state_changed', time_fired: new Date(initialNow).toISOString(), data: { entity_id: 'binary_sensor.leak', old_state: state('binary_sensor.leak', 'off'), new_state: state('binary_sensor.leak', 'on') } } });
  return { feed, sockets, notices, statuses, authenticate, ready, change };
}
async function until(predicate) { const end = Date.now() + 1000; while (!predicate()) { if (Date.now() > end) assert.fail('Fake WS timeout'); await delay(2); } }

test('HA transport waits for initial state plus both subscription ACKs, ignores snapshot and stops cleanly', t => {
  const f = transport(t), socket = f.sockets[0];
  f.authenticate(socket);
  assert.deepEqual(socket.sent.slice(1).map(command => [command.id, command.type, command.event_type]), [
    [1, 'get_states', undefined], [2, 'subscribe_events', 'state_changed'], [3, 'subscribe_events', 'automation_triggered'],
  ]);
  socket.receive({ id: 1, type: 'result', success: true, result: [state('binary_sensor.leak', 'on')] });
  socket.receive({ id: 2, type: 'result', success: true }); f.change(socket);
  assert.equal(f.notices.length, 0); assert.equal(f.feed.getStatus().connected, false);
  assert.deepEqual(f.feed.getCurrent(), []);
  socket.receive({ id: 3, type: 'result', success: true });
  assert.equal(f.feed.getStatus().connected, true); assert.equal(f.notices.length, 0);
  assert.deepEqual(f.feed.getCurrent().map(n => n.id), ['house-leak']);
  f.change(socket); assert.equal(f.notices.length, 1);
  assert.ok(!JSON.stringify(f.notices).includes('house-test-token'));
  f.feed.stop(); assert.equal(socket.closed, true); assert.equal(f.feed.getStatus().state, 'stopped'); assert.deepEqual(f.feed.getCurrent(), []);
});

test('transport reconnects without replay and authentication rejection never retries or leaks errors', async t => {
  const f = transport(t); f.ready(f.sockets[0]); f.sockets[0].emit('error');
  await until(() => f.sockets.length === 2); f.ready(f.sockets[1]);
  assert.equal(f.notices.length, 0); assert.equal(f.feed.getStatus().connected, true);
  f.feed.stop(); await delay(15); assert.equal(f.sockets.length, 2);
  const rejected = transport(t); rejected.sockets[0].receive({ type: 'auth_invalid', message: 'private secret' });
  assert.equal(rejected.feed.getStatus().state, 'authentication_failed'); await delay(15);
  assert.equal(rejected.sockets.length, 1); assert.ok(!JSON.stringify(rejected.statuses).includes('private secret'));
});
