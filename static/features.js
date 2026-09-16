'use strict';
const mapUI={enabled:false,featured:[],rows:[],selected:null,request:0,timer:null,frame:null,lastQuery:'',queryResult:null};
let cloudConnection={configured:false,model:'gpt-image-2.5-sunburst'};
let topazConnection={configured:false,model:'Standard V2',max_output_pixels:25000000};
let enhancementRunning=false;

function stopObjectVideo(){const video=document.querySelector('#object-detail video');if(video)video.pause();}
function onSkyViewChanged(){
  if(!mapUI.enabled||!state.sky)return;
  cancelAnimationFrame(mapUI.frame);mapUI.frame=requestAnimationFrame(positionObjectMarkers);
  clearTimeout(mapUI.timer);mapUI.timer=setTimeout(refreshMappedObjects,900);
}
function toggleMapping(enabled){
  if(enabled&&typeof setNearbyVisible==='function')setNearbyVisible(false);
  mapUI.enabled=enabled;mapUI.request++;clearTimeout(mapUI.timer);
  $('#mapping-toggle').checked=enabled;$('#object-markers').hidden=!enabled;$('#object-panel').hidden=!enabled;$('#mapping-labels-control').hidden=!enabled;
  $('#explore-page').classList.toggle('mapping-active',enabled);
  try{localStorage.setItem('universe-object-map',String(enabled));}catch{}
  if(enabled){showObjectList();mapUI.lastQuery='';refreshMappedObjects();}else stopObjectVideo();
}
async function refreshMappedObjects(){
  if(!mapUI.enabled||!state.sky||state.page!=='explore')return;
  const field=currentField();const radius=Math.min(1,Math.max(.005,field.fov*.7));
  if(field.fov>5){
    if(mapUI.lastQuery!=='overview'){
      mapUI.request++;mapUI.lastQuery='overview';mapUI.rows=mapUI.featured;
      renderObjectList();renderObjectMarkers();
    }
    $('#mapping-status').textContent='Guide markers across the sky. Zoom to a field of 5° or smaller to load nearby SIMBAD objects. Pan and zoom anywhere; destinations are optional.';
    return;
  }
  const query=`ra=${field.ra.toFixed(6)}&dec=${field.dec.toFixed(6)}&radius=${radius.toFixed(4)}`;
  if(query===mapUI.lastQuery)return;
  mapUI.lastQuery=query;const request=++mapUI.request;
  mapUI.rows=mapUI.featured;renderObjectList();renderObjectMarkers();
  $('#mapping-status').textContent='Locating known objects in SIMBAD… Featured guide markers are ready.';
  try{
    const data=await api('/api/objects?'+query);
    if(request!==mapUI.request||!mapUI.enabled)return;
    mapUI.queryResult=data;
    const all=[...mapUI.featured,...data.rows];mapUI.rows=all.filter((o,i)=>all.findIndex(v=>v.id===o.id)===i);
    const count=data.rows.filter(o=>!o.featured).length;
    $('#mapping-status').textContent=data.catalog_available?`${count}${data.truncated?'+':''} SIMBAD objects · central ${radius.toFixed(3)}° radius. ${data.truncated?'Nearest 120 loaded. ':''}${data.stale?'Saved catalog; refresh unavailable.':'Retrieved '+date(data.fetched_at)+'.'} Markers label at most 18 objects; click any dot or use the list.`:data.warning;
    renderObjectList();renderObjectMarkers();
  }catch(e){
    if(request!==mapUI.request)return;
    mapUI.lastQuery='';$('#mapping-status').textContent='Catalog unavailable. Featured objects remain available.';
  }
}
function objectMatches(o){const q=$('#object-filter').value.trim().toLowerCase();return !q||(o.name+' '+o.type).toLowerCase().includes(q);}
function projectedObject(o){
  if(!state.sky)return null;
  try{
    const p=state.sky.world2pix(o.ra,o.dec);const host=$('#aladin-lite-div');
    return p&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&p[0]>=5&&p[1]>=5&&p[0]<host.clientWidth-5&&p[1]<host.clientHeight-30?p:null;
  }catch{return null;}
}
function renderObjectMarkers(){
  $('#object-markers').innerHTML=mapUI.rows.filter(objectMatches).map(o=>`<button class="object-marker ${o.featured?'featured-marker':''}" data-map-id="${esc(o.id)}" aria-label="About ${esc(o.name)}" title="${esc(o.name+' · '+o.type)}"><span class="marker-dot"></span><span class="marker-label">${esc(o.name)}</span></button>`).join('');
  $$('#object-markers button').forEach(b=>b.onclick=()=>showObjectDetail(mapUI.rows.find(o=>o.id===b.dataset.mapId)));
  positionObjectMarkers();
}
function positionObjectMarkers(){
  if(!mapUI.enabled)return;
  let labels=0;const used=[];const visibleIds=[];
  $$('#object-markers button').forEach(b=>{
    const o=mapUI.rows.find(o=>o.id===b.dataset.mapId);const p=projectedObject(o);
    b.hidden=!p;if(!p)return;
    visibleIds.push(o.id);
    b.style.left=p[0]+'px';b.style.top=p[1]+'px';
    const overlaps=used.some(v=>Math.abs(v[0]-p[0])<180&&Math.abs(v[1]-p[1])<30);
    const show=$('#mapping-labels').checked&&(o.featured||(!overlaps&&labels<18));
    b.classList.toggle('label-visible',show);if(show){used.push(p);labels++;}
    b.classList.toggle('selected',mapUI.selected?.id===o.id);
  });
  const signature=visibleIds.join('|');
  if(signature!==mapUI.visibleSignature){mapUI.visibleSignature=signature;renderObjectList();}
}
function renderObjectList(){
  const visible=mapUI.rows.filter(o=>objectMatches(o)&&projectedObject(o));
  $('#object-list').innerHTML=visible.length?visible.map(o=>`<button class="object-list-item" data-list-id="${esc(o.id)}"><strong>${esc(o.name)}</strong><small>${esc(o.type)}${o.video_url?' · Video':''}</small></button>`).join(''):'<p class="small muted">No loaded objects match this view. Try a featured destination below.</p>';
  $$('#object-list [data-list-id]').forEach(b=>b.onclick=()=>showObjectDetail(mapUI.rows.find(o=>o.id===b.dataset.listId)));
}
function showObjectList(){
  stopObjectVideo();mapUI.selected=null;
  $('#object-detail').hidden=true;$('#object-list-view').hidden=false;$('#object-panel-back').hidden=true;
  positionObjectMarkers();renderObjectList();
}
function showObjectDetail(o){
  if(typeof pauseRouteForFlight==='function')pauseRouteForFlight();
  if(typeof setNearbyVisible==='function')setNearbyVisible(false);
  if(!o)return;stopObjectVideo();mapUI.selected=o;
  $('#object-list-view').hidden=true;$('#object-detail').hidden=false;$('#object-panel-back').hidden=false;
  $('#object-detail').innerHTML=`<span class="badge teal">${esc(o.catalog)}</span><h2>${esc(o.name)}</h2><div class="object-kind">${esc(o.type)}</div><p>${esc(o.summary)}</p><div class="object-coordinates">RA ${Number(o.ra).toFixed(6)}°<br>Dec ${Number(o.dec).toFixed(6)}° · ICRS</div><a href="${esc(o.source_url)}" target="_blank" rel="noopener">${o.featured?'Read the source & credits':'Open SIMBAD record & references'} ↗</a>${o.video_url?`<div class="object-video"><h3>${esc(o.video_title)}</h3><video id="object-video" controls playsinline preload="metadata" aria-label="${esc(o.video_title)}"><source src="${esc(o.video_url)}" type="video/mp4"></video><p class="video-kind">${esc(o.video_kind)}</p><a href="${esc(o.video_page)}" target="_blank" rel="noopener">Video source, description & full credits ↗</a><p id="video-error" class="small muted" hidden>Video playback is unavailable here. Open the publisher’s video page above.</p></div>`:'<p class="video-unavailable">No object-specific video is linked for this catalog entry.</p>'}<div class="object-actions"><button id="object-center" class="button">Center on object</button><button id="object-save" class="button">+ Save to notebook</button></div>`;
  $('#object-panel').scrollTop=0;
  $('#object-center').onclick=()=>flyTo({name:o.name,ra:o.ra,dec:o.dec,fov:o.fov||Math.min(currentField().fov,.15),survey:o.survey||state.survey,type:o.type,description:o.summary});
  $('#object-save').onclick=()=>noteDialog({title:o.name,body:o.summary,ra:o.ra,dec:o.dec,provenance:{catalog:o.catalog,source_url:o.source_url,video_page:o.video_page||null,classification:o.type_code||o.type}});
  const sed=document.createElement('button');sed.className='button';sed.textContent='VizieR photometry';$('.object-actions').append(sed);sed.onclick=()=>openPhotometry(`${o.ra} ${o.dec>=0?'+':''}${o.dec}`);
  const tess=document.createElement('button');tess.className='button';tess.textContent='Find TESS light curves';$('.object-actions').append(tess);tess.onclick=()=>openTessStar(o);
  if(o.video_url)$('#object-video').onerror=()=>$('#video-error').hidden=false;
  positionObjectMarkers();
}

