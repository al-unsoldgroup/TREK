(function (global) {
  'use strict';

  const MAX = { title: 200, label: 100, text: 2000, id: 160, arrays: 500 };
  const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = (value, max = MAX.text) => typeof value === 'string' && value.length <= max;
  const integer = value => Number.isInteger(value);
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
  const category = value => value === 'see' || value === 'eat';

  function validPlace(value) {
    if (!exact(value, ['key', 'title', 'category', 'cityId', 'locality', 'countryCode', 'googlePlaceId', 'mapsUrl', 'photoHandle', 'photo', 'placeType', 'coordinates'])) return false;
    return string(value.key, MAX.id) && string(value.title, MAX.title) && category(value.category) &&
      string(value.cityId, MAX.id) && string(value.locality, MAX.label) && (value.countryCode === null || string(value.countryCode, 3)) &&
      (value.googlePlaceId === null || string(value.googlePlaceId, MAX.id)) && string(value.mapsUrl, 1000) &&
      (!has(value, 'photoHandle') || string(value.photoHandle, MAX.id)) &&
      (!has(value, 'placeType') || string(value.placeType, MAX.label)) &&
      (!has(value, 'coordinates') || (exact(value.coordinates, ['lat', 'lng']) && Number.isFinite(value.coordinates.lat) && Math.abs(value.coordinates.lat) <= 90 && Number.isFinite(value.coordinates.lng) && Math.abs(value.coordinates.lng) <= 180)) &&
      (!has(value, 'photo') || (object(value.photo) && ((exact(value.photo, ['handle']) && string(value.photo.handle, MAX.id)) || (exact(value.photo, ['state', 'handle']) && value.photo.state === 'loadable' && string(value.photo.handle, MAX.id)) || (exact(value.photo, ['state']) && value.photo.state === 'unavailable'))));
  }

  function validProjection(value) {
    if (!exact(value, ['version', 'revision', 'title', 'cities', 'stays', 'shortlists']) || value.version !== 1 ||
        !string(value.revision, MAX.id) || !string(value.title, MAX.title) || !Array.isArray(value.cities) ||
        !Array.isArray(value.stays) || !Array.isArray(value.shortlists) || value.cities.length > 40 || value.stays.length > 120) return false;
    const cityIds = new Set();
    for (const city of value.cities) {
      if (!exact(city, ['id', 'label', 'countryCodes']) || !string(city.id, MAX.id) || !string(city.label, MAX.label) ||
          !Array.isArray(city.countryCodes) || city.countryCodes.some(code => !string(code, 3))) return false;
      cityIds.add(city.id);
    }
    const placeKeys = new Set();
    for (const stay of value.stays) {
      if (!exact(stay, ['id', 'cityId', 'shortlistCityId', 'days']) || !string(stay.id, MAX.id) || !cityIds.has(stay.cityId) ||
          !string(stay.shortlistCityId, MAX.id) || !Array.isArray(stay.days)) return false;
      for (const day of stay.days) {
        if (!exact(day, ['key', 'date', 'schedule', 'notes']) || !string(day.key, MAX.id) || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Array.isArray(day.schedule) ||
            (has(day, 'notes') && (!Array.isArray(day.notes) || day.notes.length > 100 || day.notes.some(note => !exact(note, ['text']) || !string(note.text, 10000))))) return false;
        for (const row of day.schedule) {
          if (!exact(row, ['key', 'place', 'time', 'booked']) || !string(row.key, MAX.id) ||
              (row.time !== null && !string(row.time, 40)) || typeof row.booked !== 'boolean' || !validPlace(row.place)) return false;
          placeKeys.add(row.place.key);
        }
      }
    }
    for (const list of value.shortlists) {
      if (!exact(list, ['cityId', 'see', 'eat']) || !string(list.cityId, MAX.id) || !Array.isArray(list.see) || !Array.isArray(list.eat)) return false;
      for (const place of [...list.see, ...list.eat]) {
        if (!validPlace(place) || place.cityId !== list.cityId || placeKeys.has(place.key)) return false;
        placeKeys.add(place.key);
      }
    }
    return true;
  }

  function validBootstrap(value) {
    return exact(value, ['kind', 'version', 'plugin', 'title', 'expiresAt']) && value.kind === 'plugin-share' && value.version === 1 &&
      exact(value.plugin, ['id', 'entry', 'protocolVersion']) && value.plugin.id === 'trip-advice' && value.plugin.entry === 'guest.html' &&
      value.plugin.protocolVersion === 1 && string(value.title, MAX.title) && string(value.expiresAt, 80);
  }

  function validAction(value) {
    if (!object(value) || value.version !== 1 || typeof value.kind !== 'string') return false;
    switch (value.kind) {
      case 'read': return exact(value, ['version', 'kind', 'commentsCursor']) && (!has(value, 'commentsCursor') || string(value.commentsCursor, MAX.id));
      case 'vote.set': return exact(value, ['version', 'kind', 'requestId', 'placeKey', 'value', 'expectedVersion']) && uuid(value.requestId) &&
        string(value.placeKey, MAX.id) && [-1, 0, 1].includes(value.value) && integer(value.expectedVersion) && value.expectedVersion >= 0;
      case 'comment.create': return exact(value, ['version', 'kind', 'requestId', 'text', 'displayName']) && uuid(value.requestId) &&
        string(value.text, MAX.text) && value.text.trim().length > 0 && (!has(value, 'displayName') || string(value.displayName, 60));
      case 'comment.delete': return exact(value, ['version', 'kind', 'requestId', 'commentId']) && uuid(value.requestId) && string(value.commentId, MAX.id);
      case 'places.autocomplete': return exact(value, ['version', 'kind', 'searchId', 'cityId', 'category', 'input', 'locale']) && uuid(value.searchId) &&
        string(value.cityId, MAX.id) && category(value.category) && string(value.input, 200) && value.input.trim().length >= 2 && string(value.locale, 35);
      case 'places.resolve': return exact(value, ['version', 'kind', 'searchId', 'predictionId']) && uuid(value.searchId) && string(value.predictionId, MAX.id);
      case 'places.metadata': return exact(value, ['version', 'kind', 'placeKey']) && /^p:[1-9]\d*$/.test(value.placeKey);
      case 'map.tile': return exact(value, ['version', 'kind', 'dayKey', 'z', 'x', 'y']) && /^d:[1-9]\d*$/.test(value.dayKey) &&
        integer(value.z) && value.z >= 2 && value.z <= 17 && integer(value.x) && integer(value.y) && value.x >= 0 && value.y >= 0 && value.x < 2 ** value.z && value.y < 2 ** value.z;
      case 'suggestion.create': return exact(value, ['version', 'kind', 'requestId', 'selectionId', 'category', 'reason', 'displayName', 'dayKey']) && uuid(value.requestId) &&
        string(value.selectionId, MAX.id) && category(value.category) && (!has(value, 'reason') || string(value.reason, 500)) &&
        (!has(value, 'displayName') || string(value.displayName, 60)) && (!has(value, 'dayKey') || string(value.dayKey, MAX.id));
      case 'suggestion.update': return exact(value, ['version', 'kind', 'requestId', 'suggestionId', 'selectionId', 'category', 'reason', 'displayName', 'dayKey']) && uuid(value.requestId) && uuid(value.suggestionId) &&
        category(value.category) && (!has(value, 'selectionId') || string(value.selectionId, MAX.id)) && (!has(value, 'reason') || string(value.reason, 500)) &&
        (!has(value, 'displayName') || string(value.displayName, 60)) && (!has(value, 'dayKey') || value.dayKey === null || string(value.dayKey, MAX.id));
      case 'suggestion.withdraw': return exact(value, ['version', 'kind', 'requestId', 'suggestionId']) && uuid(value.requestId) && string(value.suggestionId, MAX.id);
      case 'session.erase': return exact(value, ['version', 'kind', 'requestId']) && uuid(value.requestId);
      default: return false;
    }
  }

  function validPhoto(value) {
    if (!exact(value, ['state', 'mimeType', 'bytesBase64', 'authors', 'googleAttribution', 'googleMapsUri'])) return false;
    if (value.state === 'unavailable') return value.mimeType === null && value.bytesBase64 === null && Array.isArray(value.authors) && value.authors.length === 0 && value.googleAttribution === null && !has(value, 'googleMapsUri');
    return value.state === 'available' && typeof value.mimeType === 'string' && /^image\/(jpeg|png|webp)$/i.test(value.mimeType) &&
      typeof value.bytesBase64 === 'string' && value.bytesBase64.length <= 750000 && Array.isArray(value.authors) &&
      value.authors.every(author => object(author) && exact(author, ['displayName', 'uri']) && string(author.displayName, 200) && httpsUri(author.uri)) &&
      value.googleAttribution === 'Google Maps' && httpsUri(value.googleMapsUri);
  }

  function httpsUri(value) {
    if (typeof value !== 'string' || value.length > 2000) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    } catch (_) { return false; }
  }

  function validVoteResult(value) {
    return exact(value, ['placeKey', 'value', 'version', 'positive', 'negative', 'mine']) &&
      string(value.placeKey, MAX.id) && [-1, 0, 1].includes(value.value) &&
      integer(value.version) && value.version >= 0 && integer(value.positive) && value.positive >= 0 &&
      integer(value.negative) && value.negative >= 0 && [-1, 0, 1].includes(value.mine);
  }

  function readData(value) {
    if (!object(value)) return null;
    if (exact(value, ['version', 'kind', 'data']) && value.version === 1 && value.kind === 'read') return readData(value.data);
    if (validProjection(value)) return { projection: value, feedback: null };
    const feedbackKeys = ['projection', 'feedbackRevision', 'votes', 'myPendingSuggestions', 'myComments', 'nextCommentsCursor'];
    if (!exact(value, feedbackKeys) || feedbackKeys.some(key => !has(value, key)) || !validProjection(value.projection) ||
        !integer(value.feedbackRevision) || value.feedbackRevision < 0 || !Array.isArray(value.votes) ||
        !Array.isArray(value.myPendingSuggestions) || !Array.isArray(value.myComments) ||
        (value.nextCommentsCursor !== null && !string(value.nextCommentsCursor, MAX.id))) return null;
    return { projection: value.projection, feedback: value };
  }

  global.TrekAdviceProtocol = Object.freeze({ validPlace, validProjection, validBootstrap, validAction, validPhoto, validVoteResult, readData, uuid, category });
})(window);
