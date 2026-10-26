import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/notice-preferences.js', import.meta.url), 'utf8');
const KEY = 'home-tv.notice-preferences.v1', HOUR = 3600000;
const START = Date.parse('2026-10-23T18:00:00Z');
function memory(initial) {
  const values = new Map(initial === undefined ? [] : [[KEY, initial]]), calls = [];
  return { values, calls, getItem(key) { calls.push(['get', key]); return values.get(key) ?? null; }, setItem(key, value) { calls.push(['set', key, value]); values.set(key, value); } };
}
function harness(storage = memory()) {
  let now = START, timerId = 0;
  const timers = new Map();
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const sandbox = { Date: ClockDate, localStorage: storage, setInterval(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearInterval(id) { timers.delete(id); } };
  vm.runInNewContext(source, sandbox);
  return { api: sandbox.NoticePreferences, storage, timers, advance(ms) { now += ms; }, setTime(value) { now = value; }, tick() { for (const fn of [...timers.values()]) fn(); }, factory() { return sandbox.NoticePreferences.create({ storage, now: () => now }); } };
}
const ordinary = { id: 'ordinary-note', source: 'home_assistant', type: 'info', message: 'Běžná zpráva' };

test('loading the classic script and disabled production policy never read/write localStorage', () => {
  const h = harness();
  assert.equal(Object.isFrozen(h.api), true);
  assert.equal(h.api.allows(ordinary), true);
  h.api.configure({ enabled: false }); h.api.setKino(true); h.api.snooze60(); h.api.resume();
  assert.equal(h.api.getState().active, false); assert.equal(h.api.dialogMarkup(), '');
  assert.equal(h.storage.calls.length, 0); assert.equal(h.timers.size, 0);
});

test('Kino hides ordinary/info and generic warning banners but preserves explicit exceptions', () => {
  const h = harness(); h.api.configure({ enabled: true }); h.api.setKino(true);
  assert.equal(h.api.allows(ordinary), false);
  assert.equal(h.api.allows({ type: 'warning', title: 'Únik vody', message: 'Text sám nestačí' }), false);
  assert.equal(h.api.allows({ type: 'urgent' }), true);
  assert.equal(h.api.allows({ eventType: 'doorbell', type: 'info' }), true);
  assert.equal(h.api.allows({ id: 'house-washer-leak', source: 'home_assistant', type: 'warning' }), true);
  assert.equal(h.api.allows({ id: 'house-washer-finished', source: 'home_assistant', type: 'info' }), true);
  assert.equal(h.api.allows({ id: 'house-washer-leak', source: 'other', type: 'warning' }), false);
  assert.equal(h.api.allows({ id: 'house-washer-leak-extra', source: 'home_assistant' }), false);
  assert.equal(h.api.allows(null), false);
});

test('snooze expires at one absolute hour; reads/repeated activation/reload do not extend it', () => {
  const h = harness(); const p = h.factory(); p.configure({ enabled: true }); p.snooze60();
  const deadline = p.getState().snoozedUntil; assert.equal(deadline, START + HOUR);
  h.advance(19 * 60000); assert.equal(p.getState().remainingMinutes, 41);
  p.snooze60(); assert.equal(p.getState().snoozedUntil, deadline);
  const reloaded = h.factory(); reloaded.configure({ enabled: true }); assert.equal(reloaded.getState().snoozedUntil, deadline);
  h.advance(41 * 60000 - 1); assert.equal(reloaded.allows(ordinary), false);
  h.advance(1); assert.equal(reloaded.allows(ordinary), true); assert.equal(reloaded.getState().remainingMinutes, 0);
  assert.equal(JSON.parse(h.storage.values.get(KEY)).snoozedUntil, 0);
});

test('Kino survives a snooze expiry and resume explicitly restores both modes', () => {
  const h = harness(); h.api.configure({ enabled: true }); h.api.setKino(true, 120); h.api.snooze60();
  h.advance(HOUR); assert.equal(h.api.getState().snoozed, false); assert.equal(h.api.getState().kinoEnabled, true);
  assert.equal(h.api.allows(ordinary), false);
  h.api.resume(); assert.equal(h.api.getState().active, false); assert.equal(h.api.allows(ordinary), true);
  const reloaded = h.factory(); reloaded.configure({ enabled: true }); assert.equal(reloaded.getState().active, false);
});

test('malformed preferences cannot create a permanent or extended snooze', () => {
  const valid = { version: 1, kino: false, snoozedAt: START, snoozedUntil: START + HOUR };
  const invalid = ['invalid', '[]', 'null', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, kino: 'true' }),
    JSON.stringify({ ...valid, snoozedUntil: START + HOUR * 2 }), JSON.stringify({ ...valid, snoozedAt: START + HOUR, snoozedUntil: START + HOUR * 2 }),
    JSON.stringify({ ...valid, snoozedAt: '0', snoozedUntil: START + HOUR }), JSON.stringify({ ...valid, snoozedAt: START - HOUR, snoozedUntil: START })];
  for (const raw of invalid) {
    const h = harness(memory(raw)); h.api.configure({ enabled: true });
    assert.equal(h.api.getState().snoozed, false, raw); assert.equal(h.api.allows(ordinary), true, raw);
  }
});

