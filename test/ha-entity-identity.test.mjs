import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readHaEntityIdentity } from '../lib/ha-entity-identity.mjs';

const ENTITY = 'lock.entrance', UNIQUE = 'PRIVATE-UNIQUE-DOOR', DEVICE = 'PRIVATE-DEVICE-ID', AREA = 'PRIVATE-AREA-ID', TOKEN = 'PRIVATE-TEST-TOKEN';
function fixture(options = {}) {
  let socket;
  class FakeSocket {
    constructor(url) { this.url = String(url); this.listeners = new Map(); this.sent = []; this.closed = 0; socket = this; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
    send(text) { this.sent.push(JSON.parse(text)); if (options.sendFailureAt === this.sent.length) throw Error(TOKEN); }
    close() { this.closed++; this.emit('close'); }
    emit(type, data) { this.listeners.get(type)?.(type === 'message' ? { data: typeof data === 'string' ? data : JSON.stringify(data) } : {}); }
    message(data) { this.emit('message', data); }
  }
  const pending = readHaEntityIdentity({ url: 'http://ha.test:8123', token: TOKEN, entityId: ENTITY, websocketClass: FakeSocket, timeoutMs: 500, ...options });
  const auth = () => { socket.message({ type: 'auth_required' }); socket.message({ type: 'auth_ok' }); };
  const lists = {
    1: [{ entity_id: 'lock.unrelated', unique_id: 'not-selected', platform: 'mqtt' }, { entity_id: ENTITY, unique_id: UNIQUE, platform: 'nuki', disabled_by: null, device_id: DEVICE, area_id: null }],
    2: [{ id: DEVICE, area_id: AREA, manufacturer: 'Nuki', model: 'Smart Lock 4', disabled_by: null }],
    3: [{ area_id: AREA, name: 'Vchod' }],
  };
  const reply = (id, list = lists[id]) => socket.message({ id, type: 'result', success: true, result: list });
  const complete = () => { reply(3); reply(1); reply(2); };
  return { socket, pending, auth, reply, complete, lists };
}

test('identity reads exactly three registries and returns a hash with only selected metadata', async () => {
  const f = fixture(); f.auth();
  assert.deepEqual(f.socket.sent, [{ type: 'auth', access_token: TOKEN }, { id: 1, type: 'config/entity_registry/list' }, { id: 2, type: 'config/device_registry/list' }, { id: 3, type: 'config/area_registry/list' }]);
  assert.equal(f.socket.url, 'ws://ha.test:8123/api/websocket'); f.complete();
  const result = await f.pending;
  assert.deepEqual(result, { entityId: ENTITY, identityHash: createHash('sha256').update(UNIQUE).digest('hex'), platform: 'nuki', disabled: false, area: 'Vchod', manufacturer: 'Nuki', model: 'Smart Lock 4' });
  for (const secret of [TOKEN, UNIQUE, DEVICE, AREA, 'not-selected']) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(f.socket.closed, 1); assert.equal(f.socket.listeners.size, 0);
  f.socket.message({ type: 'auth_required' }); f.socket.emit('error'); assert.equal(f.socket.closed, 1);
});

test('entity area overrides device area; disabled entity or device stays explicitly disabled', async () => {
  for (const deviceDisabled of [false, true]) {
    const f = fixture(); f.lists[1][1].area_id = 'entity-area'; f.lists[1][1].disabled_by = deviceDisabled ? null : 'user';
    f.lists[2][0].disabled_by = deviceDisabled ? 'user' : null; f.lists[3].push({ area_id: 'entity-area', name: 'Předsíň' });
    f.auth(); f.complete(); const result = await f.pending; assert.equal(result.area, 'Předsíň'); assert.equal(result.disabled, true);
  }
});

test('an entity without a linked device returns unknown metadata, not invented provenance', async () => {
  const f = fixture(); f.lists[1][1].device_id = null; f.auth(); f.complete();
  assert.deepEqual(await f.pending, { entityId: ENTITY, identityHash: createHash('sha256').update(UNIQUE).digest('hex'), platform: 'nuki', disabled: false, area: null, manufacturer: null, model: null });
});

test('missing entity, missing unique identity and missing linked device fail safely', async () => {
  for (const mutate of [f => { f.lists[1] = []; }, f => { delete f.lists[1][1].unique_id; }, f => { f.lists[2] = []; }, f => { f.lists[1].push({ ...f.lists[1][1] }); }]) {
    const f = fixture(); mutate(f); f.auth(); f.complete();
    await assert.rejects(f.pending, error => /^HA_IDENTITY_/.test(error.code) && ![TOKEN, UNIQUE, DEVICE].some(secret => error.message.includes(secret)));
    assert.equal(f.socket.closed, 1);
  }
});

test('auth rejection, duplicate acknowledgments and rejected commands cannot produce an identity', async () => {
  for (const act of [f => f.socket.message({ type: 'auth_invalid', message: TOKEN }),
    f => { f.auth(); f.reply(1); f.reply(1); },
    f => { f.auth(); f.socket.message({ id: 1, type: 'result', success: false, error: { message: TOKEN } }); },
    f => { f.auth(); f.socket.message({ id: 1, type: 'result', success: true, result: {} }); },
    f => { f.socket.message({ type: 'auth_required' }); f.socket.message({ type: 'auth_required' }); }]) {
    const f = fixture(); act(f); await assert.rejects(f.pending, error => /^HA_IDENTITY_/.test(error.code) && !error.message.includes(TOKEN));
    assert.equal(f.socket.closed, 1); assert.equal(f.socket.listeners.size, 0);
  }
});

test('registry results before authentication and unknown IDs are rejected', async () => {
  const early = fixture(); early.reply(1); await assert.rejects(early.pending, error => error.code === 'HA_IDENTITY_INVALID_RESPONSE');
  const unknown = fixture(); unknown.auth(); unknown.reply(99, []); await assert.rejects(unknown.pending, error => error.code === 'HA_IDENTITY_INVALID_RESPONSE');
});

test('five-MiB frame bound covers bytes as well as JavaScript character count', async () => {
  for (const frame of ['x'.repeat(5 * 1024 * 1024 + 1), 'ž'.repeat(3 * 1024 * 1024)]) {
    const f = fixture(); f.auth(); f.socket.message(frame); await assert.rejects(f.pending, error => error.code === 'HA_IDENTITY_TOO_LARGE'); assert.equal(f.socket.closed, 1);
  }
});

test('incomplete/failed/timed-out transports close once and never return a partial identity', async () => {
  for (const kind of ['close', 'error', 'timeout', 'send']) {
    const f = fixture({ timeoutMs: kind === 'timeout' ? 5 : 500, sendFailureAt: kind === 'send' ? 2 : undefined }); f.auth();
    if (kind === 'close' || kind === 'error') f.socket.emit(kind);
    await assert.rejects(f.pending, error => /^HA_IDENTITY_/.test(error.code)); assert.equal(f.socket.closed, 1); assert.equal(f.socket.listeners.size, 0);
  }
});

test('invalid config fails before a socket is created, and supervisor base paths are preserved', async () => {
  for (const options of [{ url: 'file:///private/' }, { url: 'https://user:password@ha.test/' }, { url: 'http://ha.test/?token=secret' }, { entityId: 'lock.entrance/../../' }, { token: '' }, { websocketClass: null }]) {
    const f = fixture(options); assert.equal(f.socket, undefined); await assert.rejects(f.pending, error => error.code === 'HA_IDENTITY_CONFIG' && !error.message.includes('secret'));
  }
  const f = fixture({ url: 'http://supervisor/core/' }); assert.equal(f.socket.url, 'ws://supervisor/core/api/websocket'); f.auth(); f.complete(); await f.pending;
});
