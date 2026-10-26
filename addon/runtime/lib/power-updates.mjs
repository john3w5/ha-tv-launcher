const numeric = input => typeof input === 'number' && Number.isFinite(input) ? input
  : typeof input === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(input.trim()) && Number.isFinite(Number(input)) ? Number(input) : null;
const timestamp = input => typeof input === 'string' && Number.isFinite(Date.parse(input)) ? new Date(input).toISOString() : null;

/** Reuses the existing HA state stream; latest source value wins, at most 1 Hz. */
export function createPowerUpdates({ entityId, onUpdate = () => {}, onStatus = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const configured = typeof entityId === 'string' && /^sensor\.[a-z0-9_]+$/.test(entityId);
  const missing = () => ({ entityId: configured ? entityId : null, available: false, value: null, unit: null, powerW: null, updatedAt: null });
  let latest = missing(), connected = false, closed = false, timer = null, lastSent = -Infinity, fingerprint = '';
  let status = { configured, connected: false, state: configured ? 'connecting' : 'not_configured' };
  const getCurrent = () => ({ ...(connected ? latest : missing()) });
  const emit = () => {
    timer = null; if (closed || !configured) return;
    const value = getCurrent(), next = JSON.stringify(value);
    if (next === fingerprint) return;
    const delay = 1000 - (now() - lastSent);
    if (delay > 0) { timer = setTimer(emit, delay); timer?.unref?.(); return; }
    lastSent = now(); fingerprint = next;
    try { onUpdate(value); } catch { /* Consumers cannot break HA transport. */ }
  };
  const push = () => { if (!timer) emit(); };
  return {
    configured,
    ingest(state) {
      if (!configured || closed || state?.entity_id !== entityId) return;
      const unit = ['W', 'kW'].includes(state.attributes?.unit_of_measurement) ? state.attributes.unit_of_measurement : null;
      const value = !state.attributes?.restored && !['unknown', 'unavailable'].includes(state.state) && unit ? numeric(state.state) : null;
      const powerW = value === null ? null : value * (unit === 'kW' ? 1000 : 1), valid = powerW !== null && Number.isFinite(powerW);
      latest = { entityId, available: valid, value: valid ? value : null, unit, powerW: valid ? powerW : null,
        updatedAt: timestamp(state.last_updated) || timestamp(state.last_changed) };
      if (connected) push();
    },
    setStatus(value) {
      if (!configured || closed) return;
      connected = value?.connected === true;
      const next = { configured, connected, state: connected ? 'connected' : ['connecting', 'reconnecting', 'authentication_failed', 'stopped', 'unavailable'].includes(value?.state) ? value.state : 'unavailable' };
      if (JSON.stringify(next) !== JSON.stringify(status)) { status = next; try { onStatus({ ...status }); } catch { /* Consumer only. */ } }
      if (!connected) latest = missing();
      push();
    },
    getCurrent, getStatus: () => ({ ...status }),
    close() { closed = true; if (timer) clearTimer(timer); timer = null; },
  };
}
