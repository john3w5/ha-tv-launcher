import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const moduleSource = await readFile(new URL('../public/notice-preferences.js', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-23T18:00:00Z');
const defaultPreferences = () => ({ enabled: true, kino: false, kinoEnabled: false, kinoUntil: 0, snoozed: false, snoozedUntil: 0, active: false, persistent: true, scope: 'session' });

// Extract actual function declarations rather than reproducing startup logic. The
// scanner ignores quoted strings/comments and supports multiline declarations.
function declaration(name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\s*\\(', 'm').exec(app);
  assert.ok(match, 'Actual app declaration must exist: ' + name);
  const start = match.index, body = app.indexOf('{', start);
  let depth = 0, quote = '', comment = '';
  for (let index = body; index < app.length; index++) {
    const character = app[index], next = app[index + 1];
    if (comment === '//') { if (character === '\n') comment = ''; continue; }
    if (comment === '/*') { if (character === '*' && next === '/') { comment = ''; index++; } continue; }
    if (quote) { if (character === '\\') index++; else if (character === quote) quote = ''; continue; }
    if (character === '/' && (next === '/' || next === '*')) { comment = '/' + next; index++; continue; }
    if (['"', "'", '`'].includes(character)) { quote = character; continue; }
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return app.slice(start, index + 1);
  }
  throw new Error('Unterminated actual app declaration: ' + name);
}
const startup = ['notificationPreferenceRequest', 'configureNoticePreferences', 'initialize'].map(declaration).join('\n');

function harness(bootstrap, { isTv = true } = {}) {
  let currentBootstrap = bootstrap, remoteState = defaultPreferences(), storageReads = 0;
  const requests = [], refreshStates = [], changes = [];
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
  const state = { mode: 'loading', bootstrap: { apps: [] }, photos: [], data: null };
  const sandbox = {
    state, isTv, Date: ClockDate, document: { title: 'Home TV TV', documentElement: { dataset: {} } },
    get localStorage() { storageReads++; throw Error('App startup preferences must use the server adapter'); },
    renderIdentity() {}, normalize: value => value, unavailableData: mode => ({ mode: mode || 'setup' }), updateBadges() {}, render() {},
    loadTvApps() {}, async refresh() { refreshStates.push(sandbox.NoticePreferences.getState()); },
    resetPhotoTimer() {}, connectEvents() {}, nextPhoto() {}, async ensureHls() {}, requestIdleCallback() {},
    updateNoticeIndicator() { changes.push(sandbox.NoticePreferences.getState()); },
    $: () => ({ textContent: '' }),
    async fetch(url, options = {}) {
      requests.push({ url, options });
      if (url === '/api/bootstrap') return { ok: true, json: async () => currentBootstrap };
      if (url === '/api/photos') return { ok: true, json: async () => ({ photos: [] }) };
      if (url === '/api/notification-preferences') {
        if (options.method === 'POST') {
          const action = JSON.parse(options.body);
          remoteState = action.action === 'kino' && action.enabled ? { ...defaultPreferences(), kino: true, kinoEnabled: true, kinoUntil: NOW + 3600000, active: true } : defaultPreferences();
        }
        return { ok: true, json: async () => remoteState };
      }
      throw new Error('Unexpected request during isolated app startup: ' + url);
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(moduleSource, sandbox);
  vm.runInNewContext(startup, sandbox);
  return { ui: sandbox, state, requests, refreshStates, changes, get storageReads() { return storageReads; }, setBootstrap(value) { currentBootstrap = value; } };
}

for (const target of [{ label: 'live Android TV', isTv: true, scope: 'tv' }, { label: 'read-only live browser preview', isTv: false, scope: 'preview', preview: { readOnly: true } }]) {
  test('actual initialize enables the server-backed policy for ' + target.label, async () => {
    const initial = defaultPreferences();
    const h = harness({ mode: 'live', authenticated: true, notificationPreferences: initial, ...(target.preview ? { preview: target.preview } : {}) }, target);
    assert.equal(h.ui.NoticePreferences.getState().enabled, false, 'Real module starts disabled before actual app initialize');
    await h.ui.initialize();
    const policy = h.ui.NoticePreferences.getState();
    assert.equal(h.state.mode, 'live'); assert.equal(policy.enabled, true); assert.equal(policy.remote, true); assert.equal(policy.scope, target.scope);
    if (target.preview) assert.equal(h.ui.document.documentElement.dataset.performance, 'fast');
    assert.equal(h.refreshStates[0].enabled, true, 'Configure must occur before the first dashboard refresh');
    assert.equal(h.storageReads, 0); assert.equal(h.requests.filter(request => request.url === '/api/notification-preferences').length, 0, 'Bootstrap hydration must not send a default state or redundant GET');
    await h.ui.NoticePreferences.setKino(true);
    const post = h.requests.find(request => request.options.method === 'POST');
    assert.equal(post.url, '/api/notification-preferences'); assert.deepEqual(JSON.parse(post.options.body), { action: 'kino', enabled: true });
    assert.equal(h.ui.NoticePreferences.getState().kinoEnabled, true);
    await h.ui.NoticePreferences.refresh();
    assert.equal(h.requests.at(-1).url, '/api/notification-preferences'); assert.notEqual(h.requests.at(-1).options.method, 'POST');
  });
}

test('actual initialize loads server preferences when bootstrap has no seed', async () => {
  const h = harness({ mode: 'live', authenticated: true });
  await h.ui.initialize(); await h.ui.NoticePreferences.refresh();
  const reads = h.requests.filter(request => request.url === '/api/notification-preferences');
  assert.ok(reads.length >= 1); assert.equal(reads.some(request => request.options.method === 'POST'), false);
  assert.equal(h.ui.NoticePreferences.getState().remote, true); assert.equal(h.ui.NoticePreferences.getState().pending, false);
});

for (const bootstrap of [{ mode: 'setup', authenticated: false }, { mode: 'setup', authenticated: true }, { mode: 'live', authenticated: false }]) {
  test('actual initialize leaves setup/unauthenticated policy disabled: ' + JSON.stringify(bootstrap), async () => {
    const h = harness(bootstrap); await h.ui.initialize();
    assert.equal(h.state.mode, 'setup'); assert.equal(h.ui.NoticePreferences.getState().enabled, false);
    h.ui.NoticePreferences.setKino(true); h.ui.NoticePreferences.snooze60();
    assert.equal(h.ui.NoticePreferences.getState().active, false);
    assert.deepEqual(h.requests.map(request => request.url), ['/api/bootstrap']);
    assert.equal(h.storageReads, 0); assert.equal(h.refreshStates.length, 0);
  });
}

test('app reinitialization after lost pairing disables a previously active TV policy without a POST', async () => {
  const h = harness({ mode: 'live', authenticated: true, notificationPreferences: { ...defaultPreferences(), kino: true, kinoEnabled: true, kinoUntil: NOW + 3600000, active: true } });
  await h.ui.initialize(); assert.equal(h.ui.NoticePreferences.getState().active, true);
  h.setBootstrap({ mode: 'live', authenticated: false }); await h.ui.initialize();
  assert.equal(h.state.mode, 'setup'); assert.equal(h.ui.NoticePreferences.getState().enabled, false); assert.equal(h.ui.NoticePreferences.getState().active, false);
  assert.equal(h.requests.some(request => request.options.method === 'POST'), false);
});
