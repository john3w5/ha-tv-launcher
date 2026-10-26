import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/camera-player.js', import.meta.url), 'utf8');
const sessionId = 'session_1234567890';
const offer = { type: 'offer', sdp: 'v=0\r\ns=offline-test-offer\r\n' };
const answer = 'v=0\r\ns=offline-test-answer\r\n';
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function clock() {
  let current = 0, nextId = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(callback, milliseconds) { const id = ++nextId; timers.set(id, { at: current + milliseconds, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => [...timers.values()].map(timer => timer.at).sort((a, b) => a - b),
    async advance(milliseconds) {
      const until = current + milliseconds;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, timer] = due; current = timer.at; timers.delete(id); timer.callback(); await settle();
      }
      current = until; await settle();
    },
  };
}

function fixture(options = {}) {
  const time = clock(), peers = [], eventSources = [], requests = [], errors = [], statuses = [];
  const videoListeners = new Map(), frameCallbacks = new Map(); let nextFrameId = 0;
  const video = { srcObject: null, plays: 0, pauses: 0, paused: true, videoWidth: 0, videoHeight: 0, readyState: 0, currentTime: 0, frames: 0,
    play() { this.plays++; this.paused = false; return Promise.resolve(); }, pause() { this.pauses++; this.paused = true; },
    getVideoPlaybackQuality: options.noFrameCounter ? undefined : function() { return { totalVideoFrames: this.frames }; },
    addEventListener(type, callback) { const list = videoListeners.get(type) || []; list.push(callback); videoListeners.set(type, list); },
    removeEventListener(type, callback) { videoListeners.set(type, (videoListeners.get(type) || []).filter(item => item !== callback)); },
    emit(type) { for (const callback of videoListeners.get(type) || []) callback(); },
    presentFrame() { this.frames++; this.currentTime += .1; this.readyState = 4; this.videoWidth = 640; this.videoHeight = 360;
      const current = [...frameCallbacks.values()]; frameCallbacks.clear(); for (const callback of current) callback(time.now(), { presentedFrames: this.frames }); },
  };
  if (options.frameCallbacks) {
    video.requestVideoFrameCallback = callback => { const id = ++nextFrameId; frameCallbacks.set(id, callback); return id; };
    video.cancelVideoFrameCallback = id => frameCallbacks.delete(id);
  }
  const documentListeners = new Map(), document = { hidden: false,
    addEventListener(type, callback) { const list = documentListeners.get(type) || []; list.push(callback); documentListeners.set(type, list); },
    removeEventListener(type, callback) { documentListeners.set(type, (documentListeners.get(type) || []).filter(item => item !== callback)); },
    visibility(hidden) { this.hidden = hidden; for (const callback of documentListeners.get('visibilitychange') || []) callback(); },
  };
  class FakePeer {
    constructor(configuration) {
      this.configuration = plain(configuration); this.transceivers = []; this.listeners = new Map(); this.connectionState = 'new';
      this.iceGatheringState = options.iceGatheringState || 'complete'; this.closed = false; this.closeCount = 0;
      this.localCalls = []; this.remoteCalls = []; this.candidates = []; peers.push(this);
    }
    addTransceiver(kind, configuration) { this.transceivers.push([kind, plain(configuration)]); return { receiver: options.receiver }; }
    createOffer() { return options.createOffer ? options.createOffer() : Promise.resolve(offer); }
    async setLocalDescription(description) { this.localCalls.push(plain(description)); if (this.closed) throw Error('Peer was already closed'); this.localDescription = plain(description); }
    async setRemoteDescription(description) { if (this.closed) throw Error('Peer was already closed'); this.remoteCalls.push(plain(description)); if (options.setRemoteDescription) await options.setRemoteDescription(); }
    async addIceCandidate(candidate) { this.candidates.push(plain(candidate)); }
    addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback)); }
    emit(type, event = {}) { for (const callback of [...(this.listeners.get(type) || [])]) callback(event); }
    connection(value) { this.connectionState = value; this.onconnectionstatechange?.(); }
    close() { if (this.closed) return; this.closed = true; this.connectionState = 'closed'; this.closeCount++; }
  }
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; this.closeCount = 0; eventSources.push(this); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    emit(type, data) { this.listeners.get(type)?.({ data }); }
    close() { this.closed = true; this.closeCount++; }
  }
  class FakeMediaStream { constructor(tracks) { this.tracks = tracks; } }
  const fetch = async (url, init = {}) => {
    const request = { url, init }; requests.push(request);
    if (options.fetch) return options.fetch(request);
    return { ok: true, json: async () => ({ sessionId, answer, candidates: options.serverCandidates || [] }) };
  };
  const sandbox = { RTCPeerConnection: FakePeer, EventSource: FakeEventSource, MediaStream: FakeMediaStream, AbortController, fetch,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, performance: { now: time.now }, document };
  vm.runInNewContext(source, sandbox, { filename: 'camera-player.js' });
  const player = new sandbox.HomeTVCamera.CameraPlayer({ video, cameraId: 'entrance', onError: error => errors.push(error), onStatus: value => statuses.push(value) });
  const start = () => { const pending = player.start(); pending.catch(() => {}); return pending; };
  return { time, peers, eventSources, requests, errors, statuses, video, player, start, document, frameCallbacks, videoListeners, documentListeners };
}

