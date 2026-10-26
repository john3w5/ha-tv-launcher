import test from 'node:test';
import assert from 'node:assert/strict';
import { readDashboard } from '../lib/home-assistant.mjs';

const weather = Object.fromEntries(['windDirection', 'windGust', 'feelsLike', 'dewPoint', 'dailyRain', 'pressure', 'uvIndex', 'illuminance'].map(key => [key, `sensor.${key.toLowerCase()}`]));
const config = { entities: { weather }, safeScenes: [], calendarDays: 7 };
const sensor = (key, state, unit, extra = {}) => ({ entity_id: weather[key], state: String(state), attributes: { unit_of_measurement: unit, ...extra } });
const read = states => readDashboard({ states: async () => states }, config);

test('station metrics preserve source measurements and units without deriving missing quantities', async () => {
  const dashboard = await read([sensor('windDirection', 297, '°'), sensor('windGust', 0, 'km/h'), sensor('feelsLike', 2.7, '°C'),
    sensor('dewPoint', 2, '°C'), sensor('dailyRain', 0, 'mm'), sensor('pressure', 994.2, 'hPa')]);
  assert.equal(dashboard.weather.windDirection, 297);
  assert.equal(dashboard.weather.units.windDirection, '°');
  assert.equal(dashboard.weather.windGust, 0);
  assert.equal(dashboard.weather.units.windGust, 'km/h');
  assert.equal(dashboard.weather.feelsLike, 2.7);
  assert.equal(dashboard.weather.dewPoint, 2);
  assert.equal(dashboard.weather.dailyRain, 0);
  assert.equal(dashboard.weather.units.dailyRain, 'mm');
  assert.equal(dashboard.weather.pressure, 994.2);
  assert.equal(dashboard.weather.uvIndex, null);
  assert.equal(dashboard.weather.illuminance, null);
});

test('invalid direction, units, unavailable or restored station data never appear as valid zero', async () => {
  for (const invalid of [sensor('windDirection', 361, '°'), sensor('windDirection', -1, '°'), sensor('windDirection', 2, 'km/h'),
    sensor('windDirection', ' ', '°'), sensor('windDirection', '0x30', '°'), sensor('windDirection', 'unknown', '°'), sensor('windDirection', 20, '°', { restored: true })]) {
    assert.equal((await read([invalid])).weather.windDirection, null);
  }
  const dashboard = await read([sensor('windGust', -1, 'km/h'), sensor('dailyRain', 100, 'mm/h'), sensor('feelsLike', 2, 'W'),
    sensor('uvIndex', 'unavailable', 'UV index', { restored: true }), sensor('illuminance', 100, 'W/m²')]);
  for (const key of ['windGust', 'dailyRain', 'feelsLike', 'uvIndex', 'illuminance']) assert.equal(dashboard.weather[key], null);
});
