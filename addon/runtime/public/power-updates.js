/* Source-driven power projection only. No fetch, timer, controls or camera redraw. */
(function (global) {
  'use strict';
  function apply(data, value) {
    const energy = data?.domestic?.energy, previous = energy?.power;
    if (!energy || !previous || !value || typeof value !== 'object' || value.entityId !== previous.entityId ||
      !/^sensor\.[a-z0-9_]+$/.test(value.entityId) || typeof value.available !== 'boolean') return false;
    const time = value.updatedAt === null ? null : typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) ? Date.parse(value.updatedAt) : NaN;
    if (Number.isNaN(time)) return false;
    if (value.available && (!Number.isFinite(value.value) || !['W', 'kW'].includes(value.unit) || !Number.isFinite(value.powerW) ||
      Math.abs(value.powerW - value.value * (value.unit === 'kW' ? 1000 : 1)) > 0.000001 * Math.max(1, Math.abs(value.powerW)))) return false;
    if (!value.available && (value.value !== null || value.powerW !== null)) return false;
    const previousTime = Date.parse(previous.updatedAt);
    if (value.available && Number.isFinite(previousTime) && time !== null && time < previousTime) return false;
    energy.power = { entityId: value.entityId, available: value.available, value: value.available ? value.value : null,
      unit: ['W', 'kW'].includes(value.unit) ? value.unit : null, updatedAt: value.updatedAt };
    energy.powerW = value.available ? value.powerW : null;
    return true;
  }
  function connect(source, { getData, onChange = () => {}, onStatus = () => {} } = {}) {
    const power = event => { try { const payload = JSON.parse(event.data); if (apply(getData(), payload)) onChange(payload); } catch { /* Malformed SSE never breaks a camera or UI. */ } };
    const unavailable = () => { try {
      const data = getData(), previous = data?.domestic?.energy?.power;
      if (!previous?.entityId || previous.available === false && data.domestic.energy.powerW === null) return;
      const payload = { entityId: previous.entityId, available: false, value: null, unit: null, powerW: null, updatedAt: null };
      if (apply(data, payload)) onChange(payload);
    } catch { /* A disconnected source is never a made-up zero. */ } };
    const status = event => { try { const payload = JSON.parse(event.data); if (typeof payload?.configured === 'boolean' && typeof payload?.connected === 'boolean') {
      if (payload.configured && !payload.connected) unavailable(); onStatus(payload);
    } } catch { /* No optimistic state. */ } };
    source.addEventListener('power', power); source.addEventListener('power_status', status); source.addEventListener('error', unavailable);
    return () => { source.removeEventListener('power', power); source.removeEventListener('power_status', status); source.removeEventListener('error', unavailable); };
  }
  global.PowerUpdates = Object.freeze({ apply, connect });
})(globalThis);
