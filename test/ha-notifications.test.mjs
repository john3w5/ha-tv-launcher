import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { HomeAssistant } from '../lib/home-assistant.mjs';

function fixture(t, options = {}) {
  const sockets = [], notices = [], removals = [], statuses = [];
  class FakeWebSocket {
    constructor(url) { this.url = String(url); this.listeners = new Map(); this.sent = []; this.closed = false; sockets.push(this); }
    addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); }
    send(value) { this.sent.push(JSON.parse(value)); }
    emit(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback(event); }
    receive(value) { this.emit('message', { data: JSON.stringify(value) }); }
    close() { if (this.closed) return; this.closed = true; this.emit('close'); }
  }
  const ha = new HomeAssistant({ url: 'http://ha.example.test:8123', token: 'private-test-token', websocketClass: FakeWebSocket, timeoutMs: options.timeoutMs || 1000 });
  const feed = ha.subscribePersistentNotifications({ reconnectMs: 5, maxReconnectMs: 10, heartbeatMs: 1000, heartbeatTimeoutMs: 100,
    onNotification: value => notices.push(value), onRemove: value => removals.push(value), onStatus: value => statuses.push(value), ...options });
  t.after(() => feed.stop());
  const authenticate = socket => {
    socket.receive({ type: 'auth_required' });
    assert.deepEqual(socket.sent[0], { type: 'auth', access_token: 'private-test-token' });
    socket.receive({ type: 'auth_ok' });
    assert.deepEqual(socket.sent[1], { id: 1, type: 'persistent_notification/subscribe' });
    socket.receive({ id: 1, type: 'result', success: true, result: null });
  };
  const event = (socket, type, notifications) => socket.receive({ id: 1, type: 'event', event: { type, notifications } });
  return { feed, sockets, notices, removals, statuses, authenticate, event };
}
async function until(predicate) {
  const end = Date.now() + 1000;
  while (!predicate()) { if (Date.now() > end) assert.fail('Timed out waiting for fake WebSocket state'); await delay(2); }
}

test('native persistent notifications ignore current, deduplicate updates and use stable opaque IDs', t => {
  const f = fixture(t), socket = f.sockets[0];
  assert.equal(f.feed.getStatus().connected, false);
  f.authenticate(socket);
  assert.equal(f.feed.getStatus().connected, true);
  const old = { title: 'Old', message: 'Existing notice', created_at: '2026-10-22T00:00:00Z' };
  f.event(socket, 'current', { old });
  assert.equal(f.notices.length, 0);
  const notice = { title: 'Domov', message: 'New notice', created_at: '2026-10-23T00:00:00Z' };
  f.event(socket, 'added', { 'private-notification-name': notice });
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].source, 'home_assistant');
  assert.match(f.notices[0].id, /^ha-[a-f0-9]{24}$/);
  assert.ok(!JSON.stringify(f.notices).includes('private-notification-name'));
  assert.ok(!JSON.stringify(f.feed.getStatus()).includes('private-test-token'));
  f.event(socket, 'updated', { 'private-notification-name': notice });
  assert.equal(f.notices.length, 1);
  f.event(socket, 'updated', { 'private-notification-name': { ...notice, message: 'Updated notice' } });
  assert.equal(f.notices.length, 2);
  assert.equal(f.notices[0].id, f.notices[1].id);
  f.event(socket, 'removed', { 'private-notification-name': notice });
  assert.deepEqual(f.removals, [{ id: f.notices[0].id, source: 'home_assistant' }]);
});

