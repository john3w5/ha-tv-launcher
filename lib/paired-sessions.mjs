import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const DAY = 86400_000;
const HOUR = 3600_000;
const MINUTE = 60000;
const MAX_KINO = 24 * HOUR;
const MAX_ENTRIES = 1024;
const MAX_BYTES = 384 * 1024;
const digest = raw => createHash('sha256').update(raw).digest('hex');
const validCookie = raw => typeof raw === 'string' && /^[A-Za-z0-9_-]{32}$/.test(raw);
const failure = () => new Error('Paired-session storage is unreadable or unsafe.');
const emptyPreferences = () => ({ kinoStartedAt: 0, kinoUntil: 0, snoozedAt: 0, snoozedUntil: 0 });
function activePreferences(raw, time) {
  const result = { ...emptyPreferences(), ...raw };
  for (const [start, until] of [['kinoStartedAt', 'kinoUntil'], ['snoozedAt', 'snoozedUntil']]) {
    if (result[until] <= time || result[start] > time + 5000 || result[until] - time > (start === 'kinoStartedAt' ? MAX_KINO : HOUR) + 5000) { result[start] = 0; result[until] = 0; }
  }
  return result;
}
function validPreferences(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join() !== Object.keys(emptyPreferences()).sort().join()) return false;
  return [['kinoStartedAt', 'kinoUntil'], ['snoozedAt', 'snoozedUntil']].every(([start, until]) => Number.isSafeInteger(raw[start]) && Number.isSafeInteger(raw[until]) && raw[start] >= 0 && raw[until] >= 0
    && ((raw[start] === 0 && raw[until] === 0) || (start === 'kinoStartedAt'
      ? raw[until] - raw[start] >= MINUTE && raw[until] - raw[start] <= MAX_KINO && (raw[until] - raw[start]) % MINUTE === 0
      : raw[until] - raw[start] === HOUR)));
}

async function checkedParent(filename) {
  const parent = path.dirname(filename);
  const parsed = path.parse(parent);
  let current = parsed.root;
  for (const part of parent.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
  }
  const info = await lstat(parent);
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw failure();
  return parent;
}

async function checkedFile(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid()) || info.size > MAX_BYTES) throw failure();
    return info;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Stores only SHA-256 digests of random 192-bit cookies. Persistence is opt-in. */
