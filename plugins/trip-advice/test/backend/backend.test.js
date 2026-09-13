'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const plugin = require('../../server');
const { store, publicHandle, acceptSuggestion, stableUuid } = require('../../server/lib/advice-service');

const SHARE_A = '11111111-1111-4111-8111-111111111111';
const SHARE_B = '22222222-2222-4222-8222-222222222222';
const GUEST_A = 'guest-a';
const GUEST_B = 'guest-b';
let sequence = 0;

class SqliteDb {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.migrations = new Set();
    this.calls = [];
  }
  query(sql, ...args) { this.calls.push({ method: 'query', sql, args }); return this.sqlite.prepare(sql).all(...args); }
  exec(sql, ...args) {
    this.calls.push({ method: 'exec', sql, args });
    const result = this.sqlite.prepare(sql).run(...args);
    return { changes: Number(result.changes || 0) };
  }
  migrate(id, sql) {
    if (this.migrations.has(id)) return Promise.resolve({ applied: false });
    this.sqlite.exec(sql);
    this.migrations.add(id);
    return Promise.resolve({ applied: true });
  }
  tx(ops) {
    this.calls.push({ method: 'tx', ops });
    this.sqlite.exec('BEGIN');
    try {
      const results = ops.map(op => {
        const statement = this.sqlite.prepare(op.sql);
        if (/\bRETURNING\b|^\s*(SELECT|WITH)\b/i.test(op.sql)) return { rows: statement.all(...(op.args || [])) };
        return { changes: Number(statement.run(...(op.args || [])).changes || 0) };
      });
      this.sqlite.exec('COMMIT');
      return { results };
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

function id() { sequence += 1; return stableUuid(`request-${sequence}`); }

function projection() {
  const place = (key, title, category, cityId = 'tokyo') => ({ key, title, category, cityId, locality: cityId, countryCode: 'JP', googlePlaceId: `google-${key}`, mapsUrl: `https://www.google.com/maps/search/?api=1&query=${title}` });
  return {
    version: 1,
    revision: 'host-revision',
    title: 'Test trip',
    cities: [{ id: 'tokyo', label: 'Tokyo', countryCodes: ['JP'] }],
    stays: [{ id: 'stay-1', cityId: 'tokyo', shortlistCityId: 'tokyo', days: [{ key: 'day-1', date: '2026-10-09', schedule: [{ key: 'a:3', place: place('p:3', 'Settled activity', 'see'), time: null, booked: false }] }] }],
    shortlists: [{ cityId: 'tokyo', see: [place('p:1', 'Meiji Jingu', 'see')], eat: [place('p:2', 'Sushi Dai', 'eat')] }]
  };
}

function context(overrides = {}) {
  const db = overrides.db || new SqliteDb();
  return {
    db,
    publicShare: { snapshot: async () => projection(), ...(overrides.publicShare || {}) },
    places: overrides.places,
    trips: overrides.trips,
    config: {}
  };
}

async function ready(overrides) {
  const ctx = context(overrides);
  await plugin.onLoad(ctx);
  return ctx;
}

async function readAction(ctx, shareId = SHARE_A, guestId = GUEST_A) {
  return publicHandle({ version: 1, scope: { shareId, guestId, epoch: 1 }, action: { version: 1, kind: 'read' } }, ctx);
}

test('first owner read returns an empty setup without creating a share', async () => {
  const ctx = await ready({ publicShare: { owner: { getConfig: async ({ tripId }) => {
    assert.equal(tripId, 1);
    return null;
  } } } });
  const before = ctx.db.calls.length;
  const result = await require('../../server/lib/advice-service').routeHandler({ path: '/owner/1', params: {}, query: {} }, ctx, 'read');
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { version: 1, config: null, inbox: { suggestions: [], comments: [] } });
  assert.equal(ctx.db.calls.length, before, 'initial setup must not query or mutate share feedback');
});

test('owner read preserves host access denial', async () => {
  const ctx = await ready({ publicShare: { owner: { getConfig: async () => {
    const { AdviceError } = require('../../server/lib/protocol');
    throw new AdviceError(403, 'Forbidden');
  } } } });
  const result = await require('../../server/lib/advice-service').routeHandler({ path: '/owner/1', params: {}, query: {} }, ctx, 'read');
  assert.equal(result.status, 403);
});

test('owner routes match the host literal-path proxy and accept IDs through query parameters', async () => {
  const ctx = await ready({ publicShare: { owner: { getConfig: async ({ tripId }) => {
    assert.equal(tripId, 3);
    return null;
  } } } });
  const route = plugin.routes.find(route => route.method === 'GET' && route.path === '/owner');
  assert.ok(route, 'host proxy requires an exact static path');
  assert.ok(plugin.routes.every(route => route.auth === true && !route.path.includes(':')));
  const result = await route.handler({ path: '/owner', query: { tripId: '3' } }, ctx);
  assert.equal(result.status, 200);
  const missing = await route.handler({ path: '/owner', query: {} }, ctx);
  assert.equal(missing.status, 422);
});

test('first-use preview and configure reach the authorized host without an existing share', async () => {
  const calls = [];
  const draft = { version: 1, publicTitle: 'Public trip', cities: [], stays: [], schedule: [], shortlist: [] };
  const ctx = await ready({ publicShare: { owner: {
    getConfig: async () => null,
    preview: async input => { calls.push(['preview', input]); return { revision: 'preview-revision' }; },
    configure: async input => { calls.push(['configure', input]); return { revision: 1 }; },
  } } });
  const previewRoute = plugin.routes.find(route => route.method === 'POST' && route.path === '/owner/preview');
  const configureRoute = plugin.routes.find(route => route.method === 'PUT' && route.path === '/owner/config');
  assert.equal((await previewRoute.handler({ path: previewRoute.path, query: { tripId: '3' }, body: draft }, ctx)).status, 200);
  assert.equal((await configureRoute.handler({ path: configureRoute.path, query: { tripId: '3' }, body: {
    expectedRevision: 0, config: draft, enabled: false, expiresInDays: 30,
  } }, ctx)).status, 200);
  assert.deepEqual(calls, [
    ['preview', { tripId: 3, config: draft }],
    ['configure', { tripId: 3, expectedRevision: 0, config: draft, enabled: false, expiresInDays: 30, previewRevision: undefined }],
  ]);
});

test('owner setup includes only the host-authorized candidate response', async () => {
  const candidates = { days: [{ id: 7, date: '2026-10-09' }], schedule: [], shortlist: [] };
  const ctx = await ready({ publicShare: { owner: {
    getConfig: async () => null,
    getCandidates: async ({ tripId }) => { assert.equal(tripId, 3); return candidates; },
  } } });
  const result = await plugin.routes[0].handler({ path: '/owner', query: { tripId: '3' } }, ctx);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body).candidates, candidates);
});

