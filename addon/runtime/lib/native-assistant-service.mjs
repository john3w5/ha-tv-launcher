import { createHash, randomBytes } from 'node:crypto';
import { resolvePrimaContent } from './prima-content.mjs';

const APPS = new Map([
  ['netflix', 'com.netflix.ninja'], ['oneplay', 'net.cme.voyo.cz.tvapp'], ['voyo', 'net.cme.voyo.cz.tvapp'],
  ['iprima', 'cz.prima.tvapp'], ['prima', 'cz.prima.tvapp'], ['prima plus', 'cz.prima.tvapp'],
  ['youtube', 'com.google.android.youtube.tv'], ['spotify', 'com.spotify.tv.android'], ['vlc', 'org.videolan.vlc'],
  ['youtube music', 'com.google.android.youtube.tvmusic'], ['youtube kids', 'com.google.android.youtube.tvkids'],
  ['centrum medii', 'com.tcl.ui_mediaCenter'], ['prohlizec', 'com.tcl.browser'], ['galerie', 'com.tcl.gallery'],
  ['button mapper', 'flar2.homebutton'],
  ['smarttube', 'com.liskovsoft.smarttubetv.beta'], ['smart tube', 'com.liskovsoft.smarttubetv.beta'],
]);
const PACKAGES = new Set(APPS.values());
const norm = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[+]/g, ' plus ').replace(/[.,!?;:]+$/g, '').replace(/\s+/g, ' ').trim();
const text = (value, max = 2000) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
const digest = value => createHash('sha256').update(value).digest('hex');
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('cs-CZ', { maximumFractionDigits: 1 }) : null;
const stateName = state => ({ locked: 'zamčeno', unlocked: 'odemčeno', on: 'zapnuto', off: 'vypnuto', armed: 'zajištěno', disarmed: 'odjištěno', arming: 'probíhá odchod', docked: 'v doku', cleaning: 'uklízí', paused: 'pozastaveno', returning: 'vrací se do doku' })[state] || 'stav není ověřený';
class NativeAssistantError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}
const fail = () => { throw new NativeAssistantError('confirmation_invalid', 409, 'Potvrzení není platné, vypršelo nebo již bylo použité.'); };
export const validPrimaEpisodeUrl = value => {
  if (typeof value !== 'string' || value.length > 1000 || !/^https:\/\/www\.iprima\.cz\/serialy\/zradci\/[a-z0-9-]+\/[a-z0-9-]+$/.test(value)) return false;
  try { const url = new URL(value); return url.href === value && !url.username && !url.password && !url.port && !url.search && !url.hash; } catch { return false; }
};
async function resolveBoundedPrima(input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  timer.unref?.();
  try {
    return await resolvePrimaContent(input, { fetchImpl: (url, options = {}) => fetch(url, {
      ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
    }) });
  } finally { clearTimeout(timer); }
}

