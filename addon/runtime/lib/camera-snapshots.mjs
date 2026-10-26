const MiB = 1024 * 1024;

export class CameraSnapshotError extends Error {
  constructor(code, status, message) { super(message); this.name = 'CameraSnapshotError'; this.code = code; this.status = status; }
}
const failure = () => new CameraSnapshotError('snapshot_unavailable', 502, 'Snímek kamery není dostupný.');
const aborted = () => Object.assign(new Error('Snapshot request was cancelled'), { name: 'AbortError' });
const invalidImage = () => new CameraSnapshotError('snapshot_invalid', 502, 'Kamera nevrátila podporovaný snímek.');
const tooLarge = () => new CameraSnapshotError('snapshot_too_large', 502, 'Snímek kamery překročil povolenou velikost.');
const cancelBody = body => { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Best effort after a rejected response. */ } };

function matchesType(bytes, type) {
  if (type === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (type === 'image/png') return bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
  return type === 'image/webp' && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) + 8 === bytes.length && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16));
}

async function readImage(response, { signal, maxBytes }) {
  if (signal.aborted) { cancelBody(response?.body); throw signal.reason; }
  const contentType = String(response?.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!response?.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType) || !response.body) {
    cancelBody(response?.body); throw invalidImage();
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { cancelBody(response.body); throw tooLarge(); }
  const reader = response.body.getReader();
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Already released. */ } };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const chunks = []; let length = 0;
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      if (!(value instanceof Uint8Array)) throw invalidImage();
      length += value.byteLength;
      if (length > maxBytes) throw tooLarge();
      chunks.push(value);
    }
    const data = Buffer.concat(chunks, length);
    if (!matchesType(data, contentType)) throw invalidImage();
    return { data, contentType };
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Per-bridge memory-only cache. No shared secrets, disk images or device actions.
 * A disconnected waiter does not cancel another screen's snapshot request. */
export function createCameraSnapshots({ load, now = Date.now, ttlMs = 750, timeoutMs = 10000,
  maxBytes = 8 * MiB, maxTotalBytes = 16 * MiB, maxEntries = 16, maxActive = 4, maxWaiters = 32,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (typeof load !== 'function' || typeof now !== 'function' ||
    ![ttlMs, timeoutMs, maxBytes, maxTotalBytes, maxEntries, maxActive, maxWaiters].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Invalid snapshot cache options');
  const ready = new Map(), pending = new Map();
  let bytes = 0, closed = false;
  const drop = key => { const entry = ready.get(key); if (entry) { bytes -= entry.image.data.length; ready.delete(key); } };
  const prune = () => {
    const time = now();
    for (const [key, entry] of ready) if (time < entry.created || time - entry.created >= ttlMs) drop(key);
  };
  const remember = (key, image) => {
    if (image.data.length > maxTotalBytes) return;
    prune(); drop(key);
    while (ready.size >= maxEntries || bytes + image.data.length > maxTotalBytes) drop(ready.keys().next().value);
    ready.set(key, { image, created: now() }); bytes += image.data.length;
  };
  const settle = (entry, error, image) => {
    if (entry.done) return;
    entry.done = true;
    clearTimeoutImpl(entry.timer);
    if (pending.get(entry.key) === entry) pending.delete(entry.key);
    if (!error && !closed && !entry.controller.signal.aborted) remember(entry.key, image);
    for (const waiter of entry.waiters) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      error ? waiter.reject(error) : waiter.resolve(image);
    }
    entry.waiters.clear();
  };
  const run = async entry => {
    if (entry.done) return;
    const signal = entry.controller.signal;
    let rejectAbort;
    const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(signal.reason || aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    entry.timer = setTimeoutImpl(() => entry.controller.abort(new CameraSnapshotError('snapshot_timeout', 504, 'Načtení snímku trvá příliš dlouho.')), timeoutMs);
    entry.timer?.unref?.();
    try {
      const operation = Promise.resolve().then(() => {
        if (signal.aborted) throw signal.reason;
        return load(entry.key, { signal });
      }).then(response => readImage(response, { signal, maxBytes }));
      const image = await Promise.race([operation, interrupted]);
      settle(entry, null, image);
    } catch (error) {
      // Never forward upstream response bodies, URLs or errors to a screen.
      settle(entry, error instanceof CameraSnapshotError || error?.name === 'AbortError' ? error : failure());
    } finally {
      clearTimeoutImpl(entry.timer);
      signal.removeEventListener('abort', onAbort);
    }
  };
  return {
    get(key, { signal } = {}) {
      if (typeof key !== 'string' || !/^camera\.[a-z0-9_]+$/.test(key)) return Promise.reject(new CameraSnapshotError('snapshot_entity', 400, 'Neplatná kamera.'));
      if (closed) return Promise.reject(new CameraSnapshotError('snapshot_closed', 503, 'Načítání snímků je ukončeno.'));
      if (signal?.aborted) return Promise.reject(aborted());
      prune();
      if (ready.has(key)) {
        const entry = ready.get(key); ready.delete(key); ready.set(key, entry);
        return Promise.resolve(entry.image);
      }
      let entry = pending.get(key);
      if (!entry) {
        if (pending.size >= maxActive) return Promise.reject(new CameraSnapshotError('snapshot_busy', 503, 'Kamery jsou právě vytížené. Zkuste to znovu.'));
        entry = { key, controller: new AbortController(), waiters: new Set(), timer: undefined, done: false };
        pending.set(key, entry);
        queueMicrotask(() => { void run(entry); });
      }
      if (entry.waiters.size >= maxWaiters) return Promise.reject(new CameraSnapshotError('snapshot_busy', 503, 'Kamery jsou právě vytížené. Zkuste to znovu.'));
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, onAbort: null };
        waiter.onAbort = () => {
          entry.waiters.delete(waiter);
          signal?.removeEventListener('abort', waiter.onAbort);
          reject(aborted());
          if (!entry.waiters.size && !entry.done) { entry.controller.abort(aborted()); settle(entry, aborted()); }
        };
        entry.waiters.add(waiter);
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
      });
    },
    getStats() { prune(); return { active: pending.size, entries: ready.size, bytes, waiters: [...pending.values()].reduce((count, entry) => count + entry.waiters.size, 0) }; },
    close() {
      if (closed) return;
      closed = true;
      const error = new CameraSnapshotError('snapshot_closed', 503, 'Načítání snímků je ukončeno.');
      for (const entry of [...pending.values()]) { entry.controller.abort(error); settle(entry, error); }
      ready.clear(); bytes = 0;
    },
  };
}
