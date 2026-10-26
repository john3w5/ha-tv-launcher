import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../public/navigation-sound.js',import.meta.url),'utf8');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture(options={}){
 let time=1000;const contexts=[];
 class Param{constructor(){this.events=[];}setValueAtTime(value,at){this.events.push(['set',value,at]);}linearRampToValueAtTime(value,at){this.events.push(['linear',value,at]);}exponentialRampToValueAtTime(value,at){this.events.push(['exponential',value,at]);}}
 class FakeContext{
  constructor(configuration){if(options.constructError)throw Error('device detail');this.configuration=configuration;this.state=options.state||'running';this.currentTime=4;this.destination={destination:true};this.oscillators=[];this.gains=[];this.resumes=0;this.closes=0;contexts.push(this);}
  async resume(){this.resumes++;if(options.resume)return options.resume(this);this.state='running';}
  close(){this.closes++;this.state='closed';return options.close?options.close():Promise.resolve();}
  createOscillator(){const node={frequency:new Param(),starts:[],stops:[],disconnects:0,connect(target){this.target=target;},start(at){this.starts.push(at);},stop(at){this.stops.push(at);},disconnect(){this.disconnects++;},finish(){this.onended?.();}};this.oscillators.push(node);return node;}
  createGain(){if(options.gainError)throw Error('gain detail');const node={gain:new Param(),disconnects:0,connect(target){this.target=target;},disconnect(){this.disconnects++;}};this.gains.push(node);return node;}
 }
 const sandbox={performance:{now:()=>time},...(options.unsupported?{}:options.legacy?{webkitAudioContext:FakeContext}:{AudioContext:FakeContext})};
 vm.runInNewContext(source,sandbox,{filename:'navigation-sound.js'});
 return{api:sandbox.NavigationSound,contexts,advance:ms=>{time+=ms;}};
}

test('navigation sound is enabled by default but startup/configuration/getState never create audio',()=>{
 const f=fixture();assert.equal(f.api.getState().enabled,true);assert.equal(f.api.getState().ready,false);assert.equal(f.api.getState().status,'idle');
 f.api.configure({enabled:true});f.api.configure({enabled:'invalid'});assert.equal(f.contexts.length,0);
});

test('move and select are original short sine envelopes with a quiet bounded gain and no overlapping repeat storm',async()=>{
 const f=fixture();assert.equal(await f.api.play('move'),true);const c=f.contexts[0],move=c.oscillators[0];
 assert.equal(move.type,'sine');assert.equal(move.starts[0],4);assert.ok(move.stops[0]-move.starts[0]>=.025&&move.stops[0]-move.starts[0]<=.05);
 assert.equal(Math.max(...c.gains[0].gain.events.map(event=>event[1])),.03);assert.equal(c.gains[0].gain.events[0][1],0);assert.equal(c.gains[0].gain.events.at(-1)[1],0);
 for(let i=0;i<20;i++)assert.equal(await f.api.play('move'),false);assert.equal(c.oscillators.length,1);
 f.advance(59);assert.equal(await f.api.play('select'),false);f.advance(1);assert.equal(await f.api.play('select'),true);
 const select=c.oscillators[1];assert.ok(select.stops[0]-select.starts[0]>.04&&select.stops[0]-select.starts[0]<.05);assert.notDeepEqual(select.frequency.events,move.frequency.events);assert.equal(f.contexts.length,1);
 move.finish();select.finish();assert.equal(f.api.getState().activeNodes,0);assert.equal(move.disconnects,1);assert.equal(c.gains[0].disconnects,1);f.api.destroy();
});

test('a suspended context resumes only inside play and no oscillator is scheduled before successful resume',async()=>{
 const pending=deferred(),f=fixture({state:'suspended',resume:async c=>{await pending.promise;c.state='running';}});
 const playing=f.api.play('move');assert.equal(f.contexts.length,1);assert.equal(f.contexts[0].resumes,1);assert.equal(f.contexts[0].oscillators.length,0);assert.equal(f.api.getState().ready,false);
 f.advance(60);assert.equal(await f.api.play('select'),false);assert.equal(f.contexts[0].resumes,1);
 pending.resolve();assert.equal(await playing,true);assert.equal(f.contexts[0].oscillators.length,1);f.api.destroy();
});

