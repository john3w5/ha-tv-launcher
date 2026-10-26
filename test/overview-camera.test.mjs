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
async function settle(){await Promise.resolve();await Promise.resolve();}
function fixture(){
 const players=[],timers=new Map();let timerId=0;
 const badge={innerHTML:'<i></i>Snímek'},card={dataset:{},removeAttribute(name){if(name==='data-live')delete this.dataset.live;},querySelector:()=>badge};
 const classes=new Set(),video={videoWidth:640,plays:0,classList:{add:key=>classes.add(key),remove:key=>classes.delete(key),contains:key=>classes.has(key)},closest:()=>card,play(){this.plays++;return Promise.resolve();}};
 const state={tab:'home',mode:'live',dialog:false,saver:false,data:{cameras:[{id:'entrance',available:true}]}};
 const document={hidden:false};
 class Player{
  constructor(options){this.options=options;this.pending=deferred();this.destroyed=0;players.push(this);}
  start(){return this.pending.promise;}
  destroy(){this.destroyed++;}
 }
 const sandbox={state,document,HomeTVCamera:{CameraPlayer:Player},$:(selector)=>selector==='#overview-camera-video'?sandbox.video:selector==='.status-tag'?badge:null,video,
  setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext('let overviewPlayer=null,overviewVideo=null,overviewReconnectTimer=null,overviewStarting=false,overviewGeneration=0;\n'+['stopOverviewCamera','syncOverviewCamera'].map(declaration).join('\n')+'\nglobalThis.inspect=()=>({player:overviewPlayer,video:overviewVideo,timer:overviewReconnectTimer,starting:overviewStarting,generation:overviewGeneration});',sandbox);
 return{ui:sandbox,state,document,video,card,badge,players,timers,classes,runTimer(){const [id,timer]=[...timers][0]||[];assert.ok(timer,'Expected scheduled reconnect');timers.delete(id);timer.fn();}};
}

test('overview reuses its active player and stop releases it, live badge and reconnect state',()=>{
 const h=fixture();h.ui.syncOverviewCamera();const player=h.players[0];
 assert.equal(player.options.cameraId,'entrance');assert.equal(player.options.quality,'smooth');assert.equal(h.ui.inspect().starting,true);
 h.ui.syncOverviewCamera();assert.equal(h.players.length,1);assert.equal(h.video.plays,1);assert.equal(player.destroyed,0);
 h.video.onplaying();assert.equal(h.card.dataset.live,'true');assert.equal(h.classes.has('has-frame'),true);assert.match(h.badge.innerHTML,/Živě/);
 h.ui.stopOverviewCamera();assert.equal(player.destroyed,1);assert.equal(h.ui.inspect().player,null);assert.equal(h.ui.inspect().video,null);assert.equal(h.ui.inspect().starting,false);
 assert.equal(h.card.dataset.live,undefined);assert.equal(h.classes.has('has-frame'),false);assert.match(h.badge.innerHTML,/Snímek/);assert.equal(h.timers.size,0);
});

test('a rejected old start and old onError cannot destroy a reopened player using the same video element',async()=>{
 const h=fixture();h.ui.syncOverviewCamera();const old=h.players[0];
 h.state.dialog=true;h.ui.syncOverviewCamera();assert.equal(old.destroyed,1);
 h.state.dialog=false;h.ui.syncOverviewCamera();const current=h.players[1];assert.equal(current.options.video,old.options.video);
 old.options.onError(Error('Late old stream error'));old.pending.reject(Error('Aborted old request'));await settle();
 assert.equal(h.ui.inspect().player,current);assert.equal(current.destroyed,0);assert.equal(h.ui.inspect().starting,true);assert.equal(h.timers.size,0);
 h.video.onplaying();assert.equal(h.card.dataset.live,'true');h.ui.stopOverviewCamera();
});

test('dialog, saver, hidden page, nonhome tab and unavailable camera each stop overview until reopening',()=>{
 const blockers=[h=>{h.state.dialog=true;},h=>{h.state.saver=true;},h=>{h.document.hidden=true;},h=>{h.state.tab='calendar';},h=>{h.state.mode='offline';},h=>{h.state.data.cameras[0].available=false;},h=>{h.ui.video=null;}];
 for(const block of blockers){
  const h=fixture();h.ui.syncOverviewCamera();const old=h.players[0],latePlaying=h.video.onplaying;block(h);h.ui.syncOverviewCamera();
  assert.equal(old.destroyed,1);assert.equal(h.ui.inspect().player,null);assert.equal(h.timers.size,0);latePlaying();assert.equal(h.card.dataset.live,undefined);
  h.state.dialog=false;h.state.saver=false;h.document.hidden=false;h.state.tab='home';h.state.mode='live';h.state.data.cameras[0].available=true;h.ui.video=h.video;
  h.ui.syncOverviewCamera();assert.equal(h.players.length,2);assert.equal(h.players[1].destroyed,0);h.ui.stopOverviewCamera();
 }
});

test('current failure schedules a bounded reconnect and closing cancels it before any new connection',()=>{
 const h=fixture();h.ui.syncOverviewCamera();const player=h.players[0];player.options.onError(Error('Disconnected'));
 assert.equal(player.destroyed,1);assert.equal(h.ui.inspect().player,null);assert.equal(h.timers.size,1);assert.equal([...h.timers.values()][0].delay,12000);
 h.ui.stopOverviewCamera();assert.equal(h.timers.size,0);assert.equal(h.players.length,1);
 h.ui.syncOverviewCamera();h.players[1].options.onError(Error('Disconnected'));h.runTimer();assert.equal(h.players.length,3);assert.equal(h.ui.inspect().player,h.players[2]);h.ui.stopOverviewCamera();
});

test('onError followed by rejection of the same start leaves only one reconnect that closing can cancel',async()=>{
 const h=fixture();h.ui.syncOverviewCamera();const player=h.players[0];
 player.options.onError(Error('Timeout aborts pending fetch'));player.pending.reject(Error('AbortError'));await settle();
 assert.equal(h.timers.size,1,'A single failed attempt must not leave a second orphan reconnect');
 h.state.dialog=true;h.ui.syncOverviewCamera();assert.equal(h.timers.size,0);assert.equal(h.players.length,1);
});

test('a retained onplaying callback from the previous generation cannot announce a fresh player as live',()=>{
 const h=fixture();h.ui.syncOverviewCamera();const oldPlaying=h.video.onplaying;
 h.ui.stopOverviewCamera();h.ui.syncOverviewCamera();oldPlaying();
 assert.equal(h.card.dataset.live,undefined);assert.equal(h.classes.has('has-frame'),false);assert.equal(h.ui.inspect().starting,true);
 h.video.onplaying();assert.equal(h.card.dataset.live,'true');h.ui.stopOverviewCamera();
});
