import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomesticPanel, readDomesticPanel } from '../lib/domestic-panel.mjs';
import { readDashboard } from '../lib/home-assistant.mjs';

const NOW = new Date('2026-10-23T18:00:00Z');
const state = (entity_id, value, unit, attributes = {}) => ({ entity_id, state: String(value), last_updated: '2026-10-23T17:59:00Z',
  attributes: { ...(unit ? { unit_of_measurement: unit } : {}), ...attributes } });
const config = {
  energy: { powerEntityId: 'sensor.house', todayEntityId: 'sensor.today', consumers: [{ id: 'boiler', name: 'Bojler', entityId: 'sensor.boiler' }, { id: 'fridge', name: 'Lednice', entityId: 'sensor.fridge' }] },
  water: { wellVolumeEntityId: 'sensor.volume', wellLevelEntityId: 'sensor.level', tankLevelEntityId: 'sensor.tank', valves: [{ entityId: 'valve.garden', name: 'Zahrada' }] },
  air: { rooms: [{ id: 'bedroom', name: 'Ložnice', co2EntityId: 'sensor.co2', temperatureEntityId: 'sensor.temperature', humidityEntityId: 'sensor.humidity' }], extractionEntityId: 'fan.bathroom' },
  rooms: [{ id: 'living', name: 'Obývák', entityId: 'climate.living', unit: '°C' }],
  hotWater: { topEntityId: 'sensor.top', bottomEntityId: 'sensor.bottom', powerEntityId: 'sensor.boiler' },
  washer: { jobEntityId: 'sensor.job', machineEntityId: 'sensor.machine', completionEntityId: 'sensor.completion', progressEntityId: 'sensor.progress', energyEntityId: 'sensor.energy', waterEntityId: 'sensor.water', powerEntityId: 'sensor.washer_power' },
  vacuum: { entityId: 'vacuum.robot', mapEntityId: 'camera.sample_037', batteryEntityId: 'sensor.battery', cleanedAreaEntityId: 'sensor.cleaned', cleaningTimeEntityId: 'sensor.clean_time',
    selections: [{ id: 'living', name: 'Obývák', entityId: 'input_boolean.sample_051' }] },
};
const read = states => readDomesticPanel(config, { states, now: NOW });

test('energy distinguishes W/kW from daily Wh/kWh without a guessed balance or price', () => {
  const result = read([state('sensor.house', '1.2', 'kW'), state('sensor.today', '3200', 'Wh'), state('sensor.boiler', '900', 'W'), state('sensor.fridge', '.15', 'kW')]);
  assert.equal(result.energy.power.value, 1.2); assert.equal(result.energy.power.unit, 'kW'); assert.equal(result.energy.powerW, 1200);
  assert.equal(result.energy.today.value, 3200); assert.equal(result.energy.todayKWh, 3.2);
  assert.deepEqual(result.energy.consumers.map(c => c.powerW), [900, 150]);
  assert.equal(result.energy.power.updatedAt, '2026-10-23T17:59:00.000Z');
  assert.equal('cost' in result.energy, false); assert.equal('residual' in result.energy, false);
  const wrongUnits = read([state('sensor.house', '2', 'kWh'), state('sensor.today', '5', 'kW')]);
  assert.equal(wrongUnits.energy.powerW, null); assert.equal(wrongUnits.energy.todayKWh, null);
});

test('unknown, restored, malformed and physically invalid percentage values remain missing, never zero', () => {
  for (const value of ['unknown', 'unavailable', '', ' ', 'NaN', 'Infinity', '1,2']) assert.equal(read([state('sensor.house', value, 'W')]).energy.power.value, null);
  assert.equal(read([state('sensor.house', '0', 'W')]).energy.power.value, 0);
  assert.equal(read([state('sensor.house', '12', 'W', { restored: true })]).energy.power.available, false);
  const result = read([state('sensor.volume', '0', 'l'), state('sensor.level', '60', '%'), state('sensor.tank', '101', '%'), state('valve.garden', 'unavailable', null, { current_position: 100 })]);
  assert.equal(result.water.wellVolume.value, 0); assert.equal(result.water.wellLevel.value, 60); assert.equal(result.water.tankLevel.value, null);
  assert.deepEqual(result.water.valves[0], { entityId: 'valve.garden', name: 'Zahrada', available: false, state: 'unknown', positionPercent: null });
  assert.equal('empty' in result.water, false);
});

