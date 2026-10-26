import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// node --test runs this file in its own child process; no server/other suite TZ changes.
process.env.TZ = 'Europe/Prague';
await import('../public/calendar-utils.js');
const { dayKey, dayBounds, overlapsDay } = globalThis.HomeTVCalendar;

test('classic script exposes only its namespace and accepts HA dates and instants', async () => {
  const sandbox = {};
  vm.runInNewContext(await readFile(new URL('../public/calendar-utils.js', import.meta.url), 'utf8'), sandbox);
  assert.deepEqual(Object.keys(sandbox), ['HomeTVCalendar']);
  assert.equal(Object.isFrozen(sandbox.HomeTVCalendar), true);
  assert.equal(dayKey({ date: '2026-10-23' }), '2026-10-23');
  assert.equal(dayKey({ dateTime: '2026-10-23T22:30:00Z' }), '2026-10-24');
  const original = new Date(2026, 9, 23, 12);
  const timestamp = original.valueOf();
  assert.equal(dayKey(original), '2026-10-23');
  assert.equal(original.valueOf(), timestamp);
});

test('single all-day event has an exclusive end date', () => {
  const event = { start: { date: '2026-10-23' }, end: { date: '2026-10-24' } };
  assert.equal(overlapsDay(event, '2026-10-22'), false);
  assert.equal(overlapsDay(event, '2026-10-23'), true);
  assert.equal(overlapsDay(event, '2026-10-24'), false);
});

test('three-day event started yesterday remains visible today and tomorrow', () => {
  const event = Object.freeze({ start: '2026-10-22', end: '2026-10-25' });
  for (const day of ['2026-10-22', '2026-10-23', '2026-10-24']) assert.equal(overlapsDay(event, day), true);
  assert.equal(overlapsDay(event, '2026-10-21'), false);
  assert.equal(overlapsDay(event, '2026-10-25'), false);
});

test('timed event spanning midnight overlaps both days, but exact midnight end does not', () => {
  const event = { start: { dateTime: '2026-10-23T23:30:00+02:00' }, end: { dateTime: '2026-10-24T00:30:00+02:00' } };
  assert.equal(overlapsDay(event, '2026-10-23'), true);
  assert.equal(overlapsDay(event, '2026-10-24'), true);
  assert.equal(overlapsDay(event, '2026-10-25'), false);
  assert.equal(overlapsDay({ ...event, end: '2026-10-24T00:00:00+02:00' }, '2026-10-24'), false);
});

test('missing or null end is a point on its local day', () => {
  const event = { start: '2026-10-23T22:30:00Z' };
  assert.equal(overlapsDay(event, '2026-10-23'), false);
  assert.equal(overlapsDay(event, '2026-10-24'), true);
  assert.equal(overlapsDay({ ...event, end: null }, '2026-10-24'), true);
  assert.equal(overlapsDay({ start: '2026-10-24' }, '2026-10-24'), true);
});

test('invalid dates and ranges fail closed instead of rolling into another day', () => {
  for (const value of [null, undefined, {}, '', 'invalid', '2026-02-30', '2026-13-01', '2026-00-01',
    '2026-01-00', '2026-02-29T12:00:00Z', '2026-10-23T25:00:00Z', '2026-10-23T12:60:00Z',
    '2026-10-23T12:00:60Z', '2026-10-23T12:00:00+24:00', new Date(NaN)]) assert.equal(dayKey(value), null);
  assert.equal(dayKey('2028-02-29'), '2028-02-29');
  for (const key of ['2026-02-30', '', null, '2026-10-23T00:00:00Z']) assert.equal(dayBounds(key), null);
  for (const event of [null, {}, { start: '2026-02-30' }, { start: '2026-10-23', end: 'invalid' },
    { start: '2026-10-23', end: '2026-10-23' }, { start: '2026-10-23', end: '2026-10-22' }]) {
    assert.equal(overlapsDay(event, '2026-10-23'), false);
  }
});

test('Prague spring DST day is 23 hours and includes its real final hour', () => {
  const bounds = dayBounds('2026-03-29');
  assert.equal(bounds.start.getHours(), 0); assert.equal(bounds.end.getHours(), 0);
  assert.equal(bounds.end.valueOf() - bounds.start.valueOf(), 23 * 3600000);
  assert.equal(dayKey(bounds.end), '2026-03-30');
  assert.equal(overlapsDay({ start: '2026-03-29T23:30:00+02:00', end: '2026-03-30T00:30:00+02:00' }, '2026-03-29'), true);
  assert.equal(overlapsDay({ start: '2026-03-30T00:00:00+02:00' }, '2026-03-29'), false);
  assert.equal(dayKey('2026-03-29T02:30:00'), null); // Nonexistent local wall time.
});

test('Prague autumn DST day is 25 hours and includes both repeated 02:30 instants', () => {
  const bounds = dayBounds('2026-10-25');
  assert.equal(bounds.end.valueOf() - bounds.start.valueOf(), 25 * 3600000);
  assert.equal(dayKey(bounds.end), '2026-10-26');
  for (const start of ['2026-10-25T02:30:00+02:00', '2026-10-25T02:30:00+01:00', '2026-10-25T23:30:00+01:00']) {
    assert.equal(overlapsDay({ start }, '2026-10-25'), true);
  }
  const event = { start: '2026-10-24T23:30:00+02:00', end: '2026-10-26T00:00:00+01:00' };
  assert.equal(overlapsDay(event, '2026-10-25'), true);
  assert.equal(overlapsDay(event, '2026-10-26'), false);
});
