import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomesticPanel, readDomesticPanel } from '../lib/domestic-panel.mjs';
import { createHomeControls } from '../lib/home-controls.mjs';

const now = new Date('2026-10-25T14:40:00Z');
const reading = (entity_id, value, unit, attributes = {}) => ({ entity_id, state: String(value),
  last_updated: '2026-10-25T14:39:00Z', last_changed: '2026-10-25T14:38:00Z',
  attributes: { ...(unit ? { unit_of_measurement: unit } : {}), ...attributes } });
// Synthetic, self-contained fixtures; no installation's entity inventory.
const panel = { rooms: Array.from({ length: 9 }, (_, i) => ({
  id: `room_${i}`, name: `Room ${i + 1}`, areaId: `area_${i}`,
  ...(i < 4 ? { entityId: `climate.test_room_${i}` } : {}),
  temperatureEntityId: `sensor.test_room_${i}_temperature`,
  humidityEntityId: `sensor.test_room_${i}_humidity`,
  ...(i === 4 ? { co2EntityId: 'sensor.test_room_4_co2' } : {}),
  ...(i === 5 ? { pm25EntityId: 'sensor.test_room_5_pm25' } : {}),
  equipment: i === 1 ? [{ id: 'aux_ac', kind: 'climate', entityId: 'climate.test_aux_ac', unit: '\u00b0C' }] : [],
})) };
const project = { entities: { lights: [] }, domesticPanel: panel };
const read = (rooms, states, extra = {}) => readDomesticPanel({ rooms, ...extra }, { states, now });

test('explicit mixed rooms retain their sensor identities without promoting AC equipment to a room', () => {
  const result = readDomesticPanel(panel, { states: [], now });
  assert.equal(result.roomsContractVersion, 2);
  assert.equal(result.rooms.length, 9);
  assert.equal(result.air.rooms.length, 9);
  assert.deepEqual(result.air.rooms.map(r => r.id), panel.rooms.map(r => r.id));
  assert(result.rooms.every(r => r.available === false));
  assert.equal(result.rooms[4].co2.entityId, 'sensor.test_room_4_co2');
  assert.equal(result.rooms[5].pm25.entityId, 'sensor.test_room_5_pm25');
  assert.equal(panel.rooms.filter(r => r.entityId === 'climate.test_aux_ac').length, 0);
  const measured = readDomesticPanel(panel, { states: [reading('sensor.test_room_8_temperature', 13.25, '\u00b0C')], now }).rooms[8];
  assert.equal(measured.temperature.value, 13.25);
  assert.equal(measured.temperature.entityId, 'sensor.test_room_8_temperature');
  assert.equal(measured.available, true);
  assert.equal(measured.climate.available, false);
  assert.equal(measured.heatingActive, null);
});

test('sensor-only areas retain identity, independent measurement availability, and precision', () => {
  const result = read([{ id: 'hallway', areaId: 'predsin', temperatureEntityId: 'sensor.room_t', humidityEntityId: 'sensor.room_h' }],
    [reading('sensor.room_t', 22.35, '°C'), reading('sensor.room_h', 52.55, '%')]).rooms[0];
  assert.equal(result.available, true);
  assert.equal(result.climate.available, false);
  assert.equal(result.entityId, null);
  assert.equal(result.temperature.value, 22.35);
  assert.equal(result.humidity.value, 52.55);
  assert.equal(result.heatingActive, null);
  assert.equal(result.targetTemperature, null);
  assert.equal(result.temperature.updatedAt, '2026-10-25T14:39:00.000Z');
  for (const power of [0, 500]) {
    const heaterOnly = read([{ id: 'heater', heatingPowerEntityId: 'sensor.heater' }], [reading('sensor.heater', power, 'W')]).rooms[0];
    assert.equal(heaterOnly.available, true);
    assert.equal(heaterOnly.climate.available, false);
    assert.equal(heaterOnly.heatingActive, power > 0);
  }
});

