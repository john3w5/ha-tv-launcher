import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function declaration(name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\s*\\(', 'm').exec(app);
  assert.ok(match, 'Actual app navigation declaration must exist: ' + name);
  const start = match.index, body = app.indexOf('{', start);
  let depth = 0, quote = '', comment = '';
  for (let index = body; index < app.length; index++) {
    const character = app[index], next = app[index + 1];
    if (comment === '//') { if (character === '\n') comment = ''; continue; }
    if (comment === '/*') { if (character === '*' && next === '/') { comment = ''; index++; } continue; }
    if (quote) { if (character === '\\') index++; else if (character === quote) quote = ''; continue; }
    if (character === '/' && (next === '/' || next === '*')) { comment = '/' + next; index++; continue; }
    if (['"', "'", '`'].includes(character)) { quote = character; continue; }
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return app.slice(start, index + 1);
  }
  throw new Error('Unterminated app declaration: ' + name);
}

class Element {
  constructor(document, tag, attributes = {}, rect = {}) {
    this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.attributes = {}; this.dataset = {}; this.children = []; this.parentNode = null;
    this.disabled = false; this.visible = true; this.focusCalls = [];
    this.rect = { x: 0, y: 0, width: 80, height: 40, ...rect };
    this.classes = new Set(); this.classList = { contains: key => this.classes.has(key), add: key => this.classes.add(key), remove: key => this.classes.delete(key), toggle: (key, value) => value ? this.classes.add(key) : this.classes.delete(key) };
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
  }
  get id() { return this.attributes.id || ''; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  get controls() { return this.hasAttribute('controls'); }
  get tabIndex() { const value = this.getAttribute('tabindex'); return value === null ? ['BUTTON', 'INPUT', 'SELECT', 'A'].includes(this.tagName) ? 0 : -1 : Number(value); }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'class') this.classes = new Set(String(value).split(/\s+/));
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(key) { return this.attributes[key] ?? null; }
  getAttributeNames() { return Object.keys(this.attributes); }
  hasAttribute(key) { return this.getAttribute(key) !== null; }
  append(...elements) { for (const element of elements) { element.parentNode = this; this.children.push(element); } }
  remove() { if (this.parentNode) { if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body; this.parentNode.children = this.parentNode.children.filter(element => element !== this); this.parentNode = null; } }
  set innerHTML(value) { this.html = String(value); if (this.onHTML) this.onHTML(value); }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      if (part.includes(' ')) { const pieces = part.split(/\s+/); return this.matches(pieces.pop()) && Boolean(this.parentNode?.closest(pieces.join(' '))); }
      const plain = part.replace(/\[[^\]]+\]/g, '');
      const tag = /^[a-z]+/i.exec(plain)?.[0]; if (tag && this.tagName !== tag.toUpperCase()) return false;
      const id = /#([\w-]+)/.exec(plain)?.[1]; if (id && this.id !== id) return false;
      for (const match of plain.matchAll(/\.([\w-]+)/g)) if (!this.classes.has(match[1])) return false;
      for (const match of part.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
        if (!this.hasAttribute(match[1]) || (match[2] !== undefined && this.getAttribute(match[1]) !== match[2])) return false;
      }
      return true;
    });
  }
  closest(selector) { let node = this; while (node) { if (node.matches(selector)) return node; node = node.parentNode; } return null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => child.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() { if (!this.visible || this.parentNode && !this.parentNode.getClientRects().length) return []; return [this.getBoundingClientRect()]; }
  getBoundingClientRect() { const rect = this.rect; return { ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }; }
  focus(options) { this.ownerDocument.activeElement = this; this.focusCalls.push(options); }
}

function harness(names = ['focusables', 'moveFocus', 'keyboard', 'isWideTv', 'focusControl'], options = {}) {
  const document = { activeElement: null, querySelector(selector) { return this.body.querySelector(selector); }, querySelectorAll(selector) { return this.body.querySelectorAll(selector); }, getElementById(id) { return this.querySelector('#' + id); } };
  document.body = new Element(document, 'body'); document.activeElement = document.body;
  const make = (tag, attrs, rect, parent = document.body) => { const element = new Element(document, tag, attrs, rect); parent.append(element); return element; };
  const shell = make('div', { id: 'app-shell' }), header = make('header', { class: 'topbar' }, {}, shell), nav = make('nav', { class: 'navigation' }, {}, header);
  const tabs = ['home', 'media', 'cameras', 'calendar', 'household', 'apps'].map((tab, index) => make('button', { 'data-tab': tab }, { x: 100 + index * 110, y: 10 }, nav));
  const main = make('main', { id: 'main-content' }, {}, shell), view = make('section', { id: 'view-content' }, {}, main);
  make('section', { id: 'saver-status' });
  const state = { dialog: false, saver: false, tab: 'home', pointer: false, lastInput: 0, data: { cameras: [] }, bootstrap: {}, photos: [], tvApps: [], cursor: { x: 0, y: 0 }, failures: 0, appFocusIntent: options.isTv === false ? null : 'initial', appReturnPending: false, lastLaunchedTvApp: null };
  const handlers = new Map(), sounds = [];
  const sandbox = { state, document, isTv: options.isTv !== false, innerWidth: 1440, innerHeight: 900, AbortSignal: { timeout: milliseconds => ({ milliseconds }) }, uiPaging: { apps: 0, collection: 'tv' },
    CSS: { escape: value => String(value) }, requestAnimationFrame() {}, stopOverviewCamera() {}, syncOverviewCamera() {}, syncHousehold() {}, syncDomestic() {},
    renderHome: () => '', renderMedia: () => '', renderCalendar: () => '', renderDomov: () => '', renderApplications: () => '', cameraCard: () => '', appsMarkup: () => '', tvAppsMarkup: () => '', focusTvAppTile: () => false,
    addEventListener(type, fn) { handlers.set(type, fn); }, scrollTo() {},
    NavigationSound: { play: kind => sounds.push(kind) },
    $: (selector, scope = document) => scope.querySelector(selector), $$: (selector, scope = document) => scope.querySelectorAll(selector),
    stopSaver() { state.saver = false; }, startSaver() { state.saver = true; }, closeDialog() { state.dialog = false; }, setTab(tab) { state.tab = tab; }, setPointer() {},
    render() {}, normalize: value => value, applyAppearance() {}, updateBadges() {}, connectEvents() {}, unavailableData: () => ({}), homeStrip: () => '', notify() {}, showHouse() {} };
  sandbox.window = sandbox;
  if (names.includes('refresh') && !names.includes('refreshNow')) names = [...names, 'refreshNow'];
  const designStart = app.indexOf('const tvAppDesign = {'), designEnd = app.indexOf('\n};', designStart) + 3;
  vm.runInNewContext(app.slice(designStart, designEnd) + '\n' + app.match(/^const esc = .*$/m)[0] + '\nlet refreshingDashboard=null;\n' + names.map(declaration).join('\n'), sandbox);
  const key = (name, options = {}) => { const event = { key: name, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options }; sandbox.keyboard(event); return event; };
  return { ui: sandbox, state, document, make, shell, header, nav, tabs, view, key, handlers, sounds };
}

