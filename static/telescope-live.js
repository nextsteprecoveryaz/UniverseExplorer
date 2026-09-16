'use strict';
const telescopeLive={sky:null,opening:null,mission:'webb',observation:null,serial:0,loaded:false,following:false,busy:false,timer:null};
function telescopeLiveSurvey(mission=telescopeLive.mission){return mission==='webb'?'2mass':'optical';}
function telescopeLiveCoordinates(o){return o&&Number.isFinite(o.ra)&&o.ra>=0&&o.ra<360&&Number.isFinite(o.dec)&&Math.abs(o.dec)<=90;}
function telescopeLiveUTC(value){if(!value)return 'Not reported';const instant=new Date(value);if(!Number.isFinite(instant.getTime()))return 'Not reported';return new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(instant)+' UTC';}
function telescopeLiveLink(value){let u;try{u=new URL(value);}catch{throw Error('Paste a complete Space Telescope Live observation link.');}if(u.protocol!=='https:'||u.hostname!=='spacetelescopelive.org'||u.username||u.password||u.port||!/^\/(webb|hubble)\/?$/.test(u.pathname))throw Error('Use a Webb or Hubble link from https://spacetelescopelive.org.');const id=u.searchParams.get('obsId');if(id&&!/^[A-Z0-9]{26}$/.test(id))throw Error('Invalid observation ID. Copy the observation link from the official site.');return {mission:u.pathname.split('/')[1],id};}
function telescopeLiveReadout(){const sky=telescopeLive.sky;if(!sky)return;const [ra,dec]=sky.getRaDec();$('#telescope-live-coordinates').textContent=`RA ${ra.toFixed(5)}° · Dec ${dec.toFixed(5)}° · Field ${sky.getFov()[0].toFixed(3)}°`;telescopeLive.mapping?.invalidateView();}
function telescopeLiveRender(){
  const t=telescopeLive,o=t.observation;$('#telescope-live-mission').value=t.mission;
  $('#telescope-live-previous').disabled=t.busy||!o?.previous_id;$('#telescope-live-next').disabled=t.busy||!o?.next_id;
  const survey=state.config.surveys.find(s=>s.id===telescopeLiveSurvey());$('#telescope-live-credit').textContent=survey.name+' · CDS Aladin';$('#telescope-live-layer').textContent=t.mission==='webb'?'2MASS · Near-infrared sky':'DSS2 · Visible sky';
  if(!o){$('#telescope-live-target').textContent='Explore the sky';return;}
  $('#telescope-live-target').textContent=o.target;$('#telescope-live-status').textContent=(o.stale?'Cached feed · update failed · ':'')+o.status;
  $('#telescope-live-program').textContent=o.title||'No program title supplied';$('#telescope-live-time').textContent=`Reported start: ${telescopeLiveUTC(o.start)}\nReported end: ${telescopeLiveUTC(o.end)}`;
  $('#telescope-live-source').href=o.source_url;$('#telescope-live-source').textContent='Space Telescope Live ↗';$('#telescope-live-target-button').disabled=!telescopeLiveCoordinates(o);
  $('#telescope-live-note').textContent=(o.lookup_note?o.lookup_note+' ':'')+(o.moving_target?'Moving target · the marker shows its reported position against the ground-based survey sky.':'The marker shows the reported target position. Background imagery comes from ground-based surveys.');
}
function telescopeLivePoint(){const t=telescopeLive,o=t.observation;if(!telescopeLiveCoordinates(o)||!t.sky)return;t.sky.setProjection('SIN');t.sky.gotoRaDec(o.ra,o.dec);t.sky.setFoV(.5);telescopeLiveReadout();}
async function telescopeLiveLoad(mission=telescopeLive.mission,id=null,{background=false,at=null}={}){
  const t=telescopeLive;if(background&&t.busy)return;const serial=++t.serial;t.busy=true;$('#telescope-live-request').textContent='Reading the official observation feed…';
  $('#telescope-live-previous').disabled=$('#telescope-live-next').disabled=true;
  try{
    const o=at?await api(`/api/live-at/${mission}?at=${encodeURIComponent(at)}`):id?await api(`/api/live/${mission}/${id}`):(await api('/api/live')).rows.find(r=>r.telescope===mission);
    if(serial!==t.serial)return;if(!o||o.error)throw Error(o?.error||'The official telescope feed is unavailable.');
    const moved=t.observation?.id!==o.id,changed=t.mission!==mission,first=!t.loaded;t.mission=mission;t.observation=o;t.loaded=true;
    if(t.sky&&(changed||first)){const layer=t.sky.setBaseImageLayer(atlasSurveyURL(state.config.surveys.find(s=>s.id===telescopeLiveSurvey())));t.mapping?.bind(telescopeLiveSurvey(),layer);}
    if(t.markers){t.markers.removeAll();if(telescopeLiveCoordinates(o))t.markers.addSources([A.source(o.ra,o.dec,{name:o.target})]);}
    telescopeLiveRender();if(!background||moved)telescopeLivePoint();
    $('#telescope-live-request').textContent=telescopeLiveCoordinates(o)?(at?'Schedule near '+telescopeLiveUTC(at)+' · ':'')+'Feed retrieved '+telescopeLiveUTC(o.fetched_at):'No target coordinates in this record. You can still browse the survey.';
  }catch(e){if(serial===t.serial){$('#telescope-live-mission').value=t.mission;$('#telescope-live-request').textContent=e.message;}if(!background&&serial===t.serial)throw e;}finally{if(serial===t.serial){t.busy=false;telescopeLiveRender();}}
}
function telescopeLiveStopFollowing(){telescopeLive.following=false;$('#telescope-live-follow').checked=false;}
function telescopeLiveStep(direction){const id=telescopeLive.observation?.[direction+'_id'];if(!id)return;telescopeLiveStopFollowing();telescopeLiveLoad(telescopeLive.mission,id).catch(failure);}
async function openTelescopeLive(){
  const t=telescopeLive;if(t.opening)return t.opening;
  t.opening=(async()=>{await A.init;if(!t.sky){const survey=state.config.surveys.find(s=>s.id===telescopeLiveSurvey());t.sky=A.aladin('#telescope-live-sky',{survey:atlasSurveyURL(survey),target:'0 0',fov:360,cooFrame:'ICRSd',showReticle:false,showZoomControl:false,showFullscreenControl:false,showLayersControl:false,showGotoControl:false,showShareControl:false,showFrame:false,showCooLocation:false,showProjectionControl:false,showFov:false,showCooGrid:false,showStatusBar:true,showSimbadPointerControl:false,showContextMenu:true,backgroundColor:'#02060b'});
      t.markers=A.catalog({name:'Reported target position',sourceSize:16,color:'#ffdd90',shape:'cross'});t.sky.addCatalog(t.markers);t.sky.on('positionChanged',telescopeLiveReadout);t.sky.on('zoomChanged',telescopeLiveReadout);
      if(typeof PixelMappingController!=='undefined'){
        t.mapping=new PixelMappingController({host:$('#telescope-live-pixel-panel'),sky:t.sky,onResize:open=>{$('#telescope-live-pixels').setAttribute('aria-expanded',String(open));window.dispatchEvent(new Event('resize'));}});
        t.mapping.setOpen(true);t.mapping.bind(telescopeLiveSurvey(),t.sky.getBaseImageLayer());
      }
    }window.dispatchEvent(new Event('resize'));telescopeLiveRender();telescopeLiveReadout();if(!t.loaded)await telescopeLiveLoad();})();
  try{await t.opening;}finally{t.opening=null;}
}
function initTelescopeLive(){
  const page=document.createElement('section');page.id='telescope-live-page';page.className='page telescope-live-page';
  page.innerHTML=`
    <header class="telescope-live-header">
      <div><div class="overline">OBSERVATION EXPLORER</div><h1>Telescope Live<span>.</span></h1><p>Follow Webb and Hubble across the sky.</p></div>
      <div class="telescope-live-heading-actions"><span id="telescope-live-layer" class="telescope-live-layer">2MASS · Near-infrared sky</span><button id="telescope-live-explorer" class="button">Sky explorer ↗</button></div>
    </header>
    <div class="telescope-live-toolbar" role="group" aria-label="Telescope and map controls">
      <label class="telescope-live-mission-label">Telescope<select id="telescope-live-mission"><option value="webb">James Webb</option><option value="hubble">Hubble</option></select></label>
      <div class="telescope-live-observation-controls"><button id="telescope-live-latest" class="button primary">Latest observation</button><div class="telescope-live-stepper"><button id="telescope-live-previous" class="button" aria-label="Previous observation" title="Previous observation" disabled>←</button><button id="telescope-live-next" class="button" aria-label="Next observation" title="Next observation" disabled>→</button></div></div>
      <label class="telescope-live-follow"><input type="checkbox" id="telescope-live-follow"> Follow updates</label>
      <div class="telescope-live-view-controls"><button id="telescope-live-target-button" class="button" disabled>Center target</button><button id="telescope-live-all" class="button">All sky</button><button id="telescope-live-fullscreen" class="button">Full screen</button></div>
    </div>
    <div class="telescope-live-search-row">
      <details id="telescope-live-finder" class="telescope-live-finder"><summary>Find an observation <span>Date or source link</span></summary><div class="telescope-live-find-fields">
        <form id="telescope-live-date-form"><label for="telescope-live-date">Schedule date & time (UTC)</label><div><input id="telescope-live-date" type="datetime-local" required><button id="telescope-live-date-go" class="button">Find by date</button></div></form>
        <form id="telescope-live-link-form"><label for="telescope-live-link">Space Telescope Live link</label><div><input id="telescope-live-link" type="url" required placeholder="Paste a Webb or Hubble observation link"><button id="telescope-live-link-go" class="button">Open link</button></div></form>
      </div></details>
      <span id="telescope-live-request" class="telescope-live-feed-status" role="status">Loading observation feed…</span>
    </div>
    <div id="telescope-live-stage">
      <div id="telescope-live-sky" aria-label="Interactive telescope survey map"></div>
      <div class="telescope-live-info"><span class="telescope-live-target-label">REPORTED TARGET</span><strong id="telescope-live-target">Explore the sky</strong><span id="telescope-live-status"></span><details><summary>Observation details</summary><p id="telescope-live-program"></p><p id="telescope-live-time"></p><a id="telescope-live-source" href="https://spacetelescopelive.org/webb" target="_blank" rel="noopener">Space Telescope Live ↗</a></details></div>
      <div class="telescope-live-zoom"><button id="telescope-live-in" class="button" aria-label="Zoom telescope map in">+</button><button id="telescope-live-out" class="button" aria-label="Zoom telescope map out">−</button></div>
      <div id="telescope-live-coordinates"></div>
    </div>
    <footer class="telescope-live-footer"><span id="telescope-live-credit"></span><p id="telescope-live-note">Drag to pan · scroll to zoom</p></footer>`;
  $('main').append(page);$('#telescope-live-explorer').onclick=()=>showPage('explore');
  const pixelPanel=document.createElement('aside');pixelPanel.id='telescope-live-pixel-panel';pixelPanel.setAttribute('aria-label','Pixel mapping controls');$('#telescope-live-stage').append(pixelPanel);
  const pixelButton=document.createElement('button');pixelButton.id='telescope-live-pixels';pixelButton.className='button';pixelButton.textContent='Pixel mapping';pixelButton.setAttribute('aria-expanded','true');pixelButton.setAttribute('aria-controls','telescope-live-pixel-panel');$('#telescope-live-fullscreen').before(pixelButton);pixelButton.onclick=()=>telescopeLive.mapping?.setOpen(telescopeLive.mapping.host.hidden);
  $('#telescope-live-date').value=new Date().toISOString().slice(0,16);$('#telescope-live-previous').onclick=()=>telescopeLiveStep('previous');$('#telescope-live-next').onclick=()=>telescopeLiveStep('next');$('#telescope-live-date-form').onsubmit=e=>{e.preventDefault();telescopeLiveStopFollowing();busy($('#telescope-live-date-go'),'Loading schedule…',()=>telescopeLiveLoad(telescopeLive.mission,null,{at:$('#telescope-live-date').value+':00Z'}));};
  $('#telescope-live-mission').onchange=e=>{telescopeLiveLoad(e.target.value).catch(failure);};$('#telescope-live-latest').onclick=()=>busy($('#telescope-live-latest'),'Loading…',()=>telescopeLiveLoad());$('#telescope-live-target-button').onclick=telescopeLivePoint;
  $('#telescope-live-all').onclick=()=>{if(telescopeLive.sky){telescopeLive.sky.setProjection('AIT');telescopeLive.sky.setFoV(360);}telescopeLiveReadout();};$('#telescope-live-follow').onchange=e=>{telescopeLive.following=e.target.checked;};
  $('#telescope-live-link-form').onsubmit=e=>{e.preventDefault();busy($('#telescope-live-link-go'),'Opening…',async()=>{const ref=telescopeLiveLink($('#telescope-live-link').value.trim());telescopeLiveStopFollowing();await telescopeLiveLoad(ref.mission,ref.id);});};
  $('#telescope-live-in').onclick=()=>{const sky=telescopeLive.sky;if(sky)sky.setFoV(Math.max(.00001,sky.getFov()[0]/1.7));};$('#telescope-live-out').onclick=()=>{const sky=telescopeLive.sky;if(sky)sky.setFoV(Math.min(360,sky.getFov()[0]*1.7));};
  $('#telescope-live-fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen().catch(failure);else $('#telescope-live-page').requestFullscreen().catch(failure);};
  telescopeLive.timer=setInterval(()=>{if(!document.hidden&&state.page==='telescope-live'&&telescopeLive.following)telescopeLiveLoad(telescopeLive.mission,null,{background:true}).catch(()=>{});},60000);
}
