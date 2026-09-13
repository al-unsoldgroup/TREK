(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TrekAdviceOwner = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  function preparePreset(stored, candidates) {
    if (!candidates?.preset) throw new Error('TREK needs an update to prepare this trip automatically.');
    const hidden = { cityIds: [], dayIds: [], placeIds: [], assignmentIds: [], ...(stored?.source === 'trip' ? stored.hidden : {}) };
    return { preset: clone(candidates.preset), candidates: clone(candidates), hidden: clone(hidden) };
  }
  function toggle(state, key, id, hide) {
    state.hidden[key] = hide ? [...new Set([...state.hidden[key], id])] : state.hidden[key].filter(value => value !== id);
  }
  function hideCity(state, cityId, hide) {
    toggle(state, 'cityIds', cityId, hide);
  }
  function readPreset(state) { return clone({ ...state.preset, source: 'trip', hidden: state.hidden }); }
  function createEditor(panel, stored, candidates, changed) {
    const state = preparePreset(stored, candidates);
    const doc = panel.ownerDocument;
    const element = (tag, text, className) => {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const details = element('details');
    details.append(element('summary', 'Hide items from this link'));
    const list = element('div'); details.append(list);
    panel.replaceChildren(element('p', (state.preset.cities.map(city => city.label).join(' · ') || 'Your trip') + ' · ' + candidates.days.length + ' days', 'muted'),
      element('p', 'Cities, itinerary and saved places come from your trip. New eligible items are included automatically. Only hide exceptions below.', 'muted small'), details);
    function render() {
      list.replaceChildren();
      const group = title => { const node = element('fieldset', undefined, 'config-group'); node.append(element('legend', title)); list.append(node); return node; };
      const checkbox = (parent, title, checked, update) => {
        const label = element('label', undefined, 'check-row'), input = element('input');
        input.type = 'checkbox'; input.checked = checked;
        input.addEventListener('change', () => { update(input.checked); changed(); });
        label.append(input, element('span', 'Hide ' + title)); parent.append(label);
      };
      const cities = group('Cities');
      for (const city of state.preset.cities) checkbox(cities, city.label, state.hidden.cityIds.includes(city.id), hide => hideCity(state, city.id, hide));
      const days = group('Days');
      for (const day of candidates.days) checkbox(days, day.date, state.hidden.dayIds.includes(day.id), hide => toggle(state, 'dayIds', day.id, hide));
      const places = group('Places');
      const unique = new Map([...candidates.schedule, ...candidates.shortlist].map(place => [place.placeId, place]));
      for (const place of unique.values()) checkbox(places, place.publicTitle, state.hidden.placeIds.includes(place.placeId), hide => toggle(state, 'placeIds', place.placeId, hide));
    }
    render();
    return { read: () => readPreset(state), state };
  }
  return { preparePreset, readPreset, hideCity, createEditor };
});