test('focusables excludes the decorative overview video, disabled/hidden controls and retains real media controls', () => {
  const h = harness();
  const card = h.make('button', { 'data-camera': 'entrance' }, { x: 400, y: 200 }, h.view);
  const preview = h.make('video', { id: 'overview-camera-video', tabindex: '-1', 'aria-hidden': 'true' }, { x: 400, y: 200 }, card);
  const controlled = h.make('video', { controls: '', tabindex: '0' }, { x: 200, y: 300 }, h.view);
  const disabled = h.make('button', {}, {}, h.view); disabled.disabled = true;
  const hidden = h.make('button', {}, {}, h.view); hidden.visible = false;
  const hiddenAria = h.make('button', { 'aria-hidden': 'true' }, {}, h.view);
  const items = h.ui.focusables();
  assert.ok(items.includes(card)); assert.ok(items.includes(controlled));
  for (const excluded of [preview, disabled, hidden, hiddenAria]) assert.equal(items.includes(excluded), false);
});

test('focus candidates remain inside the current dialog or screensaver', () => {
  const h = harness(); const dialog = h.make('div', { class: 'dialog' }); const close = h.make('button', {}, {}, dialog);
  h.state.dialog = true; assert.deepEqual([...h.ui.focusables()], [close]);
  h.state.dialog = false; const saver = h.make('section', { id: 'screensaver' }); const back = h.make('button', {}, {}, saver);
  h.state.saver = true; assert.deepEqual([...h.ui.focusables()], [back]);
});

test('spatial navigation moves between cards without ever focusing the decorative video', () => {
  const h = harness();
  const first = h.make('button', { 'data-app': 'a' }, { x: 100, y: 300 }, h.view);
  const second = h.make('button', { 'data-camera': 'entrance' }, { x: 300, y: 300 }, h.view);
  const preview = h.make('video', { tabindex: '-1', 'aria-hidden': 'true' }, { x: 220, y: 300 }, second);
  first.focus(); h.key('ArrowRight'); assert.equal(h.document.activeElement, second); assert.equal(preview.focusCalls.length, 0);
});

test('a previously focused decorative video cannot trap all subsequent remote arrow keys', () => {
  const h = harness(); const card = h.make('button', { 'data-camera': 'entrance' }, { x: 300, y: 300 }, h.view);
  const preview = h.make('video', { tabindex: '-1', 'aria-hidden': 'true' }, {}, card);
  preview.focus(); const event = h.key('ArrowRight');
  assert.equal(event.defaultPrevented, true); assert.notEqual(h.document.activeElement, preview);
  assert.ok(h.ui.focusables().includes(h.document.activeElement));
});

test('left/right navigation inside the top menu chooses adjacent tabs instead of a geometrically closer icon', () => {
  const h = harness(); const outside = h.make('button', { id: 'notices-button' }, { x: 200, y: 12 }, h.shell);
  h.tabs[0].focus(); h.key('ArrowRight'); assert.equal(h.document.activeElement, h.tabs[1]);
  h.key('ArrowLeft'); assert.equal(h.document.activeElement, h.tabs[0]); assert.equal(outside.focusCalls.length, 0);
  const played = h.sounds.length;
  h.key('ArrowLeft'); assert.ok(h.tabs.includes(h.document.activeElement), 'Menu edge must remain in the navigation group');
  assert.equal(h.sounds.length, played, 'Clamped group edge must remain silent');
});

test('already handled map/repeat events do not cause a second application navigation step', () => {
  const h = harness(); h.tabs[0].focus(); h.key('ArrowRight', { defaultPrevented: true }); assert.equal(h.document.activeElement, h.tabs[0]);
});

test('real controlled media retains its native arrow controls while decorative media does not', () => {
  const h = harness(); const player = h.make('video', { controls: '', tabindex: '0' }, {}, h.view);
  player.focus(); const event = h.key('ArrowRight'); assert.equal(event.defaultPrevented, false); assert.equal(h.document.activeElement, player);
});