test('timestamp-only recreation of one unresolved HA reminder never repeats the toast', t => {
  const f = fixture(t), socket = f.sockets[0]; f.authenticate(socket);
  const notice = { title: 'Zařízení je nedostupné', message: 'Jedna stále aktivní připomínka.', created_at: '2026-10-23T17:00:00Z' };
  f.event(socket, 'current', { reminder: notice });
  for (const created_at of ['2026-10-23T17:05:19Z', '2026-10-23T17:10:38Z', '2026-10-24T17:00:00Z']) {
    f.event(socket, 'updated', { reminder: { ...notice, created_at } });
  }
  assert.equal(f.notices.length, 0);
  assert.equal(f.feed.getCurrent().length, 1);
  assert.equal(f.feed.getCurrent()[0].message, notice.message);
  f.event(socket, 'updated', { reminder: { ...notice, title: 'Skutečná změna titulku' } });
  f.event(socket, 'updated', { reminder: { ...notice, message: 'Skutečná změna obsahu' } });
  f.event(socket, 'updated', { reminder: notice });
  assert.equal(f.notices.length, 3, 'Each actual content transition remains an alert, including returning to a previous state');
});

test('different persistent IDs and removal followed by re-add remain new notification episodes', t => {
  const f = fixture(t), socket = f.sockets[0]; f.authenticate(socket);
  const notice = { title: 'Dokončeno', message: 'Nová samostatná událost.' };
  f.event(socket, 'added', { first: notice });
  f.event(socket, 'added', { second: notice });
  assert.equal(f.notices.length, 2, 'Independent HA IDs must not be collapsed by matching text');
  assert.notEqual(f.notices[0].id, f.notices[1].id);
  f.event(socket, 'removed', { first: null });
  f.event(socket, 'added', { first: notice });
  assert.equal(f.notices.length, 3);
  assert.equal(f.notices[0].id, f.notices[2].id);
  assert.equal(f.feed.getCurrent().length, 2);
});

test('HA retry identity uses displayed content, ignoring private metadata and clipped suffixes', t => {
  const f = fixture(t), socket = f.sockets[0]; f.authenticate(socket);
  const message = 'x'.repeat(1000);
  f.event(socket, 'added', { notice: { message: `${message}hidden-first`, private_metadata: 'one' } });
  f.event(socket, 'updated', { notice: { title: 'Home Assistant', message: `${message}hidden-second`, private_metadata: 'two' } });
  assert.equal(f.notices.length, 1);
  assert.equal(f.feed.getCurrent()[0].message, message);
  f.event(socket, 'updated', { notice: { message: ' ' } });
  assert.deepEqual(f.feed.getCurrent(), []);
  f.event(socket, 'added', { notice: { message } });
  assert.equal(f.notices.length, 2, 'Cleared content resets the reminder lifetime');
});

test('loss reconnects and resubscribes, initial reconnect snapshot is not replayed; stop cleans timers', async t => {
  const f = fixture(t), first = f.sockets[0];
  f.authenticate(first);
  first.emit('error');
  assert.equal(f.feed.getStatus().connected, false);
  assert.equal(first.closed, true);
  await until(() => f.sockets.length === 2);
  const second = f.sockets[1]; f.authenticate(second);
  f.event(second, 'current', { missed: { title: 'While disconnected', message: 'Not replayed as a new alert' } });
  assert.equal(f.notices.length, 0);
  assert.equal(f.feed.getStatus().connected, true);
  f.feed.stop();
  assert.equal(second.closed, true);
  assert.equal(f.feed.getStatus().state, 'stopped');
  second.emit('close');
  await delay(25);
  assert.equal(f.sockets.length, 2);
});

test('authentication rejection stops retrying and exposes only safe status', async t => {
  const f = fixture(t);
  f.sockets[0].receive({ type: 'auth_invalid', message: 'private internal detail' });
  assert.equal(f.feed.getStatus().state, 'authentication_failed');
  assert.equal(f.feed.getStatus().connected, false);
  await delay(25);
  assert.equal(f.sockets.length, 1);
  assert.ok(!JSON.stringify(f.statuses).includes('private internal detail'));
});

