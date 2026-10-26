// HA 2026.10 camera/webrtc protocol. The HA token stays on this server.
// https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/camera/webrtc.py
const MAX_SDP = 65536;
const MAX_CANDIDATES = 256;
const safeError = code => Object.assign(new Error('WebRTC spojení není dostupné.'), { code });
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sdp = value => typeof value === 'string' && value.length <= MAX_SDP && /^v=0\r?\n/.test(value);

export function validateIceCandidate(input) {
  if (!plain(input) || Object.keys(input).some(key => !['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].includes(key))
    || typeof input.candidate !== 'string' || input.candidate.length > 4096
    || (input.sdpMid != null && (typeof input.sdpMid !== 'string' || input.sdpMid.length > 256))
    || (input.sdpMLineIndex != null && (!Number.isInteger(input.sdpMLineIndex) || input.sdpMLineIndex < 0 || input.sdpMLineIndex > 65535))
    || (input.usernameFragment != null && (typeof input.usernameFragment !== 'string' || input.usernameFragment.length > 256))) {
    throw safeError('WEBRTC_INVALID_CANDIDATE');
  }
  return Object.fromEntries(['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']
    .filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
}

function inputOptions({ url, token, entityId, websocketClass = globalThis.WebSocket, timeoutMs = 15000 }) {
  if (!/^camera\.[a-z0-9_]+$/.test(entityId || '') || typeof token !== 'string' || !token || !websocketClass) throw safeError('WEBRTC_INVALID_CONFIG');
  let endpoint;
  try {
    const base = new URL(url.endsWith('/') ? url : `${url}/`);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw Error();
    endpoint = new URL('api/websocket', base);
    endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  } catch { throw safeError('WEBRTC_INVALID_CONFIG'); }
  return { endpoint, token, entityId, websocketClass, timeoutMs: Math.max(1, Math.min(30000, Number(timeoutMs) || 15000)) };
}

/** Resolves after the SDP answer. Pre-answer ICE is returned once in candidates; later ICE uses onCandidate. */
export async function createHaWebRtcSession(options) {
  const { endpoint, token, entityId, websocketClass, timeoutMs } = inputOptions(options);
  if (!sdp(options.offer)) throw safeError('WEBRTC_INVALID_OFFER');
  const onCandidate = typeof options.onCandidate === 'function' ? options.onCandidate : () => {};
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};
  return new Promise((resolve, reject) => {
    let socket, closed = false, ready = false, subscribed = false, authenticated = false, sessionId = null;
    let nextId = 2, candidateCount = 0, clientCandidateCount = 0, pingId = null;
    let handshakeTimer, heartbeatTimer, pongTimer;
    const earlyCandidates = [], pending = new Map();
    const safeCall = (fn, value) => { try { fn(value); } catch { /* Consumer errors cannot leak credentials or break cleanup. */ } };
    const finish = (reason, code = 'WEBRTC_CLOSED') => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer); clearInterval(heartbeatTimer); clearTimeout(pongTimer);
      for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(safeError(code)); }
      pending.clear();
      if (subscribed) { try { socket.send(JSON.stringify({ id: nextId++, type: 'unsubscribe_events', subscription: 1 })); } catch { /* Closing transport. */ } }
      try { socket?.close(); } catch { /* Already closed. */ }
      if (!ready) reject(safeError(code));
      safeCall(onClose, { reason });
    };
    const send = value => {
      if (closed) throw safeError('WEBRTC_CLOSED');
      try { socket.send(JSON.stringify(value)); } catch { finish('transport_error', 'WEBRTC_TRANSPORT_ERROR'); throw safeError('WEBRTC_TRANSPORT_ERROR'); }
    };
    const sendCandidate = input => {
      let candidate;
      try { candidate = validateIceCandidate(input); } catch (error) { return Promise.reject(error); }
      if (closed || !ready || !sessionId) return Promise.reject(safeError('WEBRTC_CLOSED'));
      if (++clientCandidateCount > MAX_CANDIDATES || pending.size >= 32) return Promise.reject(safeError('WEBRTC_CANDIDATE_LIMIT'));
      const id = nextId++;
      return new Promise((resolveCandidate, rejectCandidate) => {
        const timer = setTimeout(() => { pending.delete(id); rejectCandidate(safeError('WEBRTC_CANDIDATE_TIMEOUT')); finish('candidate_timeout'); }, timeoutMs);
        pending.set(id, { resolve: resolveCandidate, reject: rejectCandidate, timer });
        try { send({ id, type: 'camera/webrtc/candidate', entity_id: entityId, session_id: sessionId, candidate }); }
        catch (error) { clearTimeout(timer); pending.delete(id); rejectCandidate(error); }
      });
    };
    handshakeTimer = setTimeout(() => finish('timeout', 'WEBRTC_TIMEOUT'), timeoutMs);
    try { socket = new websocketClass(endpoint); } catch { finish('transport_error', 'WEBRTC_TRANSPORT_ERROR'); return; }
    socket.addEventListener('message', event => {
      if (closed) return;
      let message;
      try {
        const raw = String(event.data);
        if (raw.length > MAX_SDP * 4) throw Error();
        message = JSON.parse(raw);
        if (!plain(message)) throw Error();
      } catch { finish('invalid_response', 'WEBRTC_INVALID_RESPONSE'); return; }
      if (message.type === 'auth_required' && !authenticated) {
        try { send({ type: 'auth', access_token: token }); } catch { /* send closes safely. */ }
      } else if (message.type === 'auth_invalid') finish('authentication_failed', 'WEBRTC_AUTH_FAILED');
      else if (message.type === 'auth_ok' && !authenticated) {
        authenticated = true;
        try { send({ id: 1, type: 'camera/webrtc/offer', entity_id: entityId, offer: options.offer }); } catch { /* send closes safely. */ }
      } else if (message.type === 'pong' && message.id === pingId) {
        clearTimeout(pongTimer); pingId = null;
      } else if (message.type === 'result') {
        if (message.id === 1) {
          if (!message.success) finish('offer_failed', 'WEBRTC_OFFER_FAILED');
          else subscribed = true;
        } else if (pending.has(message.id)) {
          const operation = pending.get(message.id); pending.delete(message.id); clearTimeout(operation.timer);
          if (message.success) operation.resolve();
          else { operation.reject(safeError('WEBRTC_CANDIDATE_FAILED')); finish('candidate_failed'); }
        }
      } else if (message.type === 'event' && message.id === 1 && subscribed) {
        const value = message.event;
        if (!plain(value)) { finish('invalid_response', 'WEBRTC_INVALID_RESPONSE'); return; }
        if (value.type === 'session') {
          if (sessionId || typeof value.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.session_id)) finish('invalid_response', 'WEBRTC_INVALID_RESPONSE');
          else sessionId = value.session_id;
        } else if (value.type === 'candidate') {
          let candidate;
          try { candidate = validateIceCandidate(value.candidate); } catch { finish('invalid_response', 'WEBRTC_INVALID_RESPONSE'); return; }
          if (++candidateCount > MAX_CANDIDATES) { finish('candidate_limit', 'WEBRTC_CANDIDATE_LIMIT'); return; }
          if (ready) safeCall(onCandidate, candidate); else earlyCandidates.push(candidate);
        } else if (value.type === 'answer') {
          if (ready || !sessionId || !sdp(value.answer)) { finish('invalid_response', 'WEBRTC_INVALID_RESPONSE'); return; }
          ready = true;
          clearTimeout(handshakeTimer);
          heartbeatTimer = setInterval(() => {
            if (closed || pingId !== null) return;
            pingId = nextId++;
            try { send({ id: pingId, type: 'ping' }); } catch { return; }
            pongTimer = setTimeout(() => finish('heartbeat_timeout'), 10000); pongTimer.unref?.();
          }, 20000); heartbeatTimer.unref?.();
          resolve({ answer: value.answer, candidates: [...earlyCandidates], sendCandidate, close: () => finish('closed') });
        } else if (value.type === 'error') finish('offer_failed', 'WEBRTC_OFFER_FAILED');
        else finish('invalid_response', 'WEBRTC_INVALID_RESPONSE');
      }
    });
    socket.addEventListener('error', () => finish('transport_error', 'WEBRTC_TRANSPORT_ERROR'));
    socket.addEventListener('close', () => finish('transport_closed', 'WEBRTC_TRANSPORT_CLOSED'));
  });
}