test('snooze crosses local midnight and DST as elapsed time rather than wall-clock arithmetic', () => {
  for (const instant of ['2026-10-23T23:40:00+02:00', '2026-03-29T01:40:00+01:00', '2026-10-25T02:40:00+02:00']) {
    const h = harness(); h.setTime(Date.parse(instant)); h.api.configure({ enabled: true });
    const state = h.api.snooze60(); assert.equal(state.snoozedUntil, Date.parse(instant) + HOUR);
    h.advance(HOUR - 1); assert.equal(h.api.allows(ordinary), false);
    h.advance(1); assert.equal(h.api.allows(ordinary), true);
  }
});

test('major backward clock correction discards snooze instead of extending beyond one hour', () => {
  const h = harness(); h.api.configure({ enabled: true }); h.api.snooze60(); h.advance(-10 * 60000);
  assert.equal(h.api.getState().snoozed, false); assert.equal(h.api.allows(ordinary), true);
});

test('unavailable/quota-limited storage preserves in-memory controls with truthful persistence flag', () => {
  for (const storage of [{ getItem() { throw new Error('Denied'); }, setItem() {} }, { getItem() { return null; }, setItem() { throw new Error('Quota'); } }]) {
    const h = harness(storage); h.api.configure({ enabled: true }); h.api.setKino(true);
    assert.equal(h.api.getState().persistent, false); assert.equal(h.api.allows(ordinary), false);
    h.api.resume(); assert.equal(h.api.allows(ordinary), true);
  }
});

test('callbacks report only client policy changes/expiry and a throwing UI callback is isolated', () => {
  const h = harness(), changes = [];
  h.api.configure({ enabled: true, onChange: state => changes.push({ active: state.active, minutes: state.remainingMinutes }) });
  h.api.snooze60(); h.advance(HOUR); h.api.getState();
  assert.equal(changes.at(-1).active, false); assert.ok(changes.some(state => state.minutes === 60));
  h.api.configure({ enabled: true, onChange() { throw new Error('UI'); } });
  assert.doesNotThrow(() => h.api.setKino(true)); assert.equal(h.api.getState().kinoEnabled, true);
});

test('preferences remain isolated to their supplied origin storage and never mutate notices', () => {
  const a = harness(), b = harness(); a.api.configure({ enabled: true }); b.api.configure({ enabled: true }); a.api.setKino(true);
  const original = Object.freeze({ ...ordinary });
  assert.equal(a.api.allows(original), false); assert.equal(b.api.allows(original), true);
  assert.deepEqual(original, ordinary); assert.equal(b.api.getState().kinoEnabled, false);
});

