(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ASSET = '/assets/europe-110m.geojson';
  const WIDTH = 1000, HEIGHT = 560, WORLD = 1000;
  const MAX_LATITUDE = 85.05112878, EARTH_RADIUS = 6378137;
  const MIN_SPAN = 0.03, MAX_SPAN = 1000, REGION_SPAN = 1000 * 8 / 360;
  const COLORS = ['#91b7ff', '#eda7d0', '#90d7b6', '#f2c58d', '#b9a7ef', '#83d9e0'];

  function number(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  function location(value) {
    if (!value || value.available === false || ['unknown', 'unavailable'].includes(value.state)) return null;
    const latitude = number(value.latitude), longitude = number(value.longitude);
    if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude, longitude };
  }

  function project(longitude, latitude) {
    const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude)) * Math.PI / 180;
    return { x: (longitude + 180) / 360 * WORLD, y: (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2 * WORLD };
  }

  function text(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : fallback;
  }

  function entries(values, limit, kind) {
    return (Array.isArray(values) ? values : []).slice(0, limit).map((value, index) => {
      const item = value && typeof value === 'object' ? value : {};
      const position = location(item);
      const radius = number(item.radius);
      return {
        id: text(item.id, kind + '-' + index), name: text(item.name, kind === 'person' ? 'Člen rodiny' : 'Zóna'),
        position, point: position ? project(position.longitude, position.latitude) : null,
        radius: kind === 'zone' && radius !== null && radius > 0 && radius <= 1000000 ? radius : 0,
        color: COLORS[index % COLORS.length], kind
      };
    });
  }

  function element(document, tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = label;
    return node;
  }

  function svgElement(document, tag, attributes, label) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, String(value));
    if (label !== undefined) node.textContent = label;
    return node;
  }

  function geographyPaths(data) {
    if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('Neplatný mapový podklad');
    let points = 0;
    return data.features.slice(0, 256).flatMap(feature => {
      const geometry = feature && feature.geometry;
      if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return [];
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      if (!Array.isArray(polygons)) return [];
      const paths = [];
      for (const polygon of polygons) {
        if (!Array.isArray(polygon)) continue;
        const rings = [];
        for (const ring of polygon) {
          if (!Array.isArray(ring) || ring.length < 4) continue;
          const projected = [];
          for (const coordinate of ring) {
            if (++points > 50000) throw new Error('Příliš velký mapový podklad');
            if (!Array.isArray(coordinate)) continue;
            const longitude = number(coordinate[0]), latitude = number(coordinate[1]);
            if (longitude === null || latitude === null || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) continue;
            projected.push(project(longitude, latitude));
          }
          if (projected.length >= 4) rings.push(projected.map((point, index) => (index ? 'L' : 'M') + point.x.toFixed(4) + ',' + point.y.toFixed(4)).join('') + 'Z');
        }
        if (rings.length) paths.push(rings.join(''));
      }
      const labelCoordinates = feature.properties && feature.properties.label;
      const label = Array.isArray(labelCoordinates) ? location({ longitude: labelCoordinates[0], latitude: labelCoordinates[1] }) : null;
      return paths.length ? [{ paths, name: text(feature.properties && feature.properties.name, ''), label: label ? project(label.longitude, label.latitude) : null }] : [];
    });
  }

  function render(container, initialData) {
    if (!container || !container.ownerDocument) throw new TypeError('Mapa potřebuje DOM kontejner');
    const document = container.ownerDocument;
    let destroyed = false, people = [], zones = [], geography = [], assetFailed = false, assetLoaded = false;
    let view = { x: 0, y: 0, span: REGION_SPAN };
    const listeners = [];
    const root = element(document, 'section', 'house-map');
    root.setAttribute('aria-label', 'Mapa rodiny');
    const toolbar = element(document, 'div', 'house-map-toolbar');
    const controls = element(document, 'div', 'house-map-controls');
    controls.setAttribute('aria-label', 'Ovládání mapy');
    const map = svgElement(document, 'svg', { class: 'house-map-canvas', viewBox: '0 0 ' + WIDTH + ' ' + HEIGHT, tabindex: '0', role: 'img', 'aria-label': 'Mapa rodiny. Šipky posouvají mapu, plus a minus mění přiblížení, Home zobrazí všechny polohy.' });
    const backdrop = svgElement(document, 'rect', { width: WIDTH, height: HEIGHT, class: 'house-map-water' });
    const worldGroup = svgElement(document, 'g', { class: 'house-map-world' });
    const countries = svgElement(document, 'g', { class: 'house-map-countries', 'fill-rule': 'evenodd' });
    const grid = svgElement(document, 'g', { class: 'house-map-grid', 'aria-hidden': 'true' });
    const labels = svgElement(document, 'g', { class: 'house-map-country-labels', 'aria-hidden': 'true' });
    const markers = svgElement(document, 'g', { class: 'house-map-markers' });
    const status = element(document, 'p', 'house-map-status', 'Načítám místní mapový podklad…');
    status.setAttribute('role', 'status');
    const legend = element(document, 'div', 'house-map-legend');
    const note = element(document, 'p', 'house-map-note', 'Orientační mapa · Natural Earth 1:110m · bez uličních detailů. Polohy zůstávají v domácí síti.');

    function listen(node, event, handler) { node.addEventListener(event, handler); listeners.push([node, event, handler]); }
    function button(label, accessible, action) {
      const node = element(document, 'button', 'house-map-button', label);
      node.type = 'button'; node.setAttribute('aria-label', accessible); listen(node, 'click', action); controls.append(node); return node;
    }
    button('+', 'Přiblížit mapu', () => zoom(1 / 1.7));
    button('−', 'Oddálit mapu', () => zoom(1.7));
    button('Všechny polohy', 'Zobrazit všechny dostupné polohy', fit);
    const movement = element(document, 'span', 'house-map-hint', 'Šipky: posun · +/−: přiblížení');
    toolbar.append(controls, movement);
    worldGroup.append(grid, countries); map.append(backdrop, worldGroup, labels, markers);
    root.append(toolbar, map, status, legend, note); container.append(root);

    for (let longitude = -180; longitude <= 180; longitude += 10) {
      const x = project(longitude, 0).x;
      grid.append(svgElement(document, 'path', { d: 'M' + x + ',0V1000', 'vector-effect': 'non-scaling-stroke' }));
    }
    for (let latitude = -80; latitude <= 80; latitude += 5) {
      const y = project(0, latitude).y;
      grid.append(svgElement(document, 'path', { d: 'M0,' + y + 'H1000', 'vector-effect': 'non-scaling-stroke' }));
    }

    function constrain() {
      view.span = Math.max(MIN_SPAN, Math.min(MAX_SPAN, view.span));
      view.x = Math.max(0, Math.min(WORLD, view.x));
      view.y = Math.max(0, Math.min(WORLD, view.y));
    }
    function screen(point) { const scale = WIDTH / view.span; return { x: WIDTH / 2 + (point.x - view.x) * scale, y: HEIGHT / 2 + (point.y - view.y) * scale }; }
    function visible(point, margin) { return point.x > -margin && point.x < WIDTH + margin && point.y > -margin && point.y < HEIGHT + margin; }
    function radiusWorld(item) {
      return item.radius && item.position ? item.radius / (2 * Math.PI * EARTH_RADIUS * Math.cos(Math.min(MAX_LATITUDE, Math.abs(item.position.latitude)) * Math.PI / 180)) * WORLD : 0;
    }
    function redraw() {
      if (destroyed) return;
      constrain();
      const scale = WIDTH / view.span;
      worldGroup.setAttribute('transform', 'translate(' + (WIDTH / 2 - view.x * scale) + ' ' + (HEIGHT / 2 - view.y * scale) + ') scale(' + scale + ')');
      labels.replaceChildren(); markers.replaceChildren();
      for (const country of geography) {
        if (!country.label) continue;
        const point = screen(country.label);
        if (visible(point, 0)) labels.append(svgElement(document, 'text', { x: point.x, y: point.y, 'text-anchor': 'middle' }, country.name));
      }
      for (const zone of zones) {
        if (!zone.point) continue;
        const point = screen(zone.point), radius = radiusWorld(zone) * scale;
        if (!visible(point, Math.min(2000, radius) + 70)) continue;
        const group = svgElement(document, 'g', { class: 'house-map-zone' });
        group.append(svgElement(document, 'title', {}, zone.name));
        if (radius > 0) group.append(svgElement(document, 'circle', { cx: point.x, cy: point.y, r: radius, class: 'house-map-zone-radius' }));
        group.append(svgElement(document, 'circle', { cx: point.x, cy: point.y, r: 4, class: 'house-map-zone-center' }));
        group.append(svgElement(document, 'text', { x: point.x + 10, y: point.y + 18, class: 'house-map-zone-label' }, zone.name));
        markers.append(group);
      }
      const labelRows = new Map();
      for (const person of people) {
        if (!person.point) continue;
        const point = screen(person.point);
        if (!visible(point, 30)) continue;
        // Coincident labels may be offset; every marker remains at its real coordinate.
        const cell = Math.round(point.x / 35) + ':' + Math.round(point.y / 35);
        const row = labelRows.get(cell) || 0; labelRows.set(cell, row + 1);
        const group = svgElement(document, 'g', { class: 'house-map-person' });
        group.append(svgElement(document, 'title', {}, person.name));
        group.append(svgElement(document, 'circle', { cx: point.x, cy: point.y, r: 10, fill: person.color, class: 'house-map-person-halo' }));
        group.append(svgElement(document, 'circle', { cx: point.x, cy: point.y, r: 5, fill: person.color, class: 'house-map-person-point' }));
        group.append(svgElement(document, 'text', { x: point.x + 15, y: point.y - 12 - row * 20 }, person.name));
        markers.append(group);
      }
      const located = people.filter(person => person.point).length, missing = people.length - located;
      const prefix = assetFailed ? 'Mapový podklad není dostupný. ' : !assetLoaded ? 'Načítám místní mapový podklad. ' : '';
      status.textContent = prefix + (located ? 'Dostupné polohy členů rodiny: ' + located + '.' : 'Žádná poloha člena rodiny není dostupná.') + (missing ? ' Bez dostupné polohy: ' + missing + '.' : '');
    }
    function fit() {
      if (destroyed) return;
      const points = people.concat(zones).filter(item => item.point).flatMap(item => {
        const radius = radiusWorld(item);
        return [{ x: item.point.x - radius, y: item.point.y - radius }, { x: item.point.x + radius, y: item.point.y + radius }];
      });
      if (!points.length) { const fallback = project(15.5, 49.8); view = { ...fallback, span: REGION_SPAN }; }
      else {
        const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
        const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
        view = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, span: Math.max(REGION_SPAN, (maxX - minX) * 1.3, (maxY - minY) * WIDTH / HEIGHT * 1.3) };
      }
      redraw();
    }
    function zoom(factor) { if (!destroyed) { view.span *= factor; redraw(); } }
    function pan(horizontal, vertical) {
      if (destroyed || !Number.isFinite(horizontal) || !Number.isFinite(vertical)) return;
      view.x += Math.max(-1, Math.min(1, horizontal)) * view.span * 0.2;
      view.y += Math.max(-1, Math.min(1, vertical)) * view.span * HEIGHT / WIDTH * 0.2; redraw();
    }
    function setData(next, options) {
      if (destroyed) return;
      const hadLegendFocus = legend.contains(document.activeElement);
      const focusedKey = hadLegendFocus ? document.activeElement.getAttribute('data-map-key') : null;
      const uniqueKey = focusedKey && [...legend.children].filter(node => node.getAttribute('data-map-key') === focusedKey).length === 1;
      const focusCandidates = [];
      people = entries(next && next.people, 32, 'person'); zones = entries(next && next.zones, 64, 'zone');
      legend.replaceChildren();
      for (const item of people.concat(zones)) {
        const node = element(document, item.point ? 'button' : 'span', 'house-map-legend-item' + (item.point ? '' : ' unavailable'));
        const key = JSON.stringify([item.kind, item.id]);
        node.setAttribute('data-map-key', key);
        const dot = element(document, 'i', 'house-map-legend-dot');
        dot.style.backgroundColor = item.kind === 'person' ? item.color : 'var(--house-map-zone, #b7cbbf)';
        node.append(dot, element(document, 'span', '', item.name), element(document, 'small', '', item.point ? item.kind === 'zone' ? 'Zóna' : 'Poloha dostupná' : 'Poloha není dostupná'));
        if (item.point) {
          node.type = 'button'; node.setAttribute('aria-label', 'Zobrazit polohu: ' + item.name);
          if (uniqueKey && key === focusedKey) focusCandidates.push(node);
          // This listener belongs to the removed node and is garbage collected with it.
          node.addEventListener('click', () => { if (!destroyed) { view.x = item.point.x; view.y = item.point.y; redraw(); map.focus(); } });
        }
        legend.append(node);
      }
      if (options && options.fit) fit(); else redraw();
      // A refresh may recreate the legend while the remote is focused on a person.
      // Restore only the same unambiguous entry; a removed/unavailable entry returns to the map.
      if (hadLegendFocus) (focusCandidates.length === 1 ? focusCandidates[0] : map).focus({ preventScroll: true });
    }
    listen(map, 'keydown', event => {
      const actions = { ArrowLeft: () => pan(-1, 0), ArrowRight: () => pan(1, 0), ArrowUp: () => pan(0, -1), ArrowDown: () => pan(0, 1), '+': () => zoom(1 / 1.7), '=': () => zoom(1 / 1.7), '-': () => zoom(1.7), _: () => zoom(1.7), Home: fit };
      if (actions[event.key]) { event.preventDefault(); event.stopPropagation(); actions[event.key](); }
    });
    setData(initialData, { fit: true });
    const ready = Promise.resolve().then(() => global.fetch(ASSET, { credentials: 'same-origin', cache: 'force-cache' })).then(response => {
      if (!response.ok) throw new Error('Mapový podklad není dostupný');
      return response.json();
    }).then(data => {
      if (destroyed) return false;
      geography = geographyPaths(data); assetLoaded = true;
      for (const country of geography) for (const path of country.paths) countries.append(svgElement(document, 'path', { d: path, 'vector-effect': 'non-scaling-stroke' }));
      redraw(); return true;
    }).catch(() => { if (!destroyed) { assetFailed = true; redraw(); } return false; });
    return Object.freeze({
      ready, setData, fit, zoomIn: () => zoom(1 / 1.7), zoomOut: () => zoom(1.7), pan,
      destroy() { if (!destroyed) { destroyed = true; for (const [node, event, handler] of listeners) node.removeEventListener(event, handler); root.remove(); } }
    });
  }

  global.HomeTVMap = Object.freeze({ render });
})(globalThis);
