import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from '../server.mjs';
import { createPairedSessions } from '../lib/paired-sessions.mjs';

const START = Date.parse('2026-10-23T20:00:00Z'), HOUR = 3600000;
const RAW = '12345678901234567890123456789012';
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tv-notice-pref-'))), active = new Set();
  const storePath = path.join(root, 'private', 'sessions.json'); let time = START;
  t.after(async () => { for (const bridge of active) await bridge.close(); await rm(root, { recursive: true, force: true }); });
  async function start() {
    const bridge = await createBridge({ root, readOnlyPreview: true, sessionStorePath: storePath, sessionNow: () => time, config: {},
      env: { PORT: '4318', TV_CLIENT_TOKEN: 'notice-test-code', TV_WEBHOOK_TOKEN: 'test-webhook-only', HA_URL: 'http://ha.invalid', HA_TOKEN: 'test-ha-only' },
      ha: { subscribePersistentNotifications: () => ({ getStatus: () => ({ connected: true }), getCurrent: () => [{ id: 'ha-existing', title: 'Připomínka', message: 'Zůstává v centru', type: 'info' }], stop() {} }) } });
    active.add(bridge); await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
    const request = (route, { method = 'GET', cookie, body, origin = 'http://127.0.0.1:4318', authorization } = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: route, method,
        headers: { Host: '127.0.0.1:4318', Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(authorization ? { Authorization: authorization } : {}) } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks)) }));
      }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const post = (cookie, body, extra = {}) => request('/api/notification-preferences', { method: 'POST', cookie, body, ...extra });
    const pair = async () => { const response = await request('/api/pair', { method: 'POST', body: { code: 'notice-test-code' } }); return response.headers['set-cookie'][0].split(';')[0]; };
    const stream = cookie => new Promise((resolve, reject) => {
      let output = '';
      const req = http.get({ host: '127.0.0.1', port: bridge.server.address().port, path: '/api/events', headers: { Host: '127.0.0.1:4318', Cookie: cookie } }, response => {
        response.on('data', chunk => { output += chunk; });
        resolve({ output: () => output, close: () => req.destroy() });
      }); req.on('error', reject);
    });
    return { bridge, request, post, pair, stream, stop: async () => { active.delete(bridge); await bridge.close(); } };
  }
  return { root, storePath, start, advance: amount => { time += amount; } };
}
async function until(predicate) { const deadline = Date.now() + 1000; while (!predicate()) { if (Date.now() > deadline) assert.fail('SSE test timed out'); await delay(1); } }

test('local notification preferences require owning cookie and Origin, including in read-only preview', async t => {
  const f = await fixture(t), app = await f.start(), cookie = await app.pair();
  assert.equal((await app.request('/api/notification-preferences')).status, 401);
  assert.equal((await app.post(undefined, { action: 'snooze' }, { authorization: 'Bearer test-webhook-only' })).status, 401);
  assert.equal((await app.post(cookie, { action: 'kino', enabled: true }, { origin: 'http://evil.invalid' })).status, 403);
  for (const body of [{}, { action: 'kino' }, { action: 'kino', enabled: 'true' }, { action: 'snooze', until: START + 2 * HOUR }, { action: 'resume', enabled: false }, { action: 'unlock' }]) assert.equal((await app.post(cookie, body)).status, 400);
  const enabled = await app.post(cookie, { action: 'kino', enabled: true });
  assert.equal(enabled.status, 200); assert.equal(enabled.body.kino, true); assert.equal(enabled.body.kinoUntil, START + HOUR); assert.equal(enabled.body.scope, 'session');
  assert.equal((await app.request('/api/bootstrap', { cookie })).body.notificationPreferences.active, true);
  assert.equal((await app.post(cookie, { action: 'resume' })).body.active, false);
  assert.equal((await app.request('/api/notify', { method: 'POST', cookie, body: { message: 'still denied' } })).status, 403);
});

test('Kino preferences survive a real bridge restart as metadata of the hashed session only', async t => {
  const f = await fixture(t), first = await f.start(), cookie = await first.pair();
  await first.post(cookie, { action: 'kino', enabled: true });
  const raw = await readFile(f.storePath, 'utf8');
  assert.equal(raw.includes(cookie.split('=')[1]), false); assert.equal(raw.includes('notice-test-code'), false); assert.equal(raw.includes('test-ha-only'), false);
  await first.stop(); const second = await f.start();
  const restored = await second.request('/api/notification-preferences', { cookie });
  assert.equal(restored.status, 200); assert.equal(restored.body.kinoUntil, START + HOUR); assert.equal(restored.body.persistent, true);
  f.advance(HOUR); assert.equal((await second.request('/api/notification-preferences', { cookie })).body.active, false);
  await second.post(cookie, { action: 'snooze' });
  await second.request('/api/logout', { method: 'POST', cookie, body: {} });
  await second.stop(); const third = await f.start();
  assert.equal((await third.request('/api/notification-preferences', { cookie })).status, 401);
});

