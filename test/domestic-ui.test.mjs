import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { readDomesticPanel } from '../lib/domestic-panel.mjs';

const source = await readFile(new URL('../public/domestic-ui.js', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-23T18:00:00Z');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
// The backend names entityId only for sources configured in the installation.
const measure = (value = null, unit = 'W', available = value !== null) => ({ entityId: 'sensor.test', value, unit, available });
const washerConfig = { washer: { jobEntityId: 'sensor.job', machineEntityId: 'sensor.machine', completionEntityId: 'sensor.end', progressEntityId: 'sensor.progress' } };
const state = (entity_id, value, attributes = {}) => ({ entity_id, state: String(value), attributes });
const washer = (machine = 'run', job = 'wash', end = '2026-10-23T18:30:00Z', progress) => readDomesticPanel(washerConfig, {
  now: new Date(NOW), states: [state('sensor.machine', machine), state('sensor.job', job), state('sensor.end', end),
    ...(progress === undefined ? [] : [state('sensor.progress', progress, { unit_of_measurement: '%' })])],
}).washer;

function harness(data = {}) {
  let now = NOW, markup = '', dialogs = [], focused = null;
  const nodes = new Map(), listeners = new Map(), requests = [], imageRequests = [];
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  class Node {
    constructor(id) {
      this.id = id; this.dataset = {}; this.textContent = ''; this.innerHTML = ''; this.events = new Map(); this.classes = new Set();
      this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name) };
    }
    addEventListener(type, callback, options) { const handlers = this.events.get(type) || []; handlers.push({ callback, once: options?.once }); this.events.set(type, handlers); }
    emit(type) { for (const handler of [...(this.events.get(type) || [])]) { if (handler.once) this.events.set(type, this.events.get(type).filter(item => item !== handler)); handler.callback(); } }
    removeAttribute(name) { if (name === 'data-observed') delete this.dataset.observed; }
    set src(value) { this._src = value; imageRequests.push(value); }
    get src() { return this._src; }
    focus() { focused = this; }
  }
  const context = {
    Date: ClockDate, state: { mode: 'live', tab: 'household', dialog: false, data: { domestic: { configured: true, ...data } } },
    window: {}, document: { addEventListener(type, callback) { listeners.set(type, callback); } },
    $: selector => nodes.get(selector) || null, esc, icon: () => '<svg aria-hidden="true"></svg>',
    number: (value, suffix = '', digits = 0) => value !== null && value !== undefined && Number.isFinite(Number(value))
      ? Number(value).toLocaleString('cs-CZ', { maximumFractionDigits: digits }) + suffix : '—',
    dayFormat: (date, options) => new Intl.DateTimeFormat('cs-CZ', { ...options, timeZone: 'Europe/Prague' }).format(date),
    renderHousehold: () => '<section id="family-security">Rodina a zabezpečení</section>',
    showDialog(title, body) { dialogs.push({ title, body }); context.state.dialog = true; },
    closeDialog() { context.state.dialog = false; context.closeDomesticDialog(); },
    render() { markup = context.renderDomov(); },
    fetch(...args) { requests.push(args); throw Error('Domestic UI must not request a service or poll a map'); },
    setTimeout() { throw Error('No background domestic polling is allowed'); },
    setInterval() { throw Error('No background domestic polling is allowed'); },
  };
  vm.runInNewContext(source, context, { filename: 'domestic-ui.js' });
  return {
    ui: context, requests, imageRequests, nodes,
    get dialogs() { return dialogs; }, get markup() { return markup; }, get focused() { return focused; },
    node(selector) { const element = new Node(selector); nodes.set(selector, element); return element; },
    advance(milliseconds) { now += milliseconds; },
    click(kind, value) {
      const element = { dataset: { [kind]: value } };
      const selector = { domesticSection: '[data-domestic-section]', domesticRoom: '[data-domestic-room]', domesticMap: '[data-domestic-map]' }[kind];
      return listeners.get('click')({ target: { closest: candidate => candidate === selector ? element : null } });
    },
  };
}

