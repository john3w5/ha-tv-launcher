import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraSnapshots } from '../lib/camera-snapshots.mjs';
import { HomeAssistant } from '../lib/home-assistant.mjs';

const jpeg = n => Buffer.from([0xff, 0xd8, 0xff, n, 0xff, 0xd9]);
const response = n => new Response(jpeg(n), { headers: { 'Content-Type': 'image/jpeg' } });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(options = {}) {
  let now = 0, nextId = 0;
  const timers = new Map();
  const cache = createCameraSnapshots({ now: () => now,
    setTimeoutImpl: (callback, ms) => { const id = ++nextId; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimeoutImpl: id => timers.delete(id), ...options });
  return { cache, timers, async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } await settle(); } };
}

test('concurrent screens share one physical-entity load and completed bytes are reused for only 750ms', async t => {
  const pending = deferred(); let calls = 0;
  const f = fixture({ load: () => { calls++; return calls === 1 ? pending.promise : response(calls); } }); t.after(() => f.cache.close());
  const requests = Array.from({ length: 12 }, () => f.cache.get('camera.front'));
  await settle(); assert.equal(calls, 1);
  pending.resolve(response(1)); const images = await Promise.all(requests);
  assert.ok(images.every(image => image.data.equals(jpeg(1))));
  await f.advance(749); assert.equal((await f.cache.get('camera.front')).data[3], 1); assert.equal(calls, 1);
  await f.advance(1); assert.equal((await f.cache.get('camera.front')).data[3], 2); assert.equal(calls, 2);
  assert.equal(f.timers.size, 0);
});

test('one disconnected waiter cannot cancel another screen awaiting the same image', async t => {
  const delayed = deferred(); let upstreamSignal;
  const f = fixture({ load: (_id, { signal }) => { upstreamSignal = signal; return delayed.promise; } }); t.after(() => f.cache.close());
  const first = new AbortController(), second = new AbortController();
  const a = f.cache.get('camera.front', { signal: first.signal }), b = f.cache.get('camera.front', { signal: second.signal });
  const cancelled = assert.rejects(a, { name: 'AbortError' }); await settle(); first.abort(); await cancelled;
  assert.equal(upstreamSignal.aborted, false); delayed.resolve(response(2));
  assert.deepEqual((await b).data, jpeg(2)); assert.equal(f.cache.getStats().active, 0);
});

test('last waiter cancellation aborts upstream, clears its slot and cannot publish a late image', async t => {
  const delayed = deferred(); let upstreamSignal, cancelledBody = 0, calls = 0;
  const f = fixture({ load: (_id, { signal }) => { upstreamSignal = signal; return ++calls === 1 ? delayed.promise : response(2); } }); t.after(() => f.cache.close());
  const controller = new AbortController(), pending = f.cache.get('camera.front', { signal: controller.signal });
  const cancelled = assert.rejects(pending, { name: 'AbortError' }); await settle(); controller.abort(); await cancelled;
  assert.equal(upstreamSignal.aborted, true); assert.equal(f.cache.getStats().active, 0); assert.equal(f.timers.size, 0);
  delayed.resolve(new Response(new ReadableStream({ cancel() { cancelledBody++; } }), { headers: { 'Content-Type': 'image/jpeg' } })); await settle();
  assert.equal(cancelledBody, 1); assert.equal(f.cache.getStats().entries, 0);
  assert.deepEqual((await f.cache.get('camera.front')).data, jpeg(2)); assert.equal(calls, 2);
});

test('deadline bounds a never-resolving loader and releases pending consumers', async () => {
  let signal;
  const f = fixture({ load: (_id, input) => { signal = input.signal; return new Promise(() => {}); } });
  const pending = f.cache.get('camera.front'), checked = assert.rejects(pending, error => error.code === 'snapshot_timeout' && error.status === 504);
  await settle(); await f.advance(9999); assert.equal(signal.aborted, false);
  await f.advance(1); await checked; assert.equal(signal.aborted, true); assert.equal(f.cache.getStats().active, 0); assert.equal(f.timers.size, 0); f.cache.close();
});

test('deadline also bounds a response body that stalls after headers and cancels its reader', async () => {
  let cancelled = 0;
  const f = fixture({ load: async () => new Response(new ReadableStream({ start(c) { c.enqueue(jpeg(1).subarray(0, 3)); }, cancel() { cancelled++; } }), { headers: { 'Content-Type': 'image/jpeg' } }) });
  const pending = f.cache.get('camera.front'), checked = assert.rejects(pending, { code: 'snapshot_timeout' });
  await settle(); await f.advance(10000); await checked; await settle();
  assert.equal(cancelled, 1); assert.equal(f.cache.getStats().bytes, 0); assert.equal(f.timers.size, 0); f.cache.close();
});

