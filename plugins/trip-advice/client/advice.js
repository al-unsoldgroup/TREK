(function (global) {
  'use strict';

  const Model = global.TrekAdviceModel;
  const Protocol = global.TrekAdviceProtocol;
  const hasParent = global.parent && global.parent !== global;
  const $ = id => document.getElementById(id);
  const el = (tag, value, className) => {
    const node = document.createElement(tag);
    if (value !== undefined && value !== null) node.textContent = String(value);
    if (className) node.className = className;
    return node;
  };
  const button = (label, handler, className) => {
    const node = el('button', label, className);
    node.type = 'button';
    if (handler) node.addEventListener('click', handler);
    return node;
  };
  const uuid = () => global.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : r & 3 | 8).toString(16);
  });
  const errorText = error => error?.message || 'TREK could not complete that action.';
  const categoryLabel = category => category === 'eat' ? 'Eat' : 'See';
  const ownerConfigKeys = ['cities', 'stays', 'schedule', 'shortlist'];
  const ownerEmptyConfig = () => ({ version: 1, publicTitle: '', cities: [], stays: [], schedule: [], shortlist: [] });
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const copy = value => global.structuredClone ? global.structuredClone(value) : JSON.parse(JSON.stringify(value));
  const ownerRowId = (row, key) => String(row?.id ?? row?.assignmentId ?? row?.placeId ?? `${key}:${JSON.stringify(row)}`);

  function ownerSelectionModel(storedConfig, candidates) {
    const config = record(storedConfig) ? { ...ownerEmptyConfig(), ...copy(storedConfig) } : ownerEmptyConfig();
    const source = record(candidates) ? candidates : {};
    const available = {};
    const selected = {};
    ownerConfigKeys.forEach(key => {
      selected[key] = new Set((Array.isArray(config[key]) ? config[key] : []).map(row => ownerRowId(row, key)));
      const rows = [...(Array.isArray(source[key]) ? source[key] : []), ...(Array.isArray(config[key]) ? config[key] : [])];
      const seen = new Set();
      available[key] = rows.filter(row => record(row)).filter(row => {
        const id = ownerRowId(row, key);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    });
    return { config, available, selected };
  }

  function storedOwnerConfig(ownerConfig) {
    if (record(ownerConfig?.config)) return ownerConfig.config;
    const direct = record(ownerConfig) && ownerConfig.version === 1 &&
      (typeof ownerConfig.publicTitle === 'string' || ownerConfigKeys.some(key => Array.isArray(ownerConfig[key])));
    return direct ? ownerConfig : null;
  }

  function ownerConfigFromControls(draft, available, ownerDocument) {
    if (!record(draft) || !ownerDocument?.querySelector || !ownerDocument?.querySelectorAll) return null;
    const config = { ...ownerEmptyConfig(), ...copy(draft) };
    const title = ownerDocument.querySelector('#config-editor input[data-field="title"]');
    config.publicTitle = typeof title?.value === 'string' ? title.value.trim().slice(0, 200) : '';
    ownerConfigKeys.forEach(key => {
      const checked = new Set([...ownerDocument.querySelectorAll(`input[data-key="${key}"]:checked`)].map(node => String(node.dataset?.id || '')));
      config[key] = (Array.isArray(available?.[key]) ? available[key] : []).filter(row => checked.has(ownerRowId(row, key)));
    });
    return config;
  }

  function PublicBridge() {
    let sequence = 0;
    let context = null;
    let channelNonce = null;
    let closed = false;
    const pending = new Map();
    const photoCache = new Map();
    const photoUrls = new Set();
    const PHOTO_LIMIT = 24;
    const contextWaiters = [];
    const post = message => { if (hasParent) global.parent.postMessage(message, '*'); };
    const call = (type, payload) => new Promise((resolve, reject) => {
      if (closed) { reject(new Error('TREK advice frame closed.')); return; }
      if (!hasParent) { reject(new Error('Open this page from a TREK shared advice link.')); return; }
      const id = `public-${++sequence}`;
      pending.set(id, { resolve, reject });
      post({ type, id, ...payload });
    });
    global.addEventListener('message', event => {
      if (event.source !== global.parent || !event.data || typeof event.data !== 'object') return;
      const message = event.data;
      if (message.type === 'trek:public:context') {
        if (message.version !== 1 || typeof message.nonce !== 'string' || message.nonce.length < 16 || message.nonce.length > 160) return;
        context = message;
        channelNonce = message.nonce;
        while (contextWaiters.length) contextWaiters.shift()(message);
        return;
      }
      if (!message.id || !pending.has(message.id)) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (channelNonce && message.nonce !== undefined && message.nonce !== channelNonce) {
        request.reject(new Error('TREK public channel changed.'));
        return;
      }
      if (message.type === 'trek:public:error') request.reject(new Error(message.message || 'TREK public action failed.'));
      else if (message.type === 'trek:public:result') request.resolve(message.result);
      else request.reject(new Error('TREK returned an invalid public response.'));
    });
    post({ type: 'trek:public:ready', version: 1 });

    function revoke(entry) {
      if (!entry?.url) return;
      global.URL.revokeObjectURL(entry.url);
      photoUrls.delete(entry.url);
      entry.url = null;
    }
    function evictPhotos() {
      while (photoCache.size > PHOTO_LIMIT) {
        const candidate = [...photoCache.entries()].find(([, entry]) => !entry.promise) || photoCache.entries().next().value;
        if (!candidate) return;
        photoCache.delete(candidate[0]);
        revoke(candidate[1]);
      }
    }
    function touch(handle, entry) {
      photoCache.delete(handle);
      photoCache.set(handle, entry);
    }
    function photo(handle) {
      if (typeof handle !== 'string' || handle.length > 160) return Promise.reject(new Error('Invalid photo handle.'));
      const cached = photoCache.get(handle);
      if (cached) {
        touch(handle, cached);
        if (cached.promise) return cached.promise;
        if (cached.error) return Promise.reject(cached.error);
        return Promise.resolve(cached.result);
      }
      const entry = { promise: null, result: null, error: null, url: null };
      entry.promise = call('trek:public:photo', { handle }).then(result => {
        if (photoCache.get(handle) === entry) entry.result = result;
        return result;
      }).catch(error => {
        if (photoCache.get(handle) === entry) entry.error = error;
        throw error;
      }).finally(() => {
        if (photoCache.get(handle) === entry) entry.promise = null;
      });
      photoCache.set(handle, entry);
      evictPhotos();
      return entry.promise;
    }
    function photoAsset(handle) {
      return photo(handle).then(result => {
        const entry = photoCache.get(handle);
        if (!entry || entry.result !== result || !Protocol.validPhoto(result) || result.state !== 'available') return { result, url: null };
        if (!entry.url) {
          let bytes;
          try {
            const binary = global.atob(result.bytesBase64);
            bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
            if (bytes.byteLength > 512 * 1024) throw new Error('Photo exceeds the public size limit.');
            entry.url = global.URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
            photoUrls.add(entry.url);
          } catch (error) {
            entry.error = error;
            throw error;
          }
        }
        touch(handle, entry);
        return { result, url: entry.url };
      });
    }
    function clearPhotos() {
      photoCache.forEach(revoke);
      photoCache.clear();
      photoUrls.clear();
    }
    const api = {
      context: () => context ? Promise.resolve(context) : new Promise(resolve => contextWaiters.push(resolve)),
      action: action => { if (!Protocol.validAction(action)) return Promise.reject(new Error('Invalid public advice action.')); return call('trek:public:action', { action }).then(result => result?.kind && result?.data ? result.data : result); },
      photo,
      photoAsset,
      openMaps: key => { if (/^[a-z0-9:_-]{1,160}$/i.test(String(key))) post({ type: 'trek:public:openMaps', placeKeyOrSelectionId: String(key) }); },
      openAttribution: uri => { try { const url = new URL(uri); if (url.protocol === 'https:' && !url.username && !url.password) post({ type: 'trek:public:openAttribution', uri: url.href }); } catch (_) {} },
      photoUrls,
      evictPhotos,
      cleanupPhotos: clearPhotos,
      close: () => { closed = true; clearPhotos(); pending.forEach(request => request.reject(new Error('TREK advice frame closed.'))); pending.clear(); }
    };
    return api;
  }

  function OwnerBridge() {
    let sequence = 0;
    let context = null;
    const pending = new Map();
    const post = message => { if (hasParent) global.parent.postMessage(message, '*'); };
    global.addEventListener('message', event => {
      if (event.source !== global.parent || !event.data || typeof event.data !== 'object') return;
      const message = event.data;
      if (message.type === 'trek:context') { context = message; return; }
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      if (message.type === 'trek:error') request.reject(new Error(message.message || 'TREK owner action failed.'));
      else request.resolve(message.data ?? message.result);
    });
    post({ type: 'trek:ready' });
    post({ type: 'trek:context:request' });
    return {
      context: () => context ? Promise.resolve(context) : !hasParent ? Promise.reject(new Error('Open owner settings from inside TREK.')) : new Promise(resolve => {
        const timer = global.setInterval(() => { if (context) { global.clearInterval(timer); resolve(context); } }, 100);
      }),
      invoke: (sub, method, body) => new Promise((resolve, reject) => {
        if (!hasParent) { reject(new Error('Open owner settings from inside TREK.')); return; }
        const requestId = `owner-${++sequence}`;
        pending.set(requestId, { resolve, reject });
        post({ type: 'trek:invoke', requestId, sub, method, body });
      })
    };
  }

  function applyTheme(context) {
    const theme = context?.theme;
    const root = document.documentElement;
    if (typeof theme === 'string' && (theme === 'dark' || theme === 'light')) root.dataset.platformMode = theme;
    const allowed = { background: '--paper', surface: '--surface', text: '--ink', muted: '--muted', accent: '--accent', border: '--line' };
    if (theme && typeof theme === 'object') {
      Object.entries(allowed).forEach(([key, css]) => {
        if (typeof theme[key] === 'string' && /^#[0-9a-f]{3,8}$/i.test(theme[key])) root.style.setProperty(css, theme[key]);
      });
      if (theme.mode === 'dark' || theme.mode === 'light') root.dataset.platformMode = theme.mode;
    }
    if (context?.tokens && typeof context.tokens === 'object') Object.entries(context.tokens).forEach(([key, value]) => {
      if (/^--[a-z0-9-]+$/i.test(key) && typeof value === 'string' && value.length <= 120) root.style.setProperty(key, value);
    });
    if (context?.dir === 'rtl' || context?.dir === 'ltr') root.dir = context.dir;
  }

  function localeOf(context) {
    const candidate = typeof context?.locale === 'string' && context.locale.length <= 35 ? context.locale : navigator.language || 'en';
    try { new Intl.DateTimeFormat(candidate); return candidate; } catch (_) { return 'en'; }
  }

  function formatDate(date, locale, options) {
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? date : new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(parsed);
  }

  function photoPreview(place, bridge, ownerDocument = document) {
    const wrap = el('div', undefined, 'photo-slot');
    wrap.setAttribute('role', 'note');
    wrap.append(el('span', 'Photo preview', 'photo-label'));
    const image = el('img');
    image.alt = `${place.title} photo`;
    image.hidden = true;
    wrap.append(image);
    const fallback = el('span', 'Loading photo…', 'photo-fallback');
    wrap.append(fallback);
    const attribution = el('span', undefined, 'photo-attribution');
    attribution.hidden = true;
    wrap.append(attribution);
    const handle = place.photoHandle || place.photo?.handle;
    if (typeof handle !== 'string' || !bridge) { fallback.textContent = 'Photo unavailable'; return wrap; }
    bridge.photoAsset(handle).then(asset => {
      if (!Protocol.validPhoto(asset.result) || asset.result.state !== 'available' || !asset.url || !wrap.isConnected) return;
      image.src = asset.url;
      image.hidden = false;
      fallback.hidden = true;
      attribution.replaceChildren(el('span', asset.result.googleAttribution));
      asset.result.authors.forEach(author => {
        const link = el('a', author.displayName);
        link.href = author.uri;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', `${author.displayName}, photo attribution, opens in a new tab`);
        if (bridge?.openAttribution) link.addEventListener('click', event => { event.preventDefault(); bridge.openAttribution(author.uri); });
        attribution.append(ownerDocument.createTextNode(' '), link);
      });
      attribution.hidden = false;
    }).catch(() => { if (wrap.isConnected) fallback.textContent = 'Photo unavailable. Google attribution appears with an actual photo.'; });
    return wrap;
  }

  function mapLink(place, bridge) {
    const url = Model.mapsUrl(place);
    const link = el('a', place.title, 'place-link');
    link.href = url || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${place.title}, Google Maps${url ? ', opens in a new tab' : ', link unavailable'}`);
    if (!url) { link.setAttribute('aria-disabled', 'true'); link.addEventListener('click', event => event.preventDefault()); }
    else if (bridge) link.addEventListener('click', event => { event.preventDefault(); bridge.openMaps(place.key); });
    return link;
  }

  function placeRow(place, state, projection, bridge, onVote, onJump) {
    const row = el('article', undefined, 'place-row');
    row.id = `place-${String(place.key).replace(/[^a-z0-9_-]/gi, '-')}`;
    row.tabIndex = -1;
    const copy = el('div', undefined, 'place-copy');
    const titleLine = el('div', undefined, 'place-title-line');
    titleLine.append(mapLink(place, bridge));
    if (place.suggested) titleLine.append(el('span', place.status === 'accepted' ? 'Suggested' : 'Suggested · pending review', 'badge'));
    copy.append(titleLine);
    copy.append(el('p', `${place.locality || Model.cityLabel(projection, place.cityId)} · ${categoryLabel(place.category)}`, 'place-meta'));
    copy.append(photoPreview(place, bridge));
    if (place.suggested) {
      const detail = `Suggested by ${place.by || 'Guest adviser'}${place.reason ? `: ${place.reason}` : ''}`;
      copy.append(el('p', detail, 'place-note'));
    }
    if (place.suggested) {
      copy.append(el('p', 'Voting opens if the owner publishes this suggestion to the shortlist.', 'pending-note'));
      row.append(copy);
      return row;
    }
    const tally = Model.voteFor(state, place.key);
    const votes = el('div', undefined, 'votes');
    [['up', 1, tally.positive], ['down', -1, tally.negative]].forEach(([direction, value, count]) => {
      const active = tally.mine === value;
      const control = button(`${direction === 'up' ? '▲' : '▼'} ${count}`, () => onVote(place, active ? 0 : value), active ? 'vote active' : 'vote');
      control.setAttribute('aria-pressed', String(active));
      control.setAttribute('aria-label', `${direction === 'up' ? 'Upvote' : 'Downvote'} ${place.title}, ${count} votes${active ? ', yours is selected' : ''}. Press again to undo.`);
      control.disabled = Boolean(state.busy[`vote:${place.key}`]);
      votes.append(control);
    });
    row.append(copy, votes);
    if (onJump) row.addEventListener('dblclick', () => onJump(place));
    return row;
  }

  function renderGuest(root, projection, bridge, context) {
    const $ = id => root.querySelector(`[id="${id}"]`) || document.getElementById(id);
    let state = Model.initial(projection);
    const locale = localeOf(context);
    let opener = null;
    let searchTimer = null;
    let searchSerial = 0;

    function announce(message) { $('announcement').textContent = message; }
    function syncSuggestionCities(selectedCityId) {
      const select = $('suggest-city');
      if (!select) return;
      select.replaceChildren();
      (projection.cities || []).forEach(city => {
        const option = el('option', city.label);
        option.value = city.id;
        select.append(option);
      });
      if (selectedCityId && (projection.cities || []).some(city => city.id === selectedCityId)) select.value = selectedCityId;
    }
    function error(message, busyKey) { state = Model.apply(state, { type: 'error', message, key: busyKey }, projection); render(); }
    function readFeedback(data, appendComments = false) {
      const read = Protocol.readData(data);
      if (!read) throw new Error('TREK returned an invalid advice projection.');
      projection = read.projection;
      syncSuggestionCities(state.dialog?.cityId || projection.cities?.[0]?.id);
      state = Model.apply(state, { type: 'feedback', data: read.feedback, appendComments }, projection);
      render();
    }
    async function refresh(commentsCursor, appendComments = false) {
      state = { ...state, message: '', error: '', busy: { ...state.busy, ...(appendComments ? { comments: true } : {}) } };
      render();
      try {
        const action = { version: 1, kind: 'read', ...(typeof commentsCursor === 'string' && commentsCursor ? { commentsCursor } : {}) };
        readFeedback(await bridge.action(action), appendComments);
      }
      catch (caught) { error(errorText(caught), appendComments ? 'comments' : undefined); }
      finally { if (appendComments) { state = { ...state, busy: { ...state.busy, comments: false } }; render(); } }
    }
    async function vote(place, value) {
      const current = Model.voteFor(state, place.key);
      state = Model.apply(state, { type: 'vote.pending', placeKey: place.key }, projection); render();
      try {
        const result = await bridge.action({ version: 1, kind: 'vote.set', requestId: uuid(), placeKey: place.key, value, expectedVersion: current.version });
        const vote = result?.vote || result;
        if (!Protocol.validVoteResult(vote) || vote.placeKey !== place.key || vote.value !== value) throw new Error('TREK returned an invalid vote result.');
        state = Model.apply(state, { type: 'vote.result', placeKey: place.key, vote, message: value ? `Vote saved for ${place.title}.` : `Vote removed for ${place.title}.` }, projection); render();
        announce(state.message);
      } catch (caught) { error(errorText(caught), `vote:${place.key}`); }
    }
    async function commentSubmit(event) {
      event.preventDefault();
      const text = $('comment-text').value.trim();
      if (!text) { $('comment-status').textContent = 'Write a comment before sending it.'; $('comment-text').focus(); return; }
      state = Model.apply(state, { type: 'display-name', value: $('display-name').value }, projection);
      state = Model.apply(state, { type: 'comment.pending' }, projection); render();
      try {
        await bridge.action({ version: 1, kind: 'comment.create', requestId: uuid(), text, ...(state.displayName.trim() ? { displayName: state.displayName.trim() } : {}) });
        $('comment-text').value = '';
        state = Model.apply(state, { type: 'comment.result', message: 'Comment sent to the trip owner.' }, projection); render();
        $('comment-status').textContent = state.message;
        await refresh();
      } catch (caught) { error(errorText(caught), 'comment'); $('comment-status').textContent = state.error; }
    }
    function duplicateTarget(result) {
      const duplicate = result?.duplicate;
      if (!duplicate || typeof duplicate !== 'object' || typeof duplicate.placeKey !== 'string') return false;
      const place = Model.existingPlace(projection, state, duplicate.placeKey);
      if (place) jumpToPlace(place);
      else error('That place is already visible in the shared plan.');
      return true;
    }
    function jumpToPlace(place) {
      const entries = Model.dateEntries(projection);
      const scheduled = entries.find(entry => entry.dayKey && (projection.stays.find(stay => stay.id === entry.stayId)?.days || []).some(day => day.schedule.some(row => row.place.key === place.key)));
      if (scheduled) {
        state = Model.apply(state, { type: 'date', date: scheduled.date }, projection);
        render();
        announce(`${place.title} is scheduled on ${formatDate(scheduled.date, locale, { day: 'numeric', month: 'long' })}.`);
        focusAndScroll(`place-${String(place.key).replace(/[^a-z0-9_-]/gi, '-')}`);
        return;
      }
      state = Model.apply(state, { type: 'category', cityId: place.cityId, category: place.category }, projection);
      state = Model.apply(state, { type: 'city', cityId: place.cityId }, projection);
      render();
      focusAndScroll(`place-${String(place.key).replace(/[^a-z0-9_-]/gi, '-')}`);
      announce(`${place.title} is in the ${categoryLabel(place.category)} ideas for ${Model.cityLabel(projection, place.cityId)}.`);
    }
    async function submitSuggestion(event) {
      event.preventDefault();
      const dialog = state.dialog;
      if (!dialog?.selection) return;
      state = Model.apply(state, { type: 'suggestion.pending' }, projection); renderDialog();
      try {
        const reason = $('suggest-reason').value.trim(); const name = $('suggest-name').value.trim();
        const result = await bridge.action({ version: 1, kind: 'suggestion.create', requestId: uuid(), selectionId: dialog.selection.selectionId, category: dialog.category, ...(reason ? { reason } : {}), ...(name ? { displayName: name } : {}) });
        if (duplicateTarget(result)) { closeDialog(); return; }
        state = Model.apply(state, { type: 'suggestion.result', message: 'Suggestion sent for owner review.' }, projection);
        closeDialog(); await refresh(); announce(state.message);
      } catch (caught) { state = Model.apply(state, { type: 'error', message: errorText(caught), key: 'suggestion' }, projection); renderDialog(); }
    }
    function focusAndScroll(id) {
      const target = $(id);
      if (!target) return;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    function chooseDate(date) {
      state = Model.apply(state, { type: 'date', date }, projection); render();
      const entry = Model.uniqueDates(projection).find(item => item.date === date);
      if (entry) { focusAndScroll(`day-${entry.dayKey.replace(/[^a-z0-9_-]/gi, '-')}`); announce(`${Model.cityLabel(projection, entry.cityId)}, ${formatDate(date, locale, { day: 'numeric', month: 'long', year: 'numeric' })}.`); }
    }
    function chooseCity(cityId) {
      state = Model.apply(state, { type: 'city', cityId }, projection); render();
      const target = $(`stay-${cityId.replace(/[^a-z0-9_-]/gi, '-')}`);
      if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    }
    function revealDate() {
      const ribbon = $('date-ribbon');
      const chip = ribbon?.querySelector(`[data-date="${state.selectedDate || ''}"]`);
      if (!ribbon || !chip) return;
      const left = ribbon.getBoundingClientRect().left;
      const right = left + ribbon.clientWidth;
      const bounds = chip.getBoundingClientRect();
      if (bounds.left < left) ribbon.scrollLeft += bounds.left - left;
      if (bounds.right > right) ribbon.scrollLeft += bounds.right - right;
    }
    function openDialog(cityId, category) {
      opener = document.activeElement;
      state = Model.apply(state, { type: 'dialog', value: { cityId, category, query: '', results: [], active: -1, selection: null, searchId: uuid(), pending: false } }, projection);
      $('suggest-dialog').showModal();
      $('suggest-category').value = category;
      syncSuggestionCities(cityId);
      $('suggest-city').value = cityId;
      $('suggest-name').value = state.displayName;
      $('place-search').value = '';
      renderDialog();
      $('place-search').focus();
    }
    function closeDialog() {
      global.clearTimeout(searchTimer);
      const dialog = $('suggest-dialog');
      if (dialog.open) dialog.close();
      state = Model.apply(state, { type: 'dialog', value: null }, projection); render();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    }
    async function searchPlaces() {
      const dialog = state.dialog;
      if (!dialog) return;
      const input = dialog.query.trim();
      const serial = ++searchSerial;
      if (input.length < 2) { state = Model.apply(state, { type: 'dialog', value: { ...dialog, results: [], active: -1, pending: false } }, projection); renderDialog(); return; }
      state = Model.apply(state, { type: 'dialog', value: { ...dialog, results: [], active: -1, pending: true } }, projection); renderDialog();
      try {
        const result = await bridge.action({ version: 1, kind: 'places.autocomplete', searchId: dialog.searchId, cityId: dialog.cityId, category: dialog.category, input, locale });
        if (serial !== searchSerial || !state.dialog || state.dialog.searchId !== dialog.searchId) return;
        const results = Array.isArray(result?.suggestions) ? result.suggestions.filter(item => item && typeof item.predictionId === 'string' && typeof item.mainText === 'string').slice(0, 5) : [];
        state = Model.apply(state, { type: 'dialog', value: { ...state.dialog, results, active: -1, pending: false } }, projection); renderDialog();
      } catch (caught) {
        if (serial !== searchSerial) return;
        state = Model.apply(state, { type: 'dialog', value: { ...state.dialog, results: [], active: -1, pending: false, error: errorText(caught) } }, projection); renderDialog();
      }
    }
    async function selectResult(result) {
      const dialog = state.dialog;
      if (!dialog || !result) return;
      state = Model.apply(state, { type: 'dialog', value: { ...dialog, pending: true, active: -1 } }, projection); renderDialog();
      try {
        const resolved = await bridge.action({ version: 1, kind: 'places.resolve', searchId: dialog.searchId, predictionId: result.predictionId });
        const raw = resolved?.place || resolved;
        const selectionId = resolved?.selectionId;
        if (!resolved || typeof selectionId !== 'string' || !raw || typeof raw.googlePlaceId !== 'string' || !raw.cityId || !raw.title || !raw.countryCode) throw new Error('TREK returned an invalid place selection.');
        const selection = { ...raw, key: selectionId, category: dialog.category, mapsUrl: Model.mapsUrl({ ...raw, mapsUrl: raw.mapsUrl || '' }) };
        if (selection.googlePlaceId && selection.mapsUrl) { const url = new URL(selection.mapsUrl); url.searchParams.set('query_place_id', selection.googlePlaceId); selection.mapsUrl = url.href; }
        if (!Protocol.validPlace(selection)) throw new Error('TREK returned an invalid place selection.');
        state = Model.apply(state, { type: 'dialog', value: { ...state.dialog, query: result.mainText, selection: { ...selection, selectionId }, results: [], pending: false, error: '' } }, projection); renderDialog();
      } catch (caught) { state = Model.apply(state, { type: 'dialog', value: { ...state.dialog, pending: false, error: errorText(caught) } }, projection); renderDialog(); }
    }
    function renderDialog() {
      const dialog = state.dialog;
      if (!dialog) return;
      $('suggest-category').value = dialog.category;
      syncSuggestionCities(dialog.cityId);
      $('suggest-city').value = dialog.cityId;
      $('suggest-submit').disabled = !dialog.selection || dialog.pending;
      $('suggest-submit').textContent = dialog.pending ? 'Working…' : 'Send suggestion';
      const list = $('search-results'); list.replaceChildren(); list.hidden = !dialog.results.length;
      $('place-search').setAttribute('aria-expanded', String(dialog.results.length > 0));
      dialog.results.forEach((result, index) => {
        const option = el('li', undefined, index === dialog.active ? 'result active' : 'result');
        option.id = `search-result-${index}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === dialog.active));
        option.append(el('strong', result.mainText), el('span', result.secondaryText || 'Place result'));
        option.addEventListener('mousedown', event => event.preventDefault());
        option.addEventListener('click', () => selectResult(result));
        list.append(option);
      });
      if (dialog.active >= 0 && dialog.results[dialog.active]) $('place-search').setAttribute('aria-activedescendant', `search-result-${dialog.active}`);
      else $('place-search').removeAttribute('aria-activedescendant');
      const status = $('result-status');
      status.textContent = dialog.error || (dialog.pending ? 'Searching or resolving…' : dialog.results.length ? `${dialog.results.length} results. Use arrow keys and Enter.` : dialog.query.trim().length >= 2 ? 'No places found. Try another search.' : 'Type at least two characters to search.');
      const selected = $('selected-place'); selected.replaceChildren(); selected.hidden = !dialog.selection;
      if (dialog.selection) { selected.append(mapLink(dialog.selection, bridge), el('p', `${dialog.selection.locality || Model.cityLabel(projection, dialog.selection.cityId)} · ${categoryLabel(dialog.category)}`), photoPreview(dialog.selection, bridge)); }
      $('suggest-reason').value = dialog.reason || '';
    }
    function renderRoute() {
      const list = $('route-list'); list.replaceChildren();
      const seen = new Set();
      (projection.stays || []).forEach(stay => {
        if (seen.has(stay.cityId)) return;
        seen.add(stay.cityId);
        const item = el('li');
        item.append(button(`${Model.cityLabel(projection, stay.cityId)} · ${stay.days?.length || 0} day${stay.days?.length === 1 ? '' : 's'}`, () => chooseCity(stay.cityId)));
        list.append(item);
      });
    }
    function renderDates() {
      const ribbon = $('date-ribbon'); ribbon.replaceChildren();
      Model.uniqueDates(projection).forEach(item => {
        const chip = button('', () => chooseDate(item.date), 'date-chip'); chip.dataset.date = item.date;
        chip.setAttribute('aria-current', item.date === state.selectedDate ? 'date' : 'false');
        chip.setAttribute('aria-label', `${formatDate(item.date, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${Model.cityLabel(projection, item.cityId)}`);
        chip.append(el('span', formatDate(item.date, locale, { weekday: 'short' })), el('b', formatDate(item.date, locale, { day: 'numeric' })), el('span', formatDate(item.date, locale, { month: 'short' })));
        ribbon.append(chip);
      });
    }
    function renderAdvice(cityId, canonicalId) {
      const advice = el('section', undefined, 'advice'); advice.id = `advice-${canonicalId}`; advice.tabIndex = -1; advice.setAttribute('role', 'region'); advice.setAttribute('aria-label', `${Model.cityLabel(projection, cityId)} ideas`);
      const category = state.categories[cityId] || 'see';
      advice.append(el('p', 'Shortlisted ideas. Voting here does not change the settled schedule.', 'muted small'));
      const tabs = el('div', undefined, 'local-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', `${Model.cityLabel(projection, cityId)} advice sections`);
      ['see', 'eat'].forEach(tabCategory => {
        const tab = button(categoryLabel(tabCategory), () => { state = Model.apply(state, { type: 'category', cityId, category: tabCategory }, projection); render(); });
        tab.id = `tab-${canonicalId}-${tabCategory}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `panel-${canonicalId}-${tabCategory}`); tab.setAttribute('aria-selected', String(category === tabCategory)); tab.tabIndex = category === tabCategory ? 0 : -1; tabs.append(tab);
      }); advice.append(tabs);
      tabs.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'see' : event.key === 'End' ? 'eat' : event.key === 'ArrowLeft' ? 'see' : 'eat';
        state = Model.apply(state, { type: 'category', cityId, category: next }, projection); render();
        $(`tab-${canonicalId}-${next}`)?.focus({ preventScroll: true });
      });
      ['see', 'eat'].forEach(tabCategory => {
        const panel = el('div', undefined, category === tabCategory ? 'tab-panel' : 'tab-panel hidden'); panel.id = `panel-${canonicalId}-${tabCategory}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `tab-${canonicalId}-${tabCategory}`); panel.tabIndex = 0;
        const heading = el('div', undefined, 'advice-heading'); heading.append(el('h3', tabCategory === 'eat' ? 'Good things to eat' : 'Worth a detour'));
        heading.append(button(`Suggest ${tabCategory === 'eat' ? 'an' : 'a'} idea`, () => openDialog(cityId, tabCategory), 'button primary'));
        panel.append(heading);
        const places = Model.shortlistFor(projection, cityId, tabCategory).concat(state.pendingSuggestions.filter(item => item.cityId === cityId && item.category === tabCategory).map(item => item.place || item));
        if (!places.length) panel.append(el('p', `No ${tabCategory === 'eat' ? 'food places' : 'sights'} are shortlisted yet.`, 'empty'));
        places.forEach(place => panel.append(placeRow(place, state, projection, bridge, vote, jumpToPlace)));
        panel.setAttribute('aria-label', `${Model.cityLabel(projection, cityId)} ${categoryLabel(tabCategory)} ideas`);
        advice.append(panel);
      });
      return advice;
    }
    function renderCards() {
      const container = $('stays'); container.replaceChildren();
      const renderedAdvice = new Set();
      (projection.stays || []).forEach(stay => {
        const card = el('section', undefined, 'stay-card'); card.id = `stay-${stay.id.replace(/[^a-z0-9_-]/gi, '-')}`; card.tabIndex = -1; card.setAttribute('role', 'region'); card.setAttribute('aria-label', `${Model.cityLabel(projection, stay.cityId)} stay`);
        const header = el('header', undefined, 'stay-header'); header.append(el('h2', Model.cityLabel(projection, stay.cityId)), el('span', stay.days?.length ? `${stay.days.length} day${stay.days.length === 1 ? '' : 's'}` : 'Ideas beyond the settled route', 'muted small')); card.append(header);
        if (!stay.days?.length) card.append(el('p', 'No settled dates here. Suggestions stay separate from the plan.', 'empty'));
        (stay.days || []).forEach(day => {
          const dayBlock = el('section', undefined, day.date === state.selectedDate ? 'day selected' : 'day'); dayBlock.id = `day-${day.key.replace(/[^a-z0-9_-]/gi, '-')}`; dayBlock.tabIndex = -1; dayBlock.setAttribute('aria-label', `${Model.cityLabel(projection, stay.cityId)}, ${formatDate(day.date, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`);
          dayBlock.append(el('h3', formatDate(day.date, locale, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }), 'day-title'));
          if (!day.schedule?.length) dayBlock.append(el('p', 'No settled places published for this date.', 'muted small'));
          (day.schedule || []).forEach(row => {
            const schedule = el('div', undefined, 'schedule-row'); const time = el('span', row.time || 'Any time', 'time'); const copy = el('div', undefined, 'place-copy'); copy.append(mapLink(row.place, bridge), el('p', `${categoryLabel(row.place.category)} · ${row.place.locality || ''}`, 'place-meta'), photoPreview(row.place, bridge)); schedule.append(time, copy); if (row.booked) schedule.append(el('span', 'Booked', 'badge')); dayBlock.append(schedule);
          }); card.append(dayBlock);
        });
        const canonical = stay.shortlistCityId || stay.cityId;
        if (!renderedAdvice.has(canonical)) { renderedAdvice.add(canonical); card.append(renderAdvice(canonical, canonical)); }
        else { const pointer = el('div', undefined, 'return-pointer'); pointer.append(el('p', `More ${Model.cityLabel(projection, canonical)} ideas are kept in the first ${Model.cityLabel(projection, canonical)} card.`, 'muted small')); pointer.append(button(`Open ${Model.cityLabel(projection, canonical)} ideas`, () => focusAndScroll(`advice-${canonical}`), 'button')); card.append(pointer); }
        container.append(card);
      });
    }
    function renderComments() {
      const list = $('comments'); list.replaceChildren();
      const visibleComments = state.comments.filter(comment => comment && comment.deleted !== true && typeof comment.text === 'string' && comment.text);
      if (!visibleComments.length) list.append(el('p', 'Your sent comments will appear here when TREK returns them.', 'muted small'));
      visibleComments.forEach(comment => { const item = el('article', undefined, 'comment'); item.append(el('strong', comment.displayName || 'Guest adviser'), el('span', comment.createdAt ? ` · ${comment.createdAt}` : '', 'muted small'), el('p', comment.text)); list.append(item); });
      if (typeof state.nextCommentsCursor === 'string' && state.nextCommentsCursor) {
        const more = button('Load more comments', () => refresh(state.nextCommentsCursor, true), 'button');
        more.disabled = Boolean(state.busy.comments);
        list.append(more);
      }
    }
    function render() {
      $('trip-title').textContent = projection.title;
      $('trip-meta').textContent = `${projection.cities.length} destination${projection.cities.length === 1 ? '' : 's'} · settled schedule and local advice`;
      $('loading').hidden = true; $('content').hidden = false;
      $('error-banner').hidden = !state.error; $('error-banner').textContent = state.error;
      $('announcement').textContent = state.message;
      renderRoute(); renderDates(); renderCards(); renderComments(); revealDate();
      if (state.dialog) renderDialog();
    }
    root.querySelectorAll('[data-initial]').forEach(node => node.removeAttribute('data-initial'));
    $('comment-form').addEventListener('submit', commentSubmit);
    $('display-name').addEventListener('input', event => { state = Model.apply(state, { type: 'display-name', value: event.target.value }, projection); });
    $('suggest-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    $('suggest-dialog').addEventListener('click', event => { if (event.target === $('suggest-dialog')) closeDialog(); });
    $('suggest-close').addEventListener('click', closeDialog); $('suggest-cancel').addEventListener('click', closeDialog);
    $('suggest-form').addEventListener('submit', submitSuggestion);
    $('place-search').addEventListener('input', event => { if (!state.dialog) return; state = Model.apply(state, { type: 'dialog', value: { ...state.dialog, query: event.target.value, selection: null, error: '' } }, projection); renderDialog(); global.clearTimeout(searchTimer); searchTimer = global.setTimeout(searchPlaces, 300); });
    $('place-search').addEventListener('keydown', event => {
      const dialog = state.dialog; if (!dialog) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const delta = event.key === 'ArrowDown' ? 1 : -1; const active = dialog.results.length ? (dialog.active + delta + dialog.results.length) % dialog.results.length : -1; state = Model.apply(state, { type: 'dialog', value: { ...dialog, active } }, projection); renderDialog(); }
      if (event.key === 'Enter' && dialog.active >= 0) { event.preventDefault(); selectResult(dialog.results[dialog.active]); }
      if (event.key === 'Escape' && dialog.results.length) { event.preventDefault(); state = Model.apply(state, { type: 'dialog', value: { ...dialog, results: [], active: -1 } }, projection); renderDialog(); }
    });
    $('suggest-category').addEventListener('change', event => { if (state.dialog) { state = Model.apply(state, { type: 'dialog', value: { ...state.dialog, category: event.target.value, selection: null } }, projection); renderDialog(); } });
    $('suggest-city').addEventListener('change', event => { if (state.dialog) { state = Model.apply(state, { type: 'dialog', value: { ...state.dialog, cityId: event.target.value, selection: null } }, projection); renderDialog(); } });
    $('suggest-reason').addEventListener('input', event => { if (state.dialog) state = Model.apply(state, { type: 'dialog', value: { ...state.dialog, reason: event.target.value.slice(0, 500) } }, projection); });
    $('suggest-name').addEventListener('input', event => { state = Model.apply(state, { type: 'display-name', value: event.target.value }, projection); });
    refresh();
  }

  function guest() {
    const root = $('app');
    if (!root) return;
    const bridge = PublicBridge();
    global.addEventListener('pagehide', bridge.close, { once: true });
    bridge.context().then(context => {
      applyTheme(context);
      bridge.action({ version: 1, kind: 'read' }).then(result => {
        const read = Protocol.readData(result);
        if (!read) throw new Error('TREK returned an invalid advice projection.');
        renderGuest(root, read.projection, bridge, context);
      }).catch(caught => { $('loading').hidden = true; $('error-banner').hidden = false; $('error-banner').textContent = errorText(caught); });
    });
    if (!hasParent) { $('loading').hidden = true; $('error-banner').hidden = false; $('error-banner').textContent = 'Open this guest page from a TREK shared advice link.'; }
  }

  function owner() {
    const root = $('owner-app'); if (!root) return;
    const bridge = OwnerBridge();
    let context; let response; let draft = null; let editorModel = ownerSelectionModel(null, null); let previewRevision = null;
    let setupEditor = null;
    const ownerError = message => { $('owner-error').hidden = false; $('owner-error').textContent = message; };
    const tripId = () => context?.tripId;
    function input(label, value, type = 'text') { const wrap = el('label', undefined, 'field'); wrap.append(el('span', label)); const control = document.createElement('input'); control.type = type; control.value = value ?? ''; wrap.append(control); return { wrap, control }; }
    function configEditor(config, candidates) {
      setupEditor = null;
      if (Array.isArray(candidates?.days)) {
        setupEditor = global.TrekAdviceOwner.createEditor($('config-editor'), config, candidates, () => {
          previewRevision = null;
          $('preview-status').textContent = 'Selection changed. Preview again before enabling the link.';
        });
        return;
      }
      editorModel = ownerSelectionModel(config, candidates);
      draft = editorModel.config;
      const panel = $('config-editor'); panel.replaceChildren();
      const title = input('Public trip title', editorModel.config.publicTitle || '', 'text'); title.control.maxLength = 200; title.control.dataset.field = 'title'; panel.append(title.wrap);
      panel.append(el('p', 'Choose exactly which cities, stays, schedule rows, and shortlist places are visible. Private notes, member data, bookings details, and credentials never enter this form.', 'muted small'));
      const makeGroup = (heading, rows, checked, getLabel, dataKey) => {
        const group = el('fieldset', undefined, 'config-group'); group.append(el('legend', heading));
        (rows || []).forEach(row => { const label = el('label', undefined, 'check-row'); const check = document.createElement('input'); check.type = 'checkbox'; check.checked = checked(row); check.dataset.key = dataKey; check.dataset.id = String(row.id ?? row.assignmentId ?? row.placeId); label.append(check, el('span', getLabel(row))); group.append(label); });
        panel.append(group);
      };
      makeGroup('Cities', editorModel.available.cities, row => editorModel.selected.cities.has(ownerRowId(row, 'cities')), row => `${row.label || row.publicTitle || 'City'} · ${(row.countryCodes || []).join(', ')}`, 'cities');
      makeGroup('Stays', editorModel.available.stays, row => editorModel.selected.stays.has(ownerRowId(row, 'stays')), row => `${row.cityId || row.label || 'Stay'} · ${(row.dayIds || []).length} selected day${row.dayIds?.length === 1 ? '' : 's'}`, 'stays');
      makeGroup('Settled schedule', editorModel.available.schedule, row => editorModel.selected.schedule.has(ownerRowId(row, 'schedule')), row => `${row.publicTitle || row.title || 'Schedule row'} · ${categoryLabel(row.category)}`, 'schedule');
      makeGroup('Shortlist', editorModel.available.shortlist, row => editorModel.selected.shortlist.has(ownerRowId(row, 'shortlist')), row => `${row.publicTitle || row.title || 'Shortlist place'} · ${categoryLabel(row.category)} · ${row.cityId || ''}`, 'shortlist');
    }
    function currentConfig() {
      if (setupEditor) return setupEditor.read();
      return ownerConfigFromControls(draft, editorModel.available, document);
    }
    function renderInbox(inbox) {
      const panel = $('inbox'); panel.replaceChildren();
      if (!inbox) { panel.append(el('p', 'Owner feedback inbox is not included in the current host response.', 'muted')); return; }
      const suggestions = Array.isArray(inbox.suggestions) ? inbox.suggestions : [];
      const comments = Array.isArray(inbox.comments) ? inbox.comments.filter(item => item && item.deleted !== true && typeof item.text === 'string') : [];
      panel.append(el('h3', 'Pending suggestions'));
      if (!suggestions.length) panel.append(el('p', 'No pending suggestions.', 'muted small'));
      suggestions.forEach(item => { const row = el('article', undefined, 'inbox-row'); row.append(el('strong', item.title || item.publicTitle || 'Suggested place'), el('p', `${item.displayName || 'Guest adviser'}${item.reason ? ` · ${item.reason}` : ''}`, 'muted')); const actions = el('div', ''); actions.append(button('Accept', () => reviewSuggestion(item, 'accept'), 'button primary'), button('Reject', () => reviewSuggestion(item, 'reject'), 'button')); row.append(actions); panel.append(row); });
      panel.append(el('h3', 'Comments'));
      if (!comments.length) panel.append(el('p', 'No comments.', 'muted small'));
      comments.forEach(item => { const row = el('article', undefined, 'inbox-row'); row.append(el('strong', item.displayName || 'Guest adviser'), el('p', item.text || '', 'muted')); panel.append(row); });
    }
    async function reviewSuggestion(item, action) { try { await bridge.invoke(`/owner/suggestions/${action}?tripId=${encodeURIComponent(tripId())}&suggestionId=${encodeURIComponent(item.id)}`, 'POST', {}); await load(); } catch (caught) { ownerError(errorText(caught)); } }
    async function load() {
      $('owner-error').hidden = true;
      try {
        response = await bridge.invoke(`/owner?tripId=${encodeURIComponent(tripId())}`, 'GET');
        const ownerConfig = response?.config;
        const stored = storedOwnerConfig(ownerConfig);
        const candidates = response?.candidates || ownerConfig?.candidates || response?.tripReads || response?.trip || null;
        configEditor(stored, candidates);
        if (!candidates) ownerError(stored
          ? 'TREK did not supply selectable trip items. Your saved selection is shown. A TREK host update is required to add items.'
          : 'TREK did not supply selectable trip items. No advice link is configured. A TREK host update is required to start setup.');
        $('enabled').checked = Boolean(ownerConfig?.enabled ?? response?.enabled);
        if (Number.isInteger(ownerConfig?.expiresInDays)) $('expires').value = ownerConfig.expiresInDays;
        renderInbox(response?.inbox); $('owner-loading').hidden = true; $('owner-content').hidden = false;
      } catch (caught) { ownerError(errorText(caught)); }
      finally { $('owner-loading').hidden = true; }
    }
    async function preview() {
      const control = $('preview-button'); control.disabled = true; $('owner-error').hidden = true;
      try {
        const config = currentConfig();
        if (!config) throw new Error('Select the trip information to preview.');
        const result = await bridge.invoke(`/owner/preview?tripId=${encodeURIComponent(tripId())}`, 'POST', config);
        const projection = result?.projection || result;
        if (!Protocol.validProjection(projection)) throw new Error('TREK returned an invalid preview.');
        previewRevision = projection.revision;
        const panel = $('preview');
        const template = document.createElement('template');
        // This build-generated constant is the trusted guest document, never trip data.
        template.innerHTML = global.TrekAdviceGuestMarkup;
        panel.replaceChildren(el('p', 'Private preview: navigation and categories work. Feedback, search, and photos are disabled here. Nothing has been published.', 'status'), template.content.cloneNode(true));
        const previewBridge = global.TrekAdvicePreview.bridge(projection, url => global.parent.postMessage({ type: 'trek:openExternal', url }, '*'));
        renderGuest(panel, projection, previewBridge, context);
        $('preview-status').textContent = 'Review the guest page below before enabling the link.';
        panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (caught) { previewRevision = null; ownerError(errorText(caught)); }
      finally { control.disabled = false; }
    }
    async function publish() { try { const config = currentConfig(); if (!config) { ownerError('TREK has not supplied a usable owner configuration. Publishing is unavailable.'); return; } if ($('enabled').checked && !previewRevision) { ownerError('Run a current preview before enabling the advice link.'); return; } const result = await bridge.invoke(`/owner/config?tripId=${encodeURIComponent(tripId())}`, 'PUT', { enabled: $('enabled').checked, expiresInDays: Number($('expires').value), expectedRevision: response?.config?.revision || response?.revision || 0, ...($('enabled').checked && previewRevision ? { previewRevision } : {}), config }); response = result; $('publish-status').textContent = result?.token ? 'Advice link published. Copy it from the host share controls.' : 'Advice configuration published.'; } catch (caught) { ownerError(errorText(caught)); } }
    $('config-editor').addEventListener('input', () => { previewRevision = null; $('preview-status').textContent = 'Configuration changed. Run a fresh preview before enabling.'; });
    $('config-editor').addEventListener('change', () => { previewRevision = null; $('preview-status').textContent = 'Configuration changed. Run a fresh preview before enabling.'; });
    $('preview-button').addEventListener('click', preview); $('publish-button').addEventListener('click', publish); $('reload-button').addEventListener('click', load);
    bridge.context().then(value => { context = value; applyTheme(context); if (!tripId()) ownerError('TREK did not provide an owner trip context.'); else load(); }).catch(caught => ownerError(errorText(caught)));
  }

  global.TrekAdviceController = Object.freeze({ ownerSelectionModel, ownerConfigFromControls, storedOwnerConfig, validVoteResult: Protocol.validVoteResult });
  global.addEventListener('DOMContentLoaded', () => { applyTheme(null); guest(); owner(); });
})(window);