test('missing or nonnumeric readings stay missing while measured zero and escaped units remain valid', () => {
  const h = harness(), metric = h.ui.window.HomeTVDomestic.metric, power = h.ui.window.HomeTVDomestic.power;
  for (const value of [null, undefined, NaN, Infinity, '0']) {
    assert.equal(metric({ available: true, value, unit: 'W' }), '—'); assert.equal(power(value), '—');
  }
  assert.equal(metric(measure(0)), '0 W'); assert.equal(power(0), '0 W');
  assert.equal(metric(measure(100, 'W', false)), '—');
  assert.equal(metric(measure(2, '<img src=x>')), '2 &lt;img src=x&gt;');
});

test('energy displays independent source readings without deriving a balance, percentages or price', () => {
  const h = harness({ energy: { power: measure(1200), today: measure(3.25, 'kWh'), powerW: 1200, todayKWh: 3.25, consumers: [{ name: 'Bojler', powerW: 900 }, { name: 'Lednice', powerW: 150 }, { name: 'Chybějící', powerW: null }] } });
  const html = h.ui.domesticEnergy();
  assert.match(html, /1,2 kW/); assert.match(html, /3,25 kWh/); assert.doesNotMatch(html, /900 W/); assert.doesNotMatch(html, /150 W/);
  assert.doesNotMatch(html, /Chybějící|energy-distribution|energy-consumers/);
  assert.doesNotMatch(html, /150 W.*(?:Zbytek|Ostatní)/);
  assert.doesNotMatch(html, /(?:75|12,5|87,5)\s*%|Kč|CZK|zůstatek|bilance|cena|zbytek/i);
});

test('water details show raw sensor depths and never substitute percentages or infer capacity', () => {
  const h = harness({ water: { wellVolume: measure(0, 'l'), wellDepth: measure(1.79, 'm'), tankDepth: measure(null, 'm'), wellLevel: measure(60, '%'), tankLevel: measure(100, '%'), valves: [{ name: 'Zahrada', available: false, state: 'unknown', positionPercent: null }] } });
  const html = h.ui.domesticWater();
  assert.match(html, /0 l/); assert.match(html, /1,79 m/); assert.match(html, /Hladina nádrže<\/span><strong>—/);
  assert.match(html, /Stav není dostupný/);
  assert.doesNotMatch(html, /60 %|100 %|prázdn|600 l|1000 l|>0 %<|>0 °C</i);
  h.ui.state.data.domestic.water.tankDepth = measure(0, 'm');
  assert.match(h.ui.domesticWater(), /Hladina nádrže<\/span><strong>0 m/);
});

test('overview well tile pairs raw well and tank depths with their actual units, without substituting percentages', () => {
  const h = harness({ water: { wellDepth: measure(1.79, 'm'), tankDepth: measure(.93, 'm'), wellLevel: measure(59, '%'), tankLevel: measure(100, '%') } });
  const html = h.ui.domesticQuickMarkup();
  assert.match(html, /Hladina studny a nádrže/); assert.match(html, /1,79 m · 0,93 m/);
  assert.doesNotMatch(html, /59 %|100 %|1790|930/);
  h.ui.state.data.domestic.water.wellDepth.available = false;
  assert.match(h.ui.domesticQuickMarkup(), /<strong>— · 0,93 m<\/strong>/);
});

test('unknown room readings and absent HVAC action never become zero or a claimed heating action', () => {
  const room = { id: 'living', name: 'Obývák', available: true, state: 'off', action: null, currentTemperature: null, targetTemperature: null, targetLow: null, targetHigh: null, unit: '°C' };
  const h = harness({ rooms: [room] }), html = h.ui.domesticRoomDetail(room);
  assert.match(html, /Naměřeno<\/span><strong>—/); assert.match(html, /Nastaveno<\/span><strong>—/);
  assert.match(html, /Vypnuto/); assert.match(html, /Neověřeno/); assert.doesNotMatch(html, /0 °C|Topí|Chladí/);
  const range = h.ui.domesticRoomDetail({ ...room, currentTemperature: 0, targetLow: 22.5, targetHigh: 25 });
  assert.match(range, /0 °C/); assert.match(range, /22,5–25 °C/);
});

