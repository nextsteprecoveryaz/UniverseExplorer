'use strict';
const journeys={tab:'gallery',galleryPage:1,recentPage:1,galleryRequest:0,recentRequest:0,mapRequest:0,mapTimer:null,mapEnabled:true,markers:[],galleryMarkers:[],recentStatus:null,galleryStatus:null,lastCount:'',near:null,footprint:null,overlay:null};

function shortCount(n){return n>=1000?(n/1000).toFixed(n>=10000?0:1)+'k':String(n);}
function postedDate(p){return p.posted?new Date(p.posted*1000).toLocaleDateString():'Date not supplied';}
function jobText(s){const j=s?.job||{};return j.state==='running'?j.message:j.state==='failed'||j.state==='interrupted'?(j.error||'Update incomplete') :j.completed_at?'Updated '+date(j.completed_at):'Not yet updated';}
async function refreshImageStatus(){
  const results=await Promise.allSettled([api('/api/recent/status'),api('/api/gallery/status')]);
  if(results[0].status==='fulfilled')journeys.recentStatus=results[0].value;
  if(results[1].status==='fulfilled')journeys.galleryStatus=results[1].value;
  const r=journeys.recentStatus,g=journeys.galleryStatus;if(!r||!g)return;
  const running=r.job.state==='running'||g.job.state==='running';
  $('#update-images').disabled=running;$('#update-images').textContent=running?'↻ Updating images…':'↻ Update images';
  $('#image-index-summary').textContent=`${fmt(r.total,0)} archive records · ${fmt(g.mapped,0)} located NASA images`;
  const rt=`MAST: ${jobText(r)}`,gt=`Flickr: ${jobText(g)}`;
  $('#image-update-status').textContent=running?[r.job.state==='running'?rt:'',g.job.state==='running'?gt:''].filter(Boolean).join(' · '):r.job.state==='failed'||g.job.state==='failed'?'Update needs attention. Open Image journeys for details.':r.complete?'Observed since 2022 · refreshed '+date(r.complete.completed_at):'Use Update images to build your collections.';
  $('#journey-sync-status').textContent=`${fmt(r.total,0)} MAST records${r.complete?' · complete index':' · incomplete index'} (${fmt(r.counts.JWST||0,0)} Webb / ${fmt(r.counts.HST||0,0)} Hubble). ${fmt(g.total,0)} NASA Webb items; ${fmt(g.mapped,0)} have a target location. ${rt}. ${gt}. ${(g.job.warnings||[]).join(' ')}`;
  const count=[r.total,g.total,g.mapped,r.generation,r.job.state,g.job.state].join(':');
  if(count!==journeys.lastCount){journeys.lastCount=count;loadGalleryMarkers().catch(()=>{});refreshImageMap().catch(()=>{});}
}
async function updateImageCollections(){
  $('#update-images').disabled=true;$('#update-images').textContent='↻ Starting updates…';
  const results=await Promise.allSettled([api('/api/recent/update',{method:'POST'}),api('/api/gallery/update',{method:'POST'})]);
  for(const r of results)if(r.status==='rejected')failure(r.reason);
  await refreshImageStatus();
}
function selectJourneyTab(tab){journeys.tab=tab;$('#gallery-tab').setAttribute('aria-selected',String(tab==='gallery'));$('#recent-tab').setAttribute('aria-selected',String(tab==='recent'));$('#gallery-view').hidden=tab!=='gallery';$('#recent-view').hidden=tab!=='recent';loadJourneyPage().catch(failure);}
async function loadJourneyPage(){return journeys.tab==='gallery'?loadGallery(journeys.galleryPage):loadRecent(journeys.recentPage);}
function imageFallback(img,text='Preview unavailable · open the source or original files'){
  img.onerror=()=>{const note=document.createElement('div');note.className='journey-no-image';note.textContent=text;img.replaceWith(note);};
}
async function loadGallery(page=1){
  const request=++journeys.galleryRequest;journeys.galleryPage=page;const root=$('#gallery-results');root.innerHTML=loading('Opening NASA Webb’s image collections…');
  const params=new URLSearchParams({source:$('#gallery-source').value,page,search:$('#gallery-search').value,mapped:$('#gallery-mapped').checked});
  try{
    const result=await api('/api/gallery/photos?'+params);if(request!==journeys.galleryRequest)return;
    $('#gallery-summary').textContent=`${fmt(result.total,0)} items · published image dates · NASA Webb / Flickr`;
    $('#gallery-prev').disabled=page<=1;$('#gallery-next').disabled=page>=result.pages;$('#gallery-page-label').textContent=`Page ${page} of ${Math.max(1,result.pages)}`;
    root.innerHTML=result.rows.length?result.rows.map((p,i)=>`<article class="journey-card"><button class="journey-image-button" data-gallery-open="${i}" aria-label="Open ${esc(p.title)}">${p.thumbnail_url?`<img loading="lazy" src="${esc(p.thumbnail_url)}" alt="${esc(p.title)}">`:'<span class="journey-no-image">Open published item</span>'}</button><div class="journey-card-body"><div class="badges"><span class="badge rose">${esc(p.kind)}</span>${p.location?'<span class="badge teal">LOCATED</span>':''}</div><h3>${esc(p.title)}</h3><p class="small muted">Published ${postedDate(p)}</p><div class="flex"><button class="button" data-gallery-open="${i}">Open image</button>${p.location?`<button class="text-button" data-gallery-travel="${i}">Travel here ↗</button>`:'<span class="small subtle">Sky location unverified</span>'}</div></div></article>`).join(''):'<div class="empty-state"><h2>No images in this view yet.</h2><p>Use Update images to fetch the collections, or clear your filters.</p></div>';
    $$('[data-gallery-open]',root).forEach(b=>b.onclick=()=>openGalleryPhoto(result.rows[Number(b.dataset.galleryOpen)]));
    $$('[data-gallery-travel]',root).forEach(b=>b.onclick=()=>travelGallery(result.rows[Number(b.dataset.galleryTravel)]));
    $$('img',root).forEach(img=>imageFallback(img));
  }catch(e){if(request===journeys.galleryRequest)root.innerHTML=`<div class="error-box">${esc(e.message)}</div>`;}
}
function currentImageRegion(){
  const p=currentField(),v=state.sky?.getFov()||[p.fov,p.fov];
  const radius=p.fov>=150?180:Math.min(180,Math.hypot(v[0],v[1])*0.7);
  return {ra:p.ra,dec:p.dec,radius:Math.max(.00001,radius),fov:p.fov};
}
async function loadRecent(page=1){
  const request=++journeys.recentRequest;journeys.recentPage=page;const root=$('#recent-results');root.innerHTML=loading('Opening the recent telescope index…');
  const params={page,mission:$('#recent-mission').value,search:$('#recent-search').value};
  if($('#recent-field').checked)Object.assign(params,journeys.near||currentImageRegion());
  try{
    const result=await api('/api/recent/observations?'+new URLSearchParams(params));if(request!==journeys.recentRequest)return;
    $('#recent-summary').textContent=`${fmt(result.total,0)} matching image observations${$('#recent-field').checked?' near this sky position':''} · observed since January 2022`;
    $('#recent-prev').disabled=page<=1;$('#recent-next').disabled=page>=result.pages;$('#recent-page-label').textContent=`Page ${page} of ${Math.max(1,result.pages)}`;
    root.innerHTML=result.rows.length?result.rows.map((o,i)=>`<article class="journey-card"><button class="journey-image-button" data-recent-open="${i}" aria-label="Open ${esc(o.target_name||o.obs_id)}">${o.jpegURL?`<img loading="lazy" src="/api/archive-preview?uri=${encodeURIComponent(o.jpegURL)}" alt="${esc(o.obs_collection)} image of ${esc(o.target_name)}">`:'<span class="journey-no-image">Science product · no preview supplied</span>'}</button><div class="journey-card-body"><div class="badges"><span class="badge ${o.obs_collection==='JWST'?'gold':'teal'}">${esc(o.obs_collection)}</span><span class="badge">${esc(o.filters)}</span></div><h3>${esc(o.target_name||o.obs_id)}</h3><p class="small muted">Observed ${mjdDate(o.t_min)} · ${esc(o.instrument_name)}</p><button class="button" data-recent-open="${i}">Explore observation ↗</button></div></article>`).join(''):'<div class="empty-state"><h2>No matching observations.</h2><p>Clear your filters or use Update images to refresh the recent index.</p></div>';
    $$('[data-recent-open]',root).forEach(b=>b.onclick=()=>openRecentObservation(result.rows[Number(b.dataset.recentOpen)]));
    $$('img',root).forEach(img=>imageFallback(img));
  }catch(e){if(request===journeys.recentRequest)root.innerHTML=`<div class="error-box">${esc(e.message)}</div>`;}
}
function enableImageViewer(){
  const host=$('#journey-image-viewer'),img=$('img',host);if(!img)return;
  let scale=1,x=0,y=0,drag=null;
  const paint=()=>{img.style.transform=`translate(${x}px,${y}px) scale(${scale})`;$('#viewer-zoom').textContent=Math.round(scale*100)+'%';};
  const zoom=factor=>{scale=Math.max(1,Math.min(16,scale*factor));if(scale===1)x=y=0;paint();};
  host.onwheel=e=>{e.preventDefault();zoom(e.deltaY<0?1.15:1/1.15);};
  host.onpointerdown=e=>{if(e.button!==0)return;drag={x:e.clientX-x,y:e.clientY-y};host.setPointerCapture(e.pointerId);};
  host.onpointermove=e=>{if(drag){x=e.clientX-drag.x;y=e.clientY-drag.y;paint();}};
  host.onpointerup=host.onpointercancel=()=>drag=null;
  $('#viewer-in').onclick=()=>zoom(1.5);$('#viewer-out').onclick=()=>zoom(1/1.5);$('#viewer-reset').onclick=()=>{scale=1;x=y=0;paint();};
  img.ondragstart=e=>e.preventDefault();
  imageFallback(img);paint();
}
function viewerMarkup(url,alt){return `<div id="journey-image-viewer" class="journey-image-viewer">${url?`<img src="${esc(url)}" alt="${esc(alt)}">`:'<div class="journey-no-image">No image preview supplied. Open the original files or source.</div>'}</div><div class="viewer-tools"><button id="viewer-out" class="button" aria-label="Zoom image out">−</button><span id="viewer-zoom">100%</span><button id="viewer-in" class="button" aria-label="Zoom image in">+</button><button id="viewer-reset" class="text-button">Fit image</button><span class="small subtle">Scroll to zoom · drag to explore</span></div>`;}
function travelGallery(p){
  if(!p.location){toast('This published item has no verified sky location. It remains available in the gallery.');return;}
  closeModal();flyTo({name:p.location.name,ra:p.ra,dec:p.dec,fov:.18,survey:'optical',type:'NASA WEBB · PUBLISHED IMAGE',description:p.title});
  setTimeout(()=>openGalleryPhoto(p),800);
}
function openGalleryPhoto(p){
  modal(p.title,`${viewerMarkup(p.image_url,p.title)}<div class="badges"><span class="badge rose">${esc(p.kind)}</span><span class="small muted">Published ${postedDate(p)} · NASA Webb / Flickr</span></div><div class="toolbar gallery-actions">${p.location?'<button id="photo-travel" class="button primary">Travel to this target ↗</button>':''}<button id="photo-lab" class="button">Open in image lab / AI</button><a class="button" href="${esc(p.source_url)}" target="_blank" rel="noopener">Flickr source ↗</a>${p.original_url?`<a class="text-button" href="${esc(p.original_url)}" target="_blank" rel="noopener">Full-resolution original ↗</a>`:''}</div><p class="small muted">${p.location?`${esc(p.location.name)} · RA ${p.ra.toFixed(6)}° · Dec ${p.dec.toFixed(6)}°. ${esc(p.location.note)}`:'No verified sky location. This may be a mission photograph, a diagram, a moving target, or an image awaiting identification.'}</p><details open><summary>Image story & credits</summary><p class="image-story">${esc(p.description)}</p></details><p class="small subtle">Flickr license ID ${esc(p.license)}; see the source for credit and reuse terms. This published image has no calibrated science pixels in the app.</p>`);
  enableImageViewer();
  if(p.location){const sed=document.createElement('button');sed.className='button';sed.textContent='VizieR photometry';$('.gallery-actions').append(sed);sed.onclick=()=>openPhotometry(p.location.name);}
  if($('#photo-travel'))$('#photo-travel').onclick=()=>{closeModal();flyTo({name:p.location.name,ra:p.ra,dec:p.dec,fov:.18,survey:'optical',type:'NASA WEBB · IMAGE TARGET',description:p.title});toast('At the catalog target. The NASA image is available from its pink map marker.');};
  $('#photo-lab').onclick=()=>busy($('#photo-lab'),'Downloading image…',async()=>{const m=await api('/api/gallery/photos/'+p.id+'/import',{method:'POST'});closeModal();openImage(m);});
}
function observationFov(o){
  const tokens=(o.s_region||'').match(/[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)||[];let max=.025;
  for(let i=0;i+1<tokens.length;i+=2){const dra=((Number(tokens[i])-o.s_ra+540)%360-180)*Math.cos(o.s_dec*Math.PI/180);max=Math.max(max,Math.hypot(dra,Number(tokens[i+1])-o.s_dec)*2.6);}
  return Math.min(5,max);
}
function visitObservation(o){
  if(!Number.isFinite(o.s_ra)||!Number.isFinite(o.s_dec)){toast('MAST did not supply usable sky coordinates for this record.',true);return;}
  closeModal();flyTo({name:o.target_name||o.obs_id,ra:o.s_ra,dec:o.s_dec,fov:observationFov(o),survey:'optical',type:o.obs_collection+' · OBSERVED '+mjdDate(o.t_min),description:o.filters+' · '+(o.obs_title||o.obs_id)});
  if(state.sky&&o.s_region){
    try{if(!journeys.footprint){journeys.footprint=A.graphicOverlay({name:'Selected observation footprint',color:'#ffcf7b',lineWidth:2});state.sky.addOverlay(journeys.footprint);}journeys.footprint.removeAll();journeys.footprint.addFootprints(A.footprintsFromSTCS(o.s_region));}catch{}
  }
}
async function projectObservation(o,button){
  if(!o.dataURL)throw new Error('This record has no direct science-image URL. Open its data products.');
  const filename=o.dataURL.split('/').pop();
  const m=await jsonPost('/api/images/import',{uri:o.dataURL,filename,observation:o});
  if(!m.wcs)throw new Error('The downloaded image has no supported celestial WCS. It was saved to the image lab.');
  visitObservation(o);
  try{
    journeys.overlay=A.image(m.original_url,{name:o.obs_id,imgFormat:'fits',colormap:'grayscale',stretch:'asinh',successCallback:(ra,dec,fov)=>{cancelAnimationFrame(travelFrame);state.sky.gotoRaDec(ra,dec);state.sky.setFoV(Math.max(.005,fov*1.4));toast('Original FITS image projected using its celestial WCS.');},errorCallback:()=>toast('The sky renderer could not project this FITS product. Its original is saved in Image lab.',true)});
    state.sky.setOverlayImageLayer(journeys.overlay,'selected-science-image');
    $('#clear-science-overlay').hidden=false;
  }catch(e){throw new Error('The original is saved in Image lab, but this FITS could not be projected: '+e.message);}
}
function openRecentObservation(o){
  const preview=o.jpegURL?'/api/archive-preview?uri='+encodeURIComponent(o.jpegURL):null;
  modal(o.target_name||o.obs_id,`${viewerMarkup(preview,o.obs_collection+' archive preview')}<div class="badges"><span class="badge gold">${esc(o.obs_collection)}</span><span class="badge">${esc(o.filters)}</span></div><p>${esc(o.obs_title||'Public calibrated telescope image')}</p><div class="kv"><div><small>OBSERVED</small>${mjdDate(o.t_min)}</div><div><small>INSTRUMENT</small>${esc(o.instrument_name)}</div><div><small>EXPOSURE</small>${fmt(o.t_exptime,1)} s</div><div><small>PROGRAM</small>${esc(o.proposal_id)}</div></div><p class="small mono">${esc(o.obs_id)}<br>RA ${fmt(o.s_ra,6)}° · Dec ${fmt(o.s_dec,6)}°</p><div class="toolbar"><button id="observation-visit" class="button primary">Travel to footprint ↗</button><button id="observation-products" class="button">Original files / image lab</button>${o.dataURL?'<button id="observation-project" class="button">Project FITS on sky</button>':''}</div><p class="small muted">This is the actual MAST preview for this observation. Project FITS downloads the original science image (up to 100 MB) and uses its WCS to place it on the map. ${o.mtFlag?'Moving target: coordinates mark the observation pointing, not the target’s current position.':''}</p>`);
  enableImageViewer();$('#observation-visit').onclick=()=>visitObservation(o);$('#observation-products').onclick=()=>showProducts(o);
  const sed=document.createElement('button');sed.className='button';sed.textContent='VizieR photometry';$('#observation-products').parentElement.append(sed);sed.onclick=()=>openPhotometry(`${o.s_ra} ${o.s_dec>=0?'+':''}${o.s_dec}`);
  if($('#observation-project'))$('#observation-project').onclick=()=>busy($('#observation-project'),'Downloading original FITS…',()=>projectObservation(o));
}
function onImageSkyChanged(){
  if(!journeys.mapEnabled)return;
  positionImageMarkers();
  // Keep the local image index visible while cruising; remote SIMBAD queries
  // retain their separate settle-after-movement behavior.
  if(flight.active&&journeys.mapTimer)return;
  clearTimeout(journeys.mapTimer);journeys.mapTimer=setTimeout(()=>{journeys.mapTimer=null;refreshImageMap().catch(()=>{});},flight.active?1100:550);
}
async function loadGalleryMarkers(){const d=await api('/api/gallery/map');journeys.galleryMarkers=d.rows;renderImageMarkers();}
async function refreshImageMap(){
  if(!state.sky||!journeys.mapEnabled||state.page!=='explore')return;
  const request=++journeys.mapRequest,source=$('#image-map-source').value;
  if(source==='flickr'){journeys.markers=[];renderImageMarkers();return;}
  const d=await api('/api/recent/map?'+new URLSearchParams({...currentImageRegion(),mission:source}));
  if(request!==journeys.mapRequest||!journeys.mapEnabled)return;
  journeys.markers=d.rows;renderImageMarkers();
}
function renderImageMarkers(){
  if(!journeys.mapEnabled)return;
  const root=$('#image-markers'),source=$('#image-map-source').value;
  const gallery=source==='both'||source==='flickr'?journeys.galleryMarkers:[];
  const grouped=new Map();
  for(const p of gallery){const key=p.ra.toFixed(3)+':'+p.dec.toFixed(3);if(!grouped.has(key))grouped.set(key,{...p,items:[]});grouped.get(key).items.push(p);}
  const releases=[...grouped.values()];
  root.innerHTML=journeys.markers.map((p,i)=>`<button class="image-sky-marker ${p.webb&&p.hubble?'mixed':p.webb?'webb':'hubble'} ${p.count===1?'single':''}" data-image-marker="${i}" data-ra="${p.ra}" data-dec="${p.dec}" aria-label="${p.count} image observations: ${p.webb} Webb, ${p.hubble} Hubble" title="${p.count} observations · click to explore">${p.count>1?shortCount(p.count):'•'}</button>`).join('')+releases.map((p,i)=>`<button class="image-sky-marker flickr" data-release-marker="${i}" data-ra="${p.ra}" data-dec="${p.dec}" aria-label="NASA image: ${esc(p.title)} (${p.items.length} images)" title="${esc(p.title)} · ${p.items.length} published images">◆${p.items.length>1?'<small>'+p.items.length+'</small>':''}</button>`).join('');
  $$('[data-image-marker]',root).forEach(b=>b.onclick=()=>{
    const p=journeys.markers[Number(b.dataset.imageMarker)];
    if(!p.id.startsWith('group-'))api('/api/recent/observations/'+p.id).then(openRecentObservation).catch(failure);
    else if(state.fov>1){flyTo({name:'Observed sky',ra:p.ra,dec:p.dec,fov:Math.max(.06,state.fov/5),survey:state.survey,type:'HUBBLE + WEBB · '+fmt(p.count,0)+' OBSERVATIONS',description:'Zoom further to separate the image locations, or browse the observations in this field.'});}
    else{journeys.near={ra:p.ra,dec:p.dec,radius:p.radius};$('#recent-field').checked=true;journeys.recentPage=1;journeys.tab='recent';showPage('journeys');selectJourneyTab('recent');}
  });
  $$('[data-release-marker]',root).forEach(b=>b.onclick=()=>{
    const p=releases[Number(b.dataset.releaseMarker)];
    if(p.items.length===1)api('/api/gallery/photos/'+p.id).then(openGalleryPhoto).catch(failure);
    else{
      modal('NASA Webb images at this target',`<p class="small muted">${p.items.length} published items share this catalog target position.</p><div class="release-pick-list">${p.items.map(v=>`<button class="button" data-pick-photo="${v.id}">${esc(v.title)}</button>`).join('')}</div>`);
      $$('[data-pick-photo]').forEach(b=>b.onclick=()=>api('/api/gallery/photos/'+b.dataset.pickPhoto).then(openGalleryPhoto).catch(failure));
    }
  });
  positionImageMarkers();
}
function positionImageMarkers(){
  if(!state.sky||state.page!=='explore'||!journeys.mapEnabled)return;
  const rect=$('#aladin-lite-div').getBoundingClientRect();
  $$('.image-sky-marker').forEach(b=>{let p;try{p=state.sky.world2pix(Number(b.dataset.ra),Number(b.dataset.dec));}catch{}const visible=p&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&p[0]>8&&p[1]>8&&p[0]<rect.width-8&&p[1]<rect.height-8;b.hidden=!visible;if(visible){b.style.left=p[0]+'px';b.style.top=p[1]+'px';}});
}
function initImageJourneys(){
  $('#update-images').onclick=()=>updateImageCollections().catch(failure);
  $('#browse-journeys').onclick=()=>showPage('journeys');$('#journeys-map').onclick=()=>showPage('explore');
  $('#gallery-tab').onclick=()=>selectJourneyTab('gallery');$('#recent-tab').onclick=()=>selectJourneyTab('recent');
  $('#gallery-go').onclick=()=>loadGallery(1);$('#gallery-source').onchange=()=>loadGallery(1);$('#gallery-mapped').onchange=()=>loadGallery(1);$('#gallery-search').onkeydown=e=>{if(e.key==='Enter')loadGallery(1);};
  $('#gallery-prev').onclick=()=>loadGallery(journeys.galleryPage-1);$('#gallery-next').onclick=()=>loadGallery(journeys.galleryPage+1);
  $('#recent-go').onclick=()=>loadRecent(1);$('#recent-mission').onchange=()=>loadRecent(1);$('#recent-field').onchange=()=>{journeys.near=null;loadRecent(1);};$('#recent-search').onkeydown=e=>{if(e.key==='Enter')loadRecent(1);};
  $('#recent-prev').onclick=()=>loadRecent(journeys.recentPage-1);$('#recent-next').onclick=()=>loadRecent(journeys.recentPage+1);
  try{journeys.mapEnabled=localStorage.getItem('universe-image-map')!=='false';}catch{}
  const setEnabled=enabled=>{journeys.mapEnabled=enabled;$('#image-map-toggle').checked=enabled;$('#image-markers').hidden=!enabled;$('#image-index-card').hidden=!enabled;$('#image-map-source').disabled=!enabled;journeys.mapRequest++;if(enabled)refreshImageMap().catch(failure);try{localStorage.setItem('universe-image-map',String(enabled));}catch{}};
  $('#image-map-toggle').onchange=e=>setEnabled(e.target.checked);$('#image-map-source').onchange=()=>refreshImageMap().catch(failure);setEnabled(journeys.mapEnabled);
  const clear=document.createElement('button');clear.id='clear-science-overlay';clear.className='text-button';clear.textContent='× Clear projected FITS';clear.hidden=true;$('.image-map-control').append(clear);clear.onclick=()=>{if(state.sky&&journeys.overlay)state.sky.removeImageLayer('selected-science-image');journeys.overlay=null;clear.hidden=true;};
  refreshImageStatus().catch(()=>{ $('#image-index-summary').textContent='Image index unavailable. Restart the local app to load the new endpoints.';});
  setInterval(()=>{if(!document.hidden)refreshImageStatus().catch(()=>{});},4000);
  setInterval(()=>{if(!document.hidden)positionImageMarkers();},300);
  window.addEventListener('resize',onImageSkyChanged);
}
