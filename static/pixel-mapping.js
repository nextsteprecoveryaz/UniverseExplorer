'use strict';

// Display controls for the locally pinned CDS Aladin Lite renderer. Source files are never modified.
class PixelMappingController {
  constructor({host, sky, onResize=()=>{}, storageKey='universe:telescope-pixel-mapping:v1'}) {
    this.host=host; this.sky=sky; this.onResize=onResize; this.storageKey=storageKey;
    this.settings=PixelMappingMath.defaults(); this.profiles={}; this.key=null; this.layer=null;
    this.original=false; this.generation=0; this.viewGeneration=0; this.sampleGeneration=0; this.editGeneration=0;
    this.histogram=null; this.sampleTimer=null; this.frame=null; this.sampling=false; this.persistent=true; this.emptyRetries=0;
    try { const saved=JSON.parse(localStorage.getItem(storageKey)||'{}'); for(const key of ['2mass','optical']) if(saved?.[key]) this.profiles[key]=PixelMappingMath.normalize(saved[key]); } catch { this.persistent=false; }
    this.build(); this.render();
  }
  el(selector) { return this.host.querySelector(selector); }
  build() {
    this.host.classList.add('pixel-mapping');
    this.host.innerHTML=`<div class="pm-heading"><div><span class="overline">CDS ALADIN · DISPLAY</span><h2>Pixel mapping</h2></div><button class="pm-close" type="button" aria-label="Close pixel mapping">×</button></div>
      <div class="pm-scroll"><div class="pm-context"><span data-pm="survey">Waiting for survey</span><span data-pm="mode">Original</span></div>
      <section class="pm-section"><h3>Levels</h3><p class="pm-help">Drag the handles to set the black point, midtone gamma and white point.</p>
      <div class="pm-plot" role="img" aria-label="Sampled luminance histogram and brightness curve preview" title="Brightness curve preview">
        <svg viewBox="0 0 256 112" preserveAspectRatio="none" aria-hidden="true"><path class="pm-grid" d="M0 28H256M0 56H256M0 84H256M64 0V112M128 0V112M192 0V112"/><path data-pm="bars" class="pm-bars"/><path data-pm="curve" class="pm-curve"/></svg>
        <span data-pm="empty" class="pm-empty">Sample the view to show its histogram</span>
      </div>
      <div class="pm-levels" data-pm="track">${['black','mid','white'].map((name,i)=>`<button type="button" class="pm-handle pm-${name}" data-handle="${name}" role="slider" aria-label="${['Black point','Midtones (gamma)','White point'][i]}" aria-valuemin="0" aria-valuemax="255" aria-valuenow="${[0,127.5,255][i]}" title="Drag or use arrow keys; Shift for larger steps"></button>`).join('')}</div>
      <div class="pm-axis"><span>0 · dark</span><span>Luminance</span><span>255 · bright</span></div>
      <div class="pm-numbers">${['black','mid','white'].map((name,i)=>`<label><span class="pm-level-label">${['Black point','Midtones (gamma)','White point'][i]}</span><input data-level="${name}" type="number" min="0" max="255" step="0.1" aria-label="${['Black point value','Midtones (gamma) value','White point value'][i]}"></label>`).join('')}</div>
      <div class="pm-sample-row"><button type="button" class="button" data-action="sample">Refresh histogram</button><button type="button" class="button" data-action="auto">Auto levels</button></div>
      <p data-pm="sample-status" class="pm-caption" role="status">Sampled from unadjusted survey pixels.</p></section>
      <section class="pm-section"><h3>Color &amp; stretch</h3><div class="pm-options"><label>Stretch<select data-setting="stretch" aria-label="Pixel mapping stretch"><option value="linear">Linear</option><option value="asinh">Asinh</option><option value="log">Logarithmic</option><option value="sqrt">Square root</option><option value="pow2">Squared</option></select></label><label>Color map<select data-setting="colormap" aria-label="Pixel mapping color map"><option value="native">Survey colors</option><option value="grayscale">Grayscale</option><option value="viridis">Viridis</option><option value="magma">Magma</option><option value="cividis">Cividis</option></select></label></div>
      <div class="pm-gamma"><span>Midtone gamma <output data-pm="gamma">1.00</output></span><label><input type="checkbox" data-setting="reversed"> Invert colors</label></div>
      <div class="pm-presets"><span>Presets</span><button type="button" data-look="faint">Lift faint detail</button><button type="button" data-look="crisp">Crisp contrast</button></div></section>
      <details class="pm-advanced"><summary>Fine adjustment</summary>${['brightness','contrast','saturation'].map(name=>`<label>${name[0].toUpperCase()+name.slice(1)}<output data-output="${name}">0</output><input type="range" min="-1" max="1" step="0.01" value="0" data-setting="${name}" aria-label="Pixel mapping ${name}"></label>`).join('')}</details>
      <div class="pm-actions"><button type="button" class="button" data-action="original" aria-pressed="false">Show original</button><button type="button" class="button" data-action="reset">Reset display</button></div>
      <p data-pm="status" class="pm-caption" role="status"></p><p class="pm-provenance">CDS Aladin display controls. Sampled luminance is derived from survey colors, not calibrated photometry.</p></div>`;
    this.host.append(this.el('.pm-actions'));
    this.el('.pm-close').onclick=()=>this.setOpen(false);
    this.host.querySelectorAll('[data-handle]').forEach(handle=>{
      const name=handle.dataset.handle;
      handle.onpointerdown=e=>{if(e.button!==0)return; e.preventDefault(); handle.focus(); handle.setPointerCapture(e.pointerId); this.drag={name,id:e.pointerId}; this.dragTo(e.clientX);};
      handle.onpointermove=e=>{if(this.drag?.id===e.pointerId)this.dragTo(e.clientX);};
      const finish=()=>{this.drag=null;}; handle.onpointerup=finish; handle.onpointercancel=finish; handle.onlostpointercapture=finish;
      handle.onkeydown=e=>{const step=(e.shiftKey?10:1)/255; let value=this.settings[name]; if(e.key==='ArrowLeft'||e.key==='ArrowDown')value-=step; else if(e.key==='ArrowRight'||e.key==='ArrowUp')value+=step; else if(e.key==='Home')value=0; else if(e.key==='End')value=1; else return; e.preventDefault(); this.change(PixelMappingMath.moveHandle(this.settings,name,value));};
    });
    this.host.querySelectorAll('[data-level]').forEach(input=>{const update=()=>{if(input.value!==''&&Number.isFinite(input.valueAsNumber))this.change(PixelMappingMath.moveHandle(this.settings,input.dataset.level,input.valueAsNumber/255));};input.oninput=update;input.onchange=()=>{update();input.value=(this.settings[input.dataset.level]*255).toFixed(1);};input.onblur=()=>{input.value=(this.settings[input.dataset.level]*255).toFixed(1);};});
    this.host.querySelectorAll('[data-setting]').forEach(input=>input.oninput=()=>{const key=input.dataset.setting; this.change({...this.settings,[key]:input.type==='checkbox'?input.checked:input.type==='range'?Number(input.value):input.value});});
    this.host.querySelectorAll('[data-look]').forEach(button=>button.onclick=()=>{const look=button.dataset.look; this.change({...PixelMappingMath.defaults(),...(look==='faint'?{black:.01,white:1,mid:.35,stretch:'asinh'}:{black:.06,white:.94,mid:.5,contrast:.15})});});
    this.el('[data-action="reset"]').onclick=()=>this.change(PixelMappingMath.defaults());
    this.el('[data-action="original"]').onclick=()=>{this.original=!this.original;this.editGeneration++;this.render();this.scheduleApply();};
    this.el('[data-action="sample"]').onclick=()=>this.sample();
    this.el('[data-action="auto"]').onclick=()=>this.sample(true);
  }
  setOpen(open) {
    this.host.hidden=!open; this.host.parentElement.classList.toggle('pixel-mapping-open',open);
    this.onResize(open); if(open&&!this.histogram)this.scheduleSample();
  }
  dragTo(clientX) {
    const box=this.el('[data-pm="track"]').getBoundingClientRect();
    if(box.width>0&&this.drag)this.change(PixelMappingMath.moveHandle(this.settings,this.drag.name,(clientX-box.left)/box.width));
  }
  change(settings) {
    this.editGeneration++;
    this.settings=PixelMappingMath.normalize(settings); this.original=false;
    if(this.key)this.profiles[this.key]={...this.settings};
    try { localStorage.setItem(this.storageKey,JSON.stringify(this.profiles)); } catch { this.persistent=false; }
    this.render(); this.scheduleApply();
  }
  async bind(key, layer) {
    if(this.key===key&&this.layer===layer)return;
    this.generation++; this.sampleGeneration++; this.sampling=false;
    const generation=this.generation; this.key=key; this.layer=layer; this.original=false;
    this.settings=PixelMappingMath.normalize(this.profiles[key]||PixelMappingMath.defaults());
    this.invalidateView(); this.render();
    this.el('[data-pm="status"]').textContent='Preparing display controls…';
    try {
      await Promise.resolve(layer?.query);
      // Metadata readiness precedes WASM registration. Wait for this exact layer to be active.
      for(let attempt=0;attempt<150;attempt++) {
        if(generation!==this.generation)return;
        const current=this.sky.getBaseImageLayer();
        if(!layer&&current){layer=current;this.layer=layer;}
        if(layer&&layer===current)break;
        await new Promise(resolve=>setTimeout(resolve,80));
      }
      if(generation!==this.generation)return;
      if(!layer||layer!==this.sky.getBaseImageLayer()){this.el('[data-pm="status"]').textContent='Survey is taking longer to load. Once imagery appears, adjust a control to retry.';return;}
      this.apply(); this.scheduleSample();
    } catch { if(generation===this.generation)this.el('[data-pm="status"]').textContent='Survey unavailable. Display settings will be kept for a retry.'; }
  }
  scheduleApply() {
    if(this.frame!==null)return;
    this.frame=requestAnimationFrame(()=>{this.frame=null; this.apply();});
  }
  apply() {
    if(!this.layer||this.layer!==this.sky.getBaseImageLayer())return;
    const s=this.original?PixelMappingMath.defaults():this.settings;
    try {
      // JPEG/PNG color surveys in Aladin 3.8.2 take byte-valued cuts, unlike FITS intensities.
      this.layer.setCuts(s.black*255,s.white*255);
      this.layer.setColormap(s.colormap,{stretch:s.stretch,reversed:s.reversed});
      this.layer.setGamma(PixelMappingMath.gamma(s));
      // This Aladin release can feed negative graded RGB into pow(), producing a black frame.
      // Use the browser's clamped GPU color filters only on imagery; catalogue markers stay intact.
      this.layer.setBrightness(0); this.layer.setContrast(0); this.layer.setSaturation(0);
      const canvas=this.sky.aladinDiv.querySelector('.aladin-imageCanvas');
      if(canvas)canvas.style.filter=s.brightness||s.contrast||s.saturation?`brightness(${1+s.brightness}) contrast(${1+s.contrast}) saturate(${1+s.saturation})`:'none';
      this.el('[data-pm="status"]').textContent=this.original?'Showing original · your adjustments are kept':(this.persistent?'Saved for this survey in this browser':'Session settings · browser storage unavailable');
    } catch { this.el('[data-pm="status"]').textContent='Survey is still loading. Try the control again when imagery appears.'; }
  }
  invalidateView() {
    this.viewGeneration++; this.sampleGeneration++; this.sampling=false; this.histogram=null; this.emptyRetries=0;
    clearTimeout(this.sampleTimer); this.el('[data-pm="bars"]').setAttribute('d',''); this.el('[data-pm="empty"]').hidden=false;
    this.el('[data-pm="sample-status"]').textContent='View changed · histogram will sample the new field.';
    this.el('[data-action="auto"]').disabled=false; this.el('[data-action="sample"]').disabled=false;
    this.scheduleSample();
  }
  scheduleSample() {
    clearTimeout(this.sampleTimer);
    if(!this.host.hidden)this.sampleTimer=setTimeout(()=>this.sample(),1100);
  }
  async sample(auto=false) {
    clearTimeout(this.sampleTimer);
    const layer=this.layer, generation=this.generation, view=this.viewGeneration, edits=this.editGeneration, serial=++this.sampleGeneration;
    if(!layer||layer!==this.sky.getBaseImageLayer()||typeof layer.readPixel!=='function')return;
    const valid=()=>generation===this.generation&&view===this.viewGeneration&&serial===this.sampleGeneration&&layer===this.sky.getBaseImageLayer();
    this.sampling=true; this.el('[data-action="auto"]').disabled=true; this.el('[data-action="sample"]').disabled=true;
    this.el('[data-pm="sample-status"]').textContent='Sampling unadjusted survey pixels…';
    try {
      const box=this.sky.aladinDiv?.getBoundingClientRect?.()||document.getElementById('telescope-live-sky').getBoundingClientRect();
      if(!box.width||!box.height){this.el('[data-pm="sample-status"]').textContent='Open the map to sample its current view.';return;}
      const samples=[];
      for(let row=0;row<20;row++) {
        if(!valid())return;
        for(let col=0;col<32;col++) {
          // Pixels outside an all-sky projection throw; missing tiles return null.
          try { const pixel=await layer.readPixel((col+.5)*box.width/32,(row+.5)*box.height/20);
            const brightness=PixelMappingController.pixelBrightness(pixel);
            if(brightness!==null)samples.push(brightness);
          } catch { /* No valid survey pixel at this sample position. */ }
        }
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      if(!valid())return;
      const histogram=PixelMappingMath.histogram(samples); this.histogram=histogram;
      this.renderHistogram();
      this.el('[data-pm="sample-status"]').textContent=histogram.count?`${histogram.count.toLocaleString()} samples · log count scale`:'No survey pixels available yet. Let tiles load, then refresh.';
      if(!histogram.count&&!auto&&!this.host.hidden&&this.emptyRetries++<2)this.sampleTimer=setTimeout(()=>this.sample(),2000);
      if(auto&&edits===this.editGeneration) {
        const levels=histogram.count>=32?PixelMappingMath.autoLevels(histogram):null;
        if(levels)this.change({...this.settings,...levels});
        else this.el('[data-pm="sample-status"]').textContent='Not enough brightness variation for auto levels. Try a wider field.';
      }
    } catch { if(valid())this.el('[data-pm="sample-status"]').textContent='Histogram unavailable for this view. Manual display controls still work.'; }
    finally { if(valid()){this.sampling=false;this.el('[data-action="auto"]').disabled=false;this.el('[data-action="sample"]').disabled=false;} }
  }
  static pixelBrightness(pixel) {
    if(Array.isArray(pixel)||ArrayBuffer.isView(pixel)) {
      if(pixel.length<3||!Array.from(pixel).slice(0,3).every(Number.isFinite)||(pixel.length>3&&pixel[3]===0))return null;
      return (.2126*pixel[0]+.7152*pixel[1]+.0722*pixel[2])/255;
    }
    return typeof pixel==='number'&&Number.isFinite(pixel)?pixel/255:null;
  }
  renderHistogram() {
    const h=this.histogram; this.el('[data-pm="empty"]').hidden=!!h?.count;
    if(!h?.count){this.el('[data-pm="bars"]').setAttribute('d','');return;}
    const maximum=Math.log1p(Math.max(...h.bins));
    this.el('[data-pm="bars"]').setAttribute('d',h.bins.map((count,x)=>`M${x} 112v${-(Math.log1p(count)/maximum*108).toFixed(2)}`).join(''));
  }
  render() {
    const s=this.settings;
    this.el('[data-pm="survey"]').textContent=this.key==='2mass'?'Webb · 2MASS':this.key==='optical'?'Hubble · DSS2':'Waiting for survey';
    this.el('[data-pm="mode"]').textContent=this.original?'Original preview':JSON.stringify(s)===JSON.stringify(PixelMappingMath.defaults())?'Original':'Adjusted';
    for(const name of ['black','mid','white']) {
      const handle=this.el(`[data-handle="${name}"]`); handle.style.left=(s[name]*100)+'%'; handle.setAttribute('aria-valuenow',(s[name]*255).toFixed(1));
      const input=this.el(`[data-level="${name}"]`); if(document.activeElement!==input)input.value=(s[name]*255).toFixed(1);
    }
    for(const key of ['stretch','colormap','reversed','brightness','contrast','saturation']) {
      const input=this.el(`[data-setting="${key}"]`); if(input.type==='checkbox')input.checked=s[key]; else input.value=s[key];
      const output=this.el(`[data-output="${key}"]`); if(output)output.textContent=(s[key]>0?'+':'')+s[key].toFixed(2);
    }
    this.el('[data-pm="gamma"]').textContent=PixelMappingMath.gamma(s).toFixed(2);
    const original=this.el('[data-action="original"]'); original.setAttribute('aria-pressed',String(this.original)); original.textContent=this.original?'Show adjustments':'Show original';
    // Scalar tone curve: native levels/stretch/gamma, followed by browser brightness and contrast.
    const gamma=PixelMappingMath.gamma(s);
    this.el('[data-pm="curve"]').setAttribute('d',Array.from({length:129},(_,i)=>{const x=i/128;let y=Math.max(0,Math.min(1,(x-s.black)/(s.white-s.black)));if(s.stretch==='sqrt')y=Math.sqrt(y);else if(s.stretch==='pow2')y*=y;else if(s.stretch==='asinh')y=Math.asinh(10*y)/3;else if(s.stretch==='log')y=Math.log(1000*y+1)/Math.log(1000);if(s.reversed)y=1-y;y=Math.pow(Math.max(0,Math.min(1,y)),gamma);y=Math.max(0,Math.min(1,.5+(1+s.contrast)*(y*(1+s.brightness)-.5)));return `${i?'L':'M'}${x*256} ${(1-y)*112}`;}).join(''));
  }
}
