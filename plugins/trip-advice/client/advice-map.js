(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TripAdviceMap = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const TILE = 256;
  function point(coordinates, zoom) {
    const sine = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, coordinates.lat)) * Math.PI / 180);
    return { x: (coordinates.lng + 180) / 360 * 2 ** zoom * TILE,
      y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * 2 ** zoom * TILE };
  }
  function validCoordinates(place) {
    const c = place?.coordinates;
    return /^p:[1-9][0-9]*$/.test(place?.key) && c && Number.isFinite(c.lat) && Math.abs(c.lat) <= 90 && Number.isFinite(c.lng) && Math.abs(c.lng) <= 180;
  }
  function placesFor(day, consideration) {
    const entries = [...day.schedule.map(row => ({ place: row.place, scheduled: true })), ...consideration.map(place => ({ place, scheduled: false }))];
    return [...new Map(entries.filter(entry => validCoordinates(entry.place)).map(entry => [entry.place.key, entry])).values()];
  }
  function fit(entries, width, height) {
    for (let zoom = 16; zoom >= 2; zoom--) {
      const pixels = entries.map(entry => point(entry.place.coordinates, zoom));
      const xs = pixels.map(p => p.x), ys = pixels.map(p => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      if ((maxX - minX <= width - 96 && maxY - minY <= height - 96) || zoom === 2) {
        return { zoom, x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      }
    }
  }
  function tilesFor(view, width, height) {
    const tiles = [], left = view.x - width / 2, top = view.y - height / 2, limit = 2 ** view.zoom;
    for (let y = Math.max(0, Math.floor(top / TILE)); y <= Math.min(limit - 1, Math.floor((top + height - 1) / TILE)); y++) {
      for (let x = Math.max(0, Math.floor(left / TILE)); x <= Math.min(limit - 1, Math.floor((left + width - 1) / TILE)); x++) {
        tiles.push({ z: view.zoom, x, y, left: x * TILE - left, top: y * TILE - top });
      }
    }
    return tiles.slice(0, 24);
  }
  function render({ document: doc, day, consideration = [], onVote, votes = {}, bridge }) {
    const entries = placesFor(day, consideration);
    if (!entries.length) return null;
    const node = (tag, text, className) => {
      const value = doc.createElement(tag);
      if (text !== undefined) value.textContent = text;
      if (className) value.className = className;
      return value;
    };
    const button = (label, fn) => { const value = node('button', label); value.type = 'button'; value.addEventListener('click', fn); return value; };
    const section = node('section', undefined, 'daily-map');
    const header = node('div', undefined, 'daily-map-header'), title = node('h4', 'Day map');
    const viewport = node('div', undefined, 'daily-map-viewport');
    viewport.setAttribute('aria-label', 'Places on ' + day.date); viewport.setAttribute('role', 'region');
    const tiles = node('div', undefined, 'daily-map-tiles'), pins = node('div', undefined, 'daily-map-pins');
    tiles.setAttribute('aria-hidden', 'true'); viewport.append(tiles, pins);
    const popup = node('div', undefined, 'daily-map-popup'); popup.hidden = true;
    const status = node('p', '', 'daily-map-status'); status.setAttribute('role', 'status');
    let view, visible = false, generation = 0, expanded = false;
    const tileUrls = new Set(), urlApi = doc.defaultView?.URL || globalThis.URL;
    const releaseTiles = () => { tileUrls.forEach(url => urlApi.revokeObjectURL(url)); tileUrls.clear(); };
    const widths = () => ({ width: Math.min(1200, Math.max(200, viewport.clientWidth || 600)), height: Math.min(800, viewport.clientHeight || 240) });
    const expand = button('Expand map', () => { expanded = !expanded; section.dataset.expanded = String(expanded); expand.textContent = expanded ? 'Collapse map' : 'Expand map'; expand.setAttribute('aria-expanded', String(expanded)); draw(); });
    expand.setAttribute('aria-expanded', 'false'); header.append(title, expand);
    const controls = node('div', undefined, 'daily-map-controls');
    const move = (dx, dy) => { if (!view) return; view.x += dx; view.y += dy; draw(); };
    const zoom = delta => { if (!view) return; const next = Math.max(2, Math.min(17, view.zoom + delta)), factor = 2 ** (next - view.zoom); view = { zoom: next, x: view.x * factor, y: view.y * factor }; draw(); };
    controls.append(button('Zoom in', () => zoom(1)), button('Zoom out', () => zoom(-1)),
      button('Fit places', () => { view = undefined; draw(); }), button('←', () => move(-128, 0)), button('→', () => move(128, 0)), button('↑', () => move(0, -128)), button('↓', () => move(0, 128)));
    controls.children[3].setAttribute('aria-label', 'Pan west'); controls.children[4].setAttribute('aria-label', 'Pan east');
    controls.children[5].setAttribute('aria-label', 'Pan north'); controls.children[6].setAttribute('aria-label', 'Pan south');
    const credit = node('div', undefined, 'daily-map-credit');
    credit.append(button('© OpenStreetMap contributors', () => bridge?.openAttribution?.('https://www.openstreetmap.org/copyright')),
      button('Report a map issue', () => bridge?.openAttribution?.('https://www.openstreetmap.org/fixthemap')));
    section.append(header, viewport, controls, node('p', 'Filled pins: scheduled · outlined pins: for consideration', 'daily-map-legend'), status, popup, credit);
    function select(entry, index) {
      popup.hidden = false; popup.replaceChildren(node('strong', `${index + 1}. ${entry.place.title}`));
      const vote = votes instanceof Map ? votes.get(entry.place.key) : votes[entry.place.key];
      const mine = vote?.mine || 0;
      for (const [value, label] of [[1, 'Vote up'], [-1, 'Vote down']]) {
        const control = button(label, async () => {
          control.disabled = true;
          try { await onVote(entry.place.key, mine === value ? 0 : value); }
          catch (_) { status.textContent = 'Your vote could not be saved. Try again.'; }
          finally { control.disabled = false; }
        });
        control.setAttribute('aria-pressed', String(mine === value)); popup.append(control);
      }
      popup.append(button('Close place', () => { popup.hidden = true; }));
    }
    async function draw() {
      if (!visible || !section.isConnected) return;
      const current = ++generation, { width, height } = widths();
      if (!view) view = fit(entries, width, height);
      releaseTiles(); pins.replaceChildren(); tiles.replaceChildren();
      entries.forEach((entry, index) => {
        const position = point(entry.place.coordinates, view.zoom), pin = button(String(index + 1), () => select(entry, index));
        pin.className = 'daily-map-pin'; pin.dataset.scheduled = String(entry.scheduled);
        pin.setAttribute('aria-label', `${entry.place.title}, ${entry.scheduled ? 'scheduled' : 'for consideration'}`);
        pin.style.left = `${position.x - view.x + width / 2}px`; pin.style.top = `${position.y - view.y + height / 2}px`; pins.append(pin);
      });
      if (!bridge?.action || bridge.preview) { status.textContent = 'The interactive map is available on the shared link.'; return; }
      status.textContent = 'Loading map…';
      const queue = tilesFor(view, width, height);
      let failed = false;
      // Sequential requests keep the host's small anonymous action queue available for votes.
      for (const tile of queue) {
        if (current !== generation || !visible || !section.isConnected) return;
        try {
          const raw = await bridge.action({ version: 1, kind: 'map.tile', dayKey: day.key, z: tile.z, x: tile.x, y: tile.y });
          const result = raw?.data || raw;
          if (result?.mimeType !== 'image/png' || typeof result.bytesBase64 !== 'string' || result.bytesBase64.length > 350000 || !/^iVBORw0KGgo[A-Za-z0-9+/=]*$/.test(result.bytesBase64)) throw new Error('Invalid tile');
          if (current !== generation || !visible || !section.isConnected) return;
          const bytes = Uint8Array.from(atob(result.bytesBase64), char => char.charCodeAt(0));
          const url = urlApi.createObjectURL(new Blob([bytes], { type: 'image/png' })); tileUrls.add(url);
          const img = node('img'); img.alt = ''; img.src = url;
          img.style.left = `${tile.left}px`; img.style.top = `${tile.top}px`; tiles.append(img);
        } catch (_) { failed = true; }
      }
      if (current === generation) status.textContent = failed ? 'Some map tiles are unavailable. Place pins and votes still work.' : '';
    }
    const win = doc.defaultView, observers = [];
    section.disposeMap = () => { visible = false; generation++; releaseTiles(); observers.forEach(observer => observer.disconnect()); };
    if (win?.IntersectionObserver) {
      const observer = new win.IntersectionObserver(records => {
        if (!section.isConnected) { observer.disconnect(); return; }
        visible = records.some(record => record.isIntersecting);
        if (visible) void draw(); else generation++;
      });
      observer.observe(viewport);
      observers.push(observer);
    } else {
      const show = button('Show map', () => { visible = true; show.hidden = true; void draw(); }); header.append(show);
    }
    if (win?.ResizeObserver) {
      const observer = new win.ResizeObserver(() => { if (!section.isConnected) observer.disconnect(); else if (visible) void draw(); });
      observer.observe(viewport);
      observers.push(observer);
    }
    return section;
  }
  return { render, point, placesFor, fit, tilesFor };
});