/** This contains only ICE configuration needed by the authenticated browser, never the HA token. */
export async function getHaWebRtcConfig(options) {
  const { endpoint, token, entityId, websocketClass, timeoutMs } = inputOptions(options);
  return new Promise((resolve, reject) => {
    let socket, done = false, authenticated = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); try { socket?.close(); } catch { /* Already closed. */ } error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(safeError('WEBRTC_TIMEOUT')), timeoutMs);
    try { socket = new websocketClass(endpoint); } catch { finish(safeError('WEBRTC_TRANSPORT_ERROR')); return; }
    socket.addEventListener('message', event => {
      if (done) return;
      try {
        const raw = String(event.data);
        if (raw.length > MAX_SDP) throw Error();
        const message = JSON.parse(raw);
        if (message.type === 'auth_required' && !authenticated) socket.send(JSON.stringify({ type: 'auth', access_token: token }));
        else if (message.type === 'auth_invalid') finish(safeError('WEBRTC_AUTH_FAILED'));
        else if (message.type === 'auth_ok' && !authenticated) {
          authenticated = true;
          socket.send(JSON.stringify({ id: 1, type: 'camera/webrtc/get_client_config', entity_id: entityId }));
        } else if (message.type === 'result' && message.id === 1) {
          if (!message.success || !plain(message.result?.configuration)) { finish(safeError('WEBRTC_CONFIG_FAILED')); return; }
          const servers = message.result.configuration.iceServers ?? [];
          if (!Array.isArray(servers) || servers.length > 32) throw Error();
          const iceServers = servers.map(server => {
            if (!plain(server)) throw Error();
            const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
            if (!Array.isArray(urls) || !urls.length || urls.length > 16 || urls.some(url => typeof url !== 'string' || url.length > 2048 || !/^(?:stun|stuns|turn|turns):/i.test(url))) throw Error();
            const result = { urls: [...urls] };
            for (const key of ['username', 'credential']) if (server[key] != null) {
              if (typeof server[key] !== 'string' || server[key].length > 4096) throw Error(); result[key] = server[key];
            }
            return result;
          });
          finish(null, { configuration: { iceServers } });
        }
      } catch { finish(safeError('WEBRTC_INVALID_RESPONSE')); }
    });
    socket.addEventListener('error', () => finish(safeError('WEBRTC_TRANSPORT_ERROR')));
    socket.addEventListener('close', () => finish(safeError('WEBRTC_TRANSPORT_CLOSED')));
  });
}
