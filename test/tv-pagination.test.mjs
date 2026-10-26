import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

process.env.TZ = 'Europe/Prague';
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const calendar = await readFile(new URL('../public/calendar-utils.js', import.meta.url), 'utf8');
function declaration(name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\s*\\(', 'm').exec(app);
  assert.ok(match, 'Actual app declaration must exist: ' + name);
  const start = match.index, body = app.indexOf('{', start);
  let depth = 0, quote = '', comment = '';
  for (let index = body; index < app.length; index++) {
    const character = app[index], next = app[index + 1];
    if (comment === '//') { if (character === '\n') comment = ''; continue; }
    if (comment === '/*') { if (character === '*' && next === '/') { comment = ''; index++; } continue; }
    if (quote) { if (character === '\\') index++; else if (character === quote) quote = ''; continue; }
    if (character === '/' && (next === '/' || next === '*')) { comment = '/' + next; index++; continue; }
    if (['"', "'", '`'].includes(character)) { quote = character; continue; }
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return app.slice(start, index + 1);
  }
  throw new Error('Unterminated app declaration: ' + name);
}
function constant(name) {
  const match = new RegExp('^const ' + name + '\\s*=.*;$', 'm').exec(app);
  assert.ok(match, 'Actual app formatter must exist: ' + name); return match[0];
}
const NOW = Date.parse('2026-10-24T10:00:00+02:00');
class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
const ui = {
  Date: ClockDate,
  state: { mode: 'live', calendarDay: null, data: { calendars: [{ available: true, name: 'Rodina' }] } },
  uiPaging: { calendar: 0 }, isWideTv: () => true, calendarWeek: () => '', icon: () => '',
  calendarAgenda() { throw Error('Wide TV must render only the paged occurrences, not the unpaged agenda'); }
};
vm.runInNewContext(calendar, ui);
vm.runInNewContext(['eventStart', 'esc', 'dateFormatters', 'dayFormat'].map(constant).join('\n'), ui);
vm.runInNewContext(['eventTime', 'eventMarkup', 'calendarsAvailable', 'calendarOccurrences', 'paginateTv', 'calendarOccurrenceMarkup', 'paginationMarkup', 'renderCalendar'].map(declaration).join('\n'), ui);
const days = Array.from({ length: 7 }, (_, index) => '2026-10-' + String(24 + index));
const weekEvent = Object.freeze({ start: '2026-10-24', end: '2026-10-31', summary: 'Týdenní dovolená', calendar: 'Rodina' });
const rowCount = markup => (markup.match(/class="event"/g) || []).length;

test('one seven-day event produces exactly seven daily occurrences with an exclusive end', () => {
  const rows = ui.calendarOccurrences(Object.freeze([weekEvent]), days);
  assert.equal(rows.length, 7); assert.deepEqual(Array.from(rows, row => row.day), days);
  assert.ok(rows.every(row => row.event === weekEvent));
  assert.equal(ui.calendarOccurrences([weekEvent], ['2026-10-31']).length, 0);
});

test('seven actual occurrences page as four plus three and markup never expands them back to a full week', () => {
  const rows = ui.calendarOccurrences([weekEvent], days);
  const first = ui.paginateTv(rows, 0, 4), second = ui.paginateTv(rows, 1, 4);
  assert.equal(first.pages, 2); assert.equal(first.items.length, 4); assert.equal(second.items.length, 3);
  assert.equal(rowCount(ui.calendarOccurrenceMarkup(first.items)), 4);
  assert.equal(rowCount(ui.calendarOccurrenceMarkup(second.items)), 3);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.day)).size, 7);
  assert.equal(rowCount(ui.calendarOccurrenceMarkup([rows[0], rows[6]])), 2, 'Markup groups only supplied rows, even for one repeated week-long event');
});

