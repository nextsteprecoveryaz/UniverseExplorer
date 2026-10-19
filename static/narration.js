'use strict';
const tourNarration={audio:null,serial:0,context:null,pending:false,browserPending:false,started:false,error:false};
function preferredNarrator(){try{const value=localStorage.getItem('universe-narrator-v2');if(['elevenlabs','openai','windows','browser'].includes(value))return value;}catch{}return 'elevenlabs';}
function setNarratorPreference(value){try{localStorage.setItem('universe-narrator-v2',value);}catch{}if($('#tour-narration-provider'))$('#tour-narration-provider').value=value;if($('#notebook-tour-voice'))$('#notebook-tour-voice').value=value;}
function narratorName(){return {elevenlabs:'ElevenLabs',windows:'Windows',openai:'OpenAI',browser:'Browser'}[$('#tour-narration-provider').value]||'ElevenLabs';}
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
  try{await n.audio.play();if(serial!==n.serial)return;n.error=false;narrationStatus('Playing '+narratorName()+' narration · saved audio on this PC');}
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
  let text=narrationFor(route.media[index],route.stops[index]);
  const research=typeof tourStoryNeeded==='function'&&tourStoryNeeded(route,index);
  if(!text&&!research)return;
  const survey=typeof tourSkySurvey==='function'?tourSkySurvey():'';
  const contextFor=()=>[route.id,route.revision,index,provider,voice,narrationFor(route.media[index],route.stops[index]),survey].join('|');
  const context=contextFor();
  if(n.context===context&&!replay){if(n.pending||n.error)return;if(provider!=='browser'&&n.audio?.src&&!n.audio.ended&&p.playing)await playNarrationAudio();return;}
  resetTourNarration();n.context=context;const serial=n.serial;
  const current=()=>serial===n.serial&&routePlayer.route===route&&routePlayer.index===index&&narrationEnabled()&&(typeof tourSkySurvey!=='function'||tourSkySurvey()===survey);
  if(research){
    n.pending=true;narrationStatus('OpenAI is researching this object and writing its story… Saved stories are reused.');
    try{
      const story=await prepareTourStory(route,index,replay);if(!current())return;
      applyTourStory(route,index,story);text=story.narration;n.context=contextFor();n.pending=false;
    }catch(error){if(current()){n.pending=false;n.error=true;narrationStatus(error.message+' Use OpenAI story connection or Replay narration.');if(typeof pauseRoute==='function')pauseRoute('Story research needs attention · no archive codes will be narrated.');}return;}
  }
  if(provider==='browser'){
    if(!window.speechSynthesis){n.error=true;narrationStatus('Browser narration is unavailable. Choose Windows local voice or OpenAI voice.');return;}
    const speech=new SpeechSynthesisUtterance(text);speech.rate=Math.min(1.6,Number($('#route-play-speed').value)||1);
    n.browserPending=true;speech.onend=()=>{if(current()){n.browserPending=false;narrationStatus('Narration complete');}};
    speech.onerror=()=>{if(current()){n.browserPending=false;n.error=true;narrationStatus('Browser narration stopped. Choose Replay narration to retry.');}};
    window.speechSynthesis.resume();window.speechSynthesis.speak(speech);narrationStatus('Playing browser narration');return;
  }
  n.pending=true;narrationStatus(provider==='windows'?'Preparing Windows narration on this PC…':'Checking saved '+narratorName()+' narration… New scripts are generated once.');
  try{
    const endpoint={windows:'/api/narration/local/clip',elevenlabs:'/api/narration/elevenlabs/clip',openai:'/api/narration/clip'}[provider];
    const objectGuide=route.stops[index]?.guide?.research_id&&provider==='elevenlabs';
    const clip=await jsonPost(objectGuide?'/api/object-research/clip':endpoint,objectGuide?route.stops[index].guide:provider==='openai'?{text,voice}:{text});if(!current())return;
    n.audio.src=clip.url;n.audio.load();n.pending=false;
    narrationStatus(clip.cached?'Saved '+narratorName()+' narration ready · no generation charge':narratorName()+' narration saved on this PC');
    if(p.playing||replay)await playNarrationAudio();
  }catch(error){if(current()){n.pending=false;n.error=true;narrationStatus(error.message+' Choose Replay narration to retry.');}}
}
function initTourNarration(){
  const controls=document.createElement('details');controls.className='tour-narration-controls';
  controls.innerHTML=`<summary>Voice options</summary><div class="tour-narration-fields"><label>Narrator<select id="tour-narration-provider"><option value="elevenlabs">ElevenLabs · saved voice</option><option value="windows">Windows voice · local</option><option value="browser">Browser voice</option><option value="openai">OpenAI voice</option></select></label><label>Voice<select id="tour-narration-voice"><option value="cedar">Cedar</option><option value="marin">Marin</option><option value="coral">Coral</option></select></label></div><p class="tour-narration-note">ElevenLabs uses your selected voice for every tour, including older saved tours. New scripts use API credits once; completed MP3s are kept on this PC and reused across tours and app restarts. Keep the data/narration-elevenlabs folder in your backups. Changing the text or voice creates new audio.</p><div class="tour-narration-actions"><button id="tour-narration-replay" class="text-button">Replay narration</button><button id="tour-narration-connect" class="text-button">ElevenLabs connection & cache</button></div><audio id="tour-narration-audio" preload="metadata"></audio>`;
  $('#route-stop-actions').before(controls);
  const message=document.createElement('p');message.id='tour-narration-status';message.setAttribute('role','status');controls.after(message);
  $('#route-narration').parentElement.lastChild.textContent=' Voice narration';
  $('#route-narration').checked=true;
  const n=tourNarration;n.audio=$('#tour-narration-audio');
  n.audio.onended=()=>{n.started=false;narrationStatus('Narration complete · saved on this PC');};
  n.audio.onerror=()=>{if(n.audio.getAttribute('src')){n.error=true;n.started=false;narrationStatus('Audio could not play. Choose Replay narration to retry.');}};
  $('#route-narration').onchange=()=>{resetTourNarration();if(narrationEnabled()&&routePlayer.playing)void startTourNarration();};
  const updateVoiceControls=()=>{const openai=$('#tour-narration-provider').value==='openai';$('#tour-narration-voice').disabled=!openai;$('#tour-narration-voice').parentElement.hidden=!openai;$('#tour-narration-connect').textContent=openai?'OpenAI connection':'ElevenLabs connection & cache';};
  const settingsChanged=()=>{setNarratorPreference($('#tour-narration-provider').value);resetTourNarration();updateVoiceControls();if(narrationEnabled()&&routePlayer.playing)void startTourNarration();};
  $('#tour-narration-provider').onchange=settingsChanged;$('#tour-narration-voice').onchange=settingsChanged;
  $('#tour-narration-replay').onclick=()=>{$('#route-narration').checked=true;void startTourNarration(true);};
  $('#tour-narration-connect').onclick=()=>($('#tour-narration-provider').value==='openai'?openCloudConnection('speech'):openElevenLabsConnection()).catch(failure);
  const storyConnection=document.createElement('button');storyConnection.className='text-button';storyConnection.id='tour-story-connect';storyConnection.textContent='OpenAI story connection';storyConnection.onclick=()=>openCloudConnection('stories').catch(failure);$('#tour-narration-connect').after(storyConnection);
  $('#route-play-speed').addEventListener('change',()=>{n.audio.playbackRate=Number($('#route-play-speed').value)||1;});
  setNarratorPreference(preferredNarrator());updateVoiceControls();
  narrationStatus('ElevenLabs reads the guide once; saved audio is reused on this PC.');
}