function statusReply(query, data) {
  const weather = data.weather || {}, domestic = data.domestic || {}, home = data.home || {}, household = data.household || {};
  const measure = (value, unit) => number(value) === null ? 'údaj není dostupný' : `${number(value)} ${unit}`;
  if (/pocasi|venku|prsi|meteostanice|vitr/.test(query)) return `Venku ${measure(weather.temperature, weather.units?.temperature || '°C')}. Vlhkost ${measure(weather.humidity, '%')}, vítr ${measure(weather.windSpeed, weather.units?.windSpeed || 'km/h')}, tlak ${measure(weather.pressure, weather.units?.pressure || 'hPa')}.`;
  if (/studn|nadrz/.test(query)) return `Hloubka ve studni ${measure(domestic.water?.wellDepth?.value, domestic.water?.wellDepth?.unit || 'm')}, hladina ${measure(domestic.water?.wellLevel?.value, '%')}. Hloubka v nádrži ${measure(domestic.water?.tankDepth?.value, domestic.water?.tankDepth?.unit || 'm')}.`;
  if (/kde (?:je|jsou)|poloha/.test(query)) return (household.people || []).map(person => `${person.name}: ${person.available ? person.state === 'home' ? 'doma' : person.state === 'zone' ? text(person.zoneName, 100) : 'mimo domov' : 'poloha není dostupná'}`).join('. ') || 'Polohy nejsou dostupné.';
  if (/zabezpec|alarm/.test(query)) return (household.security || []).map(zone => `${zone.name}: ${stateName(zone.state)}${zone.coverageComplete === false ? ', některý kontakt není dostupný' : ''}`).join('. ') || 'Zabezpečení není dostupné.';
  if (/zamcen|zamknut|dvere|zamek/.test(query)) return (home.locks || []).map(lock => `${lock.name}: ${stateName(lock.state)}`).join('. ') || 'Stavy zámků nejsou dostupné.';
  if (/sviti|svetla|svetlo/.test(query)) {
    const lights = (home.lights || []).filter(light => light.role !== 'controller-status');
    const active = lights.filter(light => light.state === 'on');
    const unknown = lights.filter(light => !['on', 'off'].includes(light.state));
    return `${active.length ? `Svítí: ${active.slice(0, 8).map(light => light.name).join(', ')}.` : 'Z dostupných světel nyní žádné nesvítí.'}${unknown.length ? ` U ${unknown.length} světel není stav dostupný.` : ''}`;
  }
  if (/prack|pere|prani/.test(query)) return domestic.washer?.available ? `Pračka ${domestic.washer.running ? 'právě pere' : 'právě neběží'}. Příkon ${measure(domestic.washer.power?.value, domestic.washer.power?.unit || 'W')}.` : 'Stav pračky není dostupný.';
  if (/vysav|robot|uklid/.test(query)) return domestic.vacuum?.available ? `Vysavač: ${stateName(domestic.vacuum.state)}. Baterie ${measure(domestic.vacuum.batteryPercent, '%')}.` : 'Stav vysavače není dostupný.';
  if (/kalend|udalost|program|dnes/.test(query)) {
    const events = (data.calendars || []).flatMap(calendar => calendar.events || []).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 3);
    return events.length ? events.map(event => `${new Date(event.start).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric' })}: ${text(event.summary, 180)}`).join('. ') : 'V načteném kalendáři nejsou další události.';
  }
  if (/teplot|teplo|lozn|obyvak|koupeln|detsk/.test(query)) {
    const rooms = (domestic.rooms || []), selected = rooms.filter(room => norm(room.name).split(' ').some(word => word.length > 4 && query.includes(word.slice(0, 5))));
    return (selected.length ? selected : rooms).map(room => `${room.name}: ${room.available ? measure(room.currentTemperature, room.unit || '°C') : 'teplota není dostupná'}`).join('. ') || 'Teploty místností nejsou dostupné.';
  }
  if (/stav domu|jak je doma|spotreb|prikon|energie/.test(query)) return `Příkon domu ${measure(domestic.energy?.powerW, 'W')}. Dnešní spotřeba ${measure(domestic.energy?.todayKWh, 'kWh')}.`;
  return null;
}