function updateEnhancementControls(){
  const provider=$('#enhancement-provider').value;
  $('#cloud-options').hidden=provider!=='cloud';$('#chatgpt-options').hidden=provider!=='chatgpt';$('#enhance-button').hidden=provider==='chatgpt';
  $('#topaz-settings').hidden=provider!=='topaz';
  $('#cloud-connect').hidden=provider==='topaz';
  if(!enhancementRunning)$('#enhance-button').textContent=provider==='cloud'?'✧ Enhance with OpenAI':provider==='topaz'?`✧ Upscale with Topaz · ${$('#topaz-scale').value}×`:'✧ Enhance locally · 2×';
  $('#cloud-status').textContent=cloudConnection.configured?`Connected · ${cloudConnection.model} · key in ${cloudConnection.storage}.`:'OpenAI is not connected. Add an API key using Cloud connection.';
  $('#topaz-connection').textContent=topazConnection.configured?`Connected · ${topazConnection.model} · key in ${topazConnection.storage}.`:(topazConnection.problem||'Topaz is not connected. Add an API key using Topaz connection.');
  const scale=Number($('#topaz-scale').value),image=state.image;
  const size=image&&Number.isFinite(image.width)&&Number.isFinite(image.height)?` Output: ${image.width*scale} × ${image.height*scale} pixels.`:'';
  $('#topaz-note').textContent=`Sends ${image?.scientific?'the selected FITS display stretch':'the original image or saved color-adjusted copy'} to Topaz when you click Upscale. Uses your Topaz API credits. Save an adjusted copy first to include Image Lab color changes. Standard V2; maximum 25 megapixels.${size}`;
  if(state.image)$('#handoff-download').href=`/api/images/${state.image.id}/handoff?stretch=${$('#fits-stretch').value}`;
}
function renderEnhancementComparison(preferred){
  const image=state.image;if(!image)return;
  const options=[];
  if(image.ai)options.push({value:'local',label:'Local · FSRCNN 2×',result:image.ai});
  for(const result of [...(image.cloud_history||[])].reverse())options.push({value:result.variant,label:`${result.provider}${result.scale?' · '+result.scale+'×':''} · ${date(result.created_at)}`,result});
  const select=$('#ai-output-select');const selection=preferred||select.value;
  select.innerHTML=options.length?options.map(o=>`<option value="${esc(o.value)}">${esc(o.label)}</option>`).join(''):'<option value="none">No enhancement yet</option>';
  if(options.some(o=>o.value===selection))select.value=selection;
  const ai=options.find(o=>o.value===select.value)?.result;
  $('#ai-placeholder').hidden=Boolean(ai);$('#ai-image').hidden=!ai;$('#ai-download').hidden=!ai;
  if(ai){$('#ai-image').src=ai.url+'?v='+Date.now();$('#ai-download').href=ai.url+'?download=true';$('#ai-note').textContent=ai.note+` Preview ${ai.input_size.join(' × ')} → output ${ai.output_size.join(' × ')}.`;}
  else $('#ai-note').textContent='Choose local enhancement, Topaz upscaling, OpenAI cloud editing, or the ChatGPT handoff. Enhanced views are labeled visualizations; candidate detection always uses original FITS data.';
  updateEnhancementControls();
  if(typeof refreshImageLabColors==='function')refreshImageLabColors();
}
async function openCloudConnection(service='image'){
  cloudConnection=await api('/api/cloud/status');updateEnhancementControls();
  modal('OpenAI cloud connection',`<form id="cloud-key-form" class="note-form"><p class="small muted">Image enhancement and voice narration use the OpenAI API and its billing. Enter your API key here; it stays in this app’s backend and is sent only to OpenAI. Your ChatGPT sign-in is not an API key.</p><p class="small"><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">Manage API keys ↗</a> · <a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener">API pricing ↗</a></p><p class="small">${cloudConnection.configured?'Saved API connection · '+esc(cloudConnection.storage):'Not connected'}</p><label for="cloud-api-key">OpenAI API key</label><input id="cloud-api-key" type="password" autocomplete="off" spellcheck="false" required placeholder="Paste your API key privately here"><label class="remember-key"><input id="cloud-remember" type="checkbox">Remember on this Windows account (encrypted)</label><p id="cloud-key-message" class="small" role="status"></p><button id="cloud-key-save" class="button primary" type="submit">Verify & connect</button>${cloudConnection.configured?'<button id="cloud-disconnect" class="button" type="button">Remove saved connection</button>':''}</form>`);
  $('#cloud-key-form').onsubmit=async e=>{
    e.preventDefault();const key=$('#cloud-api-key').value;$('#cloud-api-key').value='';
    const remember=$('#cloud-remember').checked;
    await busy($('#cloud-key-save'),'Checking access…',async()=>{
      cloudConnection=await jsonPost('/api/cloud/connect',{api_key:key,remember,service:service==='speech'?'speech':'image'});updateEnhancementControls();closeModal();toast(service==='speech'?'OpenAI connected for voice narration.':'OpenAI connected. Choose cloud enhancement when you want to send an image.');
    });
  };
  if($('#cloud-disconnect'))$('#cloud-disconnect').onclick=async()=>{cloudConnection=await jsonPost('/api/cloud/disconnect',{});closeModal();updateEnhancementControls();toast(cloudConnection.configured?'Saved key removed. An environment key is still configured.':'OpenAI connection removed.');};
}
async function openTopazConnection(){
  topazConnection=await api('/api/topaz/status');updateEnhancementControls();
  modal('Topaz cloud connection',`<form id="topaz-key-form" class="note-form"><p class="small muted">Topaz upscaling uploads the selected image and uses your Topaz API credits. Your API key stays in this app’s backend and is sent only to Topaz. Connecting does not start an upscale.</p><p class="small">${topazConnection.configured?'Saved API connection · '+esc(topazConnection.storage):'Not connected'}</p><label for="topaz-api-key">Topaz API key</label><input id="topaz-api-key" type="password" autocomplete="off" spellcheck="false" required placeholder="Paste your API key privately here"><label class="remember-key"><input id="topaz-remember" type="checkbox">Remember on this Windows account (encrypted)</label><p id="topaz-key-message" class="small" role="status"></p><button id="topaz-key-save" class="button primary" type="submit">Verify & connect</button>${topazConnection.configured?'<button id="topaz-disconnect" class="button" type="button">Remove saved connection</button>':''}</form>`);
  $('#topaz-key-form').onsubmit=async e=>{
    e.preventDefault();const key=$('#topaz-api-key').value.trim();$('#topaz-api-key').value='';
    const remember=$('#topaz-remember').checked;
    await busy($('#topaz-key-save'),'Checking access…',async()=>{
      topazConnection=await jsonPost('/api/topaz/connect',{api_key:key,remember});updateEnhancementControls();closeModal();toast('Topaz connected. Choose Upscale when you want to send an image.');
    });
  };
  if($('#topaz-disconnect'))$('#topaz-disconnect').onclick=async()=>{
    await busy($('#topaz-disconnect'),'Removing connection…',async()=>{
      topazConnection=await jsonPost('/api/topaz/disconnect',{});closeModal();updateEnhancementControls();toast(topazConnection.configured?'Saved key removed. An environment key is still configured.':'Topaz connection removed.');
    });
  };
}
async function runEnhancement(){
  const provider=$('#enhancement-provider').value;if(provider==='chatgpt'||enhancementRunning||!state.image)return;
  if(!['local','cloud','topaz'].includes(provider))return;
  if(provider==='cloud'&&!cloudConnection.configured){await openCloudConnection();return;}
  if(provider==='topaz'&&!topazConnection.configured){await openTopazConnection();return;}
  const scale=Number($('#topaz-scale').value);
  if(provider==='topaz'&&![2,4].includes(scale))throw new Error('Choose a Topaz scale of 2× or 4×.');
  const id=state.image.id;const button=$('#enhance-button');enhancementRunning=true;
  $('#enhancement-provider').disabled=true;$('#topaz-scale').disabled=true;$('#topaz-connect').disabled=true;
  const endpoint=provider==='cloud'?'enhance-cloud':provider==='topaz'?'enhance-topaz':'enhance';
  const label=provider==='cloud'?'OpenAI is editing… this can take a few minutes':provider==='topaz'?'Topaz is upscaling… this can take a few minutes':'Enhancing on this PC…';
  try{
    await busy(button,label,async()=>{
      const body=provider==='topaz'?{scale,stretch:$('#fits-stretch').value}:{quality:$('#cloud-quality').value,instructions:$('#cloud-instructions').value,stretch:$('#fits-stretch').value};
      const options=provider==='local'?{method:'POST'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(provider==='topaz'?450000:360000)};
      const result=await api(`/api/images/${id}/${endpoint}`,options);
      if(state.image?.id===id){state.image=result;renderEnhancementComparison(provider==='local'?'local':result.cloud_ai.variant);$('#image-provenance').textContent=JSON.stringify(result,null,2);}
      toast(state.image?.id===id?'Enhancement saved. Original data preserved.':'Enhancement saved to the original image in your library.');
    });
  }finally{
    enhancementRunning=false;$('#enhancement-provider').disabled=false;$('#topaz-scale').disabled=false;$('#topaz-connect').disabled=false;updateEnhancementControls();
  }
}
function initObservatoryFeatures(){
  $('#mapping-toggle').onchange=e=>toggleMapping(e.target.checked);
  $('#mapping-labels').onchange=positionObjectMarkers;
  $('#object-filter').oninput=()=>{renderObjectList();renderObjectMarkers();};
  $('#object-panel-back').onclick=showObjectList;
  window.addEventListener('resize',onSkyViewChanged);
  new ResizeObserver(onSkyViewChanged).observe($('#aladin-lite-div'));
  // Aladin can finish resizing after the browser's resize event when a hidden
  // workspace becomes visible. Reproject existing markers without re-querying.
  setInterval(()=>{if(mapUI.enabled&&state.page==='explore'&&!document.hidden)positionObjectMarkers();},350);
  api('/api/objects/featured').then(data=>{
    mapUI.featured=data.rows;mapUI.rows=data.rows;
    $('#featured-objects').innerHTML=data.rows.map(o=>`<button class="object-list-item" data-featured-id="${esc(o.id)}"><strong>${esc(o.name)}</strong><small>${esc(o.type)} · Video</small></button>`).join('');
    $$('[data-featured-id]').forEach(b=>b.onclick=()=>{const o=data.rows.find(o=>o.id===b.dataset.featuredId);flyTo({...o,type:o.type,description:o.summary});showObjectDetail(o);});
    let enabled=false;try{enabled=localStorage.getItem('universe-object-map')==='true';}catch{}
    toggleMapping(enabled);
  }).catch(failure);
  $('#enhancement-provider').onchange=updateEnhancementControls;
  $('#cloud-connect').onclick=()=>openCloudConnection().catch(failure);
  $('#topaz-connect').onclick=()=>openTopazConnection().catch(failure);
  $('#topaz-scale').onchange=updateEnhancementControls;
  $('#enhance-button').onclick=()=>runEnhancement().catch(failure);
  $('#ai-output-select').onchange=()=>renderEnhancementComparison();
  $('#enhancement-upload').onchange=async e=>{
    const file=e.target.files[0];if(!file||!state.image)return;const id=state.image.id;
    try{
      e.target.disabled=true;const form=new FormData();form.append('file',file);
      const result=await api(`/api/images/${id}/import-enhancement`,{method:'POST',body:form});
      if(state.image?.id===id){state.image=result;renderEnhancementComparison(result.cloud_ai.variant);$('#image-provenance').textContent=JSON.stringify(result,null,2);}
      toast('Imported as a separate AI visualization. Original preserved.');
    }catch(error){failure(error);}finally{e.target.disabled=false;e.target.value='';}
  };
  api('/api/cloud/status').then(s=>{cloudConnection=s;updateEnhancementControls();}).catch(failure);
  api('/api/topaz/status').then(s=>{topazConnection=s;updateEnhancementControls();}).catch(error=>{topazConnection={...topazConnection,configured:false,problem:error.message};updateEnhancementControls();});
}
