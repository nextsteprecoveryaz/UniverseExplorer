'use strict';
const destinationVisit={serial:0,timer:null,resolveArrival:null,active:false,survey:null};
let destinationShelfSurvey=null;
function destinationSurvey(){return state.survey==='sdss-color'?'sdss-color':'optical';}
function destinationCatalog(){return destinationSurvey()==='sdss-color'?(state.config.sdss_destinations||[]):state.config.destinations;}
function destinationSurveyName(survey=destinationSurvey()){return survey==='sdss-color'?'SDSS galaxy color':'DSS2';}
function cancelDestinationVisit(){
  if(destinationVisit.active){$('#object-research-audio')?.pause();destinationStatus('Visit paused · select a shortcut to start its saved story.');}
  destinationVisit.serial++;destinationVisit.active=false;clearTimeout(destinationVisit.timer);
  if(destinationVisit.resolveArrival){destinationVisit.resolveArrival(false);destinationVisit.resolveArrival=null;}
}
function shortcutCurrent(serial,o){return serial===destinationVisit.serial&&mapUI.selected===o&&state.page==='explore'&&state.survey===destinationVisit.survey;}
function destinationStatus(text){const node=$('#destination-status');if(node)node.textContent=text;}
function shortcutObject(d){return {...d,id:d.object_id,name:d.name,summary:d.description,featured:false};}
function shortcutMatches(d,query,category){
  const normalize=s=>String(s||'').toLowerCase().replace(/[\s’'·-]+/g,'');
  return (!category||d.category===category)&&normalize([d.name,d.research_name,d.type,d.category].join(' ')).includes(normalize(query));
}
function destinationArrived(d){
  if(!state.sky)return false;
  const field=currentField();
  return FlightMath.separation(field,d)<Math.max(.0001,d.fov*.025)&&Math.abs(field.fov-d.fov)<d.fov*.03;
}
function waitForDestination(d,serial,o){
  return new Promise(resolve=>{
    destinationVisit.resolveArrival=resolve;const started=performance.now();
    const finish=value=>{destinationVisit.resolveArrival=null;resolve(value);};
    const poll=()=>{
      if(!shortcutCurrent(serial,o))return finish(false);
      if(destinationArrived(d))return finish(true);
      if(performance.now()-started>6500)return finish(false);
      destinationVisit.timer=setTimeout(poll,80);
    };poll();
  });
}
async function visitDestinationShortcut(d){
  cancelDestinationVisit();
  if(!state.sky){toast('Connect to the sky map before visiting a destination.',true);return;}
  const survey=d.survey==='sdss-color'?'sdss-color':'optical',surveyName=destinationSurveyName(survey);
  flyTo({...d,survey});
  setMapPanel('objects',false);setMapPanel('destinations',false);
  const o=shortcutObject(d),loaded=showObjectDetail(o),serial=++destinationVisit.serial;
  destinationVisit.active=true;destinationVisit.survey=survey;
  destinationStatus('Travelling to '+d.name+' in '+surveyName+'…');
  const arrival=waitForDestination(d,serial,o);
  await loaded;
  if(!await arrival||!shortcutCurrent(serial,o)){if(shortcutCurrent(serial,o))destinationStatus('Travel was interrupted. Select the destination again to start its story.');return;}
  if(!$('#destination-auto-narrate').checked){destinationStatus(d.name+' · '+surveyName+' · use the object card to research or listen.');return;}
  let record=objectResearchUI.record;
  if(!record){destinationStatus('Saved research could not be loaded. Use Reload saved research in the object card.');return;}
  const objectSerial=objectResearchUI.serial;
  if(!record.research){
    if(record.status==='unfinished'){destinationStatus('Earlier research needs attention. Use Retry research in the card, then Create narration.');return;}
    destinationStatus(d.name+' · OpenAI is preparing the saved story…');
    await runObjectResearch(o,objectSerial);
    if(!shortcutCurrent(serial,o))return;
    record=objectResearchUI.record;
  }
  if(!record?.research){destinationStatus('Research needs attention in the object card. No narration was generated.');return;}
  if(!shortcutCurrent(serial,o))return;
  if(!record.audio){
    destinationStatus(d.name+' · ElevenLabs is recording the saved story…');
    await createObjectNarration(o,objectSerial);
    if(!shortcutCurrent(serial,o))return;
    record=objectResearchUI.record;
  }
  if(!record?.audio){destinationStatus('Story saved. Check the object card to finish narration.');return;}
  const player=$('#object-research-audio');if(!player)return;
  player.hidden=false;
  try{await player.play();if(shortcutCurrent(serial,o))destinationStatus(d.name+' · playing saved ElevenLabs narration.');}
  catch{if(shortcutCurrent(serial,o))destinationStatus('Story and audio saved · click Listen to narration in the card to play.');}
}
function updateDestinationScroll(){
  const strip=$('#destinations');$('#destinations-previous').disabled=strip.scrollLeft<=1;
  $('#destinations-next').disabled=strip.scrollLeft+strip.clientWidth>=strip.scrollWidth-2;
}
function renderDestinationShortcuts(){
  const survey=destinationSurvey(),catalog=destinationCatalog(),categories=[...new Set(catalog.map(d=>d.category))];
  const categoryNode=$('#destination-category'),previousCategory=categoryNode.value;
  categoryNode.innerHTML='<option value="">All destinations</option>'+categories.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  categoryNode.value=categories.includes(previousCategory)?previousCategory:'';
  if(destinationShelfSurvey!==survey){
    if(destinationShelfSurvey!==null){$('#destination-search').value='';categoryNode.value='';}
    destinationShelfSurvey=survey;
    destinationStatus(survey==='sdss-color'?'Explore covered SDSS galaxy fields · existing DSS2 stories and recordings are reused.':'Scroll for 100 destinations · first visit creates a story and narration; saved visits replay locally.');
  }
  const query=$('#destination-search').value,category=$('#destination-category').value;
  const rows=catalog.map((d,i)=>({d,i})).filter(({d})=>shortcutMatches(d,query,category));
  $('#destination-count').textContent=`${rows.length} of ${catalog.length} · ${destinationSurveyName(survey)}`;
  $('#destinations').innerHTML=rows.length?rows.map(({d,i})=>`<button class="destination-card ${state.destination?.id===d.id?'active':''}" data-name="${esc(d.name)}" data-destination="${i}" title="${esc(d.name+' · '+d.research_name)}"><span class="num">${String(i+1).padStart(2,'0')}</span><small>${esc(d.type)}</small><strong>${esc(d.name)}</strong><span class="destination-catalog">${esc(d.research_name+(d.view_label?' · '+d.view_label:''))}</span></button>`).join(''):'<p class="small muted">No destinations match. Try a name, catalog number, or another category.</p>';
  $$('[data-destination]').forEach(button=>button.onclick=()=>visitDestinationShortcut(catalog[Number(button.dataset.destination)]).catch(failure));
  $('#destinations').scrollLeft=0;requestAnimationFrame(updateDestinationScroll);
}
function initDestinationShortcuts(){
  try{$('#destination-auto-narrate').checked=localStorage.getItem('universe-destination-narration')!=='false';}catch{}
  $('#destination-auto-narrate').onchange=()=>{cancelDestinationVisit();stopObjectVideo();try{localStorage.setItem('universe-destination-narration',String($('#destination-auto-narrate').checked));}catch{}destinationStatus($('#destination-auto-narrate').checked?'Select a destination to research, narrate and save its story.':'Automatic narration off · destination cards still open their saved research.');};
  $('#destination-search').oninput=renderDestinationShortcuts;$('#destination-category').onchange=renderDestinationShortcuts;
  const strip=$('#destinations');strip.addEventListener('scroll',updateDestinationScroll,{passive:true});
  strip.addEventListener('wheel',event=>{
    if(event.ctrlKey||strip.scrollWidth<=strip.clientWidth)return;
    event.preventDefault();event.stopPropagation();
    const scale=event.deltaMode===1?24:event.deltaMode===2?strip.clientWidth:1;
    strip.scrollLeft+=(Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY)*scale;
  },{passive:false});
  strip.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const cards=$$('[data-destination]'),index=cards.indexOf(document.activeElement);if(index<0)return;
    event.preventDefault();event.stopPropagation();
    const next=event.key==='Home'?0:event.key==='End'?cards.length-1:Math.min(cards.length-1,Math.max(0,index+(event.key==='ArrowRight'?1:-1)));
    cards[next]?.focus({preventScroll:true});cards[next]?.scrollIntoView({block:'nearest',inline:'nearest'});
  });
  for(const [id,direction] of [['previous',-1],['next',1]])$('#destinations-'+id).onclick=()=>strip.scrollBy({left:direction*strip.clientWidth*.8,behavior:'smooth'});
  window.addEventListener('resize',updateDestinationScroll);renderDestinationShortcuts();
}
