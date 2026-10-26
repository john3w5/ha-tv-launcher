/* Classic-script calendar helpers. All days use the browser's local time zone. */
(function (root) {
  'use strict';

  const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;
  const pad = value => String(value).padStart(2, '0');
  const keyForDate = date => `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  function validDay(year, month, day) {
    if (month < 1 || month > 12 || day < 1) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }

  function localMidnight(year, month, day) {
    // setFullYear avoids Date's special conversion of years 0..99 to 1900..1999.
    const date = new Date(0);
    date.setHours(0, 0, 0, 0);
    date.setFullYear(year, month - 1, day);
    return date;
  }

  function parse(value) {
    if (value instanceof Date) return Number.isFinite(value.valueOf()) ? new Date(value.valueOf()) : null;
    if (value && typeof value === 'object') value = value.dateTime ?? value.date;
    if (typeof value !== 'string') return null;
    let match = DATE.exec(value);
    if (match) {
      const [, year, month, day] = match.map(Number);
      if (!validDay(year, month, day)) return null;
      const date = localMidnight(year, month, day);
      return keyForDate(date) === value ? date : null;
    }
    match = TIMESTAMP.exec(value);
    if (!match) return null;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
    const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText || '0'].map(Number);
    if (!validDay(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
    if (zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf())) return null;
    // A zone-free wall time inside a skipped DST hour is not silently moved.
    if (!zone && (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day ||
      date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second)) return null;
    return date;
  }

  /** Date, ISO string or HA {dateTime}/{date} -> YYYY-MM-DD, otherwise null. */
  function dayKey(value) {
    const date = parse(value);
    return date ? keyForDate(date) : null;
  }

  /** Local midnights: end is exclusive and can be 23/24/25 hours after start. */
  function dayBounds(key) {
    if (typeof key !== 'string' || !DATE.test(key)) return null;
    const start = parse(key);
    if (!start) return null;
    const end = new Date(start.valueOf());
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  /** HA event -> overlap with [local midnight, next midnight). Missing end is a point. */
  function overlapsDay(event, key) {
    if (!event || typeof event !== 'object') return false;
    const bounds = dayBounds(key);
    const start = parse(event.start);
    if (!bounds || !start) return false;
    if (event.end == null) return start >= bounds.start && start < bounds.end;
    const end = parse(event.end);
    return Boolean(end && end > start && start < bounds.end && end > bounds.start);
  }

  root.HomeTVCalendar = Object.freeze({ dayKey, dayBounds, overlapsDay });
})(globalThis);
