import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile, stat, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const ORIGIN = 'http://127.0.0.1:4317';
const CODE = 'test-photo-pairing';
const LIMIT = 12 * 1024 * 1024;
// Signature fixtures exercise transport and storage; this suite does not claim image decoding.
const JPEG = Buffer.from('ffd8ffe000041234ffd9', 'hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz3cAAAAASUVORK5CYII=', 'base64');
const WEBP = Buffer.from('5249464614000000574542505650384c080000002f00000000000000', 'hex');
const filename = (data, extension = '.jpg') => `${createHash('sha256').update(data).digest('hex')}${extension}`;

async function fixture(t, { mode = 'live', photoDirectory } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'domov-photo-upload-'));
  const env = { PORT: '4317', TV_CLIENT_TOKEN: CODE,
    ...(mode !== 'demo' ? { HA_URL: 'http://ha.invalid' } : {}),
    ...(mode === 'live' ? { HA_TOKEN: 'test-only-token' } : {}),
    ...(photoDirectory ? { PHOTO_DIR: path.join(root, photoDirectory) } : {}) };
  const bridge = await createBridge({ root, env, config: {}, ha: {}, websocketClass: null });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const request = (route, { body, method = 'GET', headers = {}, chunked = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: route, method,
      agent: false, headers: { Host: '127.0.0.1:4317', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks),
        json: () => JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    if (chunked) { req.write(body.subarray(0, 1024)); req.end(body.subarray(1024)); }
    else req.end(body);
  });
  const paired = await request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE }) });
  assert.equal(paired.status, 200);
  const cookie = paired.headers['set-cookie'][0].split(';')[0];
  const upload = (data = JPEG, type = 'image/jpeg', headers = {}, options = {}) => request('/api/photos/upload', {
    method: 'POST', body: data, headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': type, ...headers }, ...options,
  });
  return { root, photos: path.join(root, photoDirectory || 'private/photos'), cookie, request, upload };
}

test('photo upload requires cookie, exact allowed Origin and a live bridge', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload(JPEG, 'image/jpeg', { Cookie: '' })).status, 401);
  assert.equal((await f.upload(JPEG, 'image/jpeg', { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.upload(JPEG, 'image/jpeg', { Origin: '' })).status, 403);
  await assert.rejects(stat(f.photos), { code: 'ENOENT' });
  for (const mode of ['demo', 'setup']) {
    const unavailable = await fixture(t, { mode });
    assert.equal((await unavailable.upload()).status, 503);
    await assert.rejects(stat(unavailable.photos), { code: 'ENOENT' });
  }
});

test('matching JPEG, PNG and WebP are private, server-named and returned in GET photo format', async t => {
  const f = await fixture(t);
  const photos = [];
  for (const [data, type, extension] of [[JPEG, 'image/jpeg', '.jpg'], [PNG, 'image/png', '.png'], [WEBP, 'image/webp', '.webp']]) {
    const uploaded = await f.upload(data, type, { 'Content-Disposition': 'attachment; filename="../../public/evil.svg"' });
    assert.equal(uploaded.status, 201);
    const photo = uploaded.json().photo;
    assert.match(photo.id, /^[a-f0-9]{24}$/);
    assert.equal(photo.url, `/api/photos/${photo.id}/file`);
    const actual = path.join(f.photos, filename(data, extension));
    assert.deepEqual(await readFile(actual), data);
    assert.equal((await stat(actual)).mode & 0o777, 0o600);
    assert.equal((await f.request(photo.url)).status, 401);
    const stored = await f.request(photo.url, { headers: { Cookie: f.cookie } });
    assert.equal(stored.status, 200); assert.equal(stored.headers['content-type'], type);
    assert.deepEqual(stored.raw, data);
    photos.push(photo);
  }
  const listing = (await f.request('/api/photos', { headers: { Cookie: f.cookie } })).json();
  assert.deepEqual(listing.sort((a, b) => a.id.localeCompare(b.id)), photos.sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal((await readdir(f.photos)).length, 3);
});

test('spoofed, unsupported and truncated types never create a photograph', async t => {
  const f = await fixture(t);
  for (const [data, type] of [[PNG, 'image/jpeg'], [JPEG, 'image/png'], [WEBP, 'image/gif'],
    [Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png'], [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.alloc(0), 'image/jpeg'], [JPEG.subarray(0, 4), 'image/jpeg'], [Buffer.from('RIFF0000WEBPVP8L'), 'image/webp']]) {
    assert.equal((await f.upload(data, type)).status, 415, type);
  }
  await assert.rejects(stat(f.photos), { code: 'ENOENT' });
});

test('12 MiB bound is enforced for declared-length and chunked bodies', async t => {
  const f = await fixture(t);
  const oversized = Buffer.alloc(LIMIT + 1); JPEG.copy(oversized); oversized.set([0xff, 0xd9], oversized.length - 2);
  // Header rejection happens before receiving bytes; do not transmit a huge body
  // after the server has already rejected and closed this Connection: close test.
  assert.equal((await f.upload(JPEG, 'image/jpeg', { 'Content-Length': String(oversized.length) })).status, 413);
  assert.equal((await f.upload(oversized, 'image/jpeg', {}, { chunked: true })).status, 413);
  await assert.rejects(stat(f.photos), { code: 'ENOENT' });
  const exact = oversized.subarray(1); exact.set([0xff, 0xd8, 0xff], 0);
  assert.equal((await f.upload(exact)).status, 201);
  assert.equal((await stat(path.join(f.photos, filename(exact)))).size, LIMIT);
});

test('duplicates including concurrent uploads reuse the same file without overwriting it', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([f.upload(), f.upload()]);
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 201]);
  assert.deepEqual(responses[0].json(), responses[1].json());
  const before = await stat(path.join(f.photos, filename(JPEG)));
  assert.equal((await f.upload()).status, 200);
  const after = await stat(path.join(f.photos, filename(JPEG)));
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await readdir(f.photos)).length, 1);
});

test('symlinked private/photo directories and destination files cannot escape or overwrite', async t => {
  for (const component of ['private', 'private/photos']) {
    const f = await fixture(t, { photoDirectory: component === 'private' ? 'private/photos' : undefined });
    const outside = path.join(f.root, 'outside'); await mkdir(outside);
    if (component.includes('/')) await mkdir(path.join(f.root, 'private'));
    await symlink(outside, path.join(f.root, component));
    assert.equal((await f.upload()).status, 409);
    assert.deepEqual(await readdir(outside), []);
  }
  const f = await fixture(t);
  await mkdir(f.photos, { recursive: true });
  const outsideFile = path.join(f.root, 'must-remain.txt'); await writeFile(outsideFile, 'original');
  await symlink(outsideFile, path.join(f.photos, filename(JPEG)));
  assert.equal((await f.upload()).status, 409);
  assert.equal(await readFile(outsideFile, 'utf8'), 'original');
});

test('an existing conflicting file is rejected and never replaced', async t => {
  const f = await fixture(t); await mkdir(f.photos, { recursive: true });
  const conflict = path.join(f.photos, filename(JPEG)); await writeFile(conflict, Buffer.alloc(JPEG.length, 42), { mode: 0o600 });
  assert.equal((await f.upload()).status, 409);
  assert.deepEqual(await readFile(conflict), Buffer.alloc(JPEG.length, 42));
});
