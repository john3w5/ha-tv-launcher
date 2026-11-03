import test from 'node:test';
import assert from 'node:assert/strict';
import { readSchool } from '../lib/school-timetable.mjs';

const hours = { 3: { id: 3, caption: '1', begin_time: '8:00', end_time: '8:45' }, 4: { id: 4, caption: '2', begin_time: '8:55', end_time: '9:40' }, 5: { id: 5, caption: '3', begin_time: '9:55', end_time: '10:40' } };
const week = days => ({ hours, days, subjects: { 10: { id: '10', abbrev: 'M', name: 'Matematika' }, 4: { id: '4', abbrev: 'Aj', name: 'Anglický jazyk' } },
  rooms: { '0Q': { id: '0Q', abbrev: '4310', name: 'učebna' } }, teachers: { U1: { id: 'U1', abbrev: 'Krb', name: 'Tomáš Krbec' } } });
const read = attributes => readSchool([{ entityId: 'sensor.rozvrh_maty', name: 'Maty' }], new Map([['sensor.rozvrh_maty', { state: '3', attributes }]]))[0];

test('lessons keep subject, room and their change, sorted by time', () => {
  const child = read({ timetable: [week([{ date: '2026-11-05T00:00:00+01:00', day_type: 'WorkDay', description: '', atoms: [
    { hour_id: 4, subject_id: ' 4', room_id: '0Q', teacher_id: 'U1', change: { change_type: 'Substitution', description: 'Suplování: Krbec Tomáš' } },
    { hour_id: 3, subject_id: '10', room_id: '0Q', teacher_id: 'U1', change: null },
    { hour_id: 5, subject_id: null, room_id: null, change: { change_type: 'Canceled', description: 'Zrušeno (TvS, Krbec Tomáš)' } },
  ] }])] });
  assert.equal(child.available, true);
  assert.deepEqual(child.days, [{ date: '2026-11-05', off: null, endsAt: '2026-11-05T10:40:00+01:00', lessons: [
    { hour: '1', begin: '08:00', end: '08:45', subject: 'M', subjectName: 'Matematika', room: '4310', change: null },
    { hour: '2', begin: '08:55', end: '09:40', subject: 'Aj', subjectName: 'Anglický jazyk', room: '4310', change: { type: 'Substitution', description: 'Suplování: Krbec Tomáš' } },
    { hour: '3', begin: '09:55', end: '10:40', subject: null, subjectName: null, room: null, change: { type: 'Canceled', description: 'Zrušeno (TvS, Krbec Tomáš)' } },
  ] }]);
  assert.doesNotMatch(JSON.stringify(child), /teacher|U1/);
});

test('holidays and whole-day absences become one free day, a shared event one row', () => {
  const absence = (hour_id, description) => ({ hour_id, subject_id: null, change: { change_type: 'Absence', description } });
  const child = read({ timetable: [week([
    { date: '2026-10-29T00:00:00+01:00', day_type: 'Holiday', description: 'podzimní prázdniny', atoms: [absence(3, 'podzimní prázdniny')] },
    { date: '2026-10-26T00:00:00+01:00', day_type: 'WorkDay', description: '', atoms: [
      { hour_id: 3, subject_id: null, change: { change_type: 'Removed', description: 'Vyjmuto z rozvrhu (M)' } }, absence(4, 'Ředitelské volno'), absence(5, 'Ředitelské volno')] },
    { date: '2026-11-13T00:00:00+01:00', day_type: 'WorkDay', description: '', atoms: [absence(3, 'Beseda'), absence(4, 'Beseda'), { hour_id: 5, subject_id: '10', room_id: '0Q', change: null }] },
  ])] });
  assert.deepEqual(child.days.map(day => [day.date, day.off]), [['2026-10-26', 'Ředitelské volno'], ['2026-10-29', 'podzimní prázdniny'], ['2026-11-13', null]]);
  assert.deepEqual(child.days[2].lessons.map(row => [row.hour, row.lastHour, row.begin, row.end, row.subject]), [['1', '2', '08:00', '09:40', null], ['3', undefined, '09:55', '10:40', 'M']]);
});

test('a missing or unavailable sensor is reported without days', () => {
  assert.deepEqual(readSchool([{ entityId: 'sensor.rozvrh_x', name: 'X' }], new Map()), [{ entityId: 'sensor.rozvrh_x', name: 'X', available: false, days: [] }]);
  assert.equal(readSchool([{ entityId: 'sensor.r', name: 'R' }], new Map([['sensor.r', { state: 'unavailable', attributes: { timetable: [] } }]]))[0].available, false);
});