test('never-resolving createOffer still reaches the initial deadline once without any network', async t => {
  const f = fixture({ createOffer: () => new Promise(() => {}) }); t.after(() => f.player.destroy());
  f.start();
  assert.deepEqual(f.peers[0].transceivers, [['video', { direction: 'recvonly' }]]);
  await f.time.advance(14999); assert.equal(f.errors.length, 0);
  await f.time.advance(1); assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /příliš dlouho/);
  assert.equal(f.requests.length, 0); assert.equal(f.player.failed, true);
  await f.time.advance(60000); assert.equal(f.errors.length, 1);
});

test('destroy before a pending offer aborts and cleans without a later timeout or extra error', async () => {
  const f = fixture({ createOffer: () => new Promise(() => {}) }); f.start();
  f.player.destroy(); f.player.destroy();
  assert.equal(f.player.controller.signal.aborted, true); assert.equal(f.peers[0].closeCount, 1);
  assert.equal(f.video.pauses, 1); assert.equal(f.video.srcObject, null); assert.deepEqual(f.time.pending(), []);
  await f.time.advance(60000); assert.equal(f.errors.length, 0); assert.equal(f.requests.length, 0);
});

test('successful answer replaces the initial deadline and connected clears the ICE deadline', async t => {
  const delayed = deferred(), f = fixture({ createOffer: () => delayed.promise }); t.after(() => f.player.destroy());
  const pending = f.start(); await f.time.advance(10000); delayed.resolve(offer); await pending;
  assert.deepEqual(f.time.pending(), [22000]); // 12 s starts after answer, not at start().
  await f.time.advance(5000); assert.equal(f.errors.length, 0); // Original 15 s deadline was cancelled.
  f.peers[0].connection('connected');
  assert.deepEqual(f.time.pending(), [16000]); assert.deepEqual(f.statuses, ['connecting', 'connected']);
  for (let index = 0; index < 60; index++) { f.video.presentFrame(); await f.time.advance(1000); }
  assert.equal(f.errors.length, 0); assert.deepEqual(f.statuses, ['connecting', 'connected', 'playing']);
  assert.deepEqual(f.peers[0].remoteCalls, [{ type: 'answer', sdp: answer }]);
});

test('an answered session which never connects reports the ICE deadline and disconnect can recover', async t => {
  const stalled = fixture(); t.after(() => stalled.player.destroy()); await stalled.start();
  await stalled.time.advance(11999); assert.equal(stalled.errors.length, 0);
  await stalled.time.advance(1); assert.equal(stalled.errors.length, 1); assert.match(stalled.errors[0].message, /neodpověděla/);
  const recovered = fixture(); t.after(() => recovered.player.destroy()); await recovered.start();
  recovered.peers[0].connection('connected'); recovered.peers[0].connection('disconnected');
  await recovered.time.advance(4999); assert.equal(recovered.errors.length, 0);
  recovered.peers[0].connection('connected'); await recovered.time.advance(10000); assert.equal(recovered.errors.length, 0);
});