test('capture/restore preserves every unique data identity and uses id when available', () => {
  const h = harness(['captureViewFocus', 'restoreViewFocus']);
  for (const attributes of [{ 'data-action': 'night' }, { 'data-security': 'home' }, { 'data-calendar-day': '2026-10-24' }, { 'data-domestic-room': 'living' }, { 'data-tv-app': 'com.netflix.ninja' }, { id: 'vacuum-map-button' }]) {
    const old = h.make('button', attributes, {}, h.view); old.focus(); const token = h.ui.captureViewFocus(h.view);
    assert.ok(token); old.remove(); const replacement = h.make('button', attributes, {}, h.view);
    h.ui.restoreViewFocus(h.view, token); assert.equal(h.document.activeElement, replacement);
    assert.equal(replacement.focusCalls.at(-1).preventScroll, true); replacement.remove();
  }
});

test('focus capture avoids ambiguous shared actions and restore never steals a preserved connected focus', () => {
  const h = harness(['captureViewFocus', 'restoreViewFocus']);
  const a = h.make('button', { 'data-action': 'night' }, {}, h.view), b = h.make('button', { 'data-action': 'night', 'data-control': 'specific' }, {}, h.view);
  a.focus(); assert.equal(h.ui.captureViewFocus(h.view), null);
  b.focus(); const token = h.ui.captureViewFocus(h.view); assert.equal(token.attribute, 'data-control');
  const before = b.focusCalls.length; h.ui.restoreViewFocus(h.view, token); assert.equal(b.focusCalls.length, before);
  h.tabs[0].focus(); assert.equal(h.ui.captureViewFocus(h.view), null);
});

test('actual render invokes capture/restore when a focused action is recreated during refresh', () => {
  const h = harness(['captureViewFocus', 'restoreViewFocus', 'render', 'refresh']);
  h.state.mode = 'live';
  let button = h.make('button', { 'data-action': 'night' }, {}, h.view); button.focus(); const previous = button;
  h.view.onHTML = () => { for (const child of [...h.view.children]) child.remove(); button = h.make('button', { 'data-action': 'night' }, {}, h.view); };
  h.ui.fetch = async () => ({ ok: true, json: async () => ({ mode: 'live', cameras: [] }) });
  return h.ui.refresh().then(() => {
    assert.equal(h.state.mode, 'live'); assert.notEqual(button, previous); assert.equal(previous.isConnected, false);
    assert.equal(h.document.activeElement, button); assert.equal(button.focusCalls.at(-1).preventScroll, true);
    assert.deepEqual(h.sounds, [], 'Automatic refresh restoration must never play user-navigation sounds');
  });
});

test('actual focus changes play move, Enter on a button plays select, and handled events remain silent', () => {
  const h = harness(); h.tabs[0].focus();
  h.key('ArrowLeft'); assert.deepEqual(h.sounds, []);
  h.key('ArrowRight'); assert.deepEqual(h.sounds, ['move']);
  h.key('Enter'); assert.deepEqual(h.sounds, ['move', 'select']);
  h.key('ArrowRight', { defaultPrevented: true }); assert.deepEqual(h.sounds, ['move', 'select']);
  const player = h.make('video', { controls: '', tabindex: '0' }, {}, h.view); player.focus();
  h.key('Enter'); assert.deepEqual(h.sounds, ['move', 'select'], 'Media controls keep their own input without a navigation beep');
});

test('CH tab helper wraps main tabs, focuses the header, rejects malformed steps and respects open dialogs/saver', () => {
  const h = harness(['stepMainTab']);
  h.ui.stepMainTab(1); assert.equal(h.state.tab, 'media'); assert.equal(h.document.activeElement, h.tabs[1]);
  h.ui.stepMainTab(-1); assert.equal(h.state.tab, 'home'); h.ui.stepMainTab(-1); assert.equal(h.state.tab, 'apps'); assert.equal(h.document.activeElement, h.tabs[5]);
  for (const direction of [0, 2, '1', null, NaN]) { h.ui.stepMainTab(direction); assert.equal(h.state.tab, 'apps'); }
  h.state.dialog = true; h.ui.stepMainTab(1); assert.equal(h.state.tab, 'apps');
  h.state.dialog = false; h.state.saver = true; h.ui.stepMainTab(1); assert.equal(h.state.tab, 'apps');
});

test('actual tv-tab-step listener forwards native CH direction to the real tab helper', () => {
  const h = harness(['stepMainTab']);
  const listener = app.split('\n').find(line => line.startsWith("window.addEventListener('tv-tab-step',")); assert.ok(listener);
  vm.runInNewContext(listener, h.ui);
  h.handlers.get('tv-tab-step')({ detail: { direction: 1 } }); assert.equal(h.state.tab, 'media'); assert.equal(h.document.activeElement, h.tabs[1]);
  h.handlers.get('tv-tab-step')({ detail: { direction: -1 } }); assert.equal(h.state.tab, 'home');
});

