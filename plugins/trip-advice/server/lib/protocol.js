'use strict';

const crypto = require('node:crypto');

const PLUGIN_ID = 'trip-advice';
const MAX_TEXT = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORY = new Set(['see', 'eat']);

class AdviceError extends Error {
  constructor(status, message, code = 'ADVICE_ERROR') {
    super(message);
    this.name = 'AdviceError';
    this.status = status;
    this.code = code;
  }
}

class IntegrationGap extends AdviceError {
  constructor(message) { super(503, message, 'HOST_CONTRACT_UNAVAILABLE'); }
}

function assert(condition, message, status = 422, code = 'INVALID_ADVICE_INPUT') {
  if (!condition) throw new AdviceError(status, message, code);
}

function object(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function exact(value, keys, label) {
  object(value, label);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) assert(allowed.has(key), `${label}.${key} is not allowed`);
  return value;
}

function text(value, label, max = MAX_TEXT, optional = false) {
  if (optional && value === undefined) return undefined;
  assert(typeof value === 'string', `${label} must be text`);
  const trimmed = value.trim();
  assert(trimmed.length > 0 && trimmed.length <= max, `${label} must be 1-${max} characters`);
  return trimmed;
}

function uuid(value, label) {
  assert(typeof value === 'string' && UUID.test(value), `${label} must be a UUID`);
  return value.toLowerCase();
}

