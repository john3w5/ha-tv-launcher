import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/weather-background.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/weather-background.css', import.meta.url), 'utf8');
const sandbox = {};
vm.runInNewContext(source, sandbox);
const { derive } = sandbox.WeatherBackground;
const NOW = Date.parse('2026-10-24T10:00:00Z');
const daytime = changes => ({ mode: 'live', updatedAt: '2026-10-24T10:00:00Z', now: NOW, background: 'soft', theme: 'light', weather: {}, solar: { state: 'above_horizon', elevation: 30, azimuth: 180, rising: true }, ...changes });

test('classic script has only its immutable namespace and performs no network/timer/DOM work', () => {
  assert.deepEqual(Object.keys(sandbox), ['WeatherBackground']);
  assert.equal(Object.isFrozen(sandbox.WeatherBackground), true);
  assert.deepEqual(Object.keys(sandbox.WeatherBackground), ['derive', 'mount']);
});

test('daylight position follows actual HA azimuth/elevation from east through south to west', () => {
  const morning = derive(daytime({ solar: { state: 'above_horizon', elevation: 2, azimuth: 90, rising: true } }));
  const noon = derive(daytime({ solar: { state: 'above_horizon', elevation: 45, azimuth: 180, rising: false } }));
  const evening = derive(daytime({ solar: { state: 'above_horizon', elevation: 2, azimuth: 270, rising: false } }));
  assert.equal(morning.sun.x, 8); assert.equal(noon.sun.x, 50); assert.equal(evening.sun.x, 92);
  assert.ok(noon.sun.y < morning.sun.y); assert.equal(morning.sun.y, evening.sun.y);
  assert.equal(morning.sun.rising, true); assert.equal(evening.sun.rising, false);
  assert.equal(morning.lowSun, true); assert.equal(noon.lowSun, false);
});

test('next sunrise tomorrow never becomes a fabricated current-day sunrise or sun position', () => {
  const result = derive(daytime({ solar: { state: 'above_horizon', nextRising: '2026-10-25T05:30:00Z', nextSetting: '2026-10-24T15:40:00Z' } }));
  assert.equal(result.active, true); assert.equal(result.sun, null);
  assert.equal(result.nextRising, Date.parse('2026-10-25T05:30:00Z'));
  assert.equal(result.nextSetting, Date.parse('2026-10-24T15:40:00Z'));
});

test('night, missing sun, offline/demo and stale data remove the live weather layer', () => {
  for (const [change, reason] of [[{ solar: { state: 'below_horizon', elevation: -20, azimuth: 300 } }, 'night'],
    [{ solar: {} }, 'sun-unknown'], [{ mode: 'offline' }, 'not-live'], [{ mode: 'demo' }, 'not-live'],
    [{ updatedAt: null }, 'stale'], [{ now: NOW + 300001 }, 'stale'], [{ now: NOW - 60001 }, 'stale'],
    [{ updatedAt: '2026-02-30T10:00:00Z' }, 'stale']]) {
    const result = derive(daytime(change)); assert.equal(result.active, false); assert.equal(result.reason, reason);
    assert.equal(result.sun, null); assert.equal(result.scene, 'unknown'); assert.equal(result.weatherAvailable, false);
  }
  assert.equal(derive(daytime({ now: NOW + 300000 })).active, true);
});

test('explicit photos/plain and hidden screens override daytime while selected dark appearance is retained', () => {
  for (const background of ['photos', 'plain']) {
    const result = derive(daytime({ background })); assert.equal(result.active, false); assert.equal(result.reason, 'user-background');
  }
  assert.equal(derive(daytime({ hidden: true })).reason, 'hidden');
  assert.equal(derive(daytime({ theme: 'dark' })).theme, 'dark');
  assert.equal(derive(daytime({ theme: 'auto' })).theme, 'light');
  assert.equal(derive(daytime({ theme: 'auto', solar: { state: 'below_horizon' } })).theme, 'dark');
});

test('HA condition enum selects real cloud/rain/snow/storm scenes without inventing precipitation', () => {
  for (const [condition, scene] of Object.entries({ sunny: 'clear', partlycloudy: 'partly-cloudy', cloudy: 'cloudy', fog: 'fog', rainy: 'rain', pouring: 'rain', snowy: 'snow', 'snowy-rainy': 'sleet', hail: 'hail', lightning: 'storm', 'lightning-rainy': 'storm', windy: 'wind' })) {
    const result = derive(daytime({ weather: { condition } })); assert.equal(result.scene, scene); assert.equal(result.weatherSource, 'condition');
  }
  for (const condition of [null, 'unknown', 'unavailable', 'clear-night', '<img onerror=alert(1)>']) {
    const result = derive(daytime({ weather: { condition } })); assert.equal(result.scene, 'unknown'); assert.equal(result.weatherAvailable, false);
  }
});

