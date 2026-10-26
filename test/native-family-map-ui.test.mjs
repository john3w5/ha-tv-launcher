import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness() {
  const calls = { fitted: [], centered: [], pins: [], tileAdds: 0, loaded: 0, removed: 0 };
  const element = () => ({ textContent: '', className: '', hidden: false, style: {}, children: [], setAttribute() {}, appendChild(child) { this.children.push(child); }, classList: { toggle() {} } });
  const status = element(), layers = new Set();
  const map = { attributionControl: { setPrefix() {} }, invalidateSize() {}, hasLayer(layer) { return layers.has(layer); },
    removeLayer(layer) { layers.delete(layer); calls.loaded = 0; calls.removed++; }, setView(point, zoom) { calls.centered.push({ point, zoom }); },
    fitBounds(bounds, options) { calls.fitted.push({ bounds, options }); } };
  const markers = { addTo() { return this; }, clearLayers() { calls.pins = []; } };
  const tiles = { addTo(target) { assert.equal(target, map); layers.add(this); calls.tileAdds++; return this; }, on(name, fn) { this[name] = fn; return this; } };
  const L = { map() { return map; }, tileLayer(url, options) { assert.equal(url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'); assert.equal(options.keepBuffer, 0); assert.equal(options.detectRetina, false); return tiles; },
    layerGroup() { return markers; }, latLngBounds(list) { return list; }, divIcon(value) { return value; }, marker(point, options) {
      const pin = { point, options, bindTooltip(label) { this.label = label; return this; }, addTo(group) { assert.equal(group, markers); calls.pins.push(this); return this; } }; return pin;
    } };
  const document = { body: element(), getElementById() { return status; }, createElement: element, createElementNS: element,
    querySelectorAll() { return { length: calls.loaded }; } };
  const window = { addEventListener() {} };
  vm.runInNewContext(readFileSync(new URL('../android/app/src/main/assets/family-map/family-map.js', import.meta.url), 'utf8'), { L, document, window, Number, JSON, Object });
  return { calls, api: window.HomeTVFamilyMap, status, tiles };
}

const atHome = [
  { id: 'person-a', name: 'Osoba A', latitude: 50.1, longitude: 16.2, home: false },
  { id: 'person-b', name: 'Osoba B', latitude: 50.1, longitude: 16.2, home: false },
  { id: 'home', name: 'Domov', latitude: 50.1, longitude: 16.2, home: true },
];

test('family map groups coincident real members, without invented coordinates or hidden tile prefetch', () => {
  const h = harness();
  assert.equal(h.calls.tileAdds, 0);
  assert.equal(h.api.bind({ positions: atHome, selected: 'all', zoom: 16 }), true);
  assert.equal(h.calls.tileAdds, 0, 'Hidden page never starts the tile layer');
  assert.equal(h.calls.pins.length, 1);
  assert.equal(h.calls.pins[0].point[0], 50.1); assert.equal(h.calls.pins[0].point[1], 16.2);
  assert.equal(h.calls.pins[0].options.icon.html.textContent, '2');
  assert.equal(h.calls.pins[0].label.textContent, '2 doma · Osoba A · Osoba B');
  h.api.setVisible(true); assert.equal(h.calls.tileAdds, 1);
  h.calls.loaded = 4; assert.equal(h.api.status().ready, true);
  h.api.setVisible(false); assert.equal(h.calls.removed, 1); assert.equal(h.api.status().visible, false);
  h.api.bind({ positions: atHome, selected: 'person-b', zoom: 17 });
  assert.equal(h.calls.tileAdds, 1, 'A hidden position update cannot re-add tiles');
  assert.equal(h.calls.centered.at(-1).point[0], atHome[1].latitude);
  assert.equal(h.calls.centered.at(-1).point[1], atHome[1].longitude);
  assert.equal(h.calls.centered.at(-1).zoom, 17);
});

test('family map removes unavailable locations, bounds inputs and renders names as text', () => {
  const h = harness();
  h.api.bind({ positions: [{ ...atHome[0], name: '<img src=x onerror=alert(1)>' }, { ...atHome[1], latitude: null }], selected: 'all', zoom: 99 });
  assert.equal(h.calls.pins.length, 1);
  assert.equal(h.calls.pins[0].label.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(h.calls.fitted.at(-1).options.maxZoom, 18);
  h.api.setVisible(true);
  const views = h.calls.fitted.length;
  h.api.bind({ positions: [{ ...atHome[0], name: 'Jiný popisek' }], selected: 'all', zoom: 18 });
  assert.equal(h.calls.fitted.length, views, 'A label-only update does not move/reload the visible viewport');
  h.api.bind({ positions: [], selected: 'all', zoom: 16 });
  assert.equal(h.calls.pins.length, 0); assert.equal(h.api.status().ready, false);
  assert.equal(h.status.textContent, 'Aktuální polohy nejsou dostupné.');
  const many = Array.from({ length: 30 }, (_, i) => ({ ...atHome[0], id: `person-${i}`, latitude: 40 + i / 100 }));
  h.api.bind({ positions: many, selected: 'all', zoom: 16 });
  assert.equal(h.api.status().positions, 9);
});
