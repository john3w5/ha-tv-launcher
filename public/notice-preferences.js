/* Toast preferences. Remote adapters receive only explicit preference actions, never HA/device commands. */
(function (global) {
  'use strict';
  const KEY = 'home-tv.notice-preferences.v1';
  const HOUR = 60 * 60 * 1000;
  const MAX_KINO = 24 * HOUR;
  const validMinutes = value => Number.isSafeInteger(value) && value >= 1 && value <= 1440;
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  function create(options) {
    const settings = options || {};
    const clock = typeof settings.now === 'function' ? settings.now : () => Date.now();
    let enabled = false, loaded = false, persistent = false, storage = null, onChange = null;
    let remote = null, scope = 'preview', pending = false, error = '', generation = 0, operation = null;
    let preferences = { kino: false, kinoStartedAt: 0, kinoUntil: 0, snoozedAt: 0, snoozedUntil: 0 };
    const listeners = new Set();
    const time = () => { const value = clock(); return Number.isSafeInteger(value) && value >= 0 ? value : null; };
    const resetSnooze = () => { preferences.snoozedAt = 0; preferences.snoozedUntil = 0; };
    function write() {
      if (!enabled || remote || !storage) return;
      try { storage.setItem(KEY, JSON.stringify({ version: 1, ...preferences })); }
      catch { persistent = false; storage = null; }
    }
    function load() {
      if (loaded || !enabled || remote) return;
      loaded = true;
      try {
        storage = Object.prototype.hasOwnProperty.call(settings, 'storage') ? settings.storage : global.localStorage;
        if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') { storage = null; return; }
        const raw = storage.getItem(KEY);
        persistent = true;
        if (raw === null) return;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { write(); return; }
        if (!parsed || Array.isArray(parsed) || parsed.version !== 1 || typeof parsed.kino !== 'boolean') { write(); return; }
        preferences.kino = parsed.kino;
        const at = parsed.snoozedAt, until = parsed.snoozedUntil, now = time();
        if (preferences.kino) {
          const start = parsed.kinoStartedAt, end = parsed.kinoUntil;
          if (!Object.prototype.hasOwnProperty.call(parsed, 'kinoStartedAt') && now !== null) {
            // Upgrade the old untimed local switch to a bounded one-hour window.
            preferences.kinoStartedAt = now; preferences.kinoUntil = now + HOUR;
          } else if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && validMinutes((end - start) / 60000) && now !== null && start <= now + 5000 && end > now && end <= now + MAX_KINO + 5000) {
            preferences.kinoStartedAt = start; preferences.kinoUntil = end;
          } else { preferences.kino = false; preferences.kinoStartedAt = 0; preferences.kinoUntil = 0; write(); }
        }
        if (Number.isSafeInteger(at) && Number.isSafeInteger(until) && at >= 0 && until - at === HOUR && now !== null && at <= now + 5000 && until > now && until - now <= HOUR + 5000) {
          preferences.snoozedAt = at; preferences.snoozedUntil = until;
        } else if (at !== 0 || until !== 0) { resetSnooze(); write(); }
        write();
      } catch { persistent = false; storage = null; }
    }
    function expire() {
      if (!enabled) return false;
      const now = time();
      let expired = false;
      if (preferences.kino && (now === null || now >= preferences.kinoUntil || preferences.kinoStartedAt > now + 5000 || preferences.kinoUntil - now > MAX_KINO + 5000)) {
        preferences.kino = false; preferences.kinoStartedAt = 0; preferences.kinoUntil = 0; write(); expired = true;
      }
      if (preferences.snoozedUntil && (now === null || now >= preferences.snoozedUntil || preferences.snoozedAt > now + 5000 || preferences.snoozedUntil - now > HOUR + 5000)) { resetSnooze(); write(); expired = true; }
      return expired;
    }
    function emit(state) { for (const listener of [onChange, ...listeners]) { if (typeof listener === 'function') try { listener(state); } catch { /* Consumer cannot break preference state. */ } } }
    function getState() {
      load(); const expired = expire();
      const now = time(), snoozed = enabled && now !== null && preferences.snoozedUntil > now;
      const remaining = now === null ? 0 : Math.max(0, (snoozed ? preferences.snoozedUntil : 0) - now, (enabled && preferences.kino && preferences.kinoUntil ? preferences.kinoUntil : 0) - now);
      const state = Object.freeze({ enabled, kino: enabled && preferences.kino, kinoEnabled: enabled && preferences.kino, snoozed, snoozedUntil: snoozed ? preferences.snoozedUntil : 0,
        kinoUntil: enabled && preferences.kino ? preferences.kinoUntil : 0, snoozedAt: snoozed ? preferences.snoozedAt : 0,
        kinoDurationMinutes: enabled && preferences.kino ? (preferences.kinoUntil - preferences.kinoStartedAt) / 60000 : 0,
        remainingMs: remaining, remainingMinutes: Math.ceil(remaining / 60000),
        active: enabled && (preferences.kino || snoozed), persistent, scope, remote: Boolean(remote), pending, error });
      if (expired) emit(state);
      return state;
    }
    function changed() { const state = getState(); emit(state); return state; }
    function applyRemote(value) {
      const now = time();
      if (!remote || !enabled || !value || Array.isArray(value) || now === null || value.enabled !== true || typeof value.kino !== 'boolean' ||
          typeof value.snoozed !== 'boolean' || !Number.isSafeInteger(value.kinoUntil) || !Number.isSafeInteger(value.snoozedUntil) ||
          value.kinoUntil < 0 || value.snoozedUntil < 0 || value.kinoUntil > now + MAX_KINO + 5000 || value.snoozedUntil > now + HOUR + 5000 ||
          (value.kino && !value.kinoUntil) || (!value.kino && value.kinoUntil !== 0) || (value.snoozed && !value.snoozedUntil) || (!value.snoozed && value.snoozedUntil !== 0)) return false;
      const start = Number.isSafeInteger(value.kinoStartedAt) ? value.kinoStartedAt : Math.max(0, value.kinoUntil - (validMinutes(value.kinoDurationMinutes) ? value.kinoDurationMinutes * 60000 : HOUR));
      if (value.kino && (start > now + 5000 || !validMinutes((value.kinoUntil - start) / 60000))) return false;
      preferences = { kino: value.kino && value.kinoUntil > now, kinoStartedAt: value.kino && value.kinoUntil > now ? start : 0, kinoUntil: value.kino && value.kinoUntil > now ? value.kinoUntil : 0,
        snoozedAt: value.snoozed && value.snoozedUntil > now ? Math.max(0, value.snoozedUntil - HOUR) : 0,
        snoozedUntil: value.snoozed && value.snoozedUntil > now ? value.snoozedUntil : 0 };
      persistent = value.persistent === true; error = ''; changed(); return true;
    }
    function request(action) {
      if (!enabled || !remote) return Promise.resolve(getState());
      if (pending) return operation || Promise.resolve(getState());
      const adapter = remote, token = generation;
      pending = true; error = ''; changed();
      operation = Promise.resolve().then(() => action ? adapter.save(action) : adapter.load()).then(value => {
        if (token !== generation || adapter !== remote || !enabled) return;
        if (!applyRemote(value)) throw Error('Server vrátil neplatný stav oznámení.');
      }).catch(() => {
        if (token === generation && adapter === remote && enabled) error = 'Změnu nebo stav oznámení se nepodařilo potvrdit. Obnov stav a zkus to znovu.';
      }).finally(() => { if (token === generation) { pending = false; operation = null; changed(); } }).then(() => getState());
      return operation;
    }
    function configure(config) {
      enabled = config?.enabled === true;
      if (Object.prototype.hasOwnProperty.call(config || {}, 'onChange')) onChange = typeof config.onChange === 'function' ? config.onChange : null;
      if (['preview', 'tv', 'screen'].includes(config?.scope)) scope = config.scope;
      if (Object.prototype.hasOwnProperty.call(config || {}, 'remote')) {
        const next = config.remote && typeof config.remote.load === 'function' && typeof config.remote.save === 'function' ? config.remote : null;
        if (next !== remote) { generation++; remote = next; pending = false; operation = null; storage = null; persistent = false; loaded = false; error = ''; preferences = { kino: false, kinoStartedAt: 0, kinoUntil: 0, snoozedAt: 0, snoozedUntil: 0 }; }
      }
      if (!enabled) { generation++; pending = false; operation = null; return changed(); }
      if (remote) {
        if (Object.prototype.hasOwnProperty.call(config || {}, 'initial') && applyRemote(config.initial)) return getState();
        request(); return getState();
      }
      load(); return changed();
    }
    function setKino(value, minutes) {
      if (!enabled || typeof value !== 'boolean' || (minutes !== undefined && (!value || !validMinutes(minutes)))) return getState();
      if (remote) return request({ action: 'kino', enabled: value, ...(minutes === undefined ? {} : { minutes }) });
      load(); expire(); const now = time();
      if (value && now === null) return getState();
      if (!value) { preferences.kino = false; preferences.kinoStartedAt = 0; preferences.kinoUntil = 0; }
      else if (!preferences.kino || (minutes !== undefined && preferences.kinoUntil - preferences.kinoStartedAt !== minutes * 60000)) {
        preferences.kino = true; preferences.kinoStartedAt = now; preferences.kinoUntil = now + (minutes ?? 60) * 60000;
      }
      write(); return changed();
    }
    function snooze60() {
      const state = getState(), now = time();
      if (!enabled || state.snoozed || now === null || !Number.isSafeInteger(now + HOUR)) return state;
      if (remote) return request({ action: 'snooze' });
      preferences.snoozedAt = now; preferences.snoozedUntil = now + HOUR; write(); return changed();
    }
    function resume() {
      if (!enabled) return getState();
      if (remote) return request({ action: 'resume' });
      preferences.kino = false; preferences.kinoStartedAt = 0; preferences.kinoUntil = 0; resetSnooze(); write(); return changed();
    }
    function allows(notice) {
      const state = getState();
      if (!state.active) return true;
      if (!notice || typeof notice !== 'object') return false;
      return notice.type === 'urgent' || notice.eventType === 'doorbell' ||
        (['house-washer-leak', 'house-washer-finished'].includes(notice.id) && notice.source === 'home_assistant');
    }
    return Object.freeze({ configure, getState, applyRemote, refresh: () => request(), setKino, toggleKino: () => setKino(!getState().kino), snooze60, resume, allows,
      subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('Preference listener must be a function'); listeners.add(listener); return () => listeners.delete(listener); } });
  }

  const current = create();
  function status(state) {
    if (!state.enabled) return 'Režim Kino není pro tuto obrazovku zapnutý.';
    if (state.pending) return 'Potvrzuji stav oznámení se serverem…';
    if (state.error) return state.error;
    const until = state.snoozed ? new Date(state.snoozedUntil).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }) : '';
    const kinoTime = state.kinoUntil ? new Date(state.kinoUntil).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }) : '';
    return (state.kino ? 'Kino je zapnuté' + (kinoTime ? ' do ' + kinoTime : '') + '. ' : '') + (state.snoozed ? 'Běžné bannery jsou ztišené do ' + until + '. ' : '') +
      (!state.active ? 'Běžné bannery jsou zapnuté. ' : '') + (!state.persistent && !state.remote ? 'Volba se v tomto prohlížeči neuloží po zavření. ' : '');
  }
  function dialogMarkup() {
    const state = current.getState();
    if (!state.enabled) return '';
    const label = state.scope === 'tv' ? 'Tato TV a její překryvy' : state.scope === 'screen' ? 'Tato obrazovka' : 'Jen tento náhled';
    const where = state.scope === 'tv' && state.remote ? 'na této obrazovce a v jejích TV překryvech' : 'v tomto prohlížeči';
    return '<section class="notice-preferences" data-notice-preferences aria-label="Zobrazení oznámení">' +
      '<div class="notice-preferences-heading"><h3>Klid na sledování</h3><span class="chip">' + label + '</span></div>' +
      '<p class="description">Kino a ztišení skryjí běžné bannery ' + where + '. Centrum oznámení zůstává dostupné. Zvonek, urgentní zprávy, únik vody a dokončení praní zůstávají povolené.</p>' +
      '<div class="notice-preferences-actions"><label>Délka Kina <input class="form-input" type="number" min="1" max="1440" step="1" value="' + (state.kinoDurationMinutes || 60) + '" data-notice-minutes aria-label="Délka Kina v minutách"> min</label>' +
      '<button class="small-button" type="button" data-notice-pref="kino-apply">Zapnout na vybranou dobu</button>' +
      '<button class="small-button" type="button" data-notice-pref="kino" role="switch" aria-checked="' + state.kino + '" aria-label="Režim Kino">Kino · ' + (state.kino ? 'zapnuto' : 'vypnuto') + '</button>' +
      '<button class="small-button" type="button" data-notice-pref="snooze"' + (state.snoozed ? ' disabled' : '') + '>Ztišit na 1 hodinu</button>' +
      '<button class="small-button" type="button" data-notice-pref="resume"' + (!state.active ? ' disabled' : '') + '>Obnovit bannery</button><button class="small-button" type="button" data-notice-pref="refresh"' + (!state.error || !state.remote ? ' hidden' : '') + '>Obnovit stav</button></div>' +
      '<p class="notice-preferences-status" role="status" aria-live="polite">' + escape(status(state)) + '</p>' +
      '<p class="photo-status">' + (state.scope === 'tv' && state.remote ? 'Volba platí pro spárovanou TV relaci. Nemění HA ani zařízení domácnosti.' : 'Volba neovládá HA, televizi ani oznámení v ostatních TV aplikacích.') + '</p></section>';
  }
  function bind(container) {
    const panel = container?.matches?.('[data-notice-preferences]') ? container : container?.querySelector?.('[data-notice-preferences]');
    if (!panel || !current.getState().enabled) return () => {};
    let stopped = false;
    const update = () => {
      if (stopped) return;
      const state = current.getState(), kino = panel.querySelector('[data-notice-pref="kino"]'), snooze = panel.querySelector('[data-notice-pref="snooze"]'), resume = panel.querySelector('[data-notice-pref="resume"]'), line = panel.querySelector('.notice-preferences-status'), refresh = panel.querySelector('[data-notice-pref="refresh"]');
      panel.setAttribute?.('aria-busy', String(state.pending));
      if (kino) { kino.setAttribute('aria-checked', String(state.kino)); kino.textContent = 'Kino · ' + (state.kino ? 'zapnuto' : 'vypnuto'); kino.disabled = state.pending; }
      const apply = panel.querySelector('[data-notice-pref="kino-apply"]'); if (apply) apply.disabled = state.pending;
      if (snooze) snooze.disabled = state.pending || state.snoozed;
      if (resume) resume.disabled = state.pending || !state.active;
      if (refresh) { refresh.hidden = !state.error || !state.remote; refresh.disabled = state.pending; }
      if (line) line.textContent = status(state);
    };
    const click = event => {
      const button = event.target?.closest?.('[data-notice-pref]');
      if (!button || !panel.contains(button) || button.disabled) return;
      const actions = { kino: current.toggleKino, 'kino-apply': () => {
        const value = Number(panel.querySelector('[data-notice-minutes]')?.value);
        if (validMinutes(value)) current.setKino(true, value);
        else { const line = panel.querySelector('.notice-preferences-status'); if (line) line.textContent = 'Zadej celou délku od 1 do 1440 minut.'; }
      }, snooze: current.snooze60, resume: current.resume, refresh: current.refresh };
      if (Object.prototype.hasOwnProperty.call(actions, button.dataset.noticePref)) actions[button.dataset.noticePref]();
    };
    const keydown = event => { if (event.repeat && ['Enter', ' '].includes(event.key) && event.target?.closest?.('[data-notice-pref]')) { event.preventDefault(); event.stopPropagation(); } };
    panel.addEventListener('click', click); panel.addEventListener('keydown', keydown);
    const unsubscribe = current.subscribe(update);
    const timer = global.setInterval(() => { if (!panel.isConnected) cleanup(); else update(); }, 1000);
    function cleanup() { if (stopped) return; stopped = true; global.clearInterval(timer); unsubscribe(); panel.removeEventListener('click', click); panel.removeEventListener('keydown', keydown); }
    update(); return cleanup;
  }

  global.NoticePreferences = Object.freeze({ create, configure: current.configure, getState: current.getState, allows: current.allows,
    applyRemote: current.applyRemote, refresh: current.refresh, setKino: current.setKino, toggleKino: current.toggleKino, snooze60: current.snooze60, resume: current.resume, dialogMarkup, bind });
})(globalThis);
