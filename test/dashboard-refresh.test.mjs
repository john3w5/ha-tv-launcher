import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function declaration(name){
 const match=new RegExp('^(?:async )?function '+name+'\\s*\\(','m').exec(source);assert.ok(match,'Actual app declaration: '+name);
 const start=match.index,body=source.indexOf('{',start);let depth=0,quote='',comment='';
 for(let i=body;i<source.length;i++){
  const c=source[i],next=source[i+1];
  if(comment==='//'){if(c==='\n')comment='';continue;}
  if(comment==='/*'){if(c==='*'&&next==='/'){comment='';i++;}continue;}
  if(quote){if(c==='\\')i++;else if(c===quote)quote='';continue;}
  if(c==='/'&&(next==='/'||next==='*')){comment='/'+next;i++;continue;}
  if(['"',"'",'`'].includes(c)){quote=c;continue;}
  if(c==='{')depth++;if(c==='}'&&--depth===0)return source.slice(start,i+1);
 }
 throw Error('Unterminated declaration: '+name);
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture(){
 const requests=[],signals=[],notices=[],commits=[];let renders=0,badges=0,reconnects=0,closed=0,preferences=0;
 const state={mode:'live',bootstrap:{authenticated:true},data:{marker:'initial'},eventsConnected:true,failures:0,dialog:false,saver:false,source:{close(){closed++;}}};
 const status={innerHTML:''},document={activeElement:{dataset:{}}};
 const sandbox={state,document,AbortSignal:{timeout(ms){const signal={milliseconds:ms};signals.push(signal);return signal;}},
  fetch(url,options){const pending=deferred();requests.push({url,options,...pending});return pending.promise;},
  normalize:value=>value,unavailableData:mode=>({mode:mode||'setup',unavailable:true}),applyAppearance(){commits.push(state.data.marker);},render(){renders++;},updateBadges(){badges++;},connectEvents(){reconnects++;},configureNoticePreferences(){preferences++;},
  showHouse(){},homeStrip:()=>'<p>state</p>',notify:notice=>notices.push(notice),$:(selector)=>selector==='#saver-status'?status:null,$$:()=>[]};
 vm.runInNewContext('let refreshingDashboard=null;\n'+['refresh','refreshNow'].map(declaration).join('\n'),sandbox);
 const success=(index,data)=>requests[index].resolve({ok:true,status:200,json:async()=>data});
 return{ui:sandbox,state,requests,signals,notices,commits,success,get renders(){return renders;},get badges(){return badges;},get reconnects(){return reconnects;},get closed(){return closed;},get preferences(){return preferences;}};
}

test('simultaneous interval/manual refreshes share the exact promise and only one bounded dashboard request',async()=>{
 const h=fixture(),first=h.ui.refresh(),second=h.ui.refresh();
 assert.equal(first,second);assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/api/dashboard');assert.equal(h.requests[0].options.signal,h.signals[0]);assert.equal(h.signals[0].milliseconds,35000);
 h.success(0,{mode:'live',marker:'first'});await first;
 assert.equal(h.renders,1);assert.deepEqual(h.commits,['first']);assert.equal(h.state.data.marker,'first');
 const next=h.ui.refresh();assert.notEqual(next,first);assert.equal(h.requests.length,2);h.success(1,{mode:'live',marker:'second'});await next;
 assert.equal(h.renders,2);assert.equal(h.state.data.marker,'second');assert.equal(h.state.failures,0);
});

test('single flight includes asynchronous JSON decoding so a second response cannot overtake an older pending body',async()=>{
 const h=fixture(),body=deferred(),first=h.ui.refresh();
 h.requests[0].resolve({ok:true,status:200,json:()=>body.promise});await Promise.resolve();
 for(let i=0;i<8;i++)assert.equal(h.ui.refresh(),first);
 assert.equal(h.requests.length,1);assert.equal(h.state.data.marker,'initial');
 body.resolve({mode:'live',marker:'decoded'});await first;
 assert.deepEqual(h.commits,['decoded']);assert.equal(h.renders,1);
 const later=h.ui.refresh();h.success(1,{mode:'live',marker:'newest'});await later;assert.deepEqual(h.commits,['decoded','newest']);assert.equal(h.state.data.marker,'newest');
});

test('network failure clears the flight and a later successful refresh restores live data and reconnects once',async()=>{
 const h=fixture(),first=h.ui.refresh();h.requests[0].reject(Error('Network detail'));await first;
 assert.equal(h.state.mode,'offline');assert.equal(h.state.data.unavailable,true);assert.equal(h.state.eventsConnected,false);assert.equal(h.state.failures,1);assert.equal(h.notices.length,1);
 const next=h.ui.refresh();assert.notEqual(next,first);assert.equal(h.requests.length,2);h.success(1,{mode:'live',marker:'recovered'});await next;
 assert.equal(h.state.mode,'live');assert.equal(h.state.data.marker,'recovered');assert.equal(h.state.failures,0);assert.equal(h.reconnects,1);
});

test('bad HTTP status and invalid JSON each release the flight without preserving fabricated live values',async()=>{
 const h=fixture();let request=h.ui.refresh();h.requests[0].resolve({ok:false,status:503});await request;
 assert.equal(h.state.mode,'offline');assert.equal(h.state.data.marker,undefined);
 request=h.ui.refresh();h.requests[1].resolve({ok:true,status:200,json:async()=>{throw Error('Malformed body');}});await request;
 assert.equal(h.state.failures,2);assert.equal(h.notices.length,1);
 request=h.ui.refresh();h.success(2,{mode:'live',marker:'good'});await request;assert.equal(h.state.data.marker,'good');
});

test('a401 closes events and disables authenticated preferences before the flight is released',async()=>{
 const h=fixture(),first=h.ui.refresh();h.requests[0].resolve({ok:false,status:401});await first;
 assert.equal(h.state.mode,'setup');assert.equal(h.state.bootstrap.authenticated,false);assert.equal(h.state.eventsConnected,false);assert.equal(h.preferences,1);assert.equal(h.closed,1);assert.equal(h.state.data.unavailable,true);
 const next=h.ui.refresh();assert.notEqual(next,first);assert.equal(h.requests.length,2);h.requests[1].resolve({ok:false,status:401});await next;
 assert.equal(h.closed,2);assert.equal(h.notices.length,0);
});
