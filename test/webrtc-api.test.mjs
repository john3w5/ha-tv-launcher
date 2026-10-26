import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const ORIGIN = 'http://127.0.0.1:4317';
const CODE = 'webrtc-test-pair';
const SECRET = 'NEVER-EXPOSE-HA-TOKEN';
const OFFER = 'v=0\r\na=recvonly\r\n';
const ANSWER = 'v=0\r\na=sendonly\r\n';
const CANDIDATE = { candidate: 'candidate:1 1 UDP 1 192.168.50.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };

async function fixture(t, factory) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tv-webrtc-api-'));
  const calls = [], signals = [];
  const createWebRtcSession = factory || (async options => {
    calls.push(options);
    const signal = { answer: ANSWER, candidates: [CANDIDATE], sent: [], closed: 0,
      async sendCandidate(candidate) { this.sent.push(candidate); }, close() { this.closed++; } };
    signals.push(signal); return signal;
  });
  const bridge = await createBridge({ root, env: { PORT: '4317', TV_CLIENT_TOKEN: CODE, HA_URL: 'http://ha.example.invalid', HA_TOKEN: SECRET },
    config: { entities: { cameras: [{ id: 'entrance', name: 'Vchod', entityId: 'camera.main', streamEntityId: 'camera.low' }] } },
    ha: { base: new URL('http://ha.example.invalid') }, createWebRtcSession });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  const request = (route, { method = 'GET', body, cookie, origin = ORIGIN, headers = {}, signal } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.server.address().port, path: route, method, signal,
      headers: { Host: '127.0.0.1:4317', Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers } }, response => {
      resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const post = (route, body, options = {}) => request(route, { ...options, method: 'POST', body });
  const pair = async () => {
    const response = await post('/api/pair', { code: CODE }); assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const cookie = await pair();
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  return { bridge, request, post, pair, cookie, calls, signals };
}

test('WebRTC creation requires cookie+Origin and chooses only configured camera profiles', async t => {
  const f = await fixture(t);
  const url = '/api/cameras/entrance/webrtc';
  assert.equal((await f.post(url, { offer: OFFER })).status, 401);
  assert.equal((await f.post(url, { offer: OFFER }, { cookie: f.cookie, origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await f.post('/api/cameras/unknown/webrtc', { offer: OFFER }, { cookie: f.cookie })).status, 404);
  assert.equal(f.calls.length, 0);
  const response = await f.post(url, { offer: OFFER }, { cookie: f.cookie });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.sessionId, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(result.quality, 'smooth'); assert.equal(result.answer, ANSWER);
  assert.deepEqual(result.candidates, [CANDIDATE]);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(f.calls[0].entityId, 'camera.low');
  const hd = await f.post(url, { offer: OFFER, quality: 'hd' }, { cookie: f.cookie });
  assert.equal((await hd.json()).quality, 'hd'); assert.equal(f.calls[1].entityId, 'camera.main');
  assert.equal((await f.post(url, { offer: OFFER }, { cookie: f.cookie })).status, 429);
});

test('WebRTC IDs are session-bound; delete and logout clean the underlying session once', async t => {
  const f = await fixture(t);
  const result = await (await f.post('/api/cameras/entrance/webrtc', { offer: OFFER }, { cookie: f.cookie })).json();
  const route = `/api/webrtc/${result.sessionId}`;
  const other = await f.pair();
  assert.equal((await f.request(route + '/events')).status, 401);
  assert.equal((await f.request(route + '/events', { cookie: other })).status, 404);
  assert.equal((await f.post(route + '/candidate', { candidate: CANDIDATE }, { cookie: other })).status, 404);
  assert.equal((await f.request(route, { method: 'DELETE', cookie: other })).status, 404);
  assert.equal((await f.request(route, { method: 'DELETE', cookie: f.cookie, origin: 'http://evil.invalid' })).status, 403);
  assert.equal(f.signals[0].closed, 0);
  assert.equal((await f.request(route, { method: 'DELETE', cookie: f.cookie })).status, 200);
  assert.equal(f.signals[0].closed, 1);
  assert.equal((await f.request(route, { method: 'DELETE', cookie: f.cookie })).status, 404);
  const second = await (await f.post('/api/cameras/entrance/webrtc', { offer: OFFER }, { cookie: f.cookie })).json();
  assert.equal((await f.post('/api/logout', {}, { cookie: f.cookie })).status, 200);
  assert.equal(f.signals[1].closed, 1);
  assert.equal((await f.request(`/api/webrtc/${second.sessionId}/events`, { cookie: other })).status, 404);
});

test('bounded SDP/candidates reject unknown fields, control characters and arbitrary entities', async t => {
  const f = await fixture(t);
  for (const body of [{ offer: '' }, { offer: OFFER, entityId: 'camera.unconfigured' }, { offer: OFFER, quality: 'bad' }, { offer: 'v=0\r\n\0' }]) {
    assert.equal((await f.post('/api/cameras/entrance/webrtc', body, { cookie: f.cookie })).status, 400);
  }
  assert.equal((await f.post('/api/cameras/entrance/webrtc', { offer: 'v=0\r\n' + 'a'.repeat(66000) }, { cookie: f.cookie })).status, 413);
  assert.equal(f.calls.length, 0);
  const result = await (await f.post('/api/cameras/entrance/webrtc', { offer: OFFER }, { cookie: f.cookie })).json();
  const route = `/api/webrtc/${result.sessionId}/candidate`;
  for (const candidate of [null, { ...CANDIDATE, candidate: 'x\r\nx' }, { ...CANDIDATE, url: 'file:///etc/passwd' }, { ...CANDIDATE, sdpMLineIndex: -1 }, { ...CANDIDATE, candidate: 'x'.repeat(4097) }]) {
    assert.equal((await f.post(route, { candidate }, { cookie: f.cookie })).status, 400);
  }
  assert.equal((await f.post(route, { candidate: CANDIDATE }, { cookie: f.cookie, origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await f.post(route, { candidate: CANDIDATE }, { cookie: f.cookie })).status, 200);
  assert.deepEqual(f.signals[0].sent, [CANDIDATE]);
});

test('SSE delivers post-answer candidates, supports resume and closes on delete', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const result = await (await f.post('/api/cameras/entrance/webrtc', { offer: OFFER }, { cookie: f.cookie })).json();
  const later = { ...CANDIDATE, candidate: CANDIDATE.candidate.replace('5000', '5001') };
  f.calls[0].onCandidate(later);
  const response = await f.request(`/api/webrtc/${result.sessionId}/events`, { cookie: f.cookie });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const readUntil = async pattern => {
    let text = '';
    for (let count = 0; count < 10; count++) {
      const item = await reader.read();
      if (item.done) break;
      text += new TextDecoder().decode(item.value);
      if (pattern.test(text)) return text;
    }
    assert.fail('Expected SSE event was not received');
  };
  const chunk = await readUntil(/event: candidate/);
  assert.match(chunk, /id: 2\nevent: candidate/); assert.match(chunk, /5001/);
  assert.equal(chunk.includes('5000'), false);
  assert.equal((await f.request(`/api/webrtc/${result.sessionId}/events`, { cookie: f.cookie, headers: { 'Last-Event-ID': 'invalid' } })).status, 400);
  await f.request(`/api/webrtc/${result.sessionId}`, { method: 'DELETE', cookie: f.cookie });
  const closing = await readUntil(/event: closed/);
  assert.match(closing, /event: closed/);
  assert.equal(f.signals[0].closed, 1);
});

test('HA errors and invalid answer fail safely without exposing secrets or leaving sessions', async t => {
  const f = await fixture(t, async () => { throw new Error(SECRET); });
  const response = await f.post('/api/cameras/entrance/webrtc', { offer: OFFER }, { cookie: f.cookie });
  assert.equal(response.status, 502); assert.equal((await response.text()).includes(SECRET), false);
  let closed = 0;
  const bad = await fixture(t, async () => ({ answer: SECRET, candidates: [], close() { closed++; } }));
  const result = await bad.post('/api/cameras/entrance/webrtc', { offer: OFFER }, { cookie: bad.cookie });
  assert.equal(result.status, 502); assert.equal(closed, 1);
});