test('migrations are plugin-owned and every vote is a desired state with atomic idempotency', async () => {
  const ctx = await ready();
  const scope = { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 };
  const requestId = id();
  const action = { version: 1, kind: 'vote.set', requestId, placeKey: 'p:1', value: 1, expectedVersion: 0 };
  const [first, retry] = await Promise.all([
    publicHandle({ version: 1, scope, action }, ctx),
    publicHandle({ version: 1, scope, action }, ctx)
  ]);
  assert.deepEqual(retry, first);
  assert.equal(first.data.version, 1);
  assert.equal(first.data.positive, 1);
  assert.equal(first.data.mine, 1);
  assert.equal(retry.data.mine, 1);
  await assert.rejects(
    publicHandle({ version: 1, scope, action: { ...action, requestId: id() } }, ctx),
    error => error.code === 'VOTE_VERSION_CONFLICT'
  );
  const downAction = { ...action, requestId: id(), value: -1, expectedVersion: 1 };
  const down = await publicHandle({ version: 1, scope, action: downAction }, ctx);
  const downRetry = await publicHandle({ version: 1, scope, action: downAction }, ctx);
  assert.equal(down.data.mine, -1);
  assert.equal(down.data.value, -1);
  assert.equal(down.data.version, 2);
  assert.equal(downRetry.data.mine, -1);
  const undoAction = { ...action, requestId: id(), value: 0, expectedVersion: 2 };
  const undo = await publicHandle({ version: 1, scope, action: undoAction }, ctx);
  const undoRetry = await publicHandle({ version: 1, scope, action: undoAction }, ctx);
  assert.equal(undo.data.mine, 0);
  assert.equal(undo.data.value, 0);
  assert.equal(undo.data.version, 3);
  assert.equal(undoRetry.data.mine, 0);
  assert.equal(undo.data.positive, 0);
  await assert.rejects(
    publicHandle({ version: 1, scope, action: { ...action, requestId: id(), placeKey: 'p:3' } }, ctx),
    error => error.code === 'PLACE_NOT_ELIGIBLE'
  );
  assert.match(ctx.db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'advice_votes'").get().sql, /PRIMARY KEY \(share_id, guest_id, place_key\)/);
  assert.ok(ctx.db.calls.some(call => call.method === 'query' && call.args.length > 0), 'ctx.db uses the host rest-argument convention');
  for (const call of ctx.db.calls) {
    const sqls = call.method === 'tx' ? call.ops.map(op => op.sql) : [call.sql];
    for (const sql of sqls) if (/advice_(votes|comments|suggestions|requests|revisions)/.test(sql)) assert.match(sql, /share_id/);
  }
});

test('feedback is scoped by share and guest, with owner-only aggregate visibility', async () => {
  const ctx = await ready();
  const created = await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action: { version: 1, kind: 'comment.create', requestId: id(), text: 'Please keep the morning flexible', displayName: 'A' } }, ctx);
  const commentId = created.data.commentId;
  const guestB = await readAction(ctx, SHARE_A, GUEST_B);
  assert.deepEqual(guestB.myComments, []);
  const ownerCtx = { ...ctx, publicShare: { ...ctx.publicShare, owner: { getConfig: async () => ({ shareId: SHARE_A, revision: 1 }) } } };
  const owner = JSON.parse((await require('../../server/lib/advice-service').routeHandler({ path: '/owner/1', query: {}, params: {}, body: null }, ownerCtx, 'read')).body);
  assert.equal(owner.inbox.comments.length, 1);
  const otherGuestDelete = await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_B, epoch: 1 }, action: { version: 1, kind: 'comment.delete', requestId: id(), commentId } }, ctx);
  assert.equal(otherGuestDelete.data.deleted, false);
  const ownDelete = await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action: { version: 1, kind: 'comment.delete', requestId: id(), commentId } }, ctx);
  assert.equal(ownDelete.data.deleted, true);
  const deleteRetryAction = { version: 1, kind: 'comment.delete', requestId: id(), commentId };
  const deleteRetry = await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action: deleteRetryAction }, ctx);
  assert.equal(deleteRetry.data.deleted, false);
  assert.deepEqual(deleteRetry, await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action: deleteRetryAction }, ctx));
  assert.deepEqual((await readAction(ctx, SHARE_A, GUEST_A)).myComments, []);
  const ownerAfterDelete = JSON.parse((await require('../../server/lib/advice-service').routeHandler({ path: '/owner/1', query: {}, params: {}, body: null }, ownerCtx, 'read')).body);
  assert.deepEqual(ownerAfterDelete.inbox.comments, []);
});

