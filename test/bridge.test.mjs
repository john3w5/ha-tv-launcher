import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const CODE = '12345678-test';
const WEBHOOK = 'a-separate-long-webhook-secret';
const HA_SECRET = 'never-expose-this-HA-token';
const ORIGIN = 'http://127.0.0.1:4317';

async function fixture(t, { live = true, customHa, failScene = false, extraApps = [], cameraAlternate, notificationNow } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'home-tv-launcher-test-'));
  await mkdir(path.join(root, 'public'));
  for (const id of ['relax', 'rodinne-kvizy', 'not-a-builtin']) {
    await mkdir(path.join(root, 'public', 'apps', id), { recursive: true });
    await writeFile(path.join(root, 'public', 'apps', id, 'index.html'), `<h1>${id}</h1>`);
  }
  await mkdir(path.join(root, 'apps', 'test'), { recursive: true });
  await mkdir(path.join(root, 'private', 'photos'), { recursive: true });
  await writeFile(path.join(root, 'public', 'index.html'), '<h1>TV</h1>');
  await writeFile(path.join(root, '.env'), `HA_TOKEN=${HA_SECRET}`);
  await writeFile(path.join(root, 'apps', 'test', 'index.html'), '<h1>App</h1>');
  await symlink(path.join(root, '.env'), path.join(root, 'public', 'escape.txt'));
  await writeFile(path.join(root, 'private', 'photos', 'rodina.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(path.join(root, 'private', 'photos', 'private.txt'), 'not a photograph');
  await symlink(path.join(root, '.env'), path.join(root, 'private', 'photos', 'escape.jpg'));
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization, method: req.method });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/states') return res.end(JSON.stringify([
      { entity_id: 'sensor.temperature', state: '14.2', attributes: { unit_of_measurement: '°C' } },
      { entity_id: 'sensor.wind', state: '12', attributes: { unit_of_measurement: 'km/h' } },
      { entity_id: 'sensor.humidity', state: 'unavailable', attributes: {} },
      { entity_id: 'camera.front', state: 'idle', attributes: { supported_features: 2, access_token: 'camera-secret' } },
      { entity_id: 'media_player.tv', state: 'on', attributes: { source: 'TV' } },
      { entity_id: 'scene.evening', state: 'unknown', attributes: {} },
      { entity_id: 'light.kitchen', state: 'on', attributes: {} },
      { entity_id: 'light.controller', state: 'on', attributes: {} },
      { entity_id: 'lock.front', state: 'unavailable', attributes: {} },
      { entity_id: 'binary_sensor.door', state: 'off', attributes: {} },
    ]));
    if (req.url.startsWith('/api/calendars/calendar.family?')) return res.end(JSON.stringify([
      { summary: 'Rodinná akce', start: { dateTime: '2026-10-24T10:00:00+02:00' }, end: { dateTime: '2026-10-24T12:00:00+02:00' }, description: HA_SECRET },
      { summary: 'Celý den', start: { date: '2026-10-25' }, end: { date: '2026-10-26' } },
    ]));
    if (req.url === '/api/camera_proxy/camera.front') { res.setHeader('Content-Type', 'image/jpeg'); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); }
    if (req.url === '/api/services/scene/turn_on') { if (failScene) res.statusCode = 500; return res.end(failScene ? JSON.stringify({ message: HA_SECRET }) : '[]'); }
    if (req.url.startsWith('/hls/index.m3u8')) { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?token=stream-secret"\n#EXTINF:2,\nsegment.ts?token=stream-secret\n'); }
    if (req.url.startsWith('/hls/segment.ts')) { res.setHeader('Content-Type', 'video/mp2t'); return res.end(Buffer.from([1, 2, 3])); }
    if (req.url.startsWith('/hls/key.bin')) { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(Buffer.alloc(16)); }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const config = {
    household: 'Domov', apps: [{ id: 'test', name: 'Test', url: '/apps/test/', localDirectory: 'apps/test' }, ...extraApps],
    entities: {
      weather: { temperature: 'sensor.temperature', humidity: 'sensor.humidity', windSpeed: 'sensor.wind' },
      calendars: [{ entityId: 'calendar.family', name: 'Rodina' }], cameras: [{ id: 'front', entityId: 'camera.front', name: 'Vstup', ...(cameraAlternate ? { streamEntityId: cameraAlternate } : {}) }],
      mediaPlayers: [{ entityId: 'media_player.tv', name: 'TCL' }], scenes: [{ entityId: 'scene.evening', name: 'Večer' }],
      lights: [{ entityId: 'light.kitchen', name: 'Kuchyně', area: 'Kuchyně' }, { entityId: 'light.controller', name: 'Řadič', role: 'controller-status' }],
      locks: [{ entityId: 'lock.front', name: 'Zámek' }], doors: [{ entityId: 'binary_sensor.door', name: 'Dveře' }], alarm: { entityId: 'alarm_control_panel.home', name: 'Alarm' },
    }, safeScenes: ['scene.evening'], allowedMediaHosts: ['media.example.test'],
  };
  const env = { PORT: '4317', TV_CLIENT_TOKEN: CODE, TV_WEBHOOK_TOKEN: WEBHOOK, ...(live ? { HA_URL: upstreamUrl, HA_TOKEN: HA_SECRET } : {}) };
  // REST tests use a REST-only upstream; persistent-notification WebSockets have their own suite.
  const bridge = await createBridge({ root, config, env, websocketClass: null, notificationNow, ...(customHa ? { ha: customHa(upstreamUrl) } : {}) });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  // Use HTTP directly so Host-header attack tests exercise the server on Node versions
  // whose fetch intentionally replaces a supplied Host header.
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const request = http.request(`${base}${route}`, { method: options.method || 'GET', signal: options.signal,
      headers: { Host: '127.0.0.1:4317', ...options.headers } }, response => {
      resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers }));
    });
    request.on('error', reject);
    request.end(options.body);
  });
  const post = (route, body, headers = {}) => request(route, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const pair = async () => {
    const response = await post('/api/pair', { code: CODE });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  t.after(async () => { await bridge.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { request, post, pair, root, requests, upstreamUrl, bridge };
}

test('public bootstrap omits live data, pairing is origin checked, private data requires cookie', async t => {
  const f = await fixture(t);
  const bootstrap = await (await f.request('/api/bootstrap')).json();
  assert.equal(bootstrap.mode, 'live');
  assert.equal(bootstrap.authenticated, false);
  assert.equal(bootstrap.apps[0].localDirectory, undefined);
  assert.ok(!JSON.stringify(bootstrap).includes(HA_SECRET));
  assert.equal((await f.request('/api/dashboard')).status, 401);
  assert.equal((await f.post('/api/pair', { code: CODE }, { Origin: 'http://evil.test' })).status, 403);
  assert.equal((await f.post('/api/pair', { code: 'wrong-code' })).status, 401);
  const response = await f.post('/api/pair', { code: CODE });
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/api/dashboard', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await f.request('/api/bootstrap', { headers: { Host: 'attacker.test' } })).status, 403);
});

test('dashboard uses HA sensor units, calendar dates and explicit unknown lock state; no raw attributes', async t => {
  const f = await fixture(t);
  const cookie = await f.pair();
  const response = await f.request('/api/dashboard', { headers: { Cookie: cookie } });
  const text = await response.text();
  const dashboard = JSON.parse(text);
  assert.equal(dashboard.weather.temperature, 14.2);
  assert.equal(dashboard.weather.humidity, null);
  assert.equal(dashboard.weather.units.windSpeed, 'km/h');
  assert.equal(dashboard.calendars[0].events[1].start, '2026-10-25');
  assert.equal(dashboard.home.locks[0].state, 'unavailable');
  assert.equal(dashboard.home.doors[0].state, 'off');
  assert.equal(dashboard.home.alarm.state, 'unavailable');
  assert.equal(dashboard.home.lights[1].role, 'controller-status');
  assert.equal(dashboard.cameras[0].streamType, 'hls');
  assert.ok(!text.includes(HA_SECRET));
  assert.ok(!text.includes('camera-secret'));
  assert.ok(f.requests.every(request => request.auth === `Bearer ${HA_SECRET}`));
  assert.ok(f.requests.some(request => request.path.includes('start=') && request.path.includes('end=')));
});

test('notification and playback require authorized caller; playback URL is allowlisted', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/notify', { message: 'Ding' })).status, 401);
  assert.equal((await f.post('/api/notify', { message: 'Ding' }, { Authorization: WEBHOOK })).status, 401);
  const bearer = { Authorization: `Bearer ${WEBHOOK}` };
  assert.equal((await f.post('/api/notify', { message: 'Ding' }, bearer)).status, 202);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://evil.test/x.mp4', '//evil.test/x', '/media/../.env', '/media/%2e%2e/.env']) {
    assert.equal((await f.post('/api/media', { url }, bearer)).status, 400, url);
  }
  assert.equal((await f.post('/api/media', { url: 'https://media.example.test/film.mp4', type: 'video' }, bearer)).status, 202);
  assert.equal((await f.post('/api/media', { url: '/media/film.mp4' }, bearer)).status, 202);
});

test('notification HTTP retries acknowledge the original event without broadcasting it twice', async t => {
  let time = 1000;
  const f = await fixture(t, { notificationNow: () => time }), cookie = await f.pair();
  const abort = new AbortController(); t.after(() => abort.abort());
  const events = await f.request('/api/events', { headers: { Cookie: cookie }, signal: abort.signal });
  const reader = events.body.getReader(); await reader.read();
  const bearer = { Authorization: `Bearer ${WEBHOOK}` };
  const first = await (await f.post('/api/notify', { title: 'Domov', message: 'Hotovo', durationSeconds: 3 }, bearer)).json();
  const duplicate = await (await f.post('/api/notify', { durationSeconds: 100, message: 'Hotovo', title: 'Domov' }, bearer)).json();
  assert.equal(duplicate.accepted, true); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.id, first.id); assert.equal(duplicate.screens, 0);
  assert.equal((await f.post('/api/notify', { message: 'Hotovo', eventId: {} }, bearer)).status, 400);
  assert.equal((await f.post('/api/notify', { message: 'Hotovo', eventId: 'x'.repeat(129) }, bearer)).status, 400);
  const episode = await (await f.post('/api/notify', { message: 'Hotovo', eventId: 'washer:cycle-2' }, bearer)).json();
  assert.notEqual(episode.id, first.id); assert.equal(episode.duplicate, undefined);
  time += 10000;
  const later = await (await f.post('/api/notify', { message: 'Hotovo' }, bearer)).json();
  assert.notEqual(later.id, first.id);
  await f.post('/api/media', { url: '/media/end-marker.mp4' }, bearer);
  let output = '';
  while (!output.includes('end-marker.mp4')) {
    const chunk = await reader.read(); assert.equal(chunk.done, false);
    output += new TextDecoder().decode(chunk.value);
  }
  assert.equal((output.match(/event: notification\n/g) || []).length, 3);
  abort.abort();
});

