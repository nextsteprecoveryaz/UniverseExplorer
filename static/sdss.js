'use strict';
const sdssUI={config:null,image:null,map:null,imageSerial:0,mapSerial:0,searchSerial:0,overlay:null,tab:'images'};
function sdssField(){
  const ra=Number($('#sdss-ra').value),dec=Number($('#sdss-dec').value),fov=Number($('#sdss-field').value)/60,size=Number($('#sdss-size').value);
  if(!Number.isFinite(ra)||ra<0||ra>=360||!Number.isFinite(dec)||Math.abs(dec)>90||!Number.isFinite(fov)||fov<.01||fov>2||![1024,2048].includes(size))throw Error('Enter valid sky coordinates and a field from 0.6 to 120 arcminutes.');
  return {ra,dec,fov,size};
}
function sdssSetField(f){$('#sdss-ra').value=Number(f.ra).toFixed(7);$('#sdss-dec').value=Number(f.dec).toFixed(7);$('#sdss-field').value=(Math.min(2,Math.max(.01,f.fov||.23))*60).toFixed(3);}
async function sdssJob(path,data,stillWanted=()=>true,onProgress=()=>{}){
  const job=await jsonPost('/api/sdss/'+path,data);
  return awaitAtlasJob(job,stillWanted,onProgress);
}
function sdssProgress(selector,job){
  const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(job.created_at))/1000));
  $(selector).textContent=(job.message||(job.state==='queued'?'Waiting for an available download slot…':'Contacting the image service…'))+(Number.isFinite(seconds)?` · ${seconds}s elapsed`:'');
}
function sdssTab(tab){sdssUI.tab=tab;$$('[data-sdss-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.sdssTab===tab)));$('#sdss-images').hidden=tab!=='images';$('#sdss-manga').hidden=tab!=='manga';}
function sdssStyle(){
  const brightness=Number($('#sdss-brightness').value)/100,contrast=Number($('#sdss-contrast').value)/100,saturation=Number($('#sdss-saturation').value)/100;
  const filter=`brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
  $('#sdss-image').style.filter=filter;return filter;
}
function sdssResetStyle(){for(const id of ['brightness','contrast','saturation'])$('#sdss-'+id).value='100';sdssStyle();}
async function sdssLoadImage(source='auto'){
  const field=sdssField(),serial=++sdssUI.imageSerial;
  $('#sdss-image-status').textContent='Retrieving the SDSS color image…';$('#sdss-image-load').disabled=true;
  $('#sdss-try-skyserver').hidden=true;$('#sdss-image').hidden=true;$('#sdss-image-actions').hidden=true;
  $('#sdss-adjustments').hidden=true;$('#sdss-image-source').textContent='';$('#sdss-empty-coverage').hidden=true;
  $('#sdss-image-empty').hidden=false;$('#sdss-image-empty').textContent='Loading this field. Slow connections are retried automatically.';
  try{
    const result=await sdssJob('cutout',{...field,source},()=>serial===sdssUI.imageSerial,job=>sdssProgress('#sdss-image-status',job));
    if(!result||serial!==sdssUI.imageSerial)return;
    sdssUI.image=result;const img=$('#sdss-image');
    img.onload=()=>{if(sdssUI.image!==result)return;$('#sdss-style-save').disabled=false;};
    img.onerror=()=>{if(sdssUI.image===result){$('#sdss-style-save').disabled=true;$('#sdss-image-status').textContent='The saved image could not load. Retrieve this field again.';}};
    $('#sdss-style-save').disabled=true;img.src=result.url;img.alt=`${result.provider==='cds'?'SDSS DR9 color mosaic':'SDSS optical color field'} at RA ${result.ra.toFixed(5)}°, Dec ${result.dec.toFixed(5)}°`;
    $('#sdss-image-empty').hidden=true;img.hidden=false;$('#sdss-image-actions').hidden=false;$('#sdss-adjustments').hidden=false;sdssResetStyle();
    $('#sdss-original').href=result.url;$('#sdss-original').download=result.name;
    $('#sdss-image-skyserver').href=result.navigate_url;
    $('#sdss-image-status').textContent=`${result.size} × ${result.size} · ${(result.fov*60).toFixed(2)}′ field · ${result.scale_arcsec.toFixed(3)}″ per output pixel${result.delivery_note?' · '+result.delivery_note:''}`;
    $('#sdss-image-source').textContent=`${result.source_label||(result.provider==='cds'?'SDSS DR9 mosaic / CDS HiPS2FITS':'SDSS / SkyServer DR20 interface · legacy optical imaging')} · retrieved ${date(result.created_at)}. Native camera sampling ≈ 0.396″/pixel; output size does not add resolved detail.`;
    $('#sdss-try-skyserver').hidden=result.provider!=='cds';
    $('#sdss-empty-coverage').hidden=result.dark_fraction<.98;
  }catch(e){if(serial===sdssUI.imageSerial){$('#sdss-image-status').textContent=e.message;$('#sdss-image-empty').textContent='This field could not be retrieved. Previously downloaded images remain cached.';}}
  finally{if(serial===sdssUI.imageSerial)$('#sdss-image-load').disabled=false;}
}
async function sdssImport(ident){openImage(await jsonPost('/api/sdss/import',{ident}));}
function sdssSaveStyle(){
  const result=sdssUI.image,img=$('#sdss-image');if(!result||!img.complete||!img.naturalWidth)return;
  const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight+48;
  const ctx=canvas.getContext('2d');ctx.filter=sdssStyle();ctx.drawImage(img,0,0);ctx.filter='none';
  ctx.fillStyle='#081019';ctx.fillRect(0,img.naturalHeight,canvas.width,48);ctx.fillStyle='#fff';ctx.font='14px sans-serif';
  ctx.fillText(`${result.provider==='cds'?'SDSS DR9 / CDS':'SDSS / SkyServer'} · DISPLAY EDIT · RA ${result.ra.toFixed(5)}° Dec ${result.dec.toFixed(5)}° · visualization only`,14,img.naturalHeight+29);
  canvas.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=result.name.replace('.jpg','-display-edit.png');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},'image/png');
}
function sdssExploreImage(){const d=sdssUI.image;if(!d)return;flyTo({name:'SDSS galaxy field',type:'SDSS DR9 · OPTICAL MAP',ra:d.ra,dec:d.dec,fov:d.fov,survey:'sdss-color',description:'SDSS DR9 map through CDS. Return to SDSS galaxies for the SkyServer image.'});}
async function sdssNearby(){
  const f=sdssField(),serial=++sdssUI.searchSerial;
  $('#sdss-nearby-status').textContent='Searching the MaNGA DR17 catalog within 1°…';$('#sdss-nearby').disabled=true;
  try{
    const d=await sdssJob('manga/nearby',{ra:f.ra,dec:f.dec,radius:1},()=>serial===sdssUI.searchSerial,job=>sdssProgress('#sdss-nearby-status',job));
    if(!d||serial!==sdssUI.searchSerial)return;
    $('#sdss-nearby-status').textContent=`${d.rows.length} observations within 1°${d.at_limit?' · nearest 25 shown':''}. ${d.rows.length?'Select a galaxy to inspect its maps.':'Try a MaNGA showcase below.'}`;
    $('#sdss-nearby-results').innerHTML=d.rows.map((r,i)=>`<button class="sdss-target" data-sdss-target="${i}"><strong>${esc(r.plateifu)}</strong><span>${esc(r.name||'MaNGA target')}</span><span>${Number(r.distance_arcmin).toFixed(1)}′ away · z ${r.redshift==null?'not reported':Number(r.redshift).toFixed(4)}</span></button>`).join('');
    $$('[data-sdss-target]').forEach(b=>b.onclick=()=>sdssSelectGalaxy(d.rows[Number(b.dataset.sdssTarget)]));
  }catch(e){if(serial===sdssUI.searchSerial)$('#sdss-nearby-status').textContent=e.message;}
  finally{if(serial===sdssUI.searchSerial)$('#sdss-nearby').disabled=false;}
}
function sdssSelectGalaxy(g){$('#sdss-plateifu').value=g.plateifu;sdssSetField({...g,fov:.03});sdssTab('manga');sdssLoadMap().catch(failure);}
function sdssPixelAt(map,x,y){
  const col=Math.min(map.width-1,Math.max(0,Math.floor(x*map.width))),row=map.height-1-Math.min(map.height-1,Math.max(0,Math.floor(y*map.height)));
  if(!map.valid[row][col])return `Spatial sample (${col}, ${row}): masked or below the selected gas S/N.`;
  if(!map.values)return `Spatial sample (${col}, ${row}): assigned S/H/O display colors. Download measurements for the individual fluxes.`;
  const value=map.values[row][col];return `Spatial sample (${col}, ${row}): ${Number(value).toPrecision(5)} ${map.unit}`;
}
async function sdssLoadMap(){
  const plateifu=$('#sdss-plateifu').value.trim(),product=$('#sdss-product').value,snr=Number($('#sdss-snr').value);
  if(!/^\d{4,5}-\d{4,5}$/.test(plateifu)||!Number.isFinite(snr)||snr<0||snr>20)throw Error('Enter a MaNGA plate-IFU identifier and a gas signal-to-noise threshold from 0 to 20.');
  const serial=++sdssUI.mapSerial;$('#sdss-map-status').textContent='Retrieving measured MaNGA maps…';$('#sdss-map-load').disabled=true;
  try{
    const d=await sdssJob('manga/map',{plateifu,product,snr},()=>serial===sdssUI.mapSerial,job=>sdssProgress('#sdss-map-status',job));
    if(!d||serial!==sdssUI.mapSerial)return;
    sdssUI.map=d;$('#sdss-map-image').src=d.url;$('#sdss-map-image').alt=`${d.label}, MaNGA ${d.plateifu}, masked spatial samples shown as empty`;
    $('#sdss-map-content').hidden=false;$('#sdss-map-empty').hidden=true;
    $('#sdss-map-title').textContent=`${d.label} · ${d.plateifu}`;
    $('#sdss-map-status').textContent=`${d.valid_pixels} / ${d.total_pixels} spatial samples displayed · ${d.width} × ${d.height} native grid · ${d.pixel_scale_arcsec.toFixed(2)}″ sampling`;
    $('#sdss-map-unit').textContent=d.unit;$('#sdss-map-scale').className='sdss-color-scale '+(d.product.includes('velocity')?'velocity':d.product==='gas_rgb'?'rgb':'flux');
    $('#sdss-map-low').textContent=d.limits?Number(d.limits[0]).toPrecision(4):'R: [S II]';$('#sdss-map-high').textContent=d.limits?Number(d.limits[1]).toPrecision(4):'G: Hα · B: [O III]';
    $('#sdss-map-processing').textContent=d.stretch;
    $('#sdss-map-quality').textContent=`DR17 · ${d.pipeline.bintype} / ${d.pipeline.template} · DAP ${d.pipeline.dap}. Only finite, unflagged samples with positive inverse variance are displayed. Gas flux must be positive and meet S/N ≥ ${d.snr}; Hα quality also filters gas velocity. Stellar velocity uses its own quality mask. ${d.dap_quality?'Whole-observation DAP quality flag: '+d.dap_quality+'. Review this observation in Marvin.':''}`;
    $('#sdss-map-measurements').href=d.data_url;$('#sdss-map-measurements').download=`manga-${d.plateifu}-${d.product}-measurements.json`;
    $('#sdss-map-download').href=d.url;$('#sdss-map-download').download=`manga-${d.plateifu}-${d.product}.png`;
    $('#sdss-marvin').href=d.marvin_url;$('#sdss-pixel').textContent='Move over the map to inspect a measured spatial sample. North is up; east is left.';
  }catch(e){if(serial===sdssUI.mapSerial)$('#sdss-map-status').textContent=e.message;}
  finally{if(serial===sdssUI.mapSerial)$('#sdss-map-load').disabled=false;}
}
function sdssRemoveOverlay(){if(sdssUI.overlay)state.sky?.removeImageLayer('sdss-manga');sdssUI.overlay=null;$('#sdss-remove-overlay').disabled=true;}
function sdssGalaxyPhoto(){const d=sdssUI.map;if(!d)return;sdssSetField({ra:d.ra,dec:d.dec,fov:Math.max(.03,d.width*d.pixel_scale_arcsec/3600*3)});sdssTab('images');sdssLoadImage().catch(failure);}
function sdssOverlay(){
  const d=sdssUI.map;if(!d||!state.sky)return;
  sdssRemoveOverlay();
  flyTo({name:'MaNGA '+d.plateifu,type:'MEASURED SPECTRAL MAP',ra:d.ra,dec:d.dec,fov:Math.max(.01,d.width*d.pixel_scale_arcsec/3600*2),survey:'sdss-color',description:d.label+' · '+d.processing});
  const layer=A.image(d.url,{name:'MaNGA DR17 · '+d.label,imgFormat:'png',wcs:d.wcs,opacity:1,successCallback:()=>toast('MaNGA map registered to the sky. Remove it from SDSS galaxies.'),errorCallback:()=>toast('The MaNGA overlay could not render.',true)});
  sdssUI.overlay=layer;state.sky.setOverlayImageLayer(layer,'sdss-manga');$('#sdss-remove-overlay').disabled=false;
}
async function openSDSS(){
  if(sdssUI.config)return;
  try{
    const config=await api('/api/sdss/config');sdssUI.config=config;
    $('#sdss-showcases').innerHTML=config.showcases.map((g,i)=>`<button class="sdss-showcase" data-sdss-showcase="${i}"><span>${g.plateifu?'SPECTRAL EXPLORATION':'OPTICAL EXPLORATION'}</span><strong>${esc(g.name)}</strong><small>${esc(g.description)}</small></button>`).join('');
    $$('[data-sdss-showcase]').forEach(b=>b.onclick=()=>{const g=config.showcases[Number(b.dataset.sdssShowcase)];sdssSetField(g);if(g.plateifu)sdssSelectGalaxy(g);else{sdssTab('images');sdssLoadImage().catch(failure);}});
    sdssSetField(config.showcases[0]);await sdssLoadImage();
  }catch(e){$('#sdss-image-status').textContent=e.message;}
}
function initSDSS(){
  const nav=document.createElement('button');nav.className='nav-item';nav.dataset.page='sdss';nav.textContent='◌ SDSS galaxies';nav.onclick=()=>showPage('sdss');$('nav[aria-label="Workspace"]').append(nav);
  const page=document.createElement('section');page.id='sdss-page';page.className='page content-page';page.innerHTML=`
  <div class="sdss-heading"><div><div class="overline">THE SLOAN DIGITAL SKY SURVEY</div><h1>A universe of galaxies<span>.</span></h1><p>Explore optical color, then reveal the gas and motion inside a galaxy.</p></div><a class="button" href="https://skyserver.sdss.org/dr20/VisualTools/navi" target="_blank" rel="noopener">SkyServer Navigate ↗</a></div>
  <div class="sdss-field-controls"><label>Right ascension (°)<input id="sdss-ra" type="number" step="any" min="0" max="359.9999999" value="202.469575"></label><label>Declination (°)<input id="sdss-dec" type="number" step="any" min="-90" max="90" value="47.1952583"></label><label>Field width (arcmin)<input id="sdss-field" type="number" min="0.6" max="120" step="any" value="13.8"></label><label>Image size<select id="sdss-size"><option value="2048">2048 × 2048</option><option value="1024">1024 × 1024 · faster</option></select></label><button id="sdss-use-map" class="button">Use current map position</button></div>
  <div class="sdss-tabs" role="tablist" aria-label="SDSS workspace"><button role="tab" data-sdss-tab="images" aria-selected="true">Optical image studio</button><button role="tab" data-sdss-tab="manga" aria-selected="false">MaNGA gas & motion</button></div>
  <section id="sdss-images" role="tabpanel" aria-label="Optical image studio"><div class="sdss-section-tools"><button id="sdss-image-load" class="button primary">Load SDSS image</button><span id="sdss-image-status" role="status">Choose a field to begin.</span></div><div class="sdss-image-stage"><div id="sdss-image-empty" class="empty-state">Your SDSS field will appear here.</div><img id="sdss-image" alt="SDSS optical color field" hidden></div><p id="sdss-empty-coverage" class="sdss-notice" hidden>This image is almost entirely dark. This position may fall outside SDSS imaging coverage; try a showcase field.</p>
  <div id="sdss-adjustments" class="sdss-adjustments" hidden><label>Brightness<input id="sdss-brightness" type="range" min="40" max="220" value="100"></label><label>Contrast<input id="sdss-contrast" type="range" min="50" max="180" value="100"></label><label>Color saturation<input id="sdss-saturation" type="range" min="0" max="200" value="100"></label><button id="sdss-style-reset" class="button">Reset display</button></div>
  <div id="sdss-image-actions" class="sdss-actions" hidden><a id="sdss-original" class="button" download>Download original JPEG</a><button id="sdss-style-save" class="button">Save styled PNG</button><button id="sdss-image-lab" class="button primary">Open original in Image Lab</button><button id="sdss-image-explore" class="button">Fly through SDSS map</button><a id="sdss-image-skyserver" class="button" target="_blank" rel="noopener">This field in SkyServer ↗</a></div><p id="sdss-image-source" class="small muted"></p><p class="small muted">Display controls change appearance. Image Lab offers local enhancement and your optional cloud AI connection; originals remain available.</p></section>
  <section id="sdss-manga" role="tabpanel" aria-label="MaNGA gas and motion" hidden><div class="sdss-section-tools"><button id="sdss-nearby" class="button">Find MaNGA galaxies near this field</button><span id="sdss-nearby-status" role="status">Search within 1° or select a MaNGA showcase below.</span></div><div id="sdss-nearby-results" class="sdss-targets"></div>
  <div class="sdss-field-controls"><label>MaNGA plate-IFU<input id="sdss-plateifu" value="8444-12704" placeholder="8444-12704"></label><label>Measured view<select id="sdss-product"><option value="ha">Hydrogen Hα</option><option value="oiii">Oxygen [O III]</option><option value="sii">Sulfur [S II] 6718</option><option value="gas_rgb">Gas color composite · S/H/O</option><option value="gas_velocity">Hα gas velocity</option><option value="stellar_velocity">Stellar velocity</option></select></label><label>Minimum gas S/N<input id="sdss-snr" type="number" min="0" max="20" step="0.5" value="3"></label><button id="sdss-map-load" class="button primary">Load measured map</button></div>
  <p id="sdss-map-status" role="status">MaNGA maps come from resolved spectra of selected galaxies, with much coarser spatial resolution than telescope photographs.</p><div id="sdss-map-empty" class="empty-state sdss-map-empty">Choose a galaxy and a measured view.</div><div id="sdss-map-content" hidden><h2 id="sdss-map-title"></h2><div class="sdss-map-layout"><figure><div class="sdss-map-frame"><img id="sdss-map-image" alt="MaNGA measured map"></div><figcaption id="sdss-pixel" role="status"></figcaption></figure><div class="sdss-map-explanation"><span class="overline">MEASURED LIGHT, ASSIGNED COLORS</span><h3 id="sdss-map-unit"></h3><div id="sdss-map-scale" class="sdss-color-scale"></div><div class="sdss-scale-values"><span id="sdss-map-low"></span><span id="sdss-map-high"></span></div><p id="sdss-map-processing"></p><p id="sdss-map-quality" class="small muted"></p><p class="small muted">Transparent areas are excluded measurements. Native sampling is retained; extra display pixels do not add spatial detail. Gas-line brightness is not an abundance measurement. Velocity colors show motion along our line of sight relative to the pipeline systemic reference.</p><a id="sdss-marvin" class="button" target="_blank" rel="noopener">Full observation in Marvin ↗</a></div></div>
  <div class="sdss-actions"><button id="sdss-map-overlay" class="button primary">Show measured map on sky</button><button id="sdss-remove-overlay" class="button" disabled>Remove MaNGA overlay</button><a id="sdss-map-download" class="button" download>Download map PNG</a><a id="sdss-map-measurements" class="button" download>Download measurements & masks</a><button id="sdss-map-lab" class="button">Open visualization in Image Lab</button></div></div></section>
  <div class="sdss-showcase-heading"><span class="overline">FIELDS TO EXPLORE</span><p>Start with a spiral galaxy or go inside a MaNGA observation.</p></div><div id="sdss-showcases" class="sdss-showcases"></div><details class="sdss-sources"><summary>Sources, releases & scientific context</summary><p>Continuous map: SDSS DR9 g/r/i imagery through CDS HiPS. Color image studio: the SDSS DR20 SkyServer interface serving legacy optical imaging. Spectral maps: MaNGA DR17 via Marvin, using the HYB10 / MILESHC-MASTARSSP analysis. These products differ in resolution, dates and processing.</p><div class="sdss-actions"><a href="https://www.sdss4.org/science/" target="_blank" rel="noopener">SDSS science ↗</a><a href="https://www.sdss4.org/surveys/manga/" target="_blank" rel="noopener">About MaNGA ↗</a><a href="https://www.sdss.org/dr20/software/" target="_blank" rel="noopener">SDSS software ↗</a></div></details>`;
  $('main').append(page);
  const retryImage=document.createElement('button');retryImage.id='sdss-try-skyserver';retryImage.className='button';retryImage.textContent='Try SkyServer image';retryImage.hidden=true;retryImage.onclick=()=>sdssLoadImage('skyserver').catch(failure);$('#sdss-image-actions').append(retryImage);
  $$('[data-sdss-tab]').forEach(b=>b.onclick=()=>sdssTab(b.dataset.sdssTab));
  $('#sdss-image-load').onclick=()=>sdssLoadImage().catch(failure);
  $('#sdss-use-map').onclick=()=>{sdssSetField(currentField());toast('Explorer coordinates copied. Load the image or search MaNGA for this field.');};
  for(const id of ['brightness','contrast','saturation'])$('#sdss-'+id).oninput=sdssStyle;
  $('#sdss-style-reset').onclick=sdssResetStyle;$('#sdss-style-save').onclick=sdssSaveStyle;
  $('#sdss-image-lab').onclick=()=>busy($('#sdss-image-lab'),'Opening…',()=>sdssImport(sdssUI.image.id));
  $('#sdss-image-explore').onclick=sdssExploreImage;
  $('#sdss-nearby').onclick=()=>sdssNearby().catch(failure);$('#sdss-map-load').onclick=()=>sdssLoadMap().catch(failure);
  $('#sdss-product').onchange=()=>{if(sdssUI.map)sdssLoadMap().catch(failure);};
  $('#sdss-map-image').onpointermove=e=>{const d=sdssUI.map;if(!d)return;const box=e.target.getBoundingClientRect();$('#sdss-pixel').textContent=sdssPixelAt(d,(e.clientX-box.left)/box.width,(e.clientY-box.top)/box.height);};
  $('#sdss-map-overlay').onclick=sdssOverlay;$('#sdss-remove-overlay').onclick=sdssRemoveOverlay;
  const galaxyPhoto=document.createElement('button');galaxyPhoto.className='button';galaxyPhoto.textContent='View galaxy in optical light';galaxyPhoto.onclick=sdssGalaxyPhoto;$('#sdss-map-overlay').after(galaxyPhoto);
  $('#sdss-map-lab').onclick=()=>busy($('#sdss-map-lab'),'Opening…',()=>sdssImport(sdssUI.map.image_id));
}
