import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobilePairing } from '../lib/mobile-pairing.mjs';
import { createHomeControls } from '../lib/home-controls.mjs';

const A = 'a'.repeat(32), B = 'b'.repeat(32);
test('short mobile codes are single-use, expire at 60 s and a new owner code replaces its previous code', () => {
  let time = 1000000; const paired = new Set([A, B]);
  const enrollment = createMobilePairing({ isPaired: session => paired.has(session), now: () => time });
  assert.throws(() => enrollment.issue('not-paired'), error => error.status === 401);
  const initial = enrollment.issue(A); assert.match(initial.code, /^\d{8}$/); assert.equal(Date.parse(initial.expiresAt), time + 60000); assert.equal(initial.url, '/manage.html');
  const replacement = enrollment.issue(A); assert.notEqual(initial.code, replacement.code);
  assert.equal(enrollment.consume(initial.code), false); assert.equal(enrollment.consume(replacement.code), true); assert.equal(enrollment.consume(replacement.code), false);
  const expired = enrollment.issue(B); time += 60000; assert.equal(enrollment.consume(expired.code), false);
  const revoked = enrollment.issue(A); paired.delete(A); assert.equal(enrollment.consume(revoked.code), false);
});

test('enrollment is bounded per owner and revoked owner cannot leave a reusable code', () => {
  const enrollment = createMobilePairing({ isPaired: () => true, maximum: 1 });
  enrollment.issue(A); assert.throws(() => enrollment.issue(B), error => error.status === 503);
  const current = enrollment.issue(A); enrollment.revoke(A); assert.equal(enrollment.consume(current.code), false);
  assert.match(enrollment.issue(B).code, /^\d{8}$/);
});

const CONFIG = { entities: { lights: [
  { entityId: 'light.living', name: 'Obývák', role: 'light-state' },
  { entityId: 'switch.lamp', name: 'Lampa', role: 'light-state' },
  { entityId: 'light.controller', name: 'Stav regulátoru', role: 'controller-status' },
  { entityId: 'lock.front', name: 'Zámek', role: 'light-state' },
] }, domesticPanel: { rooms: [{ id: 'bedroom', name: 'Ložnice', entityId: 'climate.bedroom' }] } };
const climate = attributes => ({ entity_id: 'climate.bedroom', state: 'auto', attributes: { temperature: 20, min_temp: 5, max_temp: 30, target_temp_step: .5, supported_features: 1, ...attributes } });
function fixture(initial = climate()) {
  let state = initial; const calls = [];
  const service = createHomeControls({ config: CONFIG, ha: { request: async (route, options = {}) => {
    calls.push({ route, ...options }); if (!options.method) return state; return [];
  } } });
  return { service, calls, state(value) { state = value; } };
}

test('capabilities name only explicitly configured lights and room targets', () => {
  const { service } = fixture(); const result = service.capabilities();
  assert.deepEqual(result.lights, [{ id: 'light.living', name: 'Obývák' }, { id: 'switch.lamp', name: 'Lampa' }]);
  assert.deepEqual(result.temperatures, [{ id: 'bedroom', name: 'Ložnice', deltas: [-.5, .5] }]);
  assert.equal(JSON.stringify(result).includes('lock.front'), false); assert.equal(JSON.stringify(result).includes('controller'), false);
});

test('light buttons read the current exact source then call only that light/switch on/off service', async () => {
  const f = fixture({ entity_id: 'light.living', state: 'off', attributes: {} });
  const result = await f.service.execute({ type: 'light', id: 'light.living', on: true });
  assert.deepEqual(f.calls, [{ route: 'api/states/light.living' }, { route: 'api/services/light/turn_on', method: 'POST', body: { entity_id: 'light.living' } }]);
  assert.deepEqual(result, { accepted: true, type: 'light', id: 'light.living', requested: { on: true }, verified: false, refreshRequired: true });
  f.state({ entity_id: 'switch.lamp', state: 'on', attributes: {} }); await f.service.execute({ type: 'light', id: 'switch.lamp', on: false });
  assert.deepEqual(f.calls.at(-1), { route: 'api/services/switch/turn_off', method: 'POST', body: { entity_id: 'switch.lamp' } });
});

test('temperature buttons use fresh scalar HA target, bounds and supported half-degree step without changing mode', async () => {
  const f = fixture(); const first = await f.service.execute({ type: 'temperature', id: 'bedroom', delta: .5 });
  assert.equal(first.requested.temperature, 20.5); assert.equal(first.verified, false);
  f.state(climate({ temperature: 22 })); await f.service.execute({ type: 'temperature', id: 'bedroom', delta: -.5 });
  assert.deepEqual(f.calls.at(-1), { route: 'api/services/climate/set_temperature', method: 'POST', body: { entity_id: 'climate.bedroom', temperature: 21.5 } });
  assert.equal(JSON.stringify(f.calls).includes('hvac_mode'), false);
});

test('malformed, arbitrary, controller, lock, alarm, mode and unconfigured actions fail before any HA read', async () => {
  const f = fixture();
  for (const body of [null, [], {}, { type: 'light', id: 'lock.front', on: true }, { type: 'light', id: 'light.controller', on: true },
    { type: 'light', id: 'light.other', on: true }, { type: 'light', id: 'light.living', on: 1 }, { type: 'light', id: 'light.living', on: true, service: 'unlock' },
    { type: 'temperature', id: 'climate.bedroom', delta: .5 }, { type: 'temperature', id: 'bedroom', delta: 10 },
    { type: 'temperature', id: 'bedroom', delta: .5, hvac_mode: 'heat' }, { type: 'alarm', id: 'alarm_control_panel.home', on: true }]) {
    await assert.rejects(() => f.service.execute(body), error => error.status === 400);
  }
  assert.deepEqual(f.calls, []);
});

test('unavailable/restored/mismatched lights and unknown target/bounds/features never issue a command', async () => {
  const f = fixture();
  for (const value of [{ entity_id: 'light.living', state: 'unknown' }, { entity_id: 'light.living', state: 'on', attributes: { restored: true } },
    { entity_id: 'light.other', state: 'on' }, { entity_id: 'light.living', state: 'idle' }]) {
    f.state(value); await assert.rejects(() => f.service.execute({ type: 'light', id: 'light.living', on: false }), error => error.status === 409);
  }
  for (const attributes of [{ temperature: null, target_temp_low: 20, target_temp_high: 25 }, { min_temp: undefined }, { max_temp: undefined },
    { temperature: 30 }, { temperature: 4 }, { target_temp_step: 1 }, { target_temp_step: null }, { target_temp_step: undefined }, { target_temp_step: NaN },
    { target_temp_step: '0.5' }, { supported_features: 0 }, { temperature: 20, min_temp: 30, max_temp: 5 }]) {
    f.state(climate(attributes)); await assert.rejects(() => f.service.execute({ type: 'temperature', id: 'bedroom', delta: .5 }), error => error.status === 409);
  }
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('concurrent commands for a room cannot read the same old target and silently lose a delta', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; }); let writes = 0;
  const service = createHomeControls({ config: CONFIG, ha: { request: async (route, options) => {
    if (!options) { await waiting; return climate(); } writes++; return [];
  } } });
  const first = service.execute({ type: 'temperature', id: 'bedroom', delta: .5 });
  await assert.rejects(() => service.execute({ type: 'temperature', id: 'bedroom', delta: .5 }), error => error.status === 409);
  release(); await first; assert.equal(writes, 1);
});
