/* Local-only controller. The sole remote resource is the user-visible OSM tile layer. */
(function () {
  'use strict';
  var map = L.map('map', { zoomControl: false, attributionControl: true, keyboard: false, preferCanvas: true,
    minZoom: 2, maxZoom: 18, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
  map.attributionControl.setPrefix(false);
  var tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    minZoom: 2, maxZoom: 18, maxNativeZoom: 19, keepBuffer: 0, updateWhenIdle: true, updateWhenZooming: false,
    detectRetina: false, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });
  var markers = L.layerGroup().addTo(map), current = null, lastView = '', visible = false, errors = 0;
  var status = document.getElementById('status');
  function valid(p) { return p && typeof p.id === 'string' && p.id.length <= 80 && typeof p.name === 'string' &&
    Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 85.05112878 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180; }
  function points() { return current ? current.positions.filter(valid).slice(0, 9) : []; }
  function loaded() { return document.querySelectorAll('img.leaflet-tile-loaded').length; }
  function showStatus() {
    var available = points().length;
    status.hidden = available > 0 && loaded() > 0;
    status.textContent = !available ? 'Aktuální polohy nejsou dostupné.' : errors > 0 && !loaded() ?
      'Mapové podklady se nenačetly. Polohy rodiny zůstávají dostupné.' : 'Načítám mapu…';
  }
  function grouped(list) {
    var byPosition = Object.create(null), result = [];
    list.forEach(function (point) {
      // Exact coincident positions share a visual; the geographic coordinate is unchanged.
      var key = String(point.latitude) + ';' + String(point.longitude);
      if (!byPosition[key]) { byPosition[key] = []; result.push(byPosition[key]); }
      byPosition[key].push(point);
    });
    return result;
  }
  function pin(group, index) {
    var p = group[0], family = group.filter(function (point) { return !point.home; });
    var atHome = group.some(function (point) { return point.home; });
    var selected = group.some(function (point) { return current.selected === point.id; });
    var names = group.map(function (point) { return point.name; }).join(' · ');
    var icon = document.createElement('div'); icon.className = 'family-avatar' + (atHome ? ' home' : '') + (selected ? ' selected' : '');
    if (group.length > 1) icon.textContent = String(family.length || group.length);
    else if (p.home) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24');
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M3 11 12 3l9 8v10h-6v-7H9v7H3Z'); svg.appendChild(path); icon.appendChild(svg);
    } else {
      icon.textContent = p.name.trim().split(/\s+/).slice(0, 2).map(function (part) { return part.charAt(0); }).join('').toUpperCase();
      icon.style.backgroundColor = ['#4d80cf', '#c76da3', '#9673c5', '#558f8f'][index % 4];
    }
    var label = document.createElement('span'); label.textContent = group.length > 1 && atHome ? family.length + ' doma · ' + family.map(function (point) { return point.name; }).join(' · ') : names;
    L.marker([p.latitude, p.longitude], { icon: L.divIcon({ html: icon, className: 'family-pin', iconSize: [34, 34], iconAnchor: [17, 17] }), keyboard: false })
      .bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -18], className: 'family-name' }).addTo(markers);
  }
  function apply() {
    var list = points(); document.body.classList.toggle('dark', !!(current && current.dark));
    markers.clearLayers(); grouped(list).forEach(pin);
    if (!list.length) { if (map.hasLayer(tiles)) map.removeLayer(tiles); lastView = ''; showStatus(); return; }
    var selected = list.find(function (point) { return current.selected === point.id; });
    var key = JSON.stringify([current.selected, current.zoom, list.map(function (point) { return [point.id, point.latitude, point.longitude]; })]);
    if (key !== lastView) {
      if (selected) map.setView([selected.latitude, selected.longitude], current.zoom, { animate: false });
      else map.fitBounds(L.latLngBounds(list.map(function (point) { return [point.latitude, point.longitude]; })), { padding: [40, 45], maxZoom: current.zoom, animate: false });
      lastView = key;
    }
    if (visible && !map.hasLayer(tiles)) { errors = 0; tiles.addTo(map); }
    showStatus();
  }
  tiles.on('tileload', showStatus); tiles.on('tileerror', function () { errors = Math.min(99, errors + 1); showStatus(); });
  window.HomeTVFamilyMap = {
    bind: function (payload) {
      if (!payload || !Array.isArray(payload.positions)) return false;
      current = { positions: payload.positions.slice(0, 9), selected: typeof payload.selected === 'string' ? payload.selected : 'all',
        zoom: Number.isInteger(payload.zoom) ? Math.min(18, Math.max(2, payload.zoom)) : 16, dark: payload.dark === true };
      map.invalidateSize({ pan: false }); apply(); return true;
    },
    setVisible: function (value) {
      visible = value === true;
      if (!visible) { if (map.hasLayer(tiles)) map.removeLayer(tiles); return true; }
      map.invalidateSize({ pan: false }); if (current) apply(); return true;
    },
    resize: function () { lastView = ''; map.invalidateSize({ pan: false }); if (current) apply(); return true; },
    status: function () { return { ready: !!current && points().length > 0 && loaded() > 0, positions: points().length, loadedTiles: Math.min(99, loaded()), tileErrors: errors, visible: visible }; }
  };
  window.addEventListener('resize', function () { window.HomeTVFamilyMap.resize(); });
}());
