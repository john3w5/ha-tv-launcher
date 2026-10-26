import { createHash } from 'node:crypto';

const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/.test(value);
const entity = (value, domain) => typeof value === 'string' && new RegExp(`^${domain}\\.[a-z0-9_]+$`).test(value);
const text = (value, fallback, length) => String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, length);
const seconds = (value, fallback, maximum) => Number.isFinite(Number(value)) ? Math.max(1, Math.min(maximum, Math.floor(Number(value)))) : fallback;
const numeric = value => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
// "none" is an actual SmartThings washer job enum, not an unavailable state.
const usable = value => value && typeof value.state === 'string' && !['unknown', 'unavailable', ''].includes(value.state);
const safeCall = (callback, value) => { try { callback(value); } catch { /* A UI consumer cannot interrupt the event feed. */ } };

/** The bridge passes its configured camera IDs; this function does not accept actions/services. */
export function normalizeHouseEvents(raw, { cameraIds } = {}) {
  const result = { enabled: raw?.enabled === true, doorbells: [], alerts: [] };
  if (!result.enabled || !plain(raw)) return result;
  const seen = new Set();
  const common = rule => {
    if (!plain(rule) || !id(rule.id) || seen.has(rule.id)) return null;
    seen.add(rule.id);
    return { id: rule.id, title: text(rule.title, 'Domov', 120), message: text(rule.message, '', 1000),
      cooldownSeconds: seconds(rule.cooldownSeconds, 60, 86400), durationSeconds: seconds(rule.durationSeconds, 15, 120) };
  };
  for (const rule of (Array.isArray(raw.doorbells) ? raw.doorbells : []).slice(0, 8)) {
    if (!plain(rule) || !id(rule.cameraId) || (cameraIds && !cameraIds.includes(rule.cameraId))) continue;
    const eventEntity = rule.source === 'event_entity' && entity(rule.entityId, 'event')
      && Array.isArray(rule.eventTypes) && rule.eventTypes.length > 0 && rule.eventTypes.length <= 8
      && rule.eventTypes.every(value => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value));
    const automation = rule.source === 'automation' && entity(rule.entityId, 'automation') && rule.requiredSource === 'webhook';
    if (!eventEntity && !automation) continue;
    const base = common(rule); if (!base) continue;
    result.doorbells.push({ ...base, source: rule.source, entityId: rule.entityId, cameraId: rule.cameraId,
      ...(eventEntity ? { eventTypes: [...new Set(rule.eventTypes)] } : { requiredSource: 'webhook' }) });
  }
  for (const rule of (Array.isArray(raw.alerts) ? raw.alerts : []).slice(0, 16)) {
    if (!plain(rule)) continue;
    let fields;
    if (rule.type === 'binary_on' && entity(rule.entityId, 'binary_sensor')) fields = { entityId: rule.entityId };
    else if (rule.type === 'battery_low' && entity(rule.entityId, 'sensor') && Number.isFinite(rule.threshold) && rule.threshold > 0 && rule.threshold < 100) fields = { entityId: rule.entityId, threshold: rule.threshold };
    else if (rule.type === 'washer_finished' && entity(rule.entityId, 'sensor') && Array.isArray(rule.activeStates)
      && rule.activeStates.length > 0 && rule.activeStates.length <= 24 && rule.activeStates.every(value => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value))
      && typeof rule.finishedState === 'string' && /^[a-z_]{1,40}$/.test(rule.finishedState) && !rule.activeStates.includes(rule.finishedState)) {
      fields = { entityId: rule.entityId, activeStates: [...new Set(rule.activeStates)], finishedState: rule.finishedState };
    } else if (rule.type === 'window_hvac' && entity(rule.windowEntityId, 'binary_sensor') && entity(rule.climateEntityId, 'climate')
      && Array.isArray(rule.activeModes) && rule.activeModes.length > 0 && rule.activeModes.every(value => ['cool', 'heat', 'dry', 'auto', 'fan_only'].includes(value))) {
      fields = { windowEntityId: rule.windowEntityId, climateEntityId: rule.climateEntityId, activeModes: [...new Set(rule.activeModes)] };
    }
    if (!fields) continue;
    const base = common(rule); if (!base) continue;
    result.alerts.push({ ...base, type: rule.type, tone: ['info', 'warning'].includes(rule.tone) ? rule.tone : 'info', ...fields });
  }
  return result;
}

