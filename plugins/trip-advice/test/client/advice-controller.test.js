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
    IntersectionObserver: options.IntersectionObserver,
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

function removalDocument() {
  const document = { createElement: tag => ({
    tag, children: [], listeners: {}, attributes: {}, disabled: false, value: '', dataset: {}, isConnected: true,
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    all() { return this.children.flatMap(child => [child, ...child.all()]); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() { document.activeElement = this; },
    scrollIntoView() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
    click() { if (!this.disabled) return this.listeners.click?.(); },
  }) };
  return document;
}

test('photo preview links the individual source and labels Google Maps without translation', async () => {
  const document = removalDocument();
  document.createTextNode = text => Object.assign(document.createElement('#text'), { textContent: text });
  const opened = [];
  const result = { state: 'available', mimeType: 'image/jpeg', bytesBase64: '/9j/2Q==', googleAttribution: 'Google Maps', googleMapsUri: 'https://www.google.com/maps/photo', authors: [{ displayName: 'Photographer', uri: 'https://example.test/author' }] };
  const bridge = { photoAsset: async () => ({ result, url: 'blob:synthetic' }), openAttribution: uri => opened.push(uri) };
  const preview = loadController({ document }).photoPreview({ title: 'Garden', photoHandle: 'photo-1' }, bridge);
  await settleGuest();
  const source = preview.all().find(node => node.tag === 'a' && node.href === result.googleMapsUri);
  assert.ok(source, 'Individual source photo link is missing');
  source.listeners.click({ preventDefault() {} });
  assert.deepEqual(opened, [result.googleMapsUri]);
  assert.equal(source.target, '_blank');
  assert.equal(source.rel, 'noopener noreferrer');
  const branding = preview.all().find(node => node.textContent === 'Google Maps');
  assert.equal(branding.attributes.translate, 'no');
  assert.equal(branding.className, 'google-attribution');
  assert.ok(preview.all().some(node => node.textContent === 'Photographer'));
});

test('photo preview does not display bytes without a safe source link', async () => {
  const document = removalDocument();
  const bridge = { photoAsset: async () => ({ result: { state: 'available', mimeType: 'image/jpeg', bytesBase64: '/9j/2Q==', googleAttribution: 'Google Maps', authors: [] }, url: 'blob:synthetic' }) };
  const preview = loadController({ document }).photoPreview({ title: 'Garden', photoHandle: 'photo-1' }, bridge);
  await settleGuest();
  assert.equal(preview.all().find(node => node.tag === 'img').hidden, true);
  assert.ok(preview.all().some(node => node.textContent === 'Photo unavailable'));
  assert.ok(!preview.all().some(node => node.tag === 'a'));
});

test('places without a photo handle do not render an empty photo preview box', () => {
  const document = removalDocument();
  const preview = loadController({ document }).photoPreview({ title: 'Garden' }, {});
  assert.equal(preview.hidden, true);
  assert.ok(!preview.all().some(node => node.textContent === 'Photo unavailable'));
});

function guestHarness(action, options = {}) {
  const document = removalDocument();
  const ids = new Map([...fs.readFileSync('client/guest.html', 'utf8').matchAll(/id="([^"]+)"/g)]
    .map(([, id]) => [id, document.createElement('div')]));
  document.getElementById = id => ids.get(id) || null;
  const root = ids.get('app');
  root.querySelector = selector => {
    const id = selector.match(/^\[id="([^"]+)"\]$/)?.[1];
    return ids.get(id) || [...ids.values()].flatMap(node => node.all()).find(node => node.id === id) || null;
  };
  const projection = {
    version: 1, revision: '1', title: 'Synthetic advice',
    cities: [{ id: 'city-a', label: 'Test city', countryCodes: ['JP'] }],
    stays: [{ id: 'stay-a', cityId: 'city-a', shortlistCityId: 'city-a', days: [] }], shortlists: [],
  };
  const feedback = { projection, feedbackRevision: 1, votes: [], myPendingSuggestions: [], myComments: [], nextCommentsCursor: null };
  const calls = []; let closed = false;
  const bridge = {
    action: async input => { calls.push(input); return action ? action(input, feedback) : feedback; },
    close: () => { closed = true; },
  };
  loadController({ document, ...options }).renderGuest(root, projection, bridge, {});
  const control = label => [...ids.values()].flatMap(node => [node, ...node.all()]).find(node => node.tag === 'button' && node.textContent === label);
  return { document, ids, feedback, calls, control, closed: () => closed };
}
const settleGuest = () => new Promise(resolve => setImmediate(resolve));

test('visible place metadata requests are serialized and old observed targets are released on rerender', async () => {
  let observer;
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnected = 0; observer = this; }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); this.disconnected++; }
  }
  const releases = [];
  const page = guestHarness((action, feedback) => {
    if (action.kind === 'places.metadata') return new Promise(resolve => releases.push(() => resolve({ placeKey: action.placeKey, placeType: 'Museum' })));
    feedback.projection.shortlists = [{ cityId: 'city-a', eat: [], see: [1, 2, 3].map(id => ({ key: `p:${id}`, title: `Museum ${id}`, category: 'see', cityId: 'city-a', locality: 'Tokyo', countryCode: 'JP', googlePlaceId: `google-${id}`, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Museum' })) }];
    return feedback;
  }, { IntersectionObserver: Observer });
  await settleGuest();
  observer.callback([...observer.targets].map(target => ({ target, isIntersecting: true })));
  await settleGuest();
  assert.equal(page.calls.filter(action => action.kind === 'places.metadata').length, 1);
  releases.shift()(); await settleGuest();
  assert.equal(page.calls.filter(action => action.kind === 'places.metadata').length, 2);
  releases.shift()(); await settleGuest(); releases.shift()(); await settleGuest();
  const disconnected = observer.disconnected;
  page.control('Eat').click(); await settleGuest();
  assert.ok(observer.disconnected > disconnected);
});

test('Suggest an idea shares the See and Eat toolbar, outside the tablist', async () => {
  const page = guestHarness();
  await settleGuest();
  const nodes = page.ids.get('stays').children[0].all();
  const tabs = nodes.find(node => node.attributes.role === 'tablist');
  const toolbar = nodes.find(node => node.children.includes(tabs));
  assert.ok(toolbar.children.some(node => node.tag === 'button' && node.textContent === 'Suggest an idea'));
  assert.equal(tabs.children.length, 2);
  assert.ok(tabs.children.every(node => node.attributes.role === 'tab'));
  assert.equal(nodes.filter(node => node.tag === 'button' && node.textContent === 'Suggest an idea').length, 1);
});

test('each scheduled day opens a quick recommendation search with full details hidden', async () => {
  const page = guestHarness((action, feedback) => {
    feedback.projection.stays[0].days = [{ key: 'd:1', date: '2026-10-09', schedule: [] }, { key: 'd:2', date: '2026-10-10', schedule: [] }];
    return feedback;
  });
  await settleGuest();
  const buttons = page.ids.get('stays').all().filter(node => node.tag === 'button' && node.textContent === 'Recommend here');
  assert.equal(buttons.length, 2);
  await buttons[1].click();
  assert.equal(page.ids.get('suggest-dialog').open, true);
  assert.equal(page.ids.get('suggest-dialog').dataset.mode, 'quick');
  assert.equal(page.ids.get('suggest-search-controls').hidden, true);
  assert.equal(page.ids.get('suggest-personal-details').hidden, true);
  assert.equal(page.ids.get('suggest-form-actions').hidden, true);
  assert.equal(page.document.activeElement, page.ids.get('place-search'));
  assert.equal(page.calls.filter(action => action.kind === 'suggestion.create').length, 0);
});

test('guest renders shortlist-only destinations and Elsewhere with working local tabs', async () => {
  const page = guestHarness((action, feedback) => {
    feedback.projection.cities = [{ id: 'city-a', label: 'Test city', countryCodes: ['JP'] }, { id: 'city-b', label: 'Other city', countryCodes: ['JP'] }];
    const place = (key, cityId) => ({ key, title: key, category: 'eat', cityId, locality: 'Actual town', countryCode: 'JP', googlePlaceId: null, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=food' });
    feedback.projection.shortlists = [{ cityId: 'city-b', see: [], eat: [place('p:2', 'city-b')] }, { cityId: 'elsewhere', see: [], eat: [place('p:3', 'elsewhere')] }];
    return feedback;
  });
  await settleGuest();
  const nodes = () => page.ids.get('stays').all();
  assert.ok(nodes().some(node => node.tag === 'h2' && node.children.some(child => child.textContent === 'Other city')));
  assert.ok(nodes().some(node => node.tag === 'h2' && node.children.some(child => child.textContent === 'Elsewhere')));
  const tab = nodes().find(node => node.id === 'tab-elsewhere-eat');
  await tab.click();
  assert.equal(nodes().find(node => node.id === 'tab-elsewhere-eat').attributes['aria-selected'], 'true');
  assert.ok(nodes().some(node => node.tag === 'a' && node.textContent === 'p:3'));
  await page.control('Other city · Ideas').click();
  assert.equal(page.document.activeElement.attributes['aria-label'], 'Other city stay');
  await nodes().find(node => node.id === 'tab-city-b-eat').click();
  assert.equal(nodes().find(node => node.id === 'tab-city-b-eat').attributes['aria-selected'], 'true');
  const elsewhere = nodes().find(node => node.attributes['aria-label'] === 'Elsewhere stay');
  await elsewhere.all().find(node => node.tag === 'button' && node.textContent === 'Suggest an idea').click();
  assert.equal(page.ids.get('suggest-city').value, 'city-a');
});

test('route separates committed destinations and city schedules can collapse independently', async () => {
  const page = guestHarness((action, feedback) => {
    feedback.projection.cities.push(...(feedback.projection.cities.length === 1 ? [{ id: 'city-b', label: 'Optional city', countryCodes: ['JP'] }] : []));
    feedback.projection.stays[0].days = [{ key: 'd:1', date: '2026-10-09', schedule: [] }];
    return feedback;
  });
  await settleGuest();
  assert.ok(page.ids.get('route-list').all().some(node => node.textContent === 'Test city · 1 day'));
  assert.ok(page.ids.get('route-others-list').all().some(node => node.textContent === 'Optional city · Ideas'));
  assert.ok(!page.ids.get('route-list').all().some(node => node.textContent === 'Optional city · Ideas'));
  await page.control('Test city').click();
  assert.equal(page.control('Test city').attributes['aria-expanded'], 'false');
  assert.equal(page.ids.get('stays').all().find(node => node.id === 'stay-stay-a-body').hidden, true);
  await page.control('Test city · 1 day').click();
  assert.equal(page.control('Test city').attributes['aria-expanded'], 'true');
});

test('public daily notes precede schedule and remain collapsible without HTML interpretation', async () => {
  const page = guestHarness((action, feedback) => {
    feedback.projection.stays[0].days = [{ key: 'd:1', date: '2026-10-09', schedule: [], notes: [{ text: '<script>Day intent</script>\nWalk slowly.' }] }];
    return feedback;
  });
  await settleGuest();
  const day = page.ids.get('stays').all().find(node => node.id === 'day-d-1');
  const notes = day.children.find(node => node.className === 'day-notes');
  assert.equal(notes.open, true);
  assert.equal(day.children[1], notes);
  assert.equal(notes.children[1].textContent, '<script>Day intent</script>\nWalk slowly.');
  notes.open = false; notes.listeners.toggle();
  await page.control('Test city · 1 day').click();
  assert.equal(page.ids.get('stays').all().find(node => node.className === 'day-notes').open, false);
});

test('guest markup no longer calls the shared plan read-only', () => {
  assert.ok(!fs.readFileSync('client/guest.html', 'utf8').includes('Read-only trip plan'));
});

test('quick search selection creates a day suggestion and Edit opens full details', async () => {
  const suggestionId = '22222222-2222-4222-8222-222222222222';
  const place = { googlePlaceId: 'ChIJTestGarden', cityId: 'city-a', title: 'Garden', locality: 'Test city', countryCode: 'JP' };
  const page = guestHarness((action, feedback) => {
    feedback.projection.stays[0].days = [{ key: 'd:1', date: '2026-10-09', schedule: [] }];
    if (action.kind === 'places.autocomplete') return { suggestions: [{ predictionId: 'prediction-a', mainText: 'Garden' }] };
    if (action.kind === 'places.resolve') return { selectionId: 'selection-a', place };
    if (action.kind === 'suggestion.create') {
      feedback.myPendingSuggestions = [{ ...place, key: `s:${suggestionId}`, category: 'see', dayKey: 'd:1', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Garden&query_place_id=ChIJTestGarden', state: 'pending', reason: null, displayName: null }];
      return { suggestionId, state: 'pending' };
    }
    if (action.kind === 'suggestion.update') return { suggestionId, state: 'pending' };
    return feedback;
  });
  await settleGuest();
  await page.control('Recommend here').click();
  page.ids.get('place-search').listeners.input({ target: { value: 'Garden' } });
  await new Promise(resolve => setTimeout(resolve, 350));
  await page.ids.get('search-results').children[0].click();
  await settleGuest();
  const created = page.calls.find(action => action.kind === 'suggestion.create');
  assert.equal(created.dayKey, 'd:1');
  assert.equal(created.selectionId, 'selection-a');
  assert.equal(page.ids.get('suggest-dialog').open, false);
  await page.control('Edit').click();
  assert.equal(page.ids.get('suggest-dialog').dataset.mode, 'full');
  assert.equal(page.ids.get('suggest-personal-details').hidden, false);
  assert.equal(page.ids.get('suggest-submit').textContent, 'Save changes');
  page.ids.get('suggest-reason').value = 'Go at sunset';
  await page.ids.get('suggest-form').listeners.submit({ preventDefault() {} });
  const updated = page.calls.find(action => action.kind === 'suggestion.update');
  assert.equal(updated.suggestionId, suggestionId);
  assert.equal(updated.reason, 'Go at sunset');
  assert.equal(updated.selectionId, undefined);
});

test('rendered guest deletion sends only the selected comment and refreshes the inbox', async () => {
  const page = guestHarness((action, feedback) => {
    if (action.kind === 'comment.delete') {
      feedback.myComments = [];
      return { commentId: action.commentId, deleted: true };
    }
    return feedback;
  });
  page.feedback.myComments = [{ id: 'comment-a', text: 'My private tip', deleted: false }];
  await settleGuest();
  page.control('Delete comment').click();
  assert.equal(page.calls.length, 1);
  await page.control('Confirm delete comment').click();
  const write = page.calls.find(action => action.kind === 'comment.delete');
  assert.equal(write.commentId, 'comment-a');
  assert.deepEqual(Object.keys(write).sort(), ['commentId', 'kind', 'requestId', 'version']);
  assert.equal(page.control('Delete comment'), undefined);
  assert.equal(page.ids.get('announcement').textContent, 'Comment deleted.');
});

test('rendered withdrawal targets the guest pending suggestion', async () => {
  const page = guestHarness((action, feedback) => {
    if (action.kind === 'suggestion.withdraw') {
      feedback.myPendingSuggestions = [];
      return { suggestionId: action.suggestionId, state: 'withdrawn' };
    }
    return feedback;
  });
  page.feedback.myPendingSuggestions = [{ key: 's:suggestion-a', title: 'A garden', cityId: 'city-a', category: 'see', state: 'pending' }];
  await settleGuest();
  page.control('Withdraw suggestion').click();
  await page.control('Confirm withdraw suggestion').click();
  assert.equal(page.calls.find(action => action.kind === 'suggestion.withdraw').suggestionId, 'suggestion-a');
  assert.equal(page.control('Withdraw suggestion'), undefined);
});

test('erase-all closes the guest page and ignores a stale read response', async () => {
  let finishRead;
  const page = guestHarness((action, feedback) => {
    if (action.kind === 'read') return new Promise(resolve => { finishRead = () => resolve(feedback); });
    if (action.kind === 'session.erase') return { erased: true };
    assert.fail('unexpected action after erasure');
  });
  page.control('Erase my feedback').click();
  assert.equal(page.calls.length, 1);
  await page.control('Confirm erase my feedback').click();
  assert.equal(page.closed(), true);
  assert.equal(page.ids.get('content').hidden, true);
  assert.equal(page.ids.get('erasure-status').hidden, false);
  assert.equal(page.document.activeElement, page.ids.get('erasure-status'));
  finishRead(); await settleGuest();
  assert.equal(page.ids.get('content').hidden, true);
  await page.ids.get('comment-form').listeners.submit({ preventDefault() {} });
  assert.deepEqual(page.calls.map(action => action.kind), ['read', 'session.erase']);
});

test('unconfirmed erasure keeps the page usable and retries with the same request ID', async () => {
  let attempt = 0;
  const page = guestHarness((action, feedback) => action.kind === 'session.erase' ? { erased: ++attempt > 1 } : feedback);
  await settleGuest();
  page.control('Erase my feedback').click();
  const confirm = page.control('Confirm erase my feedback');
  await confirm.click();
  assert.equal(page.closed(), false);
  assert.equal(page.ids.get('content').inert, false);
  assert.equal(confirm.disabled, false);
  await confirm.click();
  const writes = page.calls.filter(action => action.kind === 'session.erase');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].requestId, writes[1].requestId);
  assert.equal(page.closed(), true);
});

test('removal control requires confirmation and restores focus on cancel', async () => {
  const document = removalDocument();
  let calls = 0;
  const control = loadController({ document }).removalControl('Delete comment', 'This removes your comment.', async () => { calls++; });
  const launch = control.children[0];
  launch.click();
  assert.equal(calls, 0);
  assert.equal(control.children[0].textContent, 'This removes your comment.');
  const confirm = control.children[1];
  assert.equal(document.activeElement, confirm);
  control.children[2].click();
  assert.equal(control.children[0], launch);
  assert.equal(document.activeElement, launch);
  assert.equal(calls, 0);
  launch.click();
  await control.children[1].click();
  assert.equal(calls, 1);
});

test('removal control prevents duplicate writes and permits retry after failure', async () => {
  const document = removalDocument();
  let reject; let calls = 0;
  const control = loadController({ document }).removalControl('Withdraw suggestion', 'Remove this pending suggestion?', () => {
    calls++;
    return new Promise((resolve, fail) => { reject = fail; });
  });
  control.children[0].click();
  const confirm = control.children[1]; const cancel = control.children[2];
  const pending = confirm.click();
  confirm.click(); cancel.click();
  assert.equal(calls, 1);
  assert.equal(confirm.disabled, true);
  assert.equal(cancel.disabled, true);
  reject(new Error('Try again later.'));
  await pending;
  assert.equal(confirm.disabled, false);
  assert.equal(cancel.disabled, false);
  assert.equal(control.children[3].textContent, 'Try again later.');
  assert.equal(control.children[3].attributes.role, 'alert');
  const retry = confirm.click();
  assert.equal(calls, 2);
  reject(new Error('Still unavailable.'));
  await retry;
});

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
