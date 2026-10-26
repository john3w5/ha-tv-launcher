import { createHash, randomBytes } from 'node:crypto';
import { createPrivateJsonStore } from './private-json-store.mjs';

const DAY = 86400000, RETENTION = 30 * DAY, LIMIT = 256, SEEN_LIMIT = 1024;
const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
const hash = input => createHash('sha256').update(input).digest('hex');
const validId = input => typeof input === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(input);
const types = ['info', 'success', 'warning', 'urgent'];

/** Bounded event summaries only; never stores HA state attributes, GPS, tokens or media URLs. */
export async function createHouseTimeline({ storePath, now = Date.now } = {}) {
  let disk = await createPrivateJsonStore(storePath);
  let events = [], seen = new Map(), queue = Promise.resolve(), healthy = true, dirty = false, writing = false;
  let raw;
  try { raw = await disk.read(); }
  catch (error) {
    if (error.code !== 'TV_STATE_INVALID') throw error;
    disk = await createPrivateJsonStore(); raw = null;
  }
  if (raw !== null) try {
    if (raw.version !== 1 || !Array.isArray(raw.events) || raw.events.length > LIMIT || !Array.isArray(raw.seen) || raw.seen.length > SEEN_LIMIT) throw Error('Historie domácnosti je neplatná.');
    events = raw.events.map(event => {
      if (!event || !/^[a-f0-9]{24}$/.test(event.id || '') || !['notification', 'doorbell'].includes(event.kind) ||
        !['home_assistant', 'local'].includes(event.source) || !types.includes(event.type) || typeof event.title !== 'string' || event.title.length > 120 ||
        typeof event.message !== 'string' || event.message.length > 1000 || !Number.isFinite(Date.parse(event.occurredAt))) throw Error('Historie domácnosti je neplatná.');
      return { id: event.id, kind: event.kind, title: event.title, message: event.message, type: event.type, source: event.source, occurredAt: event.occurredAt };
    }).filter(event => Date.parse(event.occurredAt) > now() - RETENTION && Date.parse(event.occurredAt) <= now() + 5000);
    for (const entry of raw.seen) {
      if (!entry || !/^[a-f0-9]{64}$/.test(entry.key || '') || !/^[a-f0-9]{64}$/.test(entry.fingerprint || '') || !Number.isSafeInteger(entry.at)) throw Error('Historie domácnosti je neplatná.');
      if (entry.at > now() - RETENTION && entry.at <= now() + 5000) seen.set(entry.key, { fingerprint: entry.fingerprint, at: entry.at });
    }
  } catch {
    // A damaged optional history cannot prevent the TV from starting. Never
    // overwrite it; continue in memory and report persistent:false instead.
    events = []; seen.clear(); disk = await createPrivateJsonStore();
  }
  function persist() {
    dirty = true;
    if (writing) return;
    writing = true;
    // At most one pending disk write; bursts coalesce into the latest bounded state.
    queue = (async () => {
      while (dirty) {
        dirty = false;
        await disk.write({ version: 1, events: [...events], seen: [...seen].map(([key, value]) => ({ key, ...value })) });
      }
    })().catch(() => { healthy = false; }).finally(() => { writing = false; if (dirty) persist(); });
  }
  function record(kind, notice) {
    if (!['notification', 'doorbell'].includes(kind) || !notice || typeof notice.message !== 'string' || !notice.message.trim()) return true;
    const time = now(), title = clean(notice.title || 'Domov', 120), message = clean(notice.message, 1000), type = types.includes(notice.type) ? notice.type : 'info';
    // Stable HA reminders stay quiet across reconnects/restarts until removed or
    // their visible content changes. Real house transitions carry occurredAt.
    const persistent = /^ha-[a-f0-9]{24}$/.test(notice.id || '');
    const eventKey = validId(notice.eventId) ? `event:${notice.eventId}` : persistent ? `ha:${notice.id}`
      : `content:${kind}:${title}:${message}:${type}`;
    const key = hash(eventKey), fingerprint = hash(JSON.stringify([title, message, type]));
    const previous = seen.get(key), quiet = persistent || validId(notice.eventId) ? RETENTION : 10000;
    if (previous?.fingerprint === fingerprint && time - previous.at < quiet) return false;
    for (const [id, entry] of seen) if (entry.at <= time - RETENTION) seen.delete(id);
    seen.delete(key); seen.set(key, { fingerprint, at: time });
    while (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value);
    const suppliedTime = typeof notice.occurredAt === 'string' ? Date.parse(notice.occurredAt) : NaN;
    const occurredAt = new Date(Number.isFinite(suppliedTime) && Math.abs(time - suppliedTime) < 30000 ? suppliedTime : time).toISOString();
    events = [{ id: randomBytes(12).toString('hex'), kind, title, message, type, source: notice.source === 'home_assistant' ? 'home_assistant' : 'local', occurredAt },
      ...events.filter(event => Date.parse(event.occurredAt) > time - RETENTION)].slice(0, LIMIT);
    persist(); return true;
  }
  return { record, remove(notice) {
    if (typeof notice?.id !== 'string' || !/^ha-[a-f0-9]{24}$/.test(notice.id)) return;
    if (seen.delete(hash(`ha:${notice.id}`))) persist();
  }, get(limit = 50) {
    return { events: events.filter(event => Date.parse(event.occurredAt) > now() - RETENTION).slice(0, Math.max(1, Math.min(100, limit))).map(event => ({ ...event })), persistent: disk.persistent && healthy };
  }, flush: async () => { do { await queue; } while (writing || dirty); } };
}
