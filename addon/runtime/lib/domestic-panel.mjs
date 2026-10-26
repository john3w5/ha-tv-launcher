const entity = (value, domain) => typeof value === 'string' && new RegExp(`^${domain}\\.[a-z0-9_]+$`).test(value) ? value : null;
const text = (value, fallback = '', max = 120) => String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
const available = state => Boolean(state && typeof state.state === 'string' && state.state.trim() && !['unknown', 'unavailable'].includes(state.state) && !state.attributes?.restored);
const numeric = value => typeof value === 'number' ? Number.isFinite(value) ? value : null
  : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
const percent = value => { const result = numeric(value); return result !== null && result >= 0 && result <= 100 ? result : null; };
const iso = value => {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
  const result = Date.parse(value); return Number.isFinite(result) ? new Date(result).toISOString() : null;
};
const sensors = (raw, keys) => Object.fromEntries(keys.map(key => [key, entity(raw?.[key], 'sensor')]));
const slug = value => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/.test(value);
const roomSensorKeys = ['temperatureEntityId', 'humidityEntityId', 'co2EntityId', 'pm25EntityId'];
const unique = (items, key) => { const seen = new Set(); return items.filter(item => { const value = key(item); if (seen.has(value)) return false; seen.add(value); return true; }); };
const equipmentDomains = {
  climate: 'climate', fan: '(fan|switch)', purifier: 'fan', audio: 'media_player', door: 'binary_sensor', window: 'binary_sensor',
  weather: 'weather', status: '(sensor|binary_sensor|input_boolean)', temperature: 'sensor', power: 'sensor', distance: 'sensor',
  level: 'sensor', rain_rate: 'sensor', wind_speed: 'sensor', flow: '(sensor|input_number)',
};
const equipmentUnits = {
  temperature: ['°C', '°F', 'K'], power: ['W', 'kW'], distance: ['m', 'cm', 'mm'], level: ['%'],
  rain_rate: ['mm/h', 'in/h'], wind_speed: ['km/h', 'm/s', 'mph', 'kn'], flow: ['l/h', 'L/h', 'm³/h'],
};
const temperatureUnit = value => ['°C', '°F', 'K'].includes(value) ? value : null;
const list = value => Array.isArray(value) ? value : [];
const normalizePresence = value => unique(list(value).filter(item => slug(item?.id) && entity(item.entityId, 'binary_sensor'))
  .map(item => ({ id: item.id, name: text(item.name, item.id), entityId: item.entityId })), item => item.id).slice(0, 8);
const normalizeEquipment = value => unique(list(value).filter(item => slug(item?.id) && typeof item.kind === 'string' && Object.hasOwn(equipmentDomains, item.kind) && entity(item.entityId, equipmentDomains[item.kind]))
  .map(item => ({ id: item.id, name: text(item.name, item.id), kind: item.kind, entityId: item.entityId, unit: temperatureUnit(item.unit) })), item => item.id).slice(0, 24);

