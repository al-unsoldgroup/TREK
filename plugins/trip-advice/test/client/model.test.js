const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const context = { window: {}, URL, Set, Map, Intl };
context.window = context;
vm.createContext(context);
for (const file of ['client/advice-model.js', 'client/advice-protocol.js']) {
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(context);
}

const M = context.TrekAdviceModel;
const P = context.TrekAdviceProtocol;
const place = (key, cityId, category = 'see') => ({
  key, title: key + ' place', category, cityId, locality: cityId, countryCode: 'XX', googlePlaceId: null,
  mapsUrl: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(key + ' place ' + cityId + ' XX')
});
const projection = {
  version: 1, revision: 'rev-1', title: 'A shared trip',
  cities: [{ id: 'north', label: 'North', countryCodes: ['XX'] }, { id: 'south', label: 'South', countryCodes: ['XX'] }],
  stays: [
    { id: 'stay-1', cityId: 'north', shortlistCityId: 'north', days: [{ key: 'day-1', date: '2026-10-09', schedule: [{ key: 'row-1', place: place('scheduled', 'north'), time: null, booked: false }] }] },
    { id: 'stay-2', cityId: 'north', shortlistCityId: 'north', days: [{ key: 'day-2', date: '2026-10-11', schedule: [] }] },
    { id: 'stay-3', cityId: 'south', shortlistCityId: 'south', days: [] }
  ],
  shortlists: [{ cityId: 'north', see: [place('short-1', 'north')], eat: [place('food-1', 'north', 'eat')] }, { cityId: 'south', see: [], eat: [] }]
};

test('projection navigation keeps repeated-city advice canonical and categories independent', () => {
  assert.equal(P.validProjection(projection), true);
  assert.equal(JSON.stringify(M.uniqueDates(projection).map(item => item.date)), JSON.stringify(['2026-10-09', '2026-10-11']));
  let state = M.initial(projection);
  state = M.apply(state, { type: 'category', cityId: 'north', category: 'eat' }, projection);
  assert.equal(state.categories.north, 'eat');
  assert.equal(state.categories.south, 'see');
  assert.equal(state.selectedDate, '2026-10-09');
  state = M.apply(state, { type: 'date', date: '2026-10-11' }, projection);
  assert.equal(state.selectedDate, '2026-10-11');
  assert.equal(state.selectedCityId, 'north');
});

test('desired votes support up, change, and undo without negative counts', () => {
  let state = M.initial(projection);
  state = M.apply(state, { type: 'vote.result', placeKey: 'short-1', vote: { positive: 4, negative: 1, mine: 1, version: 1 } }, projection);
  assert.equal(JSON.stringify(M.voteFor(state, 'short-1')), JSON.stringify({ positive: 4, negative: 1, mine: 1, version: 1 }));
  state = M.apply(state, { type: 'vote.result', placeKey: 'short-1', vote: { positive: 4, negative: 2, mine: -1, version: 2 } }, projection);
  assert.equal(M.voteFor(state, 'short-1').mine, -1);
  state = M.apply(state, { type: 'vote.result', placeKey: 'short-1', vote: { positive: 4, negative: 1, mine: 0, version: 3 } }, projection);
  assert.equal(M.voteFor(state, 'short-1').negative, 1);
  assert.ok(M.voteFor(state, 'short-1').positive >= 0 && M.voteFor(state, 'short-1').negative >= 0);
});

test('suggestions stay pending, duplicate by stable key, and jump to their destination', () => {
  let state = M.initial(projection);
  const suggestion = { key: 's:new', title: 'New North idea', category: 'see', cityId: 'north', locality: 'North', countryCode: 'XX', googlePlaceId: 'ChIJ-real', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=New%20North%20XX' };
  state = M.apply(state, { type: 'suggestion', place: suggestion, displayName: '<guest>', reason: 'A tip' }, projection);
  assert.equal(state.pendingSuggestions.length, 1);
  state = M.apply(state, { type: 'suggestion', place: suggestion, displayName: 'another' }, projection);
  assert.equal(state.pendingSuggestions.length, 1);
  state = M.apply(state, { type: 'jump', target: { cityId: 'north', category: 'eat', date: '2026-10-11' } }, projection);
  assert.equal(state.selectedDate, '2026-10-11');
  assert.equal(state.categories.north, 'eat');
});

test('comments trim safely and reset clears local feedback', () => {
  let state = M.initial(projection);
  state = M.apply(state, { type: 'comment', id: 'comment-1', displayName: '<Al>', text: '  Nice tip <b>  ' }, projection);
  assert.equal(state.comments[0].text, 'Nice tip <b>');
  assert.equal(state.comments[0].displayName, '<Al>');
  state = M.apply(state, { type: 'reset' }, projection);
  assert.equal(state.comments.length, 0);
  assert.equal(state.pendingSuggestions.length, 0);
});

test('maps URLs encode the actual destination and never invent a place id', () => {
  const url = M.mapsUrl({ title: 'A & B', locality: 'South', countryCode: 'XX', mapsUrl: '' });
  assert.ok(url.startsWith('https://www.google.com/maps/search/?api=1&query='));
  assert.equal(new URL(url).searchParams.get('query'), 'A & B South XX');
  assert.equal(new URL(url).searchParams.has('query_place_id'), false);
});

test('public actions are strict and never carry a client scope', () => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(P.validAction({ version: 1, kind: 'read' }), true);
  assert.equal(P.validAction({ version: 1, kind: 'read', shareId: 'private' }), false);
  assert.equal(P.validAction({ version: 1, kind: 'vote.set', requestId, placeKey: 'short-1', value: 1, expectedVersion: 0 }), true);
  assert.equal(P.validAction({ version: 1, kind: 'vote.set', requestId, placeKey: 'short-1', value: 1, expectedVersion: 0, guestId: 'leak' }), false);
  assert.equal(P.validAction({ version: 1, kind: 'places.autocomplete', searchId: requestId, cityId: 'north', category: 'see', input: 'ab', locale: 'en' }), true);
});

test('read envelopes and optional photo payloads validate at the boundary', () => {
  assert.ok(P.readData(projection));
  assert.equal(P.validPlace({ ...place('p', 'north'), photo: { handle: 'photo-1' } }), true);
  assert.equal(P.validPlace({ ...place('p2', 'north'), photo: { state: 'unavailable' } }), true);
  assert.equal(P.validPhoto({ state: 'unavailable', mimeType: null, bytesBase64: null, authors: [], googleAttribution: null }), true);
  assert.equal(P.validPhoto({ state: 'unavailable', mimeType: null, bytesBase64: null, authors: [{ displayName: 'x', uri: 'https://example.com' }], googleAttribution: null }), false);
});
