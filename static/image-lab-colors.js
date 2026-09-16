'use strict';

// Display-only color grading. Originals, FITS measurements and AI source files stay untouched.
class ImageLabColorController {
  constructor({host,original,enhanced,getImage=()=>state.image,getVariant=()=>$('#ai-output-select').value,
    loadImage=ImageLabColorController.loadImage,upload=form=>api('/api/images/upload',{method:'POST',body:form}),
    open=image=>openImage(image),notify=message=>toast(message)}={}) {
    this.host=host;this.originalImage=original;this.enhancedImage=enhanced;this.getImage=getImage;this.getVariant=getVariant;
    this.loadImage=loadImage;this.upload=upload;this.open=open;this.notify=notify;
    this.image=null;this.target='original';this.profiles={};this.generation=0;this.signature='';this.unadjusted=false;this.running=false;
    this.filterId='image-lab-color-'+(++ImageLabColorController.serial);
    this.build();
  }
  el(selector){return this.host.querySelector(selector);}
  static colors(value){const normalized=PixelMappingMath.normalize(value);return Object.fromEntries(['red','yellow','green','blue'].map(key=>[key,normalized[key]]));}
  static loadImage(url){
    return new Promise((resolve,reject)=>{
      const image=new Image();
      const finish=(error)=>{clearTimeout(timer);image.onload=image.onerror=null;error?reject(error):resolve(image);};
      const timer=setTimeout(()=>finish(Error('The image took too long to load. Try again.')),20000);
      image.onload=()=>finish();image.onerror=()=>finish(Error('This image format could not be opened by the browser.'));
      image.src=url;
    });
  }
  build(){
    this.host.className='image-lab-colors';
    this.host.innerHTML=`<div class="lab-colors-heading"><div><span class="overline">DISPLAY CONTROLS</span><h2>Color intensity</h2></div><label>Adjust<select data-lab-color="target" aria-label="Image Lab color target"><option value="original">Original preview</option></select></label></div>
      <p class="small muted">Adjust red, yellow, green and blue. Yellow changes red and green together. Zero keeps the captured colors.</p>
      <div class="lab-color-sliders">${['red','yellow','green','blue'].map(name=>`<label><span class="lab-color-dot lab-color-${name}"></span><span>${name[0].toUpperCase()+name.slice(1)}</span><output data-lab-output="${name}">0%</output><input type="range" min="-1" max="1" step="0.01" value="0" data-lab-channel="${name}" aria-label="Image Lab ${name} color intensity"></label>`).join('')}</div>
      <div class="lab-color-actions"><button type="button" class="button" data-lab-action="unadjusted" aria-pressed="false">Show unadjusted</button><button type="button" class="button" data-lab-action="reset">Reset colors</button><button type="button" class="button" data-lab-action="download">Download adjusted PNG</button><button type="button" class="button primary" data-lab-action="copy">Save adjusted copy</button></div>
      <p class="lab-color-help small muted">Save an adjusted copy to use these colors for enhancement. Original files and measurements stay unchanged.</p><p class="lab-color-status small muted" data-lab-color="status" role="status"></p>`;
    this.host.querySelectorAll('[data-lab-channel]').forEach(input=>input.oninput=()=>this.change({...this.settings(),[input.dataset.labChannel]:Number(input.value)}));
    this.el('[data-lab-color="target"]').onchange=event=>this.select(event.target.value);
    this.el('[data-lab-action="unadjusted"]').onclick=()=>{this.unadjusted=!this.unadjusted;this.generation++;this.render();};
    this.el('[data-lab-action="reset"]').onclick=()=>this.change({});
    this.el('[data-lab-action="download"]').onclick=()=>this.export('download');
    this.el('[data-lab-action="copy"]').onclick=()=>this.export('copy');
    this.filter=document.createElementNS('http://www.w3.org/2000/svg','svg');
    this.filter.setAttribute('class','lab-color-filter-defs');this.filter.setAttribute('width','0');this.filter.setAttribute('height','0');this.filter.setAttribute('aria-hidden','true');
    // Hidden parent panels disable SVG filters in some browsers, so keep definitions at body level.
    document.body.append(this.filter);
  }
  bind(image){
    this.image=image;this.profiles={};this.target='original';this.unadjusted=false;this.signature='';this.generation++;
    this.originalImage.style.filter='none';this.enhancedImage.style.filter='none';
    this.refresh();
    this.status(image.extra?.kind==='telescope-live-capture'?'Your Telescope Live colors are already in this capture. Start at zero to keep that appearance.':'Colors are saved for this image in this browser.');
  }
  variant(){return this.getVariant()||'none';}
  hasEnhanced(){return !this.enhancedImage.hidden&&Boolean(this.enhancedImage.getAttribute('src'));}
  key(target=this.target){return target==='enhanced'?'enhanced:'+this.variant():'original';}
  settings(target=this.target){
    const key=this.key(target);
    if(!this.profiles[key]){
      let saved=null;try{saved=JSON.parse(localStorage.getItem(`universe:image-lab-colors:v1:${this.image?.id}:${key}`)||'null');}catch{}
      this.profiles[key]=ImageLabColorController.colors(saved);
    }
    return this.profiles[key];
  }
  refresh(){
    if(!this.image||this.getImage()?.id!==this.image.id)return;
    this.image=this.getImage();
    const signature=JSON.stringify([this.image.id,this.originalImage.getAttribute('src'),this.enhancedImage.getAttribute('src'),this.hasEnhanced(),this.variant()]);
    if(signature!==this.signature){this.signature=signature;this.generation++;}
    if(this.target==='enhanced'&&!this.hasEnhanced()){this.target='original';this.unadjusted=false;}
    this.render();
  }
  select(target){
    if(!['original','enhanced'].includes(target)||(target==='enhanced'&&!this.hasEnhanced()))return;
    this.target=target;this.unadjusted=false;this.generation++;this.render();
    this.status(target==='enhanced'?'Adjusting the enhanced preview. Its visualization label stays in exported copies.':'Adjusting the original preview. The original download stays unchanged.');
  }
  change(value){
    if(!this.image)return;
    const key=this.key();this.profiles[key]=ImageLabColorController.colors(value);this.unadjusted=false;this.generation++;
    try{localStorage.setItem(`universe:image-lab-colors:v1:${this.image.id}:${key}`,JSON.stringify(this.profiles[key]));}catch{}
    this.render();this.status('Display colors updated. Save an adjusted copy to use them for enhancement.');
  }
  status(message){this.el('[data-lab-color="status"]').textContent=message;}
  render(){
    if(!this.image)return;
    const select=this.el('[data-lab-color="target"]');
    const options='<option value="original">Original preview</option>'+(this.hasEnhanced()?'<option value="enhanced">Enhanced preview</option>':'');
    if(select.innerHTML!==options)select.innerHTML=options;select.value=this.target;
    const settings=this.settings();
    for(const name of ['red','yellow','green','blue']){
      this.el(`[data-lab-channel="${name}"]`).value=settings[name];
      this.el(`[data-lab-output="${name}"]`).textContent=(settings[name]>0?'+':'')+Math.round(settings[name]*100)+'%';
    }
    const toggle=this.el('[data-lab-action="unadjusted"]');toggle.setAttribute('aria-pressed',String(this.unadjusted));toggle.textContent=this.unadjusted?'Show adjusted':'Show unadjusted';
    const defs=[];
    for(const [target,image] of [['original',this.originalImage],['enhanced',this.enhancedImage]]){
      const s=this.unadjusted&&target===this.target?ImageLabColorController.colors({}):this.settings(target);
      if(!Object.values(s).some(Boolean)){image.style.filter='none';continue;}
      const id=this.filterId+'-'+target,gains=PixelMappingMath.channelGains(s);
      defs.push(`<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feComponentTransfer in="SourceGraphic">${['R','G','B'].map((name,i)=>`<feFunc${name} type="linear" slope="${gains[i]}" intercept="0"/>`).join('')}<feFuncA type="identity"/></feComponentTransfer></filter>`);
      image.style.filter=`url("#${id}")`;
    }
    this.filter.innerHTML='<defs>'+defs.join('')+'</defs>';
    for(const action of ['download','copy'])this.el(`[data-lab-action="${action}"]`).disabled=this.running;
  }
  snapshot(){
    this.refresh();
    if(!this.image)throw Error('Open an image first.');
    const node=this.target==='enhanced'?this.enhancedImage:this.originalImage;
    const preview=node.getAttribute('src');if(!preview)throw Error('Wait for the image to load.');
    return {generation:this.generation,image:structuredClone(this.image),target:this.target,variant:this.variant(),preview,
      source:this.target==='original'&&!this.image.scientific?this.image.original_url||preview:preview,
      colors:{...this.settings()},unadjusted:this.unadjusted,signature:this.signature};
  }
  current(snapshot){
    if(this.getImage()?.id!==snapshot.image.id||this.image?.id!==snapshot.image.id||this.generation!==snapshot.generation)return false;
    return this.originalImage.getAttribute('src')===JSON.parse(snapshot.signature)[1]&&this.enhancedImage.getAttribute('src')===JSON.parse(snapshot.signature)[2]&&this.variant()===snapshot.variant;
  }
  assertCurrent(snapshot){if(!this.current(snapshot))throw Error('The image or colors changed. Save again with your current selection.');}
  async capture(snapshot=this.snapshot()){
    this.assertCurrent(snapshot);
    let image,fallback=false;
    try{image=await this.loadImage(snapshot.source);}catch(error){
      this.assertCurrent(snapshot);
      if(snapshot.source===snapshot.preview)throw error;
      image=await this.loadImage(snapshot.preview);fallback=true;
    }
    this.assertCurrent(snapshot);
    const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
    if(!width||!height||width*height>25000000)throw Error('Choose an image no larger than 25 million pixels.');
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
    const colors=ImageLabColorController.colors(snapshot.unadjusted?{}:snapshot.colors);
    if(Object.values(colors).some(Boolean)){
      const pixels=context.getImageData(0,0,width,height),data=pixels.data;
      const gains=PixelMappingMath.channelGains(colors);
      for(let index=0;index<data.length;index+=4)for(let channel=0;channel<3;channel++)data[index+channel]=Math.round(Math.min(255,data[index+channel]*gains[channel]));
      context.putImageData(pixels,0,0);
    }
    const metadata={schema:'universe-explorer-image-lab-colors-v1',created_at:new Date().toISOString(),calibrated:false,
      parent_image:{id:snapshot.image.id,name:snapshot.image.name,sha256:snapshot.image.sha256,source:snapshot.image.source,scientific:snapshot.image.scientific,extra:snapshot.image.extra||{}},
      input:{target:snapshot.target,variant:snapshot.target==='enhanced'?snapshot.variant:null,url:fallback?snapshot.preview:snapshot.source,preview_fallback:fallback,width,height},
      display:colors,saved_adjustments:snapshot.colors,original_preview:snapshot.unadjusted,color_intensity_model:'rgb-channel-gains-v1',channel_gains:PixelMappingMath.channelGains(colors),
      ai_enhanced:snapshot.target==='enhanced'||snapshot.image.extra?.ai_enhanced===true,
      processing:'Image Lab color display visualization. Original files and scientific measurements are unchanged.'};
    let blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    this.assertCurrent(snapshot);
    if(!blob||blob.type!=='image/png')throw Error('The browser could not create this PNG.');
    blob=await PixelMappingController.withPngMetadata(blob,metadata);this.assertCurrent(snapshot);
    return {blob,metadata,fallback,width,height};
  }
  async export(action){
    if(this.running||!this.image)return;
    const snapshot=this.snapshot();this.running=true;this.render();this.status('Preparing your adjusted image…');
    try{
      const result=await this.capture(snapshot);this.assertCurrent(snapshot);
      const name=(snapshot.image.name||'Image').replace(/\.[^.]+$/,'')+'-adjusted.png';
      if(action==='copy'){
        const form=new FormData();form.append('file',result.blob,name);form.append('context',JSON.stringify(result.metadata));
        const saved=await this.upload(form);
        if(this.current(snapshot))this.open(saved);
        this.notify(result.fallback?'Adjusted copy saved from the display preview; this original format cannot be decoded by the browser.':'Adjusted copy saved locally. You can now enhance this copy.');
      }else{
        const url=URL.createObjectURL(result.blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);
        try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
        if(this.current(snapshot))this.status(`Saved ${result.width} × ${result.height} PNG with source and color settings.${result.fallback?' The original format could not be decoded; this export uses the display preview.':''}`);
      }
    }catch(error){if(this.getImage()?.id===snapshot.image.id)this.status(error?.name==='SecurityError'?'The browser blocked this export. Reload the image and try again.':error.message||'Unable to save this image.');}
    finally{this.running=false;this.render();}
  }
}
ImageLabColorController.serial=0;
let imageLabColors=null;
function initImageLabColors(){
  if(imageLabColors)return;
  const host=document.createElement('section');host.setAttribute('aria-label','Image Lab color intensity');
  $('#lab-content .image-compare').before(host);
  imageLabColors=new ImageLabColorController({host,original:$('#original-image'),enhanced:$('#ai-image')});
}
function bindImageLabColors(image){imageLabColors?.bind(image);}
function refreshImageLabColors(){imageLabColors?.refresh();}
