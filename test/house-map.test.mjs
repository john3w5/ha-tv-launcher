import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/house-map.js', import.meta.url), 'utf8');
const geography = JSON.parse(await readFile(new URL('../public/assets/europe-110m.geojson', import.meta.url), 'utf8'));

class FakeNode {
  constructor(document, tag) { this.ownerDocument = document; this.tagName = tag; this.children = []; this.attributes = {}; this.style = {}; this.handlers = new Map(); this.parentNode = null; this._text = ''; this.focusCalls = []; }
  set innerHTML(_) { throw new Error('Map must not render HTML strings'); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) { if (child.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null; child.parentNode = null; } this.children = []; this.append(...children); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; } }
  addEventListener(type, callback) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(callback); }
  removeEventListener(type, callback) { this.handlers.get(type)?.delete(callback); }
  focus(options) { this.ownerDocument.activeElement = this; this.focusCalls.push(options); }
  dispatch(type, key) { const event = { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; for (const handler of this.handlers.get(type) || []) handler(event); return event; }
}

function nodes(root, className) {
  return [root, ...root.children.flatMap(child => nodes(child, className))].filter(node => (node.className || node.attributes.class || '').split(' ').includes(className));
}
function setup(fetcher = async () => ({ ok: true, json: async () => geography })) {
  const document = { activeElement: null, createElement(tag) { return new FakeNode(this, tag); }, createElementNS(_namespace, tag) { return new FakeNode(this, tag); } };
  const requests = [];
  const sandbox = { fetch: (...args) => { requests.push(args); return fetcher(...args); } };
  vm.runInNewContext(source, sandbox);
  return { document, sandbox, requests, container: new FakeNode(document, 'div'), api: sandbox.HomeTVMap };
}
const people = [{ id: 'a', name: 'Alice', latitude: 50.0755, longitude: 14.4378 }, { id: 'b', name: 'Bob', latitude: 49.1951, longitude: 16.6068 }];

test('classic script exposes only its immutable namespace, with no DOM/network side effects', () => {
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  assert.deepEqual(Object.keys(sandbox), ['HomeTVMap']);
  assert.equal(Object.isFrozen(sandbox.HomeTVMap), true);
  assert.deepEqual(Object.keys(sandbox.HomeTVMap), ['render']);
});

test('local Europe asset contains genuine Czech/neighbor polygons and public-domain provenance', async () => {
  assert.equal(geography.source.license, 'Public domain');
  assert.match(geography.source.url, /^https:\/\/github\.com\/nvkelso\/natural-earth-vector\//);
  for (const id of ['CZE', 'AUT', 'DEU', 'POL', 'SVK']) assert.ok(geography.features.find(feature => feature.id === id)?.geometry.coordinates.length);
  assert.ok((await readFile(new URL('../public/assets/europe-110m.geojson', import.meta.url))).length < 500000);
});

test('requests exactly the fixed same-origin geometry, never a tile/GPS URL', async () => {
  const { api, container, requests } = setup();
  const map = api.render(container, { people });
  assert.equal(await map.ready, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], '/assets/europe-110m.geojson');
  assert.equal(requests[0][1].credentials, 'same-origin');
  assert.ok(nodes(container, 'house-map-countries')[0].children.length >= 41);
  assert.equal(nodes(container, 'house-map-person').length, 2);
  assert.equal(container.children.length, 1);
});

test('missing, unknown, malformed and unavailable positions never become fake 0,0 markers', async () => {
  const { api, container } = setup();
  const invalid = [null, '', false, {}, 'not-number', Infinity];
  const unavailable = invalid.map((latitude, index) => ({ name: 'Invalid' + index, latitude, longitude: 14 }));
  unavailable.push({ latitude: 50, longitude: '', name: 'No longitude' }, { latitude: 50, longitude: 181, name: 'Bad longitude' }, { latitude: 91, longitude: 14, name: 'Bad latitude' }, { latitude: 50, longitude: 14, available: false }, { latitude: 50, longitude: 14, state: 'unknown' }, { latitude: 50, longitude: 14, state: 'unavailable' });
  const map = api.render(container, { people: unavailable });
  await map.ready;
  assert.equal(nodes(container, 'house-map-person').length, 0);
  assert.equal(nodes(container, 'house-map-legend-item').length, unavailable.length);
  assert.match(nodes(container, 'house-map-status')[0].textContent, /Žádná poloha/);
  assert.equal(nodes(container, 'house-map-legend-item').filter(node => node.tagName === 'button').length, 0);
});

