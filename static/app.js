'use strict';
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n,d=2) => Number.isFinite(Number(n)) && n!==null ? Number(n).toLocaleString(undefined,{maximumFractionDigits:d}) : '—';
const date = value => value ? new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : 'Not reported';
const loading = text => `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`;
const ALL_SKY={name:'Start anywhere',type:'ALL-SKY EXPLORATION',ra:0,dec:0,fov:360,survey:'optical',overview:true,description:'Drag to move across the sky. Scroll to zoom into any region. Turn on Object map for guide markers and catalog information as you move closer.'};
const state={config:null,sky:null,page:'explore',survey:'optical',ra:0,dec:0,fov:360,destination:null,live:[],image:null,candidates:null,transit:null,notes:[],archive:[],archivePage:1,archiveRequest:0,archiveQuery:null};
let toastTimer;
let travelFrame;
function toast(message,error=false){$('#toast').textContent=message;$('#toast').classList.toggle('error',error);$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,error?10000:5000);}
function failure(error){console.error(error);toast(error.message||'Something went wrong. Please retry.',true);}
async function api(path,options={}){
  const response=await fetch(path,{signal:AbortSignal.timeout(180000),...options});
  let data;
  try{data=await response.json();}catch{throw new Error('The app received an unexpected response. Please retry.');}
  if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail||data));
  return data;
}
const jsonPost=(url,data)=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
async function busy(button,label,action){
  if(button.disabled)return;
  const text=button.textContent;button.disabled=true;button.textContent=label;
  try{return await action();}catch(e){failure(e);}finally{button.disabled=false;button.textContent=text;}
}
function download(data,name,type='application/json'){
  const url=URL.createObjectURL(new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type}));
  const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function modal(title,html){interruptTour('Paused to inspect or edit');$('#modal-title').textContent=title;$('#modal-content').innerHTML=html;if(!$('#modal').open)$('#modal').showModal();$('#modal').scrollTop=0;$('#modal-close').focus({preventScroll:true});}