test('resume taking more than80ms drops the stale key without creating nodes or replaying a backlog',async()=>{
 const pending=deferred(),f=fixture({state:'suspended',resume:async c=>{await pending.promise;c.state='running';}});
 const playing=f.api.play('move');f.advance(81);
 for(let i=0;i<10;i++)assert.equal(await f.api.play('select'),false);
 pending.resolve();assert.equal(await playing,false);
 const c=f.contexts[0];assert.equal(c.oscillators.length,0);assert.equal(c.gains.length,0);assert.equal(f.api.getState().activeNodes,0);
 assert.equal(await f.api.play('select'),true,'A new current key may play immediately after the stale attempt is discarded');
 assert.equal(c.resumes,1);assert.equal(c.oscillators.length,1);f.api.destroy();
});

test('a resume completing at the80ms freshness boundary is still allowed',async()=>{
 const pending=deferred(),f=fixture({state:'suspended',resume:async c=>{await pending.promise;c.state='running';}});
 const playing=f.api.play('move');f.advance(80);pending.resolve();
 assert.equal(await playing,true);assert.equal(f.contexts[0].oscillators.length,1);f.api.destroy();
});

test('resume rejection or a still-suspended context fails silently without optimistic success',async()=>{
 for(const resume of [async()=>{throw Error('private autoplay reason');},async()=>{},async c=>{c.state='running';throw Error('late resume error');}]){
  const f=fixture({state:'suspended',resume});assert.equal(await f.api.play('select'),false);assert.equal(f.api.getState().ready,false);assert.equal(f.api.getState().status,'blocked');assert.equal(f.contexts[0].oscillators.length,0);
  assert.ok(!JSON.stringify(f.api.getState()).includes('private'));f.api.destroy();
 }
});

test('turning sound off closes its context, stops active nodes and a late resume cannot emit audio',async()=>{
 const pending=deferred(),f=fixture({state:'suspended',resume:async c=>{await pending.promise;c.state='running';}}),playing=f.api.play('move');
 f.api.configure({enabled:false});assert.equal(f.contexts[0].closes,1);pending.resolve();assert.equal(await playing,false);assert.equal(f.contexts[0].oscillators.length,0);
 assert.equal(await f.api.play('move'),false);assert.equal(f.api.getState().enabled,false);
 const active=fixture();await active.api.play('select');const node=active.contexts[0].oscillators[0];active.api.configure({enabled:false});
 assert.equal(node.stops.length,2);assert.equal(node.disconnects,1);assert.equal(active.api.getState().activeNodes,0);assert.equal(active.contexts[0].closes,1);
 active.api.destroy();assert.equal(active.contexts[0].closes,1);
});

test('reenabling is lazy and uses a fresh context after the previous one was closed',async()=>{
 const f=fixture();await f.api.play('move');f.api.configure({enabled:false});f.api.configure({enabled:true});assert.equal(f.contexts.length,1);
 assert.equal(await f.api.play('select'),true);assert.equal(f.contexts.length,2);assert.equal(f.contexts[0].closes,1);f.api.destroy();assert.equal(f.contexts[1].closes,1);
});

test('unsupported APIs, unknown sound kinds and partial synthesis failures do not leak nodes or throw',async()=>{
 const unsupported=fixture({unsupported:true});assert.equal(await unsupported.api.play('move'),false);assert.equal(unsupported.api.getState().supported,false);
 const invalid=fixture();assert.equal(await invalid.api.play('startup'),false);assert.equal(invalid.contexts.length,0);
 const failed=fixture({gainError:true});assert.equal(await failed.api.play('move'),false);assert.equal(failed.contexts[0].oscillators[0].disconnects,1);assert.equal(failed.api.getState().activeNodes,0);failed.api.destroy();
 const unavailable=fixture({constructError:true});assert.equal(await unavailable.api.play('select'),false);assert.equal(unavailable.api.getState().status,'unavailable');
});

test('legacy constructor works without network, microphone, timers or automatic event registration',async()=>{
 const f=fixture({legacy:true});assert.equal(await f.api.play('move'),true);assert.equal(f.contexts.length,1);f.api.destroy();
});
