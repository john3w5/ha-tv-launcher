/* Receive-only WebRTC over the authenticated household bridge. */
(function(root){
'use strict';
class CameraPlayer {
 constructor({video,cameraId,quality='smooth',onStatus=()=>{},onError=()=>{}}){
  if(!video||!/^[a-z0-9_-]{1,80}$/.test(cameraId)||!['smooth','hd'].includes(quality))throw Error('Invalid camera');
  Object.assign(this,{video,cameraId,quality,onStatus,onError,closed:false,sessionId:null,pc:null,events:null,timer:null,failed:false,controller:new AbortController(),offerSent:false,pendingCandidates:[],startPromise:null,stream:null,watchTimer:null,frameCallback:null,hasFrame:false,watchSuspended:false,receiveBufferTargetMs:null});
 }
 start(){
  if(this.closed||this.failed)return Promise.resolve();
  if(!this.startPromise)this.startPromise=this.connect().catch(error=>{if(!this.closed)this.destroy();throw error;});
  return this.startPromise;
 }
 async connect(){
  if(typeof root.RTCPeerConnection!=='function')throw Error('WebRTC není dostupné.');
  this.timer=setTimeout(()=>this.fail('Připojení kamery trvá příliš dlouho.'),15000);
  const pc=this.pc=new root.RTCPeerConnection({iceServers:[]});
  const transceiver=pc.addTransceiver('video',{direction:'recvonly'});this.setReceiveBuffer(transceiver?.receiver);
  pc.ontrack=event=>{if(this.closed||this.failed)return;this.setReceiveBuffer(event.receiver);this.stream=event.streams?.[0]||new root.MediaStream([event.track]);this.video.srcObject=this.stream;this.watchFrames();this.video.play().catch(()=>{});};
  pc.onicecandidate=event=>{if(this.closed||!event.candidate)return;const candidate=event.candidate.toJSON?event.candidate.toJSON():event.candidate;if(this.sessionId)this.postCandidate(candidate);else if(this.offerSent)this.pendingCandidates.push(candidate);};
  pc.onconnectionstatechange=()=>{
   if(this.closed)return;
   if(pc.connectionState==='connected'){clearTimeout(this.timer);this.watchFrames();this.onStatus('connected');}
   else if(pc.connectionState==='failed')this.fail('Spojení kamery se přerušilo.');
   else if(pc.connectionState==='disconnected'){clearTimeout(this.timer);this.timer=setTimeout(()=>this.fail('Spojení kamery se přerušilo.'),5000);}
  };
  const offer=await pc.createOffer();
  if(this.closed||this.failed)return;
  await pc.setLocalDescription(offer);
  if(this.closed||this.failed)return;
  if(pc.iceGatheringState!=='complete')await new Promise(resolve=>{
   const finish=()=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',changed);if(this.gatherCleanup===finish)this.gatherCleanup=null;resolve();};
   const changed=()=>{if(pc.iceGatheringState==='complete'||this.closed)finish();};
   const timer=setTimeout(finish,1500);pc.addEventListener('icegatheringstatechange',changed);this.gatherCleanup=finish;
  });
  if(this.closed||this.failed)return;
  this.onStatus('connecting');
  this.offerSent=true;
  const response=await fetch(`/api/cameras/${encodeURIComponent(this.cameraId)}/webrtc`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offer:pc.localDescription.sdp,quality:this.quality}),signal:this.controller.signal});
  const result=await response.json();
  if(!response.ok||typeof result.answer!=='string'||result.answer.length>262144||!/^[A-Za-z0-9_-]{16,128}$/.test(result.sessionId||''))throw Error('WebRTC není dostupné.');
  this.sessionId=result.sessionId;
  if(this.closed||this.failed){this.deleteSession();return;}
  await pc.setRemoteDescription({type:'answer',sdp:result.answer});
  if(this.closed||this.failed)return;
  for(const candidate of this.pendingCandidates.splice(0))this.postCandidate(candidate);
  if(this.closed)return;
  for(const candidate of (Array.isArray(result.candidates)?result.candidates:[]).slice(0,256)){if(this.closed||this.failed)return;await pc.addIceCandidate(candidate).catch(()=>{});}
  if(this.closed||this.failed)return;
  this.events=new root.EventSource(`/api/webrtc/${this.sessionId}/events`);
  this.events.addEventListener('candidate',event=>{try{const value=JSON.parse(event.data);const candidate=typeof value.candidate==='object'?value.candidate:value;if(!this.closed&&typeof candidate.candidate==='string')pc.addIceCandidate(candidate).catch(()=>{});}catch{}});
  this.events.addEventListener('closed',()=>this.fail('Spojení kamery skončilo.'));
  clearTimeout(this.timer);
  if(pc.connectionState!=='connected')this.timer=setTimeout(()=>{if(pc.connectionState!=='connected')this.fail('Kamera neodpověděla včas.');},12000);
  return result;
 }
 setReceiveBuffer(receiver){
  if(this.closed||!receiver||typeof receiver!=='object')return;
  // Standard receiver preference in milliseconds, not a claim about actual measured latency.
  try{if(receiver.track?.kind!=='video'||!('jitterBufferTarget'in receiver))return;receiver.jitterBufferTarget=1000;this.receiveBufferTargetMs=receiver.jitterBufferTarget===1000?1000:null;}catch{}
 }
 now(){return typeof root.performance?.now==='function'?root.performance.now():Date.now();}
 watchFrames(){
  if(this.watchTimer!==null||this.closed)return;
  this.watchStartedAt=this.lastFrameAt=this.now();
  this.lastProgress=this.progress();
  const reset=()=>{this.watchStartedAt=this.lastFrameAt=this.now();this.lastProgress=this.progress();};
  this.visibilityListener=reset;root.document?.addEventListener?.('visibilitychange',reset);
  this.playingListener=reset;this.video.addEventListener?.('playing',reset);
  const frame=()=>{
   this.frameCallback=null;if(this.closed)return;
   this.frameSeen();
   if(!this.closed&&typeof this.video.requestVideoFrameCallback==='function')this.frameCallback=this.video.requestVideoFrameCallback(frame);
  };
  if(typeof this.video.requestVideoFrameCallback==='function')this.frameCallback=this.video.requestVideoFrameCallback(frame);
  const check=()=>{
   this.watchTimer=null;if(this.closed)return;
   const suspended=Boolean(root.document?.hidden)||(this.hasFrame&&this.video.paused===true);
   if(suspended){this.watchSuspended=true;reset();}
   else{
    if(this.watchSuspended){this.watchSuspended=false;reset();}
    if(typeof this.video.requestVideoFrameCallback!=='function'){
     const progress=this.progress();
     if(progress!==null&&this.lastProgress!==null&&progress>this.lastProgress)this.frameSeen();
     this.lastProgress=progress;
    }
    if(this.closed)return;
    if(!this.hasFrame&&this.now()-this.watchStartedAt>=15000){this.fail('Kamera je připojená, ale neposílá obraz.');return;}
    if(this.hasFrame&&this.now()-this.lastFrameAt>=10000){this.fail('Obraz kamery se zastavil.');return;}
   }
   this.watchTimer=setTimeout(check,1000);
  };
  this.watchTimer=setTimeout(check,1000);
 }
 progress(){
  try{if(typeof this.video.getVideoPlaybackQuality==='function'){const count=this.video.getVideoPlaybackQuality()?.totalVideoFrames;if(Number.isFinite(count))return count;}}catch{}
  if(Number.isFinite(this.video.webkitDecodedFrameCount))return this.video.webkitDecodedFrameCount;
  if(this.video.readyState>=2&&this.video.videoWidth>0&&Number.isFinite(this.video.currentTime))return this.video.currentTime;
  return null;
 }
 frameSeen(){if(this.closed)return;this.lastFrameAt=this.now();if(!this.hasFrame){this.hasFrame=true;this.onStatus('playing');}}
 async postCandidate(candidate){try{await fetch(`/api/webrtc/${this.sessionId}/candidate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({candidate}),signal:this.controller.signal});}catch{}}
 fail(message){if(this.closed||this.failed)return;this.failed=true;this.destroy();this.onError(Error(message));}
 deleteSession(){if(!this.sessionId)return;const id=this.sessionId;this.sessionId=null;fetch(`/api/webrtc/${id}`,{method:'DELETE',keepalive:true}).catch(()=>{});}
 destroy(){if(this.closed)return;this.closed=true;clearTimeout(this.timer);clearTimeout(this.watchTimer);this.watchTimer=null;
  if(this.frameCallback!==null)this.video.cancelVideoFrameCallback?.(this.frameCallback);this.frameCallback=null;
  root.document?.removeEventListener?.('visibilitychange',this.visibilityListener);this.video.removeEventListener?.('playing',this.playingListener);
  this.gatherCleanup?.();this.gatherCleanup=null;this.controller.abort();this.events?.close();this.events=null;this.pc?.close();this.pc=null;
  for(const track of this.stream?.getTracks?.()||[])try{track.stop();}catch{}
  if(this.video&&(!this.video.srcObject||this.video.srcObject===this.stream)){this.video.pause();this.video.srcObject=null;}this.stream=null;this.pendingCandidates=[];this.deleteSession();}
}
root.HomeTVCamera={CameraPlayer};
})(globalThis);