test('numeric strings/real zero coordinates are accepted and polar projection remains finite', async () => {
  const { api, container } = setup();
  const map = api.render(container, { people: [{ name: 'Origin', latitude: '0', longitude: '0' }] });
  await map.ready;
  let point = nodes(container, 'house-map-person-point')[0];
  assert.equal(Number(point.attributes.cx), 500); assert.equal(Number(point.attributes.cy), 280);
  for (const latitude of [-90, 90]) {
    map.setData({ people: [{ name: 'Polar', latitude, longitude: 15 }] }, { fit: true });
    point = nodes(container, 'house-map-person-point')[0];
    assert.equal(Number.isFinite(Number(point.attributes.cy)), true);
    assert.doesNotMatch(nodes(container, 'house-map-world')[0].attributes.transform, /NaN|Infinity/);
  }
});

test('zone radius has true Mercator meter scale, independent from fixed center marker', async () => {
  const { api, container } = setup();
  const map = api.render(container, { zones: [{ name: 'Home', latitude: 50, longitude: 14, radius: 100 }] });
  await map.ready;
  const circle = nodes(container, 'house-map-zone-radius')[0], center = nodes(container, 'house-map-zone-center')[0];
  const radius = Number(circle.attributes.r);
  const expected = 100 / (2 * Math.PI * 6378137 * Math.cos(50 * Math.PI / 180)) * 1000 * (1000 / (1000 * 8 / 360));
  assert.ok(Math.abs(radius - expected) < 0.000001);
  assert.ok(radius < 1, '100m zone is not misleadingly expanded to a screen-sized region');
  assert.equal(center.attributes.r, '4');
});

test('keyboard pan/zoom is local to focused SVG and Escape is left for outer dialog', async () => {
  const { api, container } = setup();
  const map = api.render(container, { people }); await map.ready;
  const canvas = nodes(container, 'house-map-canvas')[0], world = nodes(container, 'house-map-world')[0];
  const original = world.attributes.transform;
  const handled = canvas.dispatch('keydown', 'ArrowRight');
  assert.equal(handled.prevented, true); assert.equal(handled.stopped, true);
  assert.notEqual(world.attributes.transform, original);
  canvas.dispatch('keydown', 'Home'); assert.equal(world.attributes.transform, original);
  const zoom = canvas.dispatch('keydown', '+'); assert.equal(zoom.stopped, true); assert.notEqual(world.attributes.transform, original);
  const escape = canvas.dispatch('keydown', 'Escape'); assert.equal(escape.prevented, false); assert.equal(escape.stopped, false);
  const before = world.attributes.transform;
  map.pan(NaN, 1); assert.equal(world.attributes.transform, before);
});

test('setData keeps user camera unless fit requested and legend can refocus real location', async () => {
  const { api, container, document } = setup();
  const map = api.render(container, { people }); await map.ready;
  map.pan(1, 0);
  const world = nodes(container, 'house-map-world')[0], panned = world.attributes.transform;
  map.setData({ people: [people[0]] }); assert.equal(world.attributes.transform, panned);
  nodes(container, 'house-map-legend-item')[0].dispatch('click');
  assert.equal(document.activeElement, nodes(container, 'house-map-canvas')[0]);
  const marker = nodes(container, 'house-map-person-point')[0]; assert.equal(Number(marker.attributes.cx), 500);
  map.fit(); map.zoomIn(); const zoomed = world.attributes.transform; map.zoomOut(); assert.notEqual(world.attributes.transform, zoomed);
});

test('repeated refreshes retain the focused legend identity even after reorder, rename and moved coordinates', async () => {
  const { api, container, document } = setup();
  const map = api.render(container, { people }); await map.ready;
  map.pan(1, 0);
  const world = nodes(container, 'house-map-world')[0], panned = world.attributes.transform;
  const key = JSON.stringify(['person', 'a']);
  nodes(container, 'house-map-legend-item')[0].focus();
  for (let index = 0; index < 25; index++) {
    const oldFocus = document.activeElement;
    map.setData({ people: [people[1], { ...people[0], name: 'Alice updated', latitude: 50.5, longitude: 15.5 }] });
    assert.notEqual(document.activeElement, oldFocus, 'The test must exercise the real rebuilt legend');
    assert.equal(document.activeElement.getAttribute('data-map-key'), key);
    assert.match(document.activeElement.textContent, /Alice updated/);
    assert.equal(document.activeElement.focusCalls.at(-1).preventScroll, true);
    assert.equal(world.attributes.transform, panned, 'Focus restoration must not recenter the map');
  }
  document.activeElement.dispatch('click');
  assert.equal(document.activeElement, nodes(container, 'house-map-canvas')[0]);
  const movedPerson = nodes(container, 'house-map-person')[1];
  assert.equal(Number(nodes(movedPerson, 'house-map-person-point')[0].attributes.cx), 500, 'The restored control uses current coordinates');
});