const NETFLIX='com.netflix.ninja',ONEPLAY='net.cme.voyo.cz.tvapp',PRIMA='cz.prima.tvapp';
function appHarness(options={}){
  const names=['focusables','moveFocus','keyboard','isWideTv','focusControl','focusTvAppTile','restoreTvAppFocus','nativeTvAppUrl','rememberTvAppLaunch','activateTvApp','launchTvApp','launchTvAppFromServer','loadTvApps','applyNativeTvApps','tvAppsMarkup','homeAppsMarkup','setTab','captureViewFocus','restoreViewFocus','render','stepMainTab'];
  const h=harness(names,options);h.document.hidden=false;h.state.tvApps=[NETFLIX,ONEPLAY,PRIMA].map(appId=>({appId}));h.state.bootstrap={authenticated:true,assistant:{tvControl:true}};
  h.ui.location={href:'http://home-tv.local:4317/'};h.cache=[];h.ui.localStorage={setItem:(key,value)=>h.cache.push({key,value})};h.requests=[];
  h.ui.fetch=async(url,init)=>{h.requests.push({url,init});return{ok:true,json:async()=>({accepted:true,apps:[]})};};
  h.view.onHTML=()=>{
    for(const child of [...h.view.children])child.remove();
    if(!['home','apps'].includes(h.state.tab))return;
    h.grid=h.make('div',{class:'app-grid tv-app-grid'},{},h.view);
    h.tiles=h.state.tvApps.map((app,index)=>h.make('a',{class:'app-item native-app','data-tv-app':app.appId,href:h.ui.nativeTvAppUrl(app.appId)},{x:100+index*110,y:300,height:90},h.grid));
  };
  h.ui.render();return h;
}

test('TV startup selects Netflix directly on the existing Home overview and automatic refresh preserves later user focus',()=>{
  const h=appHarness();assert.equal(h.state.tab,'home');assert.equal(h.document.activeElement,h.tiles[0]);assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);assert.deepEqual(h.sounds,[]);
  h.tiles[1].focus();h.ui.render();assert.equal(h.document.activeElement.dataset.tvApp,ONEPLAY);
  h.tabs[3].focus();h.ui.render();assert.equal(h.document.activeElement,h.tabs[3]);assert.deepEqual(h.sounds,[]);
});

test('late native catalog fulfills pending initial focus, while an unchanged or refreshed catalog never steals user focus',async()=>{
  const h=appHarness();h.state.tvApps=[];h.state.appFocusIntent='initial';h.document.activeElement=h.document.body;h.ui.render();
  await h.ui.loadTvApps();assert.equal(h.requests.length,0,'Native TV must never query the Mac/ADB catalog route');assert.equal(h.state.tvApps.length,0);
  assert.equal(h.ui.applyNativeTvApps({appIds:[PRIMA,NETFLIX,ONEPLAY,'unapproved.package']}),true);
  assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);assert.deepEqual(Array.from(h.state.tvApps,app=>app.appId),[NETFLIX,ONEPLAY,PRIMA]);
  h.tiles[1].focus();h.ui.applyNativeTvApps({appIds:[NETFLIX,ONEPLAY,PRIMA]});h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement.dataset.tvApp,ONEPLAY);
  h.tabs[3].focus();h.ui.applyNativeTvApps({appIds:[NETFLIX,ONEPLAY]});h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement,h.tabs[3]);
});

test('a user navigation before the delayed initial catalog cancels automatic focus takeover',()=>{
  const h=appHarness();h.state.tvApps=[];h.state.appFocusIntent='initial';h.document.activeElement=h.document.body;h.ui.render();
  h.ui.focusControl(h.tabs[2]);h.ui.applyNativeTvApps({appIds:[NETFLIX,ONEPLAY]});h.ui.restoreTvAppFocus();
  assert.equal(h.document.activeElement,h.tabs[2]);assert.equal(h.state.appFocusIntent,null);
});

test('automatic Chromium wordmark or header focus never cancels the pending initial app selection',()=>{
  for(const initialTarget of ['wordmark','home-header']){
    const h=appHarness();h.state.tvApps=[];h.state.appFocusIntent='initial';h.document.activeElement=h.document.body;h.ui.render();
    const automatic=initialTarget==='wordmark'?h.make('a',{class:'wordmark',href:'/'},{x:10,y:10},h.shell):h.tabs[0];
    automatic.focus();assert.equal(h.state.appFocusIntent,'initial','Browser/WebView focus is not a user navigation action');
    h.ui.applyNativeTvApps({appIds:[NETFLIX,ONEPLAY]});
    assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);assert.equal(h.state.appFocusIntent,null);assert.deepEqual(h.sounds,[]);
    h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);
  }
});

test('a hidden native catalog preserves the pending Home focus until the document is visible',()=>{
  const h=appHarness();h.state.tvApps=[];h.state.appFocusIntent='first';h.document.activeElement=h.document.body;h.document.hidden=true;h.ui.render();
  h.ui.applyNativeTvApps({appIds:[NETFLIX,ONEPLAY]});h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement,h.document.body);assert.equal(h.state.appFocusIntent,'first');
  h.document.hidden=false;h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);assert.equal(h.state.appFocusIntent,null);
});

test('a resume following its native catalog returns to Home Netflix only once',()=>{
  const h=appHarness();h.ui.rememberTvAppLaunch(ONEPLAY);h.document.hidden=true;h.ui.applyNativeTvApps({appIds:[NETFLIX,ONEPLAY]});
  h.document.hidden=false;h.ui.restoreTvAppFocus();assert.equal(h.state.tab,'home');assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);assert.equal(h.state.appReturnPending,false);
  const focused=h.document.activeElement,before=focused.focusCalls.length;h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement,focused);assert.equal(focused.focusCalls.length,before);
});

