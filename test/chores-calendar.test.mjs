import test from 'node:test';
import assert from 'node:assert/strict';
import { readDashboard } from '../lib/home-assistant.mjs';

const config = chores => ({ entities: { weather: {}, calendars: [{ entityId: 'calendar.family', name: 'Rodina' }], chores, cameras: [], mediaPlayers: [], scenes: [], lights: [], locks: [], doors: [] }, safeScenes: [], calendarDays: 7 });
const chore = { summary: 'Marek – myčka', start: { date: '2026-11-03' }, end: { date: '2026-11-04' } };

test('chores come from their own calendar and stay out of the family calendars', async () => {
  const requested = [];
  const ha = { states: async () => [], calendar: async (entityId, start) => { requested.push({ entityId, start }); return entityId === 'calendar.povinnosti' ? [chore] : []; } };
  const dashboard = await readDashboard(ha, config({ entityId: 'calendar.povinnosti', name: 'Povinnosti' }));
  assert.deepEqual(dashboard.chores, { entityId: 'calendar.povinnosti', name: 'Povinnosti', available: true,
    events: [{ summary: 'Marek – myčka', start: '2026-11-03', end: '2026-11-04' }] });
  assert.deepEqual(dashboard.calendars[0].events, []);
  const [family, chores] = ['calendar.family', 'calendar.povinnosti'].map(id => Date.parse(requested.find(item => item.entityId === id).start));
  assert.equal(family - chores, 86400000);
});

test('a failing chores calendar is reported as unavailable and an unset one stays null', async () => {
  const ha = { states: async () => [], calendar: async entityId => { if (entityId === 'calendar.povinnosti') throw Error('offline'); return []; } };
  const failed = await readDashboard(ha, config({ entityId: 'calendar.povinnosti', name: 'Povinnosti' }));
  assert.deepEqual(failed.chores, { entityId: 'calendar.povinnosti', name: 'Povinnosti', available: false, events: [] });
  assert.equal((await readDashboard(ha, config(null))).chores, null);
});