test('air, explicit valves and hot-water measurements preserve their source units without thresholds', () => {
  const result = read([state('sensor.co2', 1100, 'ppm'), state('sensor.temperature', 21.5, '°C'), state('sensor.humidity', 55, '%'),
    state('fan.bathroom', 'on', null, { percentage: 60 }), state('valve.garden', 'opening', null, { current_position: 20 }), state('sensor.top', 55, '°C'), state('sensor.bottom', 38, '°C')]);
  assert.equal(result.air.rooms[0].co2.value, 1100); assert.equal(result.air.rooms[0].co2.unit, 'ppm');
  assert.equal(result.air.extraction.percentage, 60); assert.equal(result.water.valves[0].state, 'opening');
  assert.equal(result.hotWater.top.value, 55); assert.equal(result.hotWater.bottom.value, 38);
  assert.equal('safe' in result.air.rooms[0], false); assert.equal('ready' in result.hotWater, false);
});

test('rooms expose actual current/target/range and unknown hvac_action without inventing a setpoint', () => {
  const result = read([state('climate.living', 'heat_cool', null, { current_temperature: 23.9, temperature: null, target_temp_low: 22.5, target_temp_high: 25, hvac_action: 'idle', access_token: 'private' })]);
  assert.equal(result.rooms[0].currentTemperature, 23.9); assert.equal(result.rooms[0].targetTemperature, null);
  assert.equal(result.rooms[0].targetLow, 22.5); assert.equal(result.rooms[0].targetHigh, 25); assert.equal(result.rooms[0].unit, '°C');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(read([state('climate.living', 'off')]).rooms[0].action, null);
  assert.equal(read([state('climate.living', 'unavailable', null, { current_temperature: 25 })]).rooms[0].currentTemperature, null);
});

test('regulator heating request is never presented as confirmed physical heating', () => {
  const result = read([state('climate.living', 'auto', null, { hvac_action: 'heating', demand: 1,
    active_state: { mode: 1, value: 0 }, current_temperature: 22.5, target_temp_low: 22.5, target_temp_high: 25 })]).rooms[0];
  assert.equal(result.reportedAction, 'heating'); assert.equal(result.action, null); assert.equal(result.heatingActive, null);
  assert.equal(result.heatingLabel, 'Režim vytápění');
  assert.deepEqual(result.heatingEvidence, { kind: 'unverified', entityId: null, available: false, powerW: null, updatedAt: null });
  for (const mode of ['heat', 'auto', 'heat_cool']) {
    const room = read([state('climate.living', mode, null, { temperature: 30, current_temperature: 10 })]).rooms[0];
    assert.equal(room.heatingActive, null); assert.equal(room.action, null); assert.equal(room.heatingLabel, 'Neověřeno');
  }
});

test('only an explicit actual heater power meter establishes physical heating, with missing kept unknown', () => {
  const panel = { rooms: [{ id: 'bedroom', name: 'Ložnice', entityId: 'climate.bedroom', heatingPowerEntityId: 'sensor.heater_power' }] };
  const room = reading => readDomesticPanel(panel, { states: [state('climate.bedroom', 'auto', null, { hvac_action: 'heating' }), reading], now: NOW }).rooms[0];
  assert.equal(room(state('sensor.heater_power', 0, 'W')).heatingActive, false);
  assert.equal(room(state('sensor.heater_power', 0, 'W')).heatingLabel, 'Netopí');
  const active = room(state('sensor.heater_power', .4, 'kW'));
  assert.equal(active.action, 'heating'); assert.equal(active.heatingActive, true); assert.equal(active.heatingLabel, 'Topí');
  assert.deepEqual(active.heatingEvidence, { kind: 'measured_power', entityId: 'sensor.heater_power', available: true, powerW: 400, updatedAt: '2026-10-23T17:59:00.000Z' });
  for (const invalid of [state('sensor.heater_power', 'unavailable', 'W'), state('sensor.heater_power', 'unknown', 'W'),
    state('sensor.heater_power', 3, 'kWh'), state('sensor.heater_power', -4, 'W'), state('sensor.heater_power', 0, 'W', { restored: true })]) {
    const value = room(invalid); assert.equal(value.heatingActive, null); assert.equal(value.action, null); assert.equal(value.heatingEvidence.available, false);
  }
  assert.equal(normalizeDomesticPanel({ rooms: [{ id: 'bedroom', entityId: 'climate.bedroom', heatingPowerEntityId: 'switch.heater' }] }).rooms[0].heatingPowerEntityId, null);
});