test('a native catalog removing the currently focused installed app selects a remaining tile instead of stranding focus on body',()=>{
  const h=appHarness();h.tiles[1].focus();h.ui.applyNativeTvApps({appIds:[NETFLIX,PRIMA]});assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);
});

test('authoritative empty native catalog clears cached shortcuts and reports unavailable instead of endless loading',()=>{
  const h=appHarness();assert.equal(h.ui.applyNativeTvApps({appIds:[]}),true);assert.equal(h.state.nativeAppsReceived,true);assert.equal(h.state.tvApps.length,0);
  assert.match(h.ui.homeAppsMarkup(),/nejsou.*dostupné/);assert.doesNotMatch(h.ui.homeAppsMarkup(),/Načítám/);assert.deepEqual(JSON.parse(h.cache.at(-1).value).ids,[]);
  for(const invalid of [null,{}, {appIds:'all'}, {appIds:[1]}, {appIds:Array(257).fill(NETFLIX)}])assert.equal(h.ui.applyNativeTvApps(invalid),false);
});

test('explicit Home and Apps select Netflix, while CH switching returns Home with its header selected',()=>{
  const h=appHarness();h.tiles[2].focus();h.state.pointer=true;h.ui.setTab('home');
  assert.equal(h.state.tab,'home');assert.equal(h.state.pointer,false);assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);
  h.ui.uiPaging.collection='web';h.ui.uiPaging.apps=2;h.tabs[5].focus();h.ui.setTab('apps');
  assert.equal(h.ui.uiPaging.collection,'tv');assert.equal(h.ui.uiPaging.apps,0);assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);
  h.ui.stepMainTab(1);assert.equal(h.state.tab,'home');assert.equal(h.document.activeElement,h.tabs[0]);assert.equal(h.state.appFocusIntent,null);
});

test('return from any native app selects Netflix, while a dialog or saver keeps its focus',()=>{
  const h=appHarness();h.ui.rememberTvAppLaunch(ONEPLAY);h.document.hidden=true;h.ui.restoreTvAppFocus();assert.equal(h.state.appReturnPending,true);
  h.document.hidden=false;h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);assert.equal(h.state.appReturnPending,false);
  h.ui.rememberTvAppLaunch(PRIMA);h.state.dialog=true;const focused=h.document.activeElement;h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement,focused);
  h.state.dialog=false;h.state.saver=true;h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement,focused);
  h.state.saver=false;h.state.appFocusIntent='first';h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX,'An explicit Home request wins over the old launched app');
});

