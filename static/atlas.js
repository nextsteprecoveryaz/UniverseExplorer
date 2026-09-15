'use strict';
const atlasUI={enabled:true,busy:false,timer:null,serial:0,layer:null,loaded:null,lastAttempt:null,cachedOnly:false,prefetched:new Set(),prefetchTimer:null,detailPriority:true,pack:null,packLayer:null,packIndex:-1,autoPack:null,warm:null,warmSurvey:null,warmAt:0};
function atlasMapBusy(){return atlasUI.detailPriority&&state.sky?.isStillActive?.();}
function atlasSurveyURL(s){return location.origin+'/api/atlas/surveys/'+s.id;}
function atlasMessage(text){$('#atlas-message').textContent=text;}
const scienceTrail=new Map();let scienceRefineTimer;
function clearScienceTrail(){for(const key of scienceTrail.keys())state.sky?.removeImageLayer(key);scienceTrail.clear();}
function atlasClear(){clearTimeout(scienceRefineTimer);atlasUI.serial++;clearScienceTrail();atlasUI.layer=null;atlasUI.loaded=null;$('#atlas-details').disabled=true;}
function onAtlasViewChanged(){
  if(!$('#atlas-message')||state.page!=='explore')return;
  clearTimeout(atlasUI.timer);
  clearTimeout(scienceRefineTimer);
  try{atlasWarmFlight();}catch(e){$('#atlas-prefetch').checked=false;toast('Preloading paused: '+e.message,true);}
  if(!atlasUI.enabled||atlasUI.cachedOnly||atlasUI.pack)return;
  if(state.fov>1){atlasMessage('Zoom below 1° to load an original science cutout.');return;}
  atlasUI.timer=setTimeout(()=>loadAutomaticScience().catch(e=>atlasMessage(e.message)),1200);
}
function atlasWarmFlight(){
  // Offscreen viewers share download slots with the visible map. Keep those slots
  // available for detail by default; ahead-of-flight warming remains optional.
  if(atlasUI.detailPriority)return;
  if(!flight.active||!flight.camera||atlasUI.cachedOnly||!$('#atlas-prefetch').checked||Date.now()-atlasUI.warmAt<2000||flight.velocity.every(v=>Math.abs(v)<.02))return;
  atlasUI.warmAt=Date.now();
  const fov=state.sky.getFov()[0],rate=Math.max(.0002,fov)*.5;
  const pose=FlightMath.orientation(FlightMath.turn(flight.camera,flight.velocity[0]*rate,flight.velocity[1]*rate,flight.velocity[3]*35));
  const nextFov=FlightMath.zoom(fov,flight.velocity[2]*.85,1);
  if(!atlasUI.warm){
    const shell=document.createElement('div');shell.className='atlas-preloader-shell';shell.setAttribute('aria-hidden','true');shell.inert=true;
    shell.style.width=$('#aladin-lite-div').clientWidth+'px';shell.style.height=$('#aladin-lite-div').clientHeight+'px';
    const host=document.createElement('div');host.id='atlas-flight-preloader';shell.append(host);document.body.append(shell);
    atlasUI.warm=A.aladin('#atlas-flight-preloader',{survey:atlasSurveyURL(state.config.surveys.find(s=>s.id===state.survey)),target:`${pose.ra} ${pose.dec}`,fov:nextFov,projection:'TAN',showStatusBar:false,showLayersControl:false,showGotoControl:false,showShareControl:false,showContextMenu:false});
    atlasUI.warmSurvey=state.survey;
  }
  if(atlasUI.warmSurvey!==state.survey){atlasUI.warm.setImageSurvey(atlasSurveyURL(state.config.surveys.find(s=>s.id===state.survey)));atlasUI.warmSurvey=state.survey;}
  atlasUI.warm.gotoRaDec(pose.ra,pose.dec);atlasUI.warm.setFoV(nextFov);atlasUI.warm.setRotation(pose.roll);
}
async function awaitAtlasJob(job,stillWanted=()=>true,onProgress=()=>{}){
  while(job.state==='queued'||job.state==='running'){
    if(!stillWanted())return null;
    onProgress(job);
    await new Promise(resolve=>setTimeout(resolve,900));
    job=await api('/api/atlas/jobs/'+job.id);
  }
  if(job.state!=='complete')throw new Error(job.error||'Download cancelled.');
  return job.result;
}
async function loadAutomaticScience(force=false,quality=512){
  if(!state.sky||atlasUI.busy||(!atlasUI.enabled&&!force)||atlasUI.cachedOnly||atlasUI.pack||state.page!=='explore')return;
  if(!force&&atlasMapBusy()){
    clearTimeout(atlasUI.timer);
    atlasUI.timer=setTimeout(()=>loadAutomaticScience().catch(e=>atlasMessage(e.message)),500);
    return;
  }
  const view={...currentField()};if(view.fov>1){atlasMessage('Zoom below 1° to load an original science cutout.');return;}
  if(!force&&atlasUI.loaded&&FlightMath.separation(view,atlasUI.loaded)<atlasUI.loaded.fov*.2&&view.fov>atlasUI.loaded.fov*.4)return;
  if(!force&&atlasUI.lastAttempt&&Date.now()-atlasUI.lastAttempt.time<30000&&FlightMath.separation(view,atlasUI.lastAttempt)<view.fov*.2)return;
  atlasUI.busy=true;atlasUI.lastAttempt={...view,time:Date.now()};const serial=++atlasUI.serial;
  atlasMessage('Checking all indexed footprints…');
  try{
    const nearby=await api('/api/navigation/nearby?'+new URLSearchParams({ra:view.ra,dec:view.dec,radius:Math.max(.1,view.fov),limit:8,mission:$('#atlas-mission').value}));
    const source=nearby.rows.find(m=>m.contains_view_center===true);
    if(!source){atlasMessage('No supported fixed-target footprint covers this position.');return;}
    atlasMessage(`Loading ${source.mission} ${source.filters||''} · bounded FITS transfer…`);
    const job=await jsonPost('/api/atlas/prepare',{record_id:String(source.id),ra:Number(view.ra.toFixed(7)),dec:Number(view.dec.toFixed(7)),fov:Number(Math.min(.3,view.fov).toFixed(7)),quality});
    const item=await awaitAtlasJob(job,()=>serial===atlasUI.serial);
    if(!item||serial!==atlasUI.serial)return;
    const current=currentField();
    if(state.page!=='explore'||!atlasUI.enabled||FlightMath.separation(current,view)>Math.max(item.fov*.45,view.fov*.2)){atlasMessage('Cutout cached. Move back to its field to view it.');return;}
    if(atlasUI.loaded&&atlasUI.loaded.source_uri!==item.source_uri)clearScienceTrail();
    const trailKey='science-trail-'+item.id;
    if(scienceTrail.has(trailKey)){state.sky.removeImageLayer(trailKey);scienceTrail.delete(trailKey);}
    while(scienceTrail.size>=4){const oldest=scienceTrail.keys().next().value;state.sky.removeImageLayer(oldest);scienceTrail.delete(oldest);}
    const layer=A.image(item.url,{name:item.mission+' '+item.filters+' · original SCI cutout',imgFormat:'fits',colormap:'grayscale',stretch:'asinh',minCut:item.min_cut,maxCut:item.max_cut,opacity:Number($('#atlas-opacity').value)/100,
      successCallback:()=>{if(serial===atlasUI.serial){atlasUI.loaded=item;$('#atlas-details').disabled=false;atlasMessage(`${item.mission} · ${item.filters} · ${item.width}px · ${(item.fov*60).toFixed(2)}′ cutout · ${(item.downloaded_bytes/1048576).toFixed(1)} MB read`);if(quality===512&&$('#atlas-refine')?.checked){scienceRefineTimer=setTimeout(()=>{if(state.page==='explore'&&FlightMath.separation(currentField(),view)<item.fov*.2&&(!flight.active||flight.velocity.every(v=>Math.abs(v)<.01)))loadAutomaticScience(true,1024).catch(e=>atlasMessage(e.message));},6500);}}},
      errorCallback:()=>atlasMessage('The science cutout could not render. Source details remain in the archive.')});
    atlasUI.layer=layer;scienceTrail.set(trailKey,layer);state.sky.setOverlayImageLayer(layer,trailKey);
  }finally{
    atlasUI.busy=false;
    if(serial===atlasUI.serial&&state.page==='explore'&&FlightMath.separation(currentField(),view)>view.fov*.2)onAtlasViewChanged();
  }
}
function scienceDetails(){
  const m=atlasUI.loaded;if(!m)return;
  modal('Original observation on the sky',`<div class="atlas-facts"><strong>${esc(m.observation)}</strong><p>${esc(m.mission)} · ${esc(m.filters)} · SCI extension: ${esc(m.source_hdu)}</p><p>${esc(m.processing)}</p><p>Exposure start: ${m.observed_mjd!=null?esc(new Date((m.observed_mjd-40587)*86400000).toISOString()):'Not reported'}</p><p>Source: ${(m.source_bytes/1e9).toFixed(2)} GB · transferred ${(m.downloaded_bytes/1048576).toFixed(2)} MB in ${m.range_requests} range requests.</p><p>${(m.finite_fraction*100).toFixed(1)}% valid display pixels. WCS round-trip residual: ${Number(m.wcs_roundtrip_pixels).toExponential(2)} source pixels. This checks transformation consistency, not absolute astrometric accuracy.</p><p>Retrieved ${esc(date(m.created_at))}. The grayscale cutout is a processed display of this one filter. It does not replace the released color survey.</p><a class="button" href="${esc(m.url)}" download="${esc(m.observation)}-display.fits">Download display FITS</a><button class="button" id="atlas-open-observation">Inspect original observation</button><p class="small">Original URI: ${esc(m.source_uri)}</p><p class="small">Display SHA-256: ${esc(m.sha256)}</p></div>`);
  $('#atlas-open-observation').onclick=async()=>{closeModal();openRecentObservation(await api('/api/recent/observations/'+m.record_id));};
}
function atlasPrefetch(route,index){
  clearTimeout(atlasUI.prefetchTimer);
  if(atlasUI.cachedOnly||!$('#atlas-prefetch').checked||route.kind!=='waypoints')return;
  if(atlasMapBusy()){
    atlasUI.prefetchTimer=setTimeout(()=>{if(routePlayer.route===route&&routePlayer.index===index&&state.page==='explore')atlasPrefetch(route,index);},500);
    return;
  }
  for(const stop of route.stops.slice(index+1,index+3)){
    const key=JSON.stringify([stop.ra,stop.dec,stop.fov,stop.survey]);if(atlasUI.prefetched.has(key))continue;
    atlasUI.prefetched.add(key);if(atlasUI.prefetched.size>200)atlasUI.prefetched.delete(atlasUI.prefetched.values().next().value);
    jsonPost('/api/atlas/view',Object.fromEntries(['ra','dec','fov','survey','projection','roll'].filter(k=>stop[k]!==undefined).map(k=>[k,stop[k]]))).then(job=>awaitAtlasJob(job)).catch(()=>atlasUI.prefetched.delete(key));
  }
}
async function atlasShowPackView(route,index){
  const pack=atlasUI.pack;if(pack&&(pack.route_id!==route.id||pack.revision!==route.revision)||index===atlasUI.packIndex)return;
  atlasUI.packIndex=index;let entry=pack?.views.find(v=>v.index===index);
  if(atlasUI.packLayer)state.sky.removeImageLayer('downloaded-tour-view');atlasUI.packLayer=null;
  if(!pack&&atlasUI.detailPriority)return;
  if(!pack&&$('#atlas-prefetch').checked&&!atlasUI.cachedOnly){
    const stop=route.stops[index];if(!stop)return;
    try{const job=await jsonPost('/api/atlas/view',Object.fromEntries(['ra','dec','fov','survey','projection','roll'].filter(k=>stop[k]!==undefined).map(k=>[k,stop[k]])));entry={view:await awaitAtlasJob(job,()=>routePlayer.route===route&&routePlayer.index===index)};}catch{return;}
    if(routePlayer.route!==route||routePlayer.index!==index)return;
  }
  if(!entry?.view){atlasMessage('This stop has no downloaded view.');return;}
  const v=entry.view,layer=A.image(v.url,{name:'Downloaded · '+v.survey_name,imgFormat:'png',wcs:v.wcs,opacity:1,successCallback:()=>{atlasMessage(`Downloaded view · ${v.survey_name} · 768 × 768`);if(!pack)setTimeout(()=>atlasRetirePreview(layer),500);},errorCallback:()=>atlasMessage('Saved view could not render.')});
  atlasUI.packLayer=layer;state.sky.setOverlayImageLayer(layer,'downloaded-tour-view');
}
function atlasRetirePreview(layer,attempt=0){
  if(atlasUI.pack||atlasUI.packLayer!==layer)return;
  if(state.sky.isStillActive?.()){if(attempt<40)setTimeout(()=>atlasRetirePreview(layer,attempt+1),300);return;}
  state.sky.removeImageLayer('downloaded-tour-view');atlasUI.packLayer=null;
  atlasMessage('Detailed survey tiles ready · prepared view released.');
}
function atlasStopPack(){clearTimeout(atlasUI.prefetchTimer);if(atlasUI.packLayer)state.sky?.removeImageLayer('downloaded-tour-view');atlasUI.packLayer=null;atlasUI.pack=null;atlasUI.packIndex=-1;}
async function loadAtlasDownloads(){
  const [d,r]=await Promise.all([api('/api/atlas/status'),api('/api/navigation/routes')]);atlasUI.cachedOnly=d.cached_only;
  $('#atlas-cached-only').checked=d.cached_only;
  $('#atlas-cache-summary').textContent=`${(d.bytes/1048576).toFixed(1)} MiB / ${(d.limit_bytes/1073741824).toFixed(0)} GiB · ${(d.pinned_bytes/1048576).toFixed(1)} MiB protected by downloads · ${fmt(d.coverage.indexed,0)} pointings indexed`;
  $('#atlas-cache-limit').value=String(d.limit_bytes/1073741824);
  $('#atlas-cache-space').textContent=`${(d.disk_free_bytes/1073741824).toFixed(0)} GiB free on this drive. Space is used as you explore; this limit does not reserve GPU memory.`;
  const selected=$('#atlas-download-route').value;
  $('#atlas-download-route').innerHTML=r.rows.filter(x=>x.kind==='waypoints'&&x.stop_count).map(x=>`<option value="${esc(x.id)}">${esc(x.title)} · ${x.stop_count} stops</option>`).join('');
  if([...$('#atlas-download-route').options].some(o=>o.value===selected))$('#atlas-download-route').value=selected;
  $('#atlas-download-start').disabled=!$('#atlas-download-route').options.length;
  $('#atlas-downloads').innerHTML=d.packs.map((p,i)=>`<article class="atlas-pack"><div><span class="eyebrow">${esc(p.state.toUpperCase())}</span><h3>${esc(p.title)}</h3><p>Revision ${p.revision} · ${p.views.filter(v=>v.view).length} / ${p.total} views saved · ${esc(date(p.created_at))}</p><p class="small">${p.errors.length} view errors · ${p.views.filter(v=>v.preview_error).length} source previews unavailable</p></div><div class="flex"><button class="button primary" data-pack-play="${i}" ${!p.views.some(v=>v.view)?'disabled':''}>Play downloaded tour</button><button class="button" data-pack-remove="${i}">Remove download</button></div></article>`).join('')||'<p class="muted">Choose a saved waypoint tour above to download its views.</p>';
  $$('[data-pack-play]').forEach(b=>b.onclick=()=>playAtlasPack(d.packs[Number(b.dataset.packPlay)]).catch(failure));
  $$('[data-pack-remove]').forEach(b=>b.onclick=()=>busy(b,'Removing…',async()=>{await api('/api/atlas/packs/'+d.packs[Number(b.dataset.packRemove)].id,{method:'DELETE'});await loadAtlasDownloads();}));
  $('#atlas-download-job').textContent=d.jobs.map(j=>j.progress||j.state).join(' · ');
  if(d.jobs.length){clearTimeout(atlasUI.autoPack);atlasUI.autoPack=setTimeout(()=>{if(state.page==='downloads')loadAtlasDownloads().catch(()=>{});},2000);}
}
async function playAtlasPack(pack){
  // Play the saved revision, retaining the exact views and captions downloaded with it.
  const route=structuredClone(pack.route);route.stops.forEach((stop,i)=>{
    const entry=pack.views.find(v=>v.index===i),m=route.media[i];
    if(m){m.preview_url=entry?.preview_url||null;if(entry?.preview_error)m.description+='\nThe source preview was not saved.';}
  });
  await startRouteDocument(route,pack);
}
function initAtlas(){
  try{atlasUI.detailPriority=localStorage.getItem('universe-atlas-detail-priority')!=='false';}catch{}
  api('/api/atlas/status').then(d=>{atlasUI.cachedOnly=d.cached_only;}).catch(()=>{});
  const nav=document.createElement('button');nav.className='nav-item';nav.textContent='◫ Compare lenses';nav.dataset.page='compare';nav.onclick=()=>showPage('compare');$('nav[aria-label="Workspace"]').append(nav);
  const downloads=document.createElement('button');downloads.className='nav-item';downloads.textContent='↓ Downloads & cache';downloads.dataset.page='downloads';downloads.onclick=()=>showPage('downloads');nav.after(downloads);
  const controls=document.createElement('section');controls.className='atlas-controls';controls.innerHTML=`<div class="section-label"><span class="overline">ORIGINAL OBSERVATIONS</span></div><label class="atlas-check"><input id="atlas-auto" type="checkbox" checked> Auto-load science cutouts</label><select id="atlas-mission" aria-label="Automatic observation telescope"><option value="both">Hubble + Webb</option><option value="webb">Webb only</option><option value="hubble">Hubble only</option></select><label class="field-label" for="atlas-opacity">Science layer opacity</label><input id="atlas-opacity" type="range" min="0" max="100" value="85"><p id="atlas-message" class="small muted" role="status">Zoom below 1° to load an original science cutout.</p><div class="flex"><button class="text-button" id="atlas-load">Load here</button><button class="text-button" id="atlas-details" disabled>Source details</button></div><label class="atlas-check"><input id="atlas-prefetch" type="checkbox" checked> Preload flight & tour views</label>`;
  $('.sidebar-footer').before(controls);
  const priority=document.createElement('label');priority.className='atlas-check';priority.innerHTML='<input id="atlas-detail-priority" type="checkbox"> Prioritize visible map detail';controls.append(priority);
  priority.title='Give visible survey tiles priority. Ahead-of-flight previews pause; automatic science cutouts and upcoming tour previews wait for the map.';
  $('#atlas-detail-priority').checked=atlasUI.detailPriority;
  $('#atlas-detail-priority').onchange=e=>{atlasUI.detailPriority=e.target.checked;try{localStorage.setItem('universe-atlas-detail-priority',String(atlasUI.detailPriority));}catch{}onAtlasViewChanged();};
  const page=document.createElement('section');page.id='downloads-page';page.className='page content-page';page.innerHTML=`<div class="page-heading"><div class="overline">TAKE THE SKY WITH YOU</div><h1>Your downloaded universe<span>.</span></h1><p>Save the views and available source previews from a waypoint tour. Browse visited map tiles from this PC.</p></div><div class="atlas-download-bar"><label for="atlas-download-route">Saved waypoint tour</label><select id="atlas-download-route"></select><button id="atlas-download-start" class="button primary">Download tour views</button><button id="atlas-download-cancel" class="button" hidden>Cancel remaining views</button><button id="atlas-download-refresh" class="button">Refresh</button></div><p id="atlas-download-job" role="status"></p><div class="atlas-cache-bar"><label class="atlas-check"><input id="atlas-cached-only" type="checkbox"> Cached-only atlas</label><span id="atlas-cache-summary"></span></div><p class="muted">Downloads retain 768 × 768 survey views at each saved stop, plus available image previews and captions. Flight between stops uses cached map tiles. Unvisited areas, higher detail, videos, new catalog searches and AI cloud processing need a connection. Black survey areas may have no telescope coverage.</p><div id="atlas-downloads"></div>`;$('main').append(page);
  $('#atlas-auto').onchange=e=>{atlasUI.enabled=e.target.checked;atlasClear();if(atlasUI.enabled)onAtlasViewChanged();else atlasMessage('Automatic science layers are off.');};
  $('#atlas-mission').onchange=()=>{atlasClear();atlasUI.lastAttempt=null;onAtlasViewChanged();};
  $('#atlas-opacity').oninput=e=>{for(const layer of scienceTrail.values())layer.setOpacity(Number(e.target.value)/100);};
  $('#atlas-details').onclick=scienceDetails;$('#atlas-load').onclick=()=>{if(!atlasUI.enabled){atlasUI.enabled=true;$('#atlas-auto').checked=true;}loadAutomaticScience(true).catch(e=>atlasMessage(e.message));};
  $('#atlas-download-start').onclick=()=>busy($('#atlas-download-start'),'Queuing…',async()=>{const j=await api('/api/atlas/packs/'+$('#atlas-download-route').value,{method:'POST'});$('#atlas-download-cancel').hidden=false;$('#atlas-download-cancel').onclick=async()=>{await api('/api/atlas/jobs/'+j.id+'/cancel',{method:'POST'});$('#atlas-download-cancel').hidden=true;};await loadAtlasDownloads();});
  $('#atlas-download-refresh').onclick=()=>loadAtlasDownloads().catch(failure);
  const cacheSettings=document.createElement('div');cacheSettings.className='atlas-download-bar';cacheSettings.innerHTML='<label for="atlas-cache-limit">Map cache on disk</label><select id="atlas-cache-limit">'+[1,4,8,16,32,64].map(n=>`<option value="${n}">${n} GiB</option>`).join('')+'</select><button class="button" id="atlas-cache-save">Save cache size</button><span id="atlas-cache-space" class="small muted"></span>';
  $('.atlas-cache-bar').after(cacheSettings);
  $('#atlas-cache-save').onclick=()=>busy($('#atlas-cache-save'),'Saving…',async()=>{await jsonPost('/api/atlas/cache-settings',{limit_gib:Number($('#atlas-cache-limit').value)});await loadAtlasDownloads();toast('Map cache size saved.');});
  $('#atlas-cached-only').onchange=async e=>{try{const d=await api('/api/atlas/cached-only?enabled='+e.target.checked,{method:'POST'});atlasUI.cachedOnly=d.cached_only;atlasMessage(d.cached_only?'Cached-only atlas · automatic downloads paused.':'Online atlas · local cache enabled.');}catch(err){e.target.checked=atlasUI.cachedOnly;failure(err);}};
}
