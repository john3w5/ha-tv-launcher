import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const CODE = 'test-profile-code';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tv-profile-'));
  const folder = path.join(root, 'private', 'profile');
  const filename = path.join(folder, 'avatar.png');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const bridge = await createBridge({ root, config: {}, env: { PORT: '4317', TV_CLIENT_TOKEN: CODE } });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  const request = (route, { cookie, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: route, method,
      headers: { Host: '127.0.0.1:4317', Origin: 'http://127.0.0.1:4317', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const paired = await request('/api/pair', { method: 'POST', body: { code: CODE } });
  const cookie = paired.headers['set-cookie'][0].split(';')[0];
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  return { root, folder, filename, cookie, request };
}

test('profile is omitted publicly and fixed photo requires pairing; MIME follows real bytes', async t => {
  const f = await fixture(t);
  await writeFile(f.filename, JPEG, { mode: 0o600 });
  const anonymous = JSON.parse((await f.request('/api/bootstrap')).data);
  assert.equal('profile' in anonymous, false);
  assert.equal((await f.request('/api/profile/photo')).status, 401);
  const profile = JSON.parse((await f.request('/api/bootstrap', { cookie: f.cookie })).data).profile;
  assert.deepEqual(profile, { available: true, url: '/api/profile/photo', name: 'Domácnost' });
  const photo = await f.request(profile.url, { cookie: f.cookie });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers['content-type'], 'image/jpeg');
  assert.equal(photo.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(photo.data, JPEG);
  const head = await f.request(profile.url, { cookie: f.cookie, method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.data.length, 0);
});

test('query filenames cannot select another private file', async t => {
  const f = await fixture(t);
  await writeFile(f.filename, JPEG, { mode: 0o600 });
  await writeFile(path.join(f.root, '.env'), 'PRIVATE-SHOULD-NOT-LEAK');
  const photo = await f.request('/api/profile/photo?path=../../.env&file=/etc/passwd', { cookie: f.cookie });
  assert.equal(photo.status, 200); assert.deepEqual(photo.data, JPEG);
  assert.equal((await f.request('/api/profile/photo/../../.env', { cookie: f.cookie })).status, 404);
});

test('missing, invalid and oversized images are unavailable', async t => {
  const f = await fixture(t);
  for (const content of [null, Buffer.from('<svg onload="alert(1)"></svg>')]) {
    if (content) await writeFile(f.filename, content, { mode: 0o600 });
    assert.equal(JSON.parse((await f.request('/api/bootstrap', { cookie: f.cookie })).data).profile.available, false);
    assert.equal((await f.request('/api/profile/photo', { cookie: f.cookie })).status, 404);
  }
  const handle = await open(f.filename, 'w');
  try { await handle.truncate(12 * 1024 * 1024 + 1); } finally { await handle.close(); }
  assert.equal((await f.request('/api/profile/photo', { cookie: f.cookie })).status, 404);
});

test('file and private-directory symlinks never expose their targets', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'avatar.png'), JPEG);
  await symlink(path.join(outside, 'avatar.png'), f.filename);
  assert.equal((await f.request('/api/profile/photo', { cookie: f.cookie })).status, 404);
  await rm(f.folder, { recursive: true });
  await symlink(outside, f.folder);
  assert.equal((await f.request('/api/profile/photo', { cookie: f.cookie })).status, 404);
  await rm(f.folder);
  await rm(path.join(f.root, 'private'), { recursive: true });
  await symlink(outside, path.join(f.root, 'private'));
  assert.equal((await f.request('/api/profile/photo', { cookie: f.cookie })).status, 404);
});
