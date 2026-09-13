'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function loadController(options = {}) {
  const listeners = options.listeners || new Map();
  const window = {
    parent: null,
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    structuredClone: value => JSON.parse(JSON.stringify(value)),
    addEventListener: (name, handler) => listeners.set(name, handler),
    clearTimeout,
    setTimeout,
    URL,
  };
  window.parent = options.parent || window;
  const context = vm.createContext({ window, document: options.document, URL, Blob, navigator: { language: 'en' }, console });
  for (const file of ['client/advice-model.js', 'client/advice-protocol.js', 'client/advice.js']) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return window.TrekAdviceController;
}

const candidateRows = {
  cities: [
    { id: 'city-a', label: 'Alpha', countryCodes: ['AA'] },
    { id: 'city-b', label: 'Beta', countryCodes: ['BB'] },
  ],
  stays: [{ id: 'stay-a', cityId: 'city-a', dayIds: ['day-a'] }],
  schedule: [{ assignmentId: 'assignment-a', publicTitle: 'Museum', category: 'see' }],
  shortlist: [{ placeId: 'place-a', publicTitle: 'Cafe', category: 'eat', cityId: 'city-a' }],
};

test('first-run owner selection is explicit and starts empty', () => {
  const controller = loadController();
  assert.equal(controller.storedOwnerConfig({ version: 1, config: null }), null);
  const prepared = controller.ownerSelectionModel(null, candidateRows);
  assert.equal(JSON.stringify(prepared.config), JSON.stringify({ version: 1, publicTitle: '', cities: [], stays: [], schedule: [], shortlist: [] }));
  assert.equal(prepared.available.cities.length, 2);
  assert.equal(prepared.selected.cities.size, 0);
  assert.equal(prepared.selected.shortlist.size, 0);
});

test('selected-only stored config retains excluded authorized candidates', () => {
  const controller = loadController();
  const prepared = controller.ownerSelectionModel({
    version: 1,
    publicTitle: 'A trip',
    cities: [candidateRows.cities[0]],
    stays: [],
    schedule: [],
    shortlist: [],
  }, candidateRows);
  assert.equal(JSON.stringify(prepared.available.cities.map(row => row.id)), JSON.stringify(['city-a', 'city-b']));
  assert.equal(prepared.selected.cities.has('city-a'), true);
  assert.equal(prepared.selected.cities.has('city-b'), false);
});

test('owner DOM controller reads the title selector and checked candidate rows safely', () => {
  const controller = loadController();
  const controls = [
    { dataset: { key: 'cities', id: 'city-a' }, checked: true },
    { dataset: { key: 'cities', id: 'city-b' }, checked: false },
    { dataset: { key: 'shortlist', id: 'place-a' }, checked: true },
  ];
  const ownerDocument = {
    querySelector: selector => selector === '#config-editor input[data-field="title"]' ? { value: '  Updated title  ' } : null,
    querySelectorAll: selector => controls.filter(control => control.checked && selector.includes(`data-key="${control.dataset.key}"`)),
  };
  const draft = controller.ownerSelectionModel(null, candidateRows).config;
  const config = controller.ownerConfigFromControls(draft, controller.ownerSelectionModel(null, candidateRows).available, ownerDocument);
  assert.equal(config.publicTitle, 'Updated title');
  assert.equal(JSON.stringify(config.cities.map(row => row.id)), JSON.stringify(['city-a']));
  assert.equal(JSON.stringify(config.shortlist.map(row => row.placeId)), JSON.stringify(['place-a']));
  assert.equal(controller.ownerConfigFromControls(undefined, candidateRows, ownerDocument), null);
});

test('vote controller accepts only canonical mine values', () => {
  const controller = loadController();
  const result = { placeKey: 'p:1', value: 0, version: 3, positive: 2, negative: 1, mine: 0 };
  assert.equal(controller.validVoteResult(result), true);
  assert.equal(controller.validVoteResult({ ...result, mine: 2 }), false);
});

test('host insets clear floating navigation and reset for desktop', () => {
  const styles = new Map();
  const root = { dataset: {}, style: { setProperty: (key, value) => styles.set(key, value) } };
  const controller = loadController({ document: { documentElement: root } });
  controller.applyTheme({ theme: 'dark', viewport: { insets: { top: 70, bottom: 106, left: 0, right: 0 } } });
  assert.equal(root.dataset.platformMode, 'dark');
  assert.equal(styles.get('--trek-inset-top'), '70px');
  assert.equal(styles.get('--trek-inset-bottom'), '106px');
  controller.applyTheme({ theme: 'light', viewport: { insets: { top: -1, bottom: Infinity, left: '20', right: 10000 } } });
  for (const side of ['top', 'bottom', 'left', 'right']) assert.equal(styles.get(`--trek-inset-${side}`), '0px');
  assert.equal(root.dataset.platformMode, 'light');
});

test('owner bridge reapplies trusted context updates without reloading the editor', () => {
  const styles = new Map();
  const root = { dataset: {}, style: { setProperty: (key, value) => styles.set(key, value) } };
  const listeners = new Map();
  const parent = { postMessage() {} };
  const controller = loadController({ document: { documentElement: root }, parent, listeners });
  controller.OwnerBridge();
  const receive = listeners.get('message');
  receive({ source: {}, data: { type: 'trek:context', theme: 'dark' } });
  assert.equal(root.dataset.platformMode, undefined);
  receive({ source: parent, data: { type: 'trek:context', theme: 'dark', viewport: { insets: { top: 70 } } } });
  assert.equal(root.dataset.platformMode, 'dark');
  assert.equal(styles.get('--trek-inset-top'), '70px');
  receive({ source: parent, data: { type: 'trek:context', theme: 'light', viewport: { insets: { top: 0 } } } });
  assert.equal(root.dataset.platformMode, 'light');
  assert.equal(styles.get('--trek-inset-top'), '0px');
});