/** HA status answers and explicit, one-use native/HA commands. No ADB or CLI. */
export function createNativeAssistantService({ ha, readStatus, resolvePrima = resolveBoundedPrima, now = Date.now } = {}) {
  const pending = new Map();
  let catalogBusy = false;
  const provider = 'ha-native';
  const owner = session => { if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(session)) throw new NativeAssistantError('session_required', 401, 'Nejprve spárujte tuto obrazovku.'); return digest(session); };
  const prune = () => { for (const [id, item] of pending) if (item.expires <= now()) pending.delete(id); };
  function prepare(session, reply, action) {
    const ownerHash = owner(session); prune();
    for (const [id, item] of pending) if (item.ownerHash === ownerHash) pending.delete(id);
    if (pending.size >= 64) throw new NativeAssistantError('busy', 429, 'Dokončete předchozí potvrzení.');
    const confirmationId = randomBytes(24).toString('base64url'), expires = now() + 20000;
    pending.set(confirmationId, { ownerHash, action, expires });
    return { status: 'confirmation', reply, confirmationId, expiresAt: new Date(expires).toISOString(), provider };
  }
  return {
    provider,
    async request({ text: input, installedApps = [], session } = {}) {
      owner(session);
      if (typeof input !== 'string' || !input.trim() || input.length > 500 || /[\u0000-\u001f\u007f]/.test(input)) throw new NativeAssistantError('invalid_input', 400, 'Povel musí mít 1 až 500 znaků.');
      if (!Array.isArray(installedApps) || installedApps.length > PACKAGES.size || installedApps.some(id => typeof id !== 'string' || !PACKAGES.has(id)) || new Set(installedApps).size !== installedApps.length) throw new NativeAssistantError('invalid_apps', 400, 'Seznam aplikací se nepodařilo ověřit.');
      const query = norm(input), installed = new Set(installedApps);
      const unsupported = reply => ({ status: 'unsupported', reply, provider });
      if (/\b(?:https?|file|intent|javascript|content|adb|ssh):|\b(?:restart|reset|odinstal|smaz|vymaz|firmware|token|heslo|pin)\b/.test(query)) return unsupported('Tento systémový nebo technický povel není podporovaný.');
      if (/\b(?:script|automation|shell_command|rest_command|python_script|input_text)\./.test(query)) return unsupported('Technické názvy služeb a skriptů nejsou hlasovým povelem. Použij běžný domácí povel.');
      if (/dobrou noc|nocni rezim|rezim noc/.test(query)) return unsupported('Pro noční rutinu otevři Dobrou noc na přehledu. Zobrazí všechny kroky a vyžádá trojí potvrzení.');
      if (/zradc/.test(query) && /posledni|nejnovejsi/.test(query) && /^(?:pust|spust|otevri|zapni)\b/.test(query)) {
        if (!installed.has('cz.prima.tvapp')) return unsupported('Aplikace prima+ není mezi dostupnými aplikacemi televize.');
        if (catalogBusy) return unsupported('Právě ověřuji katalog prima+. Zkus to po dokončení předchozího požadavku.');
        let content;
        catalogBusy = true;
        try { content = await resolvePrima({ query: 'Zrádci', selection: 'latest' }); }
        catch { return unsupported('Poslední publikovaný celý díl se v oficiálním katalogu nepodařilo ověřit.'); }
        finally { catalogBusy = false; }
        if (!validPrimaEpisodeUrl(content?.url) || content?.availability?.publishingState !== 'published' || typeof content.title !== 'string' || !content.title.trim()) return unsupported('Katalog nevrátil ověřený odkaz na publikovanou celou epizodu.');
        return prepare(session, `Předat aplikaci prima+ epizodu „${text(content.title, 200)}“? Přístup účtu a skutečné spuštění videa nejsou ověřené.`, { nativeAction: { type: 'prima_episode', appId: 'cz.prima.tvapp', url: content.url } });
      }
      const appMatch = /^(?:otevri|spust|zapni|pust)(?: aplikaci| aplikace)? (.+)$/.exec(query);
      if (appMatch && APPS.has(appMatch[1])) {
        const appId = APPS.get(appMatch[1]);
        if (!installed.has(appId)) return unsupported('Požadovaná aplikace není mezi dostupnými aplikacemi televize.');
        return prepare(session, `Otevřít ${appMatch[1]} přímo v televizi?`, { nativeAction: { type: 'launch_app', appId } });
      }
      const key = ({ 'zesil': 'volume_up', 'zvys hlasitost': 'volume_up', 'zeslab': 'volume_down', 'sniz hlasitost': 'volume_down', 'ztlum zvuk': 'mute', 'vypni zvuk': 'mute', 'ztlum televizi': 'mute', 'domu': 'home', 'hlavni nabidka': 'home', 'zpet': 'back', 'pozastav prehravani': 'pause', 'pokracuj v prehravani': 'play' })[query];
      if (key) return prepare(session, `Provést na televizi povel „${text(input, 120)}“?`, { nativeAction: { type: 'key', key } });
      if (/^(?:kolik|jaka|jake|jaky|je|jsou|kde|kdo|co|ukaz|zobraz|stav|teplota|pocasi|jak)\b/.test(query)) {
        let data;
        try { data = await readStatus(); } catch { return unsupported('Aktuální data Home Assistantu se nepodařilo načíst.'); }
        const reply = statusReply(query, data || {});
        return reply ? { status: 'complete', reply, provider, readOnly: true } : unsupported('Mohu přečíst počasí, teploty, světla, zámky, polohy, kalendář, pračku a vysavač.');
      }
      if (/^(?:zapni|vypni|rozsvit|zhasni|nastav|zatahni|vytahni|otevri|zavri|zamkni|odemkni|spust|zastav|uklid|vysaj|zmen|zvys|sniz)\b/.test(query)) {
        if (!ha || typeof ha.request !== 'function') return unsupported('Domácí hlasové ovládání není dostupné.');
        return prepare(session, `Odeslat Home Assistantu domácí povel „${text(input, 500)}“? Po potvrzení může ovládat skutečná zařízení.`, { haText: input.trim() });
      }
      return unsupported('Zkus například „otevři Netflix“, „jaké je venku počasí“ nebo domácí povel. Ovládací povel nejdřív ukážu k potvrzení.');
    },
    async confirm({ id, session } = {}) {
      const ownerHash = owner(session); prune();
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id)) fail();
      const item = pending.get(id);
      if (!item || item.ownerHash !== ownerHash || item.expires <= now()) fail();
      pending.delete(id); // A timeout, replay, or retry can never repeat the home action.
      if (item.action.nativeAction) return { status: 'native_action', reply: 'Povel je potvrzený pro místní provedení v televizi.', nativeAction: { ...item.action.nativeAction }, provider };
      let result;
      try { result = await ha.request('api/services/conversation/process?return_response', { method: 'POST', body: { text: item.action.haText, language: 'cs', agent_id: 'conversation.home_assistant' } }); }
      catch { throw new NativeAssistantError('ha_outcome_unknown', 502, 'Home Assistant nepotvrdil výsledek povelu. Povel automaticky neopakuji. Stav zařízení ověř samostatně.'); }
      const response = result?.service_response?.response || result?.response;
      const speech = response?.speech?.plain?.speech;
      return { status: response?.response_type === 'error' ? 'failed' : 'complete', reply: typeof speech === 'string' && speech.trim() ? text(speech) : 'Home Assistant přijal povel. Fyzický stav zařízení není tímto potvrzený.', provider, physicalStateVerified: false };
    },
  };
}
