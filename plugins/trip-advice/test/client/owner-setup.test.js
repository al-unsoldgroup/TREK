'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Setup = require('../../client/advice-owner');
const candidates = {
  days: [{id:1,date:'2026-10-09'},{id:2,date:'2026-10-10'},{id:3,date:'2026-10-11'}],
  schedule: [{assignmentId:10,dayId:1,placeId:20,publicTitle:'Museum',lat:35.6,lng:139.7}],
  shortlist: [{placeId:21,publicTitle:'Cafe',lat:35.7,lng:139.8}],
};
const city = {id:'city-a',label:'Tokyo',countryCodes:['JP'],bounds:{south:35,north:36,west:139,east:140}};
test('first setup lists native candidates but selects nothing and invents no cities',()=>{
  const state=Setup.prepare(null,candidates);
  assert.equal(state.days.length,3);
  assert.equal(state.schedule.length,1);
  assert.equal(state.shortlist.length,1);
  assert.deepEqual(state.cities,[]);
  assert.ok(state.days.every(d=>d.cityId===''));
  assert.ok(state.schedule.every(p=>!p.selected));
});
test('owner choices become strict config, preserve return stays and omit source metadata',()=>{
  const state=Setup.prepare(null,candidates);
  state.publicTitle='Japan'; state.cities=[city,{...city,id:'city-b',label:'Kyoto'}];
  state.days[0].cityId='city-a';state.days[1].cityId='city-b';state.days[2].cityId='city-a';
  Object.assign(state.schedule[0],{selected:true,category:'see',notes:'PRIVATE'});
  Object.assign(state.shortlist[0],{selected:true,cityId:'city-a',category:'eat'});
  const config=Setup.build(state);
  assert.deepEqual(config.stays.map(s=>s.cityId),['city-a','city-b','city-a']);
  assert.deepEqual(config.schedule,[{assignmentId:10,publicTitle:'Museum',category:'see'}]);
  assert.deepEqual(config.shortlist,[{placeId:21,publicTitle:'Cafe',category:'eat',cityId:'city-a',locality:'Tokyo',countryCode:'JP'}]);
  assert.ok(!JSON.stringify(config).includes('PRIVATE'));
  assert.ok(!JSON.stringify(config).includes('placeId":20'));
});
test('stored edits survive native title changes and removed candidates are not resurrected',()=>{
  const stored={version:1,publicTitle:'Japan',cities:[city],stays:[{id:'old',cityId:city.id,dayIds:[1]}],schedule:[{assignmentId:10,publicTitle:'Public name',category:'eat'},{assignmentId:999,publicTitle:'Removed',category:'see'}],shortlist:[]};
  const state=Setup.prepare(stored,candidates);
  assert.equal(state.schedule.length,1);
  assert.equal(state.schedule[0].publicTitle,'Public name');
  assert.equal(state.schedule[0].category,'eat');
  assert.equal(state.days[0].cityId,city.id);
});
test('selected schedule needs an explicitly shared day and valid categories',()=>{
  const state=Setup.prepare(null,candidates); state.publicTitle='Japan';state.cities=[city];state.schedule[0].selected=true;
  assert.throws(()=>Setup.build(state),/day/i);
  state.days[0].cityId=city.id;state.schedule[0].category='transport';
  assert.throws(()=>Setup.build(state),/See or Eat/);
});
test('unselected calendar gaps do not merge separate stays',()=>{
  const state=Setup.prepare(null,candidates);state.publicTitle='Japan';state.cities=[city];state.days[0].cityId=city.id;state.days[2].cityId=city.id;
  assert.equal(Setup.build(state).stays.length,2);
});
test('bounds suggestion rejects distant outliers and uses only finite coordinates',()=>{
  assert.throws(()=>Setup.suggestBounds([{lat:35,lng:139},{lat:51,lng:0}]),/too far apart/i);
  assert.throws(()=>Setup.suggestBounds([{lat:null,lng:null}]),/coordinates/i);
  const b=Setup.suggestBounds([{lat:35.6,lng:139.7},{lat:35.7,lng:139.8}]);
  assert.ok(b.south<35.6&&b.north>35.7&&b.west<139.7&&b.east>139.8);
});

test('editor controls create a city, share a day and preserve selections when adding another city',()=>{
  class Element {
    constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.listeners={};this.attributes={};this.value='';}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=nodes;}
    addEventListener(name,fn){(this.listeners[name] ||= []).push(fn);}
    setAttribute(key,value){this.attributes[key]=value;}
    fire(name){for(const fn of this.listeners[name] || [])fn({target:this});}
    all(){return this.children.flatMap(child=>[child,...child.all()]);}
    querySelectorAll(tag){return this.all().filter(child=>child.tag===tag);}
  }
  const doc={createElement:tag=>new Element(tag,doc)};
  const panel=new Element('div',doc);let changes=0;
  const editor=Setup.createEditor(panel,null,candidates,()=>changes++);
  const action=name=>panel.all().find(n=>n.tag==='button'&&n.textContent===name).fire('click');
  const input=(label,value,event='input')=>{
    const wrap=panel.all().find(n=>n.tag==='label'&&n.children[0]?.textContent===label);
    const control=wrap.children[1];control.value=value;control.fire(event);return control;
  };
  action('Add city');
  input('City name','Tokyo');input('City name','Tokyo','change');
  input('Country codes (for example JP)','JP');
  input('Public trip title','Japan');
  input('2026-10-09','city-1','change');
  const check=panel.all().find(n=>n.tag==='input'&&n.type==='checkbox');check.checked=true;check.fire('change');
  action('Suggest bounds from selected places');
  const config=editor.read();
  assert.equal(config.publicTitle,'Japan');assert.equal(config.cities[0].label,'Tokyo');
  assert.deepEqual(config.stays[0].dayIds,[1]);assert.equal(config.schedule[0].assignmentId,10);
  action('Add city');
  assert.equal(editor.state.schedule[0].selected,true);
  assert.equal(editor.state.days[0].cityId,'city-1');
  assert.ok(changes>=7);
});
