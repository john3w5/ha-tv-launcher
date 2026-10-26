const SETTING_KEYS = ['theme', 'background', 'navigationSounds', 'saverMinutes', 'photoIntervalSeconds'];
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PHOTO_LIMIT = 12 * 1024 * 1024;

export class ManageError extends Error {
  constructor(status = 0) { super('Nastavení se nepodařilo přenést.'); this.status = status; }
}

export function pairingCode(raw) {
  const code = typeof raw === 'string' ? raw.replace(/\s/g, '') : '';
  return /^\d{8}$/.test(code) ? code : null;
}

export function validSettingsPatch(patch) {
  return patch && typeof patch === 'object' && !Array.isArray(patch) && Object.keys(patch).length > 0 &&
    Object.entries(patch).every(([key, value]) => {
      if (key === 'theme') return ['auto', 'light', 'dark'].includes(value);
      if (key === 'background') return ['weather', 'plain', 'photos'].includes(value);
      if (key === 'navigationSounds') return typeof value === 'boolean';
      if (key === 'saverMinutes') return Number.isSafeInteger(value) && value >= 0 && value <= 120;
      if (key === 'photoIntervalSeconds') return Number.isSafeInteger(value) && value >= 10 && value <= 3600;
      return false;
    });
}

export function readSettings(response) {
  const value = response?.settings;
  if (response?.version !== 1 || !validSettingsPatch(value) || SETTING_KEYS.some(key => !Object.hasOwn(value, key))) throw new ManageError(502);
  return Object.fromEntries(SETTING_KEYS.map(key => [key, value[key]]));
}

export function settingsDifference(current, original) {
  return Object.fromEntries(SETTING_KEYS.filter(key => current[key] !== original?.[key]).map(key => [key, current[key]]));
}

export function validPhoto(file) {
  return Boolean(file && PHOTO_TYPES.has(file.type) && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= PHOTO_LIMIT);
}

export function photoPath(value) {
  return typeof value === 'string' && /^\/api\/photos\/[a-f0-9]{24}\/file$/.test(value) ? value : null;
}

/** Fixed same-origin routes only. The one-time code is neither cached nor put in a URL. */
export function createManageApi(fetchImpl = globalThis.fetch) {
  async function request(path, { method = 'GET', body, raw = false } = {}) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), raw ? 60000 : 15000);
    try {
      const response = await fetchImpl(path, {
        method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': raw ? body.type : 'application/json' }) },
        ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
      });
      if (!response.ok) throw new ManageError(response.status);
      if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new ManageError(502);
      const text = await response.text();
      if (text.length > 262144) throw new ManageError(502);
      try { return JSON.parse(text); } catch { throw new ManageError(502); }
    } catch (error) { throw error instanceof ManageError ? error : new ManageError(); }
    finally { clearTimeout(timer); }
  }
  return {
    bootstrap: () => request('/api/bootstrap'),
    pair(code) { const safe = pairingCode(code); if (!safe) return Promise.reject(new ManageError(400)); return request('/api/pair', { method: 'POST', body: { code: safe } }); },
    settings: () => request('/api/client-settings'),
    saveSettings(patch) { if (!validSettingsPatch(patch)) return Promise.reject(new ManageError(400)); return request('/api/client-settings', { method: 'PUT', body: patch }); },
    photos: () => request('/api/photos'),
    upload(file) { if (!validPhoto(file)) return Promise.reject(new ManageError(file?.size > PHOTO_LIMIT ? 413 : 415)); return request('/api/photos/upload', { method: 'POST', body: file, raw: true }); },
    timeline: () => request('/api/timeline?limit=12'),
    logout: () => request('/api/logout', { method: 'POST', body: {} }),
  };
}