/** Pure transition evaluator: seed never alerts, missing/unknown old states never act as a crossing. */
export function createHouseEventProcessor(config, { onDoorbell = () => {}, onNotification = () => {}, now = () => Date.now() } = {}) {
  const rules = normalizeHouseEvents(config);
  const states = new Map(), lastEmitted = new Map(), washerArmed = new Set(), washerCompleted = new Set();
  const relevant = new Set([...rules.doorbells.map(rule => rule.entityId), ...rules.alerts.flatMap(rule => [rule.entityId, rule.windowEntityId, rule.climateEntityId].filter(Boolean))]);
  const project = state => !state ? null : { state: state.state, attributes: { event_type: state.attributes?.event_type, restored: state.attributes?.restored } };
  const seed = initial => {
    states.clear(); washerArmed.clear(); washerCompleted.clear();
    for (const state of Array.isArray(initial) ? initial : []) if (relevant.has(state?.entity_id)) states.set(state.entity_id, project(state));
    for (const rule of rules.alerts) if (rule.type === 'washer_finished' && rule.activeStates.includes(states.get(rule.entityId)?.state)) washerArmed.add(rule.id);
  };
  const emit = (rule, doorbell, at) => {
    const current = now();
    if (current - (lastEmitted.get(rule.id) ?? -Infinity) < rule.cooldownSeconds * 1000) return;
    lastEmitted.set(rule.id, current);
    if (doorbell) {
      const suffix = createHash('sha256').update(`${rule.id}:${at}`).digest('hex').slice(0, 16);
      safeCall(onDoorbell, { id: `bell-${rule.id}-${suffix}`, title: rule.title, message: rule.message, cameraId: rule.cameraId, durationSeconds: rule.durationSeconds });
    } else safeCall(onNotification, { id: `house-${rule.id}`, title: rule.title, message: rule.message, type: rule.tone,
      source: 'home_assistant', expiresAt: new Date(current + rule.durationSeconds * 1000).toISOString() });
  };
  const fresh = eventTime => {
    const at = timestamp(eventTime);
    return at !== null && at <= now() + 5000 && now() - at <= 30000 ? at : null;
  };
  const handle = event => {
    if (!rules.enabled || !plain(event)) return;
    const at = fresh(event.time_fired); if (at === null) return;
    if (event.event_type === 'automation_triggered') {
      for (const rule of rules.doorbells) if (rule.source === 'automation' && event.data?.entity_id === rule.entityId
        && event.data?.source === rule.requiredSource && !event.context?.user_id) emit(rule, true, at);
      return;
    }
    if (event.event_type !== 'state_changed' || !relevant.has(event.data?.entity_id)) return;
    const entityId = event.data.entity_id, old = project(event.data.old_state), next = project(event.data.new_state);
    const before = new Map(states);
    if (next) states.set(entityId, next); else states.delete(entityId);
    if (next?.attributes.restored || old?.attributes.restored) {
      for (const rule of rules.alerts) if (rule.entityId === entityId) { washerArmed.delete(rule.id); washerCompleted.delete(rule.id); }
      return;
    }
    for (const rule of rules.doorbells) if (rule.source === 'event_entity' && rule.entityId === entityId) {
      const oldTime = timestamp(old?.state), nextTime = timestamp(next?.state);
      if (oldTime !== null && nextTime !== null && nextTime > oldTime && !next.attributes.restored
        && Math.abs(nextTime - at) <= 30000 && rule.eventTypes.includes(next.attributes.event_type)) emit(rule, true, nextTime);
    }
    for (const rule of rules.alerts) {
      if (rule.type === 'window_hvac') {
        if (![rule.windowEntityId, rule.climateEntityId].includes(entityId) || !usable(old) || !usable(next) || old.state === next.state) continue;
        const wasActive = before.get(rule.windowEntityId)?.state === 'on' && rule.activeModes.includes(before.get(rule.climateEntityId)?.state);
        const active = states.get(rule.windowEntityId)?.state === 'on' && rule.activeModes.includes(states.get(rule.climateEntityId)?.state);
        if (active && !wasActive) emit(rule, false, at);
        continue;
      }
      if (rule.entityId !== entityId) continue;
      if (rule.type === 'washer_finished') {
        if (!usable(next)) { washerArmed.delete(rule.id); washerCompleted.delete(rule.id); continue; }
        if (next.state !== rule.finishedState) washerCompleted.delete(rule.id);
        if (rule.activeStates.includes(next.state) && usable(old)) washerArmed.add(rule.id);
        if (next.state === rule.finishedState && old?.state !== next.state && usable(old) && washerArmed.has(rule.id)) {
          washerArmed.delete(rule.id); washerCompleted.add(rule.id); emit(rule, false, at);
        } else if (!rule.activeStates.includes(next.state)) washerArmed.delete(rule.id);
      } else if (rule.type === 'binary_on') {
        if (old?.state === 'off' && next?.state === 'on') emit(rule, false, at);
      } else if (rule.type === 'battery_low') {
        const oldNumber = numeric(old?.state), nextNumber = numeric(next?.state);
        if (oldNumber !== null && nextNumber !== null && oldNumber >= 0 && oldNumber <= 100 && nextNumber >= 0 && nextNumber <= 100
          && oldNumber > rule.threshold && nextNumber <= rule.threshold) emit(rule, false, at);
      }
    }
  };
  const getCurrent = () => rules.alerts.filter(rule => {
    const current = states.get(rule.entityId);
    if (rule.type === 'window_hvac') {
      const window = states.get(rule.windowEntityId), climate = states.get(rule.climateEntityId);
      return !window?.attributes.restored && !climate?.attributes.restored && window?.state === 'on' && rule.activeModes.includes(climate?.state);
    }
    if (!usable(current) || current.attributes.restored) return false;
    if (rule.type === 'binary_on') return current.state === 'on';
    if (rule.type === 'battery_low') { const level = numeric(current.state); return level !== null && level >= 0 && level <= rule.threshold; }
    return rule.type === 'washer_finished' && washerCompleted.has(rule.id) && current.state === rule.finishedState;
  }).map(rule => ({ id: `house-${rule.id}`, title: rule.title, message: rule.message, type: rule.tone, source: 'home_assistant' }));
  return { seed, handle, getCurrent, ruleCount: rules.doorbells.length + rules.alerts.length };
}

