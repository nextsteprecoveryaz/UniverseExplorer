'use strict';
const compareUI={left:null,right:null,opening:null,frame:null,last:null,serial:0};
function compareReadout(){
  const l=compareUI.left;if(!l)return;
  const [ra,dec]=l.getRaDec(),fov=l.getFov()[0];
  $('#compare-coordinates').textContent=`Both layers: ICRS RA ${ra.toFixed(5)}° · Dec ${dec.toFixed(5)}° · field ${fov.toFixed(5)}°`;
  if(compareUI.right){const [r,d]=compareUI.right.getRaDec();$('#compare-coordinates').title=`Left: ${ra.toFixed(8)}, ${dec.toFixed(8)}; ${fov.toFixed(8)}°. Right: ${r.toFixed(8)}, ${d.toFixed(8)}; ${compareUI.right.getFov()[0].toFixed(8)}°. Rotation: ${l.getRotation().toFixed(4)}° / ${compareUI.right.getRotation().toFixed(4)}°.`;}
}
function syncComparison(){
  if(compareUI.frame)return;
  compareUI.frame=requestAnimationFrame(()=>{
    compareUI.frame=null;const l=compareUI.left,r=compareUI.right;if(!l||!r)return;
    const [ra,dec]=l.getRaDec(),fov=l.getFov()[0],rotation=l.getRotation();
    const old=compareUI.last;
    if(!old||old.ra!==ra||old.dec!==dec)r.gotoRaDec(ra,dec);
    if(!old||old.fov!==fov)r.setFoV(fov);
    if(!old||old.rotation!==rotation)r.setRotation(rotation);
    compareUI.last={ra,dec,fov,rotation};compareReadout();
  });
}
function compareLayers(){
  if(!compareUI.left)return;
  const serial=++compareUI.serial;
  for(const side of ['left','right']){
    const s=state.config.surveys.find(s=>s.id===$('#compare-'+side).value);
    const status=$('#compare-'+side+'-status');status.textContent='Loading survey…';
    // Remove the previous base image before relabeling: a failed lens must not show an old lens.
    compareUI[side].removeImageLayer('base');
    compareUI[side].setImageSurvey(A.HiPS(atlasSurveyURL(s),{name:s.name,
      successCallback:()=>{if(serial===compareUI.serial)status.textContent='Survey ready · blank areas may have no coverage';},
      errorCallback:()=>{if(serial===compareUI.serial)status.textContent='Survey unavailable · reconnect or choose a downloaded layer';}}));
    $('#compare-'+side+'-title').textContent=s.name;
    $('#compare-'+side+'-description').textContent=s.description;
  }
}
function compareBlend(){
  const value=Number($('#compare-slider').value),blend=$('#compare-mode').value==='blend';
  $('#compare-right-map').style.clipPath=blend?'none':`inset(0 0 0 ${value}%)`;
  $('#compare-right-map').style.opacity=blend?value/100:1;
  $('#compare-divider').style.left=value+'%';$('#compare-divider').hidden=blend;
  $('#compare-slider-label').textContent=blend?`Right layer opacity: ${value}%`:`Comparison divider: ${value}%`;
}
async function openComparison(){
  if(compareUI.opening)return compareUI.opening;
  compareUI.opening=(async()=>{
    await A.init;
    const v=currentField();
    if(!compareUI.left){
      const opts={target:`${v.ra} ${v.dec}`,fov:v.fov,projection:'AIT',cooFrame:'ICRSd',showReticle:false,showZoomControl:false,showFullscreenControl:false,showLayersControl:false,showGotoControl:false,showShareControl:false,showFrame:false,showCooLocation:false,showProjectionControl:false,showFov:false,showCooGrid:false,showStatusBar:false,showSimbadPointerControl:false,showContextMenu:false,backgroundColor:'#03070c'};
      for(const side of ['left','right'])compareUI[side]=A.aladin('#compare-'+side+'-map',{...opts,survey:atlasSurveyURL(state.config.surveys.find(s=>s.id===$('#compare-'+side).value))});
      compareUI.left.on('positionChanged',syncComparison);compareUI.left.on('zoomChanged',syncComparison);
      compareUI.left.on('rotationChanged',syncComparison);
      compareLayers();
    }
    window.dispatchEvent(new Event('resize'));compareUI.last=null;syncComparison();compareBlend();
  })();
  try{await compareUI.opening;}finally{compareUI.opening=null;}
}
function initComparison(){
  const page=document.createElement('section');page.id='compare-page';page.className='page compare-page';
  page.innerHTML=`<div class="compare-heading"><div><div class="overline">THE SAME SKY, DIFFERENT LIGHT</div><h1>Compare lenses<span>.</span></h1><p>Drag anywhere on the sky to steer both layers. Scroll to zoom.</p></div><div class="flex"><button id="compare-use-current" class="button">Use explorer position</button><button id="compare-return" class="button">Explore this field ↗</button></div></div><div class="compare-toolbar"><label>Left lens<select id="compare-left" aria-label="Left comparison lens"></select></label><button id="compare-swap" class="icon-button" aria-label="Swap comparison lenses">⇄</button><label>Right lens<select id="compare-right" aria-label="Right comparison lens"></select></label><label>Display<select id="compare-mode"><option value="swipe">Swipe divider</option><option value="blend">Blend layers</option></select></label><div class="compare-range"><label for="compare-slider" id="compare-slider-label">Comparison divider: 50%</label><input id="compare-slider" type="range" min="0" max="100" value="50"></div></div><div id="compare-stage"><div id="compare-left-map" class="comparison-map" aria-label="Steer synchronized wavelength maps"></div><div id="compare-right-map" class="comparison-map" aria-label="Right synchronized wavelength layer"></div><div id="compare-divider"><span>↔</span></div><div class="compare-map-label left" id="compare-left-title"></div><div class="compare-map-label right" id="compare-right-title"></div><div id="compare-coordinates" role="status"></div><div class="compare-zoom"><button id="compare-in" class="button" aria-label="Zoom comparison in">+</button><button id="compare-out" class="button" aria-label="Zoom comparison out">−</button></div></div><div class="compare-legends"><p id="compare-left-description"></p><p id="compare-right-description"></p></div><p class="compare-note">Coordinates stay synchronized. Resolution, observation dates and processing differ between surveys. Brightness and colors are display values; blending does not measure gas abundance. Empty regions may have no coverage. CDS Aladin / HiPS.</p>`;
  $('main').append(page);
  for(const side of ['left','right']){const status=document.createElement('span');status.id='compare-'+side+'-status';status.className='compare-layer-status '+side;$('#compare-stage').append(status);}
  const options=skyMapSurveys().map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  $('#compare-left').innerHTML=options;$('#compare-right').innerHTML=options;$('#compare-left').value='optical';$('#compare-right').value='2mass';
  $('#compare-left').onchange=compareLayers;$('#compare-right').onchange=compareLayers;
  $('#compare-swap').onclick=()=>{const old=$('#compare-left').value;$('#compare-left').value=$('#compare-right').value;$('#compare-right').value=old;compareLayers();};
  $('#compare-mode').onchange=compareBlend;$('#compare-slider').oninput=compareBlend;
  $('#compare-use-current').onclick=()=>{const v=currentField();compareUI.left.gotoRaDec(v.ra,v.dec);compareUI.left.setFoV(v.fov);compareUI.left.setRotation(0);syncComparison();};
  $('#compare-return').onclick=()=>{const [ra,dec]=compareUI.left.getRaDec();flyTo({name:'Compared field',ra,dec,fov:compareUI.left.getFov()[0],survey:$('#compare-left').value,type:'MULTIWAVELENGTH EXPLORATION'});};
  $('#compare-in').onclick=()=>{compareUI.left.setFoV(Math.max(.00001,compareUI.left.getFov()[0]/2));syncComparison();};
  $('#compare-out').onclick=()=>{compareUI.left.setFoV(Math.min(360,compareUI.left.getFov()[0]*2));syncComparison();};
  const divider=$('#compare-divider');divider.onpointerdown=e=>{divider.setPointerCapture(e.pointerId);e.preventDefault();};divider.onpointermove=e=>{if(!divider.hasPointerCapture(e.pointerId))return;const box=$('#compare-stage').getBoundingClientRect();$('#compare-slider').value=Math.max(0,Math.min(100,(e.clientX-box.left)/box.width*100));compareBlend();};
  window.addEventListener('resize',()=>{compareUI.last=null;if(state.page==='compare')syncComparison();});
}