test('actual renderCalendar wires occurrence pagination into the wide-TV view across the DST week', () => {
  ui.events = () => [weekEvent]; ui.state.calendarDay = null; ui.uiPaging.calendar = 0;
  assert.equal(rowCount(ui.renderCalendar()), 4); assert.equal(ui.uiPaging.calendar, 0);
  ui.uiPaging.calendar = 1; const second = ui.renderCalendar();
  assert.equal(rowCount(second), 3); assert.match(second, /2 \/ 2/);
  ui.state.calendarDay = '2026-10-25'; ui.uiPaging.calendar = 50;
  assert.equal(rowCount(ui.renderCalendar()), 1); assert.equal(ui.uiPaging.calendar, 0);
  ui.state.calendarDay = null;
});

test('multiple events on one day remain separate rows while chronological occurrence order is preserved', () => {
  const extra = Object.freeze({ start: '2026-10-26T12:00:00+01:00', end: '2026-10-26T13:00:00+01:00', summary: 'Návštěva' });
  const rows = ui.calendarOccurrences([weekEvent, extra], days), page = ui.paginateTv(rows, 0, 4);
  assert.equal(rows.length, 8); assert.equal(rowCount(ui.calendarOccurrenceMarkup(page.items)), 4);
  const first = Array.from(page.items, row => row.day); assert.deepEqual(first, ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-26']);
});

test('application pagination has at most six items per page without skips or duplicates', () => {
  const apps = Object.freeze(Array.from({ length: 13 }, (_, id) => Object.freeze({ id })));
  const pages = [0, 1, 2].map(page => ui.paginateTv(apps, page, 6));
  assert.deepEqual(pages.map(page => page.items.length), [6, 6, 1]);
  assert.ok(pages.every(page => page.pages === 3 && page.total === 13));
  assert.deepEqual(pages.flatMap(page => Array.from(page.items, item => item.id)), Array.from({ length: 13 }, (_, id) => id));
});

test('out-of-range page indices clamp after data changes, and empty results keep one empty page', () => {
  const items = Array.from({ length: 8 }, (_, index) => index);
  assert.equal(ui.paginateTv(items, -5, 4).page, 0); assert.equal(ui.paginateTv(items, 100, 4).page, 1);
  for (const page of [NaN, '1', 1.5, null, undefined]) assert.equal(ui.paginateTv(items, page, 4).page, 0);
  const empty = ui.paginateTv([], 100, 6);
  assert.equal(empty.page, 0); assert.equal(empty.pages, 1); assert.equal(empty.total, 0); assert.equal(empty.items.length, 0);
  ui.state.mode = 'offline'; assert.match(ui.calendarOccurrenceMarkup([]), /Kalendář není dostupný/); ui.state.mode = 'live';
});

test('overview events visibly pair their Czech day and date with time, including Prague midnight and all-day dates', () => {
  const allDay = ui.eventMarkup({ start: { date: '2026-10-26' }, summary: 'Prázdniny', calendar: 'Rodina' });
  assert.match(allDay, /<time datetime="2026-10-26"><span class="event-day">po 26\. 10\.<\/span><small>Celý den<\/small><\/time>/);
  const midnight = ui.eventMarkup({ start: { dateTime: '2026-10-24T22:30:00Z' }, summary: 'Návrat', calendar: 'Rodina' });
  assert.match(midnight, /datetime="2026-10-25"/);
  assert.match(midnight, /<span class="event-day">ne 25\. 10\.<\/span><small>00:30<\/small>/);
  assert.doesNotMatch(ui.eventMarkup({ start: 'not-a-date', summary: 'Událost' }), /1970|Invalid Date/);
  assert.match(ui.eventMarkup({ start: 'not-a-date', summary: 'Událost' }), /Datum neznámé/);
  assert.doesNotMatch(ui.eventMarkup({ start: '2026-10-26', summary: 'Prázdniny' }, true), /event-day/,
    'Full agenda already has its own date headings and keeps its time column compact');
});
