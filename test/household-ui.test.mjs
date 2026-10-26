import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/household-ui.js', import.meta.url), 'utf8');

// A deliberately small dialog surface: exercise real UI callbacks/network boundaries,
// without an HA server, a browser, a TV, or a copy of the confirmation algorithm.
function harness({ commit, prepare } = {}) {
  let now = Date.parse('2026-10-23T18:00:00Z'), nextTimer = 0, prepared = 0;
  const nodes = new Map(), intervals = new Map(), requests = [], notices = [];
  let focused = null;
  class Node {
    constructor(id) { this.id = id; this.isConnected = true; this.disabled = false; this.children = []; this.textContent = ''; this._html = ''; }
    set innerHTML(value) {
      this._html = String(value);
      for (const child of this.children) child.disconnect();
      this.children = [];
      for (const match of this._html.matchAll(/\bid="([^"]+)"/g)) {
        const child = new Node(match[1]); nodes.set(child.id, child); this.children.push(child);
      }
    }
    get innerHTML() { return this._html; }
    disconnect() { this.isConnected = false; for (const child of this.children) child.disconnect(); if (nodes.get(this.id) === this) nodes.delete(this.id); }
    focus() { focused = this; }
  }
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  function close() { for (const node of [...nodes.values()]) node.disconnect(); nodes.clear(); }
  const sandbox = {
    Date: ClockDate,
    state: { mode: 'live', data: { household: {} } },
    document: { addEventListener() {} },
    window: {},
    $: selector => nodes.get(selector.slice(1)) || null,
    icon: () => '<svg aria-hidden="true"></svg>',
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    showDialog() { close(); nodes.set('night-plan', new Node('night-plan')); },
    notify: value => notices.push(value),
    setInterval(callback) { const id = ++nextTimer; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout() { throw new Error('No confetti/timer side effects expected from night confirmation'); },
    clearTimeout() {},
    async fetch(url, options) {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (url === '/api/night/prepare') {
        const body = prepare ? await prepare(++prepared, now) : { confirmationId: String(++prepared).padStart(32, 'a'), expiresAt: new Date(now + 20000).toISOString(), requiresTripleClick: true, routineName: 'Dobrou noc', plan: [{ title: 'Vypnout TV' }] };
        return { ok: true, json: async () => body };
      }
      if (url === '/api/night/commit') {
        return commit ? commit(requests.at(-1)) : { ok: true, json: async () => ({ accepted: true, verified: false }) };
      }
      throw new Error('Unexpected UI request: ' + url);
    }
  };
  vm.runInNewContext(source, sandbox);
  return {
    ui: sandbox, nodes, requests, notices, close, intervals,
    get focused() { return focused; },
    tick(milliseconds) { now += milliseconds; for (const callback of [...intervals.values()]) callback(); },
    commits() { return requests.filter(request => request.url === '/api/night/commit'); },
    click(detail = 0) { return nodes.get('night-confirm')?.onclick({ detail }); }
  };
}

test('night preview alone and the first two remote OK clicks never invoke the macro', async () => {
  const h = harness(); await h.ui.showNight();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, '/api/night/prepare');
  assert.equal(h.focused, h.nodes.get('night-confirm'));
  await h.click(); await h.click();
  assert.equal(h.commits().length, 0);
  assert.match(h.nodes.get('night-confirm').innerHTML, /2\/3/);
});

test('exactly three distinct remote OK clicks commit only the prepared opaque ID', async () => {
  const h = harness(); await h.ui.showNight();
  await h.click(); await h.click(); await h.click(); await h.click();
  assert.equal(h.commits().length, 1);
  assert.deepEqual(Object.keys(h.commits()[0].body), ['confirmationId']);
  assert.equal(h.commits()[0].body.confirmationId.length, 32);
  assert.equal(h.nodes.get('night-confirm').disabled, true);
  assert.match(h.nodes.get('night-result').textContent, /HA přijal/);
  assert.match(h.nodes.get('night-result').textContent, /ověřují až nové stavy/);
  assert.equal(h.intervals.size, 0);
});

test('a normal pointer triple click with browser detail 1,2,3 also commits exactly once', async () => {
  const h = harness(); await h.ui.showNight();
  await h.click(1); await h.click(2); await h.click(3);
  assert.equal(h.commits().length, 1);
});

