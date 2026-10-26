import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantService } from '../lib/assistant-service.mjs';
import { createBridge } from '../server.mjs';

const APP = 'cz.iprima.app';
const action = (type, extra = {}) => ({ type, key: null, appId: null, query: null, selection: null, ...extra });
const plan = (actions = [], extra = {}) => ({ reply: 'Navrhnu tento postup.', actions, needsConfirmation: false, ...extra });
const search = () => plan([action('launch_app', { appId: APP }), action('search_content', { appId: APP, query: 'Zrádci', selection: 'latest' })], { needsConfirmation: true });
const isCode = code => error => error.code === code;
function fixture({ planner = async () => plan([action('key', { key: 'pause' })]), contentAdapter } = {}) {
  const calls = [];
  const control = {
    listApps: async () => ({ apps: [{ appId: APP, name: 'prima+', component: 'private-detail', token: 'do-not-forward' }] }),
    key: async args => { calls.push({ type: 'key', ...args }); return { ok: true, accepted: true, verifiedScreen: false }; },
    launchApp: async args => { calls.push({ type: 'launch_app', ...args }); return { ok: true, accepted: true, verifiedForeground: false }; },
  };
  return { control, calls, service: createAssistantService({ control, planner, contentAdapter }) };
}

test('AI receives public app names only; accepted keys do not claim screen verification', async () => {
  const f = fixture({ planner: async input => {
    assert.deepEqual(input, { text: 'Pauza', apps: [{ appId: APP, label: 'prima+' }] });
    return plan([action('key', { key: 'pause' })]);
  } });
  const result = await f.service.request({ text: 'Pauza', session: 'a' });
  assert.equal(result.status, 'complete');
  assert.equal(result.completed[0].result.verifiedScreen, false);
  assert.deepEqual(f.calls, [{ type: 'key', key: 'pause' }]);
});

test('confirmation is session bound, expires at deadline and cannot be replayed', async t => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture({ planner: async () => plan([action('launch_app', { appId: APP })], { needsConfirmation: true }) });
  const pending = await f.service.request({ text: 'Otevři prima+', session: 'a' });
  assert.equal(pending.status, 'confirmation');
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.confirm({ id: pending.confirmationId, session: 'b' }), isCode('confirmation_invalid'));
  assert.equal((await f.service.confirm({ id: pending.confirmationId, session: 'a' })).status, 'complete');
  await assert.rejects(f.service.confirm({ id: pending.confirmationId, session: 'a' }), isCode('confirmation_invalid'));
  const expired = await f.service.request({ text: 'Otevři prima+', session: 'a' });
  now += 120000;
  await assert.rejects(f.service.confirm({ id: expired.confirmationId, session: 'a' }), isCode('confirmation_invalid'));
  assert.equal(f.calls.length, 1);
});

test('unsupported search or failed preview never partially launches the app', async () => {
  for (const contentAdapter of [
    null,
    async () => assert.fail('execute-only adapter must not run during preview'),
    { preview: async () => ({ supported: false }), execute: async () => assert.fail('must not execute') },
    { preview: async () => { throw new Error('private upstream error'); }, execute: async () => assert.fail('must not execute') },
  ]) {
    const f = fixture({ planner: async () => search(), contentAdapter });
    const result = await f.service.request({ text: 'Pusť poslední Zrádce', session: 'a' });
    assert.equal(result.status, 'unsupported');
    assert.deepEqual(result.completed, []);
    assert.equal(result.confirmationId, undefined);
    assert.equal(f.calls.length, 0);
  }
});

test('content preview is read-only and playback waits for the owning session confirmation', async () => {
  const steps = [];
  const resolved = { supported: true, title: 'Zrádci — kandidát' };
  const f = fixture({ planner: async () => search(), contentAdapter: {
    preview: async input => { steps.push('preview'); assert.equal(input.selection, 'latest'); return resolved; },
    execute: async (input, preview) => { steps.push('execute'); assert.equal(preview, resolved); return { ok: true, accepted: true, verifiedPlayback: false }; },
  } });
  const pending = await f.service.request({ text: 'Najdi Zrádce', session: 'a' });
  assert.equal(pending.status, 'confirmation');
  assert.deepEqual(steps, ['preview']);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.confirm({ id: pending.confirmationId, session: 'b' }), isCode('confirmation_invalid'));
  const result = await f.service.confirm({ id: pending.confirmationId, session: 'a' });
  assert.equal(result.status, 'complete');
  assert.deepEqual(steps, ['preview', 'execute']);
  assert.equal(f.calls.length, 1);
  assert.equal(result.completed[1].result.verifiedPlayback, false);
});

