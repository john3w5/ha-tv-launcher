import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class HlsProxyError extends Error {
  constructor(code, status, message) { super(message); this.name = 'HlsProxyError'; this.code = code; this.status = status; }
}
const invalid = () => new HlsProxyError('hls_playlist_invalid', 502, 'Neplatný playlist.');
export function cancelHlsResponse(response) { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* A pipeline may already own the body. */ } }

/** One deadline spans headers, playlist reads and media forwarding. */
export function createHlsRequest(req, res, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController(); let disconnected = false;
  const onDisconnect = () => {
    if (res.writableEnded) return;
    disconnected = true;
    controller.abort(Object.assign(new Error('Stream client disconnected'), { name: 'AbortError' }));
  };
  req.once('aborted', onDisconnect); res.once('close', onDisconnect);
  const timer = setTimeout(() => controller.abort(new HlsProxyError('hls_timeout', 504, 'Načtení streamu trvá příliš dlouho.')), timeoutMs);
  timer.unref?.();
  if (req.aborted || res.destroyed) onDisconnect();
  return { signal: controller.signal, get disconnected() { return disconnected; },
    abort: () => controller.abort(),
    dispose() { clearTimeout(timer); req.removeListener('aborted', onDisconnect); res.removeListener('close', onDisconnect); } };
}

/** Count encoded bytes before concatenating or decoding, including chunked bodies. */
export async function readHlsPlaylist(response, { signal, maxBytes = 1024 * 1024 } = {}) {
  if (!response?.body) throw invalid();
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { cancelHlsResponse(response); throw invalid(); }
  const reader = response.body.getReader();
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Already closed. */ } };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    let size = 0; const chunks = [];
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) break;
      if (!(value instanceof Uint8Array)) throw invalid();
      size += value.byteLength;
      if (size > maxBytes) throw invalid();
      chunks.push(value);
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)); } catch { throw invalid(); }
    if (!text.trimStart().startsWith('#EXTM3U')) throw invalid();
    return text;
  } finally { signal?.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}

export async function pipeHlsMedia(response, destination, { signal } = {}) {
  if (!response?.body) throw new HlsProxyError('hls_media_empty', 502, 'Část streamu není dostupná.');
  await pipeline(Readable.fromWeb(response.body), destination, { signal });
}

/** Opaque resource URLs have a bounded sliding lifetime and LRU window.
 * Eviction makes an old ID unavailable; it never redirects that ID to a new URL. */
export function createHlsResources({ allow, now = Date.now, ttlMs = 120000, maxEntries = 256 } = {}) {
  if (typeof allow !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 ||
      !Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new TypeError('Invalid HLS resource options');
  const entries = new Map(), byUrl = new Map(); let sequence = 0;
  const drop = id => { const entry = entries.get(id); if (entry) { entries.delete(id); if (byUrl.get(entry.url) === id) byUrl.delete(entry.url); } };
  const prune = () => { const time = now(); for (const [id, entry] of entries) if (time < entry.touched || time - entry.touched >= ttlMs) drop(id); };
  const touch = (id, entry) => { entries.delete(id); entry.touched = now(); entries.set(id, entry); };
  return {
    register(value, { pinned = false } = {}) {
      let url;
      try { url = new URL(value); } catch { throw new HlsProxyError('hls_resource_invalid', 502, 'Nepovolený zdroj streamu.'); }
      if (url.href.length > 8192 || !allow(url)) throw new HlsProxyError('hls_resource_invalid', 502, 'Nepovolený zdroj streamu.');
      prune();
      const existing = byUrl.get(url.href);
      if (existing) { const entry = entries.get(existing); entry.pinned ||= pinned; touch(existing, entry); return existing; }
      while (entries.size >= maxEntries) {
        const oldest = [...entries].find(([, entry]) => !entry.pinned)?.[0];
        if (!oldest) throw new HlsProxyError('hls_resource_limit', 502, 'Stream překročil limit.');
        drop(oldest);
      }
      if (sequence >= Number.MAX_SAFE_INTEGER) throw new HlsProxyError('hls_resource_limit', 502, 'Stream překročil limit.');
      const id = `${(++sequence).toString(36)}_${randomBytes(24).toString('base64url')}`;
      entries.set(id, { url: url.href, touched: now(), pinned }); byUrl.set(url.href, id); return id;
    },
    get(id) {
      if (typeof id !== 'string' || id.length > 128) return null;
      prune(); const entry = entries.get(id);
      if (!entry) return null;
      touch(id, entry); return entry.url;
    },
    get size() { prune(); return entries.size; },
  };
}
