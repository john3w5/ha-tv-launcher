import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const connectEvents=app.match(/^function connectEvents\(\)\{.*\}$/m)?.[0];
assert.ok(connectEvents,'Test the actual application SSE handler');

function fixture({hidden=false,saver=false}={}){
 const sources=[],opened=[],notices=[];let saverStops=0,renders=0;
 const document={hidden},state={mode:'live',bootstrap:{authenticated:true},eventsConnected:false,saver,dialog:false,data:{cameras:[{id:'entrance',available:true}]}};
 class EventSource{
  constructor(url){this.url=url;this.listeners=new Map();this.closed=false;sources.push(this);}
  addEventListener(type,callback){this.listeners.set(type,callback);}
  close(){this.closed=true;}
  emit(type,payload){this.listeners.get(type)?.({data:typeof payload==='string'?payload:JSON.stringify(payload)});}
 }
 const status={innerHTML:''};
 const sandbox={state,document,EventSource,preparedCameras:new Map(),$:()=>status,homeStrip:()=>'',render(){renders++;},
  stopSaver(){saverStops++;state.saver=false;},openCamera:id=>opened.push(id),notify:notice=>notices.push(notice),removeNotice(){},playMedia(){},location:{reload(){}}};
 vm.runInNewContext(connectEvents,sandbox,{filename:'actual-app-connectEvents.js'});sandbox.connectEvents();
 return{ui:sandbox,state,document,sources,source:sources[0],opened,notices,get saverStops(){return saverStops;},get renders(){return renders;}};
}

test('a foreground doorbell opens the known camera and emits its exempt notice',()=>{
 const h=fixture({saver:true});h.source.emit('doorbell',{cameraId:'entrance',id:'bell-1',title:'Vchod',message:'Někdo zvoní'});
 assert.deepEqual(h.opened,['entrance']);assert.equal(h.saverStops,1);assert.equal(h.state.saver,false);assert.equal(h.notices.length,1);
 assert.equal(h.notices[0].id,'bell-1');assert.equal(h.notices[0].eventType,'doorbell');assert.equal(h.notices[0].title,'Vchod');
});

test('a background doorbell never starts a hidden camera, wakes the saver or queues a duplicate web toast',()=>{
 const h=fixture({hidden:true,saver:true});
 for(let i=0;i<5;i++)h.source.emit('doorbell',{cameraId:'entrance',id:'bell-'+i});
 assert.deepEqual(h.opened,[]);assert.deepEqual(h.notices,[]);assert.equal(h.saverStops,0);assert.equal(h.state.saver,true);assert.equal(h.renders,0);
 assert.equal(h.source.closed,false,'Native overlays and the server notice center remain independent of this web-only guard');
 assert.equal(h.state.source,h.source);assert.equal(h.sources.length,1);
});

test('returning to the foreground does not replay a hidden bell, while a new foreground bell works normally',()=>{
 const h=fixture({hidden:true});h.source.emit('doorbell',{cameraId:'entrance',id:'hidden'});
 h.document.hidden=false;assert.deepEqual(h.opened,[]);assert.deepEqual(h.notices,[]);
 h.source.emit('doorbell',{cameraId:'entrance',id:'visible'});
 assert.deepEqual(h.opened,['entrance']);assert.equal(h.saverStops,1);assert.equal(h.notices.length,1);assert.equal(h.notices[0].id,'visible');
 assert.equal(h.notices[0].title,'Někdo zvoní');assert.equal(h.notices[0].message,'Pohled z kamery');
});

test('malformed events and unknown cameras cannot start a player in either visibility state',()=>{
 for(const hidden of [false,true]){
  const h=fixture({hidden});
  for(const payload of ['{not-json','null',{}, {cameraId:'unknown'}])assert.doesNotThrow(()=>h.source.emit('doorbell',payload));
  assert.deepEqual(h.opened,[]);assert.deepEqual(h.notices,[]);assert.equal(h.saverStops,0);
 }
});
