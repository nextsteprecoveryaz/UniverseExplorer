'use strict';
const tourNarration={audio:null,serial:0,context:null,pending:false,browserPending:false,started:false,error:false};
function narrationStatus(text){const node=$('#tour-narration-status');if(node)node.textContent=text;}
function narrationEnabled(){return Boolean($('#route-narration')?.checked);}
function resetTourNarration(){
  const n=tourNarration;n.serial++;n.context=null;n.pending=false;n.browserPending=false;n.started=false;n.error=false;
  if(n.audio){n.audio.pause();n.audio.removeAttribute('src');n.audio.load();}window.speechSynthesis?.cancel();
  narrationStatus(narrationEnabled()?'Narration starts when this stop comes into view.':'Turn on narration to hear this guide.');
}
function pauseTourNarration(){tourNarration.audio?.pause();window.speechSynthesis?.pause();}
function tourNarrationPending(){
  const n=tourNarration;return narrationEnabled()&&!n.error&&(n.pending||n.browserPending||Boolean(n.started&&n.audio&&!n.audio.ended));
}
async function playNarrationAudio(){
  const n=tourNarration;if(!n.audio?.src||n.audio.ended)return;
  const serial=n.serial;n.started=true;
  n.audio.playbackRate=Number($('#route-play-speed').value)||1;
  try{await n.audio.play();if(serial!==n.serial)return;n.error=false;narrationStatus('Playing OpenAI narration · AI-generated voice');}
  catch{if(serial!==n.serial)return;n.error=true;narrationStatus('Audio needs a click to play. Choose Replay narration.');}
}
function resumeTourNarration(){
  if(!narrationEnabled())return;
  if($('#tour-narration-provider').value==='browser'){window.speechSynthesis?.resume();return;}
  if(tourNarration.started&&!tourNarration.audio?.ended)void playNarrationAudio();
}
async function startTourNarration(replay=false){
  const n=tourNarration,p=routePlayer,route=p.route,index=p.index;
  if(!narrationEnabled()||!route||route.kind==='recording'||index<0)return;
  const provider=$('#tour-narration-provider').value,voice=$('#tour-narration-voice').value;
  const text=narrationFor(route.media[index],route.stops[index]);if(!text)return;
  const context=[route.id,route.revision,index,provider,voice,text].join('|');
  if(n.context===context&&!replay){if(n.pending||n.error)return;if(provider==='openai'&&n.audio?.src&&!n.audio.ended&&p.playing)await playNarrationAudio();return;}
  resetTourNarration();n.context=context;const serial=n.serial;
  const current=()=>serial===n.serial&&routePlayer.route===route&&routePlayer.index===index&&narrationEnabled();
  if(provider==='browser'){
    if(!window.speechSynthesis){n.error=true;narrationStatus('Browser narration is unavailable. Choose OpenAI voice.');return;}
    const speech=new SpeechSynthesisUtterance(text);speech.rate=Math.min(1.6,Number($('#route-play-speed').value)||1);
    n.browserPending=true;speech.onend=()=>{if(current()){n.browserPending=false;narrationStatus('Narration complete');}};
    speech.onerror=()=>{if(current()){n.browserPending=false;n.error=true;narrationStatus('Browser narration stopped. Choose Replay narration to retry.');}};
    window.speechSynthesis.resume();window.speechSynthesis.speak(speech);narrationStatus('Playing browser narration');return;
  }
  n.pending=true;narrationStatus('Preparing OpenAI narration…');
  try{
    const clip=await jsonPost('/api/narration/clip',{text,voice});if(!current())return;
    n.audio.src=clip.url;n.audio.load();n.pending=false;
    narrationStatus(clip.cached?'Saved narration ready · AI-generated voice':'Narration saved on this PC · AI-generated voice');
    if(p.playing||replay)await playNarrationAudio();
  }catch(error){if(current()){n.pending=false;n.error=true;narrationStatus(error.message+' Choose Replay narration to retry.');}}
}
function initTourNarration(){
  const controls=document.createElement('details');controls.className='tour-narration-controls';
  controls.innerHTML=`<summary>Voice options</summary><div class="tour-narration-fields"><label>Narrator<select id="tour-narration-provider"><option value="openai">OpenAI voice</option><option value="browser">Browser voice</option></select></label><label>Voice<select id="tour-narration-voice"><option value="cedar">Cedar</option><option value="marin">Marin</option><option value="coral">Coral</option></select></label></div><p class="tour-narration-note">AI-generated voice. OpenAI receives the guide text and bills new audio to your API account. Replays use audio saved on this PC.</p><div class="tour-narration-actions"><button id="tour-narration-replay" class="text-button">Replay narration</button><button id="tour-narration-connect" class="text-button">OpenAI connection</button></div><audio id="tour-narration-audio" preload="metadata"></audio>`;
  $('#route-stop-actions').before(controls);
  const message=document.createElement('p');message.id='tour-narration-status';message.setAttribute('role','status');controls.after(message);
  $('#route-narration').parentElement.lastChild.textContent=' Voice narration';
  const n=tourNarration;n.audio=$('#tour-narration-audio');
  n.audio.onended=()=>{n.started=false;narrationStatus('Narration complete · saved on this PC');};
  n.audio.onerror=()=>{if(n.audio.getAttribute('src')){n.error=true;n.started=false;narrationStatus('Audio could not play. Choose Replay narration to retry.');}};
  $('#route-narration').onchange=()=>{resetTourNarration();if(narrationEnabled()&&routePlayer.playing)void startTourNarration();};
  const settingsChanged=()=>{resetTourNarration();$('#tour-narration-voice').disabled=$('#tour-narration-provider').value!=='openai';if(narrationEnabled()&&routePlayer.playing)void startTourNarration();};
  $('#tour-narration-provider').onchange=settingsChanged;$('#tour-narration-voice').onchange=settingsChanged;
  $('#tour-narration-replay').onclick=()=>{$('#route-narration').checked=true;void startTourNarration(true);};
  $('#tour-narration-connect').onclick=()=>openCloudConnection('speech').catch(failure);
  $('#route-play-speed').addEventListener('change',()=>{n.audio.playbackRate=Number($('#route-play-speed').value)||1;});
  narrationStatus('OpenAI reads the guide text. New audio uses your API account; replay is cached.');
}
