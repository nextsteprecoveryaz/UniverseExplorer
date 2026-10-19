'use strict';

class ExploreEnhancement{
  constructor({sky,host,toolbar,active=()=>true,original=()=>false}){
    Object.assign(this,{sky,host,toolbar,active,original});this.mode='off';this.generation=0;this.frame=null;this.lastMove=performance.now();this.lastDraw=0;this.nextSample=0;this.working=false;this.preview=false;this.current=null;this.engine=null;this.aiError='';
    this.canvas=document.createElement('canvas');this.canvas.className='live-enhancement-canvas';this.canvas.hidden=true;this.canvas.setAttribute('aria-hidden','true');
    this.button=document.createElement('button');this.button.id='live-enhancement-toggle';this.button.textContent='Enhance: Off';this.button.setAttribute('aria-expanded','false');this.button.setAttribute('aria-controls','live-enhancement-panel');toolbar.append(this.button);
    this.panel=document.createElement('section');this.panel.id='live-enhancement-panel';this.panel.hidden=true;this.panel.setAttribute('aria-label','Live sky enhancement');
    this.panel.innerHTML='<div class="le-heading"><strong>Live enhancement</strong><button type="button" data-le="close" aria-label="Close live enhancement">×</button></div><label for="live-enhancement-mode">Processing mode</label><select id="live-enhancement-mode"><option value="off">Off · original imagery</option><option value="fast">Fast · GPU sharpening</option><option value="ai">AI 2× · refine settled views</option><option value="auto">Auto · fast flight + AI refinement</option></select><p data-le="status" role="status">Original imagery. No enhancement processing.</p><p data-le="gpu" class="small muted"></p><button type="button" data-le="original" aria-pressed="false">Show original</button><p class="small muted">Processed on this PC. AI can alter apparent stars and structures; use originals for discovery. This is app-level enhancement, not NVIDIA RTX Video or DLSS.</p><p data-le="cache" class="small muted"></p>';
    host.append(this.panel);this.select=this.panel.querySelector('select');
    this.button.onclick=()=>this.open(this.panel.hidden);this.panel.querySelector('[data-le="close"]').onclick=()=>{this.open(false);this.button.focus();};
    this.select.onchange=()=>this.setMode(this.select.value);
    this.panel.querySelector('[data-le="original"]').onclick=()=>{this.preview=!this.preview;this.invalidate();this.syncOriginal();};
    this.panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.stopPropagation();this.open(false);this.button.focus();}});
    this.resize=new ResizeObserver(()=>this.invalidate());this.resize.observe(this.sky.aladinDiv);
    document.addEventListener('visibilitychange',()=>this.invalidate());
    this.sky.aladinDiv.addEventListener('pointerdown',()=>this.invalidate());
    this.sky.aladinDiv.addEventListener('wheel',()=>this.invalidate(),{passive:true});
    try{this.setMode(LiveEnhancementMath.mode(localStorage.getItem('universe:live-enhancement:v1')));}catch{}
  }
  text(selector,text){const node=this.panel.querySelector(selector);if(node.textContent!==text)node.textContent=text;}
  status(text){this.text('[data-le="status"]',text);}
  open(value){this.panel.hidden=!value;this.button.setAttribute('aria-expanded',String(value));if(value)this.select.focus();}
  syncOriginal(){const button=this.panel.querySelector('[data-le="original"]');button.textContent=this.preview?'Return to enhancement':'Show original';button.setAttribute('aria-pressed',String(this.preview));}
  invalidate(){this.generation++;this.current=null;this.canvas.hidden=true;this.lastMove=performance.now();this.nextSample=0;}
  key(){const source=this.sky.aladinDiv.querySelector('.aladin-imageCanvas');return JSON.stringify([this.sky.getRaDec(),this.sky.getFov(),this.sky.getRotation(),this.sky.getProjectionName(),this.sky.getBaseImageLayer()?.url,source?.width,source?.height]);}
  async setMode(mode){
    this.mode=LiveEnhancementMath.mode(mode);this.select.value=this.mode;this.preview=false;this.syncOriginal();this.invalidate();this.aiError='';
    try{localStorage.setItem('universe:live-enhancement:v1',this.mode);}catch{}
    cancelAnimationFrame(this.frame);this.frame=null;
    if(this.mode==='off'){
      this.engine?.destroy();this.engine=null;this.button.textContent='Enhance: Off';this.status('Original imagery. No enhancement processing.');this.text('[data-le="gpu"]','');this.text('[data-le="cache"]','GPU cache released.');return;
    }
    this.button.textContent='Enhance: Starting…';this.status('Starting local GPU processing…');
    try{
      if(!this.engine){
        if(!this.starting)this.starting=LiveEnhancementGPU.create(this.canvas).finally(()=>{this.starting=null;});
        const engine=await this.starting;
        if(this.mode==='off'){engine.destroy();return;}
        this.engine=engine;
        engine.device.lost.then(info=>{if(this.engine===engine&&!engine.destroyed)this.fail('GPU connection lost. Switch enhancement off and on to retry.');});
        engine.device.addEventListener('uncapturederror',event=>{if(this.engine===engine)this.fail(event.error.message);});
        const info=engine.info||{};this.text('[data-le="gpu"]',`WebGPU · ${info.description||[info.vendor,info.architecture].filter(Boolean).join(' ')||'hardware adapter'} · local processing`);
      }
      const source=this.sky.aladinDiv.querySelector('.aladin-imageCanvas');
      if(!source)throw Error('The map canvas is not ready. Switch enhancement off and on after it loads.');
      if(!this.canvas.isConnected)source.after(this.canvas);
      this.viewKey=this.key();this.lastDraw=0;this.queue();
    }catch(error){this.fail(error.message);}
  }
  fail(message){this.invalidate();cancelAnimationFrame(this.frame);this.frame=null;this.engine?.destroy();this.engine=null;this.button.textContent='Enhance: Unavailable';this.status(message+' Original imagery remains visible.');}
  queue(){if(this.frame===null&&this.engine&&this.mode!=='off')this.frame=requestAnimationFrame(time=>{this.frame=null;this.tick(time);});}
  tick(time){
    if(!this.engine||this.mode==='off')return;
    try{
      const hidden=document.hidden||!this.active()||this.preview||this.original();
      if(hidden){if(!this.suspended)this.invalidate();this.suspended=true;this.canvas.hidden=true;this.button.textContent=this.preview||this.original()?'Enhance: Original':'Enhance: Paused';this.queue();return;}
      if(this.suspended){this.suspended=false;this.invalidate();}
      const key=this.key(),viewChanged=key!==this.viewKey;if(viewChanged){this.viewKey=key;this.invalidate();}
      // Aladin 3.8 exposes isRendering on WASM; older versions expose isStillActive.
      const loading=Boolean(this.sky.isStillActive?.()||this.sky.view.wasm.isRendering?.());
      if(loading){if(this.current)this.invalidate();this.lastMove=time;}
      if(time-this.lastDraw<16&&!viewChanged){this.queue();return;}
      this.lastDraw=time;
      // Use the same original imagery canvas as Aladin's own snapshot/export.
      this.sky.view.wasm.update(0);const source=this.sky.view.wasm.canvas();
      if(!source.width||!source.height){this.queue();return;}
      if(this.canvas.width!==source.width||this.canvas.height!==source.height){this.canvas.width=source.width;this.canvas.height=source.height;this.invalidate();}
      const imageCanvas=this.sky.aladinDiv.querySelector('.aladin-imageCanvas');this.canvas.style.filter=imageCanvas.style.filter||'none';
      const texture=this.current?.texture||this.engine.copy(source);this.engine.draw(texture,this.current?0:.65);this.canvas.hidden=false;
      const mode=this.mode==='auto'?'Auto':this.mode==='ai'?'AI 2×':'Fast';
      const label=`Enhance: ${mode}${this.mode==='fast'?'':' · '+(this.current?'AI 2×':'Fast')}`;
      if(this.button.textContent!==label)this.button.textContent=label;
      if(!this.working){
        if(this.current)this.status(`AI 2× visualization · ${this.current.width} × ${this.current.height}${this.current.ms?' · '+Math.round(this.current.ms)+' ms':''}`);
        else if(this.aiError)this.status('Fast GPU view · AI unavailable: '+this.aiError);
        else this.status(this.mode==='fast'?'GPU sharpening active. No neural reconstruction.':loading||time-this.lastMove<450?'Fast GPU view while moving or loading; AI refines after settling.':'Preparing local AI refinement…');
      }
      this.text('[data-le="cache"]',`${this.engine.cache.items.size} refined views · ${(this.engine.cache.bytes/1048576).toFixed(1)} / 256 MiB GPU cache`);
      if(!this.working&&!this.aiError&&time>=this.nextSample&&LiveEnhancementMath.eligible({mode:this.mode,moving:time-this.lastMove<200,loading,hidden,elapsed:time-this.lastMove}))this.refine(source);
    }catch(error){this.fail(error.message);return;}
    this.queue();
  }
  async refine(source){
    this.working=true;const serial=this.generation,engine=this.engine,key=this.viewKey;
    const current=()=>this.generation===serial&&this.engine===engine&&this.mode!=='off'&&!this.preview&&!this.original()&&!document.hidden&&this.active()&&this.key()===key;
    try{
      // Hash the complete rendered frame, so new tiles cannot reuse stale AI pixels.
      const snapshot=document.createElement('canvas');snapshot.width=source.width;snapshot.height=source.height;
      const ctx=snapshot.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0);
      const digest=await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,snapshot.width,snapshot.height).data);
      if(!current())return;
      const cacheKey=key+':'+Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
      const saved=engine.cache.get(cacheKey);
      if(saved){this.current=saved;this.nextSample=performance.now()+2000;return;}
      this.current=null;let last=0;const start=performance.now();
      const result=await engine.upscale(snapshot,current,progress=>{if(current()&&performance.now()-last>150){last=performance.now();this.status(`Refining on GPU · ${Math.round(progress*100)}% · original field remains registered`);}});
      if(!result)return;
      if(!current()){result.texture.destroy();return;}
      result.ms=performance.now()-start;
      if(!engine.cache.put(cacheKey,result)){result.texture.destroy();throw Error('This view exceeds the 256 MiB refinement cache. Reduce the window size.');}
      this.current=result;this.nextSample=performance.now()+2000;
    }catch(error){if(current()){this.aiError=error.message;this.current=null;}}
    finally{this.working=false;}
  }
  async snapshotForExport(){
    if(!this.engine||this.mode==='off'||this.preview||this.original()||this.canvas.hidden)return null;
    const serial=this.generation,engine=this.engine,ai=Boolean(this.current);
    const texture=this.current?.texture||engine.input;if(!texture)return null;
    const canvas=await engine.capture(texture,ai?0:.65);
    if(serial!==this.generation||engine!==this.engine)throw Error('The view changed during capture. Try saving again.');
    return {source:canvas,metadata:{mode:this.mode,processing:ai?'FSRCNN 2× neural luminance upscaling':'GPU edge-limited sharpening',ai,model_sha256:ai?engine.model.sha256:null,local:true,scientific_evidence:false}};
  }
}

function initLiveEnhancement(){
  if(globalThis.exploreEnhancement||!state.sky)return;
  globalThis.exploreEnhancement=new ExploreEnhancement({sky:state.sky,host:document.querySelector('#explore-map-stage')||document.querySelector('#explore-page'),toolbar:document.querySelector('#map-view-toolbar'),active:()=>state.page==='explore',original:()=>Boolean(explorePixelMapping.controller?.original)});
}
if(typeof module!=='undefined')module.exports={ExploreEnhancement};