test('washer uses real percent and only an active future timestamp for remaining time; totals are unchanged', () => {
  const states = [state('sensor.job', 'wash'), state('sensor.machine', 'run'), state('sensor.completion', '2026-10-23T18:30:00Z'), state('sensor.progress', 35, '%'),
    state('sensor.energy', 201, 'kWh'), state('sensor.water', 15916.9, 'L')];
  const result = read(states).washer;
  assert.equal(result.running, true); assert.equal(result.progressPercent, 35); assert.equal(result.remainingSeconds, 1800);
  assert.equal(result.energy.value, 201); assert.equal(result.water.value, 15916.9);
  const idle = read(states.map(s => s.entity_id === 'sensor.machine' ? { ...s, state: 'stop' } : s)).washer;
  assert.equal(idle.remainingSeconds, null); assert.equal(idle.estimatedCompletion, null); assert.equal(idle.completionAvailable, false);
  const duration = read(states.map(s => s.entity_id === 'sensor.completion' ? { ...s, state: '163', attributes: { unit_of_measurement: 'min' } } : s)).washer;
  assert.equal(duration.estimatedCompletion, null);
  assert.equal(read(states.filter(s => s.entity_id !== 'sensor.progress')).washer.progressPercent, null);
  assert.equal(read(states.map(s => s.entity_id === 'sensor.progress' ? { ...s, state: '101' } : s)).washer.progressPercent, null);
});

test('vacuum availability is independent of its last map; room selections are read-only and map metadata is bounded', () => {
  const states = [state('vacuum.robot', 'unavailable', null, { battery_level: 80 }), state('sensor.battery', 80, '%'),
    state('camera.sample_037', 'idle', null, { last_map_update: '2026-10-23T17:50:00+00:00', last_refresh_ok: true, map_width: 1083, map_height: 558,
      access_token: 'secret', calibration_points: 'private-layout', rooms: 'private-rooms', entity_picture: 'http://ha/?token=secret' }), state('input_boolean.sample_051', 'on')];
  const result = read(states).vacuum;
  assert.equal(result.available, false); assert.equal(result.batteryPercent, null); assert.equal(result.map.available, true); assert.equal(result.map.url, '/api/vacuum/map');
  assert.equal(result.map.lastUpdated, '2026-10-23T17:50:00.000Z'); assert.equal(result.map.width, 1083); assert.equal(result.controlsAvailable, false);
  assert.deepEqual(result.selections, [{ id: 'living', name: 'Obývák', available: true, selected: true }]);
  assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('private-'));
  assert.equal(read([state('vacuum.robot', 'docked', null, { battery_level: 80 })]).vacuum.batteryPercent, 80);
  assert.equal(read([state('input_boolean.sample_051', 'unknown')]).vacuum.selections[0].selected, null);
});

test('configuration accepts only explicit domains and an explicitly configured camera map source', () => {
  const normalized = normalizeDomesticPanel({ energy: { powerEntityId: 'http://private'}, rooms: [{ id: 'bad', entityId: 'lock.front' }],
    vacuum: { mapEntityId: 'https://invalid.test/map.png', selections: [{ id: 'bad', entityId: 'switch.invalid' }] } });
  assert.equal(normalized.energy.powerEntityId, null); assert.deepEqual(normalized.rooms, []);
  assert.equal(normalized.vacuum.mapEntityId, null); assert.deepEqual(normalized.vacuum.selections, []);
  assert.equal(readDomesticPanel({}, { states: [], now: NOW }).configured, false);
  assert.equal(readDomesticPanel({ water: { wellLevelEntityId: 'sensor.level' } }, { states: [], now: NOW }).configured, true);
});

