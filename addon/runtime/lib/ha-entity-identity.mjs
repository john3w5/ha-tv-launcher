import { createHash } from 'node:crypto';

const FRAME_LIMIT = 5 * 1024 * 1024;
const COMMANDS = new Map([[1, 'config/entity_registry/list'], [2, 'config/device_registry/list'], [3, 'config/area_registry/list']]);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = code => Object.assign(new Error('Identitu zařízení se nepodařilo ověřit.'), { code });
const label = value => typeof value === 'string' && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) && value.trim() ? value.trim() : null;
const opaqueId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/.test(value);
const disabled = value => value != null;

function exact(items, field, id) {
  let result = null;
  for (const item of items) if (plain(item) && item[field] === id) {
    if (result !== null) throw fail('HA_IDENTITY_INVALID_RESPONSE');
    result = item;
  }
  return result;
}

function project(entityId, results) {
  const entity = exact(results.get(1), 'entity_id', entityId);
  if (!entity) throw fail('HA_IDENTITY_NOT_FOUND');
  if (typeof entity.unique_id !== 'string' || entity.unique_id.length < 1 || entity.unique_id.length > 4096 || /[\u0000\r\n]/.test(entity.unique_id) ||
    typeof entity.platform !== 'string' || !/^[a-z0-9_]{1,128}$/.test(entity.platform) ||
    (entity.disabled_by != null && typeof entity.disabled_by !== 'string') ||
    (entity.device_id != null && !opaqueId(entity.device_id)) || (entity.area_id != null && !opaqueId(entity.area_id))) throw fail('HA_IDENTITY_INCOMPLETE');
  const device = entity.device_id ? exact(results.get(2), 'id', entity.device_id) : null;
  if (entity.device_id && !device || device && ((device.disabled_by != null && typeof device.disabled_by !== 'string') || (device.area_id != null && !opaqueId(device.area_id)))) throw fail('HA_IDENTITY_INCOMPLETE');
  const areaId = entity.area_id || device?.area_id;
  const area = areaId ? exact(results.get(3), 'area_id', areaId) : null;
  return {
    entityId,
    identityHash: createHash('sha256').update(entity.unique_id, 'utf8').digest('hex'),
    platform: entity.platform,
    disabled: disabled(entity.disabled_by) || disabled(device?.disabled_by),
    area: label(area?.name),
    manufacturer: label(device?.manufacturer),
    model: label(device?.model),
  };
}

/** Three fixed registry reads. Never returns registry IDs, raw unique_id, state attributes or credentials. */
export function readHaEntityIdentity({ url, token, entityId, websocketClass = globalThis.WebSocket, timeoutMs = 8000 } = {}) {
  let endpoint;
  try {
    if (typeof url !== 'string' || typeof token !== 'string' || !token || token.length > 65536 || !/^[a-z_]+\.[a-z0-9_]+$/.test(entityId || '') || typeof websocketClass !== 'function') throw Error();
    const base = new URL(url.endsWith('/') ? url : `${url}/`);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error();
    endpoint = new URL('api/websocket', base); endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  } catch { return Promise.reject(fail('HA_IDENTITY_CONFIG')); }
  return new Promise((resolve, reject) => {
    let socket, timer, settled = false, authSent = false, authenticated = false;
    const results = new Map();
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); results.clear();
      if (socket) {
        socket.removeEventListener?.('message', onMessage); socket.removeEventListener?.('error', onError); socket.removeEventListener?.('close', onClose);
        try { socket.close(); } catch { /* Closing is best effort and never changes a settled result. */ }
      }
      if (error) reject(error); else resolve(value);
    };
    const send = value => {
      if (settled) return false;
      try { socket.send(JSON.stringify(value)); return true; }
      catch { finish(fail('HA_IDENTITY_TRANSPORT')); return false; }
    };
    const onError = () => finish(fail('HA_IDENTITY_TRANSPORT'));
    const onClose = () => finish(fail('HA_IDENTITY_INCOMPLETE'));
    const onMessage = event => {
      if (settled) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > FRAME_LIMIT || Buffer.byteLength(event.data, 'utf8') > FRAME_LIMIT) throw fail('HA_IDENTITY_TOO_LARGE');
        let message;
        try { message = JSON.parse(event.data); } catch { throw fail('HA_IDENTITY_INVALID_RESPONSE'); }
        if (!plain(message)) throw fail('HA_IDENTITY_INVALID_RESPONSE');
        if (message.type === 'auth_invalid') throw fail('HA_IDENTITY_AUTH');
        if (message.type === 'auth_required' && !authSent && !authenticated) { authSent = true; send({ type: 'auth', access_token: token }); return; }
        if (message.type === 'auth_ok' && authSent && !authenticated) {
          authenticated = true;
          for (const [id, type] of COMMANDS) if (!send({ id, type })) break;
          return;
        }
        if (!authenticated || message.type !== 'result' || !COMMANDS.has(message.id) || results.has(message.id)) throw fail('HA_IDENTITY_INVALID_RESPONSE');
        if (message.success !== true) throw fail('HA_IDENTITY_REJECTED');
        if (!Array.isArray(message.result)) throw fail('HA_IDENTITY_INCOMPLETE');
        results.set(message.id, message.result);
        if (results.size === COMMANDS.size) finish(null, project(entityId, results));
      } catch (error) { finish(error?.code?.startsWith('HA_IDENTITY_') ? error : fail('HA_IDENTITY_INVALID_RESPONSE')); }
    };
    const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.min(30000, Math.max(1, Number(timeoutMs))) : 8000;
    timer = setTimeout(() => finish(fail('HA_IDENTITY_TIMEOUT')), budget);
    try {
      socket = new websocketClass(endpoint);
      socket.addEventListener('message', onMessage); socket.addEventListener('error', onError); socket.addEventListener('close', onClose);
    } catch { finish(fail('HA_IDENTITY_TRANSPORT')); }
  });
}
