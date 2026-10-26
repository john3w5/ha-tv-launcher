import { createHash } from 'node:crypto';
import { readHouseholdPanel } from './household-panel.mjs';
import { readDomesticPanel } from './domestic-panel.mjs';
import { readHaEntityIdentity } from './ha-entity-identity.mjs';

export class HomeAssistant {
  constructor({ url, token, fetchImpl = fetch, websocketClass = globalThis.WebSocket, timeoutMs = 12000 }) {
    this.base = new URL(url.endsWith('/') ? url : `${url}/`);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password) throw new Error('Invalid HA_URL');
    this.token = token;
    this.fetch = fetchImpl;
    this.WebSocket = websocketClass;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, responseType = 'json', signal } = {}) {
    const url = new URL(path.replace(/^\//, ''), this.base);
    if (url.origin !== this.base.origin) throw new Error('Invalid Home Assistant path');
    const response = await this.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Home Assistant request failed (${response.status})`);
    if (responseType === 'response') return response;
    return response.json();
  }

  states() { return this.request('api/states'); }
  entityIdentity(entityId) { return readHaEntityIdentity({ url: this.base.href, token: this.token, entityId,
    websocketClass: this.WebSocket, timeoutMs: Math.min(this.timeoutMs, 8000) }); }
  calendar(entityId, start, end) {
    const query = new URLSearchParams({ start, end });
    return this.request(`api/calendars/${encodeURIComponent(entityId)}?${query}`);
  }
  snapshot(entityId, { signal } = {}) { return this.request(`api/camera_proxy/${encodeURIComponent(entityId)}`, { responseType: 'response', signal }); }
  scene(entityId) { return this.request('api/services/scene/turn_on', { method: 'POST', body: { entity_id: entityId } }); }

  /** Native HA 2026.10 persistent_notification subscription; this performs no device/config action. */
  subscribePersistentNotifications({ onNotification = () => {}, onRemove = () => {}, onStatus = () => {},
    reconnectMs = 1000, maxReconnectMs = 30000, heartbeatMs = 30000, heartbeatTimeoutMs = 10000 } = {}) {
    let stopped = false, socket = null, reconnectTimer, handshakeTimer, heartbeatTimer, pongTimer;
    let retry = 0, nextId = 2, pingId = null;
    let status = { source: 'home_assistant', configured: true, connected: false, state: 'connecting', lastEventAt: null };
    const known = new Map(), currentNotes = new Map();
    const safely = (callback, value) => { try { callback(value); } catch { /* A consumer cannot break the subscription. */ } };
    const setStatus = (connected, state) => { status = { ...status, connected, state }; safely(onStatus, { ...status }); };
    const idFor = id => `ha-${createHash('sha256').update(String(id)).digest('hex').slice(0, 24)}`;
    const text = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, max);
    const remember = (id, notice) => {
      // HA recreates created_at even for an unchanged persistent notification.
      // Keep that unresolved reminder quiet until visible content changes or it is removed.
      const fingerprint = createHash('sha256').update(JSON.stringify([notice.title, notice.message, notice.type])).digest('hex');
      const changed = known.get(id) !== fingerprint;
      known.delete(id); known.set(id, fingerprint);
      while (known.size > 2048) { const oldest = known.keys().next().value; known.delete(oldest); currentNotes.delete(oldest); }
      return changed;
    };
    const clearConnectionTimers = () => { clearTimeout(handshakeTimer); clearInterval(heartbeatTimer); clearTimeout(pongTimer); pingId = null; };
    const schedule = () => {
      if (stopped || reconnectTimer) return;
      const delay = Math.min(maxReconnectMs, reconnectMs * 2 ** Math.min(retry++, 5));
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
      reconnectTimer.unref?.();
    };
    const lose = (current, state = 'reconnecting', retryAllowed = true) => {
      if (current !== socket) return;
      socket = null;
      clearConnectionTimers();
      currentNotes.clear();
      setStatus(false, state);
      try { current.close(); } catch { /* Already closed. */ }
      if (retryAllowed) schedule();
    };
    const heartbeat = current => {
      heartbeatTimer = setInterval(() => {
        if (stopped || socket !== current || pingId !== null) return;
        pingId = nextId++;
        try { current.send(JSON.stringify({ id: pingId, type: 'ping' })); }
        catch { lose(current); return; }
        pongTimer = setTimeout(() => lose(current), heartbeatTimeoutMs);
        pongTimer.unref?.();
      }, heartbeatMs);
      heartbeatTimer.unref?.();
    };
    const connect = () => {
      if (stopped) return;
      if (!this.WebSocket) { setStatus(false, 'unavailable'); return; }
      const url = new URL('api/websocket', this.base);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      let current;
      try { current = new this.WebSocket(url); } catch { setStatus(false, 'reconnecting'); schedule(); return; }
      socket = current;
      let subscribed = false;
      setStatus(false, retry ? 'reconnecting' : 'connecting');
      handshakeTimer = setTimeout(() => lose(current), this.timeoutMs);
      handshakeTimer.unref?.();
      current.addEventListener('message', event => {
        if (stopped || current !== socket) return;
        let message;
        try { message = JSON.parse(String(event.data)); } catch { lose(current); return; }
        try {
          if (message.type === 'auth_required') current.send(JSON.stringify({ type: 'auth', access_token: this.token }));
          else if (message.type === 'auth_invalid') lose(current, 'authentication_failed', false);
          else if (message.type === 'auth_ok' && !subscribed) { subscribed = true; current.send(JSON.stringify({ id: 1, type: 'persistent_notification/subscribe' })); }
          else if (message.type === 'result' && message.id === 1) {
            if (!message.success) { lose(current, 'subscription_failed'); return; }
            clearTimeout(handshakeTimer); retry = 0; setStatus(true, 'connected'); heartbeat(current);
          } else if (message.type === 'pong' && message.id === pingId) { clearTimeout(pongTimer); pingId = null; }
          else if (message.type === 'event' && message.id === 1 && status.connected) {
            const update = message.event;
            if (!update || !['current', 'added', 'updated', 'removed'].includes(update.type)
                || !update.notifications || typeof update.notifications !== 'object' || Array.isArray(update.notifications)) return;
            if (update.type === 'current') { known.clear(); currentNotes.clear(); }
            for (const [id, notification] of Object.entries(update.notifications).slice(0, 2048)) {
              if (update.type === 'removed') { known.delete(id); currentNotes.delete(id); safely(onRemove, { id: idFor(id), source: 'home_assistant' }); continue; }
              if (!notification || typeof notification !== 'object') continue;
              if (typeof notification.message !== 'string' || !notification.message.trim()) { known.delete(id); currentNotes.delete(id); continue; }
              const safeNotice = { id: idFor(id), source: 'home_assistant', title: text(notification.title || 'Home Assistant', 120),
                message: text(notification.message, 1000), type: 'info' };
              const changed = remember(id, safeNotice);
              currentNotes.set(id, safeNotice);
              if (update.type === 'current' || !changed) continue;
              status = { ...status, lastEventAt: new Date().toISOString() };
              safely(onNotification, { ...safeNotice, expiresAt: new Date(Date.now() + 15000).toISOString() });
            }
          }
        } catch { lose(current); }
      });
      current.addEventListener('error', () => lose(current));
      current.addEventListener('close', () => lose(current));
    };
    connect();
    return { getStatus: () => ({ ...status }), getCurrent: () => [...currentNotes.values()].map(notice => ({ ...notice })), stop: () => {
      if (stopped) return;
      stopped = true; clearTimeout(reconnectTimer); reconnectTimer = null; clearConnectionTimers();
      const current = socket; socket = null;
      try { current?.close(); } catch { /* Already closed. */ }
      known.clear(); currentNotes.clear(); setStatus(false, 'stopped');
    } };
  }

  async cameraStream(entityId) {
    if (!this.WebSocket) throw new Error('WebSocket is unavailable');
    const url = new URL('api/websocket', this.base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocket(url);
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Camera stream timed out')), this.timeoutMs);
      socket.addEventListener('message', event => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: this.token }));
          else if (message.type === 'auth_invalid') finish(new Error('Home Assistant authentication failed'));
          else if (message.type === 'auth_ok') socket.send(JSON.stringify({ id: 1, type: 'camera/stream', entity_id: entityId }));
          else if (message.id === 1 && message.type === 'result') {
            if (!message.success || !message.result?.url) finish(new Error('Camera stream is unavailable'));
            else finish(null, new URL(message.result.url, this.base));
          }
        } catch { finish(new Error('Invalid camera stream response')); }
      });
      socket.addEventListener('error', () => finish(new Error('Camera stream connection failed')));
      socket.addEventListener('close', () => { if (!done) finish(new Error('Camera stream connection closed')); });
    });
  }
}

const value = state => {
  if (!state || state.attributes?.restored || ['unknown', 'unavailable', 'none', ''].includes(state.state)) return null;
  if (typeof state.state !== 'number' && (typeof state.state !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(state.state.trim()))) return null;
  const parsed = Number(state.state);
  return Number.isFinite(parsed) ? parsed : null;
};
const WEATHER_MEASUREMENTS = {
  temperature: { units: ['°C', '°F', 'K'] }, humidity: { units: ['%'], range: [0, 100] },
  windSpeed: { units: ['km/h', 'm/s', 'mph', 'kn'], range: [0, Infinity] },
  windDirection: { units: ['°', 'deg'], range: [0, 360] },
  windGust: { units: ['km/h', 'm/s', 'mph', 'kn'], range: [0, Infinity] },
  rainRate: { units: ['mm/h', 'in/h'], range: [0, Infinity] }, dailyRain: { units: ['mm', 'in'], range: [0, Infinity] },
  pressure: { units: ['hPa', 'mbar', 'Pa', 'kPa', 'inHg', 'mmHg'], range: [0, Infinity] },
  feelsLike: { units: ['°C', '°F', 'K'] }, dewPoint: { units: ['°C', '°F', 'K'] },
  uvIndex: { units: ['UV index', 'UV Index', 'UV', ''], range: [0, Infinity] },
  illuminance: { units: ['lx', 'lux'], range: [0, Infinity] },
};
const eventDate = input => typeof input === 'string' ? input : input?.dateTime || input?.date || null;
const solarTimestamp = input => {
  if (typeof input !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
      || hour > 23 || minute > 59 || second > 59) return null;
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

export async function readDashboard(ha, config, now = new Date()) {
  const states = await ha.states();
  if (!Array.isArray(states)) throw new Error('Invalid Home Assistant states');
  const byId = new Map(states.map(state => [state.entity_id, state]));
  const sun = byId.get('sun.sun');
  const solarKnown = Boolean(sun && !sun.attributes?.restored && ['above_horizon', 'below_horizon'].includes(sun.state));
  const solarAngle = (value, minimum, maximum) => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
  const solar = { state: solarKnown ? sun.state : 'unknown',
    nextRising: solarKnown ? solarTimestamp(sun.attributes?.next_rising) : null,
    nextSetting: solarKnown ? solarTimestamp(sun.attributes?.next_setting) : null,
    elevation: solarKnown ? solarAngle(sun.attributes?.elevation, -90, 90) : null,
    azimuth: solarKnown ? solarAngle(sun.attributes?.azimuth, 0, 360) : null,
    rising: solarKnown && typeof sun.attributes?.rising === 'boolean' ? sun.attributes.rising : null };
  const entities = config.entities;
  const station = entities.weather || {};
  const weatherState = byId.get(station.condition);
  const weather = Object.fromEntries(Object.entries(WEATHER_MEASUREMENTS).map(([key, settings]) => {
    const state = byId.get(station[key]), unit = state?.attributes?.unit_of_measurement;
    const measurement = value(state);
    const valid = measurement !== null && settings.units.includes(unit ?? '') &&
      (!settings.range || (measurement >= settings.range[0] && measurement <= settings.range[1]));
    return [key, valid ? measurement : null];
  }));
  weather.condition = weatherState && !weatherState.attributes?.restored && !['unknown', 'unavailable'].includes(weatherState.state) ? weatherState.state : null;
  weather.conditionSource = weather.condition ? (station.condition?.startsWith('weather.') ? 'weather-provider' : 'station') : null;
  weather.units = Object.fromEntries(Object.keys(WEATHER_MEASUREMENTS).map(key => {
    const unit = byId.get(station[key])?.attributes?.unit_of_measurement;
    return [key, typeof unit === 'string' ? unit.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24) : null];
  }));
  const start = now.toISOString();
  const end = new Date(now.getTime() + config.calendarDays * 86400000).toISOString();
  const calendarsPending = Promise.all((entities.calendars || []).map(async item => {
    try {
      const events = await ha.calendar(item.entityId, start, end);
      return { entityId: item.entityId, name: item.name, available: true, events: (Array.isArray(events) ? events : []).map(event => ({
        summary: String(event.summary || 'Událost').slice(0, 300), start: eventDate(event.start), end: eventDate(event.end),
      })).filter(event => event.start && event.end).sort((a, b) => a.start.localeCompare(b.start)) };
    } catch { return { entityId: item.entityId, name: item.name, available: false, events: [] }; }
  }));
  const cameras = (entities.cameras || []).map(item => {
    const state = byId.get(item.entityId);
    const available = Boolean(state && !['unavailable', 'unknown'].includes(state.state));
    const stream = available && ((Number(state.attributes?.supported_features) & 2) === 2);
    const alternate = typeof item.streamEntityId === 'string' && /^camera\.[a-z0-9_]+$/.test(item.streamEntityId)
      && item.streamEntityId !== item.entityId ? byId.get(item.streamEntityId) : null;
    const hasQualityModes = Boolean(stream && alternate && !['unavailable', 'unknown'].includes(alternate.state)
      && ((Number(alternate.attributes?.supported_features) & 2) === 2));
    return { id: item.id, name: item.name, available, streamType: stream ? 'hls' : available ? 'snapshot' : 'none', hasQualityModes,
      snapshotUrl: available ? `/api/cameras/${encodeURIComponent(item.id)}/snapshot` : null };
  });
  const mediaPlayers = (entities.mediaPlayers || []).map(item => {
    const state = byId.get(item.entityId);
    return { entityId: item.entityId, name: item.name, state: state?.state || 'unavailable', source: state?.attributes?.source || null };
  });
  const scenes = (entities.scenes || []).filter(item => config.safeScenes.includes(item.entityId) && byId.has(item.entityId)).map(({ entityId, name }) => ({ entityId, name }));
  const home = Object.fromEntries(['lights', 'locks', 'doors'].map(key => [key, (entities[key] || []).map(item => ({
    entityId: item.entityId, name: item.name, state: byId.get(item.entityId)?.state || 'unavailable',
    ...(item.area ? { area: item.area } : {}), ...(item.role ? { role: item.role } : {}),
  }))]));
  home.alarm = entities.alarm ? { ...entities.alarm, state: byId.get(entities.alarm.entityId)?.state || 'unavailable' } : null;
  const missing = Object.values(station).filter(id => id && !byId.has(id)).length;
  const [calendars, household] = await Promise.all([calendarsPending, readHouseholdPanel(ha, config.householdPanel, { states, now })]);
  const domestic = readDomesticPanel(config.domesticPanel, { states, now });
  return { mode: 'live', updatedAt: now.toISOString(), weather, solar, calendars, cameras, mediaPlayers, scenes, home, household, domestic,
    insights: missing ? [{ id: 'missing-weather', title: 'Meteostanice', message: 'Některé nastavené entity nejsou dostupné. Chybějící hodnoty se nezobrazují.', tone: 'info' }] : [] };
}
