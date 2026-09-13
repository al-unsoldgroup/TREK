'use strict';

const crypto = require('node:crypto');
const { AdviceStore } = require('./advice-store');
const {
  AdviceError, IntegrationGap, assert, category, hash, mapsUrl, response,
  text, uuid, validateAction, validateScope
} = require('./protocol');

const store = new AdviceStore();
const acceptInFlight = new Map();
const acceptanceInFlight = new Map();

function stableUuid(seed) {
  const bytes = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function placeKey(place) {
  return String(place?.key || '');
}

function projectionPlaces(projection) {
  const out = [];
  for (const shortlist of projection.shortlists || []) {
    for (const place of [...(shortlist.see || []), ...(shortlist.eat || [])]) out.push(place);
  }
  for (const stay of projection.stays || []) {
    for (const day of stay.days || []) for (const item of day.schedule || []) out.push(item.place);
  }
  return out.filter(place => placeKey(place));
}

function shortlistPlaceKeys(projection) {
  const keys = new Set();
  for (const shortlist of projection.shortlists || []) {
    for (const place of [...(shortlist.see || []), ...(shortlist.eat || [])]) {
      if (placeKey(place)) keys.add(placeKey(place));
    }
  }
  return keys;
}

function publicPlace(row, categoryName) {
  const title = row.title || 'Suggested place';
  const locality = row.locality || '';
  const countryCode = row.country_code || '';
  return {
    key: `s:${row.id}`,
    title,
    category: categoryName || row.category,
    cityId: row.city_id,
    locality,
    countryCode,
    googlePlaceId: row.google_place_id,
    mapsUrl: mapsUrl(title, locality, countryCode),
    state: row.state,
    reason: row.reason || null,
    displayName: row.display_name || null
  };
}

function clientComments(rows) {
  return rows.map(row => ({
    id: row.id,
    displayName: row.display_name || null,
    text: row.body,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    deleted: row.deleted_at !== null
  }));
}

function cleanExpiredSuggestion(row, now) {
  if (row.provider_detail_expires_at && Number(row.provider_detail_expires_at) <= now) {
    return { ...row, title: null, locality: null, country_code: null };
  }
  return row;
}

function decodeCommentsCursor(cursor) {
  if (cursor === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    assert(value && Number.isSafeInteger(value.createdAt) && typeof value.id === 'string' && value.id.length <= 64, 'commentsCursor is invalid');
    return { createdAt: value.createdAt, id: value.id };
  } catch (error) {
    if (error instanceof AdviceError) throw error;
    throw new AdviceError(422, 'commentsCursor is invalid');
  }
}

function encodeCommentsCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: Number(row.created_at), id: row.id })).toString('base64url');
}

function importedResult(suggestion) {
  try {
    const imported = suggestion?.accepted_import_json ? JSON.parse(suggestion.accepted_import_json) : null;
    return imported && Number.isInteger(imported.placeId) ? imported : null;
  } catch { return null; }
}

function readAggregate(rows, eligible, guestId) {
  const byPlace = new Map();
  for (const row of rows) {
    if (!eligible.has(String(row.place_key))) continue;
    if (!byPlace.has(row.place_key)) byPlace.set(row.place_key, { placeKey: row.place_key, positive: 0, negative: 0, mine: 0, version: 0 });
    const item = byPlace.get(row.place_key);
    if (Number(row.value) === 1) item.positive++;
    if (Number(row.value) === -1) item.negative++;
    if (String(row.guest_id) === guestId) { item.mine = Number(row.value); item.version = Number(row.version); }
  }
  return [...byPlace.values()];
}

