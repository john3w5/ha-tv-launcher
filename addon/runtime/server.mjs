import http from 'node:http';
import { constants as FS, createReadStream } from 'node:fs';
import { readFile, realpath, readdir, stat, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { HomeAssistant, readDashboard } from './lib/home-assistant.mjs';
import { demoDashboard } from './lib/demo.mjs';
import { TvControl } from './lib/tv-control.mjs';
import { createAssistantService } from './lib/assistant-service.mjs';
import { createNativeAssistantService } from './lib/native-assistant-service.mjs';
import { createPrimaTvAdapter } from './lib/tv-prima-adapter.mjs';
import { createPairedSessions } from './lib/paired-sessions.mjs';
import { createHaWebRtcSession } from './lib/webrtc.mjs';
import { normalizeHouseEvents, subscribeHouseEvents } from './lib/house-events.mjs';
import { normalizeHouseholdPanel } from './lib/household-panel.mjs';
import { createNightService } from './lib/night-service.mjs';
import { createNotificationRetries } from './lib/notification-retries.mjs';
import { normalizeDomesticPanel } from './lib/domestic-panel.mjs';
import { createCameraSnapshots } from './lib/camera-snapshots.mjs';
import { createClientSettings } from './lib/client-settings.mjs';
import { createHouseTimeline } from './lib/house-timeline.mjs';
import { createMobilePairing } from './lib/mobile-pairing.mjs';
import { createHomeControls } from './lib/home-controls.mjs';
import { createPowerUpdates } from './lib/power-updates.mjs';
import { createEntranceDoor } from './lib/entrance-door.mjs';
import { createHlsRequest, readHlsPlaylist, pipeHlsMedia, createHlsResources, cancelHlsResponse, HlsProxyError } from './lib/hls-proxy.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  household: 'Domov', publicOrigin: '', allowedOrigins: [], apps: [], calendarDays: 7,
  entities: { weather: {}, calendars: [], cameras: [], mediaPlayers: [], scenes: [], lights: [], locks: [], doors: [] },
  safeScenes: [], allowedMediaHosts: [], allowedStreamHosts: [], photos: { intervalSeconds: 30 },
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.vtt': 'text/vtt', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const PHOTO_UPLOAD_LIMIT = 12 * 1024 * 1024;
const VACUUM_MAP_LIMIT = 8 * 1024 * 1024;
const BUILTIN_APPS = new Set(['relax', 'rodinne-kvizy']);
const MEDIA_TYPES = { video: 'video/mp4', audio: 'audio/mpeg', image: 'image/jpeg', hls: 'application/vnd.apple.mpegurl' };
const MEDIA_MIME = new Set(['video/mp4', 'video/webm', 'video/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/vnd.apple.mpegurl', 'application/x-mpegurl']);
const ENTITY = /^(sensor|weather|calendar|camera|media_player|scene|light|switch|lock|binary_sensor|alarm_control_panel)\.[a-z0-9_]+$/;
const hash = value => createHash('sha256').update(value).digest();
const equal = (left, right) => Boolean(left && right) && timingSafeEqual(hash(String(left)), hash(String(right)));
const opaque = () => randomBytes(24).toString('base64url');
const cleanText = (input, max = 300) => String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function normalizeConfig(input = {}) {
  const config = { ...DEFAULTS, ...input, entities: { ...DEFAULTS.entities, ...(input.entities || {}) }, photos: { ...DEFAULTS.photos, ...(input.photos || {}) } };
  config.householdPanel = normalizeHouseholdPanel(input.householdPanel);
  config.domesticPanel = normalizeDomesticPanel(input.domesticPanel);
  for (const key of ['calendars', 'cameras', 'mediaPlayers', 'scenes', 'lights', 'locks', 'doors']) {
    config.entities[key] = (Array.isArray(config.entities[key]) ? config.entities[key] : []).filter(item => item && ENTITY.test(item.entityId || '')).map(item => ({
      entityId: item.entityId, name: cleanText(item.name || item.entityId, 100),
      ...(item.area ? { area: cleanText(item.area, 100) } : {}),
      ...(key === 'lights' ? { role: item.role === 'controller-status' ? 'controller-status' : 'light-state' } : {}),
      ...(key === 'cameras' ? { id: /^[a-z0-9_-]+$/.test(item.id || '') ? item.id : item.entityId.slice(7) } : {}),
      ...(key === 'cameras' && /^camera\.[a-z0-9_]+$/.test(item.streamEntityId || '') ? { streamEntityId: item.streamEntityId } : {}),
    }));
  }
  config.entities.weather = Object.fromEntries(Object.entries(config.entities.weather || {}).filter(([, id]) => ENTITY.test(id)));
  config.entities.chores = /^calendar\.[a-z0-9_]+$/.test(config.entities.chores?.entityId || '') ? { entityId: config.entities.chores.entityId, name: cleanText(config.entities.chores.name || 'Povinnosti', 100) } : null;
  config.entities.alarm = /^alarm_control_panel\.[a-z0-9_]+$/.test(config.entities.alarm?.entityId || '') ? { entityId: config.entities.alarm.entityId, name: cleanText(config.entities.alarm.name || 'Zabezpečení') } : null;
  for (const key of ['safeScenes', 'allowedMediaHosts', 'allowedStreamHosts', 'allowedOrigins']) config[key] = Array.isArray(config[key]) ? config[key].filter(item => typeof item === 'string') : [];
  config.safeScenes = config.safeScenes.filter(id => /^scene\.[a-z0-9_]+$/.test(id));
  config.calendarDays = Math.max(1, Math.min(31, Number(config.calendarDays) || 7));
  config.photos.intervalSeconds = Math.max(10, Math.min(3600, Number(config.photos.intervalSeconds) || 30));
  config.apps = (Array.isArray(config.apps) ? config.apps : []).filter(app => {
    if (!app || !/^[a-z0-9_-]+$/.test(app.id || '') || typeof app.url !== 'string') return false;
    try {
      if (/[\\\u0000-\u0020\u007f]/.test(app.url)) return false;
      const local = app.url.startsWith('/') && !app.url.startsWith('//');
      const url = new URL(app.url, 'https://home-tv-launcher.invalid');
      if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|password|auth|key/i.test(key))) return false;
      if (local) return url.origin === 'https://home-tv-launcher.invalid' && url.pathname.startsWith('/apps/');
      return /^https?:\/\//i.test(app.url) && ['http:', 'https:'].includes(url.protocol);
    } catch { return false; }
  }).map(app => ({ id: app.id, name: cleanText(app.name || app.id, 100), url: app.url,
    icon: cleanText(app.icon || 'grid', 40), description: cleanText(app.description || '', 200), ...(app.localDirectory ? { localDirectory: String(app.localDirectory) } : {}) }));
  return config;
}

async function readJsonBody(req, limit = 16384) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Je vyžadován JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Požadavek je příliš velký.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, 'Neplatný JSON.'); }
}