test('native tiles are real exact-URI anchors and Enter retains browser default activation',()=>{
  const h=appHarness(),markup=h.ui.tvAppsMarkup(6);
  assert.equal((markup.match(/<a /g)||[]).length,3);assert.equal((markup.match(/<button /g)||[]).length,0);assert.match(markup,/href="hometv:\/\/launch\?appId=com\.netflix\.ninja"/);
  const event=h.key('Enter');assert.equal(event.defaultPrevented,false);assert.equal(h.requests.length,0);
  const click={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
  h.ui.activateTvApp(click,h.tiles[0]);assert.equal(click.defaultPrevented,false);assert.equal(h.state.lastLaunchedTvApp,NETFLIX);assert.equal(h.state.appReturnPending,true);assert.equal(h.requests.length,0);assert.equal(h.ui.location.href,'http://home-tv.local:4317/','The native anchor default handles navigation, without a second scripted redirect');
});

test('installed applications view shows the entire retained catalog at once without paging or disabled packages',()=>{
  const h=appHarness();
  h.ui.icon=name=>`<svg data-icon="${name}"></svg>`;
  vm.runInNewContext(declaration('renderApplications'),h.ui);
  const retained=Array.from(vm.runInNewContext('Object.keys(tvAppDesign)',h.ui));
  h.ui.applyNativeTvApps({appIds:[...retained,'com.amazon.amazonvideo.livingroom','com.unapproved.game']});
  h.ui.uiPaging.apps=1;
  const markup=h.ui.renderApplications();
  assert.equal((markup.match(/data-tv-app=/g)||[]).length,retained.length);
  assert.equal(retained.length,12);
  assert.doesNotMatch(markup,/data-ui-page="apps"|com\.amazon|com\.unapproved/);
  assert.match(markup,/data-tv-app="com.netflix.ninja"/);
  assert.match(markup,/data-tv-app="flar2.homebutton"/);
  assert.match(markup,/utility-brand/);
  assert.equal(h.ui.uiPaging.apps,0);
});

test('the TV launch function chooses its bounded native URI synchronously without any HTTP or Promise hop',()=>{
  const h=appHarness();const result=h.ui.launchTvApp(ONEPLAY);
  assert.equal(result,undefined);assert.equal(h.ui.location.href,'hometv://launch?appId='+ONEPLAY);assert.equal(h.requests.length,0);
  for(const invalid of ['com.android.settings','com.netflix.ninja&other=1','constructor','__proto__',null])assert.equal(h.ui.nativeTvAppUrl(invalid),null);
  h.ui.location.href='unchanged';h.ui.launchTvApp('com.android.settings');assert.equal(h.ui.location.href,'unchanged');assert.equal(h.requests.length,0);
});

test('modified or uninstalled native anchor targets are canceled instead of invoking an alternate launch path',()=>{
  const h=appHarness(),tile=h.tiles[0];tile.setAttribute('href','hometv://launch?appId='+ONEPLAY);
  let prevented=0;h.ui.activateTvApp({preventDefault(){prevented++;}},tile);assert.equal(prevented,1);assert.equal(h.state.lastLaunchedTvApp,null);assert.equal(h.ui.location.href,'http://home-tv.local:4317/');
  tile.setAttribute('href',h.ui.nativeTvAppUrl(NETFLIX));h.state.tvApps=[];h.ui.activateTvApp({preventDefault(){prevented++;}},tile);assert.equal(prevented,2);assert.equal(h.requests.length,0);
});

test('PC launch keeps the server route and read-only preview cannot launch through HTTP or the native scheme',async()=>{
  const h=appHarness({isTv:false});assert.match(h.ui.tvAppsMarkup(6),/<button /);assert.doesNotMatch(h.ui.tvAppsMarkup(6),/href="hometv:/);
  await h.ui.launchTvApp(NETFLIX);assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/api/tv/launch');assert.deepEqual(JSON.parse(h.requests[0].init.body),{appId:NETFLIX});
  h.state.bootstrap.preview={readOnly:true};h.requests.length=0;await h.ui.launchTvApp(NETFLIX);assert.equal(h.requests.length,0);assert.equal(h.ui.location.href,'http://home-tv.local:4317/');
  const native=appHarness();native.state.bootstrap.preview={readOnly:true};assert.doesNotMatch(native.ui.tvAppsMarkup(6),/href="hometv:/);await native.ui.launchTvApp(NETFLIX);assert.equal(native.requests.length,0);assert.equal(native.state.lastLaunchedTvApp,null);
});

test('app grids clamp left/right to the current row and header Down returns to the first app rather than a decorative control',()=>{
  const h=appHarness();h.tiles[0].focus();h.key('ArrowRight');assert.equal(h.document.activeElement,h.tiles[1]);h.key('ArrowLeft');assert.equal(h.document.activeElement,h.tiles[0]);
  const played=h.sounds.length;h.key('ArrowLeft');assert.equal(h.document.activeElement,h.tiles[0]);assert.equal(h.sounds.length,played);
  const nextRow=h.make('a',{'data-tv-app':'next-row',href:'#'},{x:435,y:450,height:90},h.grid);h.tiles[2].focus();h.key('ArrowRight');assert.equal(h.document.activeElement,h.tiles[2]);assert.notEqual(h.document.activeElement,nextRow);
  h.tabs[0].focus();h.make('button',{'data-action':'trap'},{x:100,y:75},h.view);h.key('ArrowDown');assert.equal(h.document.activeElement,h.tiles[0]);
  const quick=h.make('button',{'data-action':'quick'},{x:100,y:200},h.view);h.key('ArrowUp');assert.equal(h.document.activeElement,quick);
});

test('Apps next/previous page handler selects the first tile of the new page, without retaining pager focus',()=>{
  const h=appHarness();h.ui.setTab('apps');
  const clickLine=app.split('\n').find(line=>line.startsWith("document.addEventListener('click',e=>"));assert.ok(clickLine);
  h.document.addEventListener=(type,callback)=>h.handlers.set(type,callback);vm.runInNewContext(clickLine,h.ui);
  h.view.onHTML=()=>{
    for(const child of [...h.view.children])child.remove();h.grid=h.make('div',{class:'app-grid tv-app-grid'},{},h.view);
    const ids=h.ui.uiPaging.apps===1?[PRIMA]:[NETFLIX,ONEPLAY];h.tiles=ids.map((id,index)=>h.make('a',{'data-tv-app':id,href:h.ui.nativeTvAppUrl(id)},{x:100+index*110,y:300,height:90},h.grid));
  };
  for(const [step,expected] of [[1,PRIMA],[-1,NETFLIX]]){
    const pager=h.make('button',{'data-ui-page':'apps','data-page-step':String(step)},{},h.view);pager.focus();
    h.handlers.get('click')({target:pager,isTrusted:false,detail:0,preventDefault(){}});
    assert.equal(h.document.activeElement.dataset.tvApp,expected);assert.equal(h.document.activeElement.hasAttribute('data-ui-page'),false);
  }
});

test('returning from an app on a later Apps page opens Home Netflix even when native catalog precedes visible resume',()=>{
  const h=appHarness();h.ui.setTab('apps');h.ui.uiPaging.apps=2;
  h.view.onHTML=()=>{
    for(const child of [...h.view.children])child.remove();h.grid=h.make('div',{class:'app-grid tv-app-grid'},{},h.view);
    const ids=h.state.tab==='apps'?[PRIMA]:[NETFLIX,ONEPLAY,PRIMA];h.tiles=ids.map((id,index)=>h.make('a',{'data-tv-app':id,href:h.ui.nativeTvAppUrl(id)},{x:100+index*110,y:300,height:90},h.grid));
  };
  h.ui.render();h.tiles[0].focus();h.ui.rememberTvAppLaunch(PRIMA);h.document.hidden=true;
  h.ui.applyNativeTvApps({appIds:[NETFLIX,ONEPLAY,PRIMA]});h.ui.restoreTvAppFocus();assert.equal(h.state.tab,'apps');assert.equal(h.state.appReturnPending,true);
  h.document.hidden=false;h.ui.restoreTvAppFocus();assert.equal(h.state.tab,'home');assert.equal(h.ui.uiPaging.apps,0);assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);assert.equal(h.state.appReturnPending,false);
  h.tiles[1].focus();h.ui.applyNativeTvApps({appIds:[NETFLIX,ONEPLAY,PRIMA]});h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement.dataset.tvApp,ONEPLAY,'A later ordinary catalog event must not reset live user navigation');
});

test('a real background/visible entry and its later native resume override automatic header focus, even after an early launch callback consumed its flag',()=>{
  const h=appHarness();h.ui.updateWeatherBackground=()=>{};h.document.addEventListener=(type,callback)=>h.handlers.set(type,callback);
  const listener=app.split('\n').find(line=>line.startsWith("document.addEventListener('visibilitychange',"));assert.ok(listener);vm.runInNewContext(listener,h.ui);
  h.ui.rememberTvAppLaunch(ONEPLAY);h.ui.restoreTvAppFocus({type:'tv-resume'});assert.equal(h.state.appReturnPending,false);
  h.document.hidden=true;h.handlers.get('visibilitychange')();assert.equal(h.state.menuReturnPending,true);
  h.document.hidden=false;h.handlers.get('visibilitychange')();assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);
  const appearance=h.make('button',{id:'appearance-button'},{x:800,y:10},h.header);appearance.focus();
  h.ui.restoreTvAppFocus({type:'tv-resume'});assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);assert.equal(h.state.menuReturnPending,false);
  h.ui.focusControl(h.tabs[3]);h.ui.restoreTvAppFocus({type:'tv-resume'});assert.equal(h.document.activeElement,h.tabs[3]);
});