test('SSE delivers notification and play; scene allowlist never accepts lock or arbitrary service', async t => {
  const f = await fixture(t);
  const cookie = await f.pair();
  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = await f.request('/api/events', { headers: { Cookie: cookie }, signal: abort.signal });
  const reader = events.body.getReader();
  await reader.read();
  const readUntil = async pattern => {
    let text = '';
    for (let count = 0; count < 20; count++) {
      const chunk = await reader.read();
      if (chunk.done) assert.fail('SSE ended before expected event');
      text += new TextDecoder().decode(chunk.value);
      if (pattern.test(text)) return text;
    }
    assert.fail('Expected SSE event did not arrive');
  };
  const bearer = { Authorization: `Bearer ${WEBHOOK}` };
  await f.post('/api/notify', { message: 'Pračka dokončena' }, bearer);
  const notification = await readUntil(/event: notification\n/);
  assert.match(notification, /event: notification/);
  assert.match(notification, /Pračka dokončena/);
  await f.post('/api/media', { url: '/media/film.mp4' }, bearer);
  const playback = await readUntil(/event: play\n/);
  assert.match(playback, /event: play/);
  assert.match(playback, /"type":"video\/mp4"/);
  await f.post('/api/media', { url: '/media/song.mp3', type: 'audio' }, bearer);
  assert.match(await readUntil(/"type":"audio\/mpeg"/), /"type":"audio\/mpeg"/);
  await f.post('/api/media', { url: '/media/photo.png', type: 'image/png' }, bearer);
  assert.match(await readUntil(/"type":"image\/png"/), /"type":"image\/png"/);
  const headers = { Cookie: cookie };
  assert.equal((await f.post('/api/action', { entityId: 'lock.front', service: 'unlock' }, headers)).status, 403);
  assert.equal((await f.post('/api/action', { entityId: 'scene.evening' }, headers)).status, 200);
  assert.deepEqual(f.requests.filter(request => request.method === 'POST').map(request => request.path), ['/api/services/scene/turn_on']);
  abort.abort();
});

