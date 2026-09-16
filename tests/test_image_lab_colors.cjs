'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const PixelMappingMath=require('../static/pixel-mapping-math.js');
const script=fs.readFileSync(path.join(__dirname,'..','static','image-lab-colors.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function harness({storage=new Map(),loadImage}={}){
  const nodes=new Map(),body=[],canvases=[],uploads=[],opened=[],notifications=[],metadata=[],downloads=[];
  const makeNode=()=>({style:{},hidden:false,disabled:false,value:'',innerHTML:'',textContent:'',attributes:new Map(),dataset:{},
    setAttribute(key,value){this.attributes.set(key,String(value));},getAttribute(key){return this.attributes.get(key)||null;},
    remove(){},click(){downloads.push(this);}});
  const node=selector=>{
    if(!nodes.has(selector)){const item=makeNode(),match=selector.match(/data-lab-channel="([^"]+)"/);if(match)item.dataset.labChannel=match[1];nodes.set(selector,item);}
    return nodes.get(selector);
  };
  const host={querySelector:node,querySelectorAll:selector=>selector==='[data-lab-channel]'?['red','yellow','green','blue'].map(name=>node(`[data-lab-channel="${name}"]`)):[]};
  const original=makeNode(),enhanced=makeNode(),overlay=makeNode();enhanced.hidden=true;
  let current={id:'one',name:'Source.png',sha256:'unchanged-sha256',source:'Local upload',scientific:false,original_url:'/one/original',preview_url:'/one/preview',extra:{credit:'Test source',kind:'telescope-live-capture',pixel_mapping:{schema:'universe-explorer-pixel-mapping-v1',display:{red:.5}}}},variant='none';
  original.setAttribute('src',current.preview_url);
  const context=vm.createContext({PixelMappingMath,console,Blob,structuredClone,Date,FormData:class{constructor(){this.items=new Map();}append(key,value){this.items.set(key,value);}get(key){return this.items.get(key);}},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    document:{body:{append:item=>body.push(item)},createElementNS:()=>makeNode(),createElement:kind=>{
      if(kind!=='canvas')return makeNode();
      const canvas={width:0,height:0,pixels:new Uint8ClampedArray([40,80,120,200]),drawn:null,
        getContext(){return {drawImage:image=>{canvas.drawn=image;},getImageData:()=>({data:canvas.pixels}),putImageData:image=>{canvas.pixels=image.data;}};},
        toBlob(callback){callback(new Blob(['PNG'],{type:'image/png'}));}};canvases.push(canvas);return canvas;
    }},
    PixelMappingController:{async withPngMetadata(blob,info){metadata.push(info);return blob;}},
    URL:{createObjectURL:()=>'/blob/download',revokeObjectURL(){}},setTimeout(){return 1;},clearTimeout(){},
  });
  vm.runInContext(script,context);const Controller=vm.runInContext('ImageLabColorController',context);
  const sources=[];
  const controller=new Controller({host,original,enhanced,getImage:()=>current,getVariant:()=>variant,
    loadImage:async url=>{sources.push(url);return loadImage?loadImage(url):{naturalWidth:1,naturalHeight:1,url};},
    upload:async form=>{uploads.push(form);return {id:'copy',name:'Source-adjusted.png'};},open:image=>opened.push(image),notify:message=>notifications.push(message)});
  controller.bind(current);
  return {controller,node,original,enhanced,overlay,storage,sources,canvases,uploads,opened,notifications,metadata,downloads,body,
    setImage(image){current=image;original.setAttribute('src',image.preview_url);controller.bind(image);},
    setEnhanced(key='variant-a',url='/one/ai-a'){variant=key;enhanced.hidden=false;enhanced.setAttribute('src',url);controller.refresh();},
    get current(){return current;},context};
}

test('fresh transferred captures start neutral and only image pixels receive color filters',()=>{
  const h=harness();assert.deepEqual(plain(h.controller.settings()),{red:0,yellow:0,green:0,blue:0});
  assert.match(h.node('[data-lab-color="status"]').textContent,/already in this capture/);
  h.controller.change({red:.5,yellow:.2,green:-.5,blue:1});
  assert.match(h.original.style.filter,/url/);assert.equal(h.enhanced.style.filter,'none');assert.equal(h.overlay.style.filter,undefined);
  assert.match(h.controller.filter.innerHTML,/slope="1.7999999999999998"/);assert.match(h.controller.filter.innerHTML,/feFuncB type="linear" slope="2"/);
  assert.equal(h.node('[data-lab-output="blue"]').textContent,'+100%');
});

test('settings stay independent for each image and enhanced variant and survive reopening',()=>{
  const h=harness();h.controller.change({red:.25,blue:.6});h.setEnhanced();h.controller.select('enhanced');
  assert.equal(h.controller.settings().red,0);h.controller.change({yellow:.4});
  h.setEnhanced('variant-b','/one/ai-b');assert.equal(h.controller.settings().yellow,0);h.controller.change({green:.8});
  h.setEnhanced('variant-a','/one/ai-a');assert.equal(h.controller.settings().yellow,.4);assert.equal(h.controller.settings().green,0);
  h.controller.select('original');assert.equal(h.controller.settings().red,.25);
  const original=h.current;h.setImage({...original,id:'two',preview_url:'/two/preview',original_url:'/two/original'});assert.equal(h.controller.settings().red,0);
  h.setImage(original);assert.equal(h.controller.settings().red,.25);assert.equal(h.controller.settings().blue,.6);
  const reopened=harness({storage:h.storage});assert.equal(reopened.controller.settings().blue,.6);
});

test('show unadjusted keeps saved colors and reset changes only the selected target',()=>{
  const h=harness();h.controller.change({red:1});h.setEnhanced();h.controller.select('enhanced');h.controller.change({blue:1});
  h.node('[data-lab-action="unadjusted"]').onclick();assert.equal(h.enhanced.style.filter,'none');assert.match(h.original.style.filter,/url/);
  assert.equal(h.controller.settings().blue,1);h.node('[data-lab-action="unadjusted"]').onclick();assert.match(h.enhanced.style.filter,/url/);
  h.node('[data-lab-action="reset"]').onclick();assert.equal(h.controller.settings().blue,0);h.controller.select('original');assert.equal(h.controller.settings().red,1);
});

test('full-resolution export uses the original file and shared channel gains while preserving alpha and provenance',async()=>{
  const h=harness();h.controller.change({red:.5,yellow:.5,green:-.5,blue:1});const result=await h.controller.capture();
  assert.deepEqual(h.sources,['/one/original']);assert.deepEqual([...h.canvases[0].pixels],[90,60,240,200]);
  assert.equal(result.blob.type,'image/png');assert.equal(result.metadata.parent_image.sha256,'unchanged-sha256');
  assert.equal(result.metadata.parent_image.extra.credit,'Test source');assert.equal(result.metadata.parent_image.extra.pixel_mapping.display.red,.5);
  assert.equal(result.metadata.calibrated,false);assert.deepEqual(plain(result.metadata.channel_gains),[2.25,.75,2]);
  assert.equal(h.current.sha256,'unchanged-sha256');assert.equal(h.current.extra.pixel_mapping.display.red,.5);
});

test('FITS uses the selected display stretch and never loads the original FITS for color export',async()=>{
  const h=harness();h.setImage({...h.current,scientific:true,name:'Science.fits',preview_url:'/one/preview?stretch=log'});
  const result=await h.controller.capture();assert.deepEqual(h.sources,['/one/preview?stretch=log']);
  assert.equal(result.metadata.parent_image.scientific,true);assert.equal(result.metadata.calibrated,false);
});

test('unsupported originals fall back to the display preview with explicit export provenance',async()=>{
  const h=harness({loadImage:async url=>{if(url.endsWith('original'))throw Error('TIFF unsupported');return {naturalWidth:1,naturalHeight:1};}});
  await h.controller.export('download');assert.deepEqual(h.sources,['/one/original','/one/preview']);
  assert.equal(h.metadata[0].input.preview_fallback,true);assert.match(h.node('[data-lab-color="status"]').textContent,/export uses the display preview/);
  assert.equal(h.downloads.length,1);
});

test('enhanced exports use the actual selected image with its baked visualization label',async()=>{
  const h=harness();h.setEnhanced('cloud-7','/one/ai/cloud-7?v=123');h.controller.select('enhanced');h.controller.change({blue:-.5});
  const result=await h.controller.capture();assert.deepEqual(h.sources,['/one/ai/cloud-7?v=123']);assert.equal(h.canvases[0].drawn.url,'/one/ai/cloud-7?v=123');
  assert.equal(result.metadata.ai_enhanced,true);assert.equal(result.metadata.input.variant,'cloud-7');
});

for(const action of ['image','colors','stretch','variant'])test(`an in-flight export is cancelled after a change of ${action}`,async()=>{
  const pending=deferred(),h=harness({loadImage:()=>pending.promise});const work=h.controller.export('copy');
  if(action==='image')h.setImage({...h.current,id:'two',preview_url:'/two/preview'});
  if(action==='colors')h.controller.change({red:.2});
  if(action==='stretch')h.original.setAttribute('src','/one/preview?stretch=linear');
  if(action==='variant')h.setEnhanced('variant-b','/one/ai-b');
  pending.resolve({naturalWidth:1,naturalHeight:1});await work;
  assert.equal(h.uploads.length,0);assert.equal(h.opened.length,0);assert.equal(h.controller.running,false);
});

test('saving an adjusted copy uploads source context and opens only the new local image',async()=>{
  const h=harness();h.controller.change({blue:.4});await h.controller.export('copy');
  assert.equal(h.uploads.length,1);const form=h.uploads[0];assert.equal(form.get('file').type,'image/png');
  const context=JSON.parse(form.get('context'));assert.equal(context.display.blue,.4);assert.equal(context.parent_image.id,'one');
  assert.deepEqual(h.opened,[{id:'copy',name:'Source-adjusted.png'}]);assert.match(h.notifications[0],/now enhance this copy/);
  assert.equal(h.current.id,'one'); // Import returns a separate asset; the original is never changed.
});

test('a completed upload cannot navigate away from another image chosen while it was saving',async()=>{
  const h=harness(),pending=deferred();h.controller.upload=()=>pending.promise;
  const work=h.controller.export('copy');for(let i=0;i<8;i++)await Promise.resolve();
  h.setImage({...h.current,id:'two',preview_url:'/two/preview'});pending.resolve({id:'copy'});await work;
  assert.equal(h.opened.length,0);assert.equal(h.controller.running,false);
});

test('an unadjusted export retains settings as metadata without applying the saved gains',async()=>{
  const h=harness();h.controller.change({red:1});h.node('[data-lab-action="unadjusted"]').onclick();
  const result=await h.controller.capture();assert.deepEqual([...h.canvases[0].pixels],[40,80,120,200]);
  assert.equal(result.metadata.display.red,0);assert.equal(result.metadata.saved_adjustments.red,1);assert.equal(result.metadata.original_preview,true);
});
