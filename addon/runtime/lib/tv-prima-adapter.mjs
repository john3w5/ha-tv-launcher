import { runAdb } from './tv-control.mjs';
import { resolvePrimaContent } from './prima-content.mjs';

const APP_ID = 'cz.prima.tvapp';
const COMPONENT = /^cz\.prima\.tvapp\/[A-Za-z0-9_.]+$/;
const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,254}$/;
const URL_PATTERN = /^https:\/\/www\.iprima\.cz\/serialy\/zradci\/[a-z0-9-]+\/[a-z0-9-]+$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class PrimaTvAdapterError extends Error {
  constructor(code, message) { super(message); this.name = 'PrimaTvAdapterError'; this.code = code; }
}
function fail(code, message) { throw new PrimaTvAdapterError(code, message); }
function validAction(action) {
  return plain(action) && Object.keys(action).every(key => ['type', 'key', 'appId', 'query', 'selection'].includes(key))
    && action.type === 'search_content' && action.appId === APP_ID && (action.key === undefined || action.key === null)
    && typeof action.query === 'string' && action.query.length > 0 && action.query.length <= 100 && action.selection === 'latest';
}
function signature(action) { return JSON.stringify([action.type, action.appId, action.query, action.selection]); }
function validateUrl(input) {
  if (typeof input !== 'string' || input.length > 1000 || !URL_PATTERN.test(input)) fail('unsafe_content_url', 'Odkaz není ověřenou povolenou stránkou epizody Zrádců.');
  const url = new URL(input);
  if (url.hostname !== 'www.iprima.cz' || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.href !== input) fail('unsafe_content_url', 'Odkaz není povolen pro předání aplikaci.');
  return input;
}
function tvApp(inventory) {
  if (!plain(inventory) || !Number.isInteger(inventory.userId) || inventory.userId < 0 || inventory.userId > 99999 || !Array.isArray(inventory.apps)) fail('invalid_tv_inventory', 'Nepodařilo se ověřit aplikace a uživatele TV.');
  const found = inventory.apps.filter(app => app?.appId === APP_ID);
  if (found.length !== 1 || typeof found[0].component !== 'string' || !COMPONENT.test(found[0].component)) fail('prima_not_available', 'TV aplikace iPrima není jednoznačně dostupná.');
  return { appId: APP_ID, component: found[0].component, userId: inventory.userId };
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

/**
 * preview is read-only. The caller must show the resolved title/episode and
 * obtain the user's confirmation before calling execute. A successful VIEW
 * handoff is not proof that iPrima navigated to, authenticated or played it.
 */
export function createPrimaTvAdapter({ control, adbPath = process.env.ADB_PATH || 'adb', serial = process.env.TV_ADB_SERIAL || '', runner = runAdb, resolve = resolvePrimaContent } = {}) {
  if (!control || typeof control.listApps !== 'function' || typeof runner !== 'function' || typeof resolve !== 'function' || typeof adbPath !== 'string' || !adbPath || /[\u0000\r\n]/.test(adbPath) || typeof serial !== 'string' || !SERIAL.test(serial)) fail('invalid_configuration', 'Neplatná konfigurace adaptéru iPrima.');
  const previews = new WeakMap();
  return {
    async preview(action) {
      if (!validAction(action)) return { supported: false, ready: false, reason: 'Adaptér podporuje jen poslední celý díl Zrádců v ověřené aplikaci iPrima.' };
      const app = tvApp(await control.listApps());
      const resolved = await resolve({ query: action.query, selection: action.selection });
      validateUrl(resolved?.url);
      if (typeof resolved.title !== 'string' || !resolved.title || resolved.title.length > 200 || !plain(resolved.episode) || !Number.isInteger(resolved.episode.season) || resolved.episode.season < 1 || !Number.isInteger(resolved.episode.number) || resolved.episode.number < 1 || resolved.availability?.publishingState !== 'published') fail('content_not_verified', 'Katalog nepotvrdil publikovanou celou epizodu.');
      // Copy only catalog data; the server-owned preview is immutable and must
      // be the same object later consumed by execute, not a client-supplied URL.
      const content = JSON.parse(JSON.stringify({ title: resolved.title, episode: resolved.episode,
        availability: { ...resolved.availability, accountChecked: false },
        evidence: { ...resolved.evidence, deepLinkVerified: false, playbackVerified: false }, url: resolved.url }));
      const preview = freeze({ supported: true, ready: true, content, ...app });
      previews.set(preview, { action: signature(action), expires: Date.now() + 120000, url: content.url, ...app });
      return preview;
    },
    async execute(action, preview) {
      if (!validAction(action) || !plain(preview)) fail('invalid_confirmation', 'Předání epizody nemá platný náhled.');
      const prepared = previews.get(preview);
      if (!prepared || prepared.expires <= Date.now() || prepared.action !== signature(action)) fail('invalid_confirmation', 'Náhled neodpovídá potvrzenému požadavku nebo vypršel.');
      validateUrl(preview.content?.url);
      if (preview.content.url !== prepared.url || preview.component !== prepared.component || preview.userId !== prepared.userId || preview.appId !== prepared.appId) fail('invalid_confirmation', 'Náhled byl změněn.');
      const current = tvApp(await control.listApps());
      if (current.component !== prepared.component || current.userId !== prepared.userId) fail('tv_changed', 'Aplikace nebo aktivní uživatel TV se od potvrzení změnil.');
      previews.delete(preview); // One accepted confirmation can make one handoff attempt.
      let response;
      try {
        response = await runner(adbPath, ['-s', serial, 'shell', 'am', 'start', '-W', '--user', String(current.userId),
          '-a', 'android.intent.action.VIEW', '-c', 'android.intent.category.BROWSABLE', '-n', current.component, '-d', prepared.url],
        { timeoutMs: 15000, maxOutputBytes: 512 * 1024 });
      } catch { fail('handoff_not_confirmed', 'Televize předání odkazu nepotvrdila.'); }
      const output = `${response?.stdout || ''}\n${response?.stderr || ''}`;
      const status = /^\s*Status:\s*(\S+)/im.exec(output)?.[1]?.toLowerCase();
      if (!response || response.code !== 0 || /(?:^|\n)\s*(?:error\b|exception\b|securityexception\b|permission denial\b|java\.[a-z.]*exception\b)/im.test(output) || (status && status !== 'ok')) fail('handoff_not_confirmed', 'Televize předání odkazu nepotvrdila.');
      return { ok: true, accepted: true, appId: APP_ID, component: current.component, userId: current.userId,
        url: prepared.url, title: preview.content.title, episode: preview.content.episode,
        handoffAccepted: true, playbackVerified: false, accountChecked: false,
        message: 'Odkaz na vybranou epizodu byl předán aplikaci iPrima. Přehrávání ani přístup účtu nejsou ověřené.' };
    },
  };
}