test('failed HA service cannot be reported as successful or leak HA response', async t => {
  const f = await fixture(t, { failScene: true });
  const cookie = await f.pair();
  const response = await f.post('/api/action', { entityId: 'scene.evening' }, { Cookie: cookie });
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.ok(!body.includes(HA_SECRET));
  assert.ok(!body.includes('"ok":true'));
});

test('camera proxy uses configured entity only; HLS playlist hides upstream addresses and tokens', async t => {
  const f = await fixture(t, { customHa: base => ({
    base: new URL(base),
    cameraStream: async () => new URL('/hls/index.m3u8?token=stream-secret', base),
    snapshot: async () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'Content-Type': 'image/jpeg' } }),
  }) });
  const cookie = await f.pair();
  const headers = { Cookie: cookie };
  assert.equal((await f.request('/api/cameras/front/snapshot')).status, 401);
  assert.equal((await f.request('/api/cameras/unconfigured/snapshot', { headers })).status, 404);
  assert.equal((await f.request('/api/cameras/front/snapshot', { headers })).headers.get('content-type'), 'image/jpeg');
  const stream = await (await f.request('/api/cameras/front/stream', { headers })).json();
  assert.match(stream.url, /^\/api\/streams\//);
  const playlist = await (await f.request(stream.url, { headers })).text();
  assert.ok(!playlist.includes('stream-secret'));
  assert.ok(!playlist.includes(f.upstreamUrl));
  assert.ok(!playlist.includes(HA_SECRET));
  const segment = playlist.split('\n').find(line => line.startsWith('/api/streams/'));
  assert.equal((await f.request(segment, { headers })).status, 200);
  const key = /URI="([^"]+)"/.exec(playlist)[1];
  assert.equal((await f.request(key, { headers })).status, 200);
  assert.ok(f.requests.every(request => request.auth === `Bearer ${HA_SECRET}`));
});