async function readPhotoBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new HttpError(415, 'Vyberte fotografii JPEG, PNG nebo WebP.');
  if (Number(req.headers['content-length']) > PHOTO_UPLOAD_LIMIT) throw new HttpError(413, 'Fotografie smí mít nejvýše 12 MiB.');
  const chunks = [];
  let size = 0;
  // Preserve the request long enough to return a readable 413 for chunked uploads.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > PHOTO_UPLOAD_LIMIT) { req.resume(); throw new HttpError(413, 'Fotografie smí mít nejvýše 12 MiB.'); }
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks, size);
  const extension = imageExtension(data);
  const expected = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[type];
  if (!extension || extension !== expected) throw new HttpError(415, 'Obsah souboru neodpovídá podporovanému typu fotografie.');
  return { data, extension };
}

function imageExtension(data) {
  let extension;
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff && data.at(-2) === 0xff && data.at(-1) === 0xd9) extension = '.jpg';
  else if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR' &&
    data.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) extension = '.png';
  else if (data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' &&
    data.readUInt32LE(4) + 8 === data.length && ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16))) extension = '.webp';
  return extension;
}

async function vacuumMapImage(response) {
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType) || !response.body) throw new HttpError(502, 'Mapa není dostupná jako podporovaný obrázek.');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > VACUUM_MAP_LIMIT) { await response.body.cancel().catch(() => {}); throw new HttpError(502, 'Mapa překročila povolenou velikost.'); }
  const reader = response.body.getReader();
  let timer;
  try {
    const read = async () => {
      const chunks = []; let length = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > VACUUM_MAP_LIMIT) throw new HttpError(502, 'Mapa překročila povolenou velikost.');
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks, length);
    };
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new HttpError(504, 'Načtení mapy trvá příliš dlouho.')), 10000); timer.unref?.(); });
    const data = await Promise.race([read(), timeout]);
    const expected = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[contentType];
    if (imageExtension(data) !== expected) throw new HttpError(502, 'Obsah mapy neodpovídá podporovanému obrázku.');
    return { data, contentType };
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function rtcCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].includes(key)) ||
    typeof value.candidate !== 'string' || value.candidate.length > 4096 || /[\u0000\r\n]/.test(value.candidate) ||
    (value.sdpMid != null && (typeof value.sdpMid !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.sdpMid))) ||
    (value.sdpMLineIndex != null && (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0 || value.sdpMLineIndex > 31)) ||
    (value.usernameFragment != null && (typeof value.usernameFragment !== 'string' || !/^[a-zA-Z0-9+/_-]{1,256}$/.test(value.usernameFragment)))) {
    throw new HttpError(400, 'Neplatný ICE kandidát.');
  }
  return { candidate: value.candidate, ...(value.sdpMid !== undefined ? { sdpMid: value.sdpMid } : {}),
    ...(value.sdpMLineIndex !== undefined ? { sdpMLineIndex: value.sdpMLineIndex } : {}),
    ...(value.usernameFragment !== undefined ? { usernameFragment: value.usernameFragment } : {}) };
}

function cameraQuality(camera, input) {
  if (input != null && !['smooth', 'hd'].includes(input)) throw new HttpError(400, 'Neplatná kvalita kamery.');
  const quality = camera.streamEntityId && input !== 'hd' ? 'smooth' : 'hd';
  return { quality, entityId: quality === 'smooth' ? camera.streamEntityId : camera.entityId };
}

