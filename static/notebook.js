'use strict';
const notebookUI={menu:null,selection:null,timer:null,request:0,selected:[],notes:[],saving:false};
const notebookBusy=n=>['queued','researching'].includes(n.research?.status);
const notebookScript=n=>n.research?.edited_narration||n.research?.story||'';
const notebookLocated=n=>Number.isFinite(n.ra)&&Number.isFinite(n.dec);
const notebookImage=n=>/^[a-f0-9]{32}$/.test(n.provenance?.image_id||'')?'/api/images/'+n.provenance.image_id+'/preview':null;
function notebookSources(sources){return storySourcesMarkup({story_sources:sources||[]});}
function notebookParagraphs(text){return String(text||'').split(/\n\s*\n/).map(p=>`<p>${esc(p)}</p>`).join('');}

function closeNotebookMenu(){if(notebookUI.menu)notebookUI.menu.hidden=true;}
function notebookLocation(event,sky,rect){
  const keyboard=event.clientX===0&&event.clientY===0;
  const x=keyboard?rect.width/2:event.clientX-rect.left,y=keyboard?rect.height/2:event.clientY-rect.top;
  if(x<0||y<0||x>rect.width||y>rect.height)return null;
  let world;try{world=sky.pix2world(x,y,'ICRS');}catch{return null;}
  const marker=event.target?.closest?.('#image-markers [data-ra][data-dec]');
  if(marker)world=[Number(marker.dataset.ra),Number(marker.dataset.dec)];
  if(!world||!Number.isFinite(world[0])||!Number.isFinite(world[1])||Math.abs(world[1])>90)return null;
  const [ra,dec]=sky.getRaDec(),fov=sky.getFov()[0];
  return {ra:(world[0]%360+360)%360,dec:world[1],fov,survey:state.survey,
    view:{ra,dec,fov,roll:sky.getRotation?.()||0,projection:sky.getProjectionName?.()||'AIT'},
    click:{x,y,width:rect.width,height:rect.height},search_radius_arcsec:Math.min(180,Math.max(3,fov/rect.width*6*3600))};
}
function initNotebookSky(){
  const host=$('#aladin-lite-div');if(host.dataset.notebookMenu)return;host.dataset.notebookMenu='true';host.tabIndex=0;
  const menu=document.createElement('div');menu.id='sky-notebook-menu';menu.className='sky-notebook-menu';menu.hidden=true;menu.setAttribute('role','menu');
  menu.innerHTML='<div class="small muted" id="notebook-menu-position"></div><button class="button primary" role="menuitem" id="notebook-menu-save">+ Add to discovery notebook</button><p class="small muted">Saves this location and a snapshot, then researches nearby catalog objects. Shift + right-click opens Aladin actions.</p>';
  $('#explore-page').append(menu);notebookUI.menu=menu;
  $('#explore-page').addEventListener('contextmenu',event=>{
    const marker=event.target.closest('#image-markers [data-ra][data-dec]');
    if(!host.contains(event.target)&&!marker)return;
    if((event.shiftKey&&(event.clientX||event.clientY))||(!marker&&event.target.closest('button,input,select,a')))return;
    event.preventDefault();event.stopImmediatePropagation();
    interruptTour('Paused to save a discovery');if(flight.active)pauseFlight();cancelAnimationFrame(travelFrame);
    const rect=host.getBoundingClientRect(),selection=notebookLocation(event,state.sky,rect);
    if(!selection){closeNotebookMenu();toast('Choose a point inside the sky projection.',true);return;}
    notebookUI.selection=selection;$('#notebook-menu-position').textContent=`RA ${selection.ra.toFixed(5)}° · Dec ${selection.dec.toFixed(5)}°`;
    menu.hidden=false;menu.style.left=Math.max(8,Math.min(event.clientX||rect.left+rect.width/2,window.innerWidth-menu.offsetWidth-12))+'px';
    menu.style.top=Math.max(8,Math.min(event.clientY||rect.top+rect.height/2,window.innerHeight-menu.offsetHeight-12))+'px';
    $('#notebook-menu-save').focus();
  },true);
  $('#notebook-menu-save').onclick=()=>busy($('#notebook-menu-save'),'Saving snapshot…',()=>captureNotebookLocation(notebookUI.selection));
  document.addEventListener('pointerdown',e=>{if(!menu.contains(e.target))closeNotebookMenu();},true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeNotebookMenu();if(state.page==='explore')host.focus({preventScroll:true});}});
  host.addEventListener('wheel',closeNotebookMenu,{passive:true});
}
async function captureNotebookLocation(selection){
  if(!selection||!state.sky)throw Error('Choose a sky location first.');
  closeNotebookMenu();
  if(state.sky.isStillActive?.())throw Error('The map is still loading. Let the view settle, then right-click again.');
  const current=skyView();
  if(['ra','dec','fov','roll','projection','survey'].some(k=>current[k]!==({...selection.view,survey:selection.survey})[k]))throw Error('The view changed. Right-click the location again.');
  const capture=await explorePixelMapping.controller.capturePNG({creditFooter:true});
  const survey=capture.metadata.survey;
  noteDialog({title:`Sky discovery · ${selection.ra.toFixed(4)}, ${selection.dec.toFixed(4)}`,ra:selection.ra,dec:selection.dec,survey:selection.survey,
    provenance:{...selection,kind:'notebook-sky-snapshot',captured_at:capture.metadata.created_at,survey_url:survey.url,snapshot_credit:survey.credit,pixel_mapping:capture.metadata}},capture);
}
async function attachNotebookSnapshot(values,capture){
  if(!capture||capture.image)return capture?.image;
  const form=new FormData();form.append('file',capture.blob,values.title+'.png');form.append('context',JSON.stringify({...values.provenance,calibrated:false}));
  capture.image=await api('/api/images/upload',{method:'POST',body:form});return capture.image;
}
function renderNotebookEntries(rows){
  notebookUI.notes=rows;state.notes=rows;$('#note-count').textContent=rows.length;
  $('#notes-list').innerHTML=rows.length?rows.map((n,i)=>{
    const r=n.research||{},image=notebookImage(n),pending=notebookBusy(n),script=notebookScript(n);
    return `<article class="note-card" data-notebook-id="${esc(n.id)}"><span class="badge teal">${esc(n.kind.toUpperCase())}</span><h2>${esc(n.title)}</h2>${image?`<img class="notebook-snapshot" src="${image}" alt="Saved sky view for ${esc(n.title)}" loading="lazy">`:''}${n.body?`<p class="notebook-personal">${esc(n.body)}</p>`:''}<div class="small">${date(n.created_at)}<br>${notebookLocated(n)?`RA ${n.ra.toFixed(5)}° · Dec ${n.dec.toFixed(5)}°`:'Pixel coordinates recorded in provenance'}</div>
      <div class="notebook-research"><span class="overline">${esc(pending?'RESEARCH IN PROGRESS':r.edited_narration?'YOUR NARRATION':r.status?'RESEARCHED FIELD GUIDE':'READY TO RESEARCH')}</span><p class="small muted" role="status">${esc(r.message||'Research this saved position to prepare a narrated tour stop.')}${r.catalog_stale?' Using cached catalog data.':''}</p>${r.identity_label?`<strong>${esc(r.identity_label)}</strong>`:''}
      ${r.candidates?.length>1?`<details><summary>Review nearby catalog matches (${r.candidates.length})</summary><label>Object discussed<select data-note-match="${i}" ${pending?'disabled':''}>${r.candidates.map(o=>`<option value="${esc(o.id)}" ${o.id===r.selected_id?'selected':''}>${esc(o.name)} · ${esc(o.type)} · ${o.separation_arcsec}″ away</option>`).join('')}</select></label><p class="small muted">A nearby position is a possible association. Your saved coordinates stay unchanged.</p></details>`:''}
      ${script?`<details class="notebook-story" open><summary>Tour story · ${Math.ceil(script.split(/\s+/).length/145*60)} sec</summary>${notebookParagraphs(script)}</details>`:''}${notebookSources(r.sources)}${r.checked_at?`<div class="small muted">Checked ${date(r.checked_at)}${r.edited_narration?' · narration edited by you':''}</div>`:''}</div>
      <div class="note-actions">${notebookLocated(n)?`<button class="text-button" data-note-research="${i}" ${pending?'disabled':''}>${pending?'Researching…':script?'Research again':'Research this location'}</button><button class="text-button" data-note-story="${i}" ${pending?'disabled':''}>Edit narration</button><button class="text-button" data-note-tour="${i}" ${pending||!script?'disabled':''}>Use in tour</button><button class="text-button" data-note-visit="${i}">Revisit field ↗</button>`:''}${image?`<button class="text-button" data-note-image="${i}">Open saved image</button>`:''}<button class="text-button delete-note" data-note-delete="${i}">Delete</button></div><details><summary>Data provenance</summary><pre>${esc(JSON.stringify({capture:n.provenance,research:r},null,2))}</pre></details></article>`;
  }).join(''):'<div class="empty-state"><span class="empty-symbol">▤</span><h2>Every discovery starts with a question.</h2><p>Right-click a location in Explore the sky to save its image and start a researched guide.</p></div>';
  $$('[data-note-research]').forEach(b=>b.onclick=()=>busy(b,'Researching…',async()=>{await jsonPost('/api/notebook/'+rows[Number(b.dataset.noteResearch)].id+'/research',{});await loadNotes();}));
  $$('[data-note-story]').forEach(b=>b.onclick=()=>editNotebookStory(rows[Number(b.dataset.noteStory)]));
  $$('[data-note-match]').forEach(el=>el.onchange=async()=>{const n=rows[Number(el.dataset.noteMatch)];try{await api('/api/notebook/'+n.id+'/identify',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:n.revision,candidate_id:el.value})});await loadNotes();}catch(e){failure(e);await loadNotes();}});
  $$('[data-note-tour]').forEach(b=>b.onclick=()=>{const id=rows[Number(b.dataset.noteTour)].id;if(!notebookUI.selected.includes(id))notebookUI.selected.push(id);showPage('routes');$('#notebook-tour-builder').scrollIntoView({behavior:'smooth'});});
  $$('[data-note-visit]').forEach(b=>b.onclick=()=>{const n=rows[Number(b.dataset.noteVisit)];flyTo({name:n.title,ra:n.ra,dec:n.dec,fov:n.provenance.fov||.2,survey:n.survey||'optical',type:'FROM YOUR NOTEBOOK',description:n.research?.identity_label||n.body});});
  $$('[data-note-image]').forEach(b=>b.onclick=()=>api('/api/images/'+rows[Number(b.dataset.noteImage)].provenance.image_id).then(openImage).catch(failure));
  $$('[data-note-delete]').forEach(b=>b.onclick=async()=>{const n=rows[Number(b.dataset.noteDelete)];if(!confirm(`Delete the note “${n.title}”? Saved images and existing tour stories will remain.`))return;try{await api('/api/notes/'+n.id,{method:'DELETE'});await loadNotes();}catch(e){failure(e);}});
  renderNotebookTourPicker();
  clearTimeout(notebookUI.timer);
  if(rows.some(notebookBusy))notebookUI.timer=setTimeout(()=>{if(['notebook','routes'].includes(state.page))loadNotes().catch(failure);},2000);
}
function editNotebookStory(n){
  modal('Edit tour narration',`<form id="notebook-story-form"><label for="notebook-script">What should the narrator say?</label><textarea id="notebook-script" maxlength="3500" required rows="12">${esc(notebookScript(n))}</textarea><p class="small muted">Your script is saved separately from the researched draft. Research again will preserve it. Existing tours keep their own saved stories.</p><button class="button primary" type="submit">Save narration</button></form>`);
  $('#notebook-story-form').onsubmit=e=>{e.preventDefault();busy($('#notebook-story-form button'),'Saving…',async()=>{await api('/api/notebook/'+n.id+'/story',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:n.revision,narration:$('#notebook-script').value})});closeModal();await loadNotes();});};
}
function renderNotebookTourPicker(){
  const host=$('#notebook-tour-entries');if(!host)return;
  const rows=notebookUI.notes.filter(notebookLocated),ids=new Set(rows.map(n=>n.id));notebookUI.selected=notebookUI.selected.filter(id=>ids.has(id));
  host.innerHTML=rows.length?rows.map(n=>{const ready=Boolean(notebookScript(n))&&!notebookBusy(n);return `<label class="notebook-tour-choice"><input type="checkbox" data-tour-note="${n.id}" ${notebookUI.selected.includes(n.id)?'checked':''} ${ready?'':'disabled'}>${notebookImage(n)?`<img src="${notebookImage(n)}" alt="" loading="lazy">`:''}<span><strong>${esc(n.title)}</strong><small>${esc(ready?n.research?.identity_label||'Your narration':notebookBusy(n)?'Researching…':'Open Notebook to research or write a story')}</small></span></label>`;}).join(''):'<p class="small muted">Save locations in Discovery notebook to build your own tour.</p>';
  $$('[data-tour-note]').forEach(el=>el.onchange=()=>{if(el.checked&&!notebookUI.selected.includes(el.dataset.tourNote))notebookUI.selected.push(el.dataset.tourNote);else if(!el.checked)notebookUI.selected=notebookUI.selected.filter(id=>id!==el.dataset.tourNote);renderNotebookTourOrder();});
  renderNotebookTourOrder();
}
function renderNotebookTourOrder(){
  const entries=notebookUI.selected.map(id=>notebookUI.notes.find(n=>n.id===id)).filter(Boolean);
  $('#notebook-tour-order').innerHTML=entries.map((n,i)=>`<li><span>${i+1}. ${esc(n.title)}</span><button class="text-button" data-notebook-move="${i}:-1" ${i===0?'disabled':''} aria-label="Move selected stop ${i+1} up">↑</button><button class="text-button" data-notebook-move="${i}:1" ${i===entries.length-1?'disabled':''} aria-label="Move selected stop ${i+1} down">↓</button></li>`).join('');
  $('#notebook-tour-count').textContent=`${entries.length} selected · stories and source links will be copied into the tour`;
  const disabled=notebookUI.saving||!entries.length||entries.length>50||entries.some(n=>!notebookScript(n)||notebookBusy(n));
  for(const id of ['notebook-tour-create','notebook-tour-play'])$('#'+id).disabled=disabled;
  $$('[data-notebook-move]').forEach(b=>b.onclick=()=>{const [i,d]=b.dataset.notebookMove.split(':').map(Number),ids=notebookUI.selected;[ids[i],ids[i+d]]=[ids[i+d],ids[i]];renderNotebookTourOrder();});
}
function activateNotebookNarration(route){
  const guide=route.stops?.find(s=>s.guide)?.guide;if(!guide)return;
  $('#route-narration').checked=true;$('#tour-narration-provider').value=guide.narrator||'windows';$('#tour-narration-voice').disabled=guide.narrator!=='openai';if($('#tour-narration-voice').parentElement)$('#tour-narration-voice').parentElement.hidden=guide.narrator!=='openai';resetTourNarration();
}
async function createNotebookTour(play){
  if(notebookUI.saving)return;notebookUI.saving=true;renderNotebookTourOrder();
  try{
    const entries=notebookUI.selected.map(id=>{const n=notebookUI.notes.find(n=>n.id===id);return {id,revision:n.revision};});
    if(!$('#notebook-tour-title').reportValidity())return;
    if(navigationUI.dirty)await saveEditedRoute();
    const route=await jsonPost('/api/notebook/tour',{title:$('#notebook-tour-title').value.trim(),narrator:$('#notebook-tour-voice').value,entries});
    await loadSavedRoutes();await editSavedRoute(route.id);toast('Notebook tour saved with its stories and sources.');
    if(play)await playSavedRoute(route.id);else $('#route-editor').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){failure(e);await loadNotes();}
  finally{notebookUI.saving=false;renderNotebookTourOrder();}
}
function initNotebook(){
  $('#notebook-tour-refresh').onclick=()=>loadNotes().catch(failure);
  $('#notebook-tour-create').onclick=()=>createNotebookTour(false);$('#notebook-tour-play').onclick=()=>createNotebookTour(true);
}