test('camera quality chooses only configured camera profiles and rejects unknown qualities', async t => {
  const called = [];
  const f = await fixture(t, { cameraAlternate: 'camera.front_low', customHa: base => ({
    base: new URL(base),
    cameraStream: async entityId => { called.push(entityId); return new URL('/hls/index.m3u8?token=stream-secret', base); },
  }) });
  const headers = { Cookie: await f.pair() };
  assert.equal((await (await f.request('/api/cameras/front/stream', { headers })).json()).quality, 'smooth');
  assert.equal((await (await f.request('/api/cameras/front/stream?quality=smooth', { headers })).json()).quality, 'smooth');
  assert.equal((await (await f.request('/api/cameras/front/stream?quality=hd', { headers })).json()).quality, 'hd');
  assert.deepEqual(called, ['camera.front_low', 'camera.front_low', 'camera.front']);
  for (const query of ['quality=unknown', 'quality=', 'quality=hd&quality=smooth', 'quality=camera.unconfigured']) {
    assert.equal((await f.request(`/api/cameras/front/stream?${query}`, { headers })).status, 400);
  }
  assert.equal(called.length, 3);
  const invalid = await fixture(t, { cameraAlternate: 'sensor.wind', customHa: base => ({
    base: new URL(base), cameraStream: async entityId => { assert.equal(entityId, 'camera.front'); return new URL('/hls/index.m3u8', base); },
  }) });
  assert.equal(invalid.bridge.config.entities.cameras[0].streamEntityId, undefined);
  const invalidHeaders = { Cookie: await invalid.pair() };
  assert.equal((await (await invalid.request('/api/cameras/front/stream', { headers: invalidHeaders })).json()).quality, 'hd');
});