function normalizeResolved(raw) {
  const source = raw?.place && typeof raw.place === 'object' ? raw.place : raw;
  assert(source && typeof source === 'object', 'host selection is unavailable', 503, 'SELECTION_UNAVAILABLE');
  const googlePlaceId = source.googlePlaceId || source.google_place_id;
  const cityId = raw.destinationCityId || raw.cityId || source.cityId;
  const locality = source.locality || source.city || '';
  const title = source.title || source.name;
  const countryCode = source.countryCode || source.country_code;
  assert(typeof googlePlaceId === 'string' && googlePlaceId.length >= 3 && googlePlaceId.length <= 256, 'host selection has no valid Google place ID', 503, 'SELECTION_UNAVAILABLE');
  assert(typeof cityId === 'string' && cityId.length > 0 && cityId.length <= 80, 'host selection has no destination city', 503, 'SELECTION_UNAVAILABLE');
  assert(typeof title === 'string' && title.trim().length > 0 && title.length <= 200, 'host selection has no display name', 503, 'SELECTION_UNAVAILABLE');
  assert(typeof countryCode === 'string' && /^[A-Z]{2}$/.test(countryCode), 'host selection has no country code', 503, 'SELECTION_UNAVAILABLE');
  return {
    googlePlaceId: googlePlaceId.trim(), cityId: cityId.trim(), title: title.trim(),
    locality: typeof locality === 'string' ? locality.trim().slice(0, 100) : '', countryCode,
    duplicate: raw.duplicate || null
  };
}

async function hostSelection(ctx, selectionId) {
  const resolver = ctx.publicShare && ctx.publicShare.resolveSelection;
  if (typeof resolver !== 'function') throw new IntegrationGap('host resolveSelection is not available until the S3 public-share extension is installed');
  return normalizeResolved(await resolver({ selectionId }));
}

async function snapshot(ctx) {
  if (!ctx.publicShare || typeof ctx.publicShare.snapshot !== 'function') throw new IntegrationGap('host public-share snapshot is unavailable');
  return ctx.publicShare.snapshot();
}

async function read(ctx, scope, commentsCursor) {
  const projection = await snapshot(ctx);
  await store.clearExpiredProviderDetails(ctx, scope.shareId);
  const eligible = shortlistPlaceKeys(projection);
  const votes = readAggregate(await store.votes(ctx, scope.shareId), eligible, scope.guestId);
  const suggestions = (await store.suggestions(ctx, scope.shareId, scope.guestId)).map(row => publicPlace(cleanExpiredSuggestion(row, Date.now())));
  const comments = await store.comments(ctx, scope.shareId, scope.guestId, false, 50, decodeCommentsCursor(commentsCursor));
  const data = {
    projection,
    feedbackRevision: await store.revision(ctx, scope.shareId),
    votes,
    myPendingSuggestions: suggestions.filter(item => item.state === 'pending'),
    myComments: clientComments(comments),
    nextCommentsCursor: comments.length === 50 ? encodeCommentsCursor(comments[comments.length - 1]) : null
  };
  /* This is the S3 read shape consumed by the packaged guest page. S1's
   * snapshot-only host contract accepts the projection itself, so the host
   * must ship the feedback action extension before forwarding this response. */
  return data;
}

