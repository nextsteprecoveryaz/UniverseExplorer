'use strict';

// Display controls for the locally pinned CDS Aladin Lite renderer. Source files are never modified.
class PixelMappingController {
  constructor({host, sky, onResize=()=>{}, onChange=()=>{}, surveyInfo=null, captureKind='telescope-live-capture', captureLabel='Telescope Live', storageKey='universe:telescope-pixel-mapping:v1'}) {
    this.host=host; this.sky=sky; this.onResize=onResize; this.onChange=onChange; this.surveyInfo=surveyInfo; this.captureKind=captureKind; this.captureLabel=captureLabel; this.storageKey=storageKey;
    this.settings=PixelMappingMath.defaults(); this.profiles=Object.create(null); this.key=null; this.layer=null; this.nativeRanges=new WeakMap();
    this.original=false; this.generation=0; this.viewGeneration=0; this.sampleGeneration=0; this.editGeneration=0;
    this.histogram=null; this.sampleTimer=null; this.frame=null; this.sampling=false; this.persistent=true; this.emptyRetries=0;
    this.filterId='pixel-color-'+(++PixelMappingController.serial); this.exporting=false;
    try { const saved=JSON.parse(localStorage.getItem(storageKey)||'{}'); if(saved&&typeof saved==='object'&&!Array.isArray(saved))for(const [key,value] of Object.entries(saved))if(/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(key))this.profiles[key]=PixelMappingMath.normalize(value); } catch { this.persistent=false; }
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
      <section class="pm-section"><h3>Color &amp; stretch</h3><div class="pm-options"><label>Stretch<select data-setting="stretch" aria-label="Pixel mapping stretch"><option value="linear">Linear</option><option value="asinh">Asinh</option><option value="log">Logarithmic</option><option value="sqrt">Square root</option><option value="pow2">Squared</option></select></label><label>Color map<select data-setting="colormap" aria-label="Pixel mapping color map">${[['native','Survey colors'],['grayscale','Grayscale'],['red','Red'],['yellow','Yellow'],['green','Green'],['blue','Blue'],['viridis','Viridis'],['magma','Magma'],['cividis','Cividis'],['inferno','Inferno'],['plasma','Plasma'],['rainbow','Rainbow']].map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label></div>
      <div class="pm-gamma"><span>Midtone gamma <output data-pm="gamma">1.00</output></span><label><input type="checkbox" data-setting="reversed"> Invert colors</label></div>
      <div class="pm-presets"><span>Presets</span><button type="button" data-look="faint">Lift faint detail</button><button type="button" data-look="crisp">Crisp contrast</button></div></section>
      <section class="pm-section pm-colors"><h3>Color intensity</h3><p class="pm-help">Adjust each color channel. Yellow adjusts red and green together. Zero keeps the original intensity.</p>${['red','yellow','green','blue'].map(name=>`<label><span class="pm-color-dot pm-color-${name}"></span>${name[0].toUpperCase()+name.slice(1)}<output data-output="${name}">0%</output><input type="range" min="-1" max="1" step="0.01" value="0" data-setting="${name}" aria-label="${name[0].toUpperCase()+name.slice(1)} color intensity"></label>`).join('')}</section>
      <details class="pm-advanced"><summary>Fine adjustment</summary>${['brightness','contrast','saturation'].map(name=>`<label>${name[0].toUpperCase()+name.slice(1)}<output data-output="${name}">0</output><input type="range" min="-1" max="1" step="0.01" value="0" data-setting="${name}" aria-label="Pixel mapping ${name}"></label>`).join('')}</details>
      <div class="pm-actions"><div class="pm-action-row"><button type="button" class="button" data-action="original" aria-pressed="false">Show original</button><button type="button" class="button" data-action="reset">Reset display</button></div><div class="pm-action-row"><button type="button" class="button pm-save" data-action="save">Save PNG</button><button type="button" class="button pm-settings" data-action="settings" title="Download display settings and source information as JSON">Settings JSON</button></div><button type="button" class="button pm-lab" data-action="lab">Open in Image Lab</button><p class="pm-caption pm-save-status" data-pm="save-status" role="status">Saves this view with its display settings and source credit.</p></div>
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
    this.el('[data-action="save"]').onclick=()=>this.savePNG();
    this.el('[data-action="lab"]').onclick=()=>this.openInImageLab();
    this.el('[data-action="settings"]').onclick=()=>this.saveSettings();
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
    if(!this.layer||this.layer!==this.sky.getBaseImageLayer())return false;
    const s=this.original?PixelMappingMath.defaults():this.settings;
    try {
      // Raster HiPS use byte-valued cuts. FITS HiPS retain their native intensity range.
      const range=this.nativeRange();
      if(!range){this.el('[data-pm="status"]').textContent='Waiting for the survey intensity range. Try again once its pixels load.';return false;}
      this.layer.setCuts(range[0]+s.black*(range[1]-range[0]),range[0]+s.white*(range[1]-range[0]));
      // Yellow is a local two-stop LUT registered through Aladin's public custom-colormap API.
      if(s.colormap==='yellow'&&!this.yellowRegistered){this.sky.addColormap('universe-yellow',['#000000','#ffff00']);this.yellowRegistered=true;}
      this.layer.setColormap(s.colormap==='yellow'?'universe-yellow':s.colormap,{stretch:s.stretch,reversed:s.reversed});
      this.layer.setGamma(PixelMappingMath.gamma(s));
      // This Aladin release can feed negative graded RGB into pow(), producing a black frame.
      // Use the browser's clamped GPU color filters only on imagery; catalogue markers stay intact.
      this.layer.setBrightness(0); this.layer.setContrast(0); this.layer.setSaturation(0);
      const canvas=this.sky.aladinDiv.querySelector('.aladin-imageCanvas');
      if(canvas)canvas.style.filter=this.displayFilter(s);
      this.el('[data-pm="status"]').textContent=this.original?'Showing original · your adjustments are kept':(this.persistent?'Saved for this survey in this browser':'Session settings · browser storage unavailable');
      return true;
    } catch { this.el('[data-pm="status"]').textContent='Survey is still loading. Try the control again when imagery appears.';return false; }
  }
  static basicFilter(s) {
    return s.brightness||s.contrast||s.saturation?`brightness(${1+s.brightness}) contrast(${1+s.contrast}) saturate(${1+s.saturation})`:'none';
  }
  nativeRange() {
    const layer=this.layer;if(!layer)return null;
    const format=String(layer.imgFormat||layer.colorCfg?.imgFormat||'').toLowerCase();
    if(!format.startsWith('fits'))return [0,255];
    if(this.nativeRanges.has(layer))return this.nativeRanges.get(layer);
    const cuts=typeof layer.getCuts==='function'?layer.getCuts():null;
    const range=cuts?.length===2&&cuts.every(Number.isFinite)&&cuts[1]>cuts[0]?cuts:[layer.defaultFitsMinCut,layer.defaultFitsMaxCut];
    if(!range.every(Number.isFinite)||range[1]<=range[0])return null;
    this.nativeRanges.set(layer,[...range]);return this.nativeRanges.get(layer);
  }
  surveyDescriptor() {
    const supplied=typeof this.surveyInfo==='function'?this.surveyInfo(this.key,this.layer):null;
    const defaults={
      '2mass':{name:'2MASS near-infrared color survey',label:'Webb · 2MASS',url:'https://alasky.cds.unistra.fr/2MASS/Color',credit:'2MASS / University of Massachusetts / IPAC-Caltech; HiPS by CDS'},
      optical:{name:'Digitized Sky Survey 2 color',label:'Hubble · DSS2',url:'https://alasky.cds.unistra.fr/DSS/DSSColor',credit:'DSS2 / STScI / ESO; color HiPS by CDS'},
    };
    if(supplied)return {id:this.key,...supplied,label:supplied.label||supplied.name,credit:supplied.credit||`${supplied.name||this.key}; see the linked survey source for credits`};
    return {id:this.key,...(defaults[this.key]||{name:this.layer?.name||this.key||'Sky survey',label:this.layer?.name||this.key,url:this.layer?.url||'',credit:'See the linked survey source for credits'})};
  }
  imageLayers() {
    if(typeof this.sky.getStackLayers!=='function')return [];
    return this.sky.getStackLayers().map(key=>{
      const layer=this.sky.getOverlayImageLayer?.(key);if(!layer)return null;
      return {key,name:layer.name||layer.id||key,url:layer.url||'',base:layer===this.layer,
        format:layer.imgFormat||layer.colorCfg?.imgFormat||'raster',opacity:typeof layer.getOpacity==='function'?layer.getOpacity():1};
    }).filter(Boolean);
  }
  displayFilter(s) {
    const basic=PixelMappingController.basicFilter(s);
    if(!s.red&&!s.yellow&&!s.green&&!s.blue)return basic;
    if(!this.colorFilter) {
      this.colorFilter=document.createElementNS('http://www.w3.org/2000/svg','svg');
      this.colorFilter.setAttribute('class','pm-filter-defs'); this.colorFilter.setAttribute('aria-hidden','true');
      this.colorFilter.setAttribute('width','0'); this.colorFilter.setAttribute('height','0');
      // Keep SVG outside the hideable panel: display:none would disable its filter.
      this.sky.aladinDiv.append(this.colorFilter);
    }
    // Direct sRGB gains stay responsive on dim survey pixels. Use the same gains
    // as PNG export; leave alpha and the separate catalog canvas untouched.
    const gains=PixelMappingMath.channelGains(s);
    const primitives=`<feComponentTransfer in="SourceGraphic">${['R','G','B'].map((c,i)=>`<feFunc${c} type="linear" slope="${gains[i]}" intercept="0"/>`).join('')}<feFuncA type="identity"/></feComponentTransfer>`;
    this.colorFilter.innerHTML=`<defs><filter id="${this.filterId}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${primitives}</filter></defs>`;
    return (basic==='none'?'':basic+' ')+`url("#${this.filterId}")`;
  }
  exportMetadata() {
    const info=this.surveyDescriptor();
    const center=this.sky.getRaDec(),fov=this.sky.getFov();
    return {schema:'universe-explorer-pixel-mapping-v1',created_at:new Date().toISOString(),
      survey:{id:this.key,...info},view:{ra_deg:center[0],dec_deg:center[1],fov_deg:fov[0],coordinate_frame:'ICRS'},
      original_preview:this.original,display:PixelMappingMath.normalize(this.original?PixelMappingMath.defaults():this.settings),
      saved_adjustments:PixelMappingMath.normalize(this.settings),renderer:'CDS Aladin Lite 3.8.2',
      color_intensity_model:'rgb-channel-gains-v1',
      native_intensity_range:this.nativeRange(),tile_format:this.layer?.imgFormat||this.layer?.colorCfg?.imgFormat||'raster',
      image_layers:this.imageLayers(),
      processing:'Survey display visualization. Native cuts, stretch, colormap and gamma; browser brightness, contrast and saturation; red, green and blue channel gains with yellow multiplying red and green. Not calibrated photometry.',
      image_kind:this.captureKind==='telescope-live-capture'?'Ground-based survey context; not a Hubble or Webb exposure.':'Rendered sky survey visualization; not calibrated photometry.'};
  }
  download(blob,filename) {
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=filename;document.body.append(link);
    try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  }
  saveSettings() {
    if(!this.key||!this.layer)return;
    const metadata=this.exportMetadata();
    this.download(new Blob([JSON.stringify(metadata,null,2)+'\n'],{type:'application/json'}),`universe-${this.key}-display.json`);
    this.el('[data-pm="save-status"]').textContent='Settings JSON saved with survey source and coordinates.';
  }
  async savePNG() { return this.exportView(false); }
  async openInImageLab() { return this.exportView(true); }
  async exportView(toLab) {
    if(this.exporting)return;
    const status=this.el('[data-pm="save-status"]'),buttons=['save','lab'].map(action=>this.el(`[data-action="${action}"]`));
    if(!this.layer||this.layer!==this.sky.getBaseImageLayer()){status.textContent='Wait for the survey to load, then save the view.';return;}
    this.exporting=true;buttons.forEach(button=>button.disabled=true);
    status.textContent=toLab?'Preparing this view for Image Lab…':'Preparing PNG with source credit…';
    try {
      const {blob,metadata}=await this.capturePNG({creditFooter:!toLab});
      if(toLab){
        const form=new FormData();
        form.append('file',blob,`${this.captureLabel} - ${metadata.survey.name}.png`);
        form.append('context',JSON.stringify({kind:this.captureKind,ra:metadata.view.ra_deg,dec:metadata.view.dec_deg,fov:metadata.view.fov_deg,
          survey:metadata.survey.id,survey_url:metadata.survey.url,captured_at:metadata.created_at,calibrated:false,pixel_mapping:metadata}));
        status.textContent='Saving this view to your local Image Lab…';
        const image=await api('/api/images/upload',{method:'POST',body:form});
        openImage(image);
        status.textContent='Opened in Image Lab with colors, coordinates and source credit preserved.';
      }else{
        this.download(blob,`universe-${metadata.survey.id}-${metadata.created_at.replace(/[:.]/g,'-')}.png`);
        status.textContent=`Saved ${metadata.export.width} × ${metadata.export.height} PNG · source and settings included.`;
      }
    } catch(error) {
      status.textContent=error?.name==='SecurityError'?'The browser blocked this image export. Reload the survey and try again.':(error?.message||'Unable to save this view. Let the survey load and try again.');
    } finally {this.exporting=false;buttons.forEach(button=>button.disabled=false);}
  }
  async capturePNG({creditFooter=true}={}) {
    const generation=this.generation,view=this.viewGeneration,edits=this.editGeneration;
    const assertCurrent=()=>{if(generation!==this.generation||view!==this.viewGeneration||edits!==this.editGeneration)throw Error('The view changed while saving. Save again when the map is still.');};
      if(!this.apply())throw Error('Wait for the survey display to finish loading, then save again.');
      // Allow native cuts/colormap changes to reach the renderer before its own capture.
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      assertCurrent();
      const metadata=this.exportMetadata(),s=metadata.display;
      // This is the same image snapshot API used by Aladin's built-in export.
      this.sky.view.wasm.update(0);
      const source=this.sky.view.wasm.canvas(),width=source.width,height=source.height;
      if(!width||!height||width*height>25000000)throw Error('Open the map at a smaller size before saving.');
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      ctx.filter=PixelMappingController.basicFilter(s);ctx.drawImage(source,0,0,width,height);ctx.filter='none';
      if(s.red||s.yellow||s.green||s.blue) {
        const pixels=ctx.getImageData(0,0,width,height),data=pixels.data;
        for(let p=0;p<data.length;p+=4) {
          const rgb=PixelMappingMath.colorIntensity(data[p]/255,data[p+1]/255,data[p+2]/255,s);
          data[p]=Math.round(rgb[0]*255);data[p+1]=Math.round(rgb[1]*255);data[p+2]=Math.round(rgb[2]*255);
        }
        ctx.putImageData(pixels,0,0);
      }
      const overlay=this.sky.aladinDiv.querySelector('.aladin-catalogCanvas');
      if(overlay)ctx.drawImage(overlay,0,0,width,height);
      metadata.image={width,height};
      const output=creditFooter?PixelMappingController.addCreditFooter(canvas,metadata):canvas;
      metadata.export={width:output.width,height:output.height,format:'image/png',credit_footer:creditFooter};
      let blob=await new Promise(resolve=>output.toBlob(resolve,'image/png'));
      assertCurrent();
      if(!blob||blob.type!=='image/png')throw Error('The browser could not create the PNG.');
      blob=await PixelMappingController.withPngMetadata(blob,metadata);
      assertCurrent();
      return {blob,metadata};
  }
  static addCreditFooter(image,metadata) {
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
    const scale=Math.max(1,Math.min(2,image.width/1000)),font=Math.round(12*scale),pad=Math.round(14*scale),lineHeight=Math.round(18*scale);
    ctx.font=`${font}px sans-serif`;
    const source=[`${metadata.survey.name} · ${metadata.renderer} · ${metadata.original_preview?'Original preview':'Display visualization'}`,
      `${metadata.survey.credit} | ${metadata.survey.url}`,
      `RA ${metadata.view.ra_deg.toFixed(5)}° · Dec ${metadata.view.dec_deg.toFixed(5)}° · Field ${metadata.view.fov_deg.toFixed(4)}° · ${metadata.created_at}`,
      `${metadata.image_kind||'Sky survey visualization.'} Source and full display settings are embedded in this PNG.`];
    const lines=[];
    for(const text of source) {
      let line='';
      for(let word of text.split(' ')) {
        // Long source URLs also wrap on narrow exports, preserving the full credit.
        if(ctx.measureText(word).width>image.width-pad*2) {
          if(line){lines.push(line);line='';}
          let part='';
          for(const character of word) {
            if(part&&ctx.measureText(part+character).width>image.width-pad*2){lines.push(part);part=character;}else part+=character;
          }
          line=part;continue;
        }
        const next=line?line+' '+word:word;
        if(line&&ctx.measureText(next).width>image.width-pad*2){lines.push(line);line=word;}else line=next;
      }
      if(line)lines.push(line);
    }
    canvas.width=image.width;canvas.height=image.height+pad*2+lineHeight*lines.length;
    ctx.fillStyle='#09131e';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);
    ctx.font=`${font}px sans-serif`;ctx.fillStyle='#d5e0e6';ctx.textBaseline='top';
    lines.forEach((line,i)=>ctx.fillText(line,pad,image.height+pad+i*lineHeight));
    return canvas;
  }
  static async withPngMetadata(blob,metadata) {
    const bytes=new Uint8Array(await blob.arrayBuffer());
    const signature=[137,80,78,71,13,10,26,10];
    if(!signature.every((value,i)=>bytes[i]===value)||bytes.length<33)throw Error('The browser returned an invalid PNG.');
    // PNG iTXt: keyword, compression flag/method, empty language and translated keyword.
    const data=new TextEncoder().encode('Universe Explorer\0\0\0\0\0'+JSON.stringify(metadata));
    const chunk=new Uint8Array(data.length+12),view=new DataView(chunk.buffer);
    view.setUint32(0,data.length);chunk.set([105,84,88,116],4);chunk.set(data,8);
    let crc=0xffffffff;
    for(let i=4;i<chunk.length-4;i++){crc^=chunk[i];for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    view.setUint32(chunk.length-4,(crc^0xffffffff)>>>0);
    return new Blob([bytes.subarray(0,33),chunk,bytes.subarray(33)],{type:'image/png'});
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
      const box=this.sky.aladinDiv?.getBoundingClientRect?.();
      if(!box?.width||!box?.height){this.el('[data-pm="sample-status"]').textContent='Open the map to sample its current view.';return;}
      const nativeRange=this.nativeRange();
      if(!nativeRange){this.el('[data-pm="sample-status"]').textContent='The survey intensity range is still loading.';return;}
      const samples=[];
      for(let row=0;row<20;row++) {
        if(!valid())return;
        for(let col=0;col<32;col++) {
          // Pixels outside an all-sky projection throw; missing tiles return null.
          try { const pixel=await layer.readPixel((col+.5)*box.width/32,(row+.5)*box.height/20);
            const brightness=typeof pixel==='number'&&Number.isFinite(pixel)?(pixel-nativeRange[0])/(nativeRange[1]-nativeRange[0]):PixelMappingController.pixelBrightness(pixel);
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
    this.el('[data-pm="survey"]').textContent=this.key?this.surveyDescriptor().label:'Waiting for survey';
    this.el('[data-pm="mode"]').textContent=this.original?'Original preview':JSON.stringify(s)===JSON.stringify(PixelMappingMath.defaults())?'Original':'Adjusted';
    for(const name of ['black','mid','white']) {
      const handle=this.el(`[data-handle="${name}"]`); handle.style.left=(s[name]*100)+'%'; handle.setAttribute('aria-valuenow',(s[name]*255).toFixed(1));
      const input=this.el(`[data-level="${name}"]`); if(document.activeElement!==input)input.value=(s[name]*255).toFixed(1);
    }
    for(const key of ['stretch','colormap','reversed','brightness','contrast','saturation','red','yellow','green','blue']) {
      const input=this.el(`[data-setting="${key}"]`); if(input.type==='checkbox')input.checked=s[key]; else input.value=s[key];
      const output=this.el(`[data-output="${key}"]`); if(output)output.textContent=(s[key]>0?'+':'')+(['red','yellow','green','blue'].includes(key)?Math.round(s[key]*100)+'%':s[key].toFixed(2));
    }
    this.el('[data-pm="gamma"]').textContent=PixelMappingMath.gamma(s).toFixed(2);
    const original=this.el('[data-action="original"]'); original.setAttribute('aria-pressed',String(this.original)); original.textContent=this.original?'Show adjustments':'Show original';
    // Scalar tone curve: native levels/stretch/gamma, followed by browser brightness and contrast.
    const gamma=PixelMappingMath.gamma(s);
    this.el('[data-pm="curve"]').setAttribute('d',Array.from({length:129},(_,i)=>{const x=i/128;let y=Math.max(0,Math.min(1,(x-s.black)/(s.white-s.black)));if(s.stretch==='sqrt')y=Math.sqrt(y);else if(s.stretch==='pow2')y*=y;else if(s.stretch==='asinh')y=Math.asinh(10*y)/3;else if(s.stretch==='log')y=Math.log(1000*y+1)/Math.log(1000);if(s.reversed)y=1-y;y=Math.pow(Math.max(0,Math.min(1,y)),gamma);y=Math.max(0,Math.min(1,.5+(1+s.contrast)*(y*(1+s.brightness)-.5)));return `${i?'L':'M'}${x*256} ${(1-y)*112}`;}).join(''));
    if(this.key)this.onChange({...s},{key:this.key,original:this.original});
  }
}
PixelMappingController.serial=0;