function positiveInt(value, label) {
  assert(Number.isInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

function category(value) {
  assert(CATEGORY.has(value), 'category must be see or eat');
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function validateScope(scope) {
  exact(scope, ['shareId', 'guestId', 'epoch'], 'scope');
  return {
    shareId: uuid(scope.shareId, 'scope.shareId'),
    guestId: text(scope.guestId, 'scope.guestId', 128),
    epoch: positiveInt(scope.epoch, 'scope.epoch')
  };
}

function validateAction(action) {
  object(action, 'action');
  assert(action.version === 1 || action.version === 2, 'action.version must be 1 or 2');
  const kind = action.kind;
  if (kind === 'read') {
    exact(action, ['version', 'kind', 'commentsCursor'], 'action');
    if (action.commentsCursor !== undefined) text(action.commentsCursor, 'commentsCursor', 256);
    return action;
  }
  if (kind === 'vote.set') {
    exact(action, ['version', 'kind', 'requestId', 'placeKey', 'value', 'expectedVersion'], 'action');
    uuid(action.requestId, 'requestId');
    text(action.placeKey, 'placeKey', 160);
    assert(action.value === -1 || action.value === 0 || action.value === 1, 'value must be -1, 0, or 1');
    assert(Number.isInteger(action.expectedVersion) && action.expectedVersion >= 0, 'expectedVersion must be a non-negative integer');
    return action;
  }
  if (kind === 'comment.create') {
    exact(action, ['version', 'kind', 'requestId', 'text', 'displayName', ...(action.version === 2 ? ['anchor'] : [])], 'action');
    uuid(action.requestId, 'requestId');
    text(action.text, 'text', 2000);
    if (action.displayName !== undefined) text(action.displayName, 'displayName', 100, true);
    if (action.anchor !== undefined) {
      exact(action.anchor, ['kind', 'key'], 'anchor');
      assert(['city', 'day', 'place'].includes(action.anchor.kind), 'anchor.kind is invalid');
      text(action.anchor.key, 'anchor.key', 160);
    }
    return action;
  }
  if (kind === 'comment.delete') {
    exact(action, ['version', 'kind', 'requestId', 'commentId'], 'action');
    uuid(action.requestId, 'requestId');
    uuid(action.commentId, 'commentId');
    return action;
  }
  if (kind === 'places.autocomplete') {
    exact(action, ['version', 'kind', 'searchId', 'cityId', 'category', 'input', 'locale'], 'action');
    uuid(action.searchId, 'searchId');
    text(action.cityId, 'cityId', 80);
    category(action.category);
    assert(text(action.input, 'input', 200).length >= 2, 'input must contain at least two characters');
    text(action.locale, 'locale', 35);
    return action;
  }
  if (kind === 'places.resolve') {
    exact(action, ['version', 'kind', 'searchId', 'predictionId'], 'action');
    uuid(action.searchId, 'searchId');
    text(action.predictionId, 'predictionId', 160);
    return action;
  }
  if (kind === 'places.metadata') {
    exact(action, ['version', 'kind', 'placeKey'], 'action');
    assert(action.version === 2, 'places.metadata requires action.version 2');
    assert(/^p:[1-9][0-9]*$/.test(text(action.placeKey, 'placeKey', 160)), 'placeKey is invalid');
    return action;
  }
  if (kind === 'places.metadata.batch') {
    exact(action, ['version', 'kind', 'placeKeys'], 'action');
    assert(action.version === 2, 'places.metadata.batch requires action.version 2');
    assert(Array.isArray(action.placeKeys) && action.placeKeys.length >= 1 && action.placeKeys.length <= 8, 'placeKeys must contain 1-8 items');
    for (const placeKey of action.placeKeys) assert(typeof placeKey === 'string' && /^p:[1-9][0-9]*$/.test(placeKey), 'placeKey is invalid');
    assert(new Set(action.placeKeys).size === action.placeKeys.length, 'placeKeys must be unique');
    return action;
  }
  if (kind === 'map.tile') {
    exact(action, ['version', 'kind', 'dayKey', 'z', 'x', 'y'], 'action');
    assert(action.version === 2, 'map.tile requires action.version 2');
    assert(/^d:[1-9][0-9]*$/.test(text(action.dayKey, 'dayKey', 160)), 'dayKey is invalid');
    assert(Number.isInteger(action.z) && action.z >= 2 && action.z <= 17, 'z is invalid');
    assert(Number.isInteger(action.x) && action.x >= 0 && action.x < 2 ** action.z, 'x is invalid');
    assert(Number.isInteger(action.y) && action.y >= 0 && action.y < 2 ** action.z, 'y is invalid');
    return action;
  }
  if (kind === 'suggestion.create' || kind === 'suggestion.update') {
    exact(action, ['version', 'kind', 'requestId', 'selectionId', 'category', 'reason', 'displayName', 'dayKey', ...(kind === 'suggestion.update' ? ['suggestionId'] : [])], 'action');
    uuid(action.requestId, 'requestId');
    if (kind === 'suggestion.create' || action.selectionId !== undefined) text(action.selectionId, 'selectionId', 160);
    if (kind === 'suggestion.update') uuid(action.suggestionId, 'suggestionId');
    if (action.dayKey !== undefined && action.dayKey !== null) text(action.dayKey, 'dayKey', 160);
    if (action.dayKey === null) assert(action.version === 2 && kind === 'suggestion.update', 'dayKey cannot be null');
    category(action.category);
    if (action.reason !== undefined) text(action.reason, 'reason', 500, true);
    if (action.displayName !== undefined) text(action.displayName, 'displayName', 60, true);
    return action;
  }
  if (kind === 'suggestion.withdraw') {
    exact(action, ['version', 'kind', 'requestId', 'suggestionId'], 'action');
    uuid(action.requestId, 'requestId');
    uuid(action.suggestionId, 'suggestionId');
    return action;
  }
  if (kind === 'session.erase') {
    exact(action, ['version', 'kind', 'requestId'], 'action');
    uuid(action.requestId, 'requestId');
    return action;
  }
  throw new AdviceError(422, `unsupported action: ${String(kind)}`);
}

function response(kind, data) { return { version: 1, kind, data }; }

function mapsUrl(title, locality, countryCode) {
  const query = [title, locality, countryCode].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

module.exports = {
  AdviceError, IntegrationGap, PLUGIN_ID, CATEGORY, assert, exact, text, uuid,
  positiveInt, category, hash, canonicalJson, validateScope, validateAction,
  response, mapsUrl
};