test('destroy aborts an in-flight offer fetch and does not open SSE or report a failure', async () => {
  const f = fixture({ fetch: ({ init }) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const error = Error('Aborted by caller'); error.name = 'AbortError'; reject(error); }, { once: true });
  }) });
  const pending = f.start(); await settle();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].init.signal.aborted, false);
  f.player.destroy(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.requests[0].init.signal.aborted, true); assert.equal(f.eventSources.length, 0);
  assert.equal(f.peers[0].closed, true); await f.time.advance(60000); assert.equal(f.errors.length, 0);
});

test('destroy after answer closes SSE, clears video, deletes the exact session once and ignores late callbacks', async () => {
  const f = fixture({ serverCandidates: [{ candidate: 'candidate:server' }] }); await f.start();
  const pc = f.peers[0], events = f.eventSources[0], stream = { dummyStream: true };
  pc.ontrack({ streams: [stream], track: {} }); assert.equal(f.video.srcObject, stream); assert.equal(f.video.plays, 1);
  events.emit('candidate', JSON.stringify({ candidate: { candidate: 'candidate:later' } })); await settle();
  assert.deepEqual(pc.candidates, [{ candidate: 'candidate:server' }, { candidate: 'candidate:later' }]);
  f.player.destroy(); f.player.destroy();
  assert.equal(events.closed, true); assert.equal(events.closeCount, 1); assert.equal(f.video.srcObject, null); assert.equal(f.video.pauses, 1);
  const deletions = f.requests.filter(request => request.init.method === 'DELETE');
  assert.equal(deletions.length, 1); assert.equal(deletions[0].url, `/api/webrtc/${sessionId}`); assert.equal(deletions[0].init.keepalive, true);
  const calls = f.requests.length;
  pc.ontrack({ streams: [{ late: true }] }); pc.onicecandidate({ candidate: { candidate: 'candidate:late-client' } });
  events.emit('closed', ''); events.emit('candidate', JSON.stringify({ candidate: { candidate: 'candidate:closed' } }));
  await f.time.advance(60000); assert.equal(f.video.srcObject, null); assert.equal(f.requests.length, calls); assert.equal(f.errors.length, 0);
});

test('a late offer resolution after destroy cannot use the closed peer or reject start', async () => {
  const delayed = deferred(), f = fixture({ createOffer: () => delayed.promise }), pending = f.start();
  f.player.destroy(); delayed.resolve(offer); await settle();
  assert.equal(f.peers[0].localCalls.length, 0, 'setLocalDescription must not run on a destroyed player');
  await assert.doesNotReject(pending); assert.equal(f.requests.length, 0); assert.equal(f.errors.length, 0);
});

test('destroy during ICE gathering releases the gathering timer and listener immediately', async () => {
  const f = fixture({ iceGatheringState: 'gathering' }), pending = f.start(); await settle();
  assert.equal(f.peers[0].listeners.get('icegatheringstatechange')?.length, 1);
  f.player.destroy(); await settle();
  assert.deepEqual(f.time.pending(), [], 'destroy must also cancel the short gathering timeout');
  assert.equal(f.peers[0].listeners.get('icegatheringstatechange')?.length, 0);
  await assert.doesNotReject(pending); assert.equal(f.requests.length, 0); assert.equal(f.errors.length, 0);
});

test('connected without any decoded frame fails after a separate deadline and releases its session once', async () => {
  const f = fixture({ frameCallbacks: true }); await f.start(); f.peers[0].connection('connected');
  await f.time.advance(14999); assert.equal(f.errors.length, 0);
  await f.time.advance(1);
  assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /neposílá obraz/);
  assert.equal(f.peers[0].closed, true); assert.equal(f.eventSources[0].closed, true); assert.equal(f.player.controller.signal.aborted, true);
  assert.deepEqual(f.time.pending(), []); assert.equal(f.frameCallbacks.size, 0);
  assert.equal(f.requests.filter(request => request.init.method === 'DELETE').length, 1);
  await f.time.advance(60000); assert.equal(f.errors.length, 1);
});

