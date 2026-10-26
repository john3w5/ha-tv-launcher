import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createManageApi, ManageError, pairingCode, validSettingsPatch, readSettings, settingsDifference, validPhoto, photoPath, initializeManage } from '../public/manage.js';

const SETTINGS = { theme: 'auto', background: 'weather', navigationSounds: true, saverMinutes: 5, photoIntervalSeconds: 30 };
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const fixture = (reply = {}) => {
  const calls = [], api = createManageApi(async (path, options) => { calls.push({ path, ...options }); return json(reply); });
  return { api, calls };
};

test('phone code keeps leading zeroes and accepts only eight digits without persisting it', () => {
  assert.equal(pairingCode('00123456'), '00123456'); assert.equal(pairingCode('0012 3456'), '00123456');
  for (const invalid of [null, 12345678, '1234567', '123456789', 'abcd1234', '1234?567']) assert.equal(pairingCode(invalid), null);
});

test('phone API uses only fixed same-origin endpoints and an eight-digit POST body', async () => {
  const f = fixture(); await f.api.pair('00123456');
  assert.equal(f.calls[0].path, '/api/pair'); assert.equal(f.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].body), { code: '00123456' });
  assert.equal(f.calls[0].credentials, 'same-origin'); assert.equal(f.calls[0].redirect, 'error'); assert.equal(f.calls[0].cache, 'no-store');
  assert.equal(f.calls[0].headers['Content-Type'], 'application/json');
  assert.equal(Object.keys(f.calls[0].headers).some(key => /cookie|authorization|origin/i.test(key)), false);
  await assert.rejects(() => f.api.pair('private-long-token'), error => error.status === 400); assert.equal(f.calls.length, 1);
});

test('only supported display preferences pass the client validator', () => {
  assert.equal(validSettingsPatch(SETTINGS), true); assert.equal(validSettingsPatch({ saverMinutes: 0, photoIntervalSeconds: 3600 }), true);
  for (const invalid of [{}, [], null, { navigationSound: true }, { navigationSounds: 'yes' }, { theme: 'purple' }, { background: 'url' },
    { saverMinutes: 121 }, { saverMinutes: 1.5 }, { saverMinutes: -1 }, { photoIntervalSeconds: 9 }, { photoIntervalSeconds: 3601 },
    { favorites: ['netflix'] }, { appOrder: [] }, { HA_TOKEN: 'secret' }, { service: 'unlock' }]) assert.ok(!validSettingsPatch(invalid));
  assert.deepEqual(readSettings({ version: 1, settings: SETTINGS }), SETTINGS);
  assert.throws(() => readSettings({ version: 1, settings: { theme: 'auto' } }), ManageError);
  assert.throws(() => readSettings({ version: 2, settings: SETTINGS }), ManageError);
});

test('saving sends only edited settings, preserving unrelated remote edits', async () => {
  const f = fixture({ version: 1, settings: SETTINGS });
  const patch = settingsDifference({ ...SETTINGS, navigationSounds: false }, SETTINGS);
  assert.deepEqual(patch, { navigationSounds: false }); await f.api.saveSettings(patch);
  assert.equal(f.calls[0].path, '/api/client-settings'); assert.equal(f.calls[0].method, 'PUT');
  assert.deepEqual(JSON.parse(f.calls[0].body), patch);
  await assert.rejects(() => f.api.saveSettings({ lock: 'front' }), error => error.status === 400); assert.equal(f.calls.length, 1);
});

test('photo uploads are raw supported images, bounded to twelve MiB and contain no filename/path', async () => {
  const f = fixture({ photo: { url: '/api/photos/' + 'a'.repeat(24) + '/file' } }), photo = new Blob(['image-data'], { type: 'image/jpeg' });
  assert.equal(validPhoto(photo), true); await f.api.upload(photo);
  assert.equal(f.calls[0].path, '/api/photos/upload'); assert.equal(f.calls[0].method, 'POST'); assert.equal(f.calls[0].body, photo);
  assert.equal(f.calls[0].headers['Content-Type'], 'image/jpeg'); assert.equal('Content-Disposition' in f.calls[0].headers, false);
  for (const file of [{ size: 0, type: 'image/png' }, { size: 1, type: 'image/heic' }, { size: 12 * 1024 * 1024 + 1, type: 'image/jpeg' }]) {
    assert.equal(validPhoto(file), false); await assert.rejects(() => f.api.upload(file), ManageError);
  }
  assert.equal(f.calls.length, 1);
});

test('photo previews accept only opaque private library routes, not external/HTML/file URLs', () => {
  const path = `/api/photos/${'a'.repeat(24)}/file`; assert.equal(photoPath(path), path);
  for (const value of ['https://example.test/photo.jpg', 'file:///private/image.jpg', 'javascript:alert(1)', '/api/profile/photo', path + '?token=secret', '../private/photos', null]) assert.equal(photoPath(value), null);
});

test('read-only history is bounded and the page never issues arbitrary house commands', async () => {
  const f = fixture(); await f.api.bootstrap(); await f.api.settings(); await f.api.photos(); await f.api.timeline(); await f.api.logout();
  assert.deepEqual(f.calls.map(call => [call.path, call.method]), [['/api/bootstrap', 'GET'], ['/api/client-settings', 'GET'], ['/api/photos', 'GET'], ['/api/timeline?limit=12', 'GET'], ['/api/logout', 'POST']]);
});

