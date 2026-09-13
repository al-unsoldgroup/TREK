(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TrekAdviceOwner = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
  const cleanTitle = value => String(value || '').trim().slice(0, 200);
  function prepare(stored, candidates) {
    const config = stored || {};
    const selected = (kind, id, key) => (config[kind] || []).find(row => row[key] === id);
    return {
      publicTitle: config.publicTitle || '', cities: clone(config.cities || []),
      days: (candidates.days || []).map(day => ({ ...day, cityId: (config.stays || []).find(stay => stay.dayIds.includes(day.id))?.cityId || '' })),
      schedule: (candidates.schedule || []).map(place => ({ ...place, category: 'see', ...selected('schedule', place.assignmentId, 'assignmentId'), selected: !!selected('schedule', place.assignmentId, 'assignmentId') })),
      shortlist: (candidates.shortlist || []).map(place => ({ ...place, category: 'see', cityId: '', locality: '', countryCode: '', ...selected('shortlist', place.placeId, 'placeId'), selected: !!selected('shortlist', place.placeId, 'placeId') })),
    };
  }
  function suggestBounds(places) {
    const points = places.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
    requireValue(points.length, 'No selected places have coordinates. Enter the city bounds manually.');
    const south = Math.min(...points.map(p => p.lat)), north = Math.max(...points.map(p => p.lat));
    const west = Math.min(...points.map(p => p.lng)), east = Math.max(...points.map(p => p.lng));
    requireValue(north - south <= 2 && east - west <= 2, 'Selected places are too far apart for one city. Review their city assignments.');
    return { south: Math.max(-90, south - 0.03), north: Math.min(90, north + 0.03), west: Math.max(-180, west - 0.03), east: Math.min(180, east + 0.03) };
  }
  function build(state) {
    const publicTitle = cleanTitle(state.publicTitle);
    requireValue(publicTitle, 'Enter a public trip title.');
    requireValue(state.cities.length, 'Add and confirm at least one city.');
    const cities = state.cities.map(city => {
      const label = cleanTitle(city.label).slice(0, 100), countries = (city.countryCodes || []).map(c => c.trim().toUpperCase());
      const b = city.bounds || {};
      requireValue(label && countries.length && countries.every(c => /^[A-Z]{2}$/.test(c)), 'Each city needs a name and two-letter country code.');
      requireValue(['south', 'north', 'west', 'east'].every(k => Number.isFinite(b[k])) && b.south < b.north && b.west < b.east && b.south >= -90 && b.north <= 90 && b.west >= -180 && b.east <= 180, `Confirm valid search bounds for ${label}.`);
      return { id: city.id, label, countryCodes: countries, bounds: { south: b.south, north: b.north, west: b.west, east: b.east } };
    });
    const cityById = new Map(cities.map(c => [c.id, c]));
    const days = [...state.days].sort((a,b) => a.date.localeCompare(b.date) || a.id-b.id);
    const stays = [];
    let previous = null;
    for (const day of days) {
      if (!day.cityId) { previous = null; continue; }
      requireValue(cityById.has(day.cityId), `Choose a current city for ${day.date}.`);
      const adjacent = previous && Date.parse(day.date) - Date.parse(previous.date) === 86400000;
      if (adjacent && previous.cityId === day.cityId) stays[stays.length-1].dayIds.push(day.id);
      else stays.push({ id: `stay-${day.id}`, cityId: day.cityId, dayIds: [day.id] });
      previous = day;
    }
    const sharedDays = new Set(stays.flatMap(s => s.dayIds));
    const choice = row => {
      const publicTitle = cleanTitle(row.publicTitle);
      requireValue(publicTitle, 'Every selected place needs a public name.');
      requireValue(['see','eat'].includes(row.category), `Choose See or Eat for ${publicTitle}.`);
      return { publicTitle, category: row.category };
    };
    const schedule = state.schedule.filter(row => row.selected).map(row => {
      requireValue(sharedDays.has(row.dayId), `Choose a city for the day containing ${row.publicTitle}, or deselect that place.`);
      return { assignmentId: row.assignmentId, ...choice(row) };
    });
    const shortlist = state.shortlist.filter(row => row.selected).map(row => {
      const city = cityById.get(row.cityId);
      requireValue(city || row.cityId === 'elsewhere', `Choose a city for ${row.publicTitle}.`);
      const locality = city ? city.label : cleanTitle(row.locality).slice(0,100);
      const countryCode = city ? city.countryCodes[0] : String(row.countryCode || '').trim().toUpperCase();
      requireValue(locality && /^[A-Z]{2}$/.test(countryCode), `Enter the destination and country for ${row.publicTitle}.`);
      return { placeId: row.placeId, cityId: row.cityId, ...choice(row), locality, countryCode };
    });
    return { version: 1, publicTitle, cities, stays, schedule, shortlist };
  }

  function createEditor(panel, stored, candidates, changed) {
    const state = prepare(stored, candidates);
    const doc = panel.ownerDocument;
    const element = (tag, text, className) => { const n=doc.createElement(tag); if(text!==undefined)n.textContent=text; if(className)n.className=className; return n; };
    const field = (parent, label, value, onInput, type='text') => {
      const wrap=element('label',undefined,'field'), input=element('input');
      wrap.append(element('span',label),input);input.type=type;input.value=value ?? '';input.addEventListener('input',()=>{onInput(input.value);changed();});
      if(type==='number')input.step='any';else input.maxLength=200;
      parent.append(wrap);return input;
    };
    const select = (parent,label,value,options,onChange) => {
      const wrap=element('label',undefined,'field'), control=element('select');
      wrap.append(element('span',label),control);
      for(const [id,name] of options){const opt=element('option',name);opt.value=id;control.append(opt);}
      control.value=value; control.addEventListener('change',()=>{onChange(control.value);changed();});parent.append(wrap);return control;
    };
    const action = (parent,label,fn) => { const b=element('button',label,'button');b.type='button';b.addEventListener('click',fn);parent.append(b);return b; };
    const group = label => { const node=element('fieldset',undefined,'config-group');node.append(element('legend',label));panel.append(node);return node; };
    const cityOptions = (elsewhere=false) => [['','Not shared / choose city'],...state.cities.map(c=>[c.id,c.label || 'Unnamed city']),...(elsewhere?[['elsewhere','Elsewhere']]:[])];
    function render() {
      panel.replaceChildren();
      field(panel,'Public trip title',state.publicTitle,v=>state.publicTitle=v);
      panel.append(element('p','Nothing is selected automatically. Name each city, assign the days you want to share, then select places. Return visits share one city shortlist.','muted small'));
      const cityGroup=group('1. Cities and search areas');
      for(const city of state.cities){
        const card=element('div',undefined,'owner-card');cityGroup.append(card);
        const inputs=element('div',undefined,'form-grid');card.append(inputs);
        const name=field(inputs,'City name',city.label,v=>city.label=v);
        name.addEventListener('change',()=>{for(const option of panel.querySelectorAll('option'))if(option.value===city.id)option.textContent=city.label || 'Unnamed city';});
        field(inputs,'Country codes (for example JP)',city.countryCodes.join(', '),v=>city.countryCodes=v.split(',').map(c=>c.trim().toUpperCase()).filter(Boolean));
        const details=element('details');details.append(element('summary','Confirm geographic search area'));card.append(details);
        details.append(element('p','Use selected places as a starting point, then review these latitude and longitude limits. They bias search; they do not restrict it.','muted small'));
        const bounds=element('div',undefined,'form-grid');details.append(bounds);
        const boundsInputs={};
        for(const key of ['south','north','west','east'])boundsInputs[key]=field(bounds,key[0].toUpperCase()+key.slice(1),city.bounds?.[key],v=>{city.bounds ||= {};city.bounds[key]=v.trim()===''?null:Number(v);},'number');
        const status=element('p',undefined,'status');status.setAttribute('role','status');details.append(status);
        action(details,'Suggest bounds from selected places',()=>{
          try {const dayIds=new Set(state.days.filter(d=>d.cityId===city.id).map(d=>d.id));city.bounds=suggestBounds([...state.schedule.filter(p=>p.selected&&dayIds.has(p.dayId)),...state.shortlist.filter(p=>p.selected&&p.cityId===city.id)]);for(const key of Object.keys(boundsInputs))boundsInputs[key].value=city.bounds[key];status.textContent='Suggested area is shown above. Review these limits before previewing.';changed();}
          catch(error){status.textContent=error.message;}
        });
        action(card,'Remove city',()=>{state.cities=state.cities.filter(c=>c!==city);for(const day of state.days)if(day.cityId===city.id)day.cityId='';for(const place of state.shortlist)if(place.cityId===city.id)place.cityId='';changed();render();});
      }
      action(cityGroup,'Add city',()=>{let index=1;while(state.cities.some(c=>c.id===`city-${index}`))index++;state.cities.push({id:`city-${index}`,label:'',countryCodes:[],bounds:{south:null,north:null,west:null,east:null}});changed();render();});
      const dayGroup=group('2. Days to share');
      if(!state.days.length)dayGroup.append(element('p','This trip has no dated days yet. You can still share a city shortlist.','muted'));
      for(const day of state.days)select(dayGroup,day.date,day.cityId,cityOptions(),v=>day.cityId=v);
      function placesGroup(label,rows,isSchedule){
        const section=group(label);
        if(!rows.length)section.append(element('p','No eligible places in this list.','muted'));
        for(const row of rows){
          const card=element('div',undefined,'owner-choice');section.append(card);
          const checkLabel=element('label',undefined,'check-row'), check=element('input');check.type='checkbox';check.checked=row.selected;
          checkLabel.append(check,element('span',row.publicTitle));card.append(checkLabel);
          if(isSchedule)card.append(element('p',state.days.find(d=>d.id===row.dayId)?.date || '', 'muted small'));
          const controls=element('div',undefined,'form-grid');controls.hidden=!row.selected;card.append(controls);
          check.addEventListener('change',()=>{row.selected=check.checked;controls.hidden=!row.selected;changed();});
          field(controls,'Public place name',row.publicTitle,v=>row.publicTitle=v);
          select(controls,'Category',row.category,[['see','See'],['eat','Eat']],v=>row.category=v);
          if(!isSchedule){
            select(controls,'City',row.cityId,cityOptions(true),v=>{row.cityId=v;render();});
            if(row.cityId==='elsewhere'){field(controls,'Actual destination',row.locality,v=>row.locality=v);field(controls,'Country code',row.countryCode,v=>row.countryCode=v);}
          }
        }
      }
      placesGroup('3. Settled schedule',state.schedule,true);
      placesGroup('4. Places for guests to vote on',state.shortlist,false);
    }
    render();
    return { read:()=>build(state), state };
  }
  return { prepare, suggestBounds, build, createEditor };
});
