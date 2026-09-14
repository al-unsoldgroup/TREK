'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Map = require('../../client/advice-map');
const museum = { key: 'p:1', title: 'Museum', coordinates: { lat: 35.7, lng: 139.7 } };
test('map uses scheduled and consideration coordinates, omitting unknown positions', () => {
  const entries = Map.placesFor({ schedule: [{ place: museum }] }, [{ key: 'p:2' }, { key: 'p:3', coordinates: { lat: 35.71, lng: 139.71 } }]);
  assert.equal(entries.length, 2); assert.equal(entries[0].scheduled, true); assert.equal(entries[1].scheduled, false);
});
test('map rejects invalid coordinates without inventing a location', () => {
  assert.deepEqual(Map.placesFor({ schedule: [] }, [{ coordinates: { lat: null, lng: 1 } }, { coordinates: { lat: 91, lng: 0 } }]), []);
});
test('fresh Google suggestions and provider geometry do not become OSM map pins', () => {
  assert.deepEqual(Map.placesFor({ schedule: [] }, [{ key: 's:pending', title: 'Google result', coordinates: museum.coordinates },
    { key: 'p:2', location: { latitude: 35.7, longitude: 139.7 }, placeType: 'Google place type', photoHandle: 'google-photo' }]), []);
});
test('fit keeps all day places in compact map bounds', () => {
  const entries = Map.placesFor({ schedule: [{ place: museum }] }, [{ key: 'p:2', coordinates: { lat: 35.8, lng: 139.9 } }]);
  const view = Map.fit(entries, 600, 240);
  for (const { place } of entries) {
    const point = Map.point(place.coordinates, view.zoom);
    assert.ok(Math.abs(point.x - view.x) <= 252); assert.ok(Math.abs(point.y - view.y) <= 72);
  }
});
test('tiles include only the visible zoom and viewport, with a fixed upper bound', () => {
  const view = Map.fit(Map.placesFor({ schedule: [{ place: museum }] }, []), 600, 240);
  const tiles = Map.tilesFor(view, 600, 240);
  assert.ok(tiles.length > 0 && tiles.length <= 24);
  for (const tile of tiles) {
    assert.equal(tile.z, view.zoom); assert.ok(tile.left < 600 && tile.left + 256 > 0);
    assert.ok(tile.top < 240 && tile.top + 256 > 0);
  }
});
function documentFixture() {
  const doc = { createElement: tag => ({ tag, children: [], listeners: {}, attributes: {}, dataset: {}, style: {}, isConnected: true,
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, fn) { this.listeners[name] = fn; },
    all() { return this.children.flatMap(child => [child, ...child.all()]); }, click() { return this.listeners.click?.(); },
  }) };
  return doc;
}
test('map fetches no tiles before viewing, exposes accessible pins and votes, and expands to half screen', async () => {
  const doc = documentFixture(), actions = [], votes = [], attribution = [];
  const created = [], revoked = [];
  doc.defaultView = { URL: { createObjectURL(blob) { assert.equal(blob.type, 'image/png'); const url = 'blob:tile-' + created.length; created.push(url); return url; }, revokeObjectURL(url) { revoked.push(url); } } };
  const map = Map.render({ document: doc, day: { key: 'd:1', date: '2026-10-09', schedule: [{ place: museum }] },
    bridge: { action: async action => { actions.push(action); return { mimeType: 'image/png', bytesBase64: 'iVBORw0KGgoAAAAA' }; }, openAttribution: uri => attribution.push(uri) },
    onVote: async (key, value) => votes.push({ key, value }) });
  const button = label => map.all().find(node => node.tag === 'button' && node.textContent === label);
  assert.equal(actions.length, 0);
  button('Show map').click(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(actions.length > 0); assert.ok(actions.every(action => action.kind === 'map.tile' && action.dayKey === 'd:1'));
  assert.ok(map.all().some(node => node.tag === 'img'));
  assert.ok(map.all().filter(node => node.tag === 'img').every(node => node.src.startsWith('blob:')));
  const pin = map.all().find(node => node.attributes['aria-label'] === 'Museum, scheduled');
  assert.ok(pin); pin.click(); await button('Vote up').click();
  assert.deepEqual(votes, [{ key: 'p:1', value: 1 }]);
  button('Expand map').click(); assert.equal(map.dataset.expanded, 'true');
  assert.ok(!map.all().some(node => node.tag === 'style'));
  assert.match(fs.readFileSync(path.join(__dirname, '../../client/advice.css'), 'utf8'), /daily-map\[data-expanded="true"\].*height:50vh/);
  button('© OpenStreetMap contributors').click(); assert.deepEqual(attribution, ['https://www.openstreetmap.org/copyright']);
  map.disposeMap();
  assert.deepEqual(new Set(revoked), new Set(created));
});
test('private preview shows native pins without requesting public map tiles', async () => {
  const map = Map.render({ document: documentFixture(), day: { key: 'd:1', date: '2026-10-09', schedule: [{ place: museum }] },
    bridge: { preview: true, action() { assert.fail('Preview must not request guest tiles'); } }, onVote() {} });
  map.all().find(node => node.textContent === 'Show map').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(map.all().some(node => node.className === 'daily-map-pin'));
  assert.ok(map.all().some(node => node.textContent === 'The interactive map is available on the shared link.'));
  map.disposeMap();
});
test('unavailable basemap keeps the geographic pins and reports the failure', async () => {
  const map = Map.render({ document: documentFixture(), day: { key: 'd:1', date: '2026-10-09', schedule: [{ place: museum }] }, bridge: { action: async () => { throw new Error('Unavailable'); } }, onVote() {} });
  map.all().find(node => node.textContent === 'Show map').click(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(map.all().some(node => node.textContent === 'Some map tiles are unavailable. Place pins and votes still work.'));
  assert.ok(map.all().some(node => node.className === 'daily-map-pin'));
  map.disposeMap();
});