async function publicHandle(input, ctx) {
  const scope = validateScope(input && input.scope);
  const action = validateAction(input && input.action);
  if (input && Object.keys(input).some(key => !['version', 'scope', 'action'].includes(key))) throw new AdviceError(422, 'invocation contains an unsupported field');
  assert(input?.version === 1, 'invocation.version must be 1');
  if (action.kind === 'read') return read(ctx, scope, action.commentsCursor);

  const requestId = action.requestId;
  const payloadHash = hash(action);
  if (requestId) {
    const prior = await store.request(ctx, scope.shareId, scope.guestId, requestId);
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new AdviceError(409, 'request ID was already used for another payload', 'REQUEST_REUSE_CONFLICT');
      return prior.result;
    }
  }

  if (action.kind === 'vote.set') {
    const projection = await snapshot(ctx);
    const eligible = shortlistPlaceKeys(projection);
    assert(eligible.has(action.placeKey), 'place is not in the published advice snapshot', 422, 'PLACE_NOT_ELIGIBLE');
    const result = await store.applyVote(ctx, { ...scope, ...action, payloadHash });
    if (!result.applied) {
      const completed = result.request || await store.request(ctx, scope.shareId, scope.guestId, requestId);
      if (completed && completed.payload_hash === payloadHash) return completed.result;
      throw new AdviceError(409, 'vote version is stale; refresh the advice snapshot', 'VOTE_VERSION_CONFLICT');
    }
    const vote = result.request.result.data;
    return { ...response(action.kind, vote), vote };
  }

  if (action.kind === 'comment.create') {
    const commentId = stableUuid(`${scope.shareId}/${scope.guestId}/${action.requestId}`);
    const result = await store.createComment(ctx, {
      ...scope, requestId, payloadHash, commentId, body: action.text,
      displayName: action.displayName
    });
    if (!result.applied && !result.request) throw new AdviceError(409, 'comment could not be recorded', 'COMMENT_CONFLICT');
    return result.request.result;
  }

  if (action.kind === 'comment.delete') {
    const result = await store.deleteCommentForGuest(ctx, {
      ...scope, requestId, payloadHash, operation: action.kind, commentId: action.commentId
    });
    return result;
  }

  if (action.kind === 'suggestion.create') {
    const selection = await hostSelection(ctx, action.selectionId);
    const projection = await snapshot(ctx);
    const known = projectionPlaces(projection).find(place => place.googlePlaceId === selection.googlePlaceId);
    if (known || selection.duplicate) return { ...response(action.kind, {
      duplicate: selection.duplicate || { placeKey: known.key, cityId: known.cityId, category: known.category }
    }), duplicate: selection.duplicate || { placeKey: known.key, cityId: known.cityId, category: known.category } };
    const active = await store.findActiveSuggestion(ctx, scope.shareId, selection.googlePlaceId);
    if (active) return { ...response(action.kind, {
      duplicate: { placeKey: `s:${active.id}`, cityId: active.city_id, category: active.category }
    }), duplicate: { placeKey: `s:${active.id}`, cityId: active.city_id, category: active.category } };
    const id = stableUuid(`${scope.shareId}/${scope.guestId}/${action.requestId}`);
    const result = await store.createSuggestion(ctx, {
      ...scope, requestId, payloadHash, id, googlePlaceId: selection.googlePlaceId,
      cityId: selection.cityId, category: category(action.category), title: selection.title,
      locality: selection.locality, countryCode: selection.countryCode,
      reason: action.reason, displayName: action.displayName,
      providerDetailExpiresAt: Date.now() + 24 * 60 * 60 * 1000
    });
    if (!result.applied && !result.request) {
      const duplicate = await store.findActiveSuggestion(ctx, scope.shareId, selection.googlePlaceId);
      if (duplicate) return { ...response(action.kind, { duplicate: { placeKey: `s:${duplicate.id}`, cityId: duplicate.city_id, category: duplicate.category } }), duplicate: { placeKey: `s:${duplicate.id}`, cityId: duplicate.city_id, category: duplicate.category } };
      throw new AdviceError(409, 'suggestion is already pending', 'SUGGESTION_DUPLICATE');
    }
    return result.request.result;
  }

  if (action.kind === 'suggestion.withdraw') {
    const result = await store.withdrawSuggestion(ctx, {
      ...scope, ...action, payloadHash, operation: action.kind
    });
    return result;
  }

  if (action.kind === 'session.erase') {
    const result = await store.eraseGuestAction(ctx, { ...scope, ...action, payloadHash, operation: action.kind });
    return result.result;
  }

  throw new IntegrationGap(`${action.kind} is host-handled and is not part of the S1 public-share dispatch surface`);
}

async function ownerScope(ctx, tripId, allowUnconfigured = false) {
  const owner = ctx.publicShare && ctx.publicShare.owner;
  if (!owner || typeof owner.getConfig !== 'function') throw new IntegrationGap('host owner share context is not available until the S3 owner extension is installed');
  const config = await owner.getConfig({ tripId });
  if (config === null && allowUnconfigured) return { owner, config, shareId: null };
  if (!config || !config.shareId) throw new AdviceError(404, 'advice share not found');
  return { owner, config, shareId: uuid(config.shareId, 'shareId') };
}

async function ownerRead(ctx, tripId) {
  const { owner, config, shareId } = await ownerScope(ctx, tripId, true);
  const setup = typeof owner.getCandidates === 'function'
    ? { candidates: await owner.getCandidates({ tripId }) } : {};
  if (shareId === null) return { version: 1, config: null, ...setup, inbox: { suggestions: [], comments: [] } };
  await store.clearExpiredProviderDetails(ctx, shareId);
  return {
    version: 1,
    config,
    ...setup,
    inbox: {
      suggestions: (await store.suggestions(ctx, shareId, null, true)).map(row => cleanExpiredSuggestion(row, Date.now())),
      comments: clientComments(await store.comments(ctx, shareId, null, true, 100))
    }
  };
}

function importApi(owner) {
  if (typeof owner?.importSuggestion === 'function') return owner.importSuggestion.bind(owner);
  throw new IntegrationGap('host publicShare.owner.importSuggestion is not available until the S5 native-import extension is installed');
}

