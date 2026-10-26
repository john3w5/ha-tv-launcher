import { createHash } from 'node:crypto';

/** A short, non-sliding webhook retry window; distinct explicit event IDs stay independent. */
export function createNotificationRetries({ now = Date.now, windowMs = 10000, maxEntries = 1024 } = {}) {
  const seen = new Map();
  return {
    claim(notice, eventId = null) {
      const time = now();
      for (const [key, entry] of seen) if (entry.expiresAt <= time) seen.delete(key);
      // Store no raw message or caller event ID in the retry cache.
      const key = createHash('sha256').update(JSON.stringify([eventId, notice.title, notice.message, notice.type])).digest('hex');
      const previous = seen.get(key);
      if (previous) return { duplicate: true, id: previous.id };
      seen.set(key, { id: notice.id, expiresAt: time + windowMs });
      while (seen.size > maxEntries) seen.delete(seen.keys().next().value);
      return { duplicate: false, id: notice.id };
    },
    clear() { seen.clear(); },
  };
}
