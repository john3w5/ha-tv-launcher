import test from 'node:test';
import assert from 'node:assert/strict';
import { createHaWebRtcSession, getHaWebRtcConfig, validateIceCandidate } from '../lib/webrtc.mjs';

const offer = 'v=0\r\ns=TV receive only\r\n';
const answer = 'v=0\r\ns=HA answer\r\n';
function fixture(options = {}) {
  const sockets = [], candidates = [], closed = [];
  class FakeWebSocket {
    constructor(url) { this.url = String(url); this.sent = []; this.listeners = new Map(); this.closed = false; sockets.push(this); }
    addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); }
    send(value) { if (this.closed) throw Error('closed'); this.sent.push(JSON.parse(value)); }
    emit(type, value = {}) { for (const callback of this.listeners.get(type) || []) callback(value); }
    receive(value) { this.emit('message', { data: JSON.stringify(value) }); }
    close() { if (this.closed) return; this.closed = true; this.emit('close'); }
  }
  const args = { url: 'https://ha.test/', token: 'secret-ha-test-token', entityId: 'camera.front_low', offer,
    websocketClass: FakeWebSocket, onCandidate: value => candidates.push(value), onClose: value => closed.push(value), timeoutMs: 100, ...options };
  const authenticate = socket => {
    socket.receive({ type: 'auth_required' });
    assert.deepEqual(socket.sent[0], { type: 'auth', access_token: 'secret-ha-test-token' });
    socket.receive({ type: 'auth_ok' });
  };
  const event = (socket, value) => socket.receive({ type: 'event', id: 1, event: value });
  const ready = socket => {
    authenticate(socket);
    socket.receive({ type: 'result', id: 1, success: true, result: null });
    event(socket, { type: 'session', session_id: '01HA_SESSION' });
    event(socket, { type: 'answer', answer });
  };
  return { args, sockets, candidates, closed, authenticate, event, ready };
}

test('HA WebRTC session authenticates, retains early ICE once, trickles later ICE and closes subscription', async () => {
  const f = fixture(), result = createHaWebRtcSession(f.args), socket = f.sockets[0];
  assert.equal(socket.url, 'wss://ha.test/api/websocket');
  f.authenticate(socket);
  assert.deepEqual(socket.sent[1], { type: 'camera/webrtc/offer', id: 1, entity_id: 'camera.front_low', offer });
  socket.receive({ type: 'result', id: 1, success: true, result: null });
  f.event(socket, { type: 'session', session_id: '01HA_SESSION' });
  f.event(socket, { type: 'candidate', candidate: { candidate: 'candidate:early', sdpMid: '0' } });
  assert.deepEqual(f.candidates, []);
  f.event(socket, { type: 'answer', answer });
  const session = await result;
  assert.equal(session.answer, answer);
  assert.deepEqual(session.candidates, [{ candidate: 'candidate:early', sdpMid: '0' }]);
  f.event(socket, { type: 'candidate', candidate: { candidate: 'candidate:late' } });
  assert.deepEqual(f.candidates, [{ candidate: 'candidate:late' }]);
  const sent = session.sendCandidate({ candidate: 'candidate:client', sdpMid: '0', sdpMLineIndex: 0 });
  assert.deepEqual(socket.sent.at(-1), { id: 2, type: 'camera/webrtc/candidate', entity_id: 'camera.front_low', session_id: '01HA_SESSION', candidate: { candidate: 'candidate:client', sdpMid: '0', sdpMLineIndex: 0 } });
  socket.receive({ id: 2, type: 'result', success: true, result: null });
  await sent;
  session.close(); session.close();
  assert.equal(socket.sent.at(-1).type, 'unsubscribe_events');
  assert.equal(socket.sent.at(-1).subscription, 1);
  assert.equal(socket.closed, true);
  assert.deepEqual(f.closed, [{ reason: 'closed' }]);
  assert.ok(!JSON.stringify(session).includes('secret-ha-test-token'));
});

test('authentication and provider errors reject with safe errors and release the transport', async () => {
  for (const type of ['auth_invalid', 'provider_error', 'offer_rejected']) {
    const f = fixture(), result = createHaWebRtcSession(f.args), socket = f.sockets[0];
    result.catch(() => {});
    if (type === 'auth_invalid') socket.receive({ type, message: 'secret private server detail' });
    else {
      f.authenticate(socket);
      if (type === 'offer_rejected') socket.receive({ id: 1, type: 'result', success: false, error: { message: 'secret private server detail' } });
      else {
        socket.receive({ id: 1, type: 'result', success: true });
        f.event(socket, { type: 'error', code: 'go2rtc_webrtc_offer_failed', message: 'secret private server detail' });
      }
    }
    await assert.rejects(result, error => Boolean(error.code?.startsWith('WEBRTC_')) && !String(error).includes('secret'));
    assert.equal(socket.closed, true);
    assert.equal(f.closed.length, 1);
  }
});