function sendJson(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

export async function createBridge(options = {}) {
  const env = options.env || process.env;
  const root = options.root || ROOT;
  const readOnlyPreview = options.readOnlyPreview === true;
  const sessionCookieName = readOnlyPreview ? 'tv_preview_session' : 'tv_session';
  const cookiePrefix = `${sessionCookieName}=`;
  let rawConfig = options.config;
  if (!rawConfig) {
    try { rawConfig = JSON.parse(await readFile(env.CONFIG_PATH || path.join(root, 'config.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Configuration could not be read.'); }
  }
  const config = normalizeConfig(rawConfig);
  const code = env.TV_CLIENT_TOKEN || '';
  const webhookToken = env.TV_WEBHOOK_TOKEN || '';
  const haConfigured = Boolean(env.HA_URL || env.HA_TOKEN);
  const mode = !haConfigured ? 'demo' : env.HA_URL && env.HA_TOKEN && code.length >= 8 && rawConfig ? 'live' : 'setup';
  const ha = mode === 'live' ? options.ha || new HomeAssistant({ url: env.HA_URL, token: env.HA_TOKEN, fetchImpl: options.fetchImpl, websocketClass: options.websocketClass }) : null;
  const fetchImpl = options.fetchImpl || fetch;
  const cameraSnapshots = ha ? createCameraSnapshots({ ...options.cameraSnapshotOptions, load: (entityId, settings) => ha.snapshot(entityId, settings) }) : null;
  const nightService = !readOnlyPreview && mode === 'live' && env.NIGHT_CONTROL_ENABLED === '1'
    ? options.nightService || createNightService({ ha, panelConfig: config.householdPanel }) : null;
  // Persistence must be explicitly configured. Unit-test bridges remain memory-only.
  const sessions = await createPairedSessions({ storePath: options.sessionStorePath ?? (readOnlyPreview ? undefined : env.TV_SESSION_STORE), ttlDays: env.TV_SESSION_DAYS, now: options.sessionNow || Date.now });
  const stateDirectory = !readOnlyPreview && env.TV_SESSION_STORE ? path.dirname(env.TV_SESSION_STORE) : null;
  const clientSettings = await createClientSettings({ storePath: options.clientSettingsStorePath ?? (stateDirectory ? path.join(stateDirectory, 'client-settings.json') : undefined),
    now: options.settingsNow || Date.now, photoIntervalSeconds: config.photos.intervalSeconds });
  const timeline = await createHouseTimeline({ storePath: options.timelineStorePath ?? (stateDirectory ? path.join(stateDirectory, 'house-timeline.json') : undefined), now: options.timelineNow || options.notificationNow || Date.now });
  const mobilePairing = createMobilePairing({ isPaired: session => sessions.has(session), now: options.mobilePairingNow || Date.now, reservedCode: code });
  const homeControls = createHomeControls({ ha, config, enabled: !readOnlyPreview && mode === 'live' });
  const entranceDoor = createEntranceDoor({ ha, config, enabled: !readOnlyPreview && mode === 'live', now: options.doorNow || Date.now });
  const attempts = new Map();
  const notificationRetries = createNotificationRetries({ now: options.notificationNow || Date.now });
  const clients = new Set();
  const streams = new Map();
  const webRtcSessions = new Map();
  const photosDir = path.resolve(env.PHOTO_DIR || path.join(root, 'private', 'photos'));
  const photoUploads = new Map();
  const port = Number(env.PORT || 4317);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  for (const origin of [env.TV_PUBLIC_ORIGIN, config.publicOrigin, ...config.allowedOrigins].filter(Boolean)) {
    try { const url = new URL(origin); if (['http:', 'https:'].includes(url.protocol)) origins.add(url.origin); } catch { throw new Error('Invalid public origin.'); }
  }
  const trustedHosts = new Set([...origins].map(origin => new URL(origin).host));
  const cookieSecure = [env.TV_PUBLIC_ORIGIN, config.publicOrigin].filter(Boolean).some(origin => origin.startsWith('https://'));
  let dashboardCache;
  let dashboardPending;
  const publicApps = config.apps.map(({ localDirectory, ...app }) => app);
  const controlEnabled = !readOnlyPreview && env.TV_CONTROL_ENABLED === '1' && Boolean(env.TV_ADB_SERIAL && env.ADB_PATH);
  const tvControl = controlEnabled ? options.tvControl || new TvControl({ adbPath: env.ADB_PATH, serial: env.TV_ADB_SERIAL }) : null;
  const legacyAssistant = controlEnabled && env.CODEX_PATH ? createAssistantService({
    control: tvControl,
    contentAdapter: createPrimaTvAdapter({ control: tvControl, adbPath: env.ADB_PATH, serial: env.TV_ADB_SERIAL }),
    planner: async input => {
      const { planAssistant } = await import('./lib/assistant-planner.mjs');
      return planAssistant({ ...input, codexPath: env.CODEX_PATH, cwd: root });
    },
  }) : null;
  const assistant = legacyAssistant || (!readOnlyPreview && mode === 'live'
    ? createNativeAssistantService({ ha, readStatus: () => readDashboard(ha, config) }) : null);
  const sessionId = req => String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(cookiePrefix))?.slice(cookiePrefix.length);
  const previewApps = (Array.isArray(options.previewApps) ? options.previewApps : []).filter(app => app &&
    typeof app.appId === 'string' && app.appId.length <= 200 && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(app.appId))
    .slice(0, 256).map(app => ({ appId: app.appId, name: cleanText(app.name || app.appId, 100) }));
  const isAuthorized = req => {
    return sessions.has(sessionId(req));
  };
  const requireAuth = req => { if (!isAuthorized(req)) throw new HttpError(401, 'Nejprve spárujte tuto obrazovku.'); };
  const requireOrigin = req => { if (!origins.has(req.headers.origin)) throw new HttpError(403, 'Původ požadavku není povolen.'); };
  const webhookAuthorized = req => {
    const match = /^Bearer (\S+)$/i.exec(String(req.headers.authorization || ''));
    return Boolean(match && equal(match[1], webhookToken));
  };
  const requireMutation = req => {
    if (webhookAuthorized(req)) { if (req.headers.origin) requireOrigin(req); return; }
    requireAuth(req);
    requireOrigin(req);
  };
  const rtcFactory = options.createWebRtcSession || createHaWebRtcSession;
  function closeWebRtc(entry, reason = 'closed') {
    if (entry.closed) return;
    entry.closed = true;
    clearTimeout(entry.disconnectTimer);
    webRtcSessions.delete(entry.id);
    for (const client of entry.clients) { client.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`); client.end(); }
    entry.clients.clear();
    try { entry.signaling?.close(); } catch { /* Cleanup must not crash the bridge. */ }
  }
  function ownWebRtc(req, id) {
    requireAuth(req);
    if (req.headers.origin) requireOrigin(req);
    const entry = webRtcSessions.get(id);
    if (!entry || !equal(entry.owner, sessionId(req))) throw new HttpError(404, 'Přenos není dostupný.');
    if (entry.expires <= Date.now()) { closeWebRtc(entry, 'expired'); throw new HttpError(404, 'Přenos vypršel.'); }
    entry.expires = Date.now() + 60000;
    return entry;
  }
  const rtcCleanup = setInterval(() => {
    for (const entry of webRtcSessions.values()) if (entry.expires <= Date.now() || !sessions.has(entry.owner)) closeWebRtc(entry, 'expired');
  }, 10000);
  rtcCleanup.unref();
  const broadcast = (type, payload, eventId) => {
    if (type === 'notification_remove') timeline.remove(payload);
    if (['notification', 'doorbell'].includes(type) && !timeline.record(type, eventId ? { ...payload, eventId } : payload)) return false;
    const message = `id: ${Date.now()}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      if (!sessions.has(client.session)) { client.res.end(); clients.delete(client); continue; }
      if (type === 'notification' && !sessions.allowsNotification(client.session, payload)) continue;
      // Close stalled screens so a disconnected TV cannot grow server memory indefinitely.
      if (client.res.writableLength > 262144) { client.res.destroy(); clients.delete(client); continue; }
      client.res.write(message);
    }
    return true;
  };
  const powerUpdates = createPowerUpdates({ entityId: (options.powerUpdatesEnabled ?? ha instanceof HomeAssistant) ? config.domesticPanel.energy.powerEntityId : null,
    now: options.powerNow || Date.now, onUpdate: payload => broadcast('power', payload), onStatus: status => broadcast('power_status', status) });
  let notificationStatus = { source: 'home_assistant', configured: Boolean(ha), connected: false, state: ha ? 'unavailable' : 'not_configured', lastEventAt: null };
  const notificationFeed = ha?.subscribePersistentNotifications?.({
    onNotification: payload => broadcast('notification', payload),
    onRemove: payload => broadcast('notification_remove', payload),
    onStatus: status => { notificationStatus = status; broadcast('ha_notification_status', status); },
  });
  const houseConfig = normalizeHouseEvents(rawConfig?.houseEvents, { cameraIds: config.entities.cameras.map(camera => camera.id) });
  const houseFeed = mode === 'live' && (houseConfig.enabled || powerUpdates.configured) ? options.houseEventsFeed || subscribeHouseEvents({
    url: env.HA_URL, token: env.HA_TOKEN, config: houseConfig, websocketClass: options.websocketClass,
    stateEntityIds: powerUpdates.configured ? [config.domesticPanel.energy.powerEntityId] : [], onState: state => powerUpdates.ingest(state),
    onDoorbell: payload => broadcast('doorbell', { ...payload, source: 'home_assistant' }),
    onNotification: payload => broadcast('notification', payload),
    onStatus: status => { broadcast('ha_house_status', status); powerUpdates.setStatus(status); },
  }) : null;
  const manualDoorbells = new Map();
  const cleanMap = async () => {
    const now = Date.now();
    await sessions.prune();
    mobilePairing.prune();
    for (const [key, value] of streams) if (value.expires < now) streams.delete(key);
    for (const [key, value] of attempts) if (value.reset < now) attempts.delete(key);
  };
  async function photoFiles() {
    let entries;
    try { entries = await readdir(photosDir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return entries.filter(entry => entry.isFile() && PHOTO_EXT.has(path.extname(entry.name).toLowerCase()) && !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 1000).map(entry => ({
      id: hash(entry.name).toString('hex').slice(0, 24), file: path.join(photosDir, entry.name),
    }));
  }
  async function profilePhoto() {
    // The request cannot supply a filename. The fixed private image is never
    // reached through a symbolic link or exposed by an unpaired bootstrap.
    let current = await realpath(root);
    try {
      for (const part of ['private', 'profile']) {
        current = path.join(current, part);
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) return null;
      }
      const filename = path.join(current, 'avatar.png');
      const before = await lstat(filename);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > PHOTO_UPLOAD_LIMIT) return null;
      const handle = await open(filename, FS.O_RDONLY | FS.O_NOFOLLOW);
      let data;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > PHOTO_UPLOAD_LIMIT) return null;
        data = await handle.readFile();
      } finally { await handle.close(); }
      if (data.length > PHOTO_UPLOAD_LIMIT) return null;
      const extension = imageExtension(data);
      return extension ? { data, type: MIME[extension] } : null;
    } catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null; throw error; }
  }
  async function writablePhotoRoot() {
    // Storage inside the project walks from its canonical root, rejecting every
    // symlinked child, even when PHOTO_DIR explicitly names private/photos.
    // An external PHOTO_DIR is anchored in its existing canonical parent.
    const relative = path.relative(path.resolve(root), photosDir);
    const insideRoot = relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
    let current = await realpath(insideRoot ? root : path.dirname(photosDir));
    const parts = insideRoot ? relative.split(path.sep) : [path.basename(photosDir)];
    for (const part of parts) {
      const directory = path.join(current, part);
      let info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) {
        await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        info = await lstat(directory);
      }
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
        throw new HttpError(409, 'Soukromá složka fotografií není bezpečně dostupná.');
      }
      current = directory;
    }
    return current;
  }
  async function savePhoto(data, extension) {
    const filename = `${hash(data).toString('hex')}${extension}`;
    if (photoUploads.has(filename)) return { ...await photoUploads.get(filename), created: false };
    const pending = (async () => {
      const directory = await writablePhotoRoot();
      const destination = path.join(directory, filename);
      let file;
      let created = false;
      try {
        try { file = await open(destination, 'wx', 0o600); created = true; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          // Never follow or overwrite a pre-existing symlink/file. A duplicate
          // is accepted only if its existing bytes and private mode match.
          try { file = await open(destination, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK); }
          catch { throw new HttpError(409, 'Fotografii nelze bezpečně uložit.'); }
          const info = await file.stat();
          if (!info.isFile() || info.nlink !== 1 || info.size !== data.length || (info.mode & 0o777) !== 0o600 ||
            !timingSafeEqual(hash(await file.readFile()), hash(data))) throw new HttpError(409, 'Fotografii nelze bezpečně uložit.');
        }
        if (created) { await file.chmod(0o600); await file.writeFile(data); await file.sync(); }
      } catch (error) {
        if (created) await unlink(destination).catch(() => {});
        throw error;
      } finally { await file?.close(); }
      const id = hash(filename).toString('hex').slice(0, 24);
      return { photo: { id, url: `/api/photos/${id}/file` }, created };
    })();
    photoUploads.set(filename, pending);
    try { return await pending; }
    finally { if (photoUploads.get(filename) === pending) photoUploads.delete(filename); }
  }
  function allowedMedia(input) {
    if (typeof input !== 'string' || input.length > 3000 || /[\u0000-\u001f]/.test(input)) return false;
    if (input.startsWith('/media/') && !input.includes('..') && !input.includes('\\') && !/%2f|%5c|%2e/i.test(input)) return true;
    try {
      const url = new URL(input);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && config.allowedMediaHosts.includes(url.host);
    } catch { return false; }
  }
  function streamUrlAllowed(input) {
    const url = new URL(input);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && (url.origin === ha.base.origin || config.allowedStreamHosts.includes(url.host));
  }
  function registerResource(stream, url, pinned = false) {
    // Android's native HLS source selection requires a playlist suffix. Keep the
    // upstream URL opaque; the alias still resolves only a registered resource.
    const playlist = pinned || new URL(url).pathname.endsWith('.m3u8');
    return `/api/streams/${stream.id}/${stream.resources.register(url, { pinned })}${playlist ? '.m3u8' : ''}`;
  }
  async function serveFile(req, res, base, relative) {
    let decoded;
    try { decoded = decodeURIComponent(relative); } catch { throw new HttpError(400, 'Neplatná cesta.'); }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(segment => segment.startsWith('.'))) throw new HttpError(404, 'Soubor nenalezen.');
    const basePath = await realpath(base).catch(() => null);
    if (!basePath) throw new HttpError(404, 'Soubor nenalezen.');
    let filename = path.resolve(basePath, decoded || 'index.html');
    if (filename !== basePath && !filename.startsWith(`${basePath}${path.sep}`)) throw new HttpError(404, 'Soubor nenalezen.');
    let info = await stat(filename).catch(() => null);
    if (info?.isDirectory()) { filename = path.join(filename, 'index.html'); info = await stat(filename).catch(() => null); }
    const actual = await realpath(filename).catch(() => null);
    if (!info?.isFile() || !actual || !actual.startsWith(`${basePath}${path.sep}`)) throw new HttpError(404, 'Soubor nenalezen.');
    await streamFile(req, res, actual, info);
  }
  async function streamFile(req, res, filename, info) {
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    if (req.headers.range && info.size) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) throw new HttpError(416, 'Neplatný rozsah.');
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (start > end || start >= info.size) { res.setHeader('Content-Range', `bytes */${info.size}`); throw new HttpError(416, 'Neplatný rozsah.'); }
      status = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    res.writeHead(status, { 'Content-Type': MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream', 'Content-Length': Math.max(0, end - start + 1), 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
    const stream = createReadStream(filename, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: http: https:; connect-src 'self'; frame-src 'self' http: https:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    try {
      await cleanMap();
      if (!trustedHosts.has(req.headers.host)) throw new HttpError(403, 'Hostitel není povolen. Nastavte TV_PUBLIC_ORIGIN.');
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (readOnlyPreview && !['GET', 'HEAD'].includes(req.method)) {
        const auth = req.method === 'POST' && ['/api/pair', '/api/logout', '/api/notification-preferences'].includes(pathname);
        const rtcCreate = req.method === 'POST' && /^\/api\/cameras\/[a-z0-9_-]+\/webrtc$/.test(pathname);
        const rtcCandidate = req.method === 'POST' && /^\/api\/webrtc\/[A-Za-z0-9_-]{32}\/candidate$/.test(pathname);
        const rtcCleanup = req.method === 'DELETE' && /^\/api\/webrtc\/[A-Za-z0-9_-]{32}$/.test(pathname);
        if (!auth && !rtcCreate && !rtcCandidate && !rtcCleanup) throw new HttpError(403, 'Tento náhled je pouze pro čtení. Ovládání zařízení je vypnuté.');
      }
      if (req.method === 'GET' && pathname === '/api/bootstrap') {
        const authenticated = isAuthorized(req);
        const photo = authenticated ? await profilePhoto() : null;
        return sendJson(res, 200, {
          mode, authenticated, household: cleanText(config.household, 100), apps: publicApps,
          ...(readOnlyPreview ? { preview: { live: true, readOnly: true } } : {}),
          ...(authenticated ? { profile: photo ? { available: true, url: '/api/profile/photo', name: 'Domácnost' } : { available: false } } : {}),
          photos: config.photos, pairingAvailable: code.length >= 8,
          ...(authenticated ? { notificationPreferences: sessions.notificationPreferences(sessionId(req)) } : {}),
          ...(authenticated ? { clientSettings: clientSettings.get() } : {}),
          ...(authenticated ? { controls: homeControls.capabilities(), mobilePairingAvailable: !readOnlyPreview && mode === 'live' } : {}),
          ...(authenticated ? { doorOpen: entranceDoor.capabilities() } : {}),
          assistant: { available: Boolean(assistant), provider: assistant ? assistant.provider || 'codex' : null, tvControl: controlEnabled,
            ...(assistant?.provider === 'ha-native' ? { nativeCommands: true } : {}) },
          notifications: notificationFeed?.getStatus() || notificationStatus,
          houseEvents: houseFeed?.getStatus() || { configured: false, connected: false, state: 'disabled' },
          powerUpdates: powerUpdates.getStatus(),
        });
      }
      if (['GET', 'HEAD'].includes(req.method) && pathname === '/api/profile/photo') {
        requireAuth(req);
        const photo = await profilePhoto();
        if (!photo) throw new HttpError(404, 'Profilová fotografie není dostupná.');
        res.writeHead(200, { 'Content-Type': photo.type, 'Content-Length': photo.data.length });
        return res.end(req.method === 'HEAD' ? undefined : photo.data);
      }
      if (req.method === 'GET' && pathname === '/api/tv/apps') {
        requireAuth(req);
        if (readOnlyPreview) {
          if (!previewApps.length) throw new HttpError(503, 'Snímek seznamu TV aplikací není pro náhled připravený.');
          return sendJson(res, 200, { userId: 0, apps: previewApps, source: 'approved_snapshot', queriedAt: null, readOnly: true });
        }
        if (!tvControl) throw new HttpError(503, 'Ovládání televize není nastavené.');
        return sendJson(res, 200, await tvControl.listApps());
      }
      if (req.method === 'GET' && pathname === '/api/notifications') {
        requireAuth(req);
        // Active house warnings must remain visible even if HA has many old notes.
        const notes = [...(houseFeed?.getCurrent?.() || []), ...(notificationFeed?.getCurrent?.() || [])].slice(0, 256);
        const notifications = notes.filter(note => note && /^[A-Za-z0-9_-]{1,128}$/.test(note.id || '') && typeof note.message === 'string' && note.message.trim())
          .map(note => ({ id: note.id, title: cleanText(note.title || 'Domov', 120), message: cleanText(note.message, 1000),
            type: ['info', 'warning', 'urgent', 'success'].includes(note.type) ? note.type : 'info', source: 'home_assistant' }));
        return sendJson(res, 200, { notifications, connected: Boolean((notificationFeed?.getStatus() || notificationStatus).connected),
          houseConnected: Boolean(houseFeed?.getStatus().connected) });
      }
      if (req.method === 'GET' && pathname === '/api/timeline') {
        requireAuth(req);
        const requested = url.searchParams.get('limit');
        if (requested !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(requested)) throw new HttpError(400, 'Neplatný rozsah historie.');
        return sendJson(res, 200, timeline.get(requested === null ? 50 : Number(requested)));
      }
      if (['GET', 'PUT'].includes(req.method) && pathname === '/api/client-settings') {
        requireAuth(req);
        if (req.method === 'GET') return sendJson(res, 200, clientSettings.get());
        requireOrigin(req);
        const result = await clientSettings.update(await readJsonBody(req, 2048));
        broadcast('client_settings', result);
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && pathname === '/api/mobile/pairing') {
        requireAuth(req); requireOrigin(req);
        if (mode !== 'live') throw new HttpError(503, 'Párování telefonu vyžaduje živý domácí most.');
        if (Object.keys(await readJsonBody(req, 128)).length) throw new HttpError(400, 'Neplatný požadavek párování telefonu.');
        return sendJson(res, 200, mobilePairing.issue(sessionId(req)));
      }
      if (req.method === 'POST' && pathname === '/api/control') {
        requireAuth(req); requireOrigin(req);
        const result = await homeControls.execute(await readJsonBody(req, 1024));
        dashboardCache = null;
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET' && pathname === '/api/door/status') {
        requireAuth(req);
        if (url.search) throw new HttpError(400, 'Stav dveří nepřijímá vlastní cíle.');
        return sendJson(res, 200, await entranceDoor.status());
      }
      if (req.method === 'POST' && ['/api/door/prepare', '/api/door/commit'].includes(pathname)) {
        requireAuth(req); requireOrigin(req);
        const body = await readJsonBody(req, 1024), keys = Object.keys(body), preparing = pathname.endsWith('/prepare');
        if (preparing ? keys.length !== 1 || keys[0] !== 'cameraId' || body.cameraId !== 'entrance'
          : keys.length !== 1 || keys[0] !== 'confirmationId' || typeof body.confirmationId !== 'string') throw new HttpError(400, 'Neplatný požadavek na vchodové dveře.');
        const result = preparing ? await entranceDoor.prepare({ session: sessionId(req), cameraId: body.cameraId })
          : await entranceDoor.commit({ session: sessionId(req), confirmationId: body.confirmationId });
        if (!preparing) dashboardCache = null;
        return sendJson(res, 200, result);
      }
      if (['GET', 'POST'].includes(req.method) && pathname === '/api/notification-preferences') {
        requireAuth(req);
        if (req.method === 'GET') return sendJson(res, 200, sessions.notificationPreferences(sessionId(req)));
        requireOrigin(req);
        const body = await readJsonBody(req), keys = Object.keys(body);
        const valid = body.action === 'kino' ? typeof body.enabled === 'boolean' && (keys.length === 2 ||
          keys.length === 3 && body.enabled && Number.isSafeInteger(body.minutes) && body.minutes >= 1 && body.minutes <= 1440) && keys.every(key => ['action', 'enabled', 'minutes'].includes(key))
          : ['snooze', 'resume'].includes(body.action) && keys.length === 1;
        if (!valid) throw new HttpError(400, 'Neplatná změna zobrazení oznámení.');
        return sendJson(res, 200, await sessions.setNotificationPreferences(sessionId(req), body));
      }
      if (req.method === 'POST' && ['/api/night/prepare', '/api/night/commit'].includes(pathname)) {
        requireAuth(req); requireOrigin(req);
        if (!nightService) throw new HttpError(503, 'Noční makro není dostupné.');
        const body = await readJsonBody(req);
        const preparing = pathname.endsWith('/prepare');
        const keys = Object.keys(body);
        if (preparing ? keys.length !== 0 : keys.length !== 1 || keys[0] !== 'confirmationId' || typeof body.confirmationId !== 'string') throw new HttpError(400, 'Neplatné potvrzení nočního makra.');
        const result = preparing ? await nightService.prepare({ session: sessionId(req) })
          : await nightService.commit({ session: sessionId(req), confirmationId: body.confirmationId });
        if (!preparing) dashboardCache = null;
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && pathname === '/api/tv/launch') {
        requireAuth(req); requireOrigin(req);
        if (!tvControl) throw new HttpError(503, 'Ovládání televize není nastavené.');
        const body = await readJsonBody(req);
        return sendJson(res, 200, await tvControl.launchApp(body));
      }
      if (req.method === 'POST' && ['/api/assistant', '/api/assistant/confirm'].includes(pathname)) {
        requireAuth(req); requireOrigin(req);
        if (!assistant) throw new HttpError(503, 'Asistent zatím není připojený.');
        const body = await readJsonBody(req);
        if (assistant.provider === 'ha-native') {
          const allowed = pathname.endsWith('/confirm') ? ['confirmationId'] : ['text', 'installedApps'];
          if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, 'Neplatný hlasový povel.');
        }
        const result = pathname.endsWith('/confirm')
          ? await assistant.confirm({ id: body.confirmationId, session: sessionId(req) })
          : await assistant.request({ text: body.text, installedApps: body.installedApps, session: sessionId(req) });
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && pathname === '/api/pair') {
        requireOrigin(req);
        if (code.length < 8) throw new HttpError(503, 'Párování není nakonfigurováno.');
        const key = req.socket.remoteAddress || 'local';
        const attempt = attempts.get(key) || { count: 0, reset: Date.now() + 600000 };
        attempts.set(key, attempt);
        if (attempt.count >= 5) throw new HttpError(429, 'Příliš mnoho pokusů. Zkuste to za 10 minut.');
        const body = await readJsonBody(req);
        if (typeof body.code !== 'string' || Object.keys(body).length !== 1 || (!equal(body.code, code) && !mobilePairing.consume(body.code))) {
          attempt.count++; throw new HttpError(401, 'Nesprávný nebo již neplatný párovací kód.');
        }
        if (sessions.size >= 1024) throw new HttpError(503, 'Byl dosažen limit relací.');
        attempts.delete(key);
        const session = opaque();
        const ttl = sessions.ttlSeconds;
        await sessions.add(session);
        return sendJson(res, 200, { authenticated: true }, { 'Set-Cookie': `${sessionCookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl}${cookieSecure ? '; Secure' : ''}` });
      }
      if (req.method === 'POST' && pathname === '/api/logout') {
        requireAuth(req); requireOrigin(req);
        const id = sessionId(req);
        await sessions.revoke(id);
        mobilePairing.revoke(id);
        for (const client of clients) if (client.session === id) { client.res.end(); clients.delete(client); }
        for (const entry of webRtcSessions.values()) if (equal(entry.owner, id)) closeWebRtc(entry, 'logout');
        return sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (req.method === 'GET' && pathname === '/api/dashboard') {
        if (mode === 'demo') return sendJson(res, 200, demoDashboard());
        requireAuth(req);
        if (mode === 'setup') throw new HttpError(503, 'Doplňte konfiguraci a přihlašovací údaje na serveru.');
        if (!dashboardCache || Date.now() - dashboardCache.created > 5000) {
          dashboardPending ||= readDashboard(ha, config).then(data => { dashboardCache = { data, created: Date.now() }; return data; }).finally(() => { dashboardPending = null; });
          await dashboardPending;
        }
        return sendJson(res, 200, dashboardCache.data);
      }
      if (req.method === 'GET' && pathname === '/api/events') {
        requireAuth(req);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n');
        res.write(`event: ha_notification_status\ndata: ${JSON.stringify(notificationFeed?.getStatus() || notificationStatus)}\n\n`);
        res.write(`event: ha_house_status\ndata: ${JSON.stringify(houseFeed?.getStatus() || { configured: false, connected: false, state: 'disabled' })}\n\n`);
        res.write(`event: power_status\ndata: ${JSON.stringify(powerUpdates.getStatus())}\n\n`);
        if (powerUpdates.configured) res.write(`event: power\ndata: ${JSON.stringify(powerUpdates.getCurrent())}\n\n`);
        const client = { res, session: sessionId(req) };
        if (clients.size >= 64) { res.end(); return; }
        clients.add(client);
        const heartbeat = setInterval(() => {
          if (!isAuthorized(req)) { clearInterval(heartbeat); clients.delete(client); res.end(); }
          else res.write(': heartbeat\n\n');
        }, 20000);
        req.on('close', () => { clearInterval(heartbeat); clients.delete(client); });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/notify') {
        requireMutation(req);
        const body = await readJsonBody(req);
        if (body.eventId !== undefined && (typeof body.eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.eventId))) throw new HttpError(400, 'Neplatné ID události.');
        const payload = { id: opaque(), title: cleanText(body.title || 'Domov', 120), message: cleanText(body.message, 1000),
          type: ['info', 'success', 'warning', 'urgent'].includes(body.type) ? body.type : 'info',
          expiresAt: new Date(Date.now() + Math.max(3, Math.min(120, Number(body.durationSeconds) || 10)) * 1000).toISOString() };
        if (!payload.message) throw new HttpError(400, 'Chybí text notifikace.');
        const retry = notificationRetries.claim(payload, body.eventId);
        if (retry.duplicate) return sendJson(res, 202, { accepted: true, duplicate: true, id: retry.id, screens: 0 });
        const delivered = broadcast('notification', payload, body.eventId);
        return sendJson(res, 202, { accepted: true, ...(delivered ? {} : { duplicate: true }), id: payload.id, screens: delivered ? clients.size : 0 });
      }
      if (req.method === 'POST' && pathname === '/api/doorbell') {
        requireMutation(req);
        if (mode !== 'live') throw new HttpError(503, 'Zvonek není propojený.');
        const body = await readJsonBody(req);
        if (Object.keys(body).some(key => !['cameraId', 'title', 'message'].includes(key)) || typeof body.cameraId !== 'string' ||
          (body.title !== undefined && typeof body.title !== 'string') || (body.message !== undefined && typeof body.message !== 'string')) throw new HttpError(400, 'Neplatný zvonek.');
        const mapping = houseConfig.doorbells.find(rule => rule.cameraId === body.cameraId);
        if (!mapping) throw new HttpError(400, 'Tato kamera není pro zvonek nastavená.');
        const previous = manualDoorbells.get(body.cameraId);
        if (previous && Date.now() - previous < Math.min(mapping.cooldownSeconds, 30) * 1000) throw new HttpError(429, 'Zvonek byl právě zobrazen.');
        const payload = { id: opaque(), title: cleanText(body.title || mapping.title || 'Někdo zvoní', 120),
          message: cleanText(body.message ?? mapping.message, 1000), cameraId: mapping.cameraId, durationSeconds: 15 };
        manualDoorbells.set(body.cameraId, Date.now());
        broadcast('doorbell', payload);
        return sendJson(res, 202, { accepted: true, id: payload.id, screens: clients.size });
      }
      if (req.method === 'POST' && pathname === '/api/media') {
        requireMutation(req);
        const body = await readJsonBody(req);
        if (!allowedMedia(body.url)) throw new HttpError(400, 'Adresa média není povolena.');
        const inputType = String(body.type || 'video').toLowerCase();
        const payload = { url: body.url, type: MEDIA_TYPES[inputType] || (MEDIA_MIME.has(inputType) ? inputType : 'video/mp4'), title: cleanText(body.title || 'Média', 160) };
        broadcast('play', payload);
        return sendJson(res, 202, { accepted: true, screens: clients.size });
      }
      if (req.method === 'POST' && pathname === '/api/action') {
        requireAuth(req); requireOrigin(req);
        if (mode !== 'live') throw new HttpError(503, 'Ovládání je dostupné až po propojení.');
        const body = await readJsonBody(req);
        if (!config.safeScenes.includes(body.entityId) || !config.entities.scenes.some(item => item.entityId === body.entityId)) throw new HttpError(403, 'Tato akce není povolena.');
        await ha.scene(body.entityId);
        dashboardCache = null;
        return sendJson(res, 200, { ok: true, entityId: body.entityId });
      }
      if (req.method === 'POST' && pathname === '/api/photos/upload') {
        requireAuth(req); requireOrigin(req);
        if (mode !== 'live') throw new HttpError(503, 'Fotografie lze nahrávat až po propojení domácího mostu.');
        const { data, extension } = await readPhotoBody(req);
        const saved = await savePhoto(data, extension);
        return sendJson(res, saved.created ? 201 : 200, { photo: saved.photo });
      }
      if (req.method === 'GET' && pathname === '/api/photos') {
        // Demo never exposes private family photographs even if a directory exists.
        if (mode === 'demo') return sendJson(res, 200, []);
        requireAuth(req);
        return sendJson(res, 200, (await photoFiles()).map(file => ({ id: file.id, url: `/api/photos/${file.id}/file` })));
      }
      const photoMatch = /^\/api\/photos\/([a-f0-9]{24})\/file$/.exec(pathname);
      if (photoMatch && ['GET', 'HEAD'].includes(req.method)) {
        requireAuth(req);
        const photo = (await photoFiles()).find(item => item.id === photoMatch[1]);
        if (mode === 'demo' || !photo) throw new HttpError(404, 'Fotografie nenalezena.');
        const actual = await realpath(photo.file);
        const photoRoot = await realpath(photosDir);
        if (!actual.startsWith(`${photoRoot}${path.sep}`)) throw new HttpError(404, 'Fotografie nenalezena.');
        return await streamFile(req, res, actual, await stat(actual));
      }
      const rtcCameraMatch = /^\/api\/cameras\/([a-z0-9_-]+)\/webrtc$/.exec(pathname);
      if (rtcCameraMatch && req.method === 'POST') {
        requireAuth(req); requireOrigin(req);
        if (mode !== 'live') throw new HttpError(503, 'Kamera není propojena.');
        const camera = config.entities.cameras.find(item => item.id === rtcCameraMatch[1]);
        if (!camera) throw new HttpError(404, 'Kamera nenalezena.');
        const body = await readJsonBody(req, 65536);
        if (Object.keys(body).some(key => !['offer', 'quality'].includes(key)) || typeof body.offer !== 'string' ||
          body.offer.length > 60000 || !/^v=0\r?\n/.test(body.offer) || /[\u0000]/.test(body.offer)) throw new HttpError(400, 'Neplatná nabídka přenosu.');
        const { quality, entityId } = cameraQuality(camera, body.quality);
        const owner = sessionId(req);
        if (webRtcSessions.size >= 8 || [...webRtcSessions.values()].filter(entry => equal(entry.owner, owner)).length >= 2) throw new HttpError(429, 'Je otevřeno příliš mnoho přenosů.');
        const entry = { id: opaque(), owner, quality, candidates: [], clients: new Set(), expires: Date.now() + 60000,
          closed: false, signaling: null, initialCandidateCount: 0, disconnectTimer: null, sentCandidates: 0 };
        webRtcSessions.set(entry.id, entry);
        res.on('close', () => { if (!res.writableEnded) closeWebRtc(entry, 'disconnected'); });
        try {
          entry.signaling = await rtcFactory({ url: env.HA_URL, token: env.HA_TOKEN, entityId, offer: body.offer,
            websocketClass: options.websocketClass, timeoutMs: 15000,
            onCandidate: candidate => {
              if (entry.closed) return;
              let safe;
              try { safe = rtcCandidate(candidate); } catch { closeWebRtc(entry, 'failed'); return; }
              if (entry.candidates.length >= 128) { closeWebRtc(entry, 'failed'); return; }
              entry.candidates.push(safe);
              const message = `id: ${entry.candidates.length}\nevent: candidate\ndata: ${JSON.stringify({ candidate: safe })}\n\n`;
              for (const client of entry.clients) {
                if (client.writableLength > 131072) { client.destroy(); continue; }
                client.write(message);
              }
            },
            onClose: () => closeWebRtc(entry, 'ended'),
          });
          if (entry.closed) { entry.signaling.close(); throw new Error('Closed before answer.'); }
          const answer = entry.signaling.answer;
          if (typeof answer !== 'string' || answer.length > 60000 || !/^v=0\r?\n/.test(answer) || /[\u0000]/.test(answer)) throw new Error('Invalid answer.');
          const early = (entry.signaling.candidates || []).map(rtcCandidate);
          if (entry.candidates.length + early.length > 128) throw new Error('Too many ICE candidates.');
          entry.candidates.unshift(...early);
          // Early candidates are returned once; later candidates arrive via SSE.
          entry.initialCandidateCount = entry.candidates.length;
          return sendJson(res, 200, { sessionId: entry.id, answer, candidates: [...entry.candidates], quality });
        } catch {
          closeWebRtc(entry, 'failed');
          throw new HttpError(502, 'Přímý přenos není dostupný.');
        }
      }
      const rtcMatch = /^\/api\/webrtc\/([A-Za-z0-9_-]{32})(?:\/(events|candidate))?$/.exec(pathname);
      if (rtcMatch) {
        const entry = ownWebRtc(req, rtcMatch[1]);
        if (req.method === 'DELETE' && !rtcMatch[2]) {
          requireOrigin(req); closeWebRtc(entry, 'closed'); return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'POST' && rtcMatch[2] === 'candidate') {
          requireOrigin(req);
          const body = await readJsonBody(req);
          if (Object.keys(body).some(key => key !== 'candidate')) throw new HttpError(400, 'Neplatný ICE kandidát.');
          const candidate = rtcCandidate(body.candidate);
          if (!entry.signaling) throw new HttpError(409, 'Přenos se připravuje.');
          if (entry.sentCandidates >= 128) throw new HttpError(429, 'Je odesláno příliš mnoho ICE kandidátů.');
          entry.sentCandidates++;
          try { await entry.signaling.sendCandidate(candidate); }
          catch { closeWebRtc(entry, 'failed'); throw new HttpError(502, 'Přenos není dostupný.'); }
          return sendJson(res, 200, { accepted: true });
        }
        if (req.method === 'GET' && rtcMatch[2] === 'events') {
          if (!entry.signaling) throw new HttpError(409, 'Přenos se připravuje.');
          if (entry.clients.size >= 2) throw new HttpError(429, 'Je otevřeno příliš mnoho přenosů.');
          const lastId = req.headers['last-event-id'];
          if (lastId !== undefined && (!/^\d{1,3}$/.test(lastId) || Number(lastId) > entry.candidates.length)) throw new HttpError(400, 'Neplatné pokračování přenosu.');
          const cursor = lastId === undefined ? entry.initialCandidateCount : Number(lastId);
          clearTimeout(entry.disconnectTimer);
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(': connected\n\n'); entry.clients.add(res);
          for (let index = cursor; index < entry.candidates.length; index++) res.write(`id: ${index + 1}\nevent: candidate\ndata: ${JSON.stringify({ candidate: entry.candidates[index] })}\n\n`);
          const heartbeat = setInterval(() => {
            if (!sessions.has(entry.owner)) { closeWebRtc(entry, 'expired'); return; }
            entry.expires = Date.now() + 60000; res.write(': heartbeat\n\n');
          }, 15000);
          req.on('close', () => {
            clearInterval(heartbeat); entry.clients.delete(res);
            if (!entry.closed && entry.clients.size === 0) {
              entry.disconnectTimer = setTimeout(() => closeWebRtc(entry, 'disconnected'), 5000); entry.disconnectTimer.unref();
            }
          });
          return;
        }
        throw new HttpError(405, 'Metoda není povolena.');
      }
      if (req.method === 'GET' && pathname === '/api/vacuum/map') {
        requireAuth(req);
        if (req.headers.origin) requireOrigin(req);
        if (url.search) throw new HttpError(400, 'Mapa nepřijímá další parametry.');
        if (mode !== 'live' || config.domesticPanel.vacuum.mapEntityId !== 'camera.sample_037') throw new HttpError(503, 'Mapa vysavače není nastavená.');
        const { data, contentType } = await vacuumMapImage(await ha.snapshot('camera.sample_037'));
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
        return res.end(data);
      }
      const cameraMatch = /^\/api\/cameras\/([a-z0-9_-]+)\/(snapshot|stream)$/.exec(pathname);
      if (cameraMatch && req.method === 'GET') {
        requireAuth(req);
        if (mode !== 'live') throw new HttpError(503, 'Kamera není propojena.');
        const camera = config.entities.cameras.find(item => item.id === cameraMatch[1]);
        if (!camera) throw new HttpError(404, 'Kamera nenalezena.');
        if (url.searchParams.getAll('quality').length > 1) throw new HttpError(400, 'Neplatná kvalita kamery.');
        const { quality, entityId } = cameraQuality(camera, url.searchParams.get('quality'));
        if (cameraMatch[2] === 'snapshot') {
          const controller = new AbortController();
          const disconnected = () => { if (!res.writableEnded) controller.abort(); };
          req.once('aborted', disconnected);
          res.once('close', disconnected);
          try {
            const { data, contentType } = await cameraSnapshots.get(entityId, { signal: controller.signal });
            if (res.destroyed || controller.signal.aborted) return;
            res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length, 'X-Camera-Quality': quality });
            res.end(data);
          } catch (error) {
            if (!res.destroyed && !controller.signal.aborted) throw error;
          } finally {
            req.removeListener('aborted', disconnected);
            res.removeListener('close', disconnected);
          }
          return;
        }
        if (streams.size >= 128) throw new HttpError(503, 'Byl dosažen limit streamů.');
        const streamUrl = await ha.cameraStream(entityId);
        const stream = { id: opaque(), resources: createHlsResources({ ...options.hlsResourceOptions, allow: streamUrlAllowed }), expires: Date.now() + 900000 };
        const resource = registerResource(stream, streamUrl, true);
        streams.set(stream.id, stream);
        return sendJson(res, 200, { url: resource, streamType: 'hls', quality });
      }
      const streamMatch = /^\/api\/streams\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:\.m3u8)?$/.exec(pathname);
      if (streamMatch && req.method === 'GET') {
        requireAuth(req);
        const stream = streams.get(streamMatch[1]);
        const resource = stream?.resources.get(streamMatch[2]);
        if (!stream || !resource || mode !== 'live') throw new HttpError(404, 'Stream vypršel.');
        stream.expires = Date.now() + 900000;
        if (!streamUrlAllowed(resource)) throw new HttpError(502, 'Nepovolený stream.');
        const upstream = new URL(resource);
        // Native LL-HLS clients use blocking/delta playlist reloads. Forward only
        // the bounded HLS protocol fields, retaining the registered upstream URL.
        for (const key of new Set(url.searchParams.keys())) {
          const values = url.searchParams.getAll(key);
          const value = values[0];
          const valid = values.length === 1 && (key === '_HLS_msn'
            ? /^\d{1,10}$/.test(value) && Number(value) <= 2147483647
            : key === '_HLS_part' ? /^\d{1,5}$/.test(value) && Number(value) <= 10000
              : key === '_HLS_skip' && ['YES', 'v2'].includes(value));
          if (!valid || !pathname.endsWith('.m3u8')) throw new HttpError(400, 'Neplatné obnovení playlistu.');
          upstream.searchParams.set(key, value);
        }
        const lifecycle = createHlsRequest(req, res, { timeoutMs: options.hlsTimeoutMs ?? 20000 });
        let response;
        try {
          response = await fetchImpl(upstream, { headers: upstream.origin === ha.base.origin ? { Authorization: `Bearer ${env.HA_TOKEN}` } : {}, signal: lifecycle.signal, redirect: 'error' });
          if (!response.ok) throw new HttpError(502, 'Stream není dostupný.');
          const type = response.headers.get('content-type') || '';
          if (/mpegurl/i.test(type) || upstream.pathname.endsWith('.m3u8')) {
            const text = await readHlsPlaylist(response, { signal: lifecycle.signal });
            const rewritten = text.split(/\r?\n/).map(line => {
              if (!line.trim()) return line;
              if (!line.startsWith('#')) return registerResource(stream, new URL(line.trim(), upstream));
              return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${registerResource(stream, new URL(uri, upstream))}"`);
            }).join('\n');
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            res.end(rewritten);
          } else {
            if (!/^(video\/|audio\/|application\/(octet-stream|mp4))/i.test(type) || !response.body) throw new HttpError(502, 'Nepodporovaná část streamu.');
            res.writeHead(200, { 'Content-Type': type.split(';')[0] });
            await pipeHlsMedia(response, res, { signal: lifecycle.signal });
          }
        } catch (error) {
          lifecycle.abort(); cancelHlsResponse(response);
          if (!lifecycle.disconnected && !res.destroyed) throw lifecycle.signal.reason instanceof HlsProxyError ? lifecycle.signal.reason : error;
        } finally { lifecycle.dispose(); }
        return;
      }
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'Rozhraní nenalezeno.');
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Metoda není povolena.');
      if (pathname.startsWith('/apps/')) {
        const [, , appId, ...rest] = pathname.split('/');
        const app = config.apps.find(item => item.id === appId && item.localDirectory);
        if (!app && BUILTIN_APPS.has(appId)) return await serveFile(req, res, path.join(root, 'public', 'apps', appId), rest.join('/'));
        if (!app) throw new HttpError(404, 'Aplikace nenalezena.');
        return await serveFile(req, res, path.resolve(root, app.localDirectory), rest.join('/'));
      }
      if (pathname.startsWith('/media/')) { requireAuth(req); return await serveFile(req, res, path.join(root, 'media'), pathname.slice(7)); }
      await serveFile(req, res, path.join(root, 'public'), pathname.slice(1));
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      // Upstream failures never return server addresses, response bodies, credentials or stream tokens.
      sendJson(res, error.status || 502, { error: error.status ? error.message : 'Spojení se službou není dostupné.' });
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  const closeRtcSessions = () => { clearInterval(rtcCleanup); for (const entry of webRtcSessions.values()) closeWebRtc(entry, 'shutdown'); };
  server.on('close', () => { powerUpdates.close(); cameraSnapshots?.close(); notificationRetries.clear(); closeRtcSessions(); houseFeed?.stop(); notificationFeed?.stop(); for (const client of clients) client.res.end(); clients.clear(); });
  return { server, mode, config, broadcast, notificationStatus: () => notificationFeed?.getStatus() || { ...notificationStatus }, close: () => {
    powerUpdates.close(); cameraSnapshots?.close(); closeRtcSessions(); houseFeed?.stop(); notificationFeed?.stop(); for (const client of clients) client.res.end(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)).then(() => timeline.flush());
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('The .env file could not be read.'); }
  const bridge = await createBridge();
  const port = Number(process.env.PORT || 4317);
  const host = process.env.HOST || '127.0.0.1';
  bridge.server.listen(port, host, () => console.log(`TV bridge ready on ${host}:${port} (${bridge.mode}).`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { bridge.close().finally(() => process.exit(0)); });
}