test('actual user navigation after visible return cancels the still-pending native-resume focus pass',()=>{
  const h=appHarness();h.state.menuReturnPending=true;h.ui.restoreTvAppFocus();assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);
  h.ui.focusControl(h.tiles[1]);assert.equal(h.state.menuReturnPending,false);h.ui.restoreTvAppFocus({type:'tv-resume'});assert.equal(h.document.activeElement.dataset.tvApp,ONEPLAY);
});

test('menu selection prefers the exact installed Netflix ID and falls back only when Netflix is absent',()=>{
  const h=appHarness();h.state.tvApps=[ONEPLAY,NETFLIX,PRIMA].map(appId=>({appId}));h.state.appFocusIntent='first';h.ui.render();assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);
  h.state.tvApps=[ONEPLAY,PRIMA].map(appId=>({appId}));h.state.appFocusIntent='first';h.ui.render();assert.equal(h.document.activeElement.dataset.tvApp,ONEPLAY);
});

function modalHarness(){
  const h=appHarness(),frames=[];h.ui.requestAnimationFrame=fn=>frames.push(fn);h.flushFrames=()=>{while(frames.length)frames.shift()();};
  h.ui.clearInterval=()=>{};h.ui.closeDomesticDialog=()=>{};h.ui.clearNightConfirmation=()=>{};h.ui.updateWeatherBackground=()=>{};h.ui.selectedSecurityId=null;
  const root=h.make('div',{id:'dialog-root'});root.onHTML=()=>{for(const child of [...root.children])child.remove();};
  h.dialogRoot=root;h.make('section',{id:'screensaver'});h.make('button',{id:'screensaver-button'},{x:1100,y:10},h.header);
  vm.runInNewContext(['queueHomeAppFocus','closeDialog','stopSaver'].map(declaration).join('\n'),h.ui);return h;
}

test('closing a Home dialog and exiting the Home saver select Netflix after guarded frame focus',()=>{
  const h=modalHarness();h.state.dialog=true;h.state.previousFocus=h.tiles[2];h.make('input',{}, {},h.dialogRoot).focus();
  h.ui.closeDialog();assert.equal(h.state.appFocusIntent,'first');h.flushFrames();assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);
  h.state.saver=true;h.tiles[2].focus();h.ui.stopSaver();h.flushFrames();assert.equal(h.state.saver,false);assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);
  h.state.tab='calendar';h.state.dialog=true;h.state.previousFocus=h.tabs[3];h.ui.closeDialog();h.flushFrames();assert.equal(h.document.activeElement,h.tabs[3],'A non-Home dialog keeps its original focus restoration');
});

test('queued Home focus never steals from a replacement camera/settings dialog or a newly entered saver',()=>{
  const h=modalHarness();h.state.dialog=true;h.ui.closeDialog();
  h.state.dialog=true;const replacement=h.make('input',{}, {},h.dialogRoot);replacement.focus();h.flushFrames();assert.equal(h.document.activeElement,replacement);
  h.state.dialog=false;h.ui.queueHomeAppFocus();h.state.saver=true;h.flushFrames();assert.equal(h.document.activeElement,replacement);
  h.state.saver=false;h.ui.queueHomeAppFocus();h.state.tab='calendar';h.tabs[3].focus();h.flushFrames();assert.equal(h.document.activeElement,h.tabs[3]);
});

test('Home dialog close remains pending without a native catalog and applies Netflix when the real catalog arrives',()=>{
  const h=modalHarness();h.state.tvApps=[];h.ui.render();h.state.dialog=true;h.ui.closeDialog();h.flushFrames();assert.equal(h.state.appFocusIntent,'first');
  h.ui.applyNativeTvApps({appIds:[NETFLIX,ONEPLAY]});assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);assert.equal(h.state.appFocusIntent,null);
});

