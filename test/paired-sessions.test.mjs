import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, writeFile, chmod, stat, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';
import { createPairedSessions } from '../lib/paired-sessions.mjs';

const CODE = 'pair-test-code-only';
const ORIGIN = 'http://127.0.0.1:4317';
const RAW = '12345678901234567890123456789012';

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tv-paired-session-')));
  const storePath = path.join(root, 'private', 'paired-sessions.json');
  const active = new Set();
  t.after(async () => { for (const bridge of active) await bridge.close(); await rm(root, { recursive: true, force: true }); });
  async function start(extra = {}) {
    const bridge = await createBridge({ root, config: {}, env: { PORT: '4317', TV_CLIENT_TOKEN: CODE, ...options }, sessionStorePath: storePath, ...extra });
    active.add(bridge);
    await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
    const request = (route, { cookie, origin = ORIGIN, body, method = body === undefined ? 'GET' : 'POST' } = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: route, method,
        headers: { Host: '127.0.0.1:4317', Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return { bridge, request, async stop() { active.delete(bridge); await bridge.close(); } };
  }
  return { root, storePath, start };
}

test('paired cookie survives a real bridge close/recreation; only hashes persist privately', async t => {
  const f = await fixture(t);
  const first = await f.start();
  const pair = await first.request('/api/pair', { body: { code: CODE } });
  assert.equal(pair.status, 200);
  const setCookie = pair.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000/);
  const cookie = setCookie.split(';')[0];
  const raw = cookie.slice('tv_session='.length);
  const saved = await readFile(f.storePath, 'utf8');
  assert.equal(saved.includes(raw), false);
  assert.equal(saved.includes(CODE), false);
  const data = JSON.parse(saved);
  assert.equal(data.sessions[0].hash, createHash('sha256').update(raw).digest('hex'));
  assert.equal((await stat(f.storePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(f.storePath))).mode & 0o777, 0o700);
  await first.stop();
  const second = await f.start();
  assert.equal((await second.request('/api/bootstrap', { cookie })).body.authenticated, true);
  assert.equal((await second.request('/api/bootstrap', { cookie: `tv_session=${RAW}` })).body.authenticated, false);
  assert.equal((await second.request('/api/bootstrap', { cookie: 'tv_session=malformed' })).body.authenticated, false);
});

test('logout is origin-checked and revocation survives restart', async t => {
  const f = await fixture(t);
  const first = await f.start();
  const pair = await first.request('/api/pair', { body: { code: CODE } });
  const cookie = pair.headers['set-cookie'][0].split(';')[0];
  assert.equal((await first.request('/api/logout', { cookie, origin: 'http://evil.invalid', body: {} })).status, 403);
  assert.equal((await first.request('/api/bootstrap', { cookie })).body.authenticated, true);
  const logout = await first.request('/api/logout', { cookie, body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.deepEqual(JSON.parse(await readFile(f.storePath, 'utf8')).sessions, []);
  await first.stop();
  const second = await f.start();
  assert.equal((await second.request('/api/bootstrap', { cookie })).body.authenticated, false);
  assert.equal((await second.request('/api/logout', { cookie, body: {} })).status, 401);
});

test('expired persisted cookies are pruned on startup', async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.storePath), { mode: 0o700 });
  await writeFile(f.storePath, JSON.stringify({ version: 1, sessions: [{ hash: createHash('sha256').update(RAW).digest('hex'), expiresAt: Date.now() - 1 }] }), { mode: 0o600 });
  const app = await f.start();
  assert.equal((await app.request('/api/bootstrap', { cookie: `tv_session=${RAW}` })).body.authenticated, false);
  assert.deepEqual(JSON.parse(await readFile(f.storePath, 'utf8')).sessions, []);
});

test('corrupt or permissive stores fail closed without replacing their content', async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.storePath), { mode: 0o700 });
  await writeFile(f.storePath, 'corrupt not json', { mode: 0o600 });
  await assert.rejects(f.start(), /storage is unreadable or unsafe/);
  assert.equal(await readFile(f.storePath, 'utf8'), 'corrupt not json');
  await writeFile(f.storePath, JSON.stringify({ version: 1, sessions: [] }));
  await chmod(f.storePath, 0o644);
  await assert.rejects(f.start(), /storage is unreadable or unsafe/);
});

test('file and ancestor symlinks are rejected; outside targets remain intact', async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.storePath), { mode: 0o700 });
  const outside = path.join(f.root, 'outside.json');
  await writeFile(outside, '{"preserve":true}', { mode: 0o600 });
  await symlink(outside, f.storePath);
  await assert.rejects(f.start(), /storage is unreadable or unsafe/);
  assert.equal(await readFile(outside, 'utf8'), '{"preserve":true}');
  await rm(f.storePath);
  await rm(path.dirname(f.storePath), { recursive: true });
  const directory = path.join(f.root, 'outside-directory');
  await mkdir(directory, { mode: 0o700 });
  await symlink(directory, path.dirname(f.storePath));
  await assert.rejects(f.start(), /storage is unreadable or unsafe/);
});

test('duration is bounded and persistence is disabled by default', async t => {
  for (const [input, expected] of [[0, 1], [-1, 1], [500, 90], [1, 1], ['', 30], ['invalid', 30]]) {
    const sessions = await createPairedSessions({ ttlDays: input });
    assert.equal(sessions.ttlSeconds, expected * 86400);
    await sessions.add(RAW);
    assert.equal(sessions.has(RAW), true);
    await sessions.revoke(RAW);
    assert.equal(sessions.has(RAW), false);
  }
  const f = await fixture(t);
  const app = await f.start({ sessionStorePath: '' });
  assert.equal((await app.request('/api/pair', { body: { code: CODE } })).status, 200);
  await assert.rejects(stat(f.storePath), { code: 'ENOENT' });
});