function importOnce(owner, tripId, payload) {
  const key = `${tripId}/${payload.externalKey}`;
  const prior = acceptInFlight.get(key);
  if (prior) return prior;
  const pending = Promise.resolve().then(() => importApi(owner)(tripId, payload));
  acceptInFlight.set(key, pending);
  pending.finally(() => {
    if (acceptInFlight.get(key) === pending) acceptInFlight.delete(key);
  }).catch(() => {});
  return pending;
}

async function performAcceptSuggestion(ctx, tripId, suggestionId, body, req) {
  const { owner, shareId } = await ownerScope(ctx, tripId);
  uuid(suggestionId, 'suggestionId');
  body = body || {};
  assert(body && typeof body === 'object' && !Array.isArray(body), 'accept body must be an object');
  for (const key of Object.keys(body)) assert(key === 'existingPlaceId', `accept.${key} is not allowed`);
  if (body.existingPlaceId !== undefined) assert(Number.isInteger(body.existingPlaceId) && body.existingPlaceId > 0, 'existingPlaceId must be a positive integer');
  const suggestion = await store.suggestion(ctx, shareId, suggestionId);
  if (!suggestion) throw new AdviceError(404, 'suggestion not found');
  if (suggestion.state === 'accepted') {
    const imported = importedResult(suggestion);
    if (!imported || !Number.isInteger(imported.placeId)) throw new AdviceError(409, 'accepted suggestion has no canonical import result', 'SUGGESTION_STATE_CONFLICT');
    return { version: 1, suggestion: cleanExpiredSuggestion(suggestion, Date.now()), imported, scheduled: false };
  }
  assert(suggestion.state === 'pending' || suggestion.state === 'accepting', 'suggestion cannot be accepted in its current state', 409, 'SUGGESTION_STATE_CONFLICT');
  let payload;
  if (suggestion.state === 'accepting') {
    if (!suggestion.reviewed_payload_json) throw new AdviceError(409, 'accepting suggestion has no recoverable payload; refresh the suggestion before accepting', 'SUGGESTION_STATE_CONFLICT');
    try { payload = JSON.parse(suggestion.reviewed_payload_json); } catch { throw new AdviceError(409, 'accepting suggestion has an invalid recoverable payload', 'SUGGESTION_STATE_CONFLICT'); }
  } else {
    assert(suggestion.title && suggestion.locality !== null && suggestion.country_code, 'provider details expired; refresh the suggestion before accepting', 409, 'PROVIDER_DETAIL_EXPIRED');
    payload = {
      tripId, externalKey: `${shareId}/${suggestion.id}`, expectedPayloadHash: null,
      place: {
        name: text(suggestion.title, 'place.name', 200), googlePlaceId: suggestion.google_place_id,
        address: suggestion.locality || undefined, categoryId: suggestion.category === 'eat' ? 2 : 1
      },
      existingPlaceId: body?.existingPlaceId
    };
    payload.expectedPayloadHash = hash(payload);
    await store.beginAccept(ctx, shareId, suggestion.id, payload, req.user?.id ?? null);
    payload = (await store.suggestion(ctx, shareId, suggestion.id))?.reviewed_payload_json;
    if (!payload) throw new AdviceError(409, 'accepting suggestion has no recoverable payload', 'SUGGESTION_STATE_CONFLICT');
    try { payload = JSON.parse(payload); } catch { throw new AdviceError(409, 'accepting suggestion has an invalid recoverable payload', 'SUGGESTION_STATE_CONFLICT'); }
  }
  const imported = await importOnce(owner, tripId, payload);
  assert(imported && Number.isInteger(imported.placeId) && imported.placeId > 0, 'host native import returned no place ID', 503, 'IMPORT_UNAVAILABLE');
  const canonicalImport = { placeId: imported.placeId, created: Boolean(imported.created) };
  const final = await store.completeAccept(ctx, shareId, suggestion.id, canonicalImport);
  const persistedImport = importedResult(final) || canonicalImport;
  return { version: 1, suggestion: final, imported: persistedImport, scheduled: false };
}