/** Explicit read-only sources. No service IDs, URLs or controls are accepted. */
export function normalizeDomesticPanel(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const legacyAir = unique(list(raw.air?.rooms).filter(item => slug(item?.id)).map(item => ({ id: item.id, name: text(item.name, item.id), ...sensors(item, roomSensorKeys) })), item => item.id).slice(0, 16);
  const rooms = unique(list(raw.rooms).filter(item => slug(item?.id)).map(item => {
    // Old air sources join only by explicit stable ID, never by a similar name.
    const old = legacyAir.find(air => air.id === item.id);
    const metrics = Object.fromEntries(roomSensorKeys.map(key => [key, entity(Object.hasOwn(item, key) ? item[key] : old?.[key], 'sensor')]));
    return { id: item.id, name: text(item.name, item.id), areaId: slug(item.areaId) ? item.areaId : null,
      entityId: entity(item.entityId, 'climate'), ...metrics, presence: normalizePresence(item.presence), equipment: normalizeEquipment(item.equipment),
      heatingPowerEntityId: entity(item.heatingPowerEntityId, 'sensor'), unit: temperatureUnit(item.unit) };
  }).filter(item => item.areaId || item.entityId || item.heatingPowerEntityId || Object.values(sensors(item, roomSensorKeys)).some(Boolean) || item.presence.length || item.equipment.length), item => item.id)
    .filter((item, index, all) => !item.entityId || all.findIndex(other => other.entityId === item.entityId) === index).slice(0, 16);
  return {
    energy: { ...sensors(raw.energy, ['powerEntityId', 'todayEntityId']), consumers: (Array.isArray(raw.energy?.consumers) ? raw.energy.consumers : [])
      .filter(item => slug(item?.id) && entity(item.entityId, 'sensor')).slice(0, 16).map(item => ({ id: item.id, name: text(item.name, item.id), entityId: item.entityId })) },
    water: { ...sensors(raw.water, ['wellVolumeEntityId', 'wellLevelEntityId', 'tankLevelEntityId', 'wellDepthEntityId', 'tankDepthEntityId']),
      valves: (Array.isArray(raw.water?.valves) ? raw.water.valves : []).filter(item => entity(item?.entityId, 'valve')).slice(0, 8).map(item => ({ entityId: item.entityId, name: text(item.name, item.entityId) })) },
    air: { rooms: legacyAir,
      extractionEntityId: entity(raw.air?.extractionEntityId, 'fan') },
    rooms,
    hotWater: sensors(raw.hotWater, ['topEntityId', 'bottomEntityId', 'powerEntityId']),
    washer: sensors(raw.washer, ['jobEntityId', 'machineEntityId', 'completionEntityId', 'progressEntityId', 'energyEntityId', 'waterEntityId', 'powerEntityId']),
    vacuum: { entityId: entity(raw.vacuum?.entityId, 'vacuum'), name: text(raw.vacuum?.name, 'Vysavač'),
      ...sensors(raw.vacuum, ['batteryEntityId', 'cleanedAreaEntityId', 'cleaningTimeEntityId']),
      selections: (Array.isArray(raw.vacuum?.selections) ? raw.vacuum.selections : [])
        .filter(item => slug(item?.id) && entity(item.entityId, 'input_boolean'))
        .slice(0, 5).map(item => ({ id: item.id, name: text(item.name, item.id), entityId: item.entityId })),
      // The fixed audited map camera is the only accepted source for this endpoint.
      mapEntityId: entity(raw.vacuum?.mapEntityId, 'camera') },
  };
}