test('missing subscription acknowledgement and missed heartbeat trigger reconnection', async t => {
  const handshake = fixture(t, { timeoutMs: 5 });
  await until(() => handshake.sockets.length > 1);
  assert.equal(handshake.sockets[0].closed, true);
  handshake.feed.stop();
  const heartbeat = fixture(t, { heartbeatMs: 5, heartbeatTimeoutMs: 5 });
  heartbeat.authenticate(heartbeat.sockets[0]);
  await until(() => heartbeat.sockets[0].sent.some(x => x.type === 'ping'));
  await until(() => heartbeat.sockets.length > 1);
  assert.equal(heartbeat.sockets[0].closed, true);
  assert.equal(heartbeat.feed.getStatus().connected, false);
});

test('a valid pong keeps subscription active and consumer errors do not drop transport', async t => {
  const f = fixture(t, { heartbeatMs: 5, heartbeatTimeoutMs: 50, onNotification: () => { throw Error('consumer'); } });
  f.authenticate(f.sockets[0]);
  await until(() => f.sockets[0].sent.some(x => x.type === 'ping'));
  const ping = f.sockets[0].sent.find(x => x.type === 'ping');
  f.sockets[0].receive({ type: 'pong', id: ping.id });
  f.event(f.sockets[0], 'added', { test: { message: 'Consumer can fail safely' } });
  assert.equal(f.feed.getStatus().connected, true);
  assert.equal(f.sockets[0].closed, false);
});

test('notification content is bounded and malformed messages do not claim connectivity', t => {
  const f = fixture(t);
  f.authenticate(f.sockets[0]);
  f.event(f.sockets[0], 'added', { long: { title: 'x'.repeat(300), message: 'a'.repeat(3000) } });
  assert.equal(f.notices[0].title.length, 120);
  assert.equal(f.notices[0].message.length, 1000);
  f.sockets[0].emit('message', { data: 'invalid JSON' });
  assert.equal(f.feed.getStatus().connected, false);
});

test('current reminder list is sanitized, read-only, lifecycle-aware and never replays startup toasts', async t => {
  const f = fixture(t); f.authenticate(f.sockets[0]);
  const existing = { title: 'Existující zpráva', message: 'Platné upozornění', access_token: 'never-return', private_url: 'never-return' };
  f.event(f.sockets[0], 'current', { 'original-private-id': existing });
  assert.equal(f.notices.length, 0);
  const current = f.feed.getCurrent();
  assert.equal(current.length, 1);
  assert.deepEqual(Object.keys(current[0]).sort(), ['id', 'message', 'source', 'title', 'type']);
  assert.match(current[0].id, /^ha-[a-f0-9]{24}$/);
  assert.ok(!JSON.stringify(current).includes('original-private-id'));
  assert.ok(!JSON.stringify(current).includes('never-return'));
  current[0].message = 'client edit'; current.length = 0;
  assert.equal(f.feed.getCurrent()[0].message, 'Platné upozornění');
  f.event(f.sockets[0], 'updated', { 'original-private-id': { ...existing, message: 'Nový obsah' } });
  assert.equal(f.feed.getCurrent()[0].message, 'Nový obsah');
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].id, f.feed.getCurrent()[0].id);
  f.event(f.sockets[0], 'removed', { 'original-private-id': existing });
  assert.deepEqual(f.feed.getCurrent(), []);
  f.event(f.sockets[0], 'added', { next: existing });
  f.sockets[0].emit('error'); assert.deepEqual(f.feed.getCurrent(), []);
  await until(() => f.sockets.length === 2); f.authenticate(f.sockets[1]);
  const before = f.notices.length;
  f.event(f.sockets[1], 'current', { fresh: { ...existing, message: 'Aktuální snapshot' } });
  assert.equal(f.feed.getCurrent().length, 1); assert.equal(f.feed.getCurrent()[0].message, 'Aktuální snapshot');
  assert.equal(f.notices.length, before);
  f.event(f.sockets[1], 'updated', { fresh: { message: ' ' } }); assert.deepEqual(f.feed.getCurrent(), []);
  f.event(f.sockets[1], 'added', { fresh: existing }); f.feed.stop(); assert.deepEqual(f.feed.getCurrent(), []);
});