function acceptSuggestion(ctx, tripId, suggestionId, body, req) {
  const key = `${tripId}/${suggestionId}`;
  const prior = acceptanceInFlight.get(key);
  if (prior) return prior;
  const pending = performAcceptSuggestion(ctx, tripId, suggestionId, body, req);
  acceptanceInFlight.set(key, pending);
  pending.finally(() => {
    if (acceptanceInFlight.get(key) === pending) acceptanceInFlight.delete(key);
  }).catch(() => {});
  return pending;
}

async function configure(ctx, tripId, body) {
  const { owner } = await ownerScope(ctx, tripId, true);
  assert(body && typeof body === 'object' && !Array.isArray(body), 'config body must be an object');
  for (const key of Object.keys(body)) assert(['expectedRevision', 'config', 'enabled', 'expiresInDays', 'previewRevision'].includes(key), `config.${key} is not allowed`);
  assert(Number.isInteger(body.expectedRevision) && body.expectedRevision >= 0, 'expectedRevision must be a non-negative integer');
  assert(body.config && body.config.version === 1, 'config.version must be 1');
  if (typeof owner.configure !== 'function') throw new IntegrationGap('host owner.configure is not available until the S3 owner extension is installed');
  return owner.configure({ tripId, expectedRevision: body.expectedRevision, config: body.config,
    enabled: body.enabled, expiresInDays: body.expiresInDays, previewRevision: body.previewRevision });
}

async function preview(ctx, tripId, body) {
  const { owner } = await ownerScope(ctx, tripId, true);
  assert(body && typeof body === 'object' && !Array.isArray(body), 'preview config must be an object');
  assert(body.version === 1, 'config.version must be 1');
  if (typeof owner.preview !== 'function') throw new IntegrationGap('host owner.preview is not available until the S3 owner extension is installed');
  return owner.preview({ tripId, config: body });
}

async function rejectSuggestion(ctx, tripId, suggestionId, req) {
  const { shareId } = await ownerScope(ctx, tripId);
  return { version: 1, suggestion: await store.rejectSuggestion(ctx, shareId, uuid(suggestionId, 'suggestionId'), req.user?.id ?? null) };
}

async function ownerDeleteComment(ctx, tripId, commentId) {
  const { shareId } = await ownerScope(ctx, tripId);
  return { version: 1, commentId: uuid(commentId, 'commentId'), deleted: await store.deleteComment(ctx, shareId, uuid(commentId, 'commentId')) };
}

async function ownerPurgeFeedback(ctx, tripId) {
  const { shareId } = await ownerScope(ctx, tripId);
  await store.purge(ctx, shareId);
  return { version: 1, purged: true };
}

function responseFor(error) {
  const status = error instanceof AdviceError ? error.status : 500;
  const body = status >= 500 ? { error: 'advice service unavailable' } : { error: error.message, code: error.code };
  return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(body) };
}

async function routeHandler(req, ctx, operation) {
  try {
    const tripId = Number(req.params?.tripId || req.query?.tripId || String(req.path).match(/\/owner\/(\d+)/)?.[1]);
    assert(Number.isInteger(tripId) && tripId > 0, 'tripId must be a positive integer');
    if (operation === 'read') return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(await ownerRead(ctx, tripId)) };
    if (operation === 'configure') return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(await configure(ctx, tripId, req.body)) };
    if (operation === 'preview') return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(await preview(ctx, tripId, req.body)) };
    const id = req.params?.suggestionId || req.query?.suggestionId || String(req.path).match(/suggestions\/([0-9a-f-]{36})/)?.[1];
    if (operation === 'accept') return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(await acceptSuggestion(ctx, tripId, id, req.body || {}, req)) };
    if (operation === 'reject') return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(await rejectSuggestion(ctx, tripId, id, req)) };
    const commentId = req.params?.commentId || req.query?.commentId || String(req.path).match(/comments\/([0-9a-f-]{36})/)?.[1];
    if (operation === 'comment-delete') return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(await ownerDeleteComment(ctx, tripId, commentId)) };
    if (operation === 'purge') return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(await ownerPurgeFeedback(ctx, tripId)) };
    throw new AdviceError(404, 'route not found');
  } catch (error) {
    return responseFor(error);
  }
}

module.exports = {
  store, publicHandle, ownerRead, configure, preview, acceptSuggestion, rejectSuggestion,
  ownerDeleteComment, ownerPurgeFeedback, routeHandler, responseFor, stableUuid, projectionPlaces, normalizeResolved,
  shortlistPlaceKeys
};