/** Pure projection of the dashboard's existing state list. Never fetches HA or performs an action. */
export function readDomesticPanel(panelConfig, { states, now = new Date() } = {}) {
  if (!Array.isArray(states) || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Domestic panel requires existing states and a valid date');
  const config = normalizeDomesticPanel(panelConfig), byId = new Map(states.map(state => [state.entity_id, state]));
  const measure = (id, units, range) => {
    const state = byId.get(id), unit = typeof state?.attributes?.unit_of_measurement === 'string' ? text(state.attributes.unit_of_measurement, '', 24) : null;
    let value = available(state) ? numeric(state.state) : null;
    if ((units && !units.includes(unit)) || (range && value !== null && (value < range[0] || value > range[1]))) value = null;
    return { entityId: id, available: value !== null, value, unit, updatedAt: available(state) ? iso(state.last_updated) || iso(state.last_changed) : null };
  };
  const power = id => measure(id, ['W', 'kW']);
  const watts = metric => metric.available ? metric.value * (metric.unit === 'kW' ? 1000 : 1) : null;
  const rawState = id => { const state = byId.get(id), known = available(state); return { entityId: id, available: known, state: known ? text(state.state) : 'unavailable' }; };
  const temperature = id => measure(id, ['°C', '°F', 'K']);
  const energyPower = power(config.energy.powerEntityId), today = measure(config.energy.todayEntityId, ['kWh', 'Wh'], [0, Infinity]);
  const consumers = config.energy.consumers.map(item => { const metric = power(item.entityId); return { id: item.id, name: item.name, power: metric, powerW: watts(metric) }; })
    .sort((a, b) => (b.powerW ?? -Infinity) - (a.powerW ?? -Infinity));
  const water = { wellVolume: measure(config.water.wellVolumeEntityId, ['l', 'L', 'm³'], [0, Infinity]),
    wellLevel: measure(config.water.wellLevelEntityId, ['%'], [0, 100]), tankLevel: measure(config.water.tankLevelEntityId, ['%'], [0, 100]),
    // Raw device distance/depth measurements: do not derive from percent or assumed vessel dimensions.
    wellDepth: measure(config.water.wellDepthEntityId, ['m', 'cm', 'mm'], [0, Infinity]),
    tankDepth: measure(config.water.tankDepthEntityId, ['m', 'cm', 'mm'], [0, Infinity]),
    valves: config.water.valves.map(item => { const state = byId.get(item.entityId), known = available(state) && ['open', 'closed', 'opening', 'closing'].includes(state.state);
      return { ...item, available: known, state: known ? state.state : 'unknown', positionPercent: known ? percent(state.attributes?.current_position) : null }; }) };
  const extraction = byId.get(config.air.extractionEntityId), fanKnown = available(extraction) && ['on', 'off'].includes(extraction.state);
  const roomMetrics = item => ({ temperature: temperature(item.temperatureEntityId), humidity: measure(item.humidityEntityId, ['%'], [0, 100]),
    co2: measure(item.co2EntityId, ['ppm'], [0, Infinity]), pm25: measure(item.pm25EntityId, ['μg/m³', 'µg/m³', 'ug/m3', 'μg/m3', 'µg/m3'], [0, Infinity]) });
  const timestamps = state => ({ updatedAt: available(state) ? iso(state.last_updated) || iso(state.last_changed) : null,
    changedAt: available(state) ? iso(state.last_changed) : null });
  const readClimate = (id, unit) => {
    const state = byId.get(id), known = available(state), attrs = known ? state.attributes || {} : {};
    return { entityId: id, available: known, state: known ? text(state.state) : 'unavailable', ...timestamps(state),
      reportedAction: typeof attrs.hvac_action === 'string' ? text(attrs.hvac_action) : null,
      currentTemperature: numeric(attrs.current_temperature), targetTemperature: numeric(attrs.temperature), targetLow: numeric(attrs.target_temp_low), targetHigh: numeric(attrs.target_temp_high),
      unit: temperatureUnit(attrs.temperature_unit) || unit };
  };
  const readBinary = item => {
    const state = byId.get(item.entityId), known = available(state) && ['on', 'off'].includes(state.state), times = known ? timestamps(state) : { updatedAt: null, changedAt: null };
    const elapsed = times.changedAt ? now.getTime() - Date.parse(times.changedAt) : -1;
    return { ...item, available: known, state: known ? state.state : 'unavailable', active: known ? state.state === 'on' : null, ...times,
      elapsedSeconds: elapsed >= 0 ? Math.floor(elapsed / 1000) : null };
  };
  const readEquipment = item => {
    if (item.kind === 'climate') return { ...item, ...readClimate(item.entityId, item.unit) };
    if (['door', 'window'].includes(item.kind) || item.entityId.startsWith('binary_sensor.') || item.entityId.startsWith('input_boolean.')) return readBinary(item);
    if (Object.hasOwn(equipmentUnits, item.kind)) {
      const metric = measure(item.entityId, equipmentUnits[item.kind], item.kind === 'temperature' ? undefined : [0, item.kind === 'level' ? 100 : Infinity]);
      return { ...item, ...metric };
    }
    const state = byId.get(item.entityId);
    const known = available(state) && (!['fan', 'purifier'].includes(item.kind) || ['on', 'off'].includes(state.state));
    return { ...item, available: known, state: known ? text(state.state) : 'unavailable',
      ...(known ? timestamps(state) : { updatedAt: null, changedAt: null }),
      ...(['fan', 'purifier'].includes(item.kind) ? { active: known ? state.state === 'on' : null, percentage: known ? percent(state.attributes?.percentage) : null } : {}) };
  };
  const rooms = config.rooms.map(item => {
    const climate = readClimate(item.entityId, item.unit), metrics = roomMetrics(item), presence = item.presence.map(readBinary), equipment = item.equipment.map(readEquipment);
    const reportedAction = climate.reportedAction;
    // Loxone's hvac_action can describe a regulator's requested mode while its
    // physical output is zero. Only an explicitly mapped heater power meter is
    // evidence that this room's heating is running; unavailable is never off.
    const heatingPower = power(item.heatingPowerEntityId), measuredWatts = watts(heatingPower);
    const heatingWatts = measuredWatts !== null && measuredWatts >= 0 ? measuredWatts : null;
    const heatingActive = heatingWatts === null ? null : heatingWatts > 0;
    const heatingLabel = heatingActive === true ? 'Topí' : heatingActive === false ? 'Netopí'
      : ({ heating: 'Režim vytápění', cooling: 'Režim chlazení', idle: 'Regulátor v klidu', off: 'Regulátor vypnutý' }[reportedAction] || 'Neověřeno');
    // Climate currentTemperature remains separate from the dashboard's explicit
    // temperature sensor. An unavailable mapped sensor must never fall back.
    return { ...item, ...climate, climate, ...metrics, presence, equipment,
      available: climate.available || heatingWatts !== null || Object.values(metrics).some(metric => metric.available) || presence.some(value => value.available) || equipment.some(value => value.available),
      action: heatingActive === null ? null : heatingActive ? 'heating' : 'idle', heatingActive, heatingLabel,
      heatingEvidence: { kind: item.heatingPowerEntityId ? 'measured_power' : 'unverified', entityId: item.heatingPowerEntityId,
        available: heatingWatts !== null, powerW: heatingWatts, updatedAt: heatingWatts !== null ? heatingPower.updatedAt : null },
    };
  });
  // Compatibility view only. Native clients consume rooms[] directly. Keep
  // unmatched old air-only rows, but never create or merge a room by its name.
  const airRooms = [...config.air.rooms.filter(item => !rooms.some(room => room.id === item.id)).map(item => ({ id: item.id, name: item.name, ...roomMetrics(item) })),
    ...rooms.map(room => ({ id: room.id, name: room.name, temperature: room.temperature, humidity: room.humidity, co2: room.co2, pm25: room.pm25 }))];
  const air = { rooms: airRooms, extraction: { entityId: config.air.extractionEntityId, name: 'Odtah v koupelně', available: fanKnown,
    state: fanKnown ? extraction.state : 'unknown', percentage: fanKnown ? percent(extraction.attributes?.percentage) : null } };
  const hotWater = { top: temperature(config.hotWater.topEntityId), bottom: temperature(config.hotWater.bottomEntityId), power: power(config.hotWater.powerEntityId) };
  const job = rawState(config.washer.jobEntityId), machine = rawState(config.washer.machineEntityId), completion = byId.get(config.washer.completionEntityId);
  const running = machine.available && machine.state === 'run';
  const estimatedCompletion = running && available(completion) ? iso(completion.state) : null;
  const remainingSeconds = running && estimatedCompletion && Date.parse(estimatedCompletion) > now.getTime() ? Math.ceil((Date.parse(estimatedCompletion) - now.getTime()) / 1000) : null;
  const washer = { available: job.available && machine.available, job, machine, running, estimatedCompletion, completionAvailable: estimatedCompletion !== null,
    remainingSeconds, progressPercent: measure(config.washer.progressEntityId, ['%'], [0, 100]).value, energy: measure(config.washer.energyEntityId, ['kWh', 'Wh'], [0, Infinity]),
    water: measure(config.washer.waterEntityId, ['L', 'l', 'm³'], [0, Infinity]), power: power(config.washer.powerEntityId) };
  const vacuumState = rawState(config.vacuum.entityId), mapState = byId.get(config.vacuum.mapEntityId), mapKnown = available(mapState);
  const dimensions = key => { const result = numeric(mapState?.attributes?.[key]); return mapKnown && Number.isInteger(result) && result > 0 && result <= 16384 ? result : null; };
  const battery = measure(config.vacuum.batteryEntityId, ['%'], [0, 100]);
  const vacuum = { ...vacuumState, name: config.vacuum.name, batteryPercent: vacuumState.available ? battery.available ? battery.value : percent(byId.get(config.vacuum.entityId)?.attributes?.battery_level) : null, progressPercent: null,
    cleanedArea: measure(config.vacuum.cleanedAreaEntityId, ['m²', '㎡'], [0, Infinity]), cleaningTime: measure(config.vacuum.cleaningTimeEntityId, ['min', 's'], [0, Infinity]),
    map: { available: mapKnown, url: mapKnown ? '/api/vacuum/map' : null, lastUpdated: mapKnown ? iso(mapState.attributes?.last_map_update) : null,
      lastRefreshOk: mapKnown && typeof mapState.attributes?.last_refresh_ok === 'boolean' ? mapState.attributes.last_refresh_ok : null,
      width: dimensions('map_width'), height: dimensions('map_height') },
    selections: config.vacuum.selections.map(item => { const state = byId.get(item.entityId), known = available(state) && ['on', 'off'].includes(state.state);
      return { id: item.id, name: item.name, available: known, selected: known ? state.state === 'on' : null }; }), controlsAvailable: false };
  const configured = Boolean(config.energy.powerEntityId || config.energy.todayEntityId || config.energy.consumers.length || config.rooms.length ||
    config.water.wellVolumeEntityId || config.water.wellLevelEntityId || config.water.tankLevelEntityId || config.water.wellDepthEntityId || config.water.tankDepthEntityId || config.water.valves.length ||
    config.vacuum.entityId || config.vacuum.mapEntityId || Object.values(config.washer).some(Boolean) || Object.values(config.hotWater).some(Boolean) || config.air.rooms.length || config.air.extractionEntityId);
  return { configured, roomsContractVersion: 2, updatedAt: now.toISOString(), energy: { power: energyPower, powerW: watts(energyPower), today,
    todayKWh: today.available ? today.value / (today.unit === 'Wh' ? 1000 : 1) : null, consumers }, water, air, rooms, hotWater, washer, vacuum };
}