function closeModal(){$('#modal').close();}
function currentField(){
  if(state.sky&&state.page==='explore'){
    const [ra,dec]=state.sky.getRaDec();state.ra=ra;state.dec=dec;state.fov=state.sky.getFov()[0];
  }
  return {ra:state.ra,dec:state.dec,fov:state.fov,survey:state.survey};
}
function showPage(page){
  if(typeof researchLeaving==='function'&&page!=='research')researchLeaving();
  cancelAnimationFrame(travelFrame);
  if(page!=='explore')leaveTourView('Paused · another workspace is open');
  if(page!=='explore'&&flight.active)exitFlight();
  currentField();state.page=page;
  syncTourSkyControls();
  $$('.page').forEach(el=>el.classList.toggle('active',el.id===page+'-page'));
  $$('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.page===page));
  if(page==='notebook')loadNotes().catch(failure);
  if(page==='lab')loadLibrary().catch(failure);
  if(page==='journeys')loadJourneyPage().catch(failure);
  if(page==='routes')loadNavigationPage().catch(failure);
  if(page==='compare')openComparison().catch(failure);
  if(page==='downloads')loadAtlasDownloads().catch(failure);
  if(page==='research')openResearch();
  if(page==='sdss')openSDSS();
  if(page==='telescope-live')openTelescopeLive().catch(failure);
  if(page==='archive')$('#archive-position').textContent=`RA ${state.ra.toFixed(5)}°  DEC ${state.dec.toFixed(5)}°`;
  if(page==='explore')window.dispatchEvent(new Event('resize'));
  if(page!=='explore')stopObjectVideo();
}
function coordinates(){
  if(!state.sky)return;
  const [ra,dec]=state.sky.getRaDec();state.ra=ra;state.dec=dec;state.fov=state.sky.getFov()[0];
  $('#coordinates').textContent=`RA ${ra.toFixed(5)}°   DEC ${dec.toFixed(5)}°`;
  $('#fov-readout').textContent=`FIELD ${state.fov<.01?state.fov.toFixed(5):state.fov.toFixed(3)}°`;
  $('#overview-button').setAttribute('aria-pressed',String(state.fov>=359));
  flightViewChanged();
  onSkyViewChanged();
  onImageSkyChanged();
  onNavigationSkyChanged();
  onAtlasViewChanged();
}
function chooseSurvey(id){
  const survey=state.config.surveys.find(s=>s.id===id);
  if(!survey)return;
  if(!routePlayer.writing)leaveTourView('Paused · exploring another survey');
  state.survey=id;$('#survey-select').value=id;$('#survey-description').textContent=survey.description;
  $$('#lens-chips button').forEach(b=>b.classList.toggle('selected',b.dataset.survey===id));
  $('#sky-stretch').value='native';
  $('#sky-credit').textContent=`${survey.name} · CDS Aladin / HiPS`;
  if(survey.credit&&survey.source_url)$('#sky-credit').innerHTML=`${esc(survey.name)} · <a href="${esc(survey.source_url)}" target="_blank" rel="noopener">${esc(survey.credit)} ↗</a> · CDS Aladin / HiPS`;
  if(survey.auto_science===false)atlasClear();
  if(state.sky){
    try{state.sky.setImageSurvey(atlasSurveyURL(survey));$('#sky-status').innerHTML='<i></i> '+esc(survey.tag)+' · SKY ATLAS';}
    catch(e){failure(e);}
  }
}
function flyTo(destination){
  leaveTourView('Paused · visiting another destination');
  if(flight.active)exitFlight();
  const origin=state.sky?{...currentField()}:null;
  state.destination=destination;showPage('explore');
  $('#explore-page').classList.toggle('all-sky-view',Boolean(destination.overview));
  if(destination.survey)chooseSurvey(destination.survey);
  state.ra=Number(destination.ra);state.dec=Number(destination.dec);state.fov=destination.fov||.2;
  $('#destination-name').innerHTML=esc(destination.name)+'<span>.</span>';
  $('#destination-type').textContent=destination.type||'EXPLORING THE SKY';
  $('#destination-description').textContent=destination.description||'Explore the observed sky at this position. Switch lenses or search the archive to follow the evidence.';
  $$('.destination-card').forEach(b=>b.classList.toggle('active',b.dataset.name===destination.name));
  if(state.sky){
    animateSkyTravel(origin,{ra:Number(destination.ra),dec:Number(destination.dec),fov:destination.fov||.2});
  }else toast('The interactive sky is unavailable. Reconnect to load the survey map.',true);
}
function showAllSky(){
  flyTo(ALL_SKY);
  if(mapUI.enabled)showObjectList();
}
async function initSky(){
  try{
    if(!window.A)throw new Error('The CDS sky viewer could not load. Check your internet connection and reload.');
    await A.init;
    state.sky=A.aladin('#aladin-lite-div',{survey:atlasSurveyURL(state.config.surveys.find(s=>s.id===state.survey)),target:`${state.ra} ${state.dec}`,fov:state.fov,projection:'AIT',cooFrame:'ICRSd',showReticle:false,showZoomControl:false,showFullscreenControl:false,showLayersControl:false,showGotoControl:false,showShareControl:false,showFrame:false,showCooLocation:false,showProjectionControl:false,showFov:false,showCooGrid:false,showStatusBar:true,showCooGridControl:false,showSimbadPointerControl:false,showContextMenu:true,backgroundColor:'#03070c'});
    $('#aladin-lite-div').addEventListener('pointerdown',()=>cancelAnimationFrame(travelFrame));
    installTourLayerGuard(state.sky);
    $('#aladin-lite-div').addEventListener('wheel',()=>cancelAnimationFrame(travelFrame),{passive:true});
    state.sky.on('positionChanged',()=>coordinates());
    state.sky.on('zoomChanged',()=>coordinates());
    $('#aladin-lite-div').style.opacity='1';
    $('#sky-fallback').classList.add('loaded');
    $('#sky-status').innerHTML='<i></i> RELEASED IMAGERY · SKY ATLAS';
    coordinates();
  }catch(e){
    $('#sky-status').textContent='SKY ATLAS OFFLINE';
    $('#sky-fallback').textContent='Connect to the internet and reload to explore the observed sky.';
    $('#capture-button').disabled=true;$('#lab-capture').disabled=true;
    failure(e);
  }
}
function renderLive(){
  $('#live-cards').innerHTML=state.live.map((o,i)=>{
    const label=o.telescope==='webb'?'James Webb':'Hubble';
    if(o.error)return `<div class="live-card"><div class="live-card-head">${label}<a href="${esc(o.source_url)}" target="_blank" rel="noopener">↗</a></div><div class="live-status">Feed unavailable. Use the official live view.</div></div>`;
    return `<div class="live-card"><div class="live-card-head"><i></i>${label}<a href="${esc(o.source_url)}" target="_blank" rel="noopener" aria-label="Open ${label} observation source">↗</a></div><button class="fly-button" data-live="${i}" title="Travel to this telescope pointing"><span class="live-target">${esc(o.target)} ↗</span></button><div class="live-status">${esc(o.instruments.join(' + '))} · ${o.stale?'Saved data — refresh failed':'Feed checked '+date(o.fetched_at)}</div><div class="live-status">${esc(o.status)}</div></div>`;
  }).join('');
  $$('#live-cards [data-live]').forEach(b=>b.onclick=()=>visitLive(state.live[Number(b.dataset.live)]));
}
function visitLive(o){
  if(o.ra===null||o.dec===null){toast('This record does not include usable sky coordinates.',true);return;}
  flyTo({name:o.target,ra:o.ra,dec:o.dec,fov:.2,survey:o.telescope==='webb'?'2mass':'optical',type:(o.telescope==='webb'?'WEBB':'HUBBLE')+' · REPORTED TARGET',description:o.title+(o.moving_target?' Moving target: this fixed survey shows the background sky at the reported position.':'')});
  modal('Observation details',`<div class="modal-body"><span class="badge teal">${esc(o.status)}</span><h3>${esc(o.title)}</h3><p><strong>${esc(o.target)}</strong> · ${esc(o.target_category||o.category||'')}</p><p>Instruments: ${esc(o.instruments.join(', '))}<br>Program ${esc(o.program)} · ${esc(o.investigator)}<br>Start: ${esc(date(o.start))}<br>End: ${esc(date(o.end))}<br>Feed retrieved: ${esc(date(o.fetched_at))}${o.stale?' (stale saved copy)':''}</p><p class="help-strip">${esc(o.image_note)} ${o.moving_target?'The target moves. A fixed star atlas does not track the planet.':''}</p><a class="button" href="${esc(o.source_url)}" target="_blank" rel="noopener">Open official observation ↗</a> <button id="live-archive" class="button primary">Find released images here</button></div>`);
  $('#live-archive').onclick=()=>{closeModal();showPage('archive');searchArchive(1);};
}
async function refreshLive(){const result=await api('/api/live');state.live=result.rows;renderLive();}
async function searchSky(event){
  event.preventDefault();const input=$('#search-input');const name=input.value.trim();if(!name)return;
  input.disabled=true;
  try{
    const known=state.config.destinations.find(d=>d.name.toLowerCase()===name.toLowerCase());
    if(known){flyTo(known);return;}
    const coord=name.match(/^([+-]?\d+(?:\.\d+)?)\s*[, ]\s*([+-]?\d+(?:\.\d+)?)$/);
    let target;
    if(coord){target={ra:Number(coord[1]),dec:Number(coord[2])};if(target.ra<0||target.ra>=360||Math.abs(target.dec)>90)throw new Error('Use RA from 0 to under 360°, and Dec from −90° to +90°.');}
    else target=await api('/api/resolve?name='+encodeURIComponent(name));
    flyTo({...target,name,fov:.5,survey:'optical',type:'YOUR DESTINATION'});
  }catch(e){failure(e);}finally{input.disabled=false;}
}
function mjdDate(mjd){return mjd ? new Date((Number(mjd)-40587)*86400000).toLocaleDateString(): 'Unknown';}
async function searchArchive(page=1){
  const requestId=++state.archiveRequest;
  const panel=$('#archive-results');panel.className='archive-results';panel.innerHTML=loading('Searching the public telescope archive…');
  $('#archive-summary').textContent='Querying MAST. Large fields can take up to a minute.';
  $('#archive-prev').disabled=true;$('#archive-next').disabled=true;
  if(page===1){
    const {ra,dec}=currentField();
    state.archiveQuery={ra,dec,radius:$('#archive-radius').value,telescope:$('#archive-telescope').value,band:$('#archive-band').value};
  }
  const query=new URLSearchParams({...state.archiveQuery,page});
  $('#archive-position').textContent=`RA ${Number(state.archiveQuery.ra).toFixed(5)}°  DEC ${Number(state.archiveQuery.dec).toFixed(5)}°`;
  try{
    const result=await api('/api/archive?'+query);
    if(requestId!==state.archiveRequest)return;
    state.archive=result.rows;state.archivePage=page;
    const total=result.paging.rowsFiltered??result.paging.total??result.rows.length;
    $('#archive-summary').textContent=`${fmt(total,0)} public observations · ${result.stale?'Saved results (refresh failed)':'Retrieved '+date(result.fetched_at)}`;
    $('#archive-page-number').textContent='Page '+page;
    $('#archive-prev').disabled=page<=1;
    $('#archive-next').disabled=page>=Number(result.paging.pagesFiltered??result.paging.pages??Math.ceil(total/60));
    if(!result.rows.length){panel.classList.add('empty-state');panel.innerHTML='<span class="empty-symbol">◎</span><h2>No public images matched this field.</h2><p>Try a larger radius, another filter, or a nearby destination. The telescope may not have observed this field, or its data may still be restricted.</p>';return;}
    panel.innerHTML=result.rows.map((o,i)=>`<article class="observation-card">${o.jpegURL?`<img class="observation-image" loading="lazy" src="/api/archive-preview?uri=${encodeURIComponent(o.jpegURL)}" alt="Archive preview of ${esc(o.target_name)}">`:'<div class="observation-no-image">Science data · preview not provided</div>'}<div class="observation-body"><div class="badges"><span class="badge teal">${esc(o.obs_collection)}</span><span class="badge">${esc(o.filters||'Filter unspecified')}</span></div><h3>${esc(o.target_name||o.obs_id)}</h3><div class="kv"><div><small>INSTRUMENT</small>${esc(o.instrument_name)}</div><div><small>OBSERVED</small>${mjdDate(o.t_min)}</div><div><small>EXPOSURE</small>${fmt(o.t_exptime,1)} s</div><div><small>PROGRAM</small>${esc(o.proposal_id||'—')}</div></div><div class="small subtle mono">${esc(o.obs_id)}</div><button class="button" data-products="${i}">Open data products ↗</button></div></article>`).join('');
    $$('.observation-image',panel).forEach(img=>img.onerror=()=>{const div=document.createElement('div');div.className='observation-no-image';div.textContent='Preview unavailable · science products may still be available';img.replaceWith(div);});
    $$('[data-products]',panel).forEach(b=>b.onclick=()=>showProducts(state.archive[Number(b.dataset.products)]));
  }catch(e){
    if(requestId!==state.archiveRequest)return;
    panel.innerHTML=`<div class="error-box">${esc(e.message)}<p style="margin-top:12px">Try again, reduce the field radius, or use the <a href="https://mast.stsci.edu/portal/Mashup/Clients/Mast/Portal.html" target="_blank" rel="noopener">MAST portal ↗</a>.</p></div>`;
    $('#archive-summary').textContent='The archive query could not complete.';
  }
}
async function showProducts(observation){
  modal('Observation products',loading('Finding original files…'));
  try{
    const result=await api('/api/products/'+encodeURIComponent(observation.obsid));
    $('#modal-content').innerHTML=`<p class="small muted">${esc(observation.target_name)} · ${esc(observation.filters)}. Import 2D FITS images up to 100 MB / 25 million pixels. Larger products can be downloaded directly.</p><div id="products-list"></div>`;
    $('#products-list').innerHTML=result.rows.length?result.rows.map((p,i)=>`<div class="product-row"><div><strong>${esc(p.productFilename)}</strong><small>${esc(p.description)} · ${fmt(p.size/1024/1024,1)} MB</small></div><div class="flex"><a class="text-button" href="https://mast.stsci.edu/api/v0.1/Download/file?uri=${encodeURIComponent(p.dataURI)}" target="_blank" rel="noopener">↓ Download</a><button class="button" data-import="${i}" ${p.size>100*1024*1024?'disabled':''}>Open in lab</button></div></div>`).join(''):'<p class="muted">No supported public image products were returned for this record.</p>';
    $$('[data-import]').forEach(b=>b.onclick=()=>busy(b,'Downloading…',async()=>{
      const product=result.rows[Number(b.dataset.import)];
      const image=await jsonPost('/api/images/import',{uri:product.dataURI,filename:product.productFilename,observation});
      closeModal();openImage(image);toast('Original archive product imported.');
    }));
  }catch(e){$('#modal-content').innerHTML=`<div class="error-box">${esc(e.message)}</div>`;}
}
function openImage(image){
  state.image=image;state.candidates=null;
  showPage('lab');$('#lab-empty').hidden=true;$('#lab-content').hidden=false;
  $('#image-name').textContent=image.name;
  $('#image-info').textContent=`${image.width} × ${image.height} pixels · ${image.scientific?'Original FITS · '+image.filter:'Display image · no scientific calibration'} · ${image.wcs?'WCS coordinates available':'No celestial WCS'}`;
  $('#original-image').src=image.preview_url;
  $('#original-download').href=image.original_url;
  $('#fits-stretch').disabled=!image.scientific;$('#fits-stretch').value='asinh';
  $('#candidate-overlay').innerHTML='';$('#export-candidates').disabled=true;
  $('#candidate-results').textContent=image.scientific?'Ready to search the original FITS data.':'Source detection requires original FITS data. Use a MAST science product or open a local FITS image.';
  $('#detect-button').disabled=!image.scientific;
  renderAI();
  $('#image-provenance').textContent=JSON.stringify(image,null,2);
}
function renderAI(){
  renderEnhancementComparison();
}
async function loadLibrary(){
  const data=await api('/api/images');
  $('#image-library').innerHTML=data.rows.length?'<div class="overline">RECENT IMAGES · SAVED ON THIS PC</div><div class="library-items">'+data.rows.map((m,i)=>`<button class="library-item" data-library="${i}"><img src="${m.preview_url}" alt="" loading="lazy"><span>${esc(m.name)}<small>${m.scientific?'Original FITS':'Display image'}${m.ai||m.cloud_ai?' · AI view available':''}</small></span></button>`).join('')+'</div>':'';
  $$('[data-library]').forEach(b=>b.onclick=()=>openImage(data.rows[Number(b.dataset.library)]));
}
async function captureSky(){
  if(!state.sky)throw new Error('Connect the interactive sky viewer first.');
  showPage('explore');
  await new Promise(resolve=>setTimeout(resolve,200));
  if(typeof state.sky.isStillActive==='function'){
    const deadline=Date.now()+15000;
    while(state.sky.isStillActive()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,250));
    if(state.sky.isStillActive())throw new Error('Sky tiles are still loading. Wait for the view to settle, then capture again.');
  }
  const field=currentField();
  const url=await state.sky.getViewDataURL({format:'image/png',logo:true});
  const response=await fetch(url);const blob=await response.blob();
  const form=new FormData();form.append('file',blob,'Sky view - '+state.config.surveys.find(s=>s.id===state.survey).name+'.png');
  form.append('context',JSON.stringify({...field,kind:'rendered sky visualization',survey_url:state.config.surveys.find(s=>s.id===state.survey).url,captured_at:new Date().toISOString(),calibrated:false}));
  openImage(await api('/api/images/upload',{method:'POST',body:form}));
}
async function uploadImage(file){
  if(!file)return;
  if(file.size>100*1024*1024)throw new Error('Choose an image under 100 MB.');
  toast('Opening image locally…');const form=new FormData();form.append('file',file);
  openImage(await api('/api/images/upload',{method:'POST',body:form}));toast('Original image saved locally.');
}
async function detect(){
  const imageId=state.image.id;
  const result=await api(`/api/images/${imageId}/detect?sigma=${encodeURIComponent($('#detection-sigma').value)}`,{method:'POST'});
  if(state.image.id!==imageId)return;
  state.candidates=result;$('#export-candidates').disabled=false;
  $('#candidate-results').innerHTML=`<p>${result.rows.length} unclassified peaks. ${esc(result.note)}</p><div class="table-wrap"><table class="data-table"><thead><tr><th>ID</th><th>X / Y (0-based)</th><th>PEAK / σ</th><th>RA / DEC</th><th>REVIEW</th></tr></thead><tbody>${result.rows.map((r,i)=>`<tr><td>${r.id}</td><td>${r.x} / ${r.y}</td><td>${fmt(r.peak_sigma)}</td><td>${r.ra!==null?Number(r.ra).toFixed(6)+' / '+Number(r.dec).toFixed(6):'No WCS'}</td><td><button class="text-button" data-candidate="${i}">Save</button> ${r.ra!==null?`<button class="text-button" data-match="${i}">Check Gaia</button>`:''}</td></tr>`).join('')}</tbody></table></div>`;
  $$('[data-candidate]').forEach(b=>b.onclick=()=>{
    const r=result.rows[Number(b.dataset.candidate)];
    noteDialog({title:'Source candidate '+r.id+' · '+state.image.name,ra:r.ra,dec:r.dec,kind:'source candidate',body:'Unclassified peak from original FITS. Follow up in independent exposures and catalogs.',provenance:{image_id:state.image.id,input_sha256:result.input_sha256,source:state.image.source,candidate:r,sigma_threshold:result.sigma_threshold}});
  });
  $$('[data-match]').forEach(b=>b.onclick=()=>busy(b,'Checking…',async()=>{
    const r=result.rows[Number(b.dataset.match)];const match=await api(`/api/catalog-match?ra=${r.ra}&dec=${r.dec}`);
    modal('Gaia DR3 positional check',`<div class="modal-body"><h3>${match.rows.length} catalog matches within 3 arcsec</h3><p>${esc(match.note)}</p>${match.rows.map(m=>`<p>Gaia source ${esc(m.source_id)}<br>G magnitude: ${fmt(m.phot_g_mean_mag,3)} · Parallax: ${fmt(m.parallax,3)} mas</p>`).join('')}<p class="small muted">Retrieved ${date(match.fetched_at)}${match.stale?' · stale saved copy':''}</p></div>`);
  }));
  const overlay=$('#candidate-overlay');overlay.setAttribute('viewBox',`0 0 ${state.image.width} ${state.image.height}`);overlay.setAttribute('preserveAspectRatio','xMidYMid meet');
  const radius=Math.max(5,state.image.width/150);
  overlay.innerHTML=result.rows.map(r=>`<circle cx="${r.display_x}" cy="${r.display_y}" r="${radius}" fill="none" stroke="#8ff9d7" stroke-width="${Math.max(1,state.image.width/700)}"/>`).join('');
}
async function knownPlanets(){
  const field=currentField();$('#planet-results').innerHTML=loading('Querying confirmed exoplanets…');
  try{
    const result=await api(`/api/exoplanets?ra=${field.ra}&dec=${field.dec}&radius=5`);
    $('#planet-results').innerHTML=`<p class="small muted">Within 5° of RA ${field.ra.toFixed(3)}°, Dec ${field.dec.toFixed(3)}°. ${result.stale?'Saved data':'Retrieved '+date(result.fetched_at)}.</p>`+(result.rows.length?result.rows.map((p,i)=>`<div class="planet-row"><strong>${esc(p.pl_name)}</strong><div class="small muted">${esc(p.discoverymethod)} · ${esc(p.disc_year)}<br>Period ${fmt(p.pl_orbper,3)} days · Radius ${fmt(p.pl_rade,2)} R⊕<br>Distance ${fmt(p.sy_dist,1)} pc</div><button class="text-button" data-planet="${i}">Visit host star ↗</button></div>`).join(''):'<p class="small muted">No confirmed planets returned in this cone. Try TRAPPIST-1 from the explorer destinations.</p>');
    $$('[data-planet]').forEach(b=>b.onclick=()=>{const p=result.rows[Number(b.dataset.planet)];flyTo({name:p.hostname,ra:p.ra,dec:p.dec,fov:.1,survey:'optical',type:'KNOWN PLANET HOST',description:`${p.pl_name} is listed in the NASA Exoplanet Archive. This map shows its host-star field; the planet itself is not resolved.`});});
  }catch(e){$('#planet-results').innerHTML=`<p class="error">${esc(e.message)}</p>`;}
}
async function analyzeTransit(file){
  if(!file)return;
  const input=$('#lightcurve-upload');input.disabled=true;toast('Analyzing the original light curve locally…');
  try{
    const form=new FormData();form.append('file',file);form.append('min_period',$('#period-min').value);form.append('max_period',$('#period-max').value);
    const result=await api('/api/transits',{method:'POST',body:form});renderTransitResult(result);
  }finally{input.disabled=false;input.value='';}
}
function renderTransitResult(result){
  state.transit=result;$('#transit-results').hidden=false;
  $('#transit-metrics').innerHTML=[['Best-fit period',fmt(result.period_days,5)+' d'],['Transit duration',fmt(result.duration_hours,2)+' h'],['Relative depth',fmt(result.depth*100,3)+'%'],['Samples analyzed',fmt(result.samples,0)]].map(([label,value])=>`<div class="metric"><strong>${value}</strong><small>${label}</small></div>`).join('');
  $('#transit-note').textContent=result.note;if($('#tess-provenance'))$('#tess-provenance').innerHTML='';plotTransit();toast('Transit candidate fit complete. Review the light curve and period aliases.');
}
function plotTransit(){
  const r=state.transit;if(!r)return;
  const canvas=$('#transit-plot');const c=canvas.getContext('2d');const w=canvas.width,h=canvas.height,pad=56;
  c.fillStyle='#0b1822';c.fillRect(0,0,w,h);
  const sorted=[...r.flux].sort((a,b)=>a-b),low=sorted[Math.floor(sorted.length*.01)]-.002,high=sorted[Math.floor(sorted.length*.99)]+.002;
  const xp=x=>pad+(x/r.period_days+.5)*(w-pad*1.4),yp=y=>h-pad-(y-low)/(high-low)*(h-pad*1.7);
  c.strokeStyle='#294451';c.fillStyle='#8faab9';c.font='11px Consolas';
  for(let i=0;i<=4;i++){const y=low+(high-low)*i/4;c.beginPath();c.moveTo(pad,yp(y));c.lineTo(w-20,yp(y));c.stroke();c.fillText(y.toFixed(3),6,yp(y)+4);}
  c.fillStyle='#83d5cbaa';for(let i=0;i<r.phase.length;i++){const y=yp(r.flux[i]);if(y<12||y>h-pad)continue;c.beginPath();c.arc(xp(r.phase[i]),y,1.6,0,Math.PI*2);c.fill();}
  c.strokeStyle='#e7b277';c.lineWidth=2;c.beginPath();
  const half=r.duration_hours/48;
  for(const [x,y] of [[-r.period_days/2,1],[-half,1],[-half,1-r.depth],[half,1-r.depth],[half,1],[r.period_days/2,1]]){c.lineTo(xp(x),yp(y));}c.stroke();
  c.fillStyle='#9ab7c1';c.fillText('Phase (days from fitted mid-transit)',w/2-130,h-14);c.fillText((-r.period_days/2).toFixed(2),pad,h-32);c.fillText('0',xp(0),h-32);c.fillText((r.period_days/2).toFixed(2),w-50,h-32);
}
function noteDialog(overrides={}){
  const field=currentField();const values={title:state.destination?.name||'Sky field',body:'',ra:field.ra,dec:field.dec,survey:state.survey,kind:'field',provenance:{...field,survey_url:state.config.surveys.find(s=>s.id===state.survey)?.url},...overrides};
  modal('Save to discovery notebook',`<form id="note-form" class="note-form"><span class="badge teal">${esc(values.kind.toUpperCase())}</span><label for="note-title">Title</label><input id="note-title" maxlength="200" required value="${esc(values.title)}"><label for="note-body">What caught your attention?</label><textarea id="note-body" maxlength="20000" placeholder="Describe the feature, your hypothesis, and what to check next.">${esc(values.body)}</textarea><p class="small muted">Coordinates and data provenance are attached. Saved locally on this PC.</p><button type="submit" class="button primary">Save to notebook</button></form>`);
  $('#note-form').onsubmit=async event=>{event.preventDefault();const button=$('#note-form button');await busy(button,'Saving…',async()=>{await jsonPost('/api/notes',{...values,title:$('#note-title').value,body:$('#note-body').value});closeModal();await loadNotes();toast('Saved to your discovery notebook.');});};
}
async function loadNotes(){
  const result=await api('/api/notes');state.notes=result.rows;$('#note-count').textContent=result.rows.length;
  $('#notes-list').innerHTML=result.rows.length?result.rows.map((n,i)=>`<article class="note-card"><span class="badge teal">${esc(n.kind.toUpperCase())}</span><h2>${esc(n.title)}</h2><p>${esc(n.body||'No notes added yet.')}</p><div class="small">${date(n.created_at)}<br>${n.ra!==null?'RA '+Number(n.ra).toFixed(5)+'° · Dec '+Number(n.dec).toFixed(5)+'°':'Pixel coordinates recorded in provenance'}</div><details><summary>Data provenance</summary><pre>${esc(JSON.stringify(n.provenance,null,2))}</pre></details><div class="note-actions">${n.ra!==null?`<button class="text-button" data-note-visit="${i}">Revisit field ↗</button>`:''}${n.provenance.image_id?`<button class="text-button" data-note-image="${i}">Open image</button>`:''}<button class="text-button delete-note" data-note-delete="${i}">Delete</button></div></article>`).join(''):'<div class="empty-state"><span class="empty-symbol">▤</span><h2>Every discovery starts with a question.</h2><p>Save a sky position, record an interesting feature, and return to investigate it. Your notes and provenance stay on this computer.</p></div>';
  $$('[data-note-visit]').forEach(b=>b.onclick=()=>{const n=state.notes[Number(b.dataset.noteVisit)];flyTo({name:n.title,ra:n.ra,dec:n.dec,fov:n.provenance.fov||.2,survey:n.survey||'optical',type:'FROM YOUR NOTEBOOK',description:n.body});});
  $$('[data-note-image]').forEach(b=>b.onclick=async()=>{try{openImage(await api('/api/images/'+state.notes[Number(b.dataset.noteImage)].provenance.image_id));}catch(e){failure(e);}});
  $$('[data-note-delete]').forEach(b=>b.onclick=async()=>{const n=state.notes[Number(b.dataset.noteDelete)];if(!confirm(`Delete the note “${n.title}”?`))return;try{await api('/api/notes/'+n.id,{method:'DELETE'});await loadNotes();toast('Note deleted.');}catch(e){failure(e);}});
}
function about(){
  modal('Your personal observatory',`<div class="modal-body"><h3>Explore light that has reached us.</h3><p>This is a 2D celestial atlas of observed fields. You can pan across the sky and zoom into released imagery; distances and depth are not reconstructed as a physical 3D universe.</p><h3>Two views of the telescopes</h3><p>Space Telescope Live supplies schedules and pointing metadata. MAST supplies released science products. The current pointing is not a live camera feed. CDS sky mosaics are selected, cached representations with incomplete coverage.</p><h3>Lenses with a scientific basis</h3><p>Wavelength buttons switch real datasets. Narrowband images may contain continuum and multiple emission lines. They do not automatically measure gas abundance. Blank fields indicate coverage limits.</p><h3>AI for visualization</h3><p>FSRCNN 2× neural upscaling runs on this PC’s CPU. Originals are preserved with SHA-256 hashes. AI images are labeled in the exported pixels and never enter the source detector.</p><h3>Candidate tools</h3><p>FITS source detection, Gaia checks, and box least squares transit fits help organize follow-up work. An unmatched peak or repeating dip is an unconfirmed candidate. Confirm discoveries through independent observations, calibration, artifact rejection, and catalog comparison.</p><h3>Sources & credits</h3><p>${state.config.sources.map(s=>`<a href="${s.url}" target="_blank" rel="noopener">${s.name} ↗</a>`).join('<br>')}<br><a href="https://github.com/Saafke/FSRCNN_Tensorflow" target="_blank" rel="noopener">FSRCNN model by Saafke / OpenCV ↗</a><br><a href="https://docs.astropy.org/en/stable/timeseries/bls.html" target="_blank" rel="noopener">Astropy BLS analysis ↗</a></p><p class="small muted">Telescope images: NASA, ESA, CSA, STScI and their credited observing teams; survey projections: CDS. Use the original product’s attribution for publication.</p></div>`);
}
async function boot(){
  try{
    state.config=await api('/api/config');state.destination=ALL_SKY;
    const groups=[...new Set(state.config.surveys.map(s=>s.group))];
    $('#survey-select').innerHTML=groups.map(group=>`<optgroup label="${esc(group)}">${state.config.surveys.filter(s=>s.group===group).map(s=>`<option value="${s.id}">${esc(s.name)} · ${esc(s.tag)}</option>`).join('')}</optgroup>`).join('');
    chooseSurvey('optical');
    $('#destinations').innerHTML=state.config.destinations.map((d,i)=>`<button class="destination-card" data-name="${esc(d.name)}" data-destination="${i}"><span class="num">0${i+1}</span><small>${esc(d.type)}</small><strong>${esc(d.name)}</strong></button>`).join('');
    $$('[data-destination]').forEach(b=>b.onclick=()=>flyTo(state.config.destinations[Number(b.dataset.destination)]));
    $$('[data-page]').forEach(b=>b.onclick=()=>showPage(b.dataset.page));
    $$('#lens-chips button').forEach(b=>b.onclick=()=>{showPage('explore');chooseSurvey(b.dataset.survey);});
    $('#survey-select').onchange=e=>{showPage('explore');chooseSurvey(e.target.value);};
    $('#sky-stretch').onchange=e=>{
      if(!state.sky)return;try{const layer=state.sky.getBaseImageLayer();if(e.target.value==='native')layer.setColormap('native',{stretch:'linear'});else layer.setColormap('native',{stretch:e.target.value});}catch(error){failure(error);}
    };
    $('#search-form').onsubmit=searchSky;
    $('#about-button').onclick=about;$('#modal-close').onclick=closeModal;
    $('#refresh-live').onclick=()=>busy($('#refresh-live'),'…',refreshLive);
    $('#requested-observation').onclick=()=>busy($('#requested-observation'),'Loading your observation…',async()=>visitLive(await api('/api/live/webb/'+state.config.requested_observation)));
    $('#zoom-in').onclick=()=>{if(state.sky)state.sky.setFoV?state.sky.setFoV(state.sky.getFov()[0]/1.6):state.sky.setFov(state.sky.getFov()[0]/1.6);};
    $('#zoom-out').onclick=()=>{if(state.sky)state.sky.setFoV?state.sky.setFoV(Math.min(360,state.sky.getFov()[0]*1.6)):state.sky.setFov(Math.min(360,state.sky.getFov()[0]*1.6));};
    $('#reset-view').onclick=()=>flyTo(state.destination||ALL_SKY);
    $('#overview-button').onclick=showAllSky;
    $('#fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen().catch(failure);else $('#explore-page').requestFullscreen().catch(failure);};
    $('#find-observations').onclick=()=>{showPage('archive');searchArchive(1);};
    $('#archive-search').onclick=()=>searchArchive(1);$('#archive-prev').onclick=()=>searchArchive(state.archivePage-1);$('#archive-next').onclick=()=>searchArchive(state.archivePage+1);
    $('#save-field').onclick=()=>noteDialog();$('#new-note').onclick=()=>noteDialog();
    $('#capture-button').onclick=()=>busy($('#capture-button'),'Capturing…',captureSky);$('#lab-capture').onclick=()=>busy($('#lab-capture'),'Capturing…',captureSky);
    $('#image-upload').onchange=async e=>{try{e.target.disabled=true;await uploadImage(e.target.files[0]);}catch(error){failure(error);}finally{e.target.disabled=false;e.target.value='';}};
    initObservatoryFeatures();
    initImageJourneys();
    initPhotometry();
    initFlight();
    initNavigation();
    initAtlas();
    initTourSkyControls();
    initComparison();
    initResearch();
    initSDSS();
    initTelescopeLive();
    initMapPanels();
    $('#fits-stretch').onchange=e=>{$('#original-image').src=state.image.preview_url+'?stretch='+e.target.value;updateEnhancementControls();};
    $('#save-image').onclick=()=>{const m=state.image;const center=m.center||m.extra;noteDialog({title:m.name,ra:center.ra??center.s_ra??null,dec:center.dec??center.s_dec??null,body:'Saved image for visual exploration and follow-up.',provenance:{image_id:m.id,input_sha256:m.sha256,source:m.source,filter:m.filter,ai:m.ai,observation:m.extra}});};
    $('#detect-button').onclick=()=>busy($('#detect-button'),'Analyzing original FITS…',detect);
    $('#export-candidates').onclick=()=>download(state.candidates,'source-candidates.json');
    $('#planet-search').onclick=()=>busy($('#planet-search'),'Querying…',knownPlanets);
    $('#lightcurve-upload').onchange=e=>analyzeTransit(e.target.files[0]).catch(failure);
    $('#save-transit').onclick=()=>{const r=state.transit;const {time,flux,phase,periods,power,...provenance}=r;noteDialog({title:'Transit candidate · '+r.name,kind:'transit candidate',ra:null,dec:null,body:`Exploratory period ${r.period_days.toFixed(6)} days; depth ${(r.depth*100).toFixed(4)}%. Check aliases and independent observations.`,provenance});};
    $('#export-transit').onclick=()=>download(state.transit,'transit-candidate-analysis.json');
    $('#export-notebook').onclick=()=>download({app:'Universe Explorer',exported_at:new Date().toISOString(),notes:state.notes},'universe-discovery-notebook.json');
    initSky();refreshLive().catch(failure);loadNotes().catch(failure);
    setInterval(()=>{if(state.sky&&state.page==='explore'&&typeof state.sky.isStillActive==='function'){$('#sky-status').innerHTML='<i></i> '+(state.sky.isStillActive()?'LOADING OBSERVATION TILES':esc(state.config.surveys.find(s=>s.id===state.survey).tag)+' · SKY ATLAS');}},800);
    setInterval(()=>{if(!document.hidden)refreshLive().catch(()=>{});},60000);
  }catch(e){failure(e);}
}
boot();