test('handshake timeout and candidate acknowledgement failure cannot report success', async () => {
  const timed = fixture({ timeoutMs: 5 }), pending = createHaWebRtcSession(timed.args);
  await assert.rejects(pending, { code: 'WEBRTC_TIMEOUT' });
  assert.equal(timed.sockets[0].closed, true);
  const f = fixture(), result = createHaWebRtcSession(f.args); f.ready(f.sockets[0]);
  const session = await result, sent = session.sendCandidate({ candidate: 'candidate:client' });
  f.sockets[0].receive({ id: 2, type: 'result', success: false, error: { message: 'private' } });
  await assert.rejects(sent, { code: 'WEBRTC_CANDIDATE_FAILED' });
  assert.equal(f.sockets[0].closed, true);
  await assert.rejects(session.sendCandidate({ candidate: 'candidate:closed' }), { code: 'WEBRTC_CLOSED' });
});

test('transport loss rejects outstanding ICE and consumer callback exceptions do not escape', async () => {
  const f = fixture({ onCandidate: () => { throw Error('consumer'); }, onClose: () => { throw Error('consumer'); } });
  const result = createHaWebRtcSession(f.args); f.ready(f.sockets[0]); const session = await result;
  f.event(f.sockets[0], { type: 'candidate', candidate: { candidate: 'candidate:later' } });
  const pending = session.sendCandidate({ candidate: 'candidate:client' });
  f.sockets[0].emit('close');
  await assert.rejects(pending, { code: 'WEBRTC_TRANSPORT_CLOSED' });
  assert.equal(f.sockets[0].closed, true);
});

test('untrusted SDP, candidate fields, oversized messages and candidate floods are bounded', async () => {
  const f = fixture();
  for (const bad of ['', 'not SDP', 'v=0\n' + 'x'.repeat(65536)]) await assert.rejects(createHaWebRtcSession({ ...f.args, offer: bad }), { code: 'WEBRTC_INVALID_OFFER' });
  for (const bad of [null, [], { candidate: 4 }, { candidate: 'x', sdpMLineIndex: -1 }, { candidate: 'x', service: 'lock.unlock' }, JSON.parse('{"candidate":"x","__proto__":{}}'), { candidate: 'x'.repeat(4097) }]) assert.throws(() => validateIceCandidate(bad), { code: 'WEBRTC_INVALID_CANDIDATE' });
  const result = createHaWebRtcSession(f.args); result.catch(() => {}); f.authenticate(f.sockets[0]);
  f.sockets[0].receive({ id: 1, type: 'result', success: true });
  for (let index = 0; index < 257; index++) f.event(f.sockets[0], { type: 'candidate', candidate: { candidate: `candidate:${index}` } });
  await assert.rejects(result, { code: 'WEBRTC_CANDIDATE_LIMIT' });
  assert.equal(f.sockets[0].closed, true);
});

test('answer requires the HA session event and a valid SDP', async () => {
  const f = fixture(), result = createHaWebRtcSession(f.args); result.catch(() => {});
  f.authenticate(f.sockets[0]);f.sockets[0].receive({ id: 1, type: 'result', success: true });
  f.event(f.sockets[0], { type: 'answer', answer });
  await assert.rejects(result, { code: 'WEBRTC_INVALID_RESPONSE' });
});

test('client configuration projects only bounded ICE fields and rejects failed HA requests', async () => {
  const f = fixture(), result = getHaWebRtcConfig(f.args), socket = f.sockets[0];
  f.authenticate(socket);
  assert.deepEqual(socket.sent[1], { id: 1, type: 'camera/webrtc/get_client_config', entity_id: 'camera.front_low' });
  socket.receive({ id: 1, type: 'result', success: true, result: { configuration: { iceServers: [{ urls: ['stun:stun.test:3478'], extra: 'omit' }], haToken: 'omit' }, dataChannel: 'omit' } });
  assert.deepEqual(await result, { configuration: { iceServers: [{ urls: ['stun:stun.test:3478'] }] } });
  assert.equal(socket.closed, true);
  const bad = fixture(), rejected = getHaWebRtcConfig(bad.args); rejected.catch(() => {}); bad.authenticate(bad.sockets[0]);
  bad.sockets[0].receive({ id: 1, type: 'result', success: true, result: { configuration: { iceServers: [{ urls: 'https://not-an-ice-server.test' }] } } });
  await assert.rejects(rejected, { code: 'WEBRTC_INVALID_RESPONSE' });
  assert.equal(bad.sockets[0].closed, true);
});