test('well and tank depths retain the actual device distance independently from percentage and volume', () => {
  const panel = { water: { wellDepthEntityId: 'sensor.well_depth', tankDepthEntityId: 'sensor.tank_depth', wellLevelEntityId: 'sensor.level' } };
  const result = readDomesticPanel(panel, { states: [state('sensor.well_depth', 1.79, 'm'), state('sensor.tank_depth', .93, 'm'), state('sensor.level', 59, '%')], now: NOW });
  assert.equal(result.configured, true);
  assert.deepEqual(result.water.wellDepth, { entityId: 'sensor.well_depth', value: 1.79, unit: 'm', available: true, updatedAt: '2026-10-23T17:59:00.000Z' });
  assert.equal(result.water.tankDepth.value, .93);
  assert.equal(result.water.wellLevel.value, 59);
  assert.equal(result.water.wellVolume.value, null);
  for (const invalid of [state('sensor.well_depth', -1, 'm'), state('sensor.well_depth', 59, '%'), state('sensor.well_depth', 'unknown', 'm'), state('sensor.well_depth', 1.79, 'm', { restored: true })]) {
    const invalidResult = readDomesticPanel(panel, { states: [invalid], now: NOW });
    assert.equal(invalidResult.water.wellDepth.available, false);
    assert.equal(invalidResult.water.wellDepth.value, null);
  }
  assert.equal(readDomesticPanel({ water: { tankDepthEntityId: 'sensor.tank_depth' } }, { states: [], now: NOW }).configured, true);
  assert.equal(normalizeDomesticPanel({ water: { wellDepthEntityId: 'lock.front' } }).water.wellDepthEntityId, null);
});

test('dashboard integrates domestic data from exactly one existing HA states read', async () => {
  let calls = 0;
  const result = await readDashboard({ states: async () => { calls++; return [state('sensor.house', 1.2, 'kW')]; } },
    { entities: { weather: {} }, safeScenes: [], calendarDays: 7, domesticPanel: config }, NOW);
  assert.equal(calls, 1); assert.equal(result.domestic.energy.powerW, 1200);
});

test('dishwasher countdown is an estimate from the HA timer start and never invents a running state', () => {
  const now = new Date('2026-10-27T17:20:00Z');
  const at = '2026-10-27T17:08:00+00:00';
  const st = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes, last_changed: at, last_updated: at });
  const config = { dishwasher: { timerEntityId: 'timer.dish', powerEntityId: 'sensor.plug', estimateMinutes: 30 } };
  const running = readDomesticPanel(config, { now, states: [st('timer.dish', 'active'), st('sensor.plug', '1850', { unit_of_measurement: 'W' })] }).dishwasher;
  assert.equal(running.running, true); assert.equal(running.startedAt, '2026-10-27T17:08:00.000Z');
  assert.equal(running.estimatedEnd, '2026-10-27T17:38:00.000Z'); assert.equal(running.remainingSeconds, 18 * 60); assert.equal(running.power.value, 1850);
  const late = readDomesticPanel(config, { now: new Date('2026-10-27T18:00:00Z'), states: [st('timer.dish', 'active')] }).dishwasher;
  assert.equal(late.running, true); assert.equal(late.remainingSeconds, 0);
  const idle = readDomesticPanel(config, { now, states: [st('timer.dish', 'idle')] }).dishwasher;
  assert.equal(idle.available, true); assert.equal(idle.running, false); assert.equal(idle.remainingSeconds, null);
  const missing = readDomesticPanel(config, { now, states: [] }).dishwasher;
  assert.equal(missing.available, false); assert.equal(missing.running, false);
  assert.equal(readDomesticPanel({}, { now, states: [] }).dishwasher.entityId, null);
});