test('legacy rooms combine climate and air only by stable id, preserve air-only rooms and require physical heating evidence', () => {
  const bedroom = { id: 'bedroom', name: 'Ložnice', available: true, state: 'heat', action: 'heating', currentTemperature: 21, targetTemperature: 22, unit: '°C', heatingActive: null, heatingLabel: 'Režim vytápění' };
  const bathroom = { id: 'bathroom', name: 'Koupelna', available: true, state: 'heat', action: 'heating', currentTemperature: 24, targetTemperature: 24, unit: '°C', heatingActive: true, heatingLabel: 'Topí' };
  const h = harness({ rooms: [bedroom, bathroom], air: { rooms: [
    { id: 'bedroom', name: 'Ložnice', co2: measure(1866, 'ppm'), humidity: measure(53, '%') },
    { id: 'bathroom', name: 'KOUPELNA', co2: measure(null, 'ppm'), humidity: measure(34, '%') },
    { id: 'office', name: 'Pracovna', temperature: measure(20.5, '°C'), humidity: measure(40, '%') },
  ] } });
  const html = h.ui.renderDomesticRooms();
  assert.equal((html.match(/domestic-room-card/g) || []).length, 3);
  assert.equal((html.match(/>Ložnice</g) || []).length, 1);
  assert.equal((html.match(/>Koupelna</g) || []).length, 1);
  assert.match(html, /1\s*866 ppm/); assert.match(html, /53 %/); assert.match(html, /34 %/);
  assert.match(html, /Pracovna/); assert.match(html, /20,5/);
  assert.doesNotMatch(html, /air-room-grid|air-panel|data-domestic-room="office"/);
  assert.equal((html.match(/>Topí</g) || []).length, 1);
  assert.match(html, /Režim vytápění/);
  h.ui.state.data.domestic.rooms[0].heatingActive = false;
  assert.match(h.ui.domesticRoomDetail(bedroom), /Netopí/);
  assert.doesNotMatch(h.ui.domesticRoomDetail(bedroom), />Topí</);
});

test('legacy rooms with similar names and different ids never share sensors', () => {
  const room = { id: 'bathroom', name: 'Koupelna', available: true, currentTemperature: 24, unit: '°C' };
  const h = harness({ rooms: [room], air: { rooms: [{ id: 'another-room', name: 'KOUPELNA', humidity: measure(87, '%') }] } });
  assert.equal(h.ui.domesticRoomRows().length, 2);
  assert.equal(h.ui.domesticRoomRows()[0].air, undefined);
  assert.doesNotMatch(h.ui.domesticRoomDetail(room), /87 %/);
  assert.equal((h.ui.renderDomesticRooms().match(/domestic-room-card/g) || []).length, 2);
});

