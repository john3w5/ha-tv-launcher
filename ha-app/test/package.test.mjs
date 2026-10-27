import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { configureDashboard, connectionOptions, persistentSecret, start } from '../startup.mjs';
import { prepare } from '../prepare-package.mjs';

const TEST_CREDENTIAL = 'test-only-not-a-real-credential';
const example = { household: 'Example home', entities: { cameras: [] }, domesticPanel: { rooms: [] }, unrelated: { retain: true } };
async function fixture(t) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'home-tv-package-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source'), data = path.join(temp, 'data'), configImport = path.join(temp, 'config-import.json');
  await mkdir(source, { mode: 0o700 }); await mkdir(data, { mode: 0o700 });
  await writeFile(path.join(source, 'config.example.json'), JSON.stringify(example), { mode: 0o600 });
  return { temp, source, data, configImport };
}
async function json(filename) { return JSON.parse(await readFile(filename, 'utf8')); }

test('Supervisor and direct transports use their distinct correct WebSocket paths', () => {
  const a = connectionOptions({ public_origin: 'http://tv.example.invalid:4317', ha_connection: 'supervisor' }, TEST_CREDENTIAL);
  assert.equal(a.url, 'http://supervisor/core/'); assert.equal(a.websocketUrl, 'ws://supervisor/core/websocket'); assert.equal(a.revision, 0);
  const b = connectionOptions({ public_origin: 'https://tv.example.invalid/', ha_connection: 'direct', ha_url: 'https://ha.example.invalid/', ha_access_token: TEST_CREDENTIAL, config_import_revision: 2 });
  assert.equal(b.url, 'https://ha.example.invalid/'); assert.equal(b.websocketUrl, 'wss://ha.example.invalid/api/websocket'); assert.equal(b.revision, 2);
});
test('unsafe origins, missing credentials and invalid option types fail before startup', () => {
  for (const public_origin of ['file:///tmp/a', 'http://user:password@host', 'http://host/path', 'http://host/?x=y', 'http://host/#x', undefined]) {
    assert.throws(() => connectionOptions({ public_origin }, TEST_CREDENTIAL));
  }
  assert.throws(() => connectionOptions({ public_origin: 'http://host' }));
  for (const extra of [{ config_import_revision: -1 }, { config_import_revision: 1.5 }, { config_import_revision: 1000001 },
    { session_days: 91 }, { night_control_enabled: 'true' }, { pairing_code: 'short' }, { webhook_token: 'short' }]) {
    assert.throws(() => connectionOptions({ public_origin: 'http://host', ...extra }, TEST_CREDENTIAL));
  }
});
test('fresh install creates a private generic config and normal updates preserve all user data', async t => {
  const f = await fixture(t), filename = path.join(f.data, 'config.json');
  assert.equal((await configureDashboard(f)).status, 'initialized');
  assert.deepEqual(await json(filename), example); assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const user = { household: 'My own home', custom: { setting: [true, 0, null] } };
  const raw = JSON.stringify(user, null, 2) + '\n'; await writeFile(filename, raw);
  await writeFile(path.join(f.source, 'config.example.json'), '{"newReleaseDefault":true}');
  await writeFile(f.configImport, '{"notRequested":true}');
  await mkdir(path.join(f.data, 'runtime'), { mode: 0o700 });
  await writeFile(path.join(f.data, 'runtime', 'user-state.json'), '{"preserve":true}', { mode: 0o600 });
  assert.equal((await configureDashboard(f)).status, 'preserved');
  assert.equal(await readFile(filename, 'utf8'), raw);
  assert.equal(await readFile(path.join(f.data, 'runtime', 'user-state.json'), 'utf8'), '{"preserve":true}');
  assert(!(await readdir(f.data)).some(name => name.startsWith('config-before-')));
});
test('only an explicit higher import revision replaces config and keeps a private original backup', async t => {
  const f = await fixture(t), filename = path.join(f.data, 'config.json'); await configureDashboard(f);
  const before = await readFile(filename), first = { household: 'My home', entities: { cameras: [{ id: 'camera_one', entityId: 'camera.user_camera' }] } };
  const raw = JSON.stringify(first, null, 2) + '\n'; await writeFile(f.configImport, raw);
  assert.deepEqual(await configureDashboard({ ...f, revision: 1 }), { status: 'imported', revision: 1 });
  const backup = path.join(f.data, 'config-before-import-1.json'); assert.deepEqual(await readFile(backup), before);
  assert.equal(await readFile(filename, 'utf8'), raw);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  const marker = await json(path.join(f.data, 'config-import.json'));
  assert.equal(marker.revision, 1); assert.equal(marker.sourceSha256, createHash('sha256').update(raw).digest('hex'));
  const later = { ...first, userEditedLater: true }; await writeFile(filename, JSON.stringify(later));
  await writeFile(f.configImport, '{"newRequestedValue":true}');
  assert.equal((await configureDashboard({ ...f, revision: 1 })).status, 'preserved'); assert.deepEqual(await json(filename), later);
  assert.equal((await configureDashboard({ ...f, revision: 2 })).status, 'imported');
  assert.deepEqual(await json(path.join(f.data, 'config-before-import-2.json')), later);
  assert.deepEqual(await readFile(backup), before);
  assert.equal((await configureDashboard({ ...f, revision: 1 })).status, 'preserved');
});
test('invalid JSON or authentication fields in an import never replace the existing config', async t => {
  for (const raw of ['{broken', '[]', '{"ha_access_token":"test-not-real"}']) await t.test(raw.startsWith('{broken') ? 'invalid-json' : raw === '[]' ? 'array' : 'credentials', async t => {
    const f = await fixture(t); await configureDashboard(f); const filename = path.join(f.data, 'config.json'), before = await readFile(filename);
    await writeFile(f.configImport, raw); await assert.rejects(() => configureDashboard({ ...f, revision: 1 }));
    assert.deepEqual(await readFile(filename), before); assert.deepEqual(await readdir(f.data), ['config.json']);
  });
});
test('symlinks and unsafe existing config permissions are refused', async t => {
  for (const target of ['source', 'config', 'import', 'marker', 'data', 'public-mode']) await t.test(target, async t => {
    const f = await fixture(t), filename = path.join(f.data, 'config.json');
    if (target !== 'source' && target !== 'data') await configureDashboard(f);
    await writeFile(f.configImport, '{"household":"New example"}');
    if (target === 'marker') await configureDashboard({ ...f, revision: 1 });
    const selected = { source: path.join(f.source, 'config.example.json'), config: filename, import: f.configImport,
      marker: path.join(f.data, 'config-import.json'), data: f.data, 'public-mode': filename }[target];
    if (target === 'public-mode') await chmod(selected, 0o644);
    else { const moved = path.join(f.temp, `outside-${target}`); await rename(selected, moved); await symlink(moved, selected); }
    await assert.rejects(() => configureDashboard({ ...f, revision: 1 }));
  });
});
test('an interrupted import resumes from backup-only or config-renamed state without overwriting backup', async t => {
  for (const phase of ['backup-only', 'config-renamed']) await t.test(phase, async t => {
    const f = await fixture(t), filename = path.join(f.data, 'config.json'); await configureDashboard(f);
    const before = await readFile(filename); await writeFile(f.configImport, '{"household":"Imported home"}');
    await configureDashboard({ ...f, revision: 1 }); const after = await readFile(filename), backupName = path.join(f.data, 'config-before-import-1.json');
    await rm(path.join(f.data, 'config-import.json')); if (phase === 'backup-only') await writeFile(filename, before);
    const temporary = path.join(f.data, `.config-before-import-1.json.${'a'.repeat(24)}.tmp`); await link(backupName, temporary);
    assert.equal((await configureDashboard({ ...f, revision: 1 })).status, 'imported');
    assert.deepEqual(await readFile(filename), after); assert.deepEqual(await readFile(backupName), before);
    assert.equal((await stat(backupName)).nlink, 1); await assert.rejects(() => stat(temporary), { code: 'ENOENT' });
  });
});
test('an edit made during an interrupted import is not overwritten', async t => {
  const f = await fixture(t), filename = path.join(f.data, 'config.json'); await configureDashboard(f);
  await writeFile(f.configImport, '{"household":"Imported home"}'); await configureDashboard({ ...f, revision: 1 });
  await rm(path.join(f.data, 'config-import.json')); const edited = '{"userEditedDuringInterruption":true}'; await writeFile(filename, edited);
  await assert.rejects(() => configureDashboard({ ...f, revision: 1 })); assert.equal(await readFile(filename, 'utf8'), edited);
});
test('fresh pairing and webhook secrets are independent, persistent, private and never derived from config', async t => {
  const f = await fixture(t), a = path.join(f.data, 'pairing-secret'), b = path.join(f.data, 'webhook-secret');
  const first = await persistentSecret(a), second = await persistentSecret(b);
  assert(/^[A-Za-z0-9_-]{32}$/.test(first)); assert(/^[A-Za-z0-9_-]{32}$/.test(second)); assert(first !== second);
  assert((await persistentSecret(a)) === first); assert.equal((await stat(a)).mode & 0o777, 0o600);
  assert((await persistentSecret(a, TEST_CREDENTIAL)) === TEST_CREDENTIAL); assert((await persistentSecret(a)) === first);
  const c = path.join(f.data, 'secret-link'); await symlink(a, c); await assert.rejects(() => persistentSecret(c));
});
test('package maps the source app template to config.yaml and excludes all personal files', async t => {
  const f = await fixture(t);
  for (const dir of ['lib', 'public', 'private']) await mkdir(path.join(f.source, dir));
  for (const name of ['server.mjs', 'package.json', 'assistant-plan.schema.json']) await writeFile(path.join(f.source, name), '{}');
  for (const name of ['.env', 'config.json', 'private/user.json', 'public/.secret', 'lib/.env']) await writeFile(path.join(f.source, name), 'TEST-PRIVATE-SENTINEL');
  await writeFile(path.join(f.source, 'public', 'index.html'), '<html>Demo</html>');
  const destination = path.join(f.temp, 'package'), manifest = await prepare(destination, { source: f.source });
  assert.equal(manifest.privateDataIncluded, false);
  const names = manifest.files.map(item => item.path); assert(names.includes('config.yaml')); assert(!names.includes('app-config.yaml'));
  assert(!names.some(name => /(^|\/)\.env|private|runtime\/config\.json/.test(name)));
  const metadata = await readFile(path.join(destination, 'config.yaml'), 'utf8'); assert(metadata.includes('slug: "home_tv_launcher"')); assert(metadata.includes('version: "0.1.4"'));
  for (const file of manifest.files) assert(!(await readFile(path.join(destination, file.path), 'utf8')).includes('TEST-PRIVATE-SENTINEL'));
  await assert.rejects(() => prepare(destination, { source: f.source }), /already exists/);
  await assert.rejects(() => stat(new URL('../config.yaml', import.meta.url)), { code: 'ENOENT' });
});
test('package refuses a linked asset', async t => {
  const f = await fixture(t);
  for (const dir of ['lib', 'public']) await mkdir(path.join(f.source, dir));
  for (const name of ['server.mjs', 'package.json', 'assistant-plan.schema.json']) await writeFile(path.join(f.source, name), '{}');
  await symlink(path.join(f.source, 'config.example.json'), path.join(f.source, 'public', 'linked.json'));
  await assert.rejects(() => prepare(path.join(f.temp, 'package'), { source: f.source }), /symbolic link/);
});
test('startup passes the user config to the bridge and preserves state/secrets on a code update', async t => {
  const f = await fixture(t), listeners = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.rawListeners(signal)]));
  t.after(() => { for (const signal of ['SIGINT', 'SIGTERM']) for (const listener of process.rawListeners(signal)) if (!listeners[signal].includes(listener)) process.removeListener(signal, listener); });
  for (const dir of ['lib', 'public']) await mkdir(path.join(f.source, dir));
  await writeFile(path.join(f.source, 'public', 'index.html'), 'first-release');
  await writeFile(path.join(f.source, 'server.mjs'), `export async function createBridge(options) { return { config: options.config, env: options.env, server: { once() {}, listen(port, host, done) { done(); } }, close: async () => {} }; }`);
  await writeFile(path.join(f.data, 'options.json'), JSON.stringify({ public_origin: 'http://tv.example.invalid:4317', ha_connection: 'direct', ha_url: 'http://ha.example.invalid', ha_access_token: TEST_CREDENTIAL }), { mode: 0o600 });
  const first = await start(f), state = path.join(f.data, 'runtime', 'private', 'state', 'sessions.json');
  await writeFile(state, '{"testUserState":true}', { mode: 0o600 });
  const user = { household: 'User home', otherSetting: true }; await writeFile(path.join(f.data, 'config.json'), JSON.stringify(user));
  await writeFile(path.join(f.source, 'public', 'index.html'), 'updated-release');
  await writeFile(path.join(f.source, 'config.example.json'), '{"newDefault":true}');
  const second = await start(f); assert.equal(second.config.household, user.household); assert.equal(second.config.otherSetting, true);
  assert(second.env.TV_CLIENT_TOKEN === first.env.TV_CLIENT_TOKEN); assert(second.env.TV_WEBHOOK_TOKEN === first.env.TV_WEBHOOK_TOKEN);
  assert.equal(await readFile(state, 'utf8'), '{"testUserState":true}');
  assert.equal(await readFile(path.join(f.data, 'runtime', 'public', 'index.html'), 'utf8'), 'updated-release');
});