test('busy rejection preserves confirmation and planner failure releases the busy slot', async () => {
  let release, signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const f = fixture({ planner: async ({ text }) => {
    if (text === 'čekej') { signalStarted(); return new Promise(resolve => { release = resolve; }); }
    if (text === 'chyba') throw new Error('model failed');
    return plan([action('key', { key: 'pause' })], { needsConfirmation: true });
  } });
  const pending = await f.service.request({ text: 'potvrdit', session: 'a' });
  const hold = f.service.request({ text: 'čekej', session: 'b' });
  await started;
  await assert.rejects(f.service.confirm({ id: pending.confirmationId, session: 'a' }), isCode('assistant_busy'));
  await assert.rejects(f.service.request({ text: 'třetí', session: 'c' }), isCode('assistant_busy'));
  release(plan()); await hold;
  assert.equal((await f.service.confirm({ id: pending.confirmationId, session: 'a' })).status, 'complete');
  await assert.rejects(f.service.request({ text: 'chyba', session: 'a' }));
  assert.equal((await f.service.request({ text: 'další', session: 'a' })).status, 'confirmation');
});

test('negative or missing action outcomes cannot complete; partial accepted steps are retained', async () => {
  for (const outcome of [{ ok: false, accepted: false }, { supported: false, executed: false }, null, {}]) {
    const f = fixture();
    f.control.key = async () => outcome;
    const result = await f.service.request({ text: 'Pauza', session: 'a' });
    assert.equal(result.status, 'failed');
    assert.equal(result.completed.length, 0);
    assert.equal(result.error.code, 'action_not_accepted');
    f.control.key = async () => ({ ok: true, accepted: true });
    assert.equal((await f.service.request({ text: 'Pauza', session: 'a' })).status, 'complete');
  }
  const f = fixture({ planner: async () => plan([action('launch_app', { appId: APP }), action('key', { key: 'pause' })]) });
  f.control.key = async () => { throw new Error('HA_TOKEN=secret'); };
  const result = await f.service.request({ text: 'Otevři a pozastav', session: 'a' });
  assert.equal(result.status, 'failed');
  assert.equal(result.completed.length, 1);
  assert.equal(result.pending.length, 1);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('negative content outcome is not a false playback completion', async () => {
  const f = fixture({ planner: async () => search(), contentAdapter: {
    preview: async () => ({ supported: true }), execute: async () => ({ supported: false, executed: false }),
  } });
  const pending = await f.service.request({ text: 'Najdi Zrádce', session: 'a' });
  const result = await f.service.confirm({ id: pending.confirmationId, session: 'a' });
  assert.equal(result.status, 'failed');
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].type, 'launch_app');
  assert.equal(result.pending[0].type, 'search_content');
});

test('clarification has no executable confirmation; session is required', async () => {
  const f = fixture({ planner: async () => plan([action('clarify')], { reply: 'Kterou aplikaci?', needsConfirmation: true }) });
  const result = await f.service.request({ text: 'Otevři něco', session: 'a' });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.confirmationId, undefined);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.request({ text: 'Pauza' }), isCode('session_required'));
});

test('assistant API requires session and same Origin before any real ADB or Codex call', async t => {
  const root = await mkdtemp(join(tmpdir(), 'domov-assistant-http-'));
  const bridge = await createBridge({ root, config: { apps: [], entities: {} }, env: {
    PORT: '4317', TV_CLIENT_TOKEN: 'test-pairing-code', TV_CONTROL_ENABLED: '1',
    TV_ADB_SERIAL: 'mock-device', ADB_PATH: '/does-not-run/adb', CODEX_PATH: '/does-not-run/codex',
  } });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const request = (path, { method = 'POST', cookie, origin = 'http://127.0.0.1:4317', data = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path, method, agent: false, headers: {
      Host: '127.0.0.1:4317', 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
    } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] })); });
    req.on('error', reject); req.end(method === 'POST' ? JSON.stringify(data) : undefined);
  });
  for (const path of ['/api/assistant', '/api/assistant/confirm']) {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, { cookie: 'tv_session=fake' })).status, 401);
  }
  assert.equal((await request('/api/tv/apps', { method: 'GET' })).status, 401);
  const paired = await request('/api/pair', { data: { code: 'test-pairing-code' } });
  assert.equal(paired.status, 200);
  for (const path of ['/api/assistant', '/api/assistant/confirm']) {
    assert.equal((await request(path, { cookie: paired.cookie, origin: 'https://evil.example' })).status, 403);
  }
  assert.equal((await request('/api/logout', { cookie: paired.cookie })).status, 200);
  assert.equal((await request('/api/assistant/confirm', { cookie: paired.cookie })).status, 401);
});