test('the complete TV header is one ordered horizontal chain from Apps through all five actions and back',()=>{
  const h=appHarness();const actions=h.make('div',{class:'top-actions'},{},h.header);
  const ids=['appearance-button','notices-button','assistant-button','screensaver-button','settings-button'];
  const controls=ids.map((id,index)=>h.make('button',{id},{x:800+index*95,y:10,width:40},actions));
  const wordmark=h.make('a',{class:'wordmark',href:'#home'},{x:0,y:10,width:80},h.header);
  h.tabs[5].focus();for(const target of controls){h.key('ArrowRight');assert.equal(h.document.activeElement,target);}
  const played=h.sounds.length;h.key('ArrowRight');assert.equal(h.document.activeElement,controls[4]);assert.equal(h.sounds.length,played);
  for(const target of [...controls.slice(0,-1)].reverse().concat([...h.tabs].reverse(),wordmark)){h.key('ArrowLeft');assert.equal(h.document.activeElement,target);if(target.dataset.tab)assert.equal(h.state.tab,target.dataset.tab,'Arrow selection activates the tab without OK');}
  const edgeSounds=h.sounds.length;h.key('ArrowLeft');assert.equal(h.document.activeElement,wordmark);assert.equal(h.sounds.length,edgeSounds);
  controls[3].focus();h.key('ArrowDown');assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);
});

test('Up entering the header selects the current tab instead of the geometrically nearest tab or icon',()=>{
  const h=harness();h.state.tab='calendar';
  const card=h.make('button',{'data-camera':'entrance'},{x:100,y:220},h.view);card.focus();
  h.key('ArrowUp');assert.equal(h.document.activeElement,h.tabs[3]);assert.equal(h.state.tab,'calendar');
  const lower=h.make('button',{'data-action':'detail'},{x:100,y:420},h.view);lower.focus();
  h.key('ArrowUp');assert.equal(h.document.activeElement,card,'Intermediate content rows remain navigable');
  h.key('ArrowUp');assert.equal(h.document.activeElement,h.tabs[3]);
});

test('arrows activate every header page immediately and keep Home/App selection in the header through refresh and pending callbacks',()=>{
  const h=appHarness(),frames=[];h.ui.requestAnimationFrame=callback=>frames.push(callback);
  vm.runInNewContext(declaration('queueHomeAppFocus'),h.ui);
  h.ui.queueHomeAppFocus();h.tabs[0].focus();
  for(let index=1;index<h.tabs.length;index++){
    h.key('ArrowRight');assert.equal(h.state.tab,h.tabs[index].dataset.tab);assert.equal(h.document.activeElement,h.tabs[index]);assert.equal(h.state.appFocusIntent,null);
    h.ui.render();assert.equal(h.document.activeElement,h.tabs[index]);
  }
  for(let index=h.tabs.length-2;index>=0;index--){h.key('ArrowLeft');assert.equal(h.state.tab,h.tabs[index].dataset.tab);assert.equal(h.document.activeElement,h.tabs[index]);}
  while(frames.length)frames.shift()();h.ui.restoreTvAppFocus();
  assert.equal(h.document.activeElement,h.tabs[0]);assert.equal(h.state.appFocusIntent,null);
  h.key('ArrowDown');assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX);
  h.ui.setTab('home');assert.equal(h.document.activeElement.dataset.tvApp,NETFLIX,'An explicit HOME entry retains Netflix selection');
});

test('keyboard arrows in the PC header also activate tabs without requiring Enter',()=>{
  const h=harness(undefined,{isTv:false});h.tabs[1].focus();h.state.tab='media';
  h.key('ArrowRight');assert.equal(h.state.tab,'cameras');assert.equal(h.document.activeElement,h.tabs[2]);
  h.key('ArrowLeft');assert.equal(h.state.tab,'media');assert.equal(h.document.activeElement,h.tabs[1]);
});

test('header action buttons retain their actual click bindings and native Enter default',()=>{
  const h=appHarness(),actions=h.make('div',{class:'top-actions'},{},h.header),opened=[];
  const bindings=[['appearance-button','appearanceDialog'],['notices-button','showNotices'],['assistant-button','openAssistant'],['screensaver-button','startSaver'],['settings-button','settings']];
  for(const [index,[id,name]] of bindings.entries()){
    const button=h.make('button',{id},{x:800+index*95,y:10,width:40},actions);h.ui[name]=()=>opened.push(id);
    const assignment=app.match(new RegExp("\\$\\('#"+id+"'\\)\\.onclick=([^;]+);"));assert.ok(assignment,'Actual binding must exist: '+id);
    vm.runInNewContext(assignment[0],h.ui);button.focus();assert.equal(h.key('Enter').defaultPrevented,false);button.onclick();assert.equal(opened.at(-1),id);
  }
  assert.equal(opened.length,5);
});

test('native remote-mode events only record activity without a banner, web pointer changes or focus takeover',()=>{
  const h=harness(),notices=[];h.ui.notify=notice=>notices.push(notice);
  const focused=h.make('a',{'data-tv-app':NETFLIX,href:'hometv://launch?appId='+NETFLIX},{},h.view);focused.focus();
  const listener=app.match(/window\.addEventListener\('tv-remote-mode',[^\n]+/)?.[0];assert.ok(listener,'Use the actual native mode listener');vm.runInNewContext(listener,h.ui);
  const event=h.handlers.get('tv-remote-mode'),nodesBefore=h.shell.children.length;
  for(const pointer of [false,true])for(const detail of [{mode:'focus'},{mode:'pointer'},{}]){
    h.state.pointer=pointer;h.state.lastInput=0;event({detail});
    assert.ok(h.state.lastInput>0);assert.equal(h.state.pointer,pointer,'Native pointer mode must not activate the separate web pointer handler');
    assert.equal(h.document.activeElement,focused);assert.equal(h.shell.children.length,nodesBefore);
  }
  assert.deepEqual(notices,[]);assert.deepEqual(h.sounds,[]);
});