test('declared and chunked oversized images are rejected and cancelled before they can enter the cache', async () => {
  for (const declared of [false, true]) {
    let cancelled = 0;
    const f = fixture({ maxBytes: 8, load: async () => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(9)); }, cancel() { cancelled++; } }),
      { headers: { 'Content-Type': 'image/jpeg', ...(declared ? { 'Content-Length': '9' } : {}) } }) });
    await assert.rejects(f.cache.get('camera.front'), { code: 'snapshot_too_large' });
    assert.equal(cancelled, 1); assert.equal(f.cache.getStats().entries, 0); f.cache.close();
  }
});

test('wrong MIME, truncated images and upstream failures fail safely and never poison a retry', async () => {
  for (const bad of [() => new Response('private upstream token', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { 'Content-Type': 'image/jpeg' } }),
    () => { throw new Error('http://private-ha/?token=secret'); }]) {
    let calls = 0; const f = fixture({ load: async () => ++calls === 1 ? bad() : response(3) });
    await assert.rejects(f.cache.get('camera.front'), error => error.status === 502 && !/private|secret|token|http/.test(error.message));
    assert.equal(f.cache.getStats().bytes, 0); assert.deepEqual((await f.cache.get('camera.front')).data, jpeg(3)); assert.equal(calls, 2); f.cache.close();
  }
});

test('LRU retention obeys both count and byte budgets, and expired entries are released', async t => {
  let calls = 0; const f = fixture({ maxEntries: 2, maxTotalBytes: 12, load: async () => response(++calls) }); t.after(() => f.cache.close());
  await f.cache.get('camera.a'); await f.cache.get('camera.b'); await f.cache.get('camera.a'); await f.cache.get('camera.c');
  assert.deepEqual(f.cache.getStats(), { active: 0, entries: 2, bytes: 12, waiters: 0 });
  await f.cache.get('camera.b'); assert.equal(calls, 4, 'least recently used b was evicted');
  await f.advance(750); assert.equal(f.cache.getStats().entries, 0); assert.equal(f.cache.getStats().bytes, 0);
});

test('active loads and waiter counts are bounded without allocating an unbounded queue', async () => {
  const f = fixture({ maxActive: 2, maxWaiters: 2, load: () => new Promise(() => {}) });
  const a = f.cache.get('camera.a'), b = f.cache.get('camera.b'), joined = f.cache.get('camera.a');
  const drained = [a, b, joined].map(promise => assert.rejects(promise, { code: 'snapshot_closed' }));
  await assert.rejects(f.cache.get('camera.c'), { code: 'snapshot_busy' });
  await assert.rejects(f.cache.get('camera.a'), { code: 'snapshot_busy' });
  assert.deepEqual(f.cache.getStats(), { active: 2, entries: 0, bytes: 0, waiters: 3 });
  f.cache.close(); await Promise.all(drained); assert.deepEqual(f.cache.getStats(), { active: 0, entries: 0, bytes: 0, waiters: 0 });
});

test('shutdown aborts pending work, erases cached bytes and rejects later requests', async () => {
  let signal; const f = fixture({ load: async (id, options) => { if (id === 'camera.ready') return response(1); signal = options.signal; return new Promise(() => {}); } });
  await f.cache.get('camera.ready'); const pending = f.cache.get('camera.pending'), checked = assert.rejects(pending, { code: 'snapshot_closed' });
  await settle(); f.cache.close(); f.cache.close(); await checked;
  assert.equal(signal.aborted, true); assert.equal(f.timers.size, 0); assert.equal(f.cache.getStats().bytes, 0);
  await assert.rejects(f.cache.get('camera.ready'), { code: 'snapshot_closed' });
});

test('HomeAssistant snapshot propagates caller cancellation to the authenticated fetch', async () => {
  let init, url;
  const ha = new HomeAssistant({ url: 'http://ha.invalid:8123', token: 'test-only-secret', fetchImpl: async (u, input) => { url = u; init = input; return response(1); } });
  const controller = new AbortController(); await ha.snapshot('camera.front', { signal: controller.signal });
  assert.equal(url.pathname, '/api/camera_proxy/camera.front'); assert.equal(init.headers.Authorization, 'Bearer test-only-secret');
  assert.equal(init.signal.aborted, false); controller.abort(); assert.equal(init.signal.aborted, true);
});