test('suggestions use host-resolved identity and prevent duplicates without cross-share leakage', async () => {
  let selected = { googlePlaceId: 'google-new', cityId: 'tokyo', title: 'Kappabashi Kitchen', locality: 'Tokyo', countryCode: 'JP' };
  const ctx = await ready({ publicShare: { resolveSelection: async ({ selectionId }) => selectionId.includes('withdraw') ? { ...selected, googlePlaceId: 'google-withdraw', title: 'Withdrawn place' } : selected } });
  const action = { version: 1, kind: 'suggestion.create', requestId: id(), selectionId: 'host-selection-1', category: 'see', reason: 'Good rainy-day option' };
  const first = await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action }, ctx);
  assert.equal(first.data.state, 'pending');
  const duplicate = await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_B, epoch: 1 }, action: { ...action, requestId: id() } }, ctx);
  assert.equal(duplicate.data.duplicate.placeKey.startsWith('s:'), true);
  const otherShare = await publicHandle({ version: 1, scope: { shareId: SHARE_B, guestId: GUEST_B, epoch: 1 }, action: { ...action, requestId: id() } }, ctx);
  assert.equal(otherShare.data.state, 'pending');
  await ctx.db.exec('UPDATE advice_suggestions SET provider_detail_expires_at = 0 WHERE share_id = ?', SHARE_B);
  await readAction(ctx, SHARE_A, GUEST_A);
  assert.equal((await store.suggestion(ctx, SHARE_B, otherShare.data.suggestionId)).title, 'Kappabashi Kitchen');
  const guest = await readAction(ctx, SHARE_A, GUEST_A);
  assert.equal(guest.myPendingSuggestions.length, 1);
  assert.equal(guest.myPendingSuggestions[0].googlePlaceId, 'google-new');
  assert.match(guest.myPendingSuggestions[0].mapsUrl, /google\.com\/maps\/search/);
  const withdrawn = await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action: { ...action, requestId: id(), selectionId: 'host-selection-withdraw' } }, ctx);
  const withdrawAction = { version: 1, kind: 'suggestion.withdraw', requestId: id(), suggestionId: withdrawn.data.suggestionId };
  const withdrawnResult = await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action: withdrawAction }, ctx);
  assert.deepEqual(withdrawnResult, await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action: withdrawAction }, ctx));
  assert.equal(withdrawnResult.data.state, 'withdrawn');
});

