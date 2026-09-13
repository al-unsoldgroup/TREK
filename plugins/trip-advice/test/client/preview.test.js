'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Preview=require('../../client/advice-preview');
test('private preview never writes feedback or searches a provider',async()=>{
 const projection={stays:[],shortlists:[]};const bridge=Preview.bridge(projection,()=>assert.fail('unexpected navigation'));
 assert.equal((await bridge.action({kind:'read'})).projection,projection);
 for(const kind of ['vote.set','comment.create','places.autocomplete','places.resolve','suggestion.create','session.erase'])await assert.rejects(bridge.action({kind}),/Preview only/);
 assert.equal(await bridge.photoAsset('anything'),null);
});
test('preview can only open Maps URLs from its owner-authorized projection',()=>{
 const url='https://www.google.com/maps/search/?api=1&query=Test';const opened=[];
 const bridge=Preview.bridge({stays:[],shortlists:[{see:[{key:'p:1',mapsUrl:url}],eat:[]}]},v=>opened.push(v));
 bridge.openMaps('foreign');assert.deepEqual(opened,[]);bridge.openMaps('p:1');assert.deepEqual(opened,[url]);
});
test('preview markup is the actual guest page without its boot scripts',()=>{
 const context=vm.createContext({});vm.runInContext(fs.readFileSync('client/advice-guest-template.js','utf8'),context);
 const expected=fs.readFileSync('client/guest.html','utf8').match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').trim();
 assert.equal(context.TrekAdviceGuestMarkup,expected);assert.ok(!expected.includes('<script'));
});