test('actual compositor callbacks mark the first image and a persistent connected freeze triggers cleanup', async () => {
  const f = fixture({ frameCallbacks: true }); await f.start(); const pc = f.peers[0];
  pc.ontrack({ streams: [{ stream: true }] }); pc.connection('connected');
  f.video.presentFrame(); assert.equal(f.player.hasFrame, true); assert.deepEqual(f.statuses, ['connecting', 'connected', 'playing']);
  await f.time.advance(9999); assert.equal(f.errors.length, 0);
  await f.time.advance(1); assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /zastavil/); assert.equal(pc.closed, true);
});

test('a slow but advancing camera is retained rather than repeatedly reconnected', async t => {
  const f = fixture({ frameCallbacks: true }); t.after(() => f.player.destroy()); await f.start();
  f.peers[0].ontrack({ streams: [{ stream: true }] }); f.peers[0].connection('connected');
  for (let index = 0; index < 6; index++) { f.video.presentFrame(); await f.time.advance(9000); }
  assert.equal(f.errors.length, 0); assert.equal(f.peers.length, 1); assert.equal(f.eventSources.length, 1);
  assert.equal(f.requests.filter(request => request.init.method === 'DELETE').length, 0);
});

test('hidden pages and deliberate pause suspend frame deadlines; foreground gets a fresh recovery window', async () => {
  const f = fixture({ frameCallbacks: true }); await f.start(); f.peers[0].ontrack({ streams: [{ stream: true }] }); f.peers[0].connection('connected');
  f.document.visibility(true); await f.time.advance(60000); assert.equal(f.errors.length, 0);
  f.document.visibility(false); await f.time.advance(14000); assert.equal(f.errors.length, 0);
  f.video.presentFrame(); f.video.pause(); await f.time.advance(60000); assert.equal(f.errors.length, 0);
  await f.video.play(); f.video.emit('playing'); await f.time.advance(9000); assert.equal(f.errors.length, 0);
  f.video.presentFrame(); await f.time.advance(9000); assert.equal(f.errors.length, 0);
  await f.time.advance(1000); assert.equal(f.errors.length, 1);
  assert.equal(f.videoListeners.get('playing').length, 0); assert.equal(f.documentListeners.get('visibilitychange').length, 0);
});

test('fallback frame counters detect progress and a moving media clock cannot hide a stopped counter', async () => {
  const f = fixture(); await f.start(); f.peers[0].ontrack({ streams: [{ stream: true }] }); f.peers[0].connection('connected');
  f.video.presentFrame(); await f.time.advance(1000); assert.equal(f.player.hasFrame, true);
  for (let index = 0; index < 9; index++) { f.video.currentTime++; await f.time.advance(1000); }
  assert.equal(f.errors.length, 0);
  f.video.currentTime++; await f.time.advance(1000); assert.equal(f.errors.length, 1);
});

test('legacy video-time fallback requires decoded dimensions and resumes without invented frame counts', async () => {
  const f = fixture({ noFrameCounter: true }); await f.start(); f.peers[0].ontrack({ streams: [{ stream: true }] }); f.peers[0].connection('connected');
  f.video.currentTime = 20; await f.time.advance(1000); assert.equal(f.player.hasFrame, false, 'A media clock without an image is not a first frame');
  f.video.presentFrame(); await f.time.advance(1000); f.video.presentFrame(); await f.time.advance(1000);
  assert.equal(f.player.hasFrame, true); f.player.destroy(); assert.equal(f.errors.length, 0);
});

test('repeated start is idempotent and a destroyed player cannot create another connection', async () => {
  const f = fixture(), first = f.player.start(), second = f.player.start();
  assert.equal(first, second); await first; assert.equal(f.peers.length, 1); assert.equal(f.requests.filter(request => request.init.method === 'POST').length, 1);
  f.player.destroy(); await f.player.start(); assert.equal(f.peers.length, 1);
});

