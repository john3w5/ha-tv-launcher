import test from 'node:test';
import assert from 'node:assert/strict';
import { readDashboard } from '../lib/home-assistant.mjs';
const config = { entities: { weather: {}, calendars: [], cameras: [], mediaPlayers: [], scenes: [], lights: [], locks: [], doors: [] }, safeScenes: [], calendarDays: 7 };
const position = { elevation: null, azimuth: null, rising: null };
async function solar(state) {
  const dashboard = await readDashboard({ states: async () => state ? [state] : [] }, config);
  return dashboard.solar;
}
test('solar uses actual HA horizon and projects valid next sunrise/sunset only', async () => {
  assert.deepEqual(await solar({ entity_id: 'sun.sun', state: 'below_horizon', attributes: {
    next_rising: '2026-10-24T05:27:46.921740+00:00', next_setting: '2026-10-24T17:46:36+02:00', latitude: 'do-not-return',
  } }), { state: 'below_horizon', nextRising: '2026-10-24T05:27:46.921Z', nextSetting: '2026-10-24T15:46:36.000Z', ...position });
  assert.deepEqual(await solar({ entity_id: 'sun.sun', state: 'above_horizon', attributes: {} }),
    { state: 'above_horizon', nextRising: null, nextSetting: null, ...position });
});
test('missing, unavailable or invalid sun state is unknown and discards stale times', async () => {
  for (const state of [undefined, 'unavailable', 'unknown', 'on', '', '<script>']) {
    assert.deepEqual(await solar(state === undefined ? null : { entity_id: 'sun.sun', state, attributes: { next_rising: '2026-10-24T05:00:00Z' } }),
      { state: 'unknown', nextRising: null, nextSetting: null, ...position });
  }
});
test('malformed solar timestamps do not become fabricated sunrise or sunset', async () => {
  for (const value of ['tomorrow', '2026-02-30T05:00:00Z', '2026-13-24T05:00:00Z', '2026-10-24T25:00:00Z', '2026-10-24', '2026-10-24T05:00:00', 'javascript:alert(1)', null, 123]) {
    assert.deepEqual(await solar({ entity_id: 'sun.sun', state: 'below_horizon', attributes: { next_rising: value, next_setting: value } }),
      { state: 'below_horizon', nextRising: null, nextSetting: null, ...position });
  }
});
test('solar projects actual finite position and direction without exposing arbitrary attributes', async () => {
  const result = await solar({ entity_id: 'sun.sun', state: 'above_horizon', attributes: { elevation: 23.5, azimuth: 132.8, rising: true, latitude: 50, longitude: 15, token: 'do-not-return' } });
  assert.deepEqual(result, { state: 'above_horizon', nextRising: null, nextSetting: null, elevation: 23.5, azimuth: 132.8, rising: true });
  for (const elevation of [null, '', '23.5', false, Infinity, -91, 91]) {
    const result = await solar({ entity_id: 'sun.sun', state: 'above_horizon', attributes: { elevation, azimuth: 361, rising: 'true' } });
    assert.deepEqual({ elevation: result.elevation, azimuth: result.azimuth, rising: result.rising }, position);
  }
  assert.deepEqual(await solar({ entity_id: 'sun.sun', state: 'above_horizon', attributes: { restored: true, elevation: 30, azimuth: 180, rising: true } }),
    { state: 'unknown', nextRising: null, nextSetting: null, ...position });
});
test('restored weather measurements and conditions are not presented as current live weather', async () => {
  const weatherConfig = { ...config, entities: { ...config.entities, weather: { rainRate: 'sensor.rain', condition: 'weather.home' } } };
  const states = [
    { entity_id: 'sensor.rain', state: '4.2', attributes: { unit_of_measurement: 'mm/h', restored: true } },
    { entity_id: 'weather.home', state: 'snowy', attributes: { restored: true } }
  ];
  const dashboard = await readDashboard({ states: async () => states }, weatherConfig);
  assert.equal(dashboard.weather.rainRate, null); assert.equal(dashboard.weather.condition, null);
  assert.equal(dashboard.weather.units.rainRate, 'mm/h');
});