test('positive measured rain rate proves rain, but zero/invalid/missing units never prove a clear sky', () => {
  for (const rate of [0.1, '2.5', { value: 1.2, available: true }]) {
    const result = derive(daytime({ weather: { rainRate: rate, units: { rainRate: 'mm/h' } } }));
    assert.equal(result.scene, 'rain'); assert.equal(result.weatherSource, 'rain-rate');
  }
  for (const rate of [null, '', false, -1, 0, Infinity, { value: 5, available: false }]) {
    assert.equal(derive(daytime({ weather: { rainRate: rate, units: { rainRate: 'mm/h' } } })).scene, 'unknown');
  }
  assert.equal(derive(daytime({ weather: { rainRate: 5 } })).scene, 'unknown');
  assert.equal(derive(daytime({ weather: { condition: 'snowy', rainRate: 1, units: { rainRate: 'mm/h' } } })).scene, 'snow');
});

test('invalid or absent position cannot become a fake sun at 0° and all valid output stays bounded', () => {
  for (const value of [null, '', false, {}, Infinity, 'invalid']) {
    assert.equal(derive(daytime({ solar: { state: 'above_horizon', elevation: value, azimuth: 180 } })).sun, null);
    assert.equal(derive(daytime({ solar: { state: 'above_horizon', elevation: 30, azimuth: value } })).sun, null);
  }
  for (const azimuth of [0, 90, 180, 270, 360]) for (const elevation of [-0.5, 0, 90]) {
    const result = derive(daytime({ solar: { state: 'above_horizon', elevation, azimuth } }));
    assert.ok(result.sun.x >= 4 && result.sun.x <= 96); assert.ok(result.sun.y >= 12 && result.sun.y <= 74);
  }
  assert.equal(derive(daytime({ solar: { state: 'above_horizon', elevation: 100, azimuth: 180 } })).sun, null);
});

class FakeNode {
  constructor(document, tag) { this.ownerDocument = document; this.tagName = tag; this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = {}; this.properties = {}; this.classes = new Set(); this.classList = { toggle: (key, active) => active ? this.classes.add(key) : this.classes.delete(key), remove: key => this.classes.delete(key) }; this.style = { setProperty: (key, value) => { this.properties[key] = value; } }; }
  set innerHTML(_) { throw Error('Weather background must use safe DOM nodes'); }
  setAttribute(key, value) { this.attributes[key] = value; }
  get firstChild() { return this.children[0] || null; }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  insertBefore(child, before) { child.parentNode = this; const index = this.children.indexOf(before); this.children.splice(index >= 0 ? index : this.children.length, 0, child); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
}
const count = root => 1 + root.children.reduce((total, child) => total + count(child), 0);
test('mount adds bounded decorative DOM, updates it in place and preserves existing wallpaper children on destroy', () => {
  const document = { hidden: false, createElement(tag) { return new FakeNode(this, tag); }, createElementNS(_namespace, tag) { return new FakeNode(this, tag); } };
  const parent = new FakeNode(document, 'div'), photo = new FakeNode(document, 'div'); parent.append(photo);
  const controller = sandbox.WeatherBackground.mount(parent);
  const layer = parent.firstChild, number = count(layer);
  assert.equal(layer.attributes['aria-hidden'], 'true'); assert.ok(number < 60); assert.equal(parent.children[1], photo);
  for (let index = 0; index < 100; index++) controller.update(daytime());
  assert.equal(count(layer), number); assert.equal(layer.dataset.active, 'true'); assert.equal(parent.classes.has('has-weather-background'), true);
  const sun = layer.children[1]; assert.equal(sun.properties['--weather-sun-x'], '50.000vw');
  document.hidden = true; controller.update(daytime()); assert.equal(layer.dataset.active, 'false');
  document.hidden = false; controller.update(daytime({ background: 'photos' })); assert.equal(layer.dataset.active, 'false');
  controller.destroy(); controller.destroy(); assert.deepEqual(parent.children, [photo]); assert.equal(parent.classes.has('has-weather-background'), false);
  controller.update(daytime()); assert.deepEqual(parent.children, [photo]);
});

test('CSS keeps reduced-motion and explicit background safeguards with no continuous paint animation/blur', () => {
  assert.match(css, /prefers-reduced-motion/); assert.match(css, /data-background="photos"/); assert.match(css, /data-background="plain"/);
  assert.doesNotMatch(css, /backdrop-filter|filter\s*:\s*blur|@keyframes|\banimation\s*:/);
  assert.match(css, /transition:transform/);
});
