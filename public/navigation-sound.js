/* Original synthesized navigation ticks; no recorded or official Apple audio asset. */
(function(root){
 'use strict';
 let enabled=true,context=null,pending=null,generation=0,lastAttempt=-Infinity,lastError=null;
 const nodes=new Set();
 const Constructor=()=>root.AudioContext||root.webkitAudioContext;
 const now=()=>typeof root.performance?.now==='function'?root.performance.now():Date.now();
 function cleanup(entry,stop=false){
  if(!entry||entry.cleaned)return;entry.cleaned=true;
  if(stop)try{entry.oscillator?.stop();}catch{}
  try{entry.oscillator?.disconnect();}catch{}
  try{entry.gain?.disconnect();}catch{}
  nodes.delete(entry);
 }
 function release(){
  generation++;pending=null;lastAttempt=-Infinity;
  for(const entry of [...nodes])cleanup(entry,true);
  const old=context;context=null;
  if(old&&old.state!=='closed')try{Promise.resolve(old.close()).catch(()=>{});}catch{}
 }
 function getState(){
  const supported=typeof Constructor()==='function';
  return Object.freeze({enabled,supported,ready:Boolean(enabled&&!lastError&&context?.state==='running'),
   status:!enabled?'disabled':!supported?'unsupported':lastError||context?.state||'idle',activeNodes:nodes.size});
 }
 function configure(options={}){
  if(typeof options.enabled==='boolean'&&options.enabled!==enabled){enabled=options.enabled;if(!enabled)release();lastError=null;}
  return getState();
 }
 // The caller invokes play only from an actual user key/click. No startup unlock or event listeners.
 async function play(kind){
  if(!enabled||!['move','select'].includes(kind)||typeof Constructor()!=='function')return false;
  const time=now(),elapsed=time-lastAttempt;
  if((elapsed>=0&&elapsed<60)||pending)return false;
  lastAttempt=time;
  const attempt={generation};pending=attempt;
  let entry;
  try{
   if(!context||context.state==='closed')context=new (Constructor())({latencyHint:'interactive'});
   const current=context;
   if(current.state!=='running'){
    await current.resume();
    if(!enabled||context!==current||attempt.generation!==generation)return false;
    if(current.state!=='running'){lastError='blocked';return false;}
   }
   if(!enabled||context!==current||attempt.generation!==generation||now()-time>80)return false;
   const at=current.currentTime,duration=kind==='move'?.027:.042;
   entry={oscillator:current.createOscillator(),gain:null,cleaned:false};
   entry.gain=current.createGain();nodes.add(entry);
   entry.oscillator.type='sine';
   entry.oscillator.frequency.setValueAtTime(kind==='move'?900:1100,at);
   entry.oscillator.frequency.exponentialRampToValueAtTime(kind==='move'?600:750,at+duration);
   entry.gain.gain.setValueAtTime(0,at);
   entry.gain.gain.linearRampToValueAtTime(.03,at+.004);
   entry.gain.gain.exponentialRampToValueAtTime(.0001,at+duration-.002);
   entry.gain.gain.setValueAtTime(0,at+duration);
   entry.oscillator.connect(entry.gain);entry.gain.connect(current.destination);
   entry.oscillator.onended=()=>cleanup(entry);
   entry.oscillator.start(at);entry.oscillator.stop(at+duration+.002);
   lastError=null;
   return true; // Scheduled locally; this cannot prove that the television was audible.
  }catch{
   cleanup(entry,true);
   if(enabled&&attempt.generation===generation)lastError=context?'blocked':'unavailable';
   return false;
  }finally{if(pending===attempt)pending=null;}
 }
 function destroy(){enabled=false;release();lastError=null;return getState();}
 root.NavigationSound=Object.freeze({configure,play,getState,destroy});
})(globalThis);
