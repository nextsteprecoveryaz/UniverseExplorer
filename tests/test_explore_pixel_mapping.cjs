'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const PixelMappingMath=require('../static/pixel-mapping-math.js');
const script=fs.readFileSync(path.join(__dirname,'..','static','explore-pixel-mapping.js'),'utf8');

function harness(){
  const nodes=new Map(),listeners=new Map(),resize=[];
  function node(id=''){
    const item={id,childNodes:[],parentElement:null,hidden:false,attributes:{},value:'native',classList:{values:new Set(),toggle(name,on){on?this.values.add(name):this.values.delete(name);}},
      setAttribute(name,value){this.attributes[name]=String(value);},
      append(child){if(child.parentElement){const index=child.parentElement.childNodes.indexOf(child);child.parentElement.childNodes.splice(index,1);}this.childNodes.push(child);child.parentElement=this;if(child.id)nodes.set('#'+child.id,child);}};
    if(id)nodes.set('#'+id,item);return item;
  }
  const page=node('explore-page'),map=node('aladin-lite-div'),markers=node('object-markers'),toolbar=node('map-view-toolbar'),route=node('route-player');
  page.append(map);page.append(markers);page.append(toolbar);page.append(route);
  node('sky-stretch');nodes.set('.mapping-control',node());
  const surveys=[
    {id:'optical',name:'Visible sky · DSS2',url:'https://alasky.cds.unistra.fr/DSS/DSSColor'},
    {id:'2mass',name:'2MASS · near-infrared survey',url:'https://alasky.cds.unistra.fr/2MASS/Color'},
    {id:'sdss-color',name:'SDSS · galaxy color',url:'https://alasky.cds.unistra.fr/SDSS/DR9/color'},
    {id:'sdss-g',name:'SDSS · g band',url:'https://alasky.cds.unistra.fr/SDSS/DR9/band-g'},
    {id:'sdss-r',name:'SDSS · r band',url:'https://alasky.cds.unistra.fr/SDSS/DR9/band-r'},
    {id:'sdss-i',name:'SDSS · i band',url:'https://alasky.cds.unistra.fr/SDSS/DR9/band-i'},
    {id:'hydrogen',name:'H-alpha',url:'https://alasky.cds.unistra.fr/FinkbeinerHalpha'},
    {id:'webb-200',name:'Webb F200W',url:'https://alasky.cds.unistra.fr/JWST/CDS_P_JWST_F200W'},
    {id:'dust',name:'Dust WSSA',url:'https://alasky.cds.unistra.fr/WSSA'},
    {id:'cefca-virgo',name:'CEFCA Virgo Cluster',url:'https://www.cefca.es/img/aladin/VirgoCluster',credit:'CEFCA Foundation',source_url:'https://www.cefca.es/divulgacion/tour_cumulo_virgo'},
  ];
  let base={name:'Visible',url:'http://localhost:8765/api/atlas/surveys/optical'};
  const state={survey:'optical',config:{surveys},sky:{getBaseImageLayer:()=>base,addListener:(name,callback)=>listeners.set(name,callback)}};
  class Controller{
    constructor(options){Object.assign(this,options);this.options=options;this.settings=PixelMappingMath.defaults();this.bindings=[];this.invalidations=0;}
    bind(key,layer){this.bindings.push({key,layer});this.key=key;this.layer=layer;return Promise.resolve();}
    change(settings){this.settings=settings;this.onChange(settings,{original:false,key:this.key});}
    invalidateView(){this.invalidations++;}
    setOpen(open){this.host.hidden=!open;this.onResize(open);}
  }
  const context=vm.createContext({state,PixelMappingController:Controller,document:{createElement:()=>node()},$:selector=>nodes.get(selector)||null,window:{dispatchEvent:event=>resize.push(event)},Event:class{constructor(type){this.type=type;}}});
  vm.runInContext(script,context);
  return {context,nodes,page,map,markers,toolbar,route,state,resize,listeners,
    init:()=>context.initExplorePixelMapping(),
    get ui(){return vm.runInContext('explorePixelMapping',context);},
    setBase(layer){base=layer;},node};
}

test('Explore initialization docks controls without recreating map elements or losing existing overlays',()=>{
  const h=harness(),controller=h.init(),stage=h.nodes.get('#explore-map-stage'),panel=h.nodes.get('#explore-pixel-panel');
  assert.equal(controller,h.ui.controller);assert.equal(stage.parentElement,h.page);
  for(const existing of [h.map,h.markers,h.toolbar,h.route])assert.equal(existing.parentElement,stage);
  assert.equal(panel.parentElement,h.page);assert.equal(panel.hidden,true);
  assert.equal(h.ui.button.parentElement,h.toolbar);assert.equal(h.ui.button.attributes['aria-expanded'],'false');
  assert.equal(controller.storageKey,'universe:explore-pixel-mapping:v1');assert.equal(controller.captureKind,'explore-sky-capture');assert.equal(controller.captureLabel,'Explore sky');
  assert.equal(controller.bindings[0].key,'optical');assert.equal(controller.bindings[0].layer,h.state.sky.getBaseImageLayer());
  assert.equal(h.init(),controller);assert.equal(h.page.childNodes.length,2,'Re-initialization must not wrap the map again');
});

