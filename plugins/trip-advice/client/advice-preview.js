(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TrekAdvicePreview = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function bridge(projection, openUrl) {
    const places = new Map();
    for (const stay of projection.stays) for (const day of stay.days) for (const row of day.schedule) places.set(row.place.key, row.place);
    for (const list of projection.shortlists) for (const place of [...list.see, ...list.eat]) places.set(place.key, place);
    return {
      async action(action) {
        if (action.kind !== 'read') throw new Error('Preview only. Publish an advice link before guests can send feedback.');
        return { projection, feedbackRevision: 0, votes: [], myPendingSuggestions: [], myComments: [], nextCommentsCursor: null };
      },
      async photoAsset() { return null; },
      openMaps(key) {
        const url = places.get(key)?.mapsUrl;
        if (url) openUrl(url);
      },
    };
  }
  return { bridge };
});
