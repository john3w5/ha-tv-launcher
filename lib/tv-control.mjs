import { spawn } from 'node:child_process';

export const TV_KEYS = Object.freeze({ up: 19, down: 20, left: 21, right: 22, ok: 23, back: 4, home: 3,
  volume_up: 24, volume_down: 25, mute: 164, play_pause: 85, play: 126, pause: 127, wake: 224, sleep: 223 });
const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,254}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const COMPONENT = /^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\/[A-Za-z0-9_.]+$/;
const KNOWN_APPS = Object.freeze({
  youtube: { name: 'YouTube', packages: ['com.google.android.youtube.tv', 'com.google.android.youtube'] },
  netflix: { name: 'Netflix', packages: ['com.netflix.ninja', 'com.netflix.mediaclient'] },
  plex: { name: 'Plex', packages: ['com.plexapp.android'] },
  spotify: { name: 'Spotify', packages: ['com.spotify.tv.android', 'com.spotify.music'] },
  prima: { name: 'prima+', packages: ['cz.prima.tvapp', 'cz.iprima.app'] },
  domov: { name: 'Domov TV', packages: ['org.hometv.launcher'] },
});

export class TvControlError extends Error {
  constructor(code, message) { super(message); this.name = 'TvControlError'; this.code = code; }
}

export function runAdb(executable, args, { timeoutMs = 10000, maxOutputBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let failure;
    const timeout = setTimeout(() => { failure = new TvControlError('adb_timeout', 'Televize neodpověděla v časovém limitu.'); process.kill('SIGKILL'); }, timeoutMs);
    for (const name of ['stdout', 'stderr']) process[name].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { failure = new TvControlError('adb_output_limit', 'Odpověď televize překročila bezpečný limit.'); process.kill('SIGKILL'); }
      else chunks[name].push(chunk);
    });
    process.once('error', () => { clearTimeout(timeout); reject(new TvControlError('adb_unavailable', 'ADB se nepodařilo spustit.')); });
    process.once('close', code => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') });
    });
  });
}

