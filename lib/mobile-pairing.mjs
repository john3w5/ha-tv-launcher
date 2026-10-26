import { createHash, randomInt } from 'node:crypto';

const digest = input => createHash('sha256').update(input).digest('hex');
const validSession = input => typeof input === 'string' && /^[A-Za-z0-9_-]{32}$/.test(input);

/** One short enrollment code per paired owner; memory only, single-use, 60 s. */
export function createMobilePairing({ isPaired, now = Date.now, maximum = 128, reservedCode = '' } = {}) {
  const owners = new Map(), codes = new Map();
  const remove = owner => {
    const entry = owners.get(owner);
    if (entry) codes.delete(entry.codeHash);
    owners.delete(owner);
  };
  const prune = () => {
    const time = now();
    for (const [owner, entry] of owners) if (entry.expiresAt <= time || !isPaired(entry.session)) remove(owner);
  };
  return {
    prune,
    revoke(session) { if (validSession(session)) remove(digest(session)); },
    issue(session) {
      prune();
      if (!validSession(session) || !isPaired(session)) throw Object.assign(Error('Nejprve spárujte tuto obrazovku.'), { status: 401 });
      const owner = digest(session);
      if (!owners.has(owner) && owners.size >= maximum) throw Object.assign(Error('Párování telefonu je dočasně vytížené.'), { status: 503 });
      let code;
      for (let attempt = 0; attempt < 16; attempt++) {
        const candidate = String(randomInt(100000000)).padStart(8, '0');
        if (candidate !== reservedCode && !codes.has(digest(candidate))) { code = candidate; break; }
      }
      if (!code) throw Object.assign(Error('Párování telefonu je dočasně vytížené.'), { status: 503 });
      remove(owner);
      const entry = { codeHash: digest(code), expiresAt: now() + 60000, session };
      owners.set(owner, entry); codes.set(entry.codeHash, owner);
      return { code, expiresAt: new Date(entry.expiresAt).toISOString(), url: '/manage.html' };
    },
    consume(code) {
      prune();
      if (typeof code !== 'string' || !/^\d{8}$/.test(code)) return false;
      const owner = codes.get(digest(code));
      if (!owner) return false;
      remove(owner); // Consume synchronously before any session-store I/O.
      return true;
    },
  };
}
