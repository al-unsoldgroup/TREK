'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Setup = require('../../client/advice-owner');
const city = {id:'city-a',label:'Tokyo',countryCodes:['JP'],bounds:null};
const candidates = {
  days:[{id:1,date:'2026-10-09'},{id:2,date:'2026-10-10'}],
  schedule:[{assignmentId:10,dayId:1,placeId:20,publicTitle:'Museum'}],
  shortlist:[{placeId:21,publicTitle:'Cafe'}],
  preset:{version:1,source:'trip',publicTitle:'Japan',cities:[city],
    stays:[{id:'stay-1',cityId:city.id,dayIds:[1,2]}],
    schedule:[{assignmentId:10,publicTitle:'Museum',category:'see'}],
    shortlist:[{placeId:21,publicTitle:'Cafe',category:'eat',cityId:city.id,locality:'Tokyo',countryCode:'JP'}]},
};
test('trip preset includes everything without manual city entry',()=>{
  const state=Setup.preparePreset(null,candidates);
  assert.deepEqual(state.hidden,{cityIds:[],dayIds:[],placeIds:[],assignmentIds:[]});
  assert.deepEqual(Setup.readPreset(state),{...candidates.preset,hidden:state.hidden});
});
test('hiding and showing a city preserves independent day and place exceptions',()=>{
  const stored={source:'trip',hidden:{cityIds:[],dayIds:[1],placeIds:[21],assignmentIds:[]}};
  const state=Setup.preparePreset(stored,candidates);
  Setup.hideCity(state,city.id,true);
  Setup.hideCity(state,city.id,true);
  assert.deepEqual(state.hidden.cityIds,[city.id]);
  Setup.hideCity(state,city.id,false);
  assert.deepEqual(state.hidden,stored.hidden);
});
test('refresh uses native trip data and keeps only saved hide exceptions',()=>{
  const stored={...candidates.preset,publicTitle:'Old title',hidden:{cityIds:[city.id],dayIds:[],placeIds:[20],assignmentIds:[]}};
  const before=JSON.stringify(stored);
  const state=Setup.preparePreset(stored,candidates);
  assert.equal(Setup.readPreset(state).publicTitle,'Japan');
  assert.deepEqual(state.hidden,stored.hidden);
  Setup.hideCity(state,city.id,false);
  assert.equal(JSON.stringify(stored),before);
});
test('older manual configurations migrate to included-by-default presets',()=>{
  const state=Setup.preparePreset({publicTitle:'Old',cities:[],hidden:{cityIds:[city.id]}},candidates);
  assert.deepEqual(state.hidden.cityIds,[]);
  assert.deepEqual(Setup.readPreset(state).cities,[city]);
});
test('missing native preset fails clearly without a manual-entry fallback',()=>{
  assert.throws(()=>Setup.preparePreset(null,{days:[]}),/update.*automatically/);
});
test('editor has collapsed hide-only controls and preserves the focused checkbox',()=>{
  class Element {
    constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.listeners={};}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=nodes;}
    addEventListener(name,fn){(this.listeners[name] ||= []).push(fn);}
    fire(name){for(const fn of this.listeners[name] || [])fn({target:this});}
    all(){return this.children.flatMap(child=>[child,...child.all()]);}
  }
  const doc={createElement:tag=>new Element(tag,doc)};
  const panel=new Element('div',doc);let changes=0;
  const editor=Setup.createEditor(panel,null,candidates,()=>changes++);
  const controls=()=>panel.all().filter(n=>n.tag==='input');
  assert.equal(controls().length,5);
  assert.ok(controls().every(n=>n.type==='checkbox'&&!n.checked));
  assert.ok(!panel.all().some(n=>n.tag==='select'||n.tag==='button'));
  assert.ok(!panel.all().find(n=>n.tag==='details').open);
  const check=controls()[0];check.checked=true;check.fire('change');
  assert.equal(controls()[0],check);
  assert.deepEqual(editor.read().hidden.cityIds,[city.id]);
  check.checked=false;check.fire('change');
  assert.deepEqual(editor.read().hidden.cityIds,[]);
  assert.equal(changes,2);
});