async function openElevenLabsConnection(){
  const info=await api('/api/narration/elevenlabs/status');
  modal('ElevenLabs voice & saved narration',`<form id="elevenlabs-form" class="note-form"><p>${info.configured?'Connected · '+esc(info.voice_name||info.voice_id):'Connect your ElevenLabs account'} · ${info.cached_clips} saved clips (${(info.cached_bytes/1048576).toFixed(1)} MB)</p><p class="small muted">New narration sends the guide text to ElevenLabs and uses API credits. Replays use local audio. Your key is encrypted for your Windows account and is never included in tours or exports.</p><label for="elevenlabs-key">ElevenLabs API key</label><input id="elevenlabs-key" type="password" autocomplete="off" spellcheck="false" required><label for="elevenlabs-voice">Voice ID</label><input id="elevenlabs-voice" value="${esc(info.voice_id)}" pattern="[A-Za-z0-9]{10,64}" required><p class="small muted">Model: ${esc(info.model)} · MP3 audio. Back up data/narration-elevenlabs to keep your paid audio. Edited text or a different voice/model needs a new generation.</p><p id="elevenlabs-message" role="status">${esc(info.problem||'')}</p><button class="button primary" type="submit">Verify & save encrypted connection</button>${info.configured?'<button class="button" id="elevenlabs-disconnect" type="button">Remove key · keep saved audio</button>':''}</form>`);
  $('#elevenlabs-form').onsubmit=async e=>{e.preventDefault();const input=$('#elevenlabs-key'),key=input.value;input.value='';await busy($('#elevenlabs-form button'),'Verifying…',async()=>{await jsonPost('/api/narration/elevenlabs/connect',{api_key:key,voice_id:$('#elevenlabs-voice').value.trim()});setNarratorPreference('elevenlabs');resetTourNarration();closeModal();toast('ElevenLabs connected. Narration is saved locally after its first generation.');});};
  if($('#elevenlabs-disconnect'))$('#elevenlabs-disconnect').onclick=async()=>{await api('/api/narration/elevenlabs/connection',{method:'DELETE'});closeModal();toast('Saved key removed. Your narration audio is still available.');};
}