/** Read-only live HA event subscription. No service calls, configuration writes or replayed initial alerts. */
export function subscribeHouseEvents({ url, token, config, websocketClass = globalThis.WebSocket, onDoorbell, onNotification,
  onStatus = () => {}, now = () => Date.now(), timeoutMs = 15000, reconnectMs = 1000, maxReconnectMs = 30000,
  heartbeatMs = 30000, heartbeatTimeoutMs = 10000, stateEntityIds = [], onState = () => {} } = {}) {
  const processor = createHouseEventProcessor(config, { onDoorbell, onNotification, now });
  const tracked = new Set((Array.isArray(stateEntityIds) ? stateEntityIds : []).filter(id => /^sensor\.[a-z0-9_]+$/.test(id)).slice(0, 1));
  const configured = config?.enabled === true && processor.ruleCount > 0 || tracked.size > 0;
  const projectTracked = state => ({ entity_id: state.entity_id, state: state.state, attributes: {
    unit_of_measurement: state.attributes?.unit_of_measurement, restored: state.attributes?.restored }, last_updated: state.last_updated, last_changed: state.last_changed });
  let status = { source: 'home_assistant', configured, connected: false,
    state: configured ? 'connecting' : 'disabled', lastEventAt: null };
  let stopped = false, socket = null, reconnectTimer, handshakeTimer, heartbeatTimer, pongTimer, retry = 0, nextId = 4, pingId = null;
  const setStatus = (connected, state) => { status = { ...status, connected, state }; safeCall(onStatus, { ...status }); };
  const clearTimers = () => { clearTimeout(handshakeTimer); clearInterval(heartbeatTimer); clearTimeout(pongTimer); pingId = null; };
  const schedule = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, Math.min(maxReconnectMs, reconnectMs * 2 ** Math.min(retry++, 5)));
    reconnectTimer.unref?.();
  };
  const lose = (current, state = 'reconnecting', retryAllowed = true) => {
    if (current !== socket) return;
    socket = null; clearTimers(); processor.seed([]); setStatus(false, state);
    try { current.close(); } catch { /* Already closed. */ }
    if (retryAllowed) schedule();
  };
  const connect = () => {
    if (stopped || !status.configured) return;
    if (!websocketClass) { setStatus(false, 'unavailable'); return; }
    let current;
    try {
      const base = new URL(url.endsWith('/') ? url : `${url}/`);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || !token) throw Error();
      const endpoint = new URL('api/websocket', base); endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      current = new websocketClass(endpoint);
    } catch { setStatus(false, 'unavailable'); return; }
    socket = current;
    const confirmed = new Set();
    let authenticated = false;
    setStatus(false, retry ? 'reconnecting' : 'connecting');
    handshakeTimer = setTimeout(() => lose(current), timeoutMs); handshakeTimer.unref?.();
    current.addEventListener('message', event => {
      if (stopped || current !== socket) return;
      let message;
      try { const raw = String(event.data); if (raw.length > 5 * 1024 * 1024) throw Error(); message = JSON.parse(raw); if (!plain(message)) throw Error(); }
      catch { lose(current); return; }
      if (message.type === 'auth_required' && !authenticated) {
        try { current.send(JSON.stringify({ type: 'auth', access_token: token })); } catch { lose(current); }
      }
      else if (message.type === 'auth_invalid') lose(current, 'authentication_failed', false);
      else if (message.type === 'auth_ok' && !authenticated) {
        authenticated = true;
        try {
          current.send(JSON.stringify({ id: 1, type: 'get_states' }));
          current.send(JSON.stringify({ id: 2, type: 'subscribe_events', event_type: 'state_changed' }));
          current.send(JSON.stringify({ id: 3, type: 'subscribe_events', event_type: 'automation_triggered' }));
        } catch { lose(current); }
      } else if (message.type === 'result' && [1, 2, 3].includes(message.id)) {
        if (!message.success || (message.id === 1 && !Array.isArray(message.result))) { lose(current); return; }
        if (message.id === 1) {
          processor.seed(message.result);
          for (const state of message.result) if (tracked.has(state?.entity_id)) safeCall(onState, projectTracked(state));
        }
        confirmed.add(message.id);
        if (confirmed.size === 3 && !status.connected) {
          clearTimeout(handshakeTimer); retry = 0; setStatus(true, 'connected');
          heartbeatTimer = setInterval(() => {
            if (socket !== current || pingId !== null) return;
            pingId = nextId++;
            try { current.send(JSON.stringify({ id: pingId, type: 'ping' })); } catch { lose(current); return; }
            pongTimer = setTimeout(() => lose(current), heartbeatTimeoutMs); pongTimer.unref?.();
          }, heartbeatMs); heartbeatTimer.unref?.();
        }
      } else if (message.type === 'pong' && message.id === pingId) { clearTimeout(pongTimer); pingId = null; }
      else if (message.type === 'event' && [2, 3].includes(message.id) && status.connected) {
        const expected = message.id === 2 ? 'state_changed' : 'automation_triggered';
        if (message.event?.event_type !== expected) return;
        const at = timestamp(message.event?.time_fired);
        if (expected === 'state_changed' && tracked.has(message.event.data?.entity_id) && at !== null && at <= now() + 5000 && now() - at <= 30000) {
          const state = message.event.data.new_state;
          safeCall(onState, state && state.entity_id === message.event.data.entity_id ? projectTracked(state)
            : { entity_id: message.event.data.entity_id, state: 'unavailable', attributes: {} });
        }
        processor.handle(message.event);
        status = { ...status, lastEventAt: new Date(now()).toISOString() };
      }
    });
    current.addEventListener('error', () => lose(current));
    current.addEventListener('close', () => lose(current));
  };
  connect();
  return { getStatus: () => ({ ...status }), getCurrent: () => status.connected ? processor.getCurrent() : [], stop: () => {
    if (stopped) return;
    stopped = true; clearTimeout(reconnectTimer); reconnectTimer = null; clearTimers();
    const current = socket; socket = null; try { current?.close(); } catch { /* Already closed. */ }
    processor.seed([]); setStatus(false, 'stopped');
  } };
}
