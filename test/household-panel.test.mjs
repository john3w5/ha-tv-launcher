import test from 'node:test';
import assert from 'node:assert/strict';
import { readHouseholdPanel, normalizeHouseholdPanel, pragueDayWindow } from '../lib/household-panel.mjs';

const now = new Date('2026-10-23T12:00:00Z');
const state = (entity_id, value, attributes = {}, extra = {}) => ({ entity_id, state: value, attributes, ...extra });
const securityConfig = { security: [{ id: 'home', name: 'Domov', enabledEntityId: 'input_boolean.secure', exitTimerEntityId: 'timer.exit', bypassEntityId: 'input_text.bypass', monitoringAutomationIds: ['automation.monitor'], contacts: [{ entityId: 'binary_sensor.front', name: 'Dveře', code: 'front' }, { entityId: 'binary_sensor.window', name: 'Okno', code: 'window' }] }] };
function baseStates(control = 'on', timer = 'idle') {
  return [state('input_boolean.secure', control), state('timer.exit', timer, { finishes_at: '2026-10-23T12:00:30Z' }), state('input_text.bypass', 'front, unknown-code'), state('automation.monitor', 'on'), state('binary_sensor.front', 'on'), state('binary_sensor.window', 'unavailable'), state('alarm_control_panel.sample_001', 'unavailable')];
}
const ha = events => ({ states: () => { assert.fail('states must be fetched only once by the caller'); }, calendar: async () => events, callService: () => { assert.fail('read panel cannot mutate HA'); } });

test('security status uses existing custom logic, exact contacts and bypass without inventing complete protection', async () => {
  const result = await readHouseholdPanel(ha(), securityConfig, { states: baseStates(), now });
  const zone = result.security[0];
  assert.equal(zone.state, 'armed'); assert.equal(zone.source, 'ha_custom_zone'); assert.equal(zone.coverageComplete, false);
  assert.equal(zone.availableContactCount, 1); assert.equal(zone.openContactCount, 1); assert.equal(zone.bypassedContactCount, 1);
  assert.deepEqual(zone.contacts, [{ entityId: 'binary_sensor.front', name: 'Dveře', state: 'open', available: true, bypassed: true }, { entityId: 'binary_sensor.window', name: 'Okno', state: 'unknown', available: false, bypassed: false }]);
  const countdown = await readHouseholdPanel(ha(), securityConfig, { states: baseStates('on', 'active'), now });
  assert.equal(countdown.security[0].state, 'arming'); assert.equal(countdown.security[0].remainingSeconds, 30);
  assert.equal((await readHouseholdPanel(ha(), securityConfig, { states: baseStates('off', 'idle'), now })).security[0].state, 'disarmed');
});

test('unavailable, paused, inconsistent or disabled monitoring remains unknown', async () => {
  for (const [control, timer] of [['on', 'paused'], ['on', 'unavailable'], ['unknown', 'idle'], ['off', 'active']]) {
    const result = await readHouseholdPanel(ha(), securityConfig, { states: baseStates(control, timer), now });
    assert.equal(result.security[0].state, 'unknown'); assert.equal(result.security[0].available, false);
  }
  const states = baseStates().map(s => s.entity_id === 'automation.monitor' ? { ...s, state: 'off' } : s);
  const zone = (await readHouseholdPanel(ha(), securityConfig, { states, now })).security[0];
  assert.equal(zone.state, 'unknown'); assert.equal(zone.monitoringAvailable, false);
  const noBypass = baseStates().filter(s => s.entity_id !== 'input_text.bypass');
  const missing = (await readHouseholdPanel(ha(), securityConfig, { states: noBypass, now })).security[0];
  assert.equal(missing.bypassAvailable, false); assert.equal(missing.bypassedContactCount, null); assert.equal(missing.contacts[0].bypassed, null);
});

test('Prague calendar query spans the actual civil day across midnight and both DST changes', () => {
  assert.deepEqual(pragueDayWindow(new Date('2026-10-23T22:30:00Z')), { timeZone: 'Europe/Prague', localDate: '2026-10-24', nextLocalDate: '2026-10-25', start: '2026-10-23T22:00:00.000Z', end: '2026-10-24T22:00:00.000Z' });
  const autumn = pragueDayWindow(new Date('2026-10-25T12:00:00Z'));
  assert.equal(autumn.start, '2026-10-24T22:00:00.000Z'); assert.equal(autumn.end, '2026-10-25T23:00:00.000Z');
  assert.equal(Date.parse(autumn.end) - Date.parse(autumn.start), 25 * 3600000);
  const spring = pragueDayWindow(new Date('2026-03-29T12:00:00Z'));
  assert.equal(Date.parse(spring.end) - Date.parse(spring.start), 23 * 3600000);
});