test('owner acceptance survives a crash and imports once without assigning a day', async () => {
  let attempts = 0;
  let importCalls = [];
  const owner = { getConfig: async () => ({ shareId: SHARE_A, revision: 1 }) };
  const ctx = await ready({
    publicShare: {
      owner: { ...owner, importSuggestion: async (tripId, payload) => {
        attempts += 1;
        importCalls.push({ tripId, payload });
        if (attempts === 1) throw new Error('simulated process crash after accepting state');
        return { placeId: 77, created: true };
      } },
      resolveSelection: async () => ({ googlePlaceId: 'google-accepted', cityId: 'tokyo', title: 'Owner-approved place', locality: 'Tokyo', countryCode: 'JP' })
    }
  });
  const created = await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action: { version: 1, kind: 'suggestion.create', requestId: id(), selectionId: 'selection-2', category: 'eat' } }, ctx);
  const suggestionId = created.data.suggestionId;
  await assert.rejects(acceptSuggestion(ctx, 42, suggestionId, {}, { user: { id: 9 } }), /simulated process crash/);
  const [accepted, concurrent] = await Promise.all([
    acceptSuggestion(ctx, 42, suggestionId, {}, { user: { id: 9 } }),
    acceptSuggestion(ctx, 42, suggestionId, {}, { user: { id: 9 } })
  ]);
  assert.deepEqual(concurrent, accepted);
  const replay = await acceptSuggestion(ctx, 42, suggestionId, {}, { user: { id: 9 } });
  assert.deepEqual(replay, accepted);
  const final = await require('../../server/lib/advice-service').store.suggestion(ctx, SHARE_A, suggestionId);
  assert.equal(final.state, 'accepted');
  assert.equal(final.accepted_place_id, 77);
  assert.equal(importCalls.length, 2);
  assert.equal(importCalls[1].payload.externalKey, `${SHARE_A}/${suggestionId}`);
  assert.equal(importCalls[1].payload.place.googlePlaceId, 'google-accepted');
  assert.equal(importCalls[1].payload.dayId, undefined);
  await ctx.db.exec("UPDATE advice_suggestions SET state = 'accepting', reviewed_payload_json = NULL WHERE id = ?", suggestionId);
  await assert.rejects(
    acceptSuggestion(ctx, 42, suggestionId, {}, { user: { id: 9 } }),
    error => error.code === 'SUGGESTION_STATE_CONFLICT' && error.status === 409
  );
});

test('eraseGuest and purge are idempotent and only remove this addon data', async () => {
  const ctx = await ready();
  await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action: { version: 1, kind: 'comment.create', requestId: id(), text: 'erase me' } }, ctx);
  const eraseAction = { version: 1, kind: 'session.erase', requestId: id() };
  const erased = await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action: eraseAction }, ctx);
  assert.deepEqual(erased, await publicHandle({ version: 1, scope: { shareId: SHARE_A, guestId: GUEST_A, epoch: 1 }, action: eraseAction }, ctx));
  await plugin.publicShare.eraseGuest({ shareId: SHARE_A, guestId: GUEST_A }, ctx);
  await plugin.publicShare.eraseGuest({ shareId: SHARE_A, guestId: GUEST_A }, ctx);
  assert.equal((await readAction(ctx)).myComments.length, 0);
  await plugin.publicShare.purge({ shareId: SHARE_A }, ctx);
  await plugin.publicShare.purge({ shareId: SHARE_A }, ctx);
  assert.equal(await store.revision(ctx, SHARE_A), 0);
});