export async function createPairedSessions({ storePath, ttlDays = 30, now = Date.now } = {}) {
  const configuredDays = ttlDays === '' || ttlDays === null ? 30 : Number(ttlDays);
  const days = Math.max(1, Math.min(90, Number.isFinite(configuredDays) ? configuredDays : 30));
  const ttlSeconds = Math.floor(days * DAY / 1000);
  const filename = storePath ? path.resolve(storePath) : null;
  let entries = new Map();
  let queue = Promise.resolve();
  let unhealthy = false;

  async function persist(next) {
    if (!filename) return;
    const parent = await checkedParent(filename);
    await checkedFile(filename);
    const temporary = path.join(parent, `.paired-sessions-${randomBytes(12).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, sessions: [...next].map(([hash, entry]) => ({ hash, ...entry })) }) + '\n');
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temporary, filename);
    } finally {
      await handle?.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function commit(update) {
    const pending = queue.then(async () => {
      if (unhealthy) throw failure();
      const next = new Map(entries);
      const changed = update(next);
      if (!changed) return;
      try { await persist(next); entries = next; }
      catch { unhealthy = true; entries.clear(); throw failure(); }
    });
    queue = pending.catch(() => {});
    return pending;
  }

  if (filename) {
    try {
      await checkedParent(filename);
      if (await checkedFile(filename)) {
        const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        let parsed;
        try { parsed = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
        if (parsed?.version !== 1 || !Array.isArray(parsed.sessions) || parsed.sessions.length > MAX_ENTRIES) throw failure();
        const time = now();
        for (const entry of parsed.sessions) {
          if (!entry || typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) ||
            !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0 || entry.expiresAt > time + 90 * DAY || entries.has(entry.hash)) throw failure();
          if (entry.notificationPreferences !== undefined && !validPreferences(entry.notificationPreferences)) throw failure();
          entries.set(entry.hash, { expiresAt: entry.expiresAt, ...(entry.notificationPreferences ? { notificationPreferences: entry.notificationPreferences } : {}) });
        }
      }
    } catch { throw failure(); }
  }

  const store = {
    ttlSeconds,
    get size() { return entries.size; },
    has(raw) { return !unhealthy && validCookie(raw) && (entries.get(digest(raw))?.expiresAt || 0) > now(); },
    async add(raw) {
      if (!validCookie(raw)) throw failure();
      return commit(next => {
        if (next.size >= MAX_ENTRIES) throw failure();
        next.set(digest(raw), { expiresAt: now() + ttlSeconds * 1000 }); return true;
      });
    },
    async revoke(raw) { if (validCookie(raw)) return commit(next => next.delete(digest(raw))); },
    async prune() { return commit(next => {
      let changed = false; const time = now();
      for (const [key, entry] of next) {
        if (entry.expiresAt <= time) { next.delete(key); changed = true; }
        else if (entry.notificationPreferences) {
          const current = activePreferences(entry.notificationPreferences, time);
          if (JSON.stringify(current) !== JSON.stringify(entry.notificationPreferences)) { next.set(key, { ...entry, notificationPreferences: current }); changed = true; }
        }
      }
      return changed;
    }); },
    notificationPreferences(raw) {
      const time = now(), preferences = activePreferences(validCookie(raw) ? entries.get(digest(raw))?.notificationPreferences : null, time);
      const kino = store.has(raw) && preferences.kinoUntil > time, snoozed = store.has(raw) && preferences.snoozedUntil > time;
      const remainingMs = Math.max(0, (kino ? preferences.kinoUntil : 0) - time, (snoozed ? preferences.snoozedUntil : 0) - time);
      return { enabled: true, kino, kinoEnabled: kino, kinoStartedAt: kino ? preferences.kinoStartedAt : 0,
        kinoDurationMinutes: kino ? (preferences.kinoUntil - preferences.kinoStartedAt) / MINUTE : 0,
        kinoUntil: kino ? preferences.kinoUntil : 0, snoozed, snoozedUntil: snoozed ? preferences.snoozedUntil : 0,
        active: kino || snoozed, remainingMs, remainingMinutes: Math.ceil(remainingMs / 60000), persistent: Boolean(filename), scope: 'session' };
    },
    async setNotificationPreferences(raw, { action, enabled, minutes } = {}) {
      if (!validCookie(raw) || !['kino', 'snooze', 'resume'].includes(action) || (action === 'kino' && typeof enabled !== 'boolean') ||
        (minutes !== undefined && (action !== 'kino' || !enabled || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440))) throw failure();
      await commit(next => {
        const key = digest(raw), entry = next.get(key), time = now();
        if (!entry || entry.expiresAt <= time) throw failure();
        const preferences = activePreferences(entry.notificationPreferences, time);
        if (action === 'resume') Object.assign(preferences, emptyPreferences());
        else if (action === 'kino') {
          if (!enabled) { preferences.kinoStartedAt = 0; preferences.kinoUntil = 0; }
          else if (!preferences.kinoUntil || (minutes !== undefined && preferences.kinoUntil - preferences.kinoStartedAt !== minutes * MINUTE)) {
            preferences.kinoStartedAt = time; preferences.kinoUntil = time + (minutes ?? 60) * MINUTE;
          }
        } else if (!preferences.snoozedUntil) { preferences.snoozedAt = time; preferences.snoozedUntil = time + HOUR; }
        if (JSON.stringify(preferences) === JSON.stringify(entry.notificationPreferences || emptyPreferences())) return false;
        next.set(key, { ...entry, notificationPreferences: preferences }); return true;
      });
      return store.notificationPreferences(raw);
    },
    allowsNotification(raw, notice) {
      if (!store.has(raw)) return false;
      if (!store.notificationPreferences(raw).active) return true;
      return notice?.type === 'urgent' || (notice?.source === 'home_assistant' && ['house-washer-leak', 'house-washer-finished'].includes(notice.id));
    },
  };
  await store.prune();
  return store;
}
