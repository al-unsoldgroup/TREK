(function (global) {
  'use strict';

  const CATEGORIES = ['see', 'eat'];
  const MAX_COMMENT = 2000;
  const MAX_REASON = 500;

  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const text = value => typeof value === 'string' ? value : '';
  const category = value => CATEGORIES.includes(value) ? value : null;

  function dateEntries(projection) {
    const entries = [];
    (projection?.stays || []).forEach(stay => {
      (stay.days || []).forEach(day => entries.push({
        date: day.date,
        dayKey: day.key,
        stayId: stay.id,
        cityId: stay.cityId,
        shortlistCityId: stay.shortlistCityId
      }));
    });
    return entries.sort((a, b) => a.date.localeCompare(b.date) || a.dayKey.localeCompare(b.dayKey));
  }

  function uniqueDates(projection) {
    const seen = new Set();
    return dateEntries(projection).filter(entry => {
      if (seen.has(entry.date)) return false;
      seen.add(entry.date);
      return true;
    });
  }

  function firstDate(projection) {
    return uniqueDates(projection)[0]?.date || null;
  }

  function cityLabel(projection, cityId) {
    return projection?.cities?.find(city => city.id === cityId)?.label || cityId || 'Destination';
  }

  function placeIndex(projection) {
    const result = new Map();
    (projection?.shortlists || []).forEach(shortlist => {
      [...(shortlist.see || []), ...(shortlist.eat || [])].forEach(place => result.set(place.key, place));
    });
    (projection?.stays || []).forEach(stay => (stay.days || []).forEach(day =>
      (day.schedule || []).forEach(row => result.set(row.place.key, row.place))));
    return result;
  }

  function initial(projection) {
    const categories = {};
    (projection?.cities || []).forEach(city => { categories[city.id] = 'see'; });
    return {
      selectedDate: firstDate(projection),
      selectedCityId: projection?.cities?.[0]?.id || null,
      categories,
      votes: {},
      pendingSuggestions: [],
      comments: [],
      nextCommentsCursor: null,
      feedbackRevision: null,
      displayName: '',
      busy: {},
      message: '',
      error: '',
      dialog: null
    };
  }

  function voteFor(state, placeKey) {
    const vote = state.votes[placeKey];
    return vote && typeof vote === 'object' ? vote : { positive: 0, negative: 0, mine: 0, version: 0 };
  }

  function withVote(state, placeKey, patch) {
    return { ...state, votes: { ...state.votes, [placeKey]: { ...voteFor(state, placeKey), ...patch } } };
  }

  function existingPlace(projection, state, key) {
    const base = placeIndex(projection).get(key);
    return base || state.pendingSuggestions.find(item => item.place?.key === key || item.key === key) || null;
  }

  function normalizePending(item) {
    if (!isObject(item)) return null;
    const place = isObject(item.place) ? item.place : item;
    if (typeof place.key !== 'string' || typeof place.title !== 'string') return null;
    return {
      ...place,
      key: place.key,
      cityId: text(place.cityId) || text(item.cityId) || 'elsewhere',
      category: category(place.category || item.category) || 'see',
      suggested: true,
      status: text(item.status) || 'pending',
      by: text(item.displayName || item.by) || 'Guest adviser',
      reason: text(item.reason)
    };
  }

  function applyFeedback(state, feedback, appendComments = false) {
    if (!isObject(feedback)) return state;
    const votes = {};
    if (Array.isArray(feedback.votes)) {
      feedback.votes.forEach(item => {
        if (isObject(item) && typeof item.placeKey === 'string') votes[item.placeKey] = {
          positive: Number.isFinite(item.positive) ? Math.max(0, item.positive) : 0,
          negative: Number.isFinite(item.negative) ? Math.max(0, item.negative) : 0,
          mine: item.mine === 1 || item.mine === -1 ? item.mine : 0,
          version: Number.isInteger(item.version) ? item.version : 0
        };
      });
    } else if (isObject(feedback.votes)) {
      Object.entries(feedback.votes).forEach(([placeKey, item]) => {
        if (isObject(item)) votes[placeKey] = {
          positive: Math.max(0, Number(item.positive) || 0),
          negative: Math.max(0, Number(item.negative) || 0),
          mine: item.mine === 1 || item.mine === -1 ? item.mine : 0,
          version: Number.isInteger(item.version) ? item.version : 0
        };
      });
    }
    const pending = Array.isArray(feedback.myPendingSuggestions)
      ? feedback.myPendingSuggestions.map(normalizePending).filter(Boolean) : state.pendingSuggestions;
    const incomingComments = Array.isArray(feedback.myComments) ? feedback.myComments.filter(isObject).map(item => ({
      id: text(item.id), displayName: text(item.displayName) || 'Guest adviser', text: text(item.text), createdAt: text(item.createdAt), deleted: item.deleted === true
    })).filter(item => item.text) : state.comments;
    const comments = appendComments
      ? [...state.comments, ...incomingComments.filter(item => !state.comments.some(previous => previous.id && previous.id === item.id))]
      : incomingComments;
    const nextCommentsCursor = own(feedback, 'nextCommentsCursor')
      ? (typeof feedback.nextCommentsCursor === 'string' ? feedback.nextCommentsCursor : null)
      : (appendComments ? state.nextCommentsCursor : null);
    return { ...state, votes, pendingSuggestions: pending, comments,
      nextCommentsCursor,
      feedbackRevision: feedback.feedbackRevision ?? state.feedbackRevision };
  }

  function apply(state, action, projection) {
    if (!isObject(action)) return state;
    switch (action.type) {
      case 'reset':
        return initial(projection);
      case 'date':
        return uniqueDates(projection).some(entry => entry.date === action.date)
          ? { ...state, selectedDate: action.date, selectedCityId: uniqueDates(projection).find(entry => entry.date === action.date).cityId, error: '' } : state;
      case 'city':
        return (projection?.cities || []).some(city => city.id === action.cityId)
          ? { ...state, selectedCityId: action.cityId, error: '' } : state;
      case 'category':
        return category(action.category) && own(state.categories, action.cityId)
          ? { ...state, categories: { ...state.categories, [action.cityId]: action.category }, error: '' } : state;
      case 'vote.pending':
        return { ...state, busy: { ...state.busy, [`vote:${action.placeKey}`]: true }, error: '' };
      case 'vote.result':
        return withVote({ ...state, busy: { ...state.busy, [`vote:${action.placeKey}`]: false }, message: action.message || '', error: '' }, action.placeKey, action.vote);
      case 'feedback':
        return applyFeedback(state, action.data, action.appendComments === true);
      case 'display-name':
        return { ...state, displayName: text(action.value).slice(0, 60) };
      case 'comment.pending':
        return { ...state, busy: { ...state.busy, comment: true }, error: '' };
      case 'comment.result':
        return { ...state, busy: { ...state.busy, comment: false }, message: action.message || '', error: '' };
      case 'comment': {
        const body = text(action.text).trim().slice(0, MAX_COMMENT);
        return body ? { ...state, comments: [...state.comments, { id: text(action.id), displayName: text(action.displayName).trim().slice(0, 60) || 'Guest adviser', text: body }] } : state;
      }
      case 'suggestion': {
        const place = action.place;
        if (!isObject(place) || !place.key || !place.cityId || !category(place.category) || existingPlace(projection, state, place.key)) return state;
        return { ...state, pendingSuggestions: [...state.pendingSuggestions, { ...place, suggested: true, status: 'pending', by: text(action.displayName).trim().slice(0, 60) || 'Guest adviser', reason: text(action.reason).trim().slice(0, MAX_REASON) }] };
      }
      case 'jump': {
        const target = action.target;
        if (!isObject(target)) return state;
        let next = state;
        if (target.date) next = apply(next, { type: 'date', date: target.date }, projection);
        if (target.cityId) next = apply(next, { type: 'city', cityId: target.cityId }, projection);
        if (target.category) next = apply(next, { type: 'category', cityId: target.cityId, category: target.category }, projection);
        return next;
      }
      case 'suggestion.pending':
        return { ...state, busy: { ...state.busy, suggestion: true }, error: '' };
      case 'suggestion.result':
        return { ...state, busy: { ...state.busy, suggestion: false }, message: action.message || '', error: '' };
      case 'error':
        return { ...state, busy: { ...state.busy, ...(action.key ? { [action.key]: false } : {}) }, error: text(action.message), message: '' };
      case 'dialog':
        return { ...state, dialog: action.value };
      default:
        return state;
    }
  }

  function shortlistFor(projection, cityId, selectedCategory) {
    const list = projection?.shortlists?.find(item => item.cityId === cityId);
    return list ? (selectedCategory === 'eat' ? list.eat || [] : list.see || []) : [];
  }

  function safeMapsUrl(place) {
    if (!isObject(place)) return null;
    try {
      const url = new URL(text(place.mapsUrl));
      const keys = [...url.searchParams.keys()];
      if (url.protocol !== 'https:' || url.hostname !== 'www.google.com' || url.pathname !== '/maps/search/' ||
          url.searchParams.get('api') !== '1' || !url.searchParams.get('query') ||
          keys.some(key => !['api', 'query', 'query_place_id'].includes(key))) return null;
      return url.href;
    } catch (_) { return null; }
  }

  function mapsUrl(place) {
    const supplied = safeMapsUrl(place);
    if (supplied) return supplied;
    if (!isObject(place) || !text(place.title) || !text(place.countryCode)) return null;
    const url = new URL('https://www.google.com/maps/search/');
    url.searchParams.set('api', '1');
    url.searchParams.set('query', [place.title, place.locality, place.countryCode].filter(Boolean).join(' '));
    return url.href;
  }

  global.TrekAdviceModel = Object.freeze({
    CATEGORIES, MAX_COMMENT, MAX_REASON, dateEntries, uniqueDates, firstDate, cityLabel,
    placeIndex, initial, voteFor, apply, applyFeedback, existingPlace, normalizePending,
    shortlistFor, safeMapsUrl, mapsUrl
  });
})(window);
