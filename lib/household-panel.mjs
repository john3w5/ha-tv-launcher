import { createHash } from 'node:crypto';

const TZ = 'Europe/Prague';
const slug = value => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/.test(value);
const entity = (value, domain) => typeof value === 'string' && new RegExp(`^${domain}\\.[a-z0-9_]+$`).test(value);
const safeText = (value, fallback = '', max = 160) => String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
const available = state => Boolean(state && typeof state.state === 'string' && !['unknown', 'unavailable'].includes(state.state) && !state.attributes?.restored);
const iso = input => {
  if (typeof input !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.exec(input);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
  const value = Date.parse(input); return Number.isFinite(value) ? new Date(value).toISOString() : null;
};
const coordinates = attrs => Number.isFinite(attrs?.latitude) && attrs.latitude >= -90 && attrs.latitude <= 90
  && Number.isFinite(attrs?.longitude) && attrs.longitude >= -180 && attrs.longitude <= 180
  ? { latitude: attrs.latitude, longitude: attrs.longitude } : { latitude: null, longitude: null };
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const parts = (formatter, date) => Object.fromEntries(formatter.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
const dayString = ({ year, month, day }) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const midnight = civil => {
  const target = Date.UTC(civil.year, civil.month - 1, civil.day);
  let candidate = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(timeFormatter, new Date(candidate));
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    candidate -= wall - target;
  }
  return candidate;
};

export function pragueDayWindow(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid panel date');
  const today = parts(dayFormatter, now);
  const nextDate = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const tomorrow = { year: nextDate.getUTCFullYear(), month: nextDate.getUTCMonth() + 1, day: nextDate.getUTCDate() };
  return { timeZone: TZ, localDate: dayString(today), nextLocalDate: dayString(tomorrow),
    start: new Date(midnight(today)).toISOString(), end: new Date(midnight(tomorrow)).toISOString() };
}

/** This configuration is only a read projection and an existing routine preview. It executes no action. */
export function normalizeHouseholdPanel(raw = {}) {
  const result = { security: [], people: [], zones: [], namedayEntityId: null, birthdayCalendarEntityId: null, night: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const seen = new Set();
  for (const zone of (Array.isArray(raw.security) ? raw.security : []).slice(0, 8)) {
    if (!slug(zone?.id) || seen.has(zone.id) || !entity(zone.enabledEntityId, 'input_boolean') || !entity(zone.exitTimerEntityId, 'timer')) continue;
    seen.add(zone.id);
    const contacts = (Array.isArray(zone.contacts) ? zone.contacts : []).slice(0, 64).filter(c => entity(c?.entityId, 'binary_sensor'))
      .map(c => ({ entityId: c.entityId, name: safeText(c.name, c.entityId), code: slug(c.code) ? c.code : null }));
    result.security.push({ id: zone.id, name: safeText(zone.name, zone.id), enabledEntityId: zone.enabledEntityId,
      exitTimerEntityId: zone.exitTimerEntityId, bypassEntityId: entity(zone.bypassEntityId, 'input_text') && !/pin/i.test(zone.bypassEntityId) ? zone.bypassEntityId : null,
      exitDelaySeconds: Number.isInteger(zone.exitDelaySeconds) && zone.exitDelaySeconds > 0 && zone.exitDelaySeconds <= 3600 ? zone.exitDelaySeconds : 30,
      monitoringAutomationIds: (Array.isArray(zone.monitoringAutomationIds) ? zone.monitoringAutomationIds : []).filter(value => entity(value, 'automation')).slice(0, 8), contacts });
  }
  for (const person of (Array.isArray(raw.people) ? raw.people : []).slice(0, 8)) if (slug(person?.id) && entity(person.entityId, 'person')) {
    result.people.push({ id: person.id, name: safeText(person.name, person.id), entityId: person.entityId });
  }
  for (const zone of (Array.isArray(raw.zones) ? raw.zones : []).slice(0, 32)) if (entity(zone?.entityId, 'zone')) result.zones.push({ entityId: zone.entityId, name: safeText(zone.name, zone.entityId) });
  if (entity(raw.namedayEntityId, 'sensor')) result.namedayEntityId = raw.namedayEntityId;
  if (entity(raw.birthdayCalendarEntityId, 'calendar')) result.birthdayCalendarEntityId = raw.birthdayCalendarEntityId;
  // Household-specific physical macros are not part of the public edition.
  return result;
}

function securityPanel(byId, config, now) {
  return config.security.map(zone => {
    const control = byId.get(zone.enabledEntityId), timer = byId.get(zone.exitTimerEntityId), bypass = byId.get(zone.bypassEntityId);
    const controlKnown = available(control) && ['on', 'off'].includes(control.state);
    const timerKnown = available(timer) && ['idle', 'active', 'paused'].includes(timer.state);
    const monitoringAvailable = zone.monitoringAutomationIds.every(id => available(byId.get(id)) && byId.get(id).state === 'on');
    let status = 'unknown';
    if (controlKnown && timerKnown && monitoringAvailable) {
      if (control.state === 'off' && timer.state === 'idle') status = 'disarmed';
      else if (control.state === 'on' && timer.state === 'active') status = 'arming';
      else if (control.state === 'on' && timer.state === 'idle') status = 'armed';
    }
    const bypassAvailable = Boolean(zone.bypassEntityId && available(bypass));
    const bypassCodes = bypassAvailable ? new Set(bypass.state.split(',').map(value => value.trim()).filter(Boolean)) : null;
    const contacts = zone.contacts.map(contact => {
      const input = byId.get(contact.entityId);
      const known = available(input) && ['on', 'off'].includes(input.state);
      return { entityId: contact.entityId, name: contact.name, state: known ? input.state === 'on' ? 'open' : 'closed' : 'unknown',
        available: known, bypassed: bypassCodes && contact.code ? bypassCodes.has(contact.code) : null };
    });
    const finishesAt = timerKnown && timer.state === 'active' ? iso(timer.attributes?.finishes_at) : null;
    return { id: zone.id, name: zone.name, state: status, available: status !== 'unknown', source: 'ha_custom_zone', monitoringAvailable,
      exitDelaySeconds: zone.exitDelaySeconds, finishesAt, remainingSeconds: finishesAt ? Math.max(0, Math.ceil((Date.parse(finishesAt) - now.getTime()) / 1000)) : null,
      contacts, contactCount: contacts.length, availableContactCount: contacts.filter(c => c.available).length,
      openContactCount: contacts.filter(c => c.state === 'open').length, coverageComplete: contacts.length > 0 && contacts.every(c => c.available),
      bypassAvailable, bypassedContactCount: bypassCodes ? contacts.filter(c => c.bypassed).length : null };
  });
}

function birthdayItems(events, window) {
  const value = input => typeof input === 'string' ? input : input?.dateTime || input?.date;
  const validDay = input => typeof input === 'string' && /^\d{4}-\d\d-\d\d$/.test(input)
    && Number.isFinite(Date.parse(`${input}T00:00:00Z`)) && new Date(`${input}T00:00:00Z`).toISOString().slice(0, 10) === input;
  return events.filter(event => {
    if (!event || event.status === 'cancelled') return false;
    const start = value(event.start), end = value(event.end);
    if (validDay(start) && validDay(end)) return start <= window.localDate && end > window.localDate;
    const from = iso(start), until = iso(end);
    return from && until && Date.parse(until) > Date.parse(from) && Date.parse(from) < Date.parse(window.end) && Date.parse(until) > Date.parse(window.start);
  }).slice(0, 64).map(event => ({ id: `birthday-${createHash('sha256').update(JSON.stringify([event.uid || '', value(event.start), event.summary || '', window.localDate])).digest('hex').slice(0, 20)}`,
    summary: safeText(event.summary, 'Narozeniny', 300), allDay: validDay(value(event.start)) }));
}

export async function readHouseholdPanel(ha, panelConfig, { states, now = new Date() } = {}) {
  if (!Array.isArray(states)) throw new Error('Household panel requires existing states');
  const config = normalizeHouseholdPanel(panelConfig), byId = new Map(states.map(state => [state.entity_id, state]));
  const window = pragueDayWindow(now);
  const security = securityPanel(byId, config, now);
  const people = config.people.map(person => {
    const state = byId.get(person.entityId), known = available(state), position = known ? coordinates(state.attributes) : { latitude: null, longitude: null };
    const accuracy = state?.attributes?.gps_accuracy;
    return { id: person.id, name: person.name, entityId: person.entityId, available: known,
      state: known ? ['home', 'not_home'].includes(state.state) ? state.state : 'zone' : 'unknown',
      zoneName: known && !['home', 'not_home'].includes(state.state) ? safeText(state.state) : null,
      ...position, locationAvailable: position.latitude !== null, gpsAccuracy: known && Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100000 ? accuracy : null,
      lastUpdated: known ? iso(state.last_updated) : null };
  });
  const zones = config.zones.map(zone => {
    const state = byId.get(zone.entityId), known = available(state), position = known ? coordinates(state.attributes) : { latitude: null, longitude: null };
    return { id: zone.entityId.slice(5), entityId: zone.entityId, name: zone.name, available: position.latitude !== null, ...position,
      radius: known && Number.isFinite(state.attributes?.radius) && state.attributes.radius >= 0 ? state.attributes.radius : null };
  });
  const namedayState = byId.get(config.namedayEntityId);
  const namedayAvailable = available(namedayState) && Boolean(namedayState.state.trim());
  const nameday = { available: namedayAvailable, names: namedayAvailable ? [safeText(namedayState.state)] : [], source: config.namedayEntityId, date: window.localDate };
  let birthdaysToday = [], birthdayAvailable = false;
  if (config.birthdayCalendarEntityId && available(byId.get(config.birthdayCalendarEntityId))) {
    try {
      const events = await ha.calendar(config.birthdayCalendarEntityId, window.start, window.end);
      if (Array.isArray(events)) { birthdaysToday = birthdayItems(events, window); birthdayAvailable = true; }
    } catch { /* No fabricated birthday when the calendar cannot be read. */ }
  }
  return { security, people, zones, nameday, birthdaysToday,
    birthdayCalendar: { available: birthdayAvailable, localDate: window.localDate, timeZone: TZ }, night: null };
}