test('explicit dashboard measurements remain separate from the regulator and never use similar names', () => {
  const room = { id: 'bathroom', name: 'Koupelna', entityId: 'climate.bath', temperatureEntityId: 'sensor.correct_t', humidityEntityId: 'sensor.correct_h', unit: '°C' };
  const states = [reading('climate.bath', 'auto', null, { current_temperature: 26, temperature: 25 }),
    reading('sensor.correct_t', 22.5, '°C'), reading('sensor.correct_h', 44.5, '%'),
    reading('sensor.koupelna_vlhkost', 39, '%', { friendly_name: 'Koupelna' })];
  const result = read([room], states, { air: { rooms: [{ id: 'bathroom-air', name: 'KOUPELNA', humidityEntityId: 'sensor.koupelna_vlhkost' }] } }).rooms[0];
  assert.equal(result.temperature.value, 22.5);
  assert.equal(result.temperature.entityId, 'sensor.correct_t');
  assert.equal(result.humidity.value, 44.5);
  assert.equal(result.climate.currentTemperature, 26);
  assert.equal(result.currentTemperature, 26); // retained control/old-client scalar
  assert.equal(result.targetTemperature, 25);
  const missingClimate = read([room], states.filter(s => !s.entity_id.startsWith('climate.'))).rooms[0];
  assert.equal(missingClimate.available, true);
  assert.equal(missingClimate.climate.available, false);
  assert.equal(missingClimate.temperature.value, 22.5);
  assert.equal(missingClimate.targetTemperature, null);
});

test('unavailable, restored and invalid explicit air readings stay null even while climate and lookalikes are available', () => {
  const room = { id: 'living', entityId: 'climate.living', temperatureEntityId: 'sensor.t', humidityEntityId: 'sensor.h', co2EntityId: 'sensor.c', pm25EntityId: 'sensor.pm', unit: '°C' };
  const other = [reading('climate.living', 'heat', null, { current_temperature: 24, current_humidity: 60 }), reading('sensor.living_humidity', 55, '%')];
  for (const bad of ['unknown', 'unavailable', '', ' ', 'NaN', 'Infinity']) {
    const result = read([room], [...other, reading('sensor.t', bad, '°C'), reading('sensor.h', bad, '%'), reading('sensor.c', bad, 'ppm')]).rooms[0];
    for (const key of ['temperature', 'humidity', 'co2']) { assert.equal(result[key].available, false); assert.equal(result[key].value, null); }
    assert.equal(result.climate.available, true);
  }
  for (const invalid of [reading('sensor.h', 55, '%', { restored: true }), reading('sensor.h', 101, '%'), reading('sensor.h', 44, '°C')]) {
    assert.equal(read([room], [...other, invalid]).rooms[0].humidity.value, null);
  }
  const zero = read([room], [reading('sensor.h', 0, '%'), reading('sensor.c', 0, 'ppm'), reading('sensor.pm', 0, 'μg/m³')]).rooms[0];
  assert.equal(zero.humidity.value, 0); assert.equal(zero.co2.value, 0); assert.equal(zero.pm25.value, 0);
  assert.equal(read([room], [reading('sensor.c', 400, '%')]).rooms[0].co2.value, null);
  assert.equal(read([room], [reading('sensor.pm', -1, 'μg/m³')]).rooms[0].pm25.value, null);
});

test('a failed explicit temperature does not fall back to the available climate temperature', () => {
  const result = read([{ id: 'room', entityId: 'climate.room', temperatureEntityId: 'sensor.room', unit: '°C' }],
    [reading('sensor.room', 'unavailable', '°C'), reading('climate.room', 'auto', null, { current_temperature: 28 })]).rooms[0];
  assert.equal(result.temperature.value, null);
  assert.equal(result.temperature.entityId, 'sensor.room');
  assert.equal(result.currentTemperature, 28);
});

test('presence and door contacts are tri-state, time-aware and independent of missing room climate', () => {
  const room = { id: 'shed', presence: [{ id: 'occupancy', name: 'Přítomnost', entityId: 'binary_sensor.presence' }],
    equipment: [{ id: 'door', name: 'Dveře', kind: 'door', entityId: 'binary_sensor.door' }] };
  const result = read([room], [reading('binary_sensor.presence', 'off'), reading('binary_sensor.door', 'on')]).rooms[0];
  assert.equal(result.available, true);
  assert.equal(result.presence[0].active, false);
  assert.equal(result.presence[0].elapsedSeconds, 120);
  assert.equal(result.equipment[0].active, true);
  for (const bad of [reading('binary_sensor.door', 'unknown'), reading('binary_sensor.door', 'on', null, { restored: true }), reading('binary_sensor.door', 'closed')]) {
    const door = read([room], [bad]).rooms[0].equipment[0];
    assert.equal(door.available, false); assert.equal(door.active, null); assert.equal(door.elapsedSeconds, null);
  }
  const future = { ...reading('binary_sensor.presence', 'on'), last_changed: '2026-10-25T14:45:00Z' };
  assert.equal(read([room], [future]).rooms[0].presence[0].elapsedSeconds, null);
});