test('timeout consumes a late offer response only to delete it; failed video can never reattach', async () => {
  const response = deferred(), f = fixture({ fetch: ({ init }) => init.method === 'DELETE' ? Promise.resolve({ ok: true }) : response.promise });
  const pending = f.start(); await settle(); await f.time.advance(15000); assert.equal(f.errors.length, 1);
  response.resolve({ ok: true, json: async () => ({ sessionId, answer }) }); await pending;
  assert.equal(f.peers[0].remoteCalls.length, 0); assert.equal(f.eventSources.length, 0);
  assert.equal(f.requests.filter(request => request.init.method === 'DELETE').length, 1);
  f.peers[0].ontrack({ streams: [{ late: true }] }); assert.equal(f.video.srcObject, null);
});

test('destroy during remote description and a rejected description both release resources without opening SSE', async () => {
  const remote = deferred(), f = fixture({ setRemoteDescription: () => remote.promise }), pending = f.start(); await settle();
  f.player.destroy(); remote.resolve(); await pending;
  assert.equal(f.eventSources.length, 0); assert.equal(f.requests.filter(request => request.init.method === 'DELETE').length, 1);
  const failed = fixture({ setRemoteDescription: () => Promise.reject(Error('bad answer')) }); await assert.rejects(failed.start(), /bad answer/);
  assert.equal(failed.peers[0].closed, true); assert.deepEqual(failed.time.pending(), []);
  assert.equal(failed.requests.filter(request => request.init.method === 'DELETE').length, 1);
});

test('destroy stops only its owned media tracks and cannot clear a newer player stream', async () => {
  const f = fixture({ frameCallbacks: true }); await f.start(); let stops = 0;
  f.peers[0].ontrack({ streams: [{ getTracks: () => [{ stop: () => { stops++; } }] }] });
  const replacement = { newerPlayer: true }; f.video.srcObject = replacement; const pauses = f.video.pauses;
  f.player.destroy(); assert.equal(stops, 1); assert.equal(f.video.srcObject, replacement); assert.equal(f.video.pauses, pauses);
  assert.equal(f.frameCallbacks.size, 0); assert.deepEqual(f.time.pending(), []);
});

test('supported video receivers get a guarded 1000ms jitter target without altering the offer or legacy hint', async t => {
  const receiver = { track: { kind: 'video' }, jitterBufferTarget: null, playoutDelayHint: null }, f = fixture({ receiver }); t.after(() => f.player.destroy());
  await f.start(); assert.equal(receiver.jitterBufferTarget, 1000); assert.equal(receiver.playoutDelayHint, null); assert.equal(f.player.receiveBufferTargetMs, 1000);
  assert.equal(JSON.parse(f.requests[0].init.body).offer, offer.sdp);
  const replacement = { track: { kind: 'video' }, jitterBufferTarget: null };
  f.peers[0].ontrack({ receiver: replacement, streams: [{ stream: true }] }); assert.equal(replacement.jitterBufferTarget, 1000);
});

test('unsupported, audio or throwing jitter-target setters do not break camera negotiation', async t => {
  const unsupported = { track: { kind: 'video' } }, audio = { track: { kind: 'audio' }, jitterBufferTarget: null };
  const rejected = { track: { kind: 'video' } }; Object.defineProperty(rejected, 'jitterBufferTarget', { get: () => null, set: () => { throw Error('unsupported'); } });
  for (const receiver of [unsupported, audio, rejected]) {
    const f = fixture({ receiver }); t.after(() => f.player.destroy()); await assert.doesNotReject(f.start());
    assert.equal(f.player.receiveBufferTargetMs, null); assert.equal(f.errors.length, 0);
  }
  assert.equal('jitterBufferTarget' in unsupported, false); assert.equal(audio.jitterBufferTarget, null);
});

test('a consumer closing the player on its first-frame status cannot leave another callback or timer behind', async () => {
  const f = fixture({ frameCallbacks: true }); await f.start(); f.peers[0].connection('connected');
  f.player.onStatus = status => { if (status === 'playing') f.player.destroy(); };
  f.video.presentFrame(); assert.equal(f.player.closed, true); assert.equal(f.frameCallbacks.size, 0); assert.deepEqual(f.time.pending(), []);
});