test('failed responses never surface server bodies, credentials or rejected redirects', async () => {
  const api = createManageApi(async () => new Response('PRIVATE-TOKEN http://ha.private/', { status: 401 }));
  await assert.rejects(() => api.settings(), error => error instanceof ManageError && error.status === 401 && !/PRIVATE|ha.private/.test(error.message));
  const broken = createManageApi(async () => { throw Error('SECRET-IN-NETWORK-ERROR'); });
  await assert.rejects(() => broken.bootstrap(), error => error instanceof ManageError && !error.message.includes('SECRET'));
  const html = createManageApi(async () => new Response('<html>private</html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(() => html.bootstrap(), error => error.status === 502);
});

test('phone page stays self-contained, with the exact TV path and no excluded feature controls', async () => {
  const [html, js] = await Promise.all([readFile(new URL('../public/manage.html', import.meta.url), 'utf8'), readFile(new URL('../public/manage.js', import.meta.url), 'utf8')]);
  assert.match(html, /Nastavení → Ovládání z telefonu/); assert.match(html, /krátce stiskni <strong>MENU/);
  assert.match(html, /inputmode="numeric"[^>]*autocomplete="one-time-code"/);
  assert.match(html, /role="switch"/); assert.match(html, /manage\.css/);
  assert.equal(/<script[^>]+src="https?:/.test(html), false);
  assert.equal(/localStorage|sessionStorage|innerHTML|\/api\/control|\/api\/night|\/api\/assistant|\/api\/mobile\/pairing/.test(js), false);
  assert.equal(/appOrder|favorites|HA_TOKEN|apiKey|profile.*upload/.test(html), false);
});

// Minimal DOM surface for the actual page controller. No browser, HA or live server is contacted.
async function domFixture() {
  class Element {
    constructor() { this.dataset = {}; this.hidden = false; this.value = ''; this.checked = false; this.disabled = false; this.children = []; this.listeners = new Map(); }
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    removeEventListener(type) { this.listeners.delete(type); }
    async emit(type, target = this) { await this.listeners.get(type)?.({ target, preventDefault() {} }); }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    removeAttribute(name) { delete this[name]; }
    focus() { this.focused = true; }
  }
  const html = await readFile(new URL('../public/manage.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const document = new Element(); document.hidden = false; document.documentElement = new Element();
  document.createElement = () => new Element(); document.getElementById = id => { assert.ok(elements.has(id), `Missing real page id ${id}`); return elements.get(id); };
  const form = elements.get('preferences-form'), saveBar = new Element(), photosPanel = new Element(), radios = [];
  for (const [name, values] of [['theme', ['light', 'dark', 'auto']], ['background', ['weather', 'photos', 'plain']]]) for (const value of values) {
    const radio = new Element(); radio.name = name; radio.value = value; radios.push(radio);
  }
  form.querySelector = selector => {
    if (selector === '.save-bar') return saveBar;
    const name = /name="([^"]+)"/.exec(selector)?.[1], value = /value="([^"]+)"/.exec(selector)?.[1];
    return radios.find(radio => radio.name === name && (value === undefined ? radio.checked : radio.value === value));
  };
  form.querySelectorAll = () => [...radios, ...['navigation-sounds', 'saver-minutes', 'photo-seconds'].map(id => elements.get(id))];
  elements.get('photo-files').closest = () => photosPanel;
  return { document, elements, form };
}

test('actual phone page authenticates, edits and saves only its changed preference', async t => {
  const dom = await domFixture(), writes = [];
  const api = { bootstrap: async () => ({ authenticated: true, mode: 'live', clientSettings: { version: 1, settings: SETTINGS, persistent: true } }), photos: async () => [],
    saveSettings: async patch => { writes.push(patch); return { version: 1, settings: { ...SETTINGS, ...patch }, persistent: true }; } };
  const screen = initializeManage(dom.document, api); t.after(() => screen.destroy()); await screen.ready;
  assert.equal(dom.elements.get('pair-screen').hidden, true); assert.equal(dom.elements.get('settings-screen').hidden, false);
  assert.equal(dom.elements.get('save-button').disabled, true);
  dom.elements.get('navigation-sounds').checked = false; await dom.form.emit('input');
  assert.equal(dom.elements.get('save-button').disabled, false); await dom.form.emit('submit');
  assert.deepEqual(writes, [{ navigationSounds: false }]); assert.equal(dom.elements.get('save-button').disabled, true);
  assert.match(dom.elements.get('settings-notice').textContent, /Uloženo/);
});

test('an in-flight background refresh cannot overwrite a newly edited field', async t => {
  const dom = await domFixture(); let release, wait = false;
  const response = { authenticated: true, mode: 'live', clientSettings: { version: 1, settings: SETTINGS, persistent: true } };
  const api = { bootstrap: () => wait ? new Promise(resolve => { release = () => resolve(response); }) : Promise.resolve(response), photos: async () => [] };
  const screen = initializeManage(dom.document, api); t.after(() => screen.destroy()); await screen.ready;
  wait = true; const refresh = screen.refresh(); dom.elements.get('navigation-sounds').checked = false; await dom.form.emit('input'); release(); await refresh;
  assert.equal(dom.elements.get('navigation-sounds').checked, false); assert.equal(dom.elements.get('save-button').disabled, false);
});

test('read-only preview disables preference and photo writes and explains the home-TV address', async t => {
  const dom = await domFixture(); let writes = 0;
  const api = { bootstrap: async () => ({ authenticated: true, mode: 'live', preview: { readOnly: true }, clientSettings: { version: 1, settings: SETTINGS, persistent: true } }),
    photos: async () => [], saveSettings: async () => { writes++; } };
  const screen = initializeManage(dom.document, api); t.after(() => screen.destroy()); await screen.ready;
  assert.equal(dom.elements.get('photo-files').disabled, true); assert.equal(dom.elements.get('navigation-sounds').disabled, true);
  assert.match(dom.elements.get('settings-warning').textContent, /jen náhled/); await dom.form.emit('submit'); assert.equal(writes, 0);
});