function checkArguments(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !(key in value))) {
    throw new TvControlError('invalid_arguments', 'Neplatné parametry ovládání TV.');
  }
}
function parseComponents(output) {
  return [...new Set(output.split(/\r?\n/).map(line => line.trim()).filter(line => COMPONENT.test(line)))];
}
function foregroundComponent(output) {
  for (const line of output.split(/\r?\n/).filter(line => /mResumedActivity|topResumedActivity|mCurrentFocus/.test(line))) {
    const component = line.split(/\s+/).map(word => word.replace(/[},]$/, '')).find(word => COMPONENT.test(word));
    if (component) return component;
  }
  return null;
}
const normalizedText = input => input.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export class TvControl {
  #adbPath; #serial; #runner; #timeoutMs; #aliases;
  constructor({ adbPath = process.env.ADB_PATH || 'adb', serial = process.env.TV_ADB_SERIAL || '', runner = runAdb, timeoutMs = 10000, appAliases = {} } = {}) {
    if (typeof adbPath !== 'string' || !adbPath || /[\u0000\r\n]/.test(adbPath) || typeof serial !== 'string' || !SERIAL.test(serial)) throw new TvControlError('invalid_configuration', 'Neplatná konfigurace ADB.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000 || typeof runner !== 'function') throw new TvControlError('invalid_configuration', 'Neplatná konfigurace ovládání TV.');
    for (const [alias, appId] of Object.entries(appAliases)) if (!Object.hasOwn(KNOWN_APPS, alias) || !PACKAGE.test(appId)) throw new TvControlError('invalid_configuration', 'Neplatné mapování aplikací TV.');
    this.#adbPath = adbPath; this.#serial = serial; this.#runner = runner; this.#timeoutMs = timeoutMs; this.#aliases = appAliases;
  }

  async #shell(parts) {
    // Every caller constructs one of these read/control commands. No user text,
    // URI, component, package or key reaches ADB without validation below.
    const result = await this.#runner(this.#adbPath, ['-s', this.#serial, 'shell', ...parts], { timeoutMs: this.#timeoutMs, maxOutputBytes: 4 * 1024 * 1024 });
    if (!result || result.code !== 0 || /(?:^|\n)\s*(?:error:|exception|permission denial|java\.[a-z.]*exception)/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new TvControlError('adb_command_failed', 'Televize požadavek nepotvrdila. Ověřte připojení a oprávnění ADB.');
    }
    return String(result.stdout || '').trim();
  }
  async #user() {
    const value = await this.#shell(['am', 'get-current-user']);
    if (!/^\d{1,5}$/.test(value)) throw new TvControlError('invalid_tv_response', 'Nepodařilo se určit aktuálního uživatele TV.');
    return Number(value);
  }

  async status() {
    const [model, sdk, userId, activities] = await Promise.all([
      this.#shell(['getprop', 'ro.product.model']), this.#shell(['getprop', 'ro.build.version.sdk']),
      this.#user(), this.#shell(['dumpsys', 'activity', 'activities']),
    ]);
    const home = parseComponents(await this.#shell(['cmd', 'package', 'resolve-activity', '--brief', '--user', String(userId), '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME']));
    return { connected: true, model: model.slice(0, 200) || null, sdk: /^\d+$/.test(sdk) ? Number(sdk) : null, userId,
      homeComponent: home.length === 1 && !home[0].startsWith('android/') ? home[0] : null,
      currentActivity: foregroundComponent(activities), checkedAt: new Date().toISOString() };
  }

  async listApps() {
    const userId = await this.#user();
    const intent = ['--brief', '--user', String(userId), '-a', 'android.intent.action.MAIN', '-c'];
    const [installedOutput, leanbackOutput, launcherOutput] = await Promise.all([
      this.#shell(['pm', 'list', 'packages', '--user', String(userId)]),
      this.#shell(['cmd', 'package', 'query-activities', ...intent, 'android.intent.category.LEANBACK_LAUNCHER']),
      this.#shell(['cmd', 'package', 'query-activities', ...intent, 'android.intent.category.LAUNCHER']),
    ]);
    const installed = new Set(installedOutput.split(/\r?\n/).filter(line => line.startsWith('package:')).map(line => line.slice(8).trim()).filter(id => PACKAGE.test(id)));
    const apps = new Map();
    for (const [output, kind] of [[leanbackOutput, 'tv'], [launcherOutput, 'launcher']]) for (const component of parseComponents(output)) {
      const appId = component.split('/')[0];
      if (!installed.has(appId)) continue;
      if (!apps.has(appId)) apps.set(appId, { appId, name: appId, component, components: [], kind, aliases: [] });
      if (!apps.get(appId).components.includes(component)) apps.get(appId).components.push(component);
    }
    for (const [alias, definition] of Object.entries(KNOWN_APPS)) {
      const candidates = this.#aliases[alias] ? [this.#aliases[alias]] : definition.packages;
      const found = candidates.map(id => apps.get(id)).filter(Boolean);
      // Prefer an explicitly mapped package, otherwise a single installed TV variant.
      const selected = found.length === 1 ? found[0] : found.filter(app => app.kind === 'tv').length === 1 ? found.find(app => app.kind === 'tv') : null;
      if (selected) { selected.name = definition.name; selected.aliases.push(alias); }
    }
    return { userId, apps: [...apps.values()].sort((a, b) => a.name.localeCompare(b.name)), queriedAt: new Date().toISOString() };
  }

  async key(arguments_ = {}) {
    checkArguments(arguments_, ['key', 'count'], ['key']);
    const { key, count = 1 } = arguments_;
    if (typeof key !== 'string' || !Object.hasOwn(TV_KEYS, key) || !Number.isInteger(count) || count < 1 || count > 10) throw new TvControlError('invalid_arguments', 'Povolena je známá TV klávesa a počet 1 až 10.');
    await this.#shell(['input', 'keyevent', ...Array(count).fill(String(TV_KEYS[key]))]);
    return { ok: true, accepted: true, key, count, verifiedScreen: false };
  }

  async launchApp(arguments_ = {}) {
    checkArguments(arguments_, ['appId'], ['appId']);
    const { appId } = arguments_;
    if (typeof appId !== 'string' || !PACKAGE.test(appId)) throw new TvControlError('invalid_arguments', 'Je vyžadováno platné ID nainstalované aplikace.');
    const inventory = await this.listApps();
    const app = inventory.apps.find(item => item.appId === appId);
    if (!app || !COMPONENT.test(app.component)) throw new TvControlError('app_not_available', 'Aplikace není mezi aktuálně dostupnými spustitelnými aplikacemi TV.');
    await this.#shell(['am', 'start', '--user', String(inventory.userId), '-n', app.component]);
    return { ok: true, accepted: true, appId, component: app.component, name: app.name, verifiedForeground: false };
  }

  async voiceCommand(arguments_ = {}) {
    checkArguments(arguments_, ['text'], ['text']);
    if (typeof arguments_.text !== 'string' || arguments_.text.length < 1 || arguments_.text.length > 300) throw new TvControlError('invalid_arguments', 'Příkaz musí být text o délce 1 až 300 znaků.');
    let text = normalizedText(arguments_.text);
    let count = 1;
    const repetitions = /^(.*?)\s+(10|[1-9])(?:\s*(?:x|krat))?$/.exec(text);
    if (repetitions) { text = repetitions[1]; count = Number(repetitions[2]); }
    const keys = {
      nahoru: 'up', dolu: 'down', doleva: 'left', vlevo: 'left', doprava: 'right', vpravo: 'right',
      ok: 'ok', potvrd: 'ok', potvrdit: 'ok', zpet: 'back', domu: 'home', 'domovska obrazovka': 'home',
      hlasiteji: 'volume_up', 'zvys hlasitost': 'volume_up', 'pridej hlasitost': 'volume_up',
      tiseji: 'volume_down', ztlum: 'volume_down', 'sniz hlasitost': 'volume_down',
      mute: 'mute', 'ztlum zvuk': 'mute', 'prepni ztlumeni': 'mute',
      pauza: 'pause', pozastav: 'pause', 'pozastav prehravani': 'pause',
      prehraj: 'play', pokracuj: 'play', 'pokracuj v prehravani': 'play', 'prepni prehravani': 'play_pause',
      'zapni televizi': 'wake', 'zapni tv': 'wake', 'probud televizi': 'wake',
      'vypni televizi': 'sleep', 'vypni tv': 'sleep', 'uspi televizi': 'sleep',
    };
    if (Object.hasOwn(keys, text)) return { supported: true, executed: true, action: 'key', result: await this.key({ key: keys[text], count }) };
    const appPhrase = /^(?:pust|spust|otevri)(?: aplikaci)? (youtube|you tube|netflix|plex|spotify|iprima|i prima|prima plus|prima|domov tv)$/.exec(text);
    if (appPhrase && count === 1) {
      const alias = ({ 'you tube': 'youtube', iprima: 'prima', 'i prima': 'prima', 'prima plus': 'prima', 'domov tv': 'domov' })[appPhrase[1]] || appPhrase[1];
      const inventory = await this.listApps();
      const app = inventory.apps.find(item => item.aliases.includes(alias));
      if (!app) return { supported: false, executed: false, reason: 'Požadovaná aplikace není jednoznačně ověřená mezi nainstalovanými TV aplikacemi.', requestedAlias: alias };
      return { supported: true, executed: true, action: 'launch_app', result: await this.launchApp({ appId: app.appId }) };
    }
    return { supported: false, executed: false, reason: /posledni|\bdil\b|epizod|zradc/.test(text)
      ? 'Spuštění konkrétního pořadu nebo poslední epizody zde není implementované; žádná akce se neprovedla.'
      : 'Nerozpoznaný příkaz. Podporované jsou jednotlivé klávesy, hlasitost, přehrávání a otevření ověřené aplikace.' };
  }
}
