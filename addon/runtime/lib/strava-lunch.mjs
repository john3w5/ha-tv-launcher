// Lunch pickup from Strava.cz, read the way the app.strava.cz web does it after a
// parent-account (e-mail) login. Strava.cz has no public API; only reading
// endpoints are used, never ordering.

const ORIGIN = 'https://app.strava.cz';
const SERVED = { 1: 'Vydáno', 3: 'Vydáno ručně', 11: 'Vydáno na jméno', 2: 'Náhradní stravenka', 9: 'Náhradní stravenka Box', 28: 'Elektronická stravenka' };
const ZONE = 'Europe/Prague';

const text = (value, max = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

function isoDate(value) {
  const raw = text(value, 40);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(raw);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

export function normalizeMeal(item) {
  const date = isoDate(item?.datum);
  if (!date) return null;
  const code = Number(item.vydano);
  const time = /^\d{1,2}:\d{2}/.exec(text(item.cas, 20))?.[0] ?? null;
  return { date, time: time ? time.padStart(5, '0') : null, kind: text(item.druh, 40), name: text(item.nazev, 200),
    served: code in SERVED ? true : code === 0 ? false : null, label: SERVED[code] ?? (code === 0 ? 'Nevydáno' : null) };
}

const mealList = value => Array.isArray(value) ? value : Object.values(value || {}).find(Array.isArray) || [];
const firstName = value => text(value, 120).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Pickup is wanted once a day: on start, then after 17:00 Prague time each day. */
export function due(lastDay, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  return { today, due: !lastDay || (lastDay !== today && Number(parts.hour) >= 17) };
}

export function createStravaLunch({ email, password, fetch = globalThis.fetch, origin = ORIGIN, log = console, now = () => new Date() }) {
  let state = { available: false, updatedAt: null, accounts: [] }, timer = null, stopped = false, lastDay = null;
  async function call(path, body) {
    const response = await fetch(origin + path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!response.ok && response.status !== 555) throw new Error(`${path} HTTP ${response.status}`);
    const value = await response.json();
    if (value?.state === 'error') throw new Error(`${path} ${value.number ?? ''}`.trim());
    return value;
  }
  async function refresh() {
    const login = await call('/api/loginPA', { email, heslo: password, zustatPrihlasen: false, lang: 'CZ' });
    const canteens = await call('/api/jidelnyPA', { sid: login.SID, lang: 'CZ', getBeta: true });
    const accounts = [];
    for (const canteen of (canteens.jidelny || []).slice(0, 8)) {
      const cislo = canteen.IDJidelny, id = canteen.IDUcetJidelny;
      const session = await call('/api/canteenLoginPA', { sid: login.SID, cislo, id, environment: 'W', lang: 'CZ' });
      const sid = typeof session === 'string' ? session : session?.sid ?? session?.SID;
      const items = await call('/api/s4Polozky', { cislo, lang: 'CZ', polozky: 'VERZE,URLWSDL_S-URL,UR_OTVIRAK,IGN_CERT' });
      const s5url = items.urlwsdl_s?.[0], ignoreCert = items.ign_cert?.[0] === 'A';
      await call('/api/nactiVlastnostiPA', { sid, url: s5url, cislo, lang: 'CZ', ignoreCert, getText: true, checkVersion: true, frontendFunction: 'loginCanteenUsingPA' });
      const pickup = await call('/api/vydej', { cislo, s5url, sid, ignoreCert, lang: 'CZ' });
      const list = mealList(pickup);
      if (!list.length) log.info?.(`Strava.cz: účet ${accounts.length + 1} má výdej bez položek (${Array.isArray(pickup) ? 'prázdný seznam' : `klíče: ${Object.keys(pickup || {}).slice(0, 12).join(', ')}`}).`);
      accounts.push({ name: text(canteen.PopisUctuJidelny, 120), meals: list.map(normalizeMeal).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20) });
    }
    log.info?.(`Strava.cz: načteno ${accounts.length} účtů, položek výdeje: ${accounts.map(item => item.meals.length).join(', ') || '0'}.`);
    return accounts;
  }
  async function tick() {
    if (stopped) return;
    const check = due(lastDay, now());
    if (check.due) {
      try {
        state = { available: true, updatedAt: now().toISOString(), accounts: await refresh() };
        lastDay = check.today;
      } catch (error) {
        state = { ...state, available: false };
        log.warn?.(`Strava.cz: výdej obědů se nepodařilo načíst (${error.message}).`);
      }
    }
    // Checked hourly; a failed attempt is retried the next hour.
    if (!stopped) { timer = setTimeout(tick, 60 * 60000); timer.unref?.(); }
  }
  return {
    start() { if (!timer) tick(); return this; },
    stop() { stopped = true; clearTimeout(timer); },
    refresh: tick,
    /** Meals of one child, matched by the start of the account description. */
    snapshot(names = []) {
      return { available: state.available, updatedAt: state.updatedAt, children: names.map(name => {
        const key = firstName(name);
        const account = state.accounts.find(item => key && firstName(item.name).startsWith(key));
        return { name, matched: Boolean(account), meals: account?.meals ?? [] };
      }) };
    },
  };
}