function errorText(error, pairing = false) {
  if (error?.status === 401) return pairing ? 'Kód není správný nebo už vypršel. Na televizi si zobraz nový kód.' : 'Připojení už neplatí. Propoj telefon novým kódem z televize.';
  if (error?.status === 403) return 'Otevři tuto stránku z domácí adresy uvedené na televizi.';
  if (error?.status === 429) return 'Příliš mnoho pokusů. Zkus to znovu za 10 minut.';
  if (error?.status === 413) return 'Fotografie smí mít nejvýše 12 MiB.';
  if (error?.status === 415) return 'Vyber JPEG, PNG nebo WebP. Fotografii HEIC nejprve ulož jako JPEG.';
  if (error?.status === 400) return 'Zkontroluj zadané hodnoty a zkus to znovu.';
  return 'Domácí most teď neodpovídá. Zkontroluj domácí Wi-Fi a zkus to znovu.';
}

export function initializeManage(document, api = createManageApi()) {
  const byId = id => document.getElementById(id);
  const form = byId('preferences-form'), pairInput = byId('pair-code');
  const state = { authenticated: false, baseline: null, dirty: false, saving: false, uploading: false, pairing: false, loading: false, photos: [], live: false };
  let refreshTimer;
  function notice(id, text, error = false) { const view = byId(id); view.textContent = text; view.dataset.error = String(error); view.hidden = !text; }
  function connection(text, connected = false) { const view = byId('connection-status'); view.textContent = text; view.dataset.state = connected ? 'connected' : 'idle'; }
  function previewTheme(theme) { document.documentElement.dataset.theme = theme; }
  function showPair(message = '') {
    state.authenticated = false; state.baseline = null; state.dirty = false; state.live = false; state.photos = [];
    byId('settings-screen').hidden = true; byId('pair-screen').hidden = false; pairInput.value = ''; byId('pair-button').disabled = true;
    byId('photo-image').removeAttribute('src'); byId('photo-preview').hidden = true; byId('timeline-list').replaceChildren();
    connection('Čeká na propojení'); previewTheme('auto'); notice('pair-notice', message, Boolean(message));
  }
  function readForm() {
    return { theme: form.querySelector('input[name="theme"]:checked')?.value,
      background: form.querySelector('input[name="background"]:checked')?.value,
      navigationSounds: byId('navigation-sounds').checked,
      saverMinutes: byId('saver-minutes').valueAsNumber, photoIntervalSeconds: byId('photo-seconds').valueAsNumber };
  }
  function updateDirty() {
    const current = readForm(); state.dirty = Object.keys(settingsDifference(current, state.baseline)).length > 0;
    byId('save-button').disabled = !state.live || state.saving || !state.dirty || !validSettingsPatch(current);
    byId('save-state').textContent = state.saving ? 'Ukládám…' : state.dirty ? 'Máš neuložené změny.' : 'Vše je uložené.';
    form.querySelector('.save-bar').dataset.dirty = String(state.dirty);
    if (['auto', 'light', 'dark'].includes(current.theme)) previewTheme(current.theme);
  }
  function applySettings(response) {
    const settings = readSettings(response); state.baseline = settings;
    for (const key of ['theme', 'background']) form.querySelector(`input[name="${key}"][value="${settings[key]}"]`).checked = true;
    byId('navigation-sounds').checked = settings.navigationSounds; byId('saver-minutes').value = String(settings.saverMinutes); byId('photo-seconds').value = String(settings.photoIntervalSeconds);
    byId('settings-warning').hidden = response.persistent !== false;
    byId('settings-warning').textContent = 'Nastavení se nyní neukládá trvale. Po restartu domácího mostu se může obnovit původní.';
    updateDirty();
  }
  function expired(error) { if (error?.status !== 401) return false; showPair(errorText(error)); return true; }
  async function loadPhotos() {
    try {
      const result = await api.photos(); if (!state.authenticated) return;
      if (!Array.isArray(result)) throw new ManageError(502);
      state.photos = result.slice(0, 1000).map(item => photoPath(item?.url)).filter(Boolean);
      byId('photo-count').textContent = `V knihovně: ${state.photos.length} ${state.photos.length === 1 ? 'fotografie' : state.photos.length > 1 && state.photos.length < 5 ? 'fotografie' : 'fotografií'}.`;
      const select = byId('photo-select'), old = select.value; select.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Vyber fotografii'; select.append(placeholder);
      state.photos.forEach((path, index) => { const option = document.createElement('option'); option.value = path; option.textContent = `Fotografie ${index + 1}`; select.append(option); });
      select.disabled = !state.photos.length; if (state.photos.includes(old)) select.value = old;
    } catch (error) { if (!expired(error)) byId('photo-count').textContent = 'Knihovnu se zatím nepodařilo načíst.'; }
  }
  async function refresh() {
    if (state.loading || state.saving || state.uploading || state.pairing || state.dirty) return;
    state.loading = true;
    try {
      const result = await api.bootstrap();
      if (result?.authenticated !== true) { showPair(); return; }
      if (state.dirty || state.saving || state.uploading) return; // A background refresh cannot replace edits made while it was in flight.
      state.live = result.mode === 'live' && result.preview?.readOnly !== true;
      applySettings(result.clientSettings || await api.settings());
      const newlyConnected = !state.authenticated; state.authenticated = true;
      byId('settings-screen').hidden = false; byId('pair-screen').hidden = true; connection('Připojeno', true);
      form.querySelectorAll('input').forEach(input => { input.disabled = !state.live; });
      if (!state.live) { byId('settings-warning').hidden = false; byId('settings-warning').textContent = 'Toto je jen náhled. Změny otevři na domácí adrese uvedené na televizi.'; }
      byId('photo-files').disabled = !state.live; byId('photo-files').closest('.photos-panel').dataset.busy = String(!state.live);
      if (!state.live) notice('photo-notice', 'Fotografie můžeš přidávat v živém domácím mostu.');
      if (newlyConnected) await loadPhotos();
    } catch (error) {
      if (!expired(error)) { connection('Bez spojení'); notice(state.authenticated ? 'settings-notice' : 'pair-notice', errorText(error), true); }
    } finally { state.loading = false; }
  }
  byId('pair-form').addEventListener('submit', async event => {
    event.preventDefault(); const code = pairingCode(pairInput.value); if (!code || state.pairing) return;
    state.pairing = true; byId('pair-button').disabled = true; byId('pair-button').textContent = 'Propojuji…'; notice('pair-notice', '');
    try { await api.pair(code); pairInput.value = ''; state.pairing = false; await refresh(); }
    catch (error) { notice('pair-notice', errorText(error, true), true); pairInput.value = ''; pairInput.focus(); }
    finally { state.pairing = false; byId('pair-button').textContent = 'Propojit telefon'; byId('pair-button').disabled = !pairingCode(pairInput.value); }
  });
  pairInput.addEventListener('input', () => { pairInput.value = pairInput.value.replace(/\D/g, '').slice(0, 8); byId('pair-button').disabled = state.pairing || !pairingCode(pairInput.value); });
  form.addEventListener('input', updateDirty); form.addEventListener('change', updateDirty);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (state.saving || !state.authenticated || !state.live) return;
    const current = readForm(), patch = settingsDifference(current, state.baseline); if (!validSettingsPatch(current) || !Object.keys(patch).length) return;
    state.saving = true; updateDirty(); notice('settings-notice', '');
    const controls = [...form.querySelectorAll('input')]; controls.forEach(input => { input.disabled = true; });
    try { applySettings(await api.saveSettings(patch)); notice('settings-notice', 'Uloženo. Televize si nastavení převezme.'); }
    catch (error) { if (!expired(error)) notice('settings-notice', errorText(error), true); }
    finally { controls.forEach(input => { input.disabled = !state.live; }); state.saving = false; if (state.authenticated) updateDirty(); }
  });
  byId('photo-files').addEventListener('change', async event => {
    const files = Array.from(event.target.files || []); if (!files.length || state.uploading || !state.authenticated || !state.live) return;
    if (files.length > 10) { notice('photo-notice', 'Vyber nejvýše 10 fotografií najednou.', true); event.target.value = ''; return; }
    const invalid = files.find(file => !validPhoto(file)); if (invalid) { notice('photo-notice', errorText(new ManageError(invalid.size > PHOTO_LIMIT ? 413 : 415)), true); event.target.value = ''; return; }
    state.uploading = true; byId('photo-files').disabled = true; byId('photo-files').closest('.photos-panel').dataset.busy = 'true'; let uploaded = 0;
    try {
      for (const file of files) { notice('photo-notice', `Nahrávám fotografii ${uploaded + 1} z ${files.length}…`); await api.upload(file); uploaded++; }
      notice('photo-notice', `Hotovo. ${uploaded === 1 ? 'Fotografie je připravená' : `Všech ${uploaded} fotografií je připraveno`} pro pozadí a spořič.`); await loadPhotos();
    } catch (error) { if (!expired(error)) notice('photo-notice', `${uploaded ? `Nahráno ${uploaded} z ${files.length}. ` : ''}${errorText(error)}`, true); }
    finally { state.uploading = false; event.target.value = ''; byId('photo-files').disabled = !state.live; byId('photo-files').closest('.photos-panel').dataset.busy = String(!state.live); }
  });
  byId('photo-select').addEventListener('change', event => {
    const path = photoPath(event.target.value), image = byId('photo-image');
    if (path && state.photos.includes(path) && state.authenticated) { image.src = path; byId('photo-preview').hidden = false; }
    else { image.removeAttribute('src'); byId('photo-preview').hidden = true; }
  });
  byId('photo-library').addEventListener('toggle', event => {
    if (!event.target.open) { byId('photo-image').removeAttribute('src'); byId('photo-preview').hidden = true; byId('photo-select').value = ''; }
  });
  let timelineBusy = false;
  async function loadTimeline() {
    if (!state.authenticated || timelineBusy) return; timelineBusy = true; byId('timeline-refresh').disabled = true; byId('timeline-notice').textContent = 'Načítám historii…';
    try {
      const response = await api.timeline(); if (!state.authenticated) return;
      if (!Array.isArray(response?.events)) throw new ManageError(502);
      const list = byId('timeline-list'); list.replaceChildren();
      const events = response.events.slice(0, 12);
      for (const item of events) {
        const row = document.createElement('li'), time = document.createElement('time'), title = document.createElement('strong'), message = document.createElement('p');
        const date = new Date(item.occurredAt); time.textContent = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(date) : 'Čas není dostupný';
        if (Number.isFinite(date.getTime())) time.dateTime = date.toISOString();
        title.textContent = String(item.title || (item.kind === 'doorbell' ? 'Zvonek' : 'Domov')).slice(0, 120); message.textContent = String(item.message || '').slice(0, 1000);
        row.append(time, title, message); list.append(row);
      }
      byId('timeline-notice').textContent = events.length ? '' : 'Zatím tu nejsou žádné události.';
    } catch (error) { if (!expired(error)) byId('timeline-notice').textContent = errorText(error); }
    finally { timelineBusy = false; byId('timeline-refresh').disabled = false; }
  }
  byId('timeline-panel').addEventListener('toggle', event => { if (event.target.open) loadTimeline(); }); byId('timeline-refresh').addEventListener('click', loadTimeline);
  byId('logout-button').addEventListener('click', async () => {
    if (state.uploading || state.saving) { notice('settings-notice', 'Nejprve nech dokončit probíhající ukládání.'); return; }
    byId('logout-button').disabled = true;
    try { await api.logout(); showPair(); } catch (error) { if (!expired(error)) notice('settings-notice', errorText(error), true); }
    finally { byId('logout-button').disabled = false; }
  });
  const visible = () => { if (!document.hidden) refresh(); };
  document.addEventListener('visibilitychange', visible);
  refreshTimer = setInterval(visible, 30000); const ready = refresh();
  return { ready, refresh, destroy() { clearInterval(refreshTimer); document.removeEventListener('visibilitychange', visible); } };
}

if (typeof document !== 'undefined') initializeManage(document);
