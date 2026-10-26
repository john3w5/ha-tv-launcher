/* Decorative daylight from actual HA data. No network, animation loop or location lookup. */
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const CLOUD_PATH = 'M.035 .66C-.012 .53 .035 .39 .14 .405C.15 .23 .285 .175 .385 .29C.435 .08 .60 .045 .704 .245C.83 .185 .956 .35 .93 .495C1.035 .61 1.008 .805 .86 .88C.70 .965 .55 .91 .385 .94C.25 .97 .12 .91 .075 .81C.025 .8 .005 .745 .035 .66Z';
  let cloudGradientId = 0;
  const MAX_AGE = 5 * 60 * 1000;
  const CONDITIONS = Object.freeze({ sunny: 'clear', partlycloudy: 'partly-cloudy', cloudy: 'cloudy', fog: 'fog', rainy: 'rain', pouring: 'rain', snowy: 'snow', 'snowy-rainy': 'sleet', hail: 'hail', lightning: 'storm', 'lightning-rainy': 'storm', windy: 'wind', 'windy-variant': 'wind' });
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  function numeric(value) {
    if (value && typeof value === 'object') { if (value.available === false) return null; value = value.value ?? value.state; }
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim() || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()))) return null;
    const number = Number(value); return Number.isFinite(number) ? number : null;
  }
  function angle(value, minimum, maximum) { const number = numeric(value); return number !== null && number >= minimum && number <= maximum ? number : null; }
  function instant(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
    const date = Date.parse(value); return Number.isFinite(date) ? date : null;
  }
  function derive(input) {
    const data = input || {}, solar = data.solar || {}, weather = data.weather || {};
    const now = data.now === undefined ? Date.now() : data.now;
    const observed = instant(data.updatedAt);
    const fresh = Number.isFinite(now) && observed !== null && now - observed >= -60000 && now - observed <= MAX_AGE;
    const day = solar.state === 'above_horizon', knownSun = day || solar.state === 'below_horizon';
    const background = data.background || 'soft';
    const allowedBackground = background === 'soft' || background === 'weather';
    let reason = !allowedBackground ? 'user-background' : data.hidden ? 'hidden' : data.mode !== 'live' ? 'not-live' : !fresh ? 'stale' : !knownSun ? 'sun-unknown' : !day ? 'night' : '';
    const active = !reason;
    const rawCondition = typeof weather.condition === 'string' ? weather.condition.trim().toLowerCase() : '';
    let scene = CONDITIONS[rawCondition] || 'unknown', weatherSource = scene !== 'unknown' ? 'condition' : null;
    const rainRate = numeric(weather.rainRate), rainUnit = String(weather.units?.rainRate || '').trim().toLowerCase();
    const rainKnown = rainRate !== null && rainRate >= 0 && ['mm/h', 'mm/hr', 'in/h', 'in/hr'].includes(rainUnit);
    if (rainKnown && rainRate > 0 && !['snow', 'sleet', 'hail', 'storm'].includes(scene)) { scene = 'rain'; weatherSource = 'rain-rate'; }
    // Zero rain cannot distinguish clear skies from an overcast day.
    if (!active) { scene = 'unknown'; weatherSource = null; }
    const elevation = active ? angle(solar.elevation, -90, 90) : null;
    const azimuth = active ? angle(solar.azimuth, 0, 360) : null;
    const visibleSun = active && elevation !== null && elevation >= -1 && azimuth !== null;
    // Orientational east–south–west diagram, not a fabricated sunrise timestamp.
    const sun = visibleSun ? Object.freeze({ x: clamp(8 + (azimuth - 90) / 180 * 84, 4, 96), y: clamp(74 - Math.max(0, elevation) / 90 * 62, 12, 74),
      azimuth, elevation, rising: typeof solar.rising === 'boolean' ? solar.rising : null }) : null;
    return Object.freeze({ active, reason, scene, weatherSource, weatherAvailable: weatherSource !== null, sun,
      theme: data.theme === 'light' || (data.theme === 'auto' && day) ? 'light' : 'dark',
      lowSun: visibleSun && elevation < 12, nextRising: instant(solar.nextRising), nextSetting: instant(solar.nextSetting) });
  }
  function node(document, name, attributes) {
    const element = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, String(value));
    return element;
  }
  function mount(parent) {
    if (!parent?.ownerDocument) throw new TypeError('Weather background needs a DOM container');
    const document = parent.ownerDocument;
    const layer = document.createElement('div'); layer.className = 'weather-background'; layer.setAttribute('aria-hidden', 'true');
    layer.dataset.active = 'false';
    const sky = document.createElement('div'); sky.className = 'weather-background-sky';
    const sun = document.createElement('div'); sun.className = 'weather-background-sun-position';
    const disc = document.createElement('div'); disc.className = 'weather-background-sun'; sun.append(disc);
    const atmosphere = node(document, 'svg', { class: 'weather-background-atmosphere', viewBox: '0 0 1440 810', preserveAspectRatio: 'xMidYMid slice' });
    const gradientId = 'home-tv-weather-cloud-' + ++cloudGradientId;
    const definitions = node(document, 'defs');
    const gradient = node(document, 'linearGradient', { id: gradientId, x1: '0%', y1: '0%', x2: '15%', y2: '100%' });
    gradient.append(node(document, 'stop', { offset: '0%', class: 'weather-cloud-top', 'stop-color': '#ffffff', 'stop-opacity': 77 / 255 }),
      node(document, 'stop', { offset: '100%', class: 'weather-cloud-bottom', 'stop-color': '#d8e5f0', 'stop-opacity': 19 / 255 }));
    definitions.append(gradient);
    const clouds = node(document, 'g', { class: 'weather-background-clouds' });
    clouds.append(node(document, 'path', { d: CLOUD_PATH, transform: 'translate(64.8 129.6) scale(302.4 93.744)', fill: `url(#${gradientId})`, opacity: 67 / 77 }),
      node(document, 'path', { d: CLOUD_PATH, transform: 'translate(1044 113.4) scale(331.2 102.672)', fill: `url(#${gradientId})` }),
      node(document, 'path', { d: CLOUD_PATH, transform: 'translate(705.6 429.3) scale(345.6 107.136)', fill: `url(#${gradientId})`, opacity: 39 / 77, class: 'weather-background-cloud-low' }));
    const rain = node(document, 'g', { class: 'weather-background-rain' });
    for (let index = 0; index < 18; index++) { const x = 40 + index * 83, y = 280 + index % 3 * 180; rain.append(node(document, 'path', { d: 'M' + x + ' ' + y + 'l-20 76' })); }
    const snow = node(document, 'g', { class: 'weather-background-snow' });
    for (let index = 0; index < 22; index++) snow.append(node(document, 'circle', { cx: 33 + index * 67, cy: 290 + index % 5 * 112, r: index % 3 === 0 ? 4 : 2.5 }));
    atmosphere.append(definitions, clouds, rain, snow); layer.append(sky, sun, atmosphere);
    parent.insertBefore(layer, parent.firstChild || null);
    let destroyed = false, last = null, signature = null;
    function update(input) {
      if (destroyed) return last;
      last = derive({ ...input, hidden: input?.hidden === true || document.hidden === true });
      const nextSignature = [last.active,last.reason,last.scene,last.theme,last.lowSun,last.sun?.x,last.sun?.y].join('|');
      if (signature === nextSignature) return last;
      signature = nextSignature;
      layer.dataset.active = String(last.active); layer.dataset.scene = last.scene; layer.dataset.theme = last.theme;
      layer.dataset.lowSun = String(last.lowSun); layer.dataset.sun = String(Boolean(last.sun));
      parent.classList.toggle('has-weather-background', last.active);
      if (last.sun) { sun.style.setProperty('--weather-sun-x', last.sun.x.toFixed(3) + 'vw'); sun.style.setProperty('--weather-sun-y', last.sun.y.toFixed(3) + 'vh'); }
      return last;
    }
    return Object.freeze({ update, getState: () => last, destroy() { if (!destroyed) { destroyed = true; parent.classList.remove('has-weather-background'); layer.remove(); } } });
  }
  global.WeatherBackground = Object.freeze({ derive, mount });
})(globalThis);
