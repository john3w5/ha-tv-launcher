// School timetables from the Bakaláři integration (schizza/bakalari-ha). Its
// "Rozvrh" sensor carries whole weeks in the `timetable` attribute; this keeps
// only what the TV shows: lessons, changes and days without school.

const text = (value, max = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const clock = value => /^\d{1,2}:\d{2}$/.test(value || '') ? value.padStart(5, '0') : null;
const lookup = (table, id) => table && typeof id === 'string' ? table[id.trim()] || null : null;

function readDay(week, day) {
  const date = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/.exec(day?.date || '');
  if (!date) return null;
  const rows = [];
  for (const atom of Array.isArray(day.atoms) ? day.atoms : []) {
    const hour = lookup(week.hours, String(atom?.hour_id ?? '')), begin = clock(hour?.begin_time), end = clock(hour?.end_time);
    if (!begin || !end) continue;
    const subject = lookup(week.subjects, atom.subject_id), room = lookup(week.rooms, atom.room_id);
    const change = atom.change ? { type: text(atom.change.change_type, 40), description: text(atom.change.description) } : null;
    if (!subject && !change) continue;
    rows.push({ hour: text(hour.caption, 8), begin, end, subject: subject ? text(subject.abbrev, 12) : null,
      subjectName: subject ? text(subject.name, 80) || text(subject.abbrev, 12) : null, room: room ? text(room.abbrev, 12) : null, change });
  }
  rows.sort((a, b) => a.begin.localeCompare(b.begin));
  // One school-wide event (holiday, excursion) covers several hours with the same text.
  const lessons = [];
  for (const row of rows) {
    const last = lessons.at(-1);
    if (!row.subject && last && !last.subject && last.change?.description === row.change.description) { last.end = row.end; last.lastHour = row.hour; continue; }
    lessons.push({ ...row });
  }
  const absence = lessons.find(row => !row.subject && row.change?.type === 'Absence');
  const free = day.day_type !== 'WorkDay' || (absence && !lessons.some(row => row.subject));
  const offset = date[2];
  return {
    date: date[1],
    off: free ? text(day.description) || absence?.change.description || 'Volno' : null,
    lessons: free ? [] : lessons,
    endsAt: !free && lessons.length ? `${date[1]}T${lessons.at(-1).end}:00${offset}` : null,
  };
}

export function readSchool(entries, byId) {
  return (entries || []).map(item => {
    const state = byId.get(item.entityId);
    const weeks = state && !['unknown', 'unavailable'].includes(state.state) && Array.isArray(state.attributes?.timetable) ? state.attributes.timetable : null;
    if (!weeks) return { entityId: item.entityId, name: item.name, available: false, days: [] };
    const days = new Map();
    for (const week of weeks.slice(0, 8)) {
      for (const day of Array.isArray(week?.days) ? week.days : []) {
        const value = readDay(week, day);
        if (value) days.set(value.date, value);
      }
    }
    return { entityId: item.entityId, name: item.name, available: true, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  });
}