test('opening and closing the panel updates accessibility and resizes the map without changing coordinates',()=>{
  const h=harness(),controller=h.init();h.ui.button.onclick();
  assert.equal(controller.host.hidden,false);assert.equal(h.ui.button.attributes['aria-expanded'],'true');assert.equal(h.page.classList.values.has('explore-pixels-open'),true);
  assert.equal(h.resize.length,1);assert.equal(h.resize[0].type,'resize');assert.equal(controller.invalidations,1);
  h.ui.button.onclick();assert.equal(controller.host.hidden,true);assert.equal(h.ui.button.attributes['aria-expanded'],'false');assert.equal(h.resize.length,2);
});

test('all configured surveys expose their actual name, URL and credited source',()=>{
  const h=harness();
  for(const survey of h.state.config.surveys){
    const descriptor=h.context.explorePixelSurveyInfo(survey.id,{});
    assert.equal(descriptor.id,survey.id);assert.equal(descriptor.name,survey.name);assert.equal(descriptor.label,survey.name);assert.equal(descriptor.url,survey.url);
    if(survey.id.startsWith('sdss-'))assert.equal(descriptor.credit,'SDSS Collaboration; HiPS by CDS');
    if(survey.id==='cefca-virgo'){assert.equal(descriptor.credit,'CEFCA Foundation');assert.equal(descriptor.source_url,survey.source_url);}
  }
  assert.doesNotMatch(h.context.explorePixelSurveyInfo('optical',{}).label,/Hubble/);
  assert.doesNotMatch(h.context.explorePixelSurveyInfo('2mass',{}).label,/Webb/);
});

test('base-layer registration follows the actual survey and ignores image overlays',()=>{
  const h=harness(),controller=h.init(),added=h.listeners.get('AL:Layer.added'),overlay={url:'/overlay.fits',name:'Science image'};
  added({detail:{layer:overlay}});assert.equal(controller.bindings.length,1);
  const sdss={url:'http://localhost:8765/api/atlas/surveys/sdss-g',name:'SDSS g'};h.setBase(sdss);added({detail:{layer:sdss}});
  assert.equal(controller.bindings.length,2);assert.equal(controller.bindings[1].key,'sdss-g');assert.equal(controller.bindings[1].layer,sdss);
});

test('custom Aladin bases retain their own source metadata and stable independent profile keys',()=>{
  const h=harness(),controller=h.init(),custom={url:'https://example.test/custom-survey',name:'Custom survey'};h.setBase(custom);
  h.listeners.get('AL:Layer.added')({detail:{layer:custom}});
  const key=controller.bindings.at(-1).key;assert.match(key,/^custom-[0-9a-f]+$/);assert.equal(h.context.explorePixelLayerKey(custom),key);
  const descriptor=h.context.explorePixelSurveyInfo(key,custom);assert.equal(descriptor.url,custom.url);assert.equal(descriptor.name,custom.name);
  assert.notEqual(h.context.explorePixelLayerKey({url:'https://example.test/different'}),key);
});

test('legacy stretch changes retain palette, levels and color gains and synchronize in both directions',()=>{
  const h=harness(),controller=h.init();controller.settings={...PixelMappingMath.defaults(),colormap:'magma',red:.7,black:.1};
  for(const [input,expected] of [['asinh','asinh'],['log','log'],['sqrt','sqrt'],['pow2','pow2'],['native','linear']]){
    assert.equal(h.context.setExplorePixelStretch(input),true);assert.equal(controller.settings.stretch,expected);
    assert.equal(controller.settings.colormap,'magma');assert.equal(controller.settings.red,.7);assert.equal(controller.settings.black,.1);
    assert.equal(h.nodes.get('#sky-stretch').value,input);
  }
  controller.onChange({...controller.settings,stretch:'sqrt'},{original:false});assert.equal(h.nodes.get('#sky-stretch').value,'sqrt');
  controller.onChange({...controller.settings,stretch:'sqrt'},{original:true});assert.equal(h.nodes.get('#sky-stretch').value,'native');
  const saved=JSON.stringify(controller.settings);assert.equal(h.context.setExplorePixelStretch('bad-value'),false);assert.equal(JSON.stringify(controller.settings),saved);
});

test('explicit survey and camera hooks invalidate the same Explore controller',()=>{
  const h=harness(),controller=h.init(),layer={name:'SDSS r',url:'https://alasky.cds.unistra.fr/SDSS/DR9/band-r'};
  h.context.bindExplorePixelMapping('sdss-r',layer);assert.equal(controller.bindings.at(-1).key,'sdss-r');assert.equal(controller.layer,layer);
  h.context.invalidateExplorePixelMapping();assert.equal(controller.invalidations,1);
});

test('hooks remain safe while the sky viewer is unavailable',()=>{
  const h=harness();h.state.sky=null;assert.equal(h.init(),null);assert.equal(h.context.setExplorePixelStretch('log'),false);
  assert.doesNotThrow(()=>h.context.invalidateExplorePixelMapping());assert.doesNotThrow(()=>h.context.bindExplorePixelMapping());
  assert.equal(h.page.childNodes.length,4);
});
