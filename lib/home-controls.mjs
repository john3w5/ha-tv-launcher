const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const available = state => plain(state) && typeof state.state === 'string' && state.state.trim() &&
  !['unknown', 'unavailable'].includes(state.state) && !state.attributes?.restored;
const error = (status, message) => Object.assign(Error(message), { status });

/** Explicit product button actions only. No arbitrary domain/service/mode/lock. */
export function createHomeControls({ ha, config, enabled = true } = {}) {
  const lights = new Map((config?.entities?.lights || []).filter(item => item.role === 'light-state' && /^(light|switch)\.[a-z0-9_]+$/.test(item.entityId))
    .map(item => [item.entityId, { id: item.entityId, name: item.name }]));
  const temperatures = new Map((config?.domesticPanel?.rooms || []).filter(item => /^[a-z0-9_-]{1,64}$/.test(item.id) && /^climate\.[a-z0-9_]+$/.test(item.entityId))
    .map(item => [item.id, { id: item.id, name: item.name, entityId: item.entityId }]));
  const busy = new Set();
  return {
    capabilities() {
      return { available: Boolean(enabled && ha), lights: [...lights.values()].map(item => ({ ...item })),
        temperatures: [...temperatures.values()].map(({ id, name }) => ({ id, name, deltas: [-0.5, 0.5] })), freshValidation: true };
    },
    async execute(body) {
      if (!enabled || !ha) throw error(503, 'Ovládání domu není dostupné.');
      if (!plain(body)) throw error(400, 'Neplatný povel ovládání domu.');
      const keys = Object.keys(body).sort().join(',');
      const isLight = body.type === 'light' && keys === 'id,on,type' && typeof body.on === 'boolean' && lights.has(body.id);
      const isTemperature = body.type === 'temperature' && keys === 'delta,id,type' && [-0.5, 0.5].includes(body.delta) && temperatures.has(body.id);
      if (!isLight && !isTemperature) throw error(400, 'Tento povel ovládání domu není povolený.');
      const entityId = isLight ? body.id : temperatures.get(body.id).entityId;
      if (busy.has(entityId)) throw error(409, 'Předchozí změna ještě probíhá.');
      busy.add(entityId);
      try {
        const state = await ha.request(`api/states/${entityId}`);
        if (!available(state) || state.entity_id !== entityId) throw error(409, 'Aktuální stav zařízení není ověřený.');
        if (isLight) {
          if (!['on', 'off'].includes(state.state)) throw error(409, 'Aktuální stav světla není ověřený.');
          const domain = entityId.split('.')[0];
          await ha.request(`api/services/${domain}/${body.on ? 'turn_on' : 'turn_off'}`, { method: 'POST', body: { entity_id: entityId } });
          return { accepted: true, type: 'light', id: body.id, requested: { on: body.on }, verified: false, refreshRequired: true };
        }
        const attrs = state.attributes || {}, current = number(attrs.temperature), min = number(attrs.min_temp), max = number(attrs.max_temp);
        // A missing scalar target (for example an automatic comfort range) is
        // intentionally read-only; never choose a guessed side of that range.
        if (current === null || min === null || max === null || min >= max || current < min || current > max) throw error(409, 'Teplota nebo povolený rozsah regulátoru nejsou ověřené.');
        if (!Number.isSafeInteger(attrs.supported_features) || !(attrs.supported_features & 1)) throw error(409, 'Regulátor nemá ověřené nastavení cílové teploty.');
        const requested = Math.round((current + body.delta) * 1000) / 1000;
        if (requested < min || requested > max) throw error(409, 'Změna by překročila povolený rozsah teploty.');
        const step = number(attrs.target_temp_step);
        if (step === null || step <= 0 || Math.abs(body.delta / step - Math.round(body.delta / step)) > 0.000001) throw error(409, 'Regulátor nemá ověřenou změnu po půl stupni.');
        await ha.request('api/services/climate/set_temperature', { method: 'POST', body: { entity_id: entityId, temperature: requested } });
        return { accepted: true, type: 'temperature', id: body.id, requested: { temperature: requested }, verified: false, refreshRequired: true };
      } finally { busy.delete(entityId); }
    },
  };
}