test('v2 uses all nine authoritative rooms in order with exact primary metrics and no climate or legacy-air fallback', () => {
  const names = ['Před domem', 'Předsíň', 'Koupelna', 'Obývák', 'Ložnice', 'Pokojíček', 'Garáž', 'Studna', 'Kůlna'];
  const ids = ['outside', 'hallway', 'bathroom', 'living', 'bedroom', 'children', 'garage', 'well', 'shed'];
  const rooms = ids.map((id, index) => ({ id, name: names[index], available: true,
    temperature: measure(index === 0 ? 0 : 10.125 + index, '°C'), humidity: measure(30.125 + index, '%'),
    co2: measure(index * 101, 'ppm'), pm25: measure(index * .125, 'µg/m³'),
    currentTemperature: 99, targetTemperature: 88,
    climate: { available: false, currentTemperature: 98, targetTemperature: 87, unit: '°F', state: 'heat', reportedAction: 'heating' },
    heatingActive: null,
  }));
  rooms[1].temperature = measure(73, '°C', false);
  rooms[2].humidity = measure(93, '%', false);
  const h = harness({ roomsContractVersion: 2, rooms, air: { rooms: [
    { id: 'outside', name: 'Před domem', temperature: measure(77, '°C'), humidity: measure(78, '%') },
    { id: 'bedroom', name: 'Ložnice', co2: measure(9999, 'ppm') },
    { id: 'old-ac', name: 'Klimatizace v obýváku', temperature: measure(22, '°C') },
  ] } });
  const rows = h.ui.domesticRoomRows();
  assert.equal(rows.length, 9);
  assert.deepEqual(Array.from(rows, row => row.room.id), ids);
  const html = h.ui.renderDomesticRooms(), cards = html.match(/<button class="card glass domestic-room-card"[\s\S]*?<\/button>/g);
  assert.equal(cards.length, 9);
  assert.match(cards[0], /room-temperature">0<small>°C/); assert.match(cards[0], /0 ppm/); assert.match(cards[0], /0 µg\/m³/);
  assert.match(cards[1], /room-temperature">—<small><\/small>/); assert.doesNotMatch(cards[1], /99|98|73|77/);
  assert.match(cards[2], /Vlhkost<\/span><strong>—/); assert.doesNotMatch(cards[2], /93 %/);
  assert.match(cards[3], /13,125/); assert.match(cards[3], /33,125 %/); assert.match(cards[3], /0,375 µg\/m³/);
  assert.doesNotMatch(html, /Klimatizace v obýváku|99|98|88|87 °F|9999|>Topí</);
  assert.match(h.ui.domesticQuickMarkup(), /404 ppm/); assert.doesNotMatch(h.ui.domesticQuickMarkup(), /9\s*999 ppm/);
  h.ui.state.data.domestic.rooms[4].co2.available = false;
  assert.match(h.ui.domesticQuickMarkup(), /Vzduch v ložnici<\/span><strong>—|Vzduch v ložnici<strong>—/);
  assert.equal(h.requests.length, 0);
});

test('v2 detail separates sensor readings, reported climate, target range and actual heating evidence', () => {
  const room = { id: 'living', name: 'Obývák', available: true,
    temperature: measure(0, '°C'), humidity: measure(42.125, '%'), co2: measure(0, 'ppm'), pm25: measure(1.125, 'μg/m³'),
    currentTemperature: 90, targetTemperature: 91,
    climate: { available: true, state: 'heat', reportedAction: 'heating', currentTemperature: 22.125, targetTemperature: 99, targetLow: 20.125, targetHigh: 24.375, unit: '°C' },
    heatingActive: null, heatingEvidence: { kind: 'unverified', available: false, powerW: null }, presence: [], equipment: [],
  };
  const h = harness({ roomsContractVersion: 2, rooms: [room] });
  let html = h.ui.domesticRoomDetail(room);
  assert.match(html, /Naměřeno<\/span><strong>0 °C/); assert.match(html, /Nastaveno<\/span><strong>20,125–24,375 °C/);
  assert.match(html, /42,125 %/); assert.match(html, /0 ppm/); assert.match(html, /1,125 μg\/m³/);
  assert.match(html, /Hlášená činnost regulátoru<\/span><span>Vytápění/);
  assert.match(html, /Teplota hlášená regulátorem<\/span><span>22,125 °C/);
  assert.match(html, /Skutečné topení<\/span><span>Neověřeno/); assert.doesNotMatch(html, />Topí<|90 °C|91 °C|99 °C/);
  room.heatingActive = false; room.heatingEvidence = { kind: 'measured_power', available: true, powerW: 0 };
  html = h.ui.domesticRoomDetail(room);
  assert.match(html, /Skutečné topení<\/span><span>Netopí/); assert.match(html, /Měřený příkon topení<\/span><span>0 W/);
  room.heatingActive = true; room.heatingEvidence.powerW = 125.25;
  assert.match(h.ui.domesticRoomDetail(room), /Skutečné topení<\/span><span>Topí/);
  room.heatingEvidence.available = false;
  assert.match(h.ui.domesticRoomDetail(room), /Skutečné topení<\/span><span>Neověřeno/);
  room.climate.available = false;
  html = h.ui.domesticRoomDetail(room);
  assert.match(html, /Režim regulátoru<\/span><span>Nedostupné/); assert.doesNotMatch(html, /22,125 °C|20,125–24,375/);
  assert.match(html, /Naměřeno<\/span><strong>0 °C/);
});

test('v2 room presence and equipment are explicit, tri-state, escaped and read-only including living-room AC', () => {
  const attack = '"><img src=x onerror=alert(1)>';
  const room = { id: 'living', name: 'Obývák', available: true, presence: [
    { name: 'Přítomnost', available: true, active: true, elapsedSeconds: 120 },
    { name: 'Bez pohybu', available: true, active: false, elapsedSeconds: 0 },
    { name: 'Neznámá přítomnost', available: true, active: null },
  ], equipment: [
    { name: 'Klimatizace', kind: 'climate', available: true, state: 'cool', reportedAction: 'cooling', targetLow: 20, targetHigh: 25, unit: '°C', service: 'climate.set_temperature', url: 'https://private.invalid/' },
    { name: 'Čistička', kind: 'purifier', available: true, active: false, percentage: 0 },
    { name: 'Okno', kind: 'window', available: true, active: null, elapsedSeconds: -1 },
    { name: 'Dveře', kind: 'door', available: true, active: false, elapsedSeconds: 60 },
    { name: 'Příkon AC', kind: 'power', available: true, value: 0, unit: 'W' },
    { name: attack, kind: 'temperature', available: true, value: 1.125, unit: attack },
    { name: 'Neznámý stav', kind: 'status', available: true, state: 'never_imply_ok' },
    { name: 'Nedostupný kontakt', kind: 'window', available: false, active: false },
  ] };
  const h = harness({ roomsContractVersion: 2, rooms: [room] });
  const html = h.ui.domesticRoomDetail(room);
  assert.match(html, /Přítomnost<\/span><span>Zjištěna přítomnost · od změny 2 min/);
  assert.match(html, /Bez pohybu<\/span><span>Bez přítomnosti · od změny 0 s/);
  assert.match(html, /Neznámá přítomnost<\/span><span>Stav neověřený/);
  assert.match(html, /Klimatizace<\/span><span>Režim: Chlazení · Hlásí: Chlazení · Cíl: 20–25 °C/);
  assert.match(html, /Čistička<\/span><span>Vypnuto · 0 %/); assert.match(html, /Příkon AC<\/span><span>0 W/);
  assert.match(html, /Okno<\/span><span>Stav neověřený/); assert.match(html, /Dveře<\/span><span>Zavřeno · od změny 1 min/);
  assert.match(html, /Neznámý stav<\/span><span>Stav neověřený/); assert.match(html, /Nedostupný kontakt<\/span><span>Nedostupné/);
  assert.match(html, /Skutečné topení<\/span><span>Neověřeno/);
  assert.ok(html.includes(esc(attack))); assert.doesNotMatch(html, /<img src=x|never_imply_ok|private\.invalid|climate\.set_temperature|<button|<input|Topí|od změny -/);
  h.click('domesticRoom', 'living'); assert.equal(h.dialogs.length, 1); assert.equal(h.requests.length, 0);
  h.node('#domestic-room-detail'); room.equipment[0].available = false;
  h.ui.syncDomestic(); assert.match(h.nodes.get('#domestic-room-detail').innerHTML, /Klimatizace<\/span><span>Nedostupné/);
  assert.equal(h.requests.length, 0);
});

test('v2 preserves small nonzero measurements and never treats unknown enum keys as known states', () => {
  const room = { id: 'well', name: 'Studna', available: true, temperature: measure(1e-25, '°C'), humidity: measure(50, '%', 'true'),
    equipment: [{ name: 'Průtok', kind: 'flow', available: true, value: 1e-25, unit: 'l/h' }] };
  const h = harness({ roomsContractVersion: 2, rooms: [room] });
  assert.equal(h.ui.domesticMetric(room.temperature, null), '0,0000000000000000000000001 °C');
  assert.match(h.ui.domesticRoomDetail(room), /0,0000000000000000000000001 l\/h/);
  assert.doesNotMatch(h.ui.renderDomesticRooms(), /50 %/);
  for (const value of ['__proto__', 'constructor', 'toString', 'https://private.invalid/']) {
    assert.equal(h.ui.domesticRoomReported(value), 'Stav neověřený');
    assert.equal(h.ui.domesticEquipmentState({ kind: 'status', available: true, state: value }), 'Stav neověřený');
  }
});

test('a stopped washer cannot show a countdown from a stale future completion timestamp', () => {
  const projected = washer('stop', 'none');
  assert.equal(projected.completionAvailable, false); assert.equal(projected.estimatedCompletion, null);
  const h = harness({ washer: projected });
  assert.equal(h.ui.window.HomeTVDomestic.washerCountdown(), 'Pračka právě neběží');
  assert.doesNotMatch(h.ui.domesticWasher(), /Odhadem zbývá|Odhad dokončení/);
  // Even if the browser still holds an earlier timestamp, a fresh stopped state wins.
  assert.equal(h.ui.window.HomeTVDomestic.washerCountdown({ ...projected, completionAvailable: true, estimatedCompletion: '2026-10-23T19:00:00Z' }), 'Pračka právě neběží');
  assert.match(h.ui.window.HomeTVDomestic.washerCountdown(washer('run')), /Odhadem zbývá 30 min/);
});

test('an elapsed estimate is never presented as a finished program without the program state', () => {
  const h = harness({ washer: washer('run', 'wash', '2026-10-23T18:01:00Z') });
  assert.match(h.ui.domesticWasherCountdown(), /Odhadem zbývá/);
  h.advance(61000);
  assert.equal(h.ui.domesticWasherCountdown(), 'Poslední odhad již uplynul');
  assert.doesNotMatch(h.ui.domesticWasher(), /Program hlásí dokončení|<h3>Dokončeno/);
  h.ui.state.data.domestic.washer.job.state = 'finish';
  assert.equal(h.ui.domesticWasherCountdown(), 'Program hlásí dokončení');
  h.ui.state.data.domestic.washer = washer('run', 'wash', '163');
  assert.equal(h.ui.domesticWasherCountdown(), 'Čas dokončení není dostupný');
});

test('washer progress is rendered only from an actual source percentage and totals remain labelled totals', () => {
  const h = harness({ washer: { ...washer('run'), energy: measure(201, 'kWh'), water: measure(15916.9, 'L') } });
  let html = h.ui.domesticWasher();
  assert.doesNotMatch(html, /<progress/); assert.match(html, /Celková energie/); assert.match(html, /Celková voda/);
  assert.doesNotMatch(html, /poslední(?:ho)? cykl/i);
  h.ui.state.data.domestic.washer = washer('run', 'wash', '2026-10-23T18:30:00Z', 0);
  assert.match(h.ui.domesticWasher(), /<progress max="100" value="0"/);
  h.ui.state.data.domestic.washer.progressPercent = 42;
  assert.match(h.ui.domesticWasher(), /<progress max="100" value="42"/);
});

test('HA labels, state strings and unit text are escaped in all domestic HTML surfaces', () => {
  const attack = '"><img src=x onerror=alert(1)>';
  const room = { id: attack, name: attack, unit: attack, available: true, state: attack, action: attack, currentTemperature: 21, targetTemperature: 23 };
  const h = harness({ energy: { consumers: [{ name: attack, powerW: null }] }, water: { valves: [{ name: attack, available: true, state: attack }] },
    rooms: [room], air: { rooms: [{ id: attack, name: attack, co2: measure(1, attack) }] },
    washer: { available: true, machine: { state: attack }, job: { available: true, state: attack } },
    vacuum: { name: attack, available: true, state: attack, selections: [{ name: attack, available: true }] } });
  const html = [h.ui.domesticEnergy(), h.ui.domesticWater(), h.ui.renderDomesticRooms(), h.ui.domesticRoomDetail(room), h.ui.domesticWasher(), h.ui.domesticVacuum()].join('');
  assert.ok(html.includes(esc(attack))); assert.doesNotMatch(html, /<img src=x|<script|data-domestic-room="">/);
  assert.ok(!html.includes(attack)); assert.equal(h.requests.length, 0);
});

test('map image is absent outside cleaning, remains independent of robot availability and cannot start a robot', () => {
  const h = harness({ vacuum: { available: false, batteryPercent: null, map: { available: true, url: '/api/vacuum/map', lastUpdated: '2026-10-23T17:50:00Z', lastRefreshOk: true }, selections: [{ name: 'Obývák', selected: true, available: true }] } });
  h.ui.render(); assert.doesNotMatch(h.markup, /src="\/api\/vacuum\/map"/);
  h.click('domesticSection', 'rooms'); assert.doesNotMatch(h.markup, /src="\/api\/vacuum\/map"/);
  h.click('domesticSection', 'cleaning'); assert.match(h.markup, /Robot nedostupný/);
  assert.match(h.markup, /loading="lazy" src="\/api\/vacuum\/map"/); assert.match(h.markup, /vacuum-control-disabled" disabled/);
  assert.doesNotMatch(h.markup, /Baterie <strong>0 %|<progress/);
  h.click('domesticSection', 'security'); assert.match(h.markup, /family-security/); assert.doesNotMatch(h.markup, /src="\/api\/vacuum\/map"/);
  h.ui.state.mode = 'offline'; h.click('domesticSection', 'cleaning');
  assert.doesNotMatch(h.markup, /src="\/api\/vacuum\/map"/); assert.match(h.markup, /Mapa není dostupná/);
  assert.equal(h.requests.length, 0); assert.equal(h.imageRequests.length, 0);
});

test('map image errors expose a manual retry without polling or device calls', () => {
  const h = harness({ vacuum: { map: { available: true, url: '/api/vacuum/map' } } });
  const image = h.node('#vacuum-map-image'), error = h.node('#vacuum-map-error'); error.classes.add('hidden');
  h.ui.syncDomestic(); h.ui.syncDomestic(); assert.equal(image.events.get('error').length, 1);
  image.emit('error'); assert.equal(image.classList.contains('hidden'), true); assert.equal(error.classList.contains('hidden'), false);
  assert.equal(h.imageRequests.length, 0); assert.equal(h.requests.length, 0);
  h.click('domesticMap', 'retry');
  assert.equal(image.classList.contains('hidden'), false); assert.equal(error.classList.contains('hidden'), true);
  assert.deepEqual(h.imageRequests, ['/api/vacuum/map']); assert.equal(h.requests.length, 0);
  assert.equal(image.events.get('error').length, 1);
});

test('live installations hide cards and sections whose sources are not configured', () => {
  const h = harness({ energy: { powerW: null, consumers: [{ name: 'Zásuvka', powerW: 5 }] }, water: { valves: [] }, hotWater: {}, washer: {}, vacuum: { map: { available: false } },
    roomsContractVersion: 2, rooms: [{ id: 'obyvak', name: 'Obývák', temperature: measure(23.4, '°C'), humidity: measure(51, '%'), co2: measure(null, 'ppm', false), presence: [], equipment: [] }] });
  assert.match(h.ui.domesticEnergy(), /Zásuvka/); assert.doesNotMatch(h.ui.domesticEnergy(), /Celkový příkon/);
  assert.equal(h.ui.domesticWater(), '');
  const quick = h.ui.domesticQuickMarkup();
  assert.match(quick, /Obývák/); assert.doesNotMatch(quick, /Dům právě teď|Hladina studny|Pračka|Vzduch v ložnici/);
  h.ui.render(); assert.doesNotMatch(h.markup, /data-domestic-section="cleaning"/); assert.match(h.markup, /data-domestic-section="overview"/);
});