test('person and zone with the same ID have independent focus identities', async () => {
  const { api, container, document } = setup();
  const zone = { id: people[0].id, name: 'Home zone', latitude: 50, longitude: 14, radius: 100 };
  const map = api.render(container, { people, zones: [zone] }); await map.ready;
  nodes(container, 'house-map-legend-item')[2].focus();
  map.setData({ people: [...people].reverse(), zones: [{ ...zone, name: 'Updated home zone' }] });
  assert.equal(document.activeElement.getAttribute('data-map-key'), JSON.stringify(['zone', zone.id]));
  assert.match(document.activeElement.textContent, /Updated home zone/);
});

test('removed or newly unavailable focused location returns to the map instead of losing focus to the page', async () => {
  for (const next of [{ people: [people[1]] }, { people: [{ ...people[0], available: false }, people[1]] }]) {
    const { api, container, document } = setup();
    const map = api.render(container, { people }); await map.ready;
    nodes(container, 'house-map-legend-item')[0].focus();map.setData(next);
    assert.equal(document.activeElement, nodes(container, 'house-map-canvas')[0]);
    assert.equal(document.activeElement.focusCalls.at(-1).preventScroll, true);
  }
});

test('an ambiguous duplicate identity never selects an arbitrary legend entry', async () => {
  const { api, container, document } = setup();
  const map = api.render(container, { people }); await map.ready;
  nodes(container, 'house-map-legend-item')[0].focus();
  map.setData({ people: [people[0], { ...people[1], id: people[0].id }] });
  assert.equal(document.activeElement, nodes(container, 'house-map-canvas')[0]);
  nodes(container, 'house-map-legend-item')[1].focus();map.setData({ people: [people[0]] });
  assert.equal(document.activeElement, nodes(container, 'house-map-canvas')[0]);
});

test('refresh never steals focus from the canvas, toolbar or controls outside the map', async () => {
  const { api, container, document } = setup();
  const map = api.render(container, { people }); await map.ready;
  const outside = new FakeNode(document, 'button');
  for (const focused of [nodes(container, 'house-map-canvas')[0], nodes(container, 'house-map-button')[0], outside]) {
    focused.focus();const before = focused.focusCalls.length;
    map.setData({ people: [people[1], people[0]] });
    assert.equal(document.activeElement, focused);assert.equal(focused.focusCalls.length, before);
  }
});

test('untrusted names remain bounded literal text, and input catalog is bounded', async () => {
  const { api, container } = setup();
  const payload = '<img src=x onerror=alert(1)><svg onload=alert(2)>';
  const list = Array.from({ length: 100 }, (_, index) => ({ name: index ? 'x'.repeat(500) : payload, latitude: 50, longitude: 14 }));
  const map = api.render(container, { people: list, zones: Array.from({ length: 100 }, () => ({ name: 'Zone', latitude: 50, longitude: 14 })) });
  await map.ready;
  assert.equal(nodes(container, 'house-map-person').length, 32);
  assert.equal(nodes(container, 'house-map-zone').length, 64);
  assert.equal(nodes(container, 'house-map-legend-item').length, 96);
  assert.ok(container.textContent.includes(payload));
  assert.equal(nodes(container, 'house-map-person')[1].children[0].textContent.length, 100);
});

test('geometry failure is explicit while supplied positions remain visible', async () => {
  const { api, container } = setup(async () => { throw new Error('Offline'); });
  const map = api.render(container, { people: [people[0]] });
  assert.equal(await map.ready, false);
  assert.match(nodes(container, 'house-map-status')[0].textContent, /Mapový podklad není dostupný/);
  assert.equal(nodes(container, 'house-map-person').length, 1);
});

test('destroy removes DOM/listeners and a late asset response never resurrects the map', async () => {
  let finish;
  const { api, container } = setup(() => new Promise(resolve => { finish = resolve; }));
  const map = api.render(container, { people });
  const canvas = nodes(container, 'house-map-canvas')[0];
  await Promise.resolve();
  map.destroy(); map.destroy();
  assert.equal(container.children.length, 0); assert.equal(canvas.handlers.get('keydown').size, 0);
  finish({ ok: true, json: async () => geography });
  assert.equal(await map.ready, false);
  map.setData({ people }); map.fit(); map.zoomIn(); map.pan(1, 1);
  assert.equal(container.children.length, 0);
});