test('dialog is explicitly local, exposes switch state and does not turn warnings into urgent', () => {
  const h = harness(); h.api.configure({ enabled: true }); h.api.setKino(true);
  const markup = h.api.dialogMarkup();
  assert.match(markup, /role="switch" aria-checked="true"/); assert.match(markup, /Jen tento náhled/);
  assert.match(markup, /Centrum oznámení zůstává dostupné/); assert.match(markup, /neovládá HA/);
  assert.doesNotMatch(markup, /onclick=|<script|https?:\/\//);
});

test('bound controls update ARIA, block held-key repeat and clean up after dialog detaches', () => {
  const h = harness(); h.api.configure({ enabled: true });
  const handlers = new Map(), buttons = Object.fromEntries(['kino', 'snooze', 'resume'].map(action => [action, {
    dataset: { noticePref: action }, disabled: false, attributes: {}, textContent: '', setAttribute(key, value) { this.attributes[key] = value; }, closest() { return this; }
  }]));
  const line = { textContent: '' };
  const panel = { isConnected: true, matches: () => true, contains: button => Object.values(buttons).includes(button),
    querySelector(selector) { if (selector === '.notice-preferences-status') return line; return buttons[/="([^"]+)"/.exec(selector)?.[1]] || null; },
    addEventListener(type, fn) { handlers.set(type, fn); }, removeEventListener(type) { handlers.delete(type); } };
  const cleanup = h.api.bind(panel);
  handlers.get('click')({ target: buttons.kino }); assert.equal(buttons.kino.attributes['aria-checked'], 'true');
  handlers.get('click')({ target: buttons.snooze }); assert.equal(buttons.snooze.disabled, true);
  let prevented = false, stopped = false;
  handlers.get('keydown')({ target: buttons.kino, key: 'Enter', repeat: true, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true);
  h.advance(HOUR); h.tick(); assert.equal(buttons.snooze.disabled, false);
  handlers.get('click')({ target: buttons.resume }); assert.equal(h.api.getState().active, false);
  panel.isConnected = false; h.tick(); cleanup(); assert.equal(handlers.size, 0); assert.equal(h.timers.size, 0);
});

function remoteState({ kinoUntil = 0, snoozedUntil = 0 } = {}) {
  return { enabled: true, kino: kinoUntil > 0, kinoEnabled: kinoUntil > 0, kinoUntil,
    snoozed: snoozedUntil > 0, snoozedUntil, active: kinoUntil > 0 || snoozedUntil > 0, persistent: true, scope: 'session' };
}

test('remote mode seeds bootstrap state without localStorage or an accidental preference POST', async () => {
  const h = harness(), saves = [], changes = [];
  const adapter = { async load() { return remoteState(); }, async save(action) { saves.push(action); return remoteState(); } };
  h.api.configure({ enabled: true, scope: 'tv', remote: adapter, initial: remoteState({ kinoUntil: START + HOUR }), onChange: state => changes.push(state.active) });
  assert.equal(h.api.getState().active, true); assert.equal(h.api.getState().scope, 'tv');
  assert.equal(h.storage.calls.length, 0); assert.equal(saves.length, 0);
  assert.match(h.api.dialogMarkup(), /Tato TV a její překryvy/); assert.match(h.api.dialogMarkup(), /Délka Kina/);
  h.api.applyRemote(remoteState()); assert.equal(h.api.getState().active, false); assert.equal(saves.length, 0);
  assert.ok(changes.includes(true)); assert.equal(changes.at(-1), false);
});

test('remote actions wait for server acceptance, remain single-flight and send only strict action fields', async () => {
  const h = harness(), actions = []; let finish;
  h.api.configure({ enabled: true, scope: 'tv', initial: remoteState(), remote: {
    async load() { return remoteState(); }, save(action) { actions.push(action); return new Promise(resolve => { finish = resolve; }); }
  } });
  const first = h.api.setKino(true); const duplicate = h.api.setKino(true);
  assert.equal(h.api.getState().pending, true); assert.equal(h.api.getState().active, false); assert.equal(h.api.allows(ordinary), true);
  await Promise.resolve(); assert.equal(actions.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(actions[0])), { action: 'kino', enabled: true });
  finish(remoteState({ kinoUntil: START + HOUR })); await first; await duplicate;
  assert.equal(h.api.getState().pending, false); assert.equal(h.api.allows(ordinary), false); assert.equal(h.storage.calls.length, 0);
  h.advance(HOUR); assert.equal(h.api.getState().kinoEnabled, false); assert.equal(h.api.allows(ordinary), true);
});

test('failed or malformed remote responses never optimistically mute and expose a retryable status', async () => {
  for (const save of [async () => { throw Error('Network'); }, async () => remoteState({ kinoUntil: START + HOUR * 2 })]) {
    const h = harness(); h.api.configure({ enabled: true, scope: 'tv', initial: remoteState(), remote: { load: async () => remoteState(), save } });
    await h.api.snooze60(); assert.equal(h.api.getState().active, false); assert.equal(h.api.getState().pending, false);
    assert.ok(h.api.getState().error); assert.equal(h.api.allows(ordinary), true);
    await h.api.refresh(); assert.equal(h.api.getState().error, '');
  }
});

test('remote hydration/refresh preserves absolute deadlines, ignores late results after disable and never writes localStorage', async () => {
  const h = harness(); let finish;
  h.api.configure({ enabled: true, scope: 'screen', remote: { load: () => new Promise(resolve => { finish = resolve; }), save: async () => remoteState() } });
  assert.equal(h.api.getState().pending, true); await Promise.resolve();
  const loading = h.api.refresh(); h.api.configure({ enabled: false });
  finish(remoteState({ kinoUntil: START + HOUR })); await loading;
  assert.equal(h.api.getState().active, false); assert.equal(h.storage.calls.length, 0);
  const adapter = { load: async () => remoteState(), save: async () => remoteState() };
  h.api.configure({ enabled: true, scope: 'screen', remote: adapter, initial: remoteState({ snoozedUntil: START + HOUR }) });
  const deadline = h.api.getState().snoozedUntil; h.advance(15 * 60000);
  h.api.applyRemote(remoteState({ snoozedUntil: deadline })); assert.equal(h.api.getState().remainingMinutes, 45);
  assert.equal(h.api.getState().snoozedUntil, deadline);
});

test('chosen Kino duration stays bounded, survives reload and does not slide on repeated activation', async () => {
  const h = harness(); const p = h.factory(); p.configure({ enabled: true });
  p.setKino(true, 120); const until = p.getState().kinoUntil; assert.equal(until, START + 2 * HOUR);
  h.advance(10 * 60000); p.setKino(true, 120); assert.equal(p.getState().kinoUntil, until);
  const reloaded = h.factory(); reloaded.configure({ enabled: true }); assert.equal(reloaded.getState().kinoUntil, until);
  for (const value of [0, 1441, 1.5, '120', NaN]) { reloaded.setKino(true, value); assert.equal(reloaded.getState().kinoUntil, until); }
  reloaded.setKino(true, 30); assert.equal(reloaded.getState().kinoUntil, START + 40 * 60000);
  h.advance(30 * 60000); assert.equal(reloaded.getState().kino, false); assert.equal(reloaded.allows(ordinary), true);
});

test('remote Kino sends chosen minutes and accepts the server verified start/duration without local storage', async () => {
  const h = harness(), actions = [];
  h.api.configure({ enabled: true, scope: 'tv', initial: remoteState(), remote: { load: async () => remoteState(), save: async action => {
    actions.push(action); return { ...remoteState({ kinoUntil: START + 2 * HOUR }), kinoStartedAt: START, kinoDurationMinutes: 120 };
  } } });
  await h.api.setKino(true, 120);
  assert.deepEqual(JSON.parse(JSON.stringify(actions[0])), { action: 'kino', enabled: true, minutes: 120 });
  assert.equal(h.api.getState().kinoDurationMinutes, 120); assert.equal(h.api.getState().remainingMinutes, 120);
  assert.equal(h.storage.calls.length, 0); h.advance(2 * HOUR); assert.equal(h.api.getState().active, false);
});
