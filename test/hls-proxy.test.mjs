import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { createHlsRequest, readHlsPlaylist, pipeHlsMedia, createHlsResources } from '../lib/hls-proxy.mjs';

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const allowed = url => url.origin === 'http://ha.invalid' && !url.username && !url.password;

test('playlist decoding counts encoded bytes and never calls an unbounded response.text()', async () => {
  const bytes = Buffer.from('#EXTM3U\n# český popisek\nsegment.ts\n');
  const response = new Response(bytes); response.text = () => assert.fail('Unbounded text() must not run');
  assert.equal(await readHlsPlaylist(response, { maxBytes: bytes.length }), bytes.toString());
  await assert.rejects(readHlsPlaylist(new Response(bytes), { maxBytes: bytes.length - 1 }), { code: 'hls_playlist_invalid' });
});

test('oversized content-length and chunked playlist bodies are cancelled before buffering past the limit', async () => {
  for (const declared of [true, false]) {
    let cancelled = 0;
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(33)); }, cancel() { cancelled++; } }), { headers: declared ? { 'Content-Length': '33' } : {} });
    await assert.rejects(readHlsPlaylist(response, { maxBytes: 32 }), { code: 'hls_playlist_invalid' });
    assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
  }
});

test('non-playlists and invalid UTF-8 fail without returning their private contents', async () => {
  for (const bytes of [Buffer.from('http://private/?token=secret'), Buffer.from([0xff, 0xfe, 0xff])]) {
    await assert.rejects(readHlsPlaylist(new Response(bytes)), error => error.status === 502 && !/private|secret|token|http/.test(error.message));
  }
});

test('aborting a stalled playlist cancels the reader and releases its lock', async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from('#EXTM3U\n')); }, cancel() { cancelled++; } }));
  const controller = new AbortController(), pending = readHlsPlaylist(response, { signal: controller.signal });
  const checked = assert.rejects(pending, { name: 'AbortError' }); await settle(); controller.abort(); await checked;
  assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
});

test('media pipeline preserves bytes and cancels its upstream under backpressure when the client leaves', async () => {
  const chunks = [], completed = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  await pipeHlsMedia(new Response(Buffer.from([1, 2, 3])), completed);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3]));
  let cancelled = 0, firstWrite;
  const started = new Promise(resolve => { firstWrite = resolve; });
  const destination = new Writable({ highWaterMark: 1, write() { firstWrite(); /* Backpressure until cancellation. */ } });
  const source = new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(1024)); }, cancel() { cancelled++; } }));
  const controller = new AbortController(), pending = pipeHlsMedia(source, destination, { signal: controller.signal });
  const checked = assert.rejects(pending, { name: 'AbortError' }); await started; controller.abort(); await checked;
  assert.equal(cancelled, 1); assert.equal(destination.destroyed, true);
});

test('resource LRU supports an indefinitely advancing playlist without a permanent lifetime cap', () => {
  const resources = createHlsResources({ allow: allowed, maxEntries: 3 });
  const playlist = resources.register('http://ha.invalid/index.m3u8?token=secret', { pinned: true });
  let first, latest;
  for (let sequence = 0; sequence < 3000; sequence++) {
    latest = resources.register(`http://ha.invalid/${sequence}.ts?token=secret`); first ||= latest;
    assert.ok(resources.size <= 3);
  }
  assert.equal(resources.get(first), null); assert.match(resources.get(latest), /2999\.ts/);
  assert.ok(resources.get(playlist)); assert.match(latest, /^[A-Za-z0-9_-]+$/); assert.doesNotMatch(latest, /secret|http|ha\.invalid/);
});

test('resource access refreshes LRU and TTL while expired IDs never point to a different source', () => {
  let now = 0; const resources = createHlsResources({ allow: allowed, now: () => now, ttlMs: 100, maxEntries: 2 });
  const a = resources.register('http://ha.invalid/a.ts'), b = resources.register('http://ha.invalid/b.ts');
  now = 50; assert.ok(resources.get(a)); const c = resources.register('http://ha.invalid/c.ts');
  assert.equal(resources.get(b), null); assert.ok(resources.get(c));
  now = 149; assert.equal(resources.register('http://ha.invalid/a.ts'), a);
  now = 250; assert.equal(resources.get(a), null);
  const fresh = resources.register('http://ha.invalid/a.ts'); assert.notEqual(fresh, a); assert.equal(resources.get(a), null);
  assert.equal(resources.get('forged-opaque-token'), null);
});

test('resource registration rechecks the configured URL allowlist and bounds individual URLs', () => {
  const resources = createHlsResources({ allow: allowed });
  for (const url of ['http://outside.invalid/segment.ts', 'http://user:secret@ha.invalid/segment.ts', 'file:///private/secret', 'not a URL', 'http://ha.invalid/' + 'x'.repeat(8200)]) {
    assert.throws(() => resources.register(url), error => error.status === 502 && !/outside|private|secret/.test(error.message));
  }
  assert.equal(resources.size, 0);
});

test('request lifecycle separates normal completion from a disconnected client and removes listeners', () => {
  for (const normal of [true, false]) {
    const req = new EventEmitter(), res = Object.assign(new EventEmitter(), { writableEnded: normal, destroyed: false });
    const lifecycle = createHlsRequest(req, res); res.emit('close');
    assert.equal(lifecycle.signal.aborted, !normal); assert.equal(lifecycle.disconnected, !normal);
    lifecycle.dispose(); lifecycle.dispose(); assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
  }
});

test('one request deadline covers a stalled upstream and keeps a safe typed timeout', async () => {
  const req = new EventEmitter(), res = Object.assign(new EventEmitter(), { writableEnded: false });
  const lifecycle = createHlsRequest(req, res, { timeoutMs: 10 });
  // A ref'ed test timer keeps the process alive while the production deadline is unref'ed.
  const keeper = setTimeout(() => {}, 1000);
  try {
    await new Promise(resolve => lifecycle.signal.addEventListener('abort', resolve, { once: true }));
    assert.equal(lifecycle.signal.reason.status, 504); assert.equal(lifecycle.signal.reason.code, 'hls_timeout'); assert.equal(lifecycle.disconnected, false);
  } finally { clearTimeout(keeper); lifecycle.dispose(); }
});
