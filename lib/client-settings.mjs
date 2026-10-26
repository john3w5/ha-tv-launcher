import { createPrivateJsonStore } from './private-json-store.mjs';

const DEFAULTS = { theme: 'auto', background: 'weather', navigationSounds: true, saverMinutes: 5, photoIntervalSeconds: 30 };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function validClientSettingsPatch(value) {
  return plain(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) => {
    if (key === 'theme') return ['auto', 'light', 'dark'].includes(item);
    if (key === 'background') return ['weather', 'plain', 'photos'].includes(item);
    if (key === 'navigationSounds') return typeof item === 'boolean';
    if (key === 'saverMinutes') return Number.isSafeInteger(item) && item >= 0 && item <= 120;
    if (key === 'photoIntervalSeconds') return Number.isSafeInteger(item) && item >= 10 && item <= 3600;
    return false;
  });
}

/** Household display preferences only. No device commands, credentials or app reordering. */
export async function createClientSettings({ storePath, now = Date.now, photoIntervalSeconds = 30 } = {}) {
  let disk = await createPrivateJsonStore(storePath, { maxBytes: 4096 });
  let settings = { ...DEFAULTS, photoIntervalSeconds: Number.isSafeInteger(photoIntervalSeconds) && photoIntervalSeconds >= 10 && photoIntervalSeconds <= 3600 ? photoIntervalSeconds : 30 };
  let revision = 0, updatedAt = null, queue = Promise.resolve();
  let raw;
  try { raw = await disk.read(); }
  catch (error) {
    if (error.code !== 'TV_STATE_INVALID') throw error;
    // Display preferences must not take the TV offline. Preserve a damaged file
    // untouched and make non-persistence visible in the API.
    disk = await createPrivateJsonStore(); raw = null;
  }
  if (raw !== null) {
    if (!plain(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0 ||
      !validClientSettingsPatch(raw.settings) || Object.keys(raw.settings).length !== Object.keys(DEFAULTS).length ||
      typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) disk = await createPrivateJsonStore();
    else { settings = { ...raw.settings }; revision = raw.revision; updatedAt = raw.updatedAt; }
  }
  const get = () => ({ version: 1, revision, updatedAt, settings: { ...settings }, persistent: disk.persistent, scope: 'household' });
  return { get, async update(patch) {
    if (!validClientSettingsPatch(patch)) throw Object.assign(Error('Neplatná změna nastavení obrazovky.'), { status: 400 });
    const operation = queue.then(async () => {
      const next = { ...settings, ...patch };
      if (JSON.stringify(next) === JSON.stringify(settings)) return get();
      const nextRevision = Math.max(revision + 1, now()), time = new Date(now()).toISOString();
      await disk.write({ version: 1, revision: nextRevision, updatedAt: time, settings: next });
      settings = next; revision = nextRevision; updatedAt = time; return get();
    });
    queue = operation.catch(() => {}); return operation;
  } };
}