test('held Enter/Space repeat events suppress browser activation without counting a click', async () => {
  const h = harness(); await h.ui.showNight();
  const button = h.nodes.get('night-confirm');
  for (const key of ['Enter', ' ']) for (let i = 0; i < 5; i++) {
    let prevented = false, stopped = false;
    button.onkeydown({ key, repeat: true, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert.equal(prevented, true); assert.equal(stopped, true);
  }
  assert.equal(h.commits().length, 0);
  assert.match(button.innerHTML || h.nodes.get('night-plan').innerHTML, /0\/3/);
});

test('expired preview disables confirmation and cannot commit even with two previous clicks', async () => {
  const h = harness(); await h.ui.showNight();
  await h.click(); await h.click(); h.tick(20001);
  assert.equal(h.nodes.get('night-confirm').disabled, true);
  assert.match(h.nodes.get('night-result').textContent, /vypršelo/);
  await h.click();
  assert.equal(h.commits().length, 0); assert.equal(h.intervals.size, 0);
});

test('closing a preview cancels its timer and ignores further callbacks on detached button', async () => {
  const h = harness(); await h.ui.showNight();
  const detached = h.nodes.get('night-confirm');
  h.close(); h.tick(250);
  await detached.onclick({ detail: 0 });
  assert.equal(h.commits().length, 0); assert.equal(h.intervals.size, 0);
});

test('commit remains single-flight during a slow backend response', async () => {
  let finish;
  const h = harness({ commit: () => new Promise(resolve => { finish = resolve; }) });
  await h.ui.showNight(); await h.click(); await h.click();
  const pending = h.click();
  await h.click(); await h.click();
  assert.equal(h.commits().length, 1);
  finish({ ok: true, json: async () => ({ accepted: true, verified: false }) }); await pending;
  assert.equal(h.commits().length, 1);
});

test('late result of an older commit cannot overwrite or cancel a newly opened preview', async () => {
  let finish;
  const h = harness({ commit: () => new Promise(resolve => { finish = resolve; }) });
  await h.ui.showNight(); await h.click(); await h.click(); const oldCommit = h.click();
  await h.ui.showNight();
  const newResult = h.nodes.get('night-result');
  finish({ ok: true, json: async () => ({ accepted: true, verified: false }) }); await oldCommit;
  assert.equal(newResult.textContent, '');
  await h.click(); await h.click(); const nextCommit = h.click();
  assert.equal(h.commits().length, 2);
  assert.notEqual(h.commits()[0].body.confirmationId, h.commits()[1].body.confirmationId);
  finish({ ok: true, json: async () => ({ accepted: true, verified: false }) }); await nextCommit;
});

test('failed commit reports the failure and does not automatically retry the physical macro', async () => {
  const h = harness({ commit: async () => ({ ok: false, json: async () => ({ error: 'Potvrzení vypršelo.' }) }) });
  await h.ui.showNight(); await h.click(); await h.click(); await h.click(); await h.click();
  assert.equal(h.commits().length, 1); assert.equal(h.notices.length, 0);
  assert.equal(h.nodes.get('night-result').textContent, 'Potvrzení vypršelo.');
});

test('a prepare response arriving after its dialog closed cannot create a confirmation UI', async () => {
  let finish;
  const h = harness({ prepare: () => new Promise(resolve => { finish = resolve; }) });
  const pending = h.ui.showNight(); h.close();
  finish({ confirmationId: 'a'.repeat(32), expiresAt: '2026-10-23T18:00:20Z', requiresTripleClick: true, plan: [] }); await pending;
  assert.equal(h.nodes.size, 0); assert.equal(h.commits().length, 0); assert.equal(h.intervals.size, 0);
});

test('malformed or expired prepare contracts fail closed with no confirmation button', async () => {
  const valid = { confirmationId: 'a'.repeat(32), expiresAt: '2026-10-23T18:00:20Z', requiresTripleClick: true, plan: [] };
  const invalid = [
    { confirmationId: '' }, { confirmationId: '<unsafe>' }, { confirmationId: 'a'.repeat(129) },
    { expiresAt: 'invalid' }, { expiresAt: null }, { expiresAt: '2026-10-23T18:00:00Z' },
    { expiresAt: '2026-10-22T18:00:00Z' }, { requiresTripleClick: false }, { requiresTripleClick: null }
  ];
  for (const change of invalid) {
    const h = harness({ prepare: async () => ({ ...valid, ...change }) }); await h.ui.showNight();
    assert.equal(h.nodes.has('night-confirm'), false, JSON.stringify(change));
    assert.equal(h.intervals.size, 0); assert.equal(h.commits().length, 0);
    assert.match(h.nodes.get('night-plan').innerHTML, /state-warning/);
  }
});


test('live read-only preview shows the existing night plan without preparing or committing an action',async()=>{
 const h=harness();h.ui.state.bootstrap={preview:{readOnly:true}};
 h.ui.state.data.household.night={plan:[{name:'Vypnout TV'}],warnings:['Ukázka pouze pro čtení']};
 await h.ui.showNight();
 assert.equal(h.requests.length,0);assert.equal(h.commits().length,0);assert.equal(h.nodes.has('night-confirm'),false);
});
