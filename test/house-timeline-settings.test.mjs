import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, readFile, symlink, stat, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHouseTimeline } from '../lib/house-timeline.mjs';
import { createClientSettings } from '../lib/client-settings.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tv-house-state-'))); await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const note = { id: 'ha-aaaaaaaaaaaaaaaaaaaaaaaa', source: 'home_assistant', title: 'Vysavač', message: 'Vyprázdni nádobu.', type: 'info' };

test('unchanged HA reminders stay quiet after restart and may notify again after removal or visible change', async t => {
  const directory = await fixture(t), storePath = path.join(directory, 'timeline.json');
  let time = Date.parse('2026-10-25T09:00:00Z');
  let timeline = await createHouseTimeline({ storePath, now: () => time });
  assert.equal(timeline.record('notification', note), true); await timeline.flush();
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  time += 500000;
  timeline = await createHouseTimeline({ storePath, now: () => time });
  assert.equal(timeline.record('notification', { ...note, expiresAt: new Date(time + 15000).toISOString() }), false);
  assert.equal(timeline.get().events.length, 1);
  assert.equal(timeline.record('notification', { ...note, message: 'Nádoba je plná.' }), true);
  timeline.remove(note); assert.equal(timeline.record('notification', note), true); await timeline.flush();
  assert.equal(timeline.get().events.length, 3);
});

test('event IDs dedupe webhook retries across restart while real doorbells may recur; stored summaries exclude raw payloads', async t => {
  const directory = await fixture(t), storePath = path.join(directory, 'timeline.json'); let time = Date.now();
  const options = { storePath, now: () => time }; let timeline = await createHouseTimeline(options);
  const payload = { id: 'random-1', eventId: 'wash-cycle-21', title: 'Pračka', message: 'Doprala.', type: 'success', entity_id: 'sensor.private', latitude: 49, access_token: 'never-store', url: 'http://camera.invalid/private' };
  assert.equal(timeline.record('notification', payload), true); await timeline.flush();
  timeline = await createHouseTimeline(options);
  assert.equal(timeline.record('notification', { ...payload, id: 'random-2' }), false);
  assert.equal(timeline.record('doorbell', { title: 'Vchod', message: 'Někdo zvoní.' }), true);
  assert.equal(timeline.record('doorbell', { title: 'Vchod', message: 'Někdo zvoní.' }), false);
  time += 11000; assert.equal(timeline.record('doorbell', { title: 'Vchod', message: 'Někdo zvoní.' }), true);
  await timeline.flush(); const disk = await readFile(storePath, 'utf8');
  for (const excluded of ['never-store', 'latitude', 'entity_id', 'camera.invalid', 'wash-cycle-21']) assert.equal(disk.includes(excluded), false);
});

test('timeline caps history and dedupe keys, expires old summaries and accepts no forged raw state entries', async t => {
  const directory = await fixture(t), storePath = path.join(directory, 'timeline.json'); let time = Date.now();
  const timeline = await createHouseTimeline({ storePath, now: () => time });
  for (let i = 0; i < 1100; i++) timeline.record('notification', { title: 'Domov', message: String(i), eventId: 'cycle-' + i });
  assert.equal(timeline.get(100).events.length, 100); await timeline.flush();
  const disk = JSON.parse(await readFile(storePath, 'utf8')); assert.equal(disk.events.length, 256); assert.equal(disk.seen.length, 1024);
  time += 31 * 86400000; assert.equal(timeline.get().events.length, 0);
});

test('client preferences validate only display choices, persist revisions and serialize concurrent changes', async t => {
  const directory = await fixture(t), storePath = path.join(directory, 'settings.json');
  let settings = await createClientSettings({ storePath, now: () => 1234567890000, photoIntervalSeconds: 45 });
  assert.equal(settings.get().settings.photoIntervalSeconds, 45);
  await Promise.all([settings.update({ theme: 'dark' }), settings.update({ navigationSounds: false })]);
  assert.equal(settings.get().revision, 1234567890001);
  settings = await createClientSettings({ storePath }); assert.equal(settings.get().settings.theme, 'dark'); assert.equal(settings.get().settings.navigationSounds, false);
  assert.equal(settings.get().scope, 'household'); assert.equal(settings.get().persistent, true);
  for (const patch of [{}, { HA_TOKEN: 'secret' }, { appOrder: ['com.netflix.ninja'] }, { theme: 'system' }, { background: 'https://evil.invalid' },
    { navigationSounds: 1 }, { saverMinutes: -1 }, { saverMinutes: 1.5 }, { photoIntervalSeconds: 9 }, { photoIntervalSeconds: 3601 }, { theme: 'light', secret: 'bad' }]) {
    await assert.rejects(() => settings.update(patch), error => error.status === 400);
  }
  assert.equal(settings.get().settings.theme, 'dark');
});

test('private state refuses linked and world-readable stores', async t => {
  const directory = await fixture(t), target = path.join(directory, 'target.json'), linked = path.join(directory, 'link.json');
  const settings = await createClientSettings({ storePath: target }); await settings.update({ theme: 'dark' });
  await symlink(target, linked);
  await assert.rejects(() => createClientSettings({ storePath: linked }));
  await chmod(target, 0o644); await assert.rejects(() => createClientSettings({ storePath: target }));
});

test('damaged optional history or display settings stay untouched and do not stop the TV', async t => {
  const directory = await fixture(t);
  for (const raw of ['{partial', '{"version":999}', '[]']) {
    const historyPath = path.join(directory, 'history.json'), settingsPath = path.join(directory, 'settings.json');
    await writeFile(historyPath, raw, { mode: 0o600 }); await writeFile(settingsPath, raw, { mode: 0o600 });
    const history = await createHouseTimeline({ storePath: historyPath });
    assert.equal(history.get().persistent, false); history.record('notification', note); await history.flush();
    const settings = await createClientSettings({ storePath: settingsPath });
    assert.equal(settings.get().persistent, false); await settings.update({ theme: 'dark' });
    assert.equal(await readFile(historyPath, 'utf8'), raw); assert.equal(await readFile(settingsPath, 'utf8'), raw);
  }
});
