'use strict';
const navigationUI={templates:[],routes:[],editor:null,dirty:false,editVersion:0,savePromise:null,autoSave:null,nearby:true,nearbyPreference:true,nearbyData:null,nearbyRequest:0,nearbyTimer:null,footprint:null,loaded:false};
const ROUTE_FIELDS=['title','description','kind','stops','track'];
function routePayload(r){return Object.fromEntries(ROUTE_FIELDS.map(k=>[k,r[k]??(k==='stops'||k==='track'?[]:k==='kind'?'waypoints':'')]));}
function navigationStop(media){return {title:media.title||media.name,ra:media.ra,dec:media.dec,fov:media.fov||.18,roll:0,survey:tourSkySurvey(),projection:'AIT',notes:'',travel:4,hold:15,source:{kind:media.kind,id:String(media.id)}};}
function setNearbyVisible(enabled,persist=false){
  navigationUI.nearby=enabled;$('#nearby-panel').hidden=!enabled;$('#nearby-toggle').setAttribute('aria-pressed',String(enabled));$('#explore-page').classList.toggle('nearby-active',enabled);
  if(persist){navigationUI.nearbyPreference=enabled;try{localStorage.setItem('universe-nearby',String(enabled));}catch{}}
  if(enabled)refreshNearby().catch(failure);else{navigationUI.nearbyRequest++;clearTimeout(navigationUI.nearbyTimer);navigationUI.nearbyTimer=null;}
}
function onNavigationSkyChanged(){
  if(!navigationUI.nearby||state.page!=='explore'||navigationUI.nearbyTimer)return;
  navigationUI.nearbyTimer=setTimeout(()=>{navigationUI.nearbyTimer=null;refreshNearby().catch(()=>{});},2200);
}
function angularDistance(d){return d<1?(d*60).toFixed(2)+'′':d.toFixed(2)+'°';}
async function refreshNearby(){
  if(!navigationUI.nearby||!state.sky||state.page!=='explore')return;
  const request=++navigationUI.nearbyRequest,p=currentField(),selected=$('#nearby-radius').value,radius=selected==='auto'?Math.min(30,Math.max(.5,p.fov*2)):Number(selected);
  try{
    const d=await api('/api/navigation/nearby?'+new URLSearchParams({ra:p.ra,dec:p.dec,radius,mission:$('#nearby-mission').value,limit:6}));
    if(request!==navigationUI.nearbyRequest||!navigationUI.nearby)return;
    navigationUI.nearbyData=d;
    $('#nearby-status').textContent=`${fmt(d.indexed_pointings_in_radius,0)} indexed pointings within ${radius}° · ${d.rows.length} distinct suggestions`;
    $('#nearby-provenance').textContent=`Index refreshed ${date(d.index_updated_at)}. ${d.note}`;
    const rows=[...d.rows,...d.releases];
    $('#nearby-results').innerHTML=rows.length?rows.map((m,i)=>`<article class="nearby-card"><button class="nearby-preview" data-nearby-inspect="${i}" aria-label="Inspect ${esc(m.title)}">${m.preview_url?`<img src="${esc(m.preview_url)}" alt="${esc(m.title)}" loading="lazy">`:'<span>SCIENCE<br>DATA</span>'}</button><div><div class="nearby-meta">${esc(m.mission)} · ${angularDistance(m.distance_deg)}</div><h3>${esc(m.title)}</h3><div class="coverage-tag ${m.contains_view_center?'inside':''}">${esc(m.coverage_label)}</div><p>${esc(m.filters||m.classification||'')}${m.observed_at?' · '+m.observed_at.slice(0,10)+' UTC':''}</p><div class="nearby-actions"><button class="text-button" data-nearby-visit="${i}">Visit ↗</button><button class="text-button" data-nearby-add="${i}">+ Route</button></div></div></article>`).join(''):'<p class="small muted">No indexed pointings in this radius. Increase the search radius or update the image index.</p>';
    $$('[data-nearby-inspect]').forEach(b=>b.onclick=()=>inspectNavigationMedia(rows[Number(b.dataset.nearbyInspect)]));
    $$('[data-nearby-visit]').forEach(b=>b.onclick=()=>visitNavigationMedia(rows[Number(b.dataset.nearbyVisit)]));
    $$('[data-nearby-add]').forEach(b=>b.onclick=()=>addNavigationStop(rows[Number(b.dataset.nearbyAdd)]).catch(failure));
    $$('#nearby-results img').forEach(img=>{img.onerror=()=>{img.hidden=true;img.parentElement.classList.add('preview-missing');};});
    $('#nearby-tour').disabled=!d.rows.length;
  }catch(e){if(request===navigationUI.nearbyRequest)$('#nearby-status').textContent='Suggestions unavailable · '+e.message;}
}
function drawNavigationFootprint(region){
  if(!state.sky)return;
  if(navigationUI.footprint){state.sky.removeOverlay(navigationUI.footprint);navigationUI.footprint=null;}
  if(!region)return;
  try{const layer=A.graphicOverlay({name:'Guided observation footprint',color:'#efc38b',lineWidth:2});layer.addFootprints(A.footprintsFromSTCS(region));state.sky.addOverlay(layer);navigationUI.footprint=layer;}catch{}
}
function storySourcesMarkup(media){
  const sources=(Array.isArray(media?.story_sources)?media.story_sources:[]).filter(s=>s&&typeof s.url==='string'&&/^https:\/\/[^\s]+$/i.test(s.url)&&typeof s.title==='string');
  if(!sources.length)return '';
  return `<details class="tour-story-sources"><summary>Story sources</summary><ul>${sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)} ↗</a></li>`).join('')}</ul></details>`;
}
async function inspectNavigationMedia(m){
  if(!m?.available)return;interruptTour('Paused to inspect the source');if(flight.active)pauseFlight();
  try{
    if(m.kind==='gallery')openGalleryPhoto(await api('/api/gallery/photos/'+m.id));
    else if(m.kind==='mast')openRecentObservation(await api('/api/recent/observations/'+m.id));
    else if(m.kind==='cefca')modal(m.title,`<p>${esc(m.description)}</p>${storySourcesMarkup(m)}<p class="small muted">${esc(m.credit)} · JAST80 / T80Cam</p><p>RA ${Number(m.ra).toFixed(6)}° · Dec ${Number(m.dec).toFixed(6)}°</p><a class="button" href="${esc(m.source_url)}" target="_blank" rel="noopener">Read the original Spanish guide ↗</a>`);
    else{setNearbyVisible(false);toggleMapping(true);showObjectDetail(m);}
  }catch(e){failure(e);}
}
function showTourStopDetails(m){
  if(!m)return;pauseRoute('Paused to read about this stop');
  modal(m.title,`<p>${esc(m.description||'No guide text is available for this stop.')}</p>${storySourcesMarkup(m)}<p class="small muted">Guide source: ${esc(m.credit||m.location_note||'Published target information')}</p>${m.source_url?`<a class="button" href="${esc(m.source_url)}" target="_blank" rel="noopener">Read the publisher source ↗</a>`:''}`);
}
function visitNavigationMedia(m){
  flyTo({name:m.title,ra:m.ra,dec:m.dec,fov:m.fov,survey:m.survey,type:m.mission||'PUBLISHED GUIDE',description:m.description?.slice(0,300)});drawNavigationFootprint(m.footprint);
}
async function ensureEditor(){
  if(navigationUI.editor?.kind==='waypoints')return navigationUI.editor;
  if(navigationUI.dirty)await saveEditedRoute();
  const r=await jsonPost('/api/navigation/routes',{title:'My exploration route',description:'',kind:'waypoints',stops:[],track:[]});
  navigationUI.editor=r;navigationUI.dirty=false;renderRouteEditor();await loadSavedRoutes();return r;
}
async function addNavigationStop(media){
  const r=await ensureEditor();if(r.stops.length>=100)throw new Error('A route can hold up to 100 waypoints. Start another route for more.');
  r.stops.push(navigationStop(media));r.media.push(media);markRouteDirty();renderRouteEditor();toast('Added to '+r.title);await saveEditedRoute();
}
async function addCurrentRouteStop(){
  const r=await ensureEditor();if(r.stops.length>=100)throw new Error('This route has reached 100 waypoints.');
  const p=tourSurveyView(skyView());r.stops.push({...p,title:'Waypoint '+(r.stops.length+1),notes:'',travel:4,hold:12,source:null});r.media.push(null);markRouteDirty();renderRouteEditor();await saveEditedRoute();toast('Current view added to '+r.title);
}
function markRouteDirty(){
  navigationUI.dirty=true;navigationUI.editVersion++;$('#route-save-status').textContent='Unsaved changes';
  clearTimeout(navigationUI.autoSave);navigationUI.autoSave=setTimeout(()=>saveEditedRoute().catch(e=>{$('#route-save-status').textContent='Not saved · '+e.message;}),1500);
}
async function saveEditedRoute(){
  const n=navigationUI;if(!n.editor||!n.dirty)return n.editor;
  if(n.savePromise)return n.savePromise;
  clearTimeout(n.autoSave);
  n.savePromise=(async()=>{
    while(n.dirty){
      const r=n.editor,version=n.editVersion,payload=JSON.parse(JSON.stringify(routePayload(r)));
      $('#route-save-status').textContent='Saving on this PC…';
      const saved=await api('/api/navigation/routes/'+r.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,revision:r.revision})});
      r.revision=saved.revision;r.updated_at=saved.updated_at;
      if(version===n.editVersion){n.dirty=false;r.media=saved.media;$('#route-save-status').textContent='Saved · revision '+saved.revision;}
    }
    await loadSavedRoutes();return n.editor;
  })();
  try{return await n.savePromise;}finally{n.savePromise=null;}
}
async function editSavedRoute(id){
  if(routeRecorder.active&&routeRecorder.route?.id===id)throw new Error('Stop and save this recording before editing it.');
  if(navigationUI.dirty)await saveEditedRoute();
  navigationUI.editor=await api('/api/navigation/routes/'+id);navigationUI.dirty=false;renderRouteEditor();
}
async function loadSavedRoutes(){
  const d=await api('/api/navigation/routes');navigationUI.routes=d.rows;renderSavedRoutes();
}
function renderSavedRoutes(){
  const search=$('#route-filter').value.toLowerCase();const rows=navigationUI.routes.filter(r=>(r.title+' '+r.description).toLowerCase().includes(search));
  $('#saved-route-list').innerHTML=rows.length?rows.map(r=>`<button class="saved-route ${r.id===navigationUI.editor?.id?'selected':''}" data-route-id="${r.id}"><span>${r.kind==='recording'?'◉':'⌁'}</span><div><strong>${esc(r.title)}</strong><small>${r.kind==='recording'?r.sample_count+' recorded samples':r.stop_count+' waypoints'} · ${routeTime(r.duration)}<br>${date(r.updated_at)}</small></div></button>`).join(''):'<p class="small muted">Your saved routes will appear here. Add sky positions, copy a guided tour, or record a flight.</p>';
  $$('[data-route-id]').forEach(b=>b.onclick=()=>editSavedRoute(b.dataset.routeId).catch(failure));
}
function renderRouteOverview(r){
  const points=r.kind==='recording'?r.track.filter((_,i)=>i%Math.max(1,Math.floor(r.track.length/180))===0):r.stops;
  const x=ra=>(360-ra)%360/360*800,y=dec=>(90-dec)/180*200;
  let path='',last=null;
  for(let i=0;i<points.length;i++){
    const steps=last?Array.from({length:12},(_,n)=>FlightMath.interpolate(last,points[i],(n+1)/12)):[points[i]];
    for(const p of steps){const px=x(p.ra),py=y(p.dec);path+=(last&&Math.abs(px-x(last.ra))<400?' L':' M')+px.toFixed(2)+' '+py.toFixed(2);last=p;}
  }
  $('#route-overview').innerHTML=`<svg viewBox="0 0 800 200" role="img" aria-label="Route overview in right ascension and declination"><defs><linearGradient id="route-line"><stop stop-color="#93e3d0"/><stop offset="1" stop-color="#f0c18d"/></linearGradient></defs>${[50,100,150].map(v=>`<path d="M0 ${v}H800" class="route-grid"/>`).join('')}${[100,200,300,400,500,600,700].map(v=>`<path d="M${v} 0V200" class="route-grid"/>`).join('')}<path d="${path}" class="route-line"/>${points.filter((_,i)=>r.kind!=='recording'||i===0||i===points.length-1).map((p,i)=>`<circle cx="${x(p.ra)}" cy="${y(p.dec)}" r="4"/><text x="${x(p.ra)+7}" y="${y(p.dec)-5}">${r.kind==='recording'?'':i+1}</text>`).join('')}</svg><span>Angular itinerary · RA / Dec · spacing is not physical distance</span>`;
}
function renderRouteEditor(){
  const r=navigationUI.editor;$('#route-editor').hidden=!r;$('#route-editor-empty').hidden=Boolean(r);if(!r)return;
  $('#route-title').value=r.title;$('#route-description').value=r.description;
  $('#route-editor-kind').textContent=r.kind==='recording'?'RECORDED FLIGHT':'WAYPOINT ROUTE';
  $('#route-save-status').textContent=navigationUI.dirty?'Unsaved changes':'Saved · revision '+r.revision;
  $('#route-optimize').hidden=r.kind==='recording';$('#route-add-view').hidden=r.kind==='recording';
  $('#route-play-resume').hidden=!r.progress;renderRouteOverview(r);
  if(r.kind==='recording'){
    $('#route-stop-list').innerHTML=`<div class="recording-summary"><strong>${fmt(r.track.length,0)} camera samples</strong><p>${routeTime(r.track.at(-1)?.t||0)} recorded. Position, zoom, rotation and projection are retained. Playback uses your selected full-sky survey throughout.</p><p class="small muted">Export this route to keep a portable copy. The file contains camera data and source references, not telescope image files.</p></div>`;return;
  }
  $('#route-stop-list').innerHTML=r.stops.length?r.stops.map((s,i)=>`<article class="route-stop-editor"><div class="stop-number">${i+1}</div><div class="stop-main"><label>Stop title<input type="text" data-stop-title="${i}" value="${esc(s.title)}" maxlength="200" required></label><div class="stop-source">${s.source?esc(r.media[i]?.title||s.source.kind+' '+s.source.id):'User-saved waypoint'}${r.media[i]?.available===false?' · source unavailable':''}</div><div class="stop-timing"><label>Travel (sec)<input data-stop-number="${i}:travel" type="number" min="1" max="30" step="1" value="${s.travel}"></label><label>Explore (sec)<input data-stop-number="${i}:hold" type="number" min="3" max="120" step="1" value="${s.hold}"></label></div><details><summary>Coordinates & notes</summary><div class="stop-timing"><label>RA (degrees)<input data-stop-number="${i}:ra" type="number" min="0" max="359.999999999" step="any" value="${s.ra}"></label><label>Dec (degrees)<input data-stop-number="${i}:dec" type="number" min="-90" max="90" step="any" value="${s.dec}"></label><label>Field (degrees)<input data-stop-number="${i}:fov" type="number" min="0.001" max="360" step="any" value="${s.fov}"></label></div><textarea data-stop-notes="${i}" maxlength="4000" placeholder="Your observing notes">${esc(s.notes)}</textarea></details></div><div class="stop-edit-actions"><button class="text-button" data-stop-move="${i}:-1" ${i===0?'disabled':''} aria-label="Move stop ${i+1} up">↑</button><button class="text-button" data-stop-move="${i}:1" ${i===r.stops.length-1?'disabled':''} aria-label="Move stop ${i+1} down">↓</button><button class="text-button" data-stop-visit="${i}" aria-label="Visit stop ${i+1}">↗</button><button class="text-button" data-stop-remove="${i}" aria-label="Remove stop ${i+1}">×</button></div></article>`).join(''):'<p class="empty-route">Add the current view or use <strong>+ Route</strong> on a nearby image suggestion.</p>';
  $$('[data-stop-title]').forEach(el=>el.oninput=()=>{r.stops[Number(el.dataset.stopTitle)].title=el.value;markRouteDirty();});
  $$('[data-stop-notes]').forEach(el=>el.oninput=()=>{r.stops[Number(el.dataset.stopNotes)].notes=el.value;markRouteDirty();});
  $$('[data-stop-number]').forEach(el=>{el.oninput=()=>{if(!el.checkValidity()||!Number.isFinite(el.valueAsNumber))return;const [i,key]=el.dataset.stopNumber.split(':');r.stops[Number(i)][key]=el.valueAsNumber;markRouteDirty();renderRouteOverview(r);};el.onchange=()=>{if(el.reportValidity())el.oninput();};});
  $$('[data-stop-remove]').forEach(el=>el.onclick=()=>{const i=Number(el.dataset.stopRemove);r.stops.splice(i,1);r.media.splice(i,1);markRouteDirty();renderRouteEditor();});
  $$('[data-stop-move]').forEach(el=>el.onclick=()=>{const [i,d]=el.dataset.stopMove.split(':').map(Number);[r.stops[i],r.stops[i+d]]=[r.stops[i+d],r.stops[i]];[r.media[i],r.media[i+d]]=[r.media[i+d],r.media[i]];markRouteDirty();renderRouteEditor();});
  $$('[data-stop-visit]').forEach(el=>el.onclick=()=>{const s=r.stops[Number(el.dataset.stopVisit)];flyTo({name:s.title,...tourSurveyView(s)});});
  renderSavedRoutes();
}
async function loadNavigationPage(){
  await loadSavedRoutes();
  const d=await api('/api/navigation/templates');navigationUI.templates=d.rows;navigationUI.loaded=true;renderTourTemplates();
}
function renderTourTemplates(){
  const rows=navigationUI.templates.map((r,i)=>({r,i})),cefca=rows.filter(({r})=>r.collection==='cefca');
  $('#cefca-tour-section').hidden=!cefca.length;
  $('#cefca-guided-tours').innerHTML=cefca.map(({r,i})=>`<article class="cefca-tour-card"><div class="cefca-tour-body"><div class="cefca-tour-tags"><span>${r.stops.length} sky stops</span><span>Full-sky surveys</span><span>${routeTime(r.stops.reduce((n,s)=>n+s.travel+s.hold,0))} without narration</span></div><h3>${esc(r.title)}</h3><p>${esc(r.description)}</p><p class="cefca-tour-language">Researched English stories · Original guide in Spanish · CEFCA Foundation</p><div class="cefca-tour-actions"><button class="button primary" data-template-start="${i}">Start Virgo tour ↗</button><button class="button" data-template-copy="${i}">Customize route</button><a href="${esc(r.source_url)}" target="_blank" rel="noopener">Original Spanish tour ↗</a></div></div></article>`).join('');
  $('#guided-tours').innerHTML=rows.filter(({r})=>r.collection!=='cefca').map(({r,i})=>`<article class="tour-card"><div class="tour-card-body"><span class="overline">${r.stops.length} SKY STOPS · ${routeTime(r.stops.reduce((n,s)=>n+s.travel+s.hold,0))} WITHOUT NARRATION</span><h2>${esc(r.title)}</h2><p>${esc(r.description)}</p><button class="button primary" data-template-start="${i}">Start guided tour ↗</button><button class="text-button" data-template-copy="${i}">Customize</button></div></article>`).join('');
  $$('[data-template-start]').forEach(b=>b.onclick=()=>busy(b,'Preparing…',async()=>{const r=await jsonPost('/api/navigation/routes',routePayload(navigationUI.templates[Number(b.dataset.templateStart)]));await loadSavedRoutes();await playSavedRoute(r.id);}));
  $$('[data-template-copy]').forEach(b=>b.onclick=()=>busy(b,'Copying…',async()=>{if(navigationUI.dirty)await saveEditedRoute();const template=navigationUI.templates[Number(b.dataset.templateCopy)];const r=await jsonPost('/api/navigation/routes',{...routePayload(template),title:template.title+' · my route'});await loadSavedRoutes();await editSavedRoute(r.id);$('#route-editor').scrollIntoView({behavior:'smooth',block:'start'});}));
}
async function nearbyTour(){
  const rows=navigationUI.nearbyData?.rows||[];if(!rows.length)return;
  const order=RouteTimeline.nearestOrder(rows,skyView()),stops=order.map(i=>navigationStop(rows[i]));
  const r=await jsonPost('/api/navigation/routes',{title:'Nearby observations · '+new Date().toLocaleDateString(),description:'Explore nearby observation positions on a continuous full-sky survey, with their published guide text and source links.',kind:'waypoints',stops,track:[]});
  await loadSavedRoutes();await playSavedRoute(r.id);
}
function initNavigation(){
  $('#nearby-toggle').onclick=()=>{const enabled=!navigationUI.nearby;if(enabled){pauseRouteForFlight();showPage('explore');}setNearbyVisible(enabled,true);};$('#nearby-close').onclick=()=>setNearbyVisible(false,true);
  $('#nearby-mission').onchange=()=>refreshNearby().catch(failure);$('#nearby-radius').onchange=()=>refreshNearby().catch(failure);$('#nearby-refresh').onclick=()=>refreshNearby().catch(failure);
  $('#nearby-tour').onclick=()=>nearbyTour().catch(failure);$('#open-routes').onclick=()=>showPage('routes');$('#flight-routes').onclick=()=>showPage('routes');
  $('#new-route').onclick=async()=>{try{if(navigationUI.dirty)await saveEditedRoute();const r=await jsonPost('/api/navigation/routes',{title:'Untitled route',description:'',kind:'waypoints',stops:[],track:[]});await loadSavedRoutes();await editSavedRoute(r.id);}catch(e){failure(e);}};
  $('#route-filter').oninput=renderSavedRoutes;
  $('#route-title').oninput=e=>{navigationUI.editor.title=e.target.value;markRouteDirty();};$('#route-description').oninput=e=>{navigationUI.editor.description=e.target.value;markRouteDirty();};
  $('#route-save').onclick=()=>saveEditedRoute().catch(failure);$('#route-add-view').onclick=()=>addCurrentRouteStop().catch(failure);$('#flight-route-add').onclick=()=>addCurrentRouteStop().catch(failure);
  $('#route-optimize').onclick=()=>{const r=navigationUI.editor,order=RouteTimeline.nearestOrder(r.stops,skyView());r.stops=order.map(i=>r.stops[i]);r.media=order.map(i=>r.media[i]);markRouteDirty();renderRouteEditor();toast('Stops ordered by a nearest-neighbor angular path.');};
  const play=async resume=>{const r=await saveEditedRoute();if(r)await playSavedRoute(r.id,resume);};
  $('#route-play').onclick=()=>play(false).catch(failure);$('#route-play-resume').onclick=()=>play(true).catch(failure);
  $('#route-duplicate').onclick=async()=>{try{const r=await saveEditedRoute(),copy=await jsonPost('/api/navigation/routes',{...routePayload(r),title:r.title+' · copy'});await loadSavedRoutes();await editSavedRoute(copy.id);}catch(e){failure(e);}};
  $('#route-export').onclick=async()=>{const r=navigationUI.editor;if(!r)return;const filename=r.title.replace(/[^a-z0-9 -]/gi,'').slice(0,80)+'.universe-route.json';try{await saveEditedRoute();download(await api('/api/navigation/routes/'+r.id+'/export'),filename);}catch(e){download({schema:'universe-explorer-route',version:1,route:routePayload(r)},filename);toast('Current edits exported for recovery. Save on PC failed: '+e.message,true);}};
  $('#route-reload').onclick=()=>{const r=navigationUI.editor;const reload=async()=>{clearTimeout(navigationUI.autoSave);if(navigationUI.savePromise)try{await navigationUI.savePromise;}catch{}navigationUI.dirty=false;await editSavedRoute(r.id);closeModal();};if(!navigationUI.dirty){reload().catch(failure);return;}modal('Reload the saved version?',`<p>Use Export route first to keep your current edits. Reloading replaces this editor with the version saved on this PC.</p><button id="confirm-route-reload" class="button">Reload saved version</button>`);$('#confirm-route-reload').onclick=()=>reload().catch(failure);};
  $('#route-import').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>2*1024*1024)throw new Error('Route imports are limited to 2 MB.');if(navigationUI.dirty)await saveEditedRoute();const r=await jsonPost('/api/navigation/import',JSON.parse(await file.text()));await loadSavedRoutes();await editSavedRoute(r.id);toast('Route imported as a new local copy.');}catch(error){failure(error);}finally{e.target.value='';}};
  $('#route-delete').onclick=()=>{const r=navigationUI.editor;modal('Delete saved route?',`<p>Remove <strong>${esc(r.title)}</strong> from this PC? Its telescope images and notebook entries remain available.</p><button id="confirm-route-delete" class="button">Delete this route</button>`);$('#confirm-route-delete').onclick=async()=>{try{clearTimeout(navigationUI.autoSave);if(navigationUI.savePromise)await navigationUI.savePromise;await api('/api/navigation/routes/'+r.id+'?revision='+r.revision,{method:'DELETE'});navigationUI.editor=null;navigationUI.dirty=false;closeModal();renderRouteEditor();await loadSavedRoutes();}catch(e){failure(e);}};};
  $('#recording-rescue').onclick=()=>{if(routeRecorder.route)download({schema:'universe-explorer-route',version:1,route:routePayload(routeRecorder.route)},'recorded-flight-backup.universe-route.json');};
  try{navigationUI.nearbyPreference=localStorage.getItem('universe-nearby')!=='false';}catch{}
  setNearbyVisible(navigationUI.nearbyPreference);initRoutePlayer();
}
