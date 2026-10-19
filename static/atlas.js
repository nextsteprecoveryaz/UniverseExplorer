'use strict';
const atlasUI={enabled:false,busy:false,timer:null,serial:0,layer:null,loaded:null,lastAttempt:null,cachedOnly:false,prefetched:new Set(),prefetchTimer:null,detailPriority:true,pack:null,packLayer:null,packIndex:-1,packSurvey:null,packRoute:null,packSource:null,packRequest:0,autoPack:null,warm:null,warmSurvey:null,warmAt:0};
function atlasMapBusy(){return atlasUI.detailPriority&&state.sky?.isStillActive?.();}
function atlasSurveyURL(s){return location.origin+'/api/atlas/surveys/'+s.id;}
function atlasSurveyAllows(survey,capability){return state.config?.surveys?.find(s=>s.id===survey)?.[capability]!==false;}
function atlasMessage(text){const node=$('#atlas-message');if(node)node.textContent=text;}
const scienceTrail=new Map();let scienceRefineTimer;
function clearScienceTrail(){
  const keys=new Set([...scienceTrail.keys(),...(state.sky?.getStackLayers?.()||[]).filter(key=>String(key).startsWith('science-trail-')||key==='science-overlay')]);
  for(const key of keys)state.sky?.removeImageLayer(key);scienceTrail.clear();
}
function atlasClear(){clearTimeout(atlasUI.timer);clearTimeout(scienceRefineTimer);atlasUI.serial++;atlasUI.enabled=false;clearScienceTrail();atlasUI.layer=null;atlasUI.loaded=null;}
function onAtlasViewChanged(){
  if(state.page!=='explore')return;
  try{atlasWarmFlight();}catch(e){$('#atlas-prefetch').checked=false;toast('Preloading paused: '+e.message,true);}
}
function atlasWarmFlight(){
  // Offscreen viewers share download slots with the visible map. Keep those slots
  // available for detail by default; ahead-of-flight warming remains optional.
  if(atlasUI.detailPriority||tourSurveyActive())return;
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
// Compatibility for old callers: this feature is retired, including forced loads.
async function loadAutomaticScience(){atlasClear();}
function atlasPrefetch(route,index){
  clearTimeout(atlasUI.prefetchTimer);
  if(atlasUI.cachedOnly||!$('#atlas-prefetch').checked||route.kind!=='waypoints')return;
  if(atlasMapBusy()){
    atlasUI.prefetchTimer=setTimeout(()=>{if(routePlayer.route===route&&routePlayer.index===index&&state.page==='explore')atlasPrefetch(route,index);},500);
    return;
  }
  const survey=tourSkySurvey();
  for(const savedStop of route.stops.slice(index+1,index+3)){
    const stop=tourSurveyView(savedStop);
    if(!atlasSurveyAllows(stop.survey,'rendered_views'))continue;
    const key=JSON.stringify([stop.ra,stop.dec,stop.fov,stop.survey]);if(atlasUI.prefetched.has(key))continue;
    atlasUI.prefetched.add(key);if(atlasUI.prefetched.size>200)atlasUI.prefetched.delete(atlasUI.prefetched.values().next().value);
    jsonPost('/api/atlas/view',Object.fromEntries(['ra','dec','fov','survey','projection','roll'].filter(k=>stop[k]!==undefined).map(k=>[k,stop[k]]))).then(job=>awaitAtlasJob(job,()=>tourSkySurvey()===survey)).catch(()=>atlasUI.prefetched.delete(key));
  }
}
async function atlasShowPackView(route,index){
  const pack=atlasUI.pack,survey=tourSkySurvey();
  if(index===atlasUI.packIndex&&survey===atlasUI.packSurvey&&route===atlasUI.packRoute&&pack===atlasUI.packSource)return;
  const request=++atlasUI.packRequest;
  atlasUI.packIndex=index;atlasUI.packSurvey=survey;atlasUI.packRoute=route;atlasUI.packSource=pack;
  if(atlasUI.packLayer)state.sky.removeImageLayer('downloaded-tour-view');atlasUI.packLayer=null;
  if(pack&&(pack.route_id!==route.id||pack.revision!==route.revision))return;
  let entry=pack?.views.find(v=>v.index===index);
  const current=()=>request===atlasUI.packRequest&&tourSkySurvey()===survey&&atlasUI.pack===pack&&routePlayer.route===route&&routePlayer.index===index;
  if(!pack&&atlasUI.detailPriority)return;
  if(!pack&&$('#atlas-prefetch').checked&&!atlasUI.cachedOnly){
    const savedStop=route.stops[index];if(!savedStop)return;
    const stop=tourSurveyView(savedStop);
    if(!atlasSurveyAllows(stop.survey,'rendered_views'))return;
    try{const job=await jsonPost('/api/atlas/view',Object.fromEntries(['ra','dec','fov','survey','projection','roll'].filter(k=>stop[k]!==undefined).map(k=>[k,stop[k]])));entry={view:await awaitAtlasJob(job,current)};}catch{return;}
  }
  if(!current())return;
  if(!entry?.view){atlasMessage('This stop has no downloaded view.');return;}
  const v=entry.view;
  if(v.survey!==survey){atlasMessage('This download uses another survey. Showing the selected full-sky map.');return;}
  const layer=A.image(v.url,{name:'Downloaded · '+v.survey_name,imgFormat:'png',wcs:v.wcs,opacity:0,successCallback:()=>{
    if(!current()){if(atlasUI.packLayer===layer){state.sky.removeImageLayer('downloaded-tour-view');atlasUI.packLayer=null;}return;}
    layer.setOpacity(1);
    atlasMessage(`Downloaded full-sky view · ${v.survey_name} · 768 × 768`);if(!pack)setTimeout(()=>atlasRetirePreview(layer),500);
  },errorCallback:()=>{if(current())atlasMessage('Saved view could not render.');}});
  atlasUI.packLayer=layer;state.sky.setOverlayImageLayer(layer,'downloaded-tour-view');
}
function atlasRetirePreview(layer,attempt=0){
  if(atlasUI.pack||atlasUI.packLayer!==layer)return;
  if(state.sky.isStillActive?.()){if(attempt<40)setTimeout(()=>atlasRetirePreview(layer,attempt+1),300);return;}
  state.sky.removeImageLayer('downloaded-tour-view');atlasUI.packLayer=null;
  atlasMessage('Detailed survey tiles ready · prepared view released.');
}
function atlasStopPack(){clearTimeout(atlasUI.prefetchTimer);atlasUI.packRequest++;if(atlasUI.packLayer)state.sky?.removeImageLayer('downloaded-tour-view');atlasUI.packLayer=null;atlasUI.pack=null;atlasUI.packIndex=-1;atlasUI.packSurvey=null;atlasUI.packRoute=null;atlasUI.packSource=null;}
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
  $('#atlas-downloads').innerHTML=d.packs.map((p,i)=>`<article class="atlas-pack"><div><span class="eyebrow">${esc(p.state.toUpperCase())}</span><h3>${esc(p.title)}</h3><p>Revision ${p.revision} · ${p.views.filter(v=>tourSkySurveys().some(s=>s.id===v.view?.survey)).length} / ${p.total} full-sky views saved · ${esc(date(p.created_at))}</p><p class="small">${p.errors.length} view errors · playback uses views matching your selected sky</p></div><div class="flex"><button class="button primary" data-pack-play="${i}">Play downloaded tour</button><button class="button" data-pack-remove="${i}">Remove download</button></div></article>`).join('')||'<p class="muted">Choose a saved waypoint tour above to download its full-sky views.</p>';
  $$('[data-pack-play]').forEach(b=>b.onclick=()=>playAtlasPack(d.packs[Number(b.dataset.packPlay)]).catch(failure));
  $$('[data-pack-remove]').forEach(b=>b.onclick=()=>busy(b,'Removing…',async()=>{await api('/api/atlas/packs/'+d.packs[Number(b.dataset.packRemove)].id,{method:'DELETE'});await loadAtlasDownloads();}));
  $('#atlas-download-job').textContent=d.jobs.map(j=>j.progress||j.state).join(' · ');
  if(d.jobs.length){clearTimeout(atlasUI.autoPack);atlasUI.autoPack=setTimeout(()=>{if(state.page==='downloads')loadAtlasDownloads().catch(()=>{});},2000);}
}
async function playAtlasPack(pack){
  // Keep the saved route revision, but follow the chosen continuous sky survey.
  const route=tourSurveyRoute(pack.route);
  for(const media of route.media||[])if(media)media.preview_url=null;
  await startRouteDocument(route,pack);
}
function initAtlas(){
  try{atlasUI.detailPriority=localStorage.getItem('universe-atlas-detail-priority')!=='false';}catch{}
  api('/api/atlas/status').then(d=>{atlasUI.cachedOnly=d.cached_only;}).catch(()=>{});
  const nav=document.createElement('button');nav.className='nav-item';nav.textContent='◫ Compare lenses';nav.dataset.page='compare';nav.onclick=()=>showPage('compare');$('nav[aria-label="Workspace"]').append(nav);
  const downloads=document.createElement('button');downloads.className='nav-item';downloads.textContent='↓ Downloads & cache';downloads.dataset.page='downloads';downloads.onclick=()=>showPage('downloads');nav.after(downloads);
  const controls=document.createElement('section');controls.className='atlas-controls';controls.innerHTML=`<div class="section-label"><span class="overline">MAP PERFORMANCE</span></div><p id="atlas-message" class="small muted" role="status">Continuous survey imagery · local tile cache enabled.</p><label class="atlas-check"><input id="atlas-prefetch" type="checkbox" checked> Preload flight & tour views</label>`;
  $('.sidebar-footer').before(controls);
  const priority=document.createElement('label');priority.className='atlas-check';priority.innerHTML='<input id="atlas-detail-priority" type="checkbox"> Prioritize visible map detail';controls.append(priority);
  priority.title='Give visible survey tiles priority. Ahead-of-flight previews pause; upcoming tour previews wait for the map.';
  $('#atlas-detail-priority').checked=atlasUI.detailPriority;
  $('#atlas-detail-priority').onchange=e=>{atlasUI.detailPriority=e.target.checked;try{localStorage.setItem('universe-atlas-detail-priority',String(atlasUI.detailPriority));}catch{}onAtlasViewChanged();};
  const page=document.createElement('section');page.id='downloads-page';page.className='page content-page';page.innerHTML=`<div class="page-heading"><div class="overline">TAKE THE SKY WITH YOU</div><h1>Your downloaded universe<span>.</span></h1><p>Save a waypoint tour in your chosen full-sky survey. Browse visited map tiles from this PC.</p></div><div class="atlas-download-bar"><label for="atlas-download-route">Saved waypoint tour</label><select id="atlas-download-route"></select><label for="atlas-download-survey">Sky survey</label><select id="atlas-download-survey" data-tour-sky aria-label="Download sky survey"></select><button id="atlas-download-start" class="button primary">Download tour views</button><button id="atlas-download-cancel" class="button" hidden>Cancel remaining views</button><button id="atlas-download-refresh" class="button">Refresh</button></div><p id="atlas-download-job" role="status"></p><div class="atlas-cache-bar"><label class="atlas-check"><input id="atlas-cached-only" type="checkbox"> Cached-only atlas</label><span id="atlas-cache-summary"></span></div><p class="muted">Downloads retain 768 × 768 full-sky survey views at each saved stop and the tour captions. Playback uses saved views only when they match your selected survey. Flight between stops uses cached map tiles. Unvisited areas, higher detail, new catalog searches and AI cloud processing need a connection.</p><div id="atlas-downloads"></div>`;$('main').append(page);
  $('#atlas-download-start').onclick=()=>busy($('#atlas-download-start'),'Queuing…',async()=>{const j=await api('/api/atlas/packs/'+encodeURIComponent($('#atlas-download-route').value)+'?survey='+encodeURIComponent(tourSkySurvey()),{method:'POST'});$('#atlas-download-cancel').hidden=false;$('#atlas-download-cancel').onclick=async()=>{await api('/api/atlas/jobs/'+j.id+'/cancel',{method:'POST'});$('#atlas-download-cancel').hidden=true;};await loadAtlasDownloads();});
  $('#atlas-download-refresh').onclick=()=>loadAtlasDownloads().catch(failure);
  const cacheSettings=document.createElement('div');cacheSettings.className='atlas-download-bar';cacheSettings.innerHTML='<label for="atlas-cache-limit">Map cache on disk</label><select id="atlas-cache-limit">'+[1,4,8,16,32,64].map(n=>`<option value="${n}">${n} GiB</option>`).join('')+'</select><button class="button" id="atlas-cache-save">Save cache size</button><span id="atlas-cache-space" class="small muted"></span>';
  $('.atlas-cache-bar').after(cacheSettings);
  $('#atlas-cache-save').onclick=()=>busy($('#atlas-cache-save'),'Saving…',async()=>{await jsonPost('/api/atlas/cache-settings',{limit_gib:Number($('#atlas-cache-limit').value)});await loadAtlasDownloads();toast('Map cache size saved.');});
  $('#atlas-cached-only').onchange=async e=>{try{const d=await api('/api/atlas/cached-only?enabled='+e.target.checked,{method:'POST'});atlasUI.cachedOnly=d.cached_only;atlasMessage(d.cached_only?'Cached-only atlas · automatic downloads paused.':'Online atlas · local cache enabled.');}catch(err){e.target.checked=atlasUI.cachedOnly;failure(err);}};
}