test('equipment reports mode and safe typed values without implying physical heating or leaking HA attributes', () => {
  const room = { id: 'living', entityId: 'climate.regulator', equipment: [
    { id: 'ac', kind: 'climate', entityId: 'climate.ac', unit: '°C' }, { id: 'purifier', kind: 'purifier', entityId: 'fan.air' },
    { id: 'boiler', kind: 'temperature', entityId: 'sensor.boiler' }, { id: 'power', kind: 'power', entityId: 'sensor.ac_power' },
  ] };
  const result = read([room], [reading('climate.regulator', 'heat', null, { hvac_action: 'heating', current_temperature: 22 }),
    reading('climate.ac', 'heat', null, { temperature: 30, hvac_action: 'heating', access_token: 'PRIVATE-SENTINEL' }),
    reading('fan.air', 'off', null, { percentage: 0, entity_picture: 'PRIVATE-SENTINEL' }), reading('sensor.boiler', 51.2, '°C'), reading('sensor.ac_power', 500, 'W')]).rooms[0];
  assert.equal(result.equipment[0].state, 'heat'); assert.equal(result.equipment[0].targetTemperature, 30);
  assert.equal(result.equipment[1].active, false); assert.equal(result.equipment[1].percentage, 0);
  assert.equal(result.equipment[2].value, 51.2);
  assert.equal(result.heatingActive, null); assert.equal(result.action, null);
  assert(!JSON.stringify(result).includes('PRIVATE-SENTINEL'));
});

test('legacy air merges only by stable room ID and normalization preserves explicit exclusions and is idempotent', () => {
  const input = { rooms: [{ id: 'bathroom', entityId: 'climate.bath' }, { id: 'bedroom', entityId: 'climate.bed', humidityEntityId: null }],
    air: { rooms: [{ id: 'bathroom', humidityEntityId: 'sensor.correct' }, { id: 'bedroom', humidityEntityId: 'sensor.excluded' }, { id: 'similar', name: 'Koupelna', co2EntityId: 'sensor.unrelated' }] } };
  const normalized = normalizeDomesticPanel(input);
  assert.equal(normalized.rooms[0].humidityEntityId, 'sensor.correct');
  assert.equal(normalized.rooms[1].humidityEntityId, null);
  assert.equal(normalized.rooms[0].co2EntityId, null);
  assert.deepEqual(normalizeDomesticPanel(normalized), normalized);
});

test('room identity and configuration boundaries reject duplicate IDs/climates and unsafe equipment domains', () => {
  const input = { rooms: [{ id: 'first', areaId: 'a', name: 'Stejný název', temperatureEntityId: 'sensor.a' },
    { id: 'second', areaId: 'b', name: 'Stejný název', temperatureEntityId: 'sensor.b' },
    { id: 'first', entityId: 'climate.other' }, { id: 'regulator', entityId: 'climate.room' }, { id: 'duplicate', entityId: 'climate.room' },
    { id: 'bad', entityId: 'lock.front', equipment: [{ id: 'lock', kind: 'door', entityId: 'lock.front' }] },
  ] };
  const normalized = normalizeDomesticPanel(input);
  assert.deepEqual(normalized.rooms.map(r => r.id), ['first', 'second', 'regulator']);
  assert.deepEqual(normalizeDomesticPanel({ rooms: [{ id: 'test', areaId: 'test', equipment: [
    { id: 'url', kind: 'status', entityId: 'http://private' }, { id: 'service', kind: 'script', entityId: 'script.unsafe' },
    { id: 'alarm', kind: 'status', entityId: 'alarm_control_panel.home' },
    { id: 'array-kind', kind: ['fan'], entityId: 'fan.air' },
    { id: 'object-kind', kind: JSON.parse('{"toString":null}'), entityId: 'fan.air' },
  ] }] }).rooms[0].equipment, []);
});

test('only the four primary regulators retain temperature control capabilities; equipment and sensor-only rooms stay read-only', () => {
  const config = { ...project, domesticPanel: normalizeDomesticPanel(panel) };
  const controls = createHomeControls({ ha: { request: () => { throw Error('No HA calls expected'); } }, config });
  assert.deepEqual(controls.capabilities().temperatures.map(r => r.id), ['room_0', 'room_1', 'room_2', 'room_3']);
  assert(!controls.capabilities().temperatures.some(r => r.id === 'aux_ac' || r.id === 'room_8'));
});