test('photos require authentication, expose only opaque safe image IDs, and reject traversal and symlinks', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/photos')).status, 401);
  const cookie = await f.pair();
  const headers = { Cookie: cookie };
  const photos = await (await f.request('/api/photos', { headers })).json();
  assert.equal(photos.length, 1);
  assert.ok(!JSON.stringify(photos).includes('rodina'));
  assert.equal((await f.request(photos[0].url)).status, 401);
  assert.equal((await f.request(photos[0].url, { headers })).status, 200);
  for (const route of ['/%2e%2e%2f.env', '/escape.txt', '/.env', '/apps/test/%2e%2e%2f%2e%2e%2f.env', '/api/photos/%2e%2e%2f.env/file']) assert.equal((await f.request(route, { headers })).status, 404, route);
  assert.equal((await f.request('/apps/test/')).status, 200);
  assert.equal((await f.request('/apps/relax/')).status, 200);
  assert.equal((await f.request('/apps/rodinne-kvizy/')).status, 200);
  assert.equal((await f.request('/apps/not-a-builtin/')).status, 404);
});

test('demo is explicit and does not reveal supplied photographs or call HA', async t => {
  const f = await fixture(t, { live: false });
  const dashboard = await (await f.request('/api/dashboard')).json();
  assert.equal(dashboard.mode, 'demo');
  assert.equal(dashboard.home.locks[0].state, 'unknown');
  assert.deepEqual(await (await f.request('/api/photos')).json(), []);
  assert.equal(f.requests.length, 0);
});

test('pairing is rate limited and logout invalidates the session', async t => {
  const f = await fixture(t);
  const cookie = await f.pair();
  assert.equal((await f.post('/api/logout', {}, { Cookie: cookie })).status, 200);
  assert.equal((await f.request('/api/dashboard', { headers: { Cookie: cookie } })).status, 401);
  for (let index = 0; index < 5; index++) assert.equal((await f.post('/api/pair', { code: 'wrong-code' })).status, 401);
  assert.equal((await f.post('/api/pair', { code: CODE })).status, 429);
});

test('public app registry rejects sensitive queries for local and absolute URLs and constrains local paths', async t => {
  const urls = [
    '/apps/private/?token=secret', '/apps/private/?%61ccess_token=secret', '/app/?password=secret',
    'https://app.example.test/?api_key=secret', 'https://user:password@app.example.test/',
    '//external.example.test/apps/test/', '/apps\\evil/', '/apps/test/../../private/',
    '/private/family.html', 'apps/test/', '/apps/line\nbreak/',
  ];
  const f = await fixture(t, { extraApps: [
    ...urls.map((url, index) => ({ id: `bad-${index}`, name: 'Rejected', url })),
    { id: 'good-local', name: 'Local', url: '/apps/test/?view=grid' },
    { id: 'good-https', name: 'External', url: 'https://app.example.test/?theme=dark' },
  ] });
  const bootstrap = await (await f.request('/api/bootstrap')).json();
  assert.deepEqual(bootstrap.apps.map(app => app.id), ['test', 'good-local', 'good-https']);
  assert.ok(!JSON.stringify(bootstrap).includes('secret'));
});