test('Kino filters only the owning session SSE while urgent, washer alerts, doorbell and center remain available', async t => {
  const f = await fixture(t), app = await f.start(), firstCookie = await app.pair(), secondCookie = await app.pair();
  const first = await app.stream(firstCookie), second = await app.stream(secondCookie); t.after(() => { first.close(); second.close(); });
  await app.post(firstCookie, { action: 'kino', enabled: true });
  for (const payload of [
    { id: 'ordinary', title: 'Domov', message: 'generic', type: 'info' },
    { id: 'urgent', title: 'Domov', message: 'urgent', type: 'urgent' },
    { id: 'house-washer-leak', source: 'home_assistant', message: 'leak', type: 'warning' },
    { id: 'house-washer-finished', source: 'home_assistant', message: 'finish', type: 'info' },
    { id: 'spoofed', message: 'generic warning', type: 'warning' },
  ]) app.bridge.broadcast('notification', payload);
  app.bridge.broadcast('doorbell', { id: 'bell-test', cameraId: 'entrance' });
  app.bridge.broadcast('notification_remove', { id: 'removed-test' });
  app.bridge.broadcast('probe', { id: 'end-marker' });
  await until(() => first.output().includes('end-marker') && second.output().includes('end-marker'));
  assert.ok(!first.output().includes('"id":"ordinary"')); assert.ok(!first.output().includes('"id":"spoofed"'));
  assert.equal((first.output().match(/event: notification\n/g) || []).length, 3); assert.equal((second.output().match(/event: notification\n/g) || []).length, 5);
  assert.ok(first.output().includes('event: doorbell\n')); assert.ok(first.output().includes('event: notification_remove\n'));
  const center = await app.request('/api/notifications', { cookie: firstCookie }); assert.equal(center.body.notifications[0].id, 'ha-existing');
  f.advance(HOUR); app.bridge.broadcast('notification', { id: 'after-expiry', message: 'visible again', type: 'info' });
  await until(() => first.output().includes('after-expiry'));
});

test('absolute hour windows never slide, resume resets both, and backward clock jumps cannot extend silence', async () => {
  let time = START; const sessions = await createPairedSessions({ now: () => time }); await sessions.add(RAW);
  const kino = await sessions.setNotificationPreferences(RAW, { action: 'kino', enabled: true });
  time += 30 * 60000;
  assert.equal((await sessions.setNotificationPreferences(RAW, { action: 'kino', enabled: true })).kinoUntil, kino.kinoUntil);
  const snooze = await sessions.setNotificationPreferences(RAW, { action: 'snooze' });
  time += 20 * 60000;
  assert.equal((await sessions.setNotificationPreferences(RAW, { action: 'snooze' })).snoozedUntil, snooze.snoozedUntil);
  assert.equal((await sessions.setNotificationPreferences(RAW, { action: 'resume' })).active, false);
  await sessions.setNotificationPreferences(RAW, { action: 'snooze' }); time -= 10 * 60000;
  assert.equal(sessions.notificationPreferences(RAW).active, false);
});

test('malformed stored preference durations fail closed without changing the existing file', async t => {
  const f = await fixture(t), app = await f.start(), cookie = await app.pair(); await app.post(cookie, { action: 'snooze' }); await app.stop();
  const data = JSON.parse(await readFile(f.storePath, 'utf8')); data.sessions[0].notificationPreferences.snoozedUntil += HOUR;
  const malformed = JSON.stringify(data); await writeFile(f.storePath, malformed, { mode: 0o600 });
  await assert.rejects(f.start(), /storage is unreadable or unsafe/); assert.equal(await readFile(f.storePath, 'utf8'), malformed);
});

test('explicit Kino minutes are bounded, persisted, idempotent and can deliberately change the duration', async t => {
  const f = await fixture(t), app = await f.start(), cookie = await app.pair();
  for (const minutes of [0, 1441, 1.5, '120', null]) assert.equal((await app.post(cookie, { action: 'kino', enabled: true, minutes })).status, 400);
  assert.equal((await app.post(cookie, { action: 'kino', enabled: false, minutes: 120 })).status, 400);
  const active = await app.post(cookie, { action: 'kino', enabled: true, minutes: 120 });
  assert.equal(active.body.kinoUntil, START + 2 * HOUR); assert.equal(active.body.kinoStartedAt, START); assert.equal(active.body.kinoDurationMinutes, 120);
  f.advance(10 * 60000); assert.equal((await app.post(cookie, { action: 'kino', enabled: true, minutes: 120 })).body.kinoUntil, active.body.kinoUntil);
  await app.stop(); const restored = await f.start(); assert.equal((await restored.request('/api/notification-preferences', { cookie })).body.kinoUntil, active.body.kinoUntil);
  const shorter = await restored.post(cookie, { action: 'kino', enabled: true, minutes: 30 }); assert.equal(shorter.body.kinoUntil, START + 40 * 60000);
  f.advance(30 * 60000); assert.equal((await restored.request('/api/notification-preferences', { cookie })).body.active, false);
});