test('birthdays include today only, keep exclusive end and ignore unrelated, cancelled or malformed events', async () => {
  const calls = [];
  const events = [
    { uid: 'today', summary: 'Test dnes', start: { date: '2026-10-23' }, end: { date: '2026-10-24' }, private_field: 'never-return' },
    { summary: 'Včera', start: '2026-10-22', end: '2026-10-23' },
    { summary: 'Zítra', start: '2026-10-24', end: '2026-10-25' },
    { summary: 'Končí přesně o půlnoci', start: { dateTime: '2026-10-22T20:00:00Z' }, end: { dateTime: '2026-10-22T22:00:00Z' } },
    { summary: 'Začíná další den', start: '2026-10-23T22:00:00Z', end: '2026-10-24T01:00:00Z' },
    { summary: 'Zrušeno', status: 'cancelled', start: '2026-10-23', end: '2026-10-24' },
    { summary: 'Chybné datum', start: '2026-99-99', end: '2026-10-24' },
    { summary: 'Bez konce', start: '2026-10-23' },
  ];
  const api = { ...ha(), calendar: async (...args) => { calls.push(args); return events; } };
  const result = await readHouseholdPanel(api, { birthdayCalendarEntityId: 'calendar.sample_031' }, { states: [state('calendar.sample_031', 'off'), state('calendar.family', 'on', { message: 'Unrelated family event' })], now });
  assert.deepEqual(calls, [['calendar.sample_031', '2026-10-22T22:00:00.000Z', '2026-10-23T22:00:00.000Z']]);
  assert.equal(result.birthdayCalendar.available, true); assert.equal(result.birthdaysToday.length, 1);
  assert.equal(result.birthdaysToday[0].summary, 'Test dnes'); assert.equal(result.birthdaysToday[0].allDay, true);
  assert.match(result.birthdaysToday[0].id, /^birthday-[a-f0-9]{20}$/); assert.ok(!JSON.stringify(result).includes('never-return'));
});

test('people and zones project only explicit local coordinates, freshness and accuracy; no raw private attributes', async () => {
  const config = { people: [{ id: 'first', name: 'Test', entityId: 'person.first' }, { id: 'second', name: 'Test 2', entityId: 'person.second' }], zones: [{ entityId: 'zone.example_home', name: 'Domov' }] };
  const states = [state('person.first', 'home', { latitude: 0, longitude: 0, gps_accuracy: 10, access_token: 'never-return', entity_picture: '/private-photo', device_trackers: ['device_tracker.private'] }, { last_updated: '2026-10-23T11:50:00Z' }), state('person.second', 'not_home', { latitude: 91, longitude: 0 }), state('person.unselected', 'Private place', { latitude: 12, longitude: 12 }), state('zone.example_home', '0', { latitude: 0, longitude: 0, radius: 100, private_value: 'never-return' })];
  const result = await readHouseholdPanel(ha(), config, { states, now });
  assert.equal(result.people.length, 2); assert.equal(result.people[0].locationAvailable, true); assert.equal(result.people[0].latitude, 0);
  assert.equal(result.people[0].lastUpdated, '2026-10-23T11:50:00.000Z'); assert.equal(result.people[0].gpsAccuracy, 10);
  assert.equal(result.people[1].locationAvailable, false); assert.equal(result.people[1].latitude, null);
  assert.deepEqual(result.zones[0], { id: 'example_home', entityId: 'zone.example_home', name: 'Domov', available: true, latitude: 0, longitude: 0, radius: 100 });
  for (const term of ['never-return', 'private-photo', 'device_tracker.private', 'Private place']) assert.ok(!JSON.stringify(result).includes(term));
});

test('calendar errors and missing name-day data remain unavailable and never log GPS, birthday text or provider secrets', async () => {
  const messages = [], original = { log: console.log, warn: console.warn, error: console.error };
  try {
    for (const method of Object.keys(original)) console[method] = (...args) => messages.push(args);
    const api = { ...ha(), calendar: async () => { throw Error('secret provider response and private title'); } };
    const result = await readHouseholdPanel(api, { namedayEntityId: 'sensor.nameday', birthdayCalendarEntityId: 'calendar.sample_031', people: [{ id: 'test', name: 'Test', entityId: 'person.first' }] }, { states: [state('sensor.nameday', 'unavailable'), state('calendar.sample_031', 'off'), state('person.first', 'home', { latitude: 0, longitude: 0 })], now });
    assert.deepEqual(result.nameday, { available: false, names: [], source: 'sensor.nameday', date: '2026-10-23' });
    assert.equal(result.birthdayCalendar.available, false); assert.deepEqual(result.birthdaysToday, []);
    assert.ok(!JSON.stringify(result).includes('secret provider')); assert.equal(messages.length, 0);
  } finally { Object.assign(console, original); }
  const ok = await readHouseholdPanel(ha(), { namedayEntityId: 'sensor.nameday' }, { states: [state('sensor.nameday', 'Test')], now });
  assert.deepEqual(ok.nameday.names, ['Test']);
});
