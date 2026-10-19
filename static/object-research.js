'use strict';
const objectResearchUI={serial:0,timer:null,record:null,pending:false};
function researchTarget(o){return {id:String(o.id),name:o.research_name||o.name||o.title,catalog:o.catalog||'Featured',ra:o.ra,dec:o.dec,type:o.type||'',source_url:o.source_url||''};}
function objectResearchCurrent(serial,o){return objectResearchUI.serial===serial&&mapUI.selected===o;}
function objectResearchStatus(message){const node=$('#object-research-status');if(node)node.textContent=message;}
function objectResearchMarkup(o,record){
  const r=record?.research,working=record?.status==='researching',audio=record?.audio;
  return `<div class="object-research-heading"><strong>${r?'Saved research':'Discover this object'}</strong>${r?'<span class="badge teal">ON THIS PC</span>':''}</div>
    <div class="object-research-actions">${r?`${audio?'<button class="button primary" id="object-listen">Listen to narration</button>':`<button class="button primary" id="object-narrate" ${record?.audio_status==='creating'?'disabled':''}>${record?.audio_status==='creating'?'Creating narration…':'Create narration'}</button>`}<button class="button" id="object-add-tour">Add to tour</button>`:`<button class="button primary" id="object-research-start" ${working?'disabled':''}>${working?'Researching…':record?.status==='unfinished'?'Retry research':'Research Object'}</button>`}</div>
    <p id="object-research-status" role="status">${esc(r?(record.audio_error||'Research saved independently of narration. '+(audio?'Your ElevenLabs recording is ready to replay locally.':'Create narration reads this exact story with ElevenLabs.')):working?'OpenAI is researching this object. You can leave this card; the completed story will be saved.':record?.error||'OpenAI researches the object using linked astronomy sources. New research uses API credits.')}</p>
    ${audio?`<audio id="object-research-audio" controls preload="none" src="${esc(audio.url)}" aria-label="Saved ElevenLabs narration for ${esc(o.name)}" hidden></audio><p class="object-voice-disclosure">AI-generated ElevenLabs voice · saved on this PC</p>`:''}
    ${r&&r.story.identified===false?'<p class="object-evidence-note">Limited object-specific evidence. This story also explains the wider astronomical context.</p>':''}
    <div id="object-research-story">${r?tourStoryMarkup({tour_story:r}):`<p>${esc(o.summary||'')}</p>`}</div>
    ${r?storySourcesMarkup({story_sources:r.sources}):''}
    <details class="object-research-connections"><summary>Research & voice connections</summary><button class="text-button" id="object-openai-connect">OpenAI connection</button><button class="text-button" id="object-eleven-connect">ElevenLabs connection</button>${r?`<p>Researched ${esc(date(r.created_at))}. Research and recordings remain in this app’s data folder; include it in your backups.</p>`:''}</details>`;
}
function renderObjectResearch(o,record,serial){
  if(!objectResearchCurrent(serial,o))return;
  objectResearchUI.record=record;$('#object-research').innerHTML=objectResearchMarkup(o,record);
  if($('#object-research-start'))$('#object-research-start').onclick=()=>runObjectResearch(o,serial);
  if($('#object-narrate'))$('#object-narrate').onclick=()=>createObjectNarration(o,serial);
  if($('#object-listen'))$('#object-listen').onclick=async()=>{
    const audio=$('#object-research-audio');audio.hidden=false;
    if(typeof pauseTourNarration==='function')pauseTourNarration();
    if(audio.ended)audio.currentTime=0;
    try{await audio.play();}catch{objectResearchStatus('Press play on the audio player to listen.');}
  };
  if($('#object-research-audio')){
    $('#object-research-audio').onplay=()=>{if(typeof pauseObjectVideos==='function')pauseObjectVideos();if(typeof pauseTourNarration==='function')pauseTourNarration();};
    $('#object-research-audio').onerror=()=>objectResearchStatus('Saved audio could not play. Reopen the object to check its recording; research remains saved.');
  }
  if($('#object-add-tour'))$('#object-add-tour').onclick=()=>openObjectTour(o,record).catch(failure);
  $('#object-openai-connect').onclick=()=>openCloudConnection('stories').catch(failure);
  $('#object-eleven-connect').onclick=()=>openElevenLabsConnection().catch(failure);
  clearTimeout(objectResearchUI.timer);
  if(!objectResearchUI.pending&&(record?.status==='researching'||record?.audio_status==='creating'))objectResearchUI.timer=setTimeout(()=>refreshObjectResearch(o,serial,record.id),2000);
}
async function loadObjectResearch(o){
  const serial=++objectResearchUI.serial;clearTimeout(objectResearchUI.timer);objectResearchUI.record=null;objectResearchUI.pending=false;
  $('#object-research').innerHTML='<p role="status">Checking saved object research…</p>';
  try{const record=await jsonPost('/api/object-research/lookup',{target:researchTarget(o)});renderObjectResearch(o,record,serial);}
  catch(error){if(objectResearchCurrent(serial,o)){$('#object-research').innerHTML=`<p>${esc(o.summary||'')}</p><p role="status">${esc(error.message)}</p><button class="button" id="object-research-reload">Reload saved research</button>`;$('#object-research-reload').onclick=()=>loadObjectResearch(o);}}
}
async function refreshObjectResearch(o,serial,id){
  if(!objectResearchCurrent(serial,o))return;
  try{const record=await api('/api/object-research/'+id);if(!objectResearchUI.pending)renderObjectResearch(o,record,serial);}
  catch(error){if(objectResearchCurrent(serial,o))objectResearchStatus(error.message+' Reopen this object to check its saved research.');}
}
async function runObjectResearch(o,serial){
  if(!objectResearchCurrent(serial,o)||objectResearchUI.pending)return;
  const record=objectResearchUI.record;objectResearchUI.pending=true;clearTimeout(objectResearchUI.timer);
  renderObjectResearch(o,{...record,status:'researching'},serial);
  try{const result=await jsonPost('/api/object-research/research',{target:researchTarget(o),retry:record?.status==='unfinished'});renderObjectResearch(o,result,serial);}
  catch(error){if(objectResearchCurrent(serial,o))renderObjectResearch(o,{...record,status:'unfinished',error:error.message},serial);}
  finally{if(objectResearchCurrent(serial,o))objectResearchUI.pending=false;}
}
async function createObjectNarration(o,serial){
  const record=objectResearchUI.record;
  if(!objectResearchCurrent(serial,o)||!record?.research||objectResearchUI.pending)return;
  objectResearchUI.pending=true;clearTimeout(objectResearchUI.timer);const button=$('#object-narrate');button.disabled=true;button.textContent='Creating narration…';
  objectResearchStatus('ElevenLabs is reading the exact saved story. The completed recording will be kept on this PC.');
  try{const audio=await jsonPost('/api/object-research/'+record.id+'/narration',{});renderObjectResearch(o,{...record,audio,audio_status:'ready'},serial);}
  catch(error){if(objectResearchCurrent(serial,o)){renderObjectResearch(o,record,serial);objectResearchStatus(error.message+' Your research is still saved.');}}
  finally{if(objectResearchCurrent(serial,o))objectResearchUI.pending=false;}
}
async function openObjectTour(o,record){
  if(!record?.research)return;
  if(navigationUI.dirty)await saveEditedRoute();
  const {rows}=await api('/api/navigation/routes'),routes=rows.filter(r=>r.kind==='waypoints'&&r.stop_count<100);
  const view={...tourSurveyView(skyView()),ra:o.ra,dec:o.dec,fov:Math.min(2,Math.max(.001,currentField().fov))};
  modal('Add '+o.name+' to a tour',`<p>The tour keeps this exact saved story and reuses its ElevenLabs recording. You can add the story before creating audio.</p><label>Tour<select id="object-tour-choice"><option value="">Create a new tour</option>${routes.map(r=>`<option value="${esc(r.id)}">${esc(r.title)} · ${r.stop_count} stops</option>`).join('')}</select></label><label id="object-tour-title-label">New tour name<input id="object-tour-title" maxlength="200" value="${esc(o.name+' and beyond')}"></label><p id="object-tour-result" role="status"></p><button class="button primary" id="object-tour-save">Add saved story</button>`);
  const select=$('#object-tour-choice');if(routes.some(r=>r.id===navigationUI.editor?.id))select.value=navigationUI.editor.id;
  select.onchange=()=>$('#object-tour-title-label').hidden=Boolean(select.value);select.onchange();
  $('#object-tour-save').onclick=()=>busy($('#object-tour-save'),'Saving…',async()=>{
    if(navigationUI.dirty)await saveEditedRoute();
    const chosen=routes.find(r=>r.id===select.value),title=$('#object-tour-title').value.trim();
    if(!chosen&&!title)throw new Error('Enter a name for your new tour.');
    const route=await jsonPost('/api/object-research/'+record.id+'/tour',{view,route_id:chosen?.id||null,route_revision:chosen?.revision||null,title:title||'My object tour'});
    if(navigationUI.editor?.id===route.id){navigationUI.editor=route;navigationUI.dirty=false;renderRouteEditor();}
    await loadSavedRoutes();closeModal();toast('Saved story added to '+route.title+'. Find it in Tours & Routes.');
  });
}
