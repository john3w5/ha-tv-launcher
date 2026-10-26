import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrimaTvAdapter } from '../lib/tv-prima-adapter.mjs';

const ACTION = { type: 'search_content', key: null, appId: 'cz.prima.tvapp', query: 'Zrádci', selection: 'latest' };
const URL = 'https://www.iprima.cz/serialy/zradci/traitors-the-3-zradci-3/6-epizoda-6';
const CONTENT = { url: URL, title: 'Zrádci S3 (6)', episode: { season: 3, number: 6, durationSeconds: 4400 },
  availability: { publishingState: 'published', fullVideoAccessLevels: ['light', 'premium'], accountChecked: false },
  evidence: { sources: ['https://www.iprima.cz/serialy/zradci', URL], playbackVerified: false } };
const CATALOG = { userId: 0, apps: [{ appId: 'cz.prima.tvapp', component: 'cz.prima.tvapp/.MainActivity' }] };
function fixture({ content = CONTENT, response = { code: 0, stdout: 'Status: ok\nActivity: cz.prima.tvapp/.MainActivity', stderr: '' }, inventory = CATALOG } = {}) {
  const calls = []; let catalog = inventory; let reads = 0; let resolves = 0;
  const adapter = createPrimaTvAdapter({ adbPath: '/fake path/adb', serial: '192.168.50.133:5555',
    control: { async listApps() { reads++; return catalog; } },
    resolve: async action => { resolves++; assert.deepEqual(action, { query: 'Zrádci', selection: 'latest' }); return content; },
    runner: async (...args) => { calls.push(args); return response; },
  });
  return { adapter, calls, setInventory(value) { catalog = value; }, stats: () => ({ reads, resolves }) };
}

test('preview resolves and verifies live app without invoking any mutating runner', async () => {
  const f = fixture();
  const preview = await f.adapter.preview(ACTION);
  assert.equal(preview.supported, true); assert.equal(preview.ready, true);
  assert.equal(preview.content.episode.number, 6);
  assert.equal(preview.content.evidence.deepLinkVerified, false);
  assert.equal(preview.content.evidence.playbackVerified, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.stats(), { reads: 1, resolves: 1 });
});

test('confirmed execute rechecks app/user then sends one shell-safe explicit VIEW handoff', async () => {
  const f = fixture(); const preview = await f.adapter.preview(ACTION);
  const result = await f.adapter.execute(ACTION, preview);
  assert.equal(result.ok, true); assert.equal(result.accepted, true);
  assert.equal(result.playbackVerified, false); assert.equal(result.accountChecked, false);
  assert.equal(result.handoffAccepted, true);
  assert.deepEqual(f.calls[0][1], ['-s', '192.168.50.133:5555', 'shell', 'am', 'start', '-W', '--user', '0', '-a', 'android.intent.action.VIEW', '-c', 'android.intent.category.BROWSABLE', '-n', 'cz.prima.tvapp/.MainActivity', '-d', URL]);
  assert.equal(f.calls[0][0], '/fake path/adb');
  assert.deepEqual(f.stats(), { reads: 2, resolves: 1 });
  await assert.rejects(f.adapter.execute(ACTION, preview), error => error.code === 'invalid_confirmation');
  assert.equal(f.calls.length, 1);
});

test('unsupported requests never resolve, send keys or launch another app', async () => {
  const f = fixture();
  for (const action of [{ ...ACTION, appId: 'com.netflix.ninja' }, { ...ACTION, type: 'launch_app' }, { ...ACTION, selection: 'none' }, { ...ACTION, command: 'reboot' }]) {
    const result = await f.adapter.preview(action);
    assert.equal(result.supported, false); assert.equal(result.ready, false);
  }
  assert.deepEqual(f.stats(), { reads: 0, resolves: 0 }); assert.equal(f.calls.length, 0);
});

test('only exact www.iprima.cz ASCII slug URLs pass, without credential/query/fragment/metacharacters', async () => {
  for (const url of [URL + '?token=x', URL + '#play', URL.replace('www.iprima.cz', 'evil.test'), URL.replace('www.', ''), URL.replace('https:', 'http:'), URL.replace('www.iprima.cz', 'user:pass@www.iprima.cz'), URL.replace('www.iprima.cz', 'www.iprima.cz:443'), URL.replace('epizoda-6', '%3Breboot'), URL + ';reboot', URL.replace('zradci/', 'zradci-usa/')]) {
    const f = fixture({ content: { ...CONTENT, url } });
    await assert.rejects(f.adapter.preview(ACTION), error => error.code === 'unsafe_content_url', url);
    assert.equal(f.calls.length, 0);
  }
});

test('missing/malicious component or a changed user/component blocks execution', async () => {
  for (const inventory of [{ userId: 0, apps: [] }, { userId: 0, apps: [{ appId: 'cz.prima.tvapp', component: 'cz.prima.tvapp/.Main;reboot' }] }]) {
    const f = fixture({ inventory });
    await assert.rejects(f.adapter.preview(ACTION)); assert.equal(f.calls.length, 0);
  }
  for (const change of [{ ...CATALOG, userId: 10 }, { userId: 0, apps: [{ appId: 'cz.prima.tvapp', component: 'cz.prima.tvapp/.OtherActivity' }] }]) {
    const f = fixture(); const preview = await f.adapter.preview(ACTION); f.setInventory(change);
    await assert.rejects(f.adapter.execute(ACTION, preview), error => error.code === 'tv_changed');
    assert.equal(f.calls.length, 0);
  }
});

test('forged preview, mutated action and changed URL cannot bypass server-owned confirmation', async () => {
  const f = fixture(); const preview = await f.adapter.preview(ACTION);
  assert.throws(() => { preview.content.url = 'https://evil.test'; }, TypeError);
  await assert.rejects(f.adapter.execute(ACTION, JSON.parse(JSON.stringify(preview))), error => error.code === 'invalid_confirmation');
  await assert.rejects(f.adapter.execute({ ...ACTION, query: 'Jiný pořad' }, preview), error => error.code === 'invalid_confirmation');
  assert.equal(f.calls.length, 0);
});

test('nonzero ADB, Error text or timeout status never claims successful playback/handoff', async () => {
  for (const response of [{ code: 1, stdout: '', stderr: 'private adb error' }, { code: 0, stdout: 'Error: Activity not found', stderr: '' }, { code: 0, stdout: 'Status: timeout', stderr: '' }]) {
    const f = fixture({ response }); const preview = await f.adapter.preview(ACTION);
    await assert.rejects(f.adapter.execute(ACTION, preview), error => error.code === 'handoff_not_confirmed' && !error.message.includes('private'));
    assert.equal(f.calls.length, 1);
  }
});
